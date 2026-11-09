#!/usr/bin/env python3
"""Write real session views as a TypeScript module for the coach's contract check.

Every scenario, in each mode it allows, passes through the run phases the coach
renders: preparing (the POST /api/runs response), investigating, verifying the
fix, and completed with feedback. Extra samples cover each alert and an
unreachable scenario controller.

`npm run typecheck:contract` in argocd-coach/ runs this and type-checks the
output against argocd-coach/types/session-view.d.ts, so a field the server adds,
drops, renames or retypes fails the check until the coach's types follow.

Usage: session_view_samples.py OUTPUT.ts
"""

import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
os.environ.setdefault("LEARNING_DIR", str(HERE.parent / "learning"))
sys.path.insert(0, str(HERE))
import server  # noqa: E402

TRIGGER = "a1b2c3d4" * 5
SERVING = "c3d4e5f6" * 5
FIXED = "e5f6a7b8" * 5
MODES = ("demonstration", "guided", "challenge")


def lab_run(scenario, environment, state):
    """A scenario-controller run as the learning service receives it."""
    return {"id": "run-sample", "scenario": scenario, "environment": environment,
            "application": "shop-web-" + environment, "trigger_revision": TRIGGER,
            "serving_revision": SERVING, "seed": 4242, "state": state,
            "created_at": "2026-11-09T10:00:00Z", "updated_at": "2026-11-09T10:05:00Z"}


def probe(fixed, durable=None, conditions=()):
    revision = FIXED if fixed else TRIGGER
    return {"fixed": fixed, "durable": fixed if durable is None else durable,
            "git_revision": revision, "other_application_healthy": True, "operation_running": False,
            "status": {"health": {"status": "Healthy" if fixed else "Degraded"},
                       "sync": {"status": "Synced" if fixed else "OutOfSync", "revision": revision},
                       "conditions": list(conditions)}}


def new_session(scenario, mode, environment="prod"):
    session = server.make_session(lab_run(scenario, environment, "CREATED"), mode)
    session.update(id="session-sample", token="token-sample")
    return session


def visit(session, *targets):
    for target in targets:
        session["visited"].add(target)


def act(session, kind, **details):
    session["actions"].append({"type": kind, "details": details, "at": 0})


def view(session, state, current_probe, include_token=False):
    run = lab_run(session["pack"]["id"], session["environment"], state)
    return server.build_session_view(session, run, current_probe, include_token)


def scenario_samples(scenario, mode, environment):
    """The views one run produces from creation to debrief."""
    pack = server.PACKS[scenario]
    checks = pack["checks"]
    session = new_session(scenario, mode, environment)
    label = f"{scenario} · {mode} · {environment}"
    preparing = {f"{label} · preparing": view(session, "RESETTING", {}, include_token=True)}

    first = server.check_targets(checks[0])[0]
    visit(session, first)
    act(session, "target_visited", target=first, application=session["application"])
    act(session, "hint_requested", target=first)
    unfixed = probe(fixed=pack["level"] == 1)
    views = {f"{label} · investigating": view(session, "INVESTIGATING", unfixed)}

    for check in checks:
        visit(session, *server.check_targets(check))
        if mode != "challenge":
            session["passed"].add(check["id"])
            session["answers"][check["id"]] = check["answer"]
    visit(session, *pack["targets"], "app.history")
    act(session, "step_demonstrated", target="app.history")
    act(session, "diff_viewed", application=session["application"])
    act(session, "sync_requested", application=session["application"], prune=False,
        dryRun=False, resources=[])
    act(session, "commit_pushed", files=list(pack["fix_paths"]), sha=FIXED,
        message="Repair the deployment", force=False, via="gitea")
    fixed = probe(fixed=True)
    views[f"{label} · verifying"] = view(session, "FIXED", fixed)

    if mode != "challenge" and pack["level"] != 1:
        session["passed"].add("verify-revision")
        session["answers"]["verify-revision"] = FIXED
    truth = server.expand(pack["truth"], server.context_for(session, fixed))
    session["note"] = {"resource": truth["resource"], "evidence": truth.get("evidence", "Healthy and Synced"),
                       "revision": TRIGGER, "cause": truth["cause"], "fix": truth["fix"]}
    session["feedback"] = server.score(session, fixed)
    views[f"{label} · completed"] = view(session, "COMPLETED", fixed)
    return preparing, views


def alert_samples():
    """One view for each alert the coach can show."""
    views = {}
    fix_path = server.PACKS["missing-configmap"]["fix_paths"][0]

    session = new_session("missing-configmap", "guided")
    act(session, "commit_pushed", files=["secrets.yaml"], sha=FIXED, message="", force=False, via="gitea")
    views["alert · secret_leaked"] = view(session, "INVESTIGATING", probe(fixed=False))

    session = new_session("missing-configmap", "guided")
    act(session, "resource_updated", application=session["application"])
    view(session, "INVESTIGATING", probe(fixed=True, durable=False))
    views["alert · live_edit_reverted"] = view(session, "INVESTIGATING", probe(fixed=False))

    session = new_session("missing-configmap", "challenge")
    act(session, "commit_pushed", files=["README.md"], sha=FIXED, message="", force=False, via="gitea")
    views["alert · wrong_file_edited"] = view(session, "INVESTIGATING", probe(fixed=False))

    session = new_session("missing-configmap", "challenge")
    act(session, "commit_pushed", files=[fix_path], sha=FIXED, message="", force=False, via="gitea")
    broken = probe(fixed=False, conditions=[{"type": "ComparisonError", "message": "render failed"}])
    views["alert · fix_broke_render"] = view(session, "INVESTIGATING", broken)
    return views


def unreachable_controller_sample():
    """session_view() passes the controller's error body through as the run and probe."""
    session = new_session("missing-configmap", "guided")
    unavailable = {"error": "scenario controller unavailable: connection refused"}
    return {"controller unreachable": server.build_session_view(session, unavailable, unavailable, False)}


def samples():
    server.load_packs()
    server.log_event = lambda *args, **kwargs: None
    new_views, views = {}, {}
    for scenario, pack in server.PACKS.items():
        for mode in MODES:
            if pack["level"] == 1 and mode == "challenge":
                continue
            for environment in ("prod", "staging"):
                preparing, run_views = scenario_samples(scenario, mode, environment)
                new_views.update(preparing)
                views.update(run_views)
    views.update(alert_samples())
    views.update(unreachable_controller_sample())
    return new_views, views


def typescript(new_views, views):
    def record(value):
        return json.dumps(value, indent=2, ensure_ascii=False, sort_keys=True)
    return "\n".join([
        "// Generated by learning-service/session_view_samples.py; do not edit.",
        "// Real learning-service output, checked against argocd-coach/types/session-view.d.ts.",
        "",
        f"export const newSessionViews: Record<string, NewSessionView> = {record(new_views)};",
        "",
        f"export const sessionViews: Record<string, SessionView> = {record(views)};",
        "",
    ])


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: session_view_samples.py OUTPUT.ts")
    output = Path(sys.argv[1])
    output.parent.mkdir(parents=True, exist_ok=True)
    new_views, views = samples()
    output.write_text(typescript(new_views, views), encoding="utf-8")
    print(f"session_view_samples: wrote {len(new_views) + len(views)} views to {output}")


if __name__ == "__main__":
    main()
