"""HTTP learning service for Argo CD incident runs.

Scenario packs own the facts and information targets. The controller owns
cluster state and remediation. Browser actions only establish where a learner
looked; they cannot claim that a deployment was fixed.
"""

import base64
import binascii
import hashlib
import hmac
import http.cookiejar
import json
import os
import re
import select
import secrets
import struct
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, quote, urlencode, urlparse
from urllib.request import HTTPCookieProcessor, HTTPRedirectHandler, Request, build_opener, urlopen


PORT = int(os.getenv("PORT", "8091"))
CONTROLLER_URL = os.getenv("SCENARIO_CONTROLLER_URL", "http://scenario-controller:8092").rstrip("/")
LEARNING_DIR = Path(os.getenv("LEARNING_DIR", "/app/learning"))
WEBHOOK_SECRET = os.getenv("GITEA_WEBHOOK_SECRET", "")
TERMINAL_TOKEN = os.getenv("LAB_TERMINAL_TOKEN", "")
ARGOCD_URL = os.getenv("ARGOCD_URL", "http://argocd-server.argocd.svc.cluster.local:80/argocd").rstrip("/")
ARGOCD_USER = os.getenv("ARGOCD_USER", "learner")
ARGOCD_PASSWORD = os.getenv("ARGOCD_PASSWORD", "remotelab")
GITEA_URL = os.getenv("GITEA_URL", "http://gitea.applications.svc.cluster.local:3000").rstrip("/")
GITEA_USER = os.getenv("GITEA_USER", "remotelab")
GITEA_PASSWORD = os.getenv("GITEA_PASSWORD", "remotelab")
LOG_FILE = Path(os.getenv("LOG_FILE", "/tmp/argo-learning-events.jsonl"))
LOCK = threading.RLock()
SESSIONS = {}
ACTIVE_SESSION_ID = None
CATALOG = {}
PACKS = {}
TARGETS = {}
TOKEN = re.compile(r"\$\{([a-z_]+)\}")


def load_packs():
    global CATALOG, PACKS, TARGETS
    CATALOG = json.loads((LEARNING_DIR / "catalog.json").read_text())
    TARGETS = json.loads((LEARNING_DIR / "targets" / "argocd-3.5.json").read_text())["targets"]
    framing_data = json.loads((LEARNING_DIR / "incident-framing.json").read_text())
    framing = framing_data["scenarios"]
    demo = framing_data["demo"]
    debrief = framing_data["debrief"]
    if set(framing) != set(CATALOG["scenarios"]):
        raise ValueError("incident framing must cover every catalog scenario")
    if set(demo) != set(framing):
        raise ValueError("demo narration must cover every catalog scenario")
    if set(debrief) != set(framing):
        raise ValueError("debrief must cover every catalog scenario")
    PACKS = {}
    for name in CATALOG["scenarios"]:
        pack = json.loads((LEARNING_DIR / "scenarios" / name / "pack.json").read_text())
        if pack["id"] != name:
            raise ValueError("pack ID mismatch for " + name)
        story = framing[name]
        if set(story["steps"]) != {check["id"] for check in pack["checks"]}:
            raise ValueError("incident framing steps do not match checks in " + name)
        demo_steps = demo[name]
        expected_demo = set(story["steps"]) | ({"repair"} if pack["level"] != 1 else set())
        if set(demo_steps) != expected_demo or any(
                not all(copy.get(field) for field in ("what", "why"))
                for copy in demo_steps.values()):
            raise ValueError("incomplete demo narration for " + name)
        debrief_steps = debrief[name]
        if set(debrief_steps) != expected_demo or any(
                not all(copy.get(field) for field in ("action", "finding"))
                for copy in debrief_steps.values()):
            raise ValueError("incomplete debrief for " + name)
        if not all(story["briefing"].get(field) for field in
                   ("source", "headline", "summary")):
            raise ValueError("incomplete incident briefing for " + name)
        if pack["level"] != 1 and not all((story.get("repair") or {}).get(field)
                                          for field in ("action", "reason")):
            raise ValueError("incomplete repair framing for " + name)
        pack["briefing"] = story["briefing"]
        pack["repair"] = ({**story["repair"], "demo": demo_steps["repair"],
                           "debrief": debrief_steps["repair"]}
                          if pack["level"] != 1 else None)
        for check in pack["checks"]:
            step = story["steps"][check["id"]]
            if not all(step.get(field) for field in ("action", "reason", "learning")):
                raise ValueError("incomplete step framing for %s/%s" % (name, check["id"]))
            check.update(step)
            check["demo"] = demo_steps[check["id"]]
            check["debrief"] = debrief_steps[check["id"]]
        for target in pack["targets"]:
            if target not in TARGETS:
                raise ValueError("unknown target %s in %s" % (target, name))
        for check in pack["checks"]:
            for target in check_targets(check):
                if target not in TARGETS:
                    raise ValueError("unknown check target %s in %s" % (target, name))
        PACKS[name] = pack


