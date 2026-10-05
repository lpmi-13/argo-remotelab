import os
import io
import hashlib
import hmac
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
os.environ["LEARNING_DIR"] = str(Path(__file__).parent.parent / "learning")
import server  # noqa: E402


def probe(fixed=True, durable=True):
    return {"fixed": fixed, "durable": durable, "git_revision": "abc123",
            "other_application_healthy": True,
            "status": {"health": {"status": "Healthy"}, "sync": {"status": "Synced", "revision": "abc123"}}}


def session(name="missing-configmap", mode="challenge"):
    return {"id": "test", "run_id": "run-test", "mode": mode,
            "pack": server.PACKS[name], "application": "shop-web-prod", "environment": "prod",
            "visited": set(), "passed": set(), "actions": [], "last_sequence": 0,
            "note": None, "feedback": None}


class LearningServiceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        server.load_packs()
        server.log_event = lambda *args: None

    def test_pack_contracts_and_targets(self):
        self.assertEqual(len(server.PACKS), 13)
        self.assertIn("settings.repos", server.TARGETS)
        for pack in server.PACKS.values():
            self.assertTrue(pack["checks"])
            self.assertTrue(set(pack["targets"]).issubset(server.TARGETS))

    def test_curriculum_starts_at_level_one_and_orientation_has_no_repair_step(self):
        self.assertEqual([item["level"] for item in server.CATALOG["levels"]], [1, 2, 3, 4, 5])
        self.assertEqual(min(pack["level"] for pack in server.PACKS.values()), 1)
        orientation = session(name="console-history", mode="guided")
        incident = session(name="missing-configmap", mode="guided")
        self.assertEqual(len(server.all_checks(orientation, probe())), len(orientation["pack"]["checks"]))
        self.assertEqual(len(server.all_checks(incident, probe())), len(incident["pack"]["checks"]) + 1)

    def test_briefing_and_next_step_explain_the_selected_environment(self):
        run = session(name="env-drift", mode="guided")
        run["environment"] = "staging"
        run["application"] = "shop-web-staging"
        view = server.build_session_view(run, {"state": "READY"}, probe(False, False), False)
        self.assertIn("staging", view["briefing"]["summary"])
        self.assertIn("staging", view["next_check"]["action"])
        self.assertIn("healthy peer", view["next_check"]["reason"])
        self.assertNotIn("demonstration_answer", view["next_check"])
        self.assertNotIn("${", json.dumps(view["briefing"]))

    def test_catalog_introduces_the_signal_without_naming_the_answer(self):
        catalog = {item["id"]: item for item in server.public_catalog()["scenarios"]}
        self.assertEqual(catalog["hmac-mismatch"]["title"],
                         "An encrypted value blocked the shop release")
        self.assertIn("the selected environment", catalog["hmac-mismatch"]["brief"])
        self.assertNotIn("authentication", catalog["hmac-mismatch"]["brief"].lower())

    def test_answer_confirmation_explains_what_the_evidence_means(self):
        run = session(mode="guided")
        server.record_action(run, {"sequence": 1, "type": "target_visited",
                                   "details": {"target": "apps.list"}}, probe(False, False))
        result = server.record_action(run, {"sequence": 2, "type": "evidence_check_answered",
                                            "details": {"check_id": "application", "answer": "shop-web-prod"}},
                                      probe(False, False))
        self.assertTrue(result["correct"])
        self.assertIn("affected Application", result["message"])

    def test_deployed_revision_step_explains_why_history_matters(self):
        run = session(mode="demonstration")
        run["passed"] = {check["id"] for check in run["pack"]["checks"]}
        view = server.build_session_view(run, {"state": "FIXED"}, probe(), False)
        self.assertEqual(view["next_check"]["id"], "verify-revision")
        self.assertIn("exact commit", view["next_check"]["reason"])
        self.assertEqual(view["next_check"]["demonstration_answer"], "abc123")

    def test_repository_failure_includes_working_connection_comparison(self):
        run = session(name="repo-auth", mode="demonstration")
        run["passed"] = {"application", "source"}
        view = server.build_session_view(run, {"state": "READY"}, probe(False, False), False)
        self.assertEqual(view["next_check"]["target"], "settings.repos")
        self.assertIn("known-good", view["next_check"]["reason"])
        self.assertEqual(view["next_check"]["demonstration_answer"], "HTTP")

    def test_guided_check_requires_visit_and_reading(self):
        run = session(mode="guided")
        with self.assertRaisesRegex(ValueError, "visit the target"):
            server.record_action(run, {"sequence": 1, "type": "evidence_check_answered",
                                       "details": {"check_id": "application", "answer": "shop-web-prod"}}, probe())
        server.record_action(run, {"sequence": 1, "type": "target_visited",
                                   "details": {"target": "apps.list"}}, probe())
        wrong = server.record_action(run, {"sequence": 2, "type": "evidence_check_answered",
                                           "details": {"check_id": "application", "answer": "shop-web-staging"}}, probe())
        self.assertFalse(wrong["correct"])
        self.assertEqual(run["passed"], set())
        right = server.record_action(run, {"sequence": 3, "type": "evidence_check_answered",
                                           "details": {"check_id": "application", "answer": "shop-web-prod"}}, probe())
        self.assertTrue(right["correct"])
        self.assertIn("application", run["passed"])

    def test_fixed_challenge_scores_100_with_console_evidence(self):
        run = session()
        run["visited"] = {"apps.list", "resource.events"}
        run["note"] = {"resource": "Deployment/django", "cause": "The deployment references a ConfigMap that does not exist",
                       "revision": "abc123", "evidence": "django-app-missing-config", "fix": "Restored reference"}
        self.assertEqual(server.score(run, probe())["total"], 100)

    def test_unfixed_run_is_capped_at_50(self):
        run = session()
        run["visited"] = {"apps.list", "resource.events"}
        run["note"] = {"resource": "Deployment/django", "cause": "The deployment references a ConfigMap that does not exist",
                       "revision": "abc123", "evidence": "django-app-missing-config"}
        self.assertLessEqual(server.score(run, probe(False, False))["total"], 50)

    def test_terminal_only_earns_half_console_evidence(self):
        run = session()
        run["note"] = {"resource": "Deployment/django", "cause": "The deployment references a ConfigMap that does not exist",
                       "revision": "abc123", "evidence": "django-app-missing-config"}
        run["actions"] = [{"type": "terminal_command", "details": {"verb": "kubectl"}}]
        self.assertEqual(server.score(run, probe())["breakdown"]["console_evidence"], 12)

    def test_plaintext_secret_commit_zeroes_practice(self):
        run = session()
        run["actions"] = [{"type": "commit_pushed", "details": {"files": ["chart/django-app/secrets.yaml"]}}]
        feedback = server.score(run, probe())
        self.assertTrue(feedback["leaked_secret"])
        self.assertEqual(feedback["breakdown"]["operational_practice"], 0)

    def test_guided_dead_end_feedback(self):
        run = session(mode="guided")
        running = probe()
        running["operation_running"] = True
        wrong = server.record_action(run, {"sequence": 1, "type": "sync_requested",
                                           "details": {"application": "shop-web-staging"}}, running)
        self.assertEqual(wrong["reason_code"], "wrong_app")
        busy = server.record_action(run, {"sequence": 2, "type": "sync_requested",
                                          "details": {"application": "shop-web-prod"}}, running)
        self.assertEqual(busy["reason_code"], "sync_while_running")
        self.assertTrue(run["actions"][1]["details"]["operation_running"])

    def test_unsafe_prune_and_live_workload_delete_reduce_practice(self):
        run = session(name="orphaned-resource")
        run["actions"] = [
            {"type": "sync_requested", "details": {"application": "shop-web-prod", "prune": True, "resources": []}},
            {"type": "resource_deleted", "details": {"application": "shop-web-prod", "name": "django"}},
        ]
        scored = server.score(run, probe())
        self.assertLessEqual(scored["breakdown"]["operational_practice"], 2)

    def test_check_in_is_recorded_without_changing_progress(self):
        run = session(mode="guided")
        result = server.record_action(run, {"sequence": 1, "type": "check_in_answered",
                                            "details": {"step": "check:application", "choice": "continue",
                                                        "active_seconds": 45}}, probe())
        self.assertTrue(result["accepted"])
        self.assertEqual(run["passed"], set())
        self.assertEqual(run["actions"][0]["type"], "check_in_answered")

    def test_short_sha_answers_match_the_full_revision(self):
        full = "a4e3c92" + "6" * 33
        self.assertTrue(server.answer_matches("a4e3c92", full))
        self.assertFalse(server.answer_matches("a4e3c9", full))

    def test_challenge_scores_the_triggering_revision(self):
        run = session()
        run["trigger_revision"] = "bad1234" + "a" * 33
        run["note"] = {"resource": "Deployment/django", "cause": "The deployment references a ConfigMap that does not exist",
                       "revision": "bad1234", "evidence": "django-app-missing-config"}
        scored = server.score(run, probe())
        self.assertEqual(scored["breakdown"]["diagnosis"], 20)
        run["note"]["revision"] = "abc123"
        self.assertLess(server.score(run, probe())["breakdown"]["diagnosis"], 20)

    def test_plaintext_secret_interrupt_is_visible_in_every_mode(self):
        run = session(mode="challenge")
        run["actions"].append({"type": "commit_pushed", "details": {"files": ["chart/django-app/secrets.yaml"]}})
        view = server.build_session_view(run, {"state": "READY"}, probe(), False)
        self.assertEqual(view["alert"]["reason_code"], "secret_leaked")

    def test_live_edit_reversion_points_back_to_git(self):
        run = session(mode="guided")
        run["actions"].append({"type": "resource_updated", "details": {"application": "shop-web-prod"}})
        server.build_session_view(run, {"state": "READY"}, probe(True, False), False)
        view = server.build_session_view(run, {"state": "READY"}, probe(False, False), False)
        self.assertEqual(view["alert"]["reason_code"], "live_edit_reverted")

    def test_signed_main_push_refreshes_shop_applications(self):
        payload = {"ref": "refs/heads/main", "after": "abc123", "commits": []}
        raw = json.dumps(payload).encode()
        handler = object.__new__(server.Handler)
        handler.raw_body = raw
        handler.headers = {"X-Gitea-Signature": hmac.new(b"test-secret", raw, hashlib.sha256).hexdigest()}
        replies = []
        handler.respond = lambda status, body: replies.append((status, body))
        with patch.object(server, "WEBHOOK_SECRET", "test-secret"), \
             patch.object(server, "controller", return_value=(202, {"refreshed": ["shop-web-prod", "shop-web-staging"]})) as refresh:
            handler.webhook(payload)
        refresh.assert_called_once_with("/api/refresh", "POST", {})
        self.assertEqual(replies[0][0], 202)

    def test_invalid_webhook_signature_cannot_refresh(self):
        payload = {"ref": "refs/heads/main", "after": "abc123", "commits": []}
        handler = object.__new__(server.Handler)
        handler.raw_body = json.dumps(payload).encode()
        handler.headers = {"X-Gitea-Signature": "bad"}
        replies = []
        handler.respond = lambda status, body: replies.append((status, body))
        with patch.object(server, "WEBHOOK_SECRET", "test-secret"), patch.object(server, "controller") as refresh:
            handler.webhook(payload)
        refresh.assert_not_called()
        self.assertEqual(replies[0][0], 401)

    def test_websocket_stream_requires_session_token(self):
        handler = object.__new__(server.Handler)
        handler.headers = {"Sec-WebSocket-Protocol": "argo-coach, token.wrong"}
        replies = []
        handler.respond = lambda status, body: replies.append((status, body))
        with patch.dict(server.SESSIONS, {"session-test": {"token": "secret"}}, clear=True):
            handler.session_stream("session-test")
        self.assertEqual(replies[0][0], 401)

    def test_websocket_stream_accepts_masked_browser_close(self):
        mask = b"abcd"
        reason = b"\x03\xe8recorder reconnect check"
        encoded = bytes(byte ^ mask[index % 4] for index, byte in enumerate(reason))
        opcode, payload = server.websocket_client_control(io.BytesIO(
            bytes([0x88, 0x80 | len(reason)]) + mask + encoded))
        self.assertEqual((opcode, payload), (8, reason))

    def test_terminal_signal_attaches_only_to_current_session(self):
        active = session()
        stale = session()
        active["id"], stale["id"] = "active", "stale"
        handler = object.__new__(server.Handler)
        handler.path = "/api/events/terminal"
        handler.headers = {"X-Lab-Terminal-Token": "test-token"}
        handler.body = lambda: {"verb": "kubectl", "exit_code": 0}
        replies = []
        handler.respond = lambda status, body: replies.append((status, body))
        with patch.object(server, "TERMINAL_TOKEN", "test-token"), \
             patch.object(server, "ACTIVE_SESSION_ID", "active"), \
             patch.dict(server.SESSIONS, {"active": active, "stale": stale}, clear=True), \
             patch.object(server, "log_event"):
            handler.do_POST()
        self.assertEqual(replies[0][0], 202)
        self.assertEqual(active["actions"][0]["details"], {"verb": "kubectl", "exit_code": 0})
        self.assertEqual(stale["actions"], [])


if __name__ == "__main__":
    unittest.main()
