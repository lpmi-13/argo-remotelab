#!/usr/bin/env python3
"""Exercise every scenario's live state and learning mode in an isolated lab.

The controller's reference fix is used as a fixture for Guided and Challenge.
Browser navigation and learner repair surfaces are covered separately; this
matrix checks injection, detection, remediation predicates, and mode policy.
"""

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
PACKS = ROOT / "learning" / "scenarios"
SCENARIOS = [
    "missing-configmap", "stuck-sync", "stale-job", "orphaned-resource",
    "sops-decrypt-failure", "sops-global-mac-mismatch", "hmac-mismatch",
    "wrong-type-sops", "env-drift", "repo-auth",
]
MODES = ["demonstration", "guided", "challenge"]


def request(base, route, method="GET", payload=None, token=None, timeout=20):
    body = json.dumps(payload).encode() if payload is not None else None
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    req = Request(base + route, data=body, method=method, headers=headers)
    try:
        with urlopen(req, timeout=timeout) as response:
            return response.status, json.loads(response.read())
    except HTTPError as error:
        try:
            detail = json.loads(error.read())
        except ValueError:
            detail = {"error": str(error)}
        return error.code, detail


def checked(base, route, method="GET", payload=None, token=None):
    status, result = request(base, route, method, payload, token)
    if status >= 400:
        raise RuntimeError(f"{method} {route}: HTTP {status}: {result}")
    return result


def wait_until(label, predicate, seconds=480):
    deadline = time.monotonic() + seconds
    last = None
    while time.monotonic() < deadline:
        last = predicate()
        if last:
            return last
        time.sleep(3)
    raise TimeoutError(f"{label} timed out; last state: {last}")