def controller(path, method="GET", payload=None, timeout=15):
    body = json.dumps(payload).encode() if payload is not None else None
    request = Request(CONTROLLER_URL + path, data=body, method=method,
                      headers={"Content-Type": "application/json"})
    try:
        with urlopen(request, timeout=timeout) as response:
            return response.status, json.loads(response.read())
    except HTTPError as error:
        try:
            return error.code, json.loads(error.read())
        except (ValueError, OSError):
            return error.code, {"error": str(error)}
    except (URLError, TimeoutError) as error:
        return 503, {"error": "scenario controller unavailable: %s" % error}


def normalized(value):
    return re.sub(r"[^a-z0-9]+", " ", str(value).casefold()).strip()


def check_targets(check):
    target = check["target"]
    return target if isinstance(target, list) else [target]


def answer_matches(actual, expected):
    actual_text, expected_text = normalized(actual), normalized(expected)
    if not actual_text or not expected_text:
        return False
    # Argo often displays a short commit SHA while the probe has the full SHA.
    if re.fullmatch(r"[0-9a-f]{7,40}", actual_text) and expected_text.startswith(actual_text):
        return True
    return actual_text == expected_text or expected_text in actual_text


def context_for(session, probe):
    status = probe.get("status") or {}
    return {
        "application": session["application"],
        "environment": session["environment"],
        "revision": (status.get("sync") or {}).get("revision") or probe.get("git_revision") or "",
        "health": (status.get("health") or {}).get("status") or "Unknown",
    }


def expand(value, context):
    if isinstance(value, str):
        return TOKEN.sub(lambda match: str(context.get(match.group(1), match.group(0))), value)
    if isinstance(value, list):
        return [expand(item, context) for item in value]
    if isinstance(value, dict):
        return {key: expand(item, context) for key, item in value.items()}
    return value


def log_event(session, action, result=None):
    record = {"at": time.time(), "session": session["id"], "run": session["run_id"],
              "mode": session["mode"], "action": action, "result": result}
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    with LOG_FILE.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(record, separators=(",", ":")) + "\n")


def websocket_frame(payload, opcode=1):
    """Encode one server-to-browser frame."""
    if isinstance(payload, str):
        payload = payload.encode("utf-8")
    length = len(payload)
    if length < 126:
        header = bytes([0x80 | opcode, length])
    elif length < 65536:
        header = bytes([0x80 | opcode, 126]) + struct.pack("!H", length)
    else:
        header = bytes([0x80 | opcode, 127]) + struct.pack("!Q", length)
    return header + payload


def websocket_client_control(stream):
    """Read one masked browser control frame, rejecting data and oversized frames."""
    header = stream.read(2)
    if len(header) != 2:
        return 8, b""
    opcode = header[0] & 0x0f
    length = header[1] & 0x7f
    if header[1] & 0x80 == 0 or opcode not in (8, 9, 10):
        raise ValueError("unsupported WebSocket client frame")
    if length == 126:
        length = struct.unpack("!H", stream.read(2))[0]
    elif length == 127:
        length = struct.unpack("!Q", stream.read(8))[0]
    if length > 125:
        raise ValueError("oversized WebSocket control frame")
    mask = stream.read(4)
    payload = stream.read(length)
    if len(mask) != 4 or len(payload) != length:
        raise ValueError("incomplete WebSocket control frame")
    return opcode, bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))


def make_session(run, mode):
    global ACTIVE_SESSION_ID
    scenario = run["scenario"]
    pack = PACKS[scenario]
    session = {
        "id": "session-" + secrets.token_hex(8), "token": secrets.token_urlsafe(32),
        "run_id": run["id"], "mode": mode, "pack": pack,
        "application": run["application"], "environment": run["environment"],
        "trigger_revision": run.get("trigger_revision", ""),
        "visited": set(), "passed": set(), "actions": [], "last_sequence": 0,
        "note": None, "feedback": None, "created_at": time.time(),
    }
    with LOCK:
        SESSIONS[session["id"]] = session
        ACTIVE_SESSION_ID = session["id"]
    return session


def public_catalog():
    return {"version": CATALOG["version"], "levels": CATALOG["levels"],
            "scenarios": [{"id": p["id"], "title": p["briefing"]["headline"], "level": p["level"],
                           "brief": expand(p["briefing"]["summary"],
                                           {"environment": "the selected environment"}),
                           "fix_surface": p["fix_surface"]}
                          for p in PACKS.values()]}


def next_check(session, probe):
    if session["mode"] == "challenge":
        return None
    context = context_for(session, probe)
    for check in all_checks(session, probe):
        if check["id"] in session["passed"]:
            continue
        alternatives = check_targets(check)
        target = next((item for item in alternatives if item in session["visited"]), alternatives[0])
        result = {"id": check["id"], "target": target, "where": TARGETS[target],
                "question": expand(check["question"], context),
                "hint": expand(check.get("hint", ""), context),
                "action": expand(check["action"], context),
                "reason": expand(check["reason"], context),
                "learning": expand(check["learning"], context),
                "demo": expand(check["demo"], context),
                "available": any(item in session["visited"] for item in alternatives)}
        if session["mode"] == "demonstration":
            result["demonstration_answer"] = expand(check["answer"], context)
        return result
    return None


