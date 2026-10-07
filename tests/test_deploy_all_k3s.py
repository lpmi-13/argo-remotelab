"""Exercise deploy-all's Linux k3s startup without touching the host service."""

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts/deploy-all.sh"
REFRESH_SCRIPT = SCRIPT.parent / "manual-refresh.sh"


class DeployAllK3sStartupTests(unittest.TestCase):
    def run_deploy(self, *args, active=False, start_fails=False, api_never_ready=False,
                   auth_rejected=False, sudo_valid=True):
        with tempfile.TemporaryDirectory() as directory:
            temp = Path(directory)
            commands = {
                "systemctl": """#!/bin/sh
printf 'systemctl %s\\n' "$*" >> "$CALLS"
case "$1" in
    is-active) [ "$ACTIVE" = 1 ] ;;
    start) [ "$START_FAILS" = 0 ] || exit 1; touch "$STARTED" ;;
esac
""",
                "sudo": """#!/bin/sh
printf 'sudo %s\\n' "$*" >> "$CALLS"
if [ "$1" = -v ]; then [ "$SUDO_VALID" = 1 ]; exit $?; fi
exec "$@"
""",
                "kubectl": """#!/bin/sh
printf 'kubectl %s\\n' "$*" >> "$CALLS"
if [ "$1" = cluster-info ]; then
    [ -f "$STARTED" ] || exit 1
    if [ "$AUTH_REJECTED" = 1 ]; then
        printf 'error: You must be logged in to the server\\n' >&2
        exit 1
    fi
    [ "$ACTIVE" = 1 ] && exit 0
    count=0
    [ ! -f "$PROBES" ] || count=$(cat "$PROBES")
    count=$((count + 1))
    printf '%s\\n' "$count" > "$PROBES"
    [ "$API_NEVER_READY" = 0 ] || exit 1
    [ "$count" -ge 2 ]
    exit $?
fi
if [ "$1" = get ] && [ "$2" = nodes ]; then
    exit 0
fi
exit 1
""",
                "bash": """#!/bin/sh
printf 'warm %s\\n' "$*" >> "$CALLS"
exit 1
""",
                "sleep": "#!/bin/sh\nexit 0\n",
                "uname": "#!/bin/sh\nprintf 'Linux\\n'\n",
                "ip": "#!/bin/sh\nprintf '1 via 192.0.2.1 dev eth0 src 192.0.2.10\\n'\n",
            }
            for name, content in commands.items():
                command = temp / name
                command.write_text(content)
                command.chmod(0o755)

            calls = temp / "calls"
            env = os.environ.copy()
            env.update(
                PATH=f"{temp}:{env['PATH']}",
                CALLS=str(calls),
                STARTED=str(temp / "started"),
                PROBES=str(temp / "probes"),
                ACTIVE="1" if active else "0",
                START_FAILS="1" if start_fails else "0",
                API_NEVER_READY="1" if api_never_ready else "0",
                AUTH_REJECTED="1" if auth_rejected else "0",
                SUDO_VALID="1" if sudo_valid else "0",
            )
            if active:
                (temp / "started").touch()
            result = subprocess.run(
                ["/bin/bash", str(SCRIPT), *args],
                env=env,
                capture_output=True,
                text=True,
                timeout=20,
                check=False,
            )
            return result, calls.read_text().splitlines() if calls.exists() else []

    def test_stopped_k3s_starts_before_warm_check(self):
        result, calls = self.run_deploy()
        self.assertIn("OK: k3s API reachable", result.stdout)
        self.assertIn("Could not determine k3s node name", result.stdout)
        warm_check = next(i for i, call in enumerate(calls) if call.startswith("warm "))
        api_checks = [i for i, call in enumerate(calls) if call == "kubectl cluster-info"]
        self.assertLess(calls.index("systemctl start k3s"), api_checks[0])
        self.assertGreaterEqual(len(api_checks), 2)
        self.assertLess(api_checks[1], warm_check)

    def test_running_k3s_is_not_started_again(self):
        result, calls = self.run_deploy("--full", active=True)
        self.assertNotIn("Starting k3s service", result.stdout)
        self.assertIn("Could not determine k3s node name", result.stdout)
        self.assertNotIn("systemctl start k3s", calls)
        self.assertIn("kubectl cluster-info", calls)

    def test_start_failure_stops_deployment(self):
        result, calls = self.run_deploy("--full", start_fails=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Could not start k3s service", result.stderr)
        self.assertFalse(any(call.startswith("kubectl ") for call in calls))

    def test_sudo_preflight_stops_full_deployment(self):
        result, calls = self.run_deploy("--full", active=True, sudo_valid=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Linux deployment needs sudo access", result.stderr)
        self.assertIn("sudo -v", calls)
        self.assertFalse(any(call.startswith("kubectl get nodes") for call in calls))

    def test_api_wait_ends_after_15_seconds(self):
        result, calls = self.run_deploy(api_never_ready=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("within 15s", result.stderr)
        self.assertEqual(calls.count("kubectl cluster-info"), 6)
        self.assertFalse(any(call.startswith("warm ") for call in calls))

    def test_rejected_credentials_show_manual_refresh_before_warm_check(self):
        result, calls = self.run_deploy(active=True, auth_rejected=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("kubectl credentials", result.stderr)
        self.assertIn("MANUAL ACTION REQUIRED", result.stderr)
        self.assertIn("./scripts/manual-refresh.sh", result.stderr)
        self.assertFalse(any(call.startswith("warm ") for call in calls))

    def test_ip_repair_uses_one_15_second_deadline(self):
        script = SCRIPT.read_text()
        function = "wait_for_k3s_ip_repair() {" + script.split(
            "wait_for_k3s_ip_repair() {", 1
        )[1].split("\n}\n", 1)[0] + "\n}"
        harness = """set -eo pipefail
K3S_READY_TIMEOUT=15
probe=0
kubectl() {
    if [[ "$1" == cluster-info ]]; then
        probe=$((probe + 1))
    else
        printf 'True'
    fi
}
get_k3s_node_internal_ip() {
    if (( probe >= converge_at )); then printf '192.0.2.10'; else printf '192.0.2.9'; fi
}
get_kubernetes_endpoint_ip() {
    if (( probe >= converge_at )); then printf '192.0.2.10'; else printf '192.0.2.9'; fi
}
sleep() { :; }
""" + function + """
if wait_for_k3s_ip_repair test-node 192.0.2.10; then status=0; else status=$?; fi
printf 'probes=%s status=%s\\n' "$probe" "$status"
"""
        for converge_at, expected in ((3, "probes=3 status=0"),
                                      (100, "probes=6 status=1")):
            with self.subTest(converge_at=converge_at):
                result = subprocess.run(
                    ["/bin/bash", "-c", harness],
                    env={**os.environ, "converge_at": str(converge_at)},
                    capture_output=True,
                    text=True,
                    timeout=5,
                    check=False,
                )
                self.assertEqual(result.returncode, 0)
                self.assertIn(expected, result.stdout)
                if converge_at == 100:
                    self.assertIn("within 15s", result.stderr)

    def test_cleanup_preflight_reports_unavailable_api_service(self):
        script = SCRIPT.read_text()
        function = "check_api_services_available() {" + script.split(
            "check_api_services_available() {", 1
        )[1].split("\n}\n", 1)[0] + "\n}"
        harness = """set -eo pipefail
kubectl() { printf '%s' "$API_SERVICES"; }
""" + function + """
if check_api_services_available; then echo healthy; else echo blocked; fi
"""
        for status, expected in (("True", "healthy"), ("False", "blocked")):
            with self.subTest(status=status):
                apiservices = {"items": [{
                    "metadata": {"name": "v1beta1.metrics.k8s.io"},
                    "status": {"conditions": [{"type": "Available", "status": status,
                                               "reason": "MissingEndpoints"}]},
                }]}
                result = subprocess.run(
                    ["/bin/bash", "-c", harness],
                    env={**os.environ, "API_SERVICES": json.dumps(apiservices)},
                    capture_output=True,
                    text=True,
                    timeout=5,
                    check=False,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(expected, result.stdout)
                if status == "False":
                    self.assertIn("v1beta1.metrics.k8s.io: MissingEndpoints", result.stderr)


class ManualRefreshTests(unittest.TestCase):
    def run_refresh(self, *, contexts="default", fresh_content="fresh"):
        with tempfile.TemporaryDirectory() as directory:
            temp = Path(directory)
            command_dir = temp / "bin"
            command_dir.mkdir()
            config = temp / "config"
            config.write_text("stale")
            source = temp / "source"
            source.write_text(fresh_content)
            calls = temp / "calls"
            commands = {
                "uname": "#!/bin/sh\nprintf 'Linux\\n'\n",
                "sudo": """#!/bin/sh
printf 'sudo %s\\n' "$*" >> "$CALLS"
[ "$1" = cat ] && [ "$2" = /etc/rancher/k3s/k3s.yaml ] || exit 1
cat "$SOURCE"
""",
                "kubectl": """#!/bin/sh
case "$1 $2" in
    'config get-contexts') printf '%s\\n' "$CONTEXTS" ;;
    'config view') printf 'https://127.0.0.1:6443' ;;
    'cluster-info ')
        [ "$(cat "$KUBECONFIG")" = fresh ] || exit 1
        printf 'Kubernetes is running\\n'
        ;;
    *) exit 1 ;;
esac
""",
            }
            for name, content in commands.items():
                command = command_dir / name
                command.write_text(content)
                command.chmod(0o755)
            env = os.environ.copy()
            env.update(
                PATH=f"{command_dir}:{env['PATH']}",
                KUBECONFIG=str(config),
                SOURCE=str(source),
                CALLS=str(calls),
                CONTEXTS=contexts,
            )
            result = subprocess.run(
                ["/bin/bash", str(REFRESH_SCRIPT)],
                env=env,
                capture_output=True,
                text=True,
                timeout=5,
                check=False,
            )
            backups = list(temp.glob("config.bak.*"))
            return result, config.read_text(), [
                (backup.read_text(), backup.stat().st_mode & 0o777) for backup in backups
            ], calls.read_text() if calls.exists() else ""

    def test_refresh_backs_up_and_replaces_local_config(self):
        result, config, backups, calls = self.run_refresh()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(config, "fresh")
        self.assertEqual(backups, [("stale", 0o600)])
        self.assertIn("sudo cat /etc/rancher/k3s/k3s.yaml", calls)

    def test_refresh_refuses_multiple_contexts(self):
        result, config, backups, calls = self.run_refresh(contexts="default\nother")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("refusing to replace", result.stderr)
        self.assertEqual(config, "stale")
        self.assertEqual(backups, [])
        self.assertEqual(calls, "")

    def test_refresh_preserves_config_if_new_credentials_fail(self):
        result, config, backups, _ = self.run_refresh(fresh_content="invalid")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(config, "stale")
        self.assertEqual(backups, [])


if __name__ == "__main__":
    unittest.main()