def forward(context, name, port, remote):
    process = subprocess.Popen(
        ["kubectl", "--context", context, "-n", "applications", "port-forward",
         "svc/" + name, f"{port}:{remote}"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    base = f"http://127.0.0.1:{port}"
    try:
        wait_until(name + " port-forward", lambda: process.poll() is None and health(base), 20)
        return process
    except Exception:
        process.terminate()
        raise


def health(base):
    try:
        with urlopen(base + "/healthz", timeout=1) as response:
            return response.status == 200
    except (URLError, TimeoutError):
        return False


def expand(text, view):
    values = {
        "application": view["application"], "environment": view["environment"],
        "revision": view["revision"], "health": view["health"],
    }
    for name, value in values.items():
        text = text.replace("${" + name + "}", str(value or ""))
    return text


def one_case(gateway, controller, scenario, mode, environment):
    pack = json.loads((PACKS / scenario / "pack.json").read_text())
    run_id = None
    started = time.monotonic()
    try:
        created = checked(gateway, "/coach/learning/api/runs", "POST", {
            "scenario": scenario, "mode": mode, "environment": environment,
            "scenario_key": f"live-matrix-{scenario}-{mode}-{environment}",
        })
        run_id = created["run"]["id"]
        session_id = created["session"]["session_id"]
        token = created["session"]["connection_token"]
        session_route = "/coach/learning/api/sessions/" + quote(session_id)
        run_route = "/coach/learning/api/runs/" + quote(run_id)
        wait_until("READY " + scenario, lambda: ready_run(gateway, run_route))
        sequence = 0

        def view():
            return checked(gateway, session_route, token=token)

        def action(kind, details):
            nonlocal sequence
            sequence += 1
            return checked(gateway, session_route + "/actions", "POST", {
                "protocol_version": 2, "sequence": sequence, "type": kind,
                "actor": "tutorial" if mode == "demonstration" else "learner",
                "details": details,
            }, token=token)

        if mode != "challenge":
            for check in pack["checks"]:
                target = check["target"]
                if isinstance(target, list):
                    target = target[0]
                action("target_visited", {"target": target, "application": created["run"]["application"]})
                expected = expand(check["answer"], view())
                result = action("evidence_check_answered", {"check_id": check["id"], "answer": expected})
                if not result["evaluation"].get("correct"):
                    raise AssertionError(f"{scenario} {mode}: rejected authored answer for {check['id']}")

        if mode == "demonstration":
            checked(gateway, session_route + "/demonstrate-fix", "POST", {}, token=token)
        else:
            checked(controller, "/api/runs/" + quote(run_id) + "/reference-fix", "POST", {})

        fixed = wait_until("fixed and durable " + scenario,
                           lambda: fixed_probe(controller, created["run"]["application"]), 480)
        if mode != "challenge":
            action("target_visited", {"target": "app.history", "application": created["run"]["application"]})
            result = action("evidence_check_answered", {"check_id": "verify-revision", "answer": view()["revision"]})
            if not result["evaluation"].get("correct"):
                raise AssertionError(f"{scenario} {mode}: deployed revision check failed")
        else:
            for check in pack["checks"]:
                target = check["target"]
                if isinstance(target, list):
                    target = target[0]
                action("target_visited", {"target": target, "application": created["run"]["application"]})

        current = view()
        truth = {key: expand(str(value), current) for key, value in pack["truth"].items()}
        note = {
            "resource": truth.get("resource", current["application"]),
            "evidence": truth.get("evidence", "Healthy and Synced"),
            "revision": current["trigger_revision"],
            "cause": truth.get("cause", scenario),
            "fix": truth.get("fix", "Reference fix applied"),
        }
        feedback = checked(gateway, session_route + "/note", "POST", note, token=token)
        final_run = checked(gateway, run_route)
        if final_run["state"] != "COMPLETED" or not feedback["fixed"] or not feedback["durable"]:
            raise AssertionError(f"{scenario} {mode}: incomplete result: {final_run['state']}, {feedback}")
        if mode == "challenge" and not 0 <= feedback["total"] <= 100:
            raise AssertionError(f"{scenario}: invalid challenge score {feedback['total']}")
        return {"scenario": scenario, "mode": mode, "environment": environment,
                "seconds": round(time.monotonic() - started, 1),
                "score": feedback["total"], "revision": fixed["status"]["sync"]["revision"][:7]}
    finally:
        if run_id:
            try:
                checked(gateway, "/coach/learning/api/runs/" + quote(run_id), "DELETE")
            except Exception as error:
                print(f"cleanup {run_id}: {error}", file=sys.stderr, flush=True)


def ready_run(gateway, route):
    run = checked(gateway, route)
    if run["state"] == "FAILED":
        raise RuntimeError(run.get("error", "run failed"))
    return run if run["state"] == "READY" else None


def fixed_probe(controller, application):
    probe = checked(controller, "/probe?application=" + quote(application))
    return probe if probe.get("fixed") and probe.get("durable") and probe.get("other_application_healthy") else None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--context", required=True, help="dedicated Kubernetes context")
    parser.add_argument("--scenario", action="append", choices=SCENARIOS)
    parser.add_argument("--mode", action="append", choices=MODES)
    parser.add_argument("--gateway-port", type=int, default=18080)
    parser.add_argument("--controller-port", type=int, default=18092)
    args = parser.parse_args()
    if args.context == "" or args.context == "default":
        parser.error("use the isolated lab context")
    gateway_forward = controller_forward = None
    gateway = f"http://127.0.0.1:{args.gateway_port}"
    controller = f"http://127.0.0.1:{args.controller_port}"
    results = []
    try:
        gateway_forward = forward(args.context, "lab-gateway", args.gateway_port, 8080)
        controller_forward = forward(args.context, "scenario-controller", args.controller_port, 8092)
        for scenario in args.scenario or SCENARIOS:
            for mode in args.mode or MODES:
                environment = "staging" if (SCENARIOS.index(scenario) + MODES.index(mode)) % 2 else "prod"
                print(f"RUN {scenario} {mode} {environment}", flush=True)
                result = one_case(gateway, controller, scenario, mode, environment)
                results.append(result)
                print("PASS " + json.dumps(result, sort_keys=True), flush=True)
        print(f"PASS {len(results)} live cases", flush=True)
    finally:
        for process in (controller_forward, gateway_forward):
            if process:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()


if __name__ == "__main__":
    main()