def all_checks(session, probe):
    checks = list(session["pack"]["checks"])
    if session["pack"]["level"] != 1:
        checks.append({"id": "verify-revision", "target": "app.history",
                       "question": "Which revision is now deployed after the fix?",
                       "answer": "${revision}",
                       "hint": "Wait for Healthy and Synced, then open History and Rollback.",
                       "why": "The deployed revision in History confirms that Argo applied the git fix.",
                       "action": "Once the Application is Healthy and Synced, open History and Rollback and read the newest deployed revision.",
                       "reason": "A pushed fix is only a proposal until Argo records a successful deployment. History connects the recovered workload to the exact commit that reached it.",
                       "learning": "The deployed revision confirms which commit Argo applied after the repair. Include it in the incident note.",
                       "demo": {"what": "Open ${application} → History and Rollback; read the newest deployed revision.",
                                "why": "History links the recovered workload to the Git commit Argo applied."},
                       "debrief": {"action": "We checked History and Rollback after the fix.",
                                   "finding": "Argo deployed revision ${answer}."},
                       "requires_fixed": True})
    return [check for check in checks if not check.get("requires_fixed") or probe.get("fixed")]


def session_view(session, run=None, probe=None, include_token=False):
    if run is None:
        _, run = controller("/api/runs/" + quote(session["run_id"]))
    if probe is None:
        _, probe = controller("/probe?application=" + quote(session["application"]))
    with LOCK:
        if run.get("trigger_revision"):
            session["trigger_revision"] = run["trigger_revision"]
        return build_session_view(session, run, probe, include_token)


def build_session_view(session, run, probe, include_token):
    pack = session["pack"]
    view = {
        "session_id": session["id"], "run_id": session["run_id"], "mode": session["mode"],
        "seed": run.get("seed"),
        "state": run.get("state", "UNKNOWN"), "run_error": run.get("error"),
        "run_updated_at": run.get("updated_at"),
        "application": session["application"], "environment": session["environment"],
        "scenario": {"id": pack["id"], "title": pack["title"], "level": pack["level"]},
        "brief": pack["brief"],
        "briefing": expand(pack["briefing"], context_for(session, probe)),
        "repair": expand(pack["repair"], context_for(session, probe)),
        "fix_surface": pack["fix_surface"],
        "fix_paths": [path.replace("chart/django-app", "chart/django-app-staging")
                      if session["environment"] == "staging" else path for path in pack["fix_paths"]],
        "targets": [{"id": name, "where": TARGETS[name], "visited": name in session["visited"]}
                    for name in pack["targets"]],
        "next_check": next_check(session, probe),
        "checks_passed": len(session["passed"]), "checks_total": len(pack["checks"]) + (pack["level"] != 1),
        "fixed": bool(probe.get("fixed")), "durable": bool(probe.get("durable")),
        "health": (probe.get("status") or {}).get("health", {}).get("status"),
        "sync": (probe.get("status") or {}).get("sync", {}).get("status"),
        "revision": context_for(session, probe)["revision"],
        "trigger_revision": session.get("trigger_revision", ""),
        "feedback": session["feedback"],
        "note_draft": session["note"],
    }
    commits = [action for action in session["actions"] if action["type"] == "commit_pushed"]
    if (probe.get("fixed") and not probe.get("durable") and
            any(action["type"] == "resource_updated" for action in session["actions"])):
        session["saw_live_only_fix"] = True
    if any(any(path.endswith("secrets.yaml") for path in action["details"].get("files", [])) for action in commits):
        view["alert"] = {"reason_code": "secret_leaked", "message": "A plaintext secrets.yaml was committed. Remove it from git history and re-encrypt the secret before continuing."}
    elif session.get("saw_live_only_fix") and not probe.get("fixed"):
        view["alert"] = {"reason_code": "live_edit_reverted", "message": "Argo CD self-healed the live edit from Git. Open the Application header to find the source chart, then fix the desired state there."}
    elif commits:
        latest = commits[-1]
        expected_paths = set(view["fix_paths"])
        if expected_paths and not expected_paths.intersection(latest["details"].get("files", [])) and not probe.get("fixed"):
            view["alert"] = {"reason_code": "wrong_file_edited", "message": "That commit did not change the chart file Argo is using. Check the Desired manifest and source path."}
        elif any(condition.get("type") == "ComparisonError" for condition in (probe.get("status") or {}).get("conditions") or []):
            view["alert"] = {"reason_code": "fix_broke_render", "message": "The new commit still has a ComparisonError. Read the Application condition before editing again."}
    if include_token:
        view["connection_token"] = session["token"]
        view["investigation_url"] = "/argocd/applications"
    if session["mode"] == "demonstration":
        view["demonstration_note"] = {
            **expand(pack["truth"], context_for(session, probe)),
            "revision": session.get("trigger_revision") or context_for(session, probe)["revision"],
        }
    return view


