#!/usr/bin/env python3
"""Exercise repeated baseline resets against an explicitly named lab context.

Example: python3 tests/live_reset_soak.py --context colima-argo-remotelab
"""

import argparse
import json
import subprocess
import time
import urllib.error
import urllib.request


APPS = ("shop-web-prod", "shop-web-staging")
NAMESPACES = ("applications", "shop-staging")
TEMPORARY_RESOURCES = (("deployment", "django-web"), ("configmap", "django-app-missing-config"))


def request(base, path, method="GET", data=None):
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request(base + path, body, method=method)
    if body is not None:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=15) as response:
        return json.load(response)


def kubectl(context, *args, check=True):
    return subprocess.run(["kubectl", "--context", context, *args],
                          capture_output=True, text=True, check=check)


def wait_for_forward(base, process):
    for _ in range(30):
        if process.poll() is not None:
            raise RuntimeError("controller port-forward exited")
        try:
            if request(base, "/healthz")["status"] == "ok":
                return
        except urllib.error.URLError:
            time.sleep(1)
    raise TimeoutError("controller port-forward did not become ready")


def seed_leftovers(context):
    for namespace in NAMESPACES:
        kubectl(context, "-n", namespace, "create", "configmap", "django-app-missing-config",
                "--from-literal=lab=temporary")
        kubectl(context, "-n", namespace, "create", "deployment", "django-web",
                "--image=public.ecr.aws/docker/library/postgres:18.6", "--replicas=0")


def check_no_leftovers(context):
    for namespace in NAMESPACES:
        for kind, name in TEMPORARY_RESOURCES:
            result = kubectl(context, "-n", namespace, "get", kind, name, check=False)
            if result.returncode == 0:
                raise AssertionError(f"{namespace}/{kind}/{name} survived reset")
            if "NotFound" not in result.stderr and "not found" not in result.stderr.lower():
                raise RuntimeError(result.stderr)


def wait_ready(base, run_id):
    deadline = time.monotonic() + 420
    while time.monotonic() < deadline:
        run = request(base, "/api/runs/" + run_id)
        if run["state"] == "READY":
            return run
        if run["state"] == "FAILED":
            raise RuntimeError(run.get("error") or "reset failed")
        time.sleep(3)
    raise TimeoutError("reset did not reach READY")


def create_run(base, iteration):
    for _ in range(10):
        try:
            return request(base, "/api/runs", "POST", {
                "scenario": "console-orientation", "environment": "prod",
                "scenario_key": f"reset-soak-{iteration}",
            })
        except urllib.error.HTTPError as error:
            if error.code != 409:
                raise
            time.sleep(2)
    raise RuntimeError("previous run did not stop before the next reset")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--context", required=True, help="explicit isolated k3s context")
    parser.add_argument("--count", type=int, default=20)
    parser.add_argument("--port", type=int, default=18092)
    args = parser.parse_args()
    if args.count < 1:
        parser.error("--count must be positive")
    kubectl(args.context, "-n", "applications", "get", "service", "scenario-controller")
    base = f"http://127.0.0.1:{args.port}"
    forward = subprocess.Popen([
        "kubectl", "--context", args.context, "-n", "applications", "port-forward",
        "svc/scenario-controller", f"{args.port}:8092",
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    run_id = None
    baseline = None
    try:
        wait_for_forward(base, forward)
        for iteration in range(1, args.count + 1):
            seed_leftovers(args.context)
            created = create_run(base, iteration)
            run_id = created["id"]
            wait_ready(base, run_id)
            head = None
            for application in APPS:
                probe = request(base, "/probe?application=" + application)
                status = probe["status"]
                assert probe["fixed"] is True and probe["http_ok"] is True, (iteration, application, probe)
                assert probe["other_application_healthy"] is True, (iteration, application, probe)
                assert status["health"]["status"] == "Healthy" and status["sync"]["status"] == "Synced"
                assert status["sync"]["revision"] == probe["git_revision"]
                if head is None:
                    head = probe["git_revision"]
                assert head == probe["git_revision"]
            if baseline is None:
                baseline = head
            assert head == baseline, f"baseline HEAD drifted on reset {iteration}: {head} != {baseline}"
            check_no_leftovers(args.context)
            request(base, "/api/runs/" + run_id, "DELETE")
            run_id = None
            print(f"reset {iteration}/{args.count}: Healthy/Synced at {head[:10]}, no leftovers", flush=True)
        print(f"PASS: {args.count} resets returned to one baseline with no resource drift", flush=True)
    finally:
        if run_id:
            try:
                request(base, "/api/runs/" + run_id, "DELETE")
            except Exception:
                pass
        for namespace in NAMESPACES:
            for kind, name in TEMPORARY_RESOURCES:
                kubectl(args.context, "-n", namespace, "delete", kind, name,
                        "--ignore-not-found=true", check=False)
        forward.terminate()
        try:
            forward.wait(timeout=3)
        except subprocess.TimeoutExpired:
            forward.kill()


if __name__ == "__main__":
    main()