def record_action(session, action, probe):
    if not isinstance(action, dict):
        raise ValueError("action must be an object")
    sequence = action.get("sequence")
    if not isinstance(sequence, int) or sequence <= session["last_sequence"]:
        raise ValueError("action sequence must increase")
    kind = action.get("type")
    details = action.get("details") or {}
    if kind not in {"target_visited", "evidence_check_answered", "sync_requested",
                    "operation_terminated", "resource_deleted", "rollback_requested",
                    "diff_viewed", "manifest_viewed", "history_viewed", "events_viewed", "logs_viewed",
                    "commit_pushed", "terminal_command", "resource_updated",
                    "hint_requested", "step_demonstrated", "check_in_answered",
                    "refresh_requested", "file_edited_in_browser"}:
        raise ValueError("unknown action type")
    result = {"accepted": True}
    if kind == "target_visited":
        target = details.get("target")
        if target not in TARGETS:
            raise ValueError("unknown information target")
        if target not in {"apps.list", "apps.filter", "settings.repos"} and details.get("application") != session["application"]:
            raise ValueError("visit is for a different application")
        session["visited"].add(target)
        if session["mode"] == "demonstration" and target == "app.header" and "apps.list" in session["visited"]:
            check = next_check(session, probe)
            if check and check["id"] == "application" and check["target"] == "apps.list":
                session["passed"].add(check["id"])
    elif kind == "evidence_check_answered":
        if session["mode"] == "challenge":
            raise ValueError("challenge mode uses the incident note")
        check = next((item for item in all_checks(session, probe) if item["id"] == details.get("check_id")), None)
        if check is None:
            raise ValueError("unknown evidence check")
        if not any(target in session["visited"] for target in check_targets(check)):
            raise ValueError("visit the target before answering")
        expected = expand(check["answer"], context_for(session, probe))
        correct = answer_matches(details.get("answer", ""), expected)
        if correct:
            session["passed"].add(check["id"])
        result.update({"correct": correct,
                       "message": expand(check["learning"], context_for(session, probe))
                       if correct else expand(check["hint"], context_for(session, probe))})
    elif kind in {"sync_requested", "operation_terminated", "resource_deleted", "rollback_requested", "resource_updated"}:
        if kind == "sync_requested" and probe.get("operation_running"):
            details["operation_running"] = True
        if details.get("application") != session["application"]:
            result.update({"reason_code": "wrong_app", "message": "This Application is outside the incident. Check its environment label before acting."})
        elif kind == "sync_requested" and probe.get("operation_running"):
            result.update({"reason_code": "sync_while_running", "message": "An operation is already running. Read its status and terminate it before another sync."})
        elif kind == "resource_deleted" and session["pack"]["id"] == "orphaned-resource" and details.get("name") == "django":
            result.update({"reason_code": "deleted_live_workload", "message": "The live Deployment was deleted. Argo may recreate it; prune only the orphan after fixing the desired state."})
        elif kind == "rollback_requested":
            result.update({"reason_code": "rollback_temporary", "message": "Rollback is temporary while auto-sync is enabled. Follow it with a git fix."})
    session["last_sequence"] = sequence
    session["actions"].append({"type": kind, "details": details, "at": time.time()})
    log_event(session, action, result)
    return result


def field_credit(actual, expected):
    return 1.0 if answer_matches(actual, expected) else 0.0


def debrief_steps(session, probe):
    """Summarize observed evidence and durable repairs in the order they happened."""
    context = context_for(session, probe)
    actions = session["actions"]
    steps = []

    def add_step(check, position):
        answer = expand(check["answer"], context)
        copy = expand(check["debrief"], {**context, "answer": answer})
        steps.append((position, copy))

    if session["mode"] == "challenge":
        first_visits = {}
        for index, action in enumerate(actions):
            if action["type"] == "target_visited":
                first_visits.setdefault(action["details"].get("target"), index)
        for order, check in enumerate(session["pack"]["checks"]):
            targets = [target for target in check_targets(check) if target in session["visited"]]
            if targets:
                add_step(check, min(first_visits.get(target, len(actions) + order) for target in targets))
    else:
        for order, check in enumerate(session["pack"]["checks"]):
            if check["id"] in session["passed"]:
                add_step(check, order)

    if session["pack"]["repair"] and probe.get("fixed") and probe.get("durable"):
        repair = expand(session["pack"]["repair"]["debrief"], context)
        if session["mode"] == "challenge":
            head = probe.get("git_revision")
            commits = [index for index, action in enumerate(actions)
                       if action["type"] == "commit_pushed" and action["details"].get("sha") == head
                       and head != session.get("trigger_revision")]
            position = commits[-1] if commits else len(actions) + len(steps)
        else:
            position = len(session["pack"]["checks"])
        steps.append((position, repair))

    if session["mode"] != "challenge" and "verify-revision" in session["passed"]:
        check = next((check for check in all_checks(session, probe)
                      if check["id"] == "verify-revision"), None)
        if check:
            add_step(check, len(session["pack"]["checks"]) + 1)

    if not steps and session["note"]:
        cause = session["note"].get("cause", "").strip()
        steps.append((0, {"action": "We submitted an incident note.",
                          "finding": "The note recorded the cause as “%s”." % cause.rstrip(".") if cause
                          else "The note did not identify a cause."}))
    return [copy for _, copy in sorted(steps, key=lambda item: item[0])]


def score(session, probe):
    pack = session["pack"]
    note = session["note"] or {}
    truth = expand(pack["truth"], context_for(session, probe))
    fixed, durable = bool(probe.get("fixed")), bool(probe.get("durable"))
    collateral = probe.get("other_application_healthy") is True
    leaked = any(action["type"] == "commit_pushed" and
                 any(path.endswith("secrets.yaml") for path in action["details"].get("files", []))
                 for action in session["actions"])
    remediation = (20 if fixed else 0) + (10 if durable else 0) + (5 if collateral and not leaked else 0)
    diagnosis = round(20 * (field_credit(note.get("resource"), truth.get("resource")) * 0.35 +
                            field_credit(note.get("cause"), truth.get("cause")) * 0.4 +
                            field_credit(note.get("revision"), session.get("trigger_revision") or probe.get("git_revision", "")) * 0.25))
    decisive_targets = [check_targets(check) for check in pack["checks"]]
    visited = sum(any(target in session["visited"] for target in alternatives) for alternatives in decisive_targets)
    target_fraction = visited / max(1, len(decisive_targets))
    fact_fraction = field_credit(note.get("evidence"), truth.get("evidence", ""))
    if pack["id"] == "console-orientation":
        fact_fraction = len(session["passed"]) / max(1, len(pack["checks"]))
    console_evidence = round(25 * (target_fraction * 0.5 + fact_fraction * target_fraction * 0.5))
    if not visited and any(action["type"] == "terminal_command" for action in session["actions"]):
        console_evidence = round(25 * fact_fraction * 0.5)
    practice = 10
    actions = session["actions"]
    for index, action in enumerate(actions):
        if action["type"] == "sync_requested":
            earlier = {item["type"] for item in actions[:index]}
            if "diff_viewed" not in earlier and "manifest_viewed" not in earlier:
                practice -= 2
            if action["details"].get("operation_running"):
                practice -= 2
            if action["details"].get("prune") and not action["details"].get("resources"):
                practice -= 3
        if action["type"] in {"sync_requested", "operation_terminated", "resource_deleted", "rollback_requested"} and action["details"].get("application") != session["application"]:
            practice -= 3
        if (action["type"] == "resource_deleted" and pack["id"] == "orphaned-resource" and
                action["details"].get("name") != "django-web"):
            practice -= 3
        if action["type"] == "rollback_requested" and not any(
                later["type"] == "commit_pushed" for later in actions[index + 1:]):
            practice -= 2
    if leaked:
        practice = 0
    practice = max(0, practice)
    repeated_syncs = max(0, sum(item["type"] == "sync_requested" for item in actions) - 1)
    efficiency = max(0, 10 - repeated_syncs * 2)
    total = remediation + diagnosis + console_evidence + practice + efficiency
    if not fixed:
        total = min(total, 50)
    if session["mode"] != "challenge":
        total = None
    evidence_map = [{"target": target, "where": TARGETS[target], "visited": target in session["visited"],
                     "fact": next((expand(check["answer"], context_for(session, probe)) for check in all_checks(session, probe)
                                   if target in check_targets(check)), "")}
                    for target in pack["targets"]]
    practice_notes = []
    if leaked:
        practice_notes.append("A plaintext secret was committed; remove it from history and re-encrypt it.")
    if fixed and not durable:
        practice_notes.append("The deployment recovered, but the fix is not reflected in the deployed Git revision.")
    if any(action["type"] == "sync_requested" and action["details"].get("application") != session["application"] for action in actions):
        practice_notes.append("A sync was requested in the other environment.")
    if repeated_syncs:
        practice_notes.append("Repeated syncs added no new evidence; inspect the diff or operation first.")
    if not practice_notes:
        practice_notes.append("No unsafe operation was observed.")
    head = probe.get("git_revision", "")
    commits = [action["details"] for action in actions if action["type"] == "commit_pushed" and
               action["details"].get("sha") == head and head != session.get("trigger_revision")]
    return {"total": total, "out_of": 100 if total is not None else None, "fixed": fixed, "durable": durable,
            "breakdown": {"remediation": remediation, "console_evidence": console_evidence,
                          "diagnosis": diagnosis, "operational_practice": practice, "efficiency": efficiency},
            "evidence_map": evidence_map, "truth": truth,
            "trigger_revision": session.get("trigger_revision", ""),
            "deployed_revision": context_for(session, probe)["revision"],
            "fix_commit": commits[-1] if commits else None,
            "debrief_steps": debrief_steps(session, probe),
            "practice_notes": practice_notes,
            "note": note, "leaked_secret": leaked,
            "assistance": {"hints": sum(action["type"] == "hint_requested" for action in actions),
                           "show_me": sum(action["type"] == "step_demonstrated" for action in actions)},
            "message": "Deployment fixed" if fixed else "The deployment is still not fixed"}


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        return None


def gitea_session_cookies():
    jar = http.cookiejar.CookieJar()
    opener = build_opener(HTTPCookieProcessor(jar), NoRedirect())
    with opener.open(GITEA_URL + "/user/login", timeout=10) as response:
        page = response.read().decode("utf-8", "replace")
    # Gitea scopes its CSRF/session cookies to the public /gitea path. Internal
    # service calls use its unprefixed upstream routes, so widen only this
    # temporary server-side jar before posting the login form.
    issued_cookies = list(jar)
    jar.clear()
    for cookie in issued_cookies:
        cookie.path = "/"
        jar.set_cookie(cookie)
    match = re.search(r'name=["\']_csrf["\'][^>]*value=["\']([^"\']+)', page)
    if not match:
        match = re.search(r'value=["\']([^"\']+)["\'][^>]*name=["\']_csrf["\']', page)
    if not match:
        raise ValueError("Gitea login form has no CSRF token")
    body = urlencode({"user_name": GITEA_USER, "password": GITEA_PASSWORD, "_csrf": match.group(1)}).encode()
    request = Request(GITEA_URL + "/user/login", data=body, method="POST",
                      headers={"Content-Type": "application/x-www-form-urlencoded"})
    try:
        with opener.open(request, timeout=10) as response:
            response.read()
    except HTTPError as error:
        if error.code not in (302, 303):
            raise
    by_name = {}
    for cookie in jar:
        if cookie.name != "_csrf" and (cookie.name not in by_name or len(cookie.path) > len(by_name[cookie.name].path)):
            by_name[cookie.name] = cookie
    cookies = list(by_name.values())
    if not cookies:
        raise ValueError("Gitea did not create a session")
    verification = Request(GITEA_URL + "/user/settings",
                           headers={"Cookie": "; ".join("%s=%s" % (cookie.name, cookie.value) for cookie in cookies)})
    with build_opener(NoRedirect()).open(verification, timeout=10) as response:
        if response.status != 200:
            raise ValueError("Gitea credentials were rejected")
    return cookies


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print("learning-service: " + fmt % args, flush=True)

    def respond(self, status, payload):
        body = json.dumps(payload, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def body(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length > 64 * 1024:
            raise ValueError("request body too large")
        self.raw_body = self.rfile.read(length) or b"{}"
        return json.loads(self.raw_body)

    def session(self, identifier):
        with LOCK:
            session = SESSIONS.get(identifier)
        if not session:
            self.respond(404, {"error": "session not found"})
            return None
        if self.headers.get("Authorization") != "Bearer " + session["token"]:
            self.respond(401, {"error": "invalid session token"})
            return None
        return session

    def session_stream(self, identifier):
        with LOCK:
            session = SESSIONS.get(identifier)
        if not session:
            self.respond(404, {"error": "session not found"})
            return
        protocols = [item.strip() for item in self.headers.get("Sec-WebSocket-Protocol", "").split(",")]
        if "argo-coach" not in protocols or "token." + session["token"] not in protocols:
            self.respond(401, {"error": "invalid session token"})
            return
        if self.headers.get("Upgrade", "").lower() != "websocket" or \
           "upgrade" not in self.headers.get("Connection", "").lower() or \
           self.headers.get("Sec-WebSocket-Version") != "13":
            self.respond(400, {"error": "WebSocket upgrade required"})
            return
        try:
            key = self.headers["Sec-WebSocket-Key"]
            if len(base64.b64decode(key, validate=True)) != 16:
                raise ValueError("invalid WebSocket key")
        except (KeyError, ValueError, binascii.Error):
            self.respond(400, {"error": "invalid WebSocket key"})
            return
        accept = base64.b64encode(hashlib.sha1(
            (key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()
        ).digest()).decode()
        self.send_response(101)
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", accept)
        self.send_header("Sec-WebSocket-Protocol", "argo-coach")
        self.end_headers()
        self.close_connection = True
        last_view = None
        last_sent = time.monotonic()
        while True:
            try:
                if select.select([self.connection], [], [], 0)[0]:
                    opcode, payload = websocket_client_control(self.rfile)
                    if opcode == 8:
                        self.wfile.write(websocket_frame(payload, opcode=8))
                        self.wfile.flush()
                        return
                    if opcode == 9:
                        self.wfile.write(websocket_frame(payload, opcode=10))
                        self.wfile.flush()
                view = json.dumps(session_view(session), separators=(",", ":"))
                if view != last_view:
                    self.wfile.write(websocket_frame(view))
                    self.wfile.flush()
                    last_view = view
                    last_sent = time.monotonic()
                elif time.monotonic() - last_sent > 30:
                    self.wfile.write(websocket_frame(b"", opcode=9))
                    self.wfile.flush()
                    last_sent = time.monotonic()
                if session["feedback"] is not None:
                    return
                time.sleep(4)
            except (BrokenPipeError, ConnectionResetError, OSError, ValueError):
                return

    def do_GET(self):
        path = urlparse(self.path).path
        parts = path.strip("/").split("/")
        if path == "/healthz":
            self.respond(200, {"status": "ok"})
            return
        if path == "/api/catalog":
            self.respond(200, public_catalog())
            return
        if path == "/api/auth/argocd":
            request = Request(ARGOCD_URL + "/api/v1/session",
                              data=json.dumps({"username": ARGOCD_USER, "password": ARGOCD_PASSWORD}).encode(),
                              method="POST", headers={"Content-Type": "application/json"})
            try:
                with urlopen(request, timeout=10) as response:
                    token = json.loads(response.read()).get("token")
                if not token:
                    raise ValueError("Argo CD returned no token")
                body = b'{"authenticated":true}'
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                # Argo's 3.3 UI reads its HttpOnly cookie, not localStorage.
                # This response is same-origin through the gateway.
                self.send_header("Set-Cookie", "argocd.token=%s; Path=/argocd; HttpOnly; SameSite=Lax" % token)
                self.end_headers()
                self.wfile.write(body)
            except (HTTPError, URLError, ValueError) as error:
                self.respond(503, {"error": "Argo CD login failed: %s" % error})
            return
        if path == "/api/auth/gitea":
            try:
                cookies = gitea_session_cookies()
            except (HTTPError, URLError, ValueError) as error:
                self.respond(503, {"error": "Gitea login failed: %s" % error})
                return
            body = b'{"authenticated":true}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            for cookie in cookies:
                # Match Gitea's own cookie path exactly. A trailing slash
                # creates a second same-name session cookie; Gitea can then
                # validate the form token against a different session.
                self.send_header("Set-Cookie", "%s=%s; Path=/gitea; HttpOnly; SameSite=Lax" % (cookie.name, cookie.value))
            self.end_headers()
            self.wfile.write(body)
            return
        if len(parts) == 3 and parts[:2] == ["api", "runs"]:
            status, run = controller("/api/runs/" + quote(parts[2]))
            self.respond(status, run)
            return
        if len(parts) == 3 and parts[:2] == ["api", "sessions"]:
            session = self.session(parts[2])
            if session:
                self.respond(200, session_view(session))
            return
        if len(parts) == 4 and parts[:2] == ["api", "sessions"] and parts[3] == "stream":
            self.session_stream(parts[2])
            return
        if len(parts) == 4 and parts[:2] == ["api", "sessions"] and parts[3] == "feedback":
            session = self.session(parts[2])
            if session:
                if session["feedback"] is None:
                    self.respond(409, {"error": "incident note has not been completed"})
                else:
                    self.respond(200, session["feedback"])
            return
        self.respond(404, {"error": "not found"})

    def do_POST(self):
        path = urlparse(self.path).path
        parts = path.strip("/").split("/")
        try:
            payload = self.body()
        except (ValueError, TypeError) as error:
            self.respond(400, {"error": str(error)})
            return
        if path == "/api/runs":
            mode = payload.get("mode", "demonstration")
            scenario = payload.get("scenario", "console-orientation")
            if mode not in {"demonstration", "guided", "challenge"} or scenario not in PACKS:
                self.respond(400, {"error": "invalid mode or scenario"})
                return
            if PACKS[scenario]["level"] == 1 and mode == "challenge":
                self.respond(400, {"error": "console orientation is available in Guided or Demonstration"})
                return
            request = {key: value for key, value in payload.items()
                       if key in {"scenario", "scenario_key", "seed", "environment", "replace_existing"}}
            request["scenario"] = scenario
            status, run = controller("/api/runs", "POST", request)
            if status >= 400:
                self.respond(status, run)
                return
            session = make_session(run, mode)
            self.respond(202, {"run": {key: value for key, value in run.items() if key != "manifest"},
                               "session": session_view(session, run, {}, include_token=True)})
            return
        if path == "/api/webhooks/gitea":
            self.webhook(payload)
            return
        if path == "/api/events/terminal":
            if not TERMINAL_TOKEN or self.headers.get("X-Lab-Terminal-Token") != TERMINAL_TOKEN:
                self.respond(401, {"error": "invalid terminal token"})
                return
            verb = re.sub(r"[^a-z0-9_.-]", "", str(payload.get("verb", "other")).lower())[:30] or "other"
            exit_code = payload.get("exit_code")
            if isinstance(exit_code, bool) or not isinstance(exit_code, int) or not 0 <= exit_code <= 255:
                self.respond(400, {"error": "invalid terminal exit code"})
                return
            with LOCK:
                session = SESSIONS.get(ACTIVE_SESSION_ID)
                if session and session["feedback"] is None:
                    event = {"type": "terminal_command", "details": {"verb": verb, "exit_code": exit_code}, "at": time.time()}
                    session["actions"].append(event)
                    log_event(session, event)
            self.respond(202, {"accepted": True})
            return
        if len(parts) == 4 and parts[:2] == ["api", "sessions"]:
            session = self.session(parts[2])
            if not session:
                return
            _, current_run = controller("/api/runs/" + quote(session["run_id"]))
            if current_run.get("trigger_revision"):
                session["trigger_revision"] = current_run["trigger_revision"]
            if parts[3] == "actions":
                _, probe = controller("/probe?application=" + quote(session["application"]))
                status, run = 200, current_run
                if status == 200 and run.get("state") == "READY":
                    controller("/api/runs/" + quote(session["run_id"]) + "/state", "POST", {"state": "INVESTIGATING"})
                try:
                    with LOCK:
                        result = record_action(session, payload, probe)
                except ValueError as error:
                    self.respond(409, {"error": str(error)})
                    return
                if session["pack"]["level"] == 1 and len(session["passed"]) == len(session["pack"]["checks"]):
                    controller("/api/runs/" + quote(session["run_id"]) + "/state", "POST", {"state": "COMPLETED"})
                    session["note"] = {"resource": session["application"], "evidence": "Healthy and Synced",
                                       "revision": context_for(session, probe)["revision"],
                                       "cause": "No incident", "fix": "No fix needed"}
                    with LOCK:
                        session["feedback"] = score(session, probe)
                self.respond(202, {"evaluation": result, "session": session_view(session, probe=probe)})
                return
            if parts[3] == "note":
                session["note"] = {key: str(payload.get(key, ""))
                                   for key in ("resource", "evidence", "revision", "cause", "fix")}
                _, probe = controller("/probe?application=" + quote(session["application"]))
                if session["mode"] == "guided" and len(session["passed"]) < len(session["pack"]["checks"]) + (session["pack"]["level"] != 1):
                    self.respond(409, {"error": "finish the evidence checks first"})
                    return
                if not probe.get("fixed") and session["pack"]["level"] != 1:
                    self.respond(409, {"error": "the deployment is still not fixed; the note was saved as a draft"})
                    return
                status, transition = controller("/api/runs/" + quote(session["run_id"]) + "/state", "POST", {"state": "COMPLETED"})
                if status >= 400:
                    self.respond(status, transition)
                    return
                with LOCK:
                    session["feedback"] = score(session, probe)
                self.respond(200, session["feedback"])
                return
            if parts[3] == "demonstrate-fix":
                if session["mode"] != "demonstration":
                    self.respond(403, {"error": "demonstration only"})
                    return
                status, result = controller("/api/runs/" + quote(session["run_id"]) + "/reference-fix", "POST", {})
                self.respond(status, result)
                return
        self.respond(404, {"error": "not found"})

    def webhook(self, payload):
        if not WEBHOOK_SECRET:
            self.respond(503, {"error": "webhook secret is not configured"})
            return
        # Gitea signatures are SHA-256 HMACs of the exact request body. The
        # reverse proxy must not transform the body before it reaches us.
        raw = self.raw_body
        given = self.headers.get("X-Gitea-Signature", "")
        expected = hmac.new(WEBHOOK_SECRET.encode(), raw, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(given, expected):
            self.respond(401, {"error": "invalid webhook signature"})
            return
        if payload.get("ref") == "refs/heads/main" and payload.get("after"):
            status, result = controller("/api/refresh", "POST", {})
            if status >= 400:
                self.respond(status, result)
                return
        files = []
        for commit in payload.get("commits") or []:
            files.extend(commit.get("added") or [])
            files.extend(commit.get("modified") or [])
            files.extend(commit.get("removed") or [])
        commits = payload.get("commits") or []
        details = {"files": files, "sha": payload.get("after", ""),
                   "message": commits[-1].get("message", "") if commits else "",
                   "force": bool(payload.get("forced")), "via": "gitea"}
        with LOCK:
            session = SESSIONS.get(ACTIVE_SESSION_ID)
            if session and session["feedback"] is None:
                event = {"type": "commit_pushed", "details": details, "at": time.time()}
                session["actions"].append(event)
                log_event(session, event)
        self.respond(202, {"accepted": True})

    def do_DELETE(self):
        global ACTIVE_SESSION_ID
        parts = urlparse(self.path).path.strip("/").split("/")
        if len(parts) == 3 and parts[:2] == ["api", "runs"]:
            status, result = controller("/api/runs/" + quote(parts[2]), "DELETE")
            if status < 400:
                with LOCK:
                    active = SESSIONS.get(ACTIVE_SESSION_ID)
                    if active and active["run_id"] == parts[2]:
                        ACTIVE_SESSION_ID = None
            self.respond(status, result)
            return
        self.respond(404, {"error": "not found"})


def main():
    load_packs()
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print("learning-service listening on %d" % PORT, flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
