"""Check the bounded Colima network recovery used before deployment."""

import os
import subprocess
import tempfile
import unittest
from pathlib import Path


HELPER = Path(__file__).resolve().parents[1] / "scripts/lib/colima-network.sh"
PLATFORM = HELPER.parent / "platform.sh"


class ColimaNetworkTests(unittest.TestCase):
    def run_other_profile_lookup(self, output, *, status_ok=True):
        with tempfile.TemporaryDirectory() as directory:
            colima = Path(directory) / "colima"
            colima.write_text(
                "#!/bin/sh\n"
                "case \"$1\" in\n"
                "  list) printf '%s' \"$COLIMA_JSON\" ;;\n"
                "  status) [ \"$COLIMA_STATUS_OK\" = 1 ] ;;\n"
                "esac\n"
            )
            colima.chmod(0o755)
            return subprocess.run(
                ["bash", "-c", 'source "$HELPER"; colima_running_other_profiles argo-remotelab'],
                env={**os.environ, "PATH": f"{directory}:{os.environ['PATH']}",
                     "HELPER": str(HELPER), "COLIMA_JSON": output,
                     "COLIMA_STATUS_OK": str(int(status_ok))},
                capture_output=True, text=True, timeout=5, check=False,
            )

    def run_helper(self, *, vm_before=False, vm_after=False, host=True,
                   restart=True, api=True, other_profile="", other_vm_ok=False,
                   other_vm_after=False, list_ok=True, containers=False,
                   docker_ok=True, start_fail_once="", vm_succeeds_after=0,
                   host_succeeds_after=0):
        with tempfile.TemporaryDirectory() as directory:
            calls = Path(directory) / "calls"
            restarted = Path(directory) / "restarted"
            environment = {
                **os.environ,
                "HELPER": str(HELPER),
                "CALLS": str(calls),
                "RESTARTED": str(restarted),
                "VM_BEFORE": str(int(vm_before)),
                "VM_AFTER": str(int(vm_after)),
                "HOST_OK": str(int(host)),
                "RESTART_OK": str(int(restart)),
                "API_OK": str(int(api)),
                "OTHER_PROFILE": other_profile,
                "OTHER_VM_OK": str(int(other_vm_ok)),
                "OTHER_VM_AFTER": str(int(other_vm_after)),
                "LIST_OK": str(int(list_ok)),
                "CONTAINERS": str(int(containers)),
                "DOCKER_OK": str(int(docker_ok)),
                "START_FAIL_ONCE": start_fail_once,
                "VM_SUCCEEDS_AFTER": str(vm_succeeds_after),
                "HOST_SUCCEEDS_AFTER": str(host_succeeds_after),
                "TEMP_DIR": directory,
            }
            harness = r'''
source "$HELPER"
detect_local_context() { printf 'colima-argo-remotelab'; }
colima_running_other_profiles() {
    [[ "$LIST_OK" == 1 ]] || return 1
    if [[ -n "$OTHER_PROFILE" ]]; then printf '%s\n' "$OTHER_PROFILE"; fi
}
colima() {
    printf 'colima %s\n' "$*" >> "$CALLS"
    case "$1" in
        ssh)
            if [[ "$3" != argo-remotelab ]]; then
                if [[ "$OTHER_VM_OK" == 1 || -f "$TEMP_DIR/shared-started" && "$OTHER_VM_AFTER" == 1 ]]; then
                    printf '401'; return 0
                fi
                return 28
            fi
            if (( VM_SUCCEEDS_AFTER > 0 )); then
                count=$(cat "$TEMP_DIR/vm-probe-count" 2>/dev/null || printf '0')
                count=$((count + 1))
                printf '%s' "$count" > "$TEMP_DIR/vm-probe-count"
                if (( count > VM_SUCCEEDS_AFTER )); then printf '401'; return 0; fi
            fi
            if [[ "$VM_BEFORE" == 1 ]] || [[ "$VM_AFTER" == 1 &&
                ( -f "$RESTARTED" || -f "$TEMP_DIR/shared-started" ) ]]; then
                printf '401'
                return 0
            fi
            return 28
            ;;
        restart)
            touch "$RESTARTED"
            if [[ "$RESTART_OK" != 1 ]]; then
                touch "$TEMP_DIR/stopped-$3"
                return 1
            fi
            ;;
        stop)
            touch "$TEMP_DIR/stopped-$3"
            ;;
        start)
            if [[ "$START_FAIL_ONCE" == "$3" && ! -f "$TEMP_DIR/failed-start-$3" ]]; then
                touch "$TEMP_DIR/failed-start-$3"
                return 1
            fi
            rm -f "$TEMP_DIR/stopped-$3"
            if [[ "$3" == argo-remotelab ]]; then touch "$TEMP_DIR/shared-started"; fi
            ;;
        status)
            [[ ! -f "$TEMP_DIR/stopped-$3" ]]
            ;;
    esac
}
docker() {
    printf 'docker %s\n' "$*" >> "$CALLS"
    [[ "$DOCKER_OK" == 1 ]] || return 1
    case "$3" in
        ps)
            if [[ "$CONTAINERS" == 1 ]]; then printf 'abc\ndef\nghi\n'; fi
            ;;
        inspect)
            case "$5" in
                '{{.HostConfig.RestartPolicy.Name}}')
                    case "$6" in
                        abc) printf 'no\n' ;;
                        def) printf 'always\n' ;;
                        ghi) printf 'on-failure\n' ;;
                    esac
                    ;;
                '{{.State.Running}}') printf 'false\n' ;;
            esac
            ;;
        info) ;;
        start) ;;
    esac
}
curl() {
    printf 'host curl %s\n' "$*" >> "$CALLS"
    if (( HOST_SUCCEEDS_AFTER > 0 )); then
        count=$(cat "$TEMP_DIR/host-probe-count" 2>/dev/null || printf '0')
        count=$((count + 1))
        printf '%s' "$count" > "$TEMP_DIR/host-probe-count"
        if (( count <= HOST_SUCCEEDS_AFTER )); then return 28; fi
    fi
    if [[ "$HOST_OK" == 1 ]]; then printf '401'; else return 28; fi
}
kubectl() {
    printf 'kubectl %s\n' "$*" >> "$CALLS"
    [[ "$API_OK" == 1 ]]
}
sleep() { :; }
if ensure_colima_registry_access argo-remotelab; then result_code=0; else result_code=$?; fi
printf 'result=%s refreshed=%s\n' "$result_code" "$COLIMA_REFRESHED"
'''
            result = subprocess.run(
                ["bash", "-c", harness], env=environment, capture_output=True,
                text=True, timeout=10, check=False,
            )
            return result, calls.read_text().splitlines() if calls.exists() else []

    def test_healthy_vm_does_not_restart(self):
        result, calls = self.run_helper(vm_before=True)
        self.assertIn("result=0 refreshed=false", result.stdout)
        self.assertEqual(len(calls), 1)
        self.assertTrue(calls[0].startswith("colima ssh "))

    def test_restarts_once_and_waits_for_kubernetes(self):
        result, calls = self.run_helper(vm_after=True, other_profile="default", other_vm_ok=True)
        self.assertIn("result=0 refreshed=true", result.stdout)
        self.assertEqual(sum(call.startswith("colima restart ") for call in calls), 1)
        self.assertIn("kubectl --context colima-argo-remotelab cluster-info", calls)

    def test_stops_if_vm_network_stays_broken(self):
        result, calls = self.run_helper()
        self.assertIn("result=2 refreshed=true", result.stdout)
        self.assertIn("still cannot reach public.ecr.aws", result.stderr)
        self.assertEqual(sum(call.startswith("colima restart ") for call in calls), 1)

    def test_failed_profile_restart_attempts_to_start_stopped_vm(self):
        result, calls = self.run_helper(restart=False, other_profile="default", other_vm_ok=True)
        self.assertIn("result=2 refreshed=false", result.stdout)
        self.assertIn("Could not restart Colima profile", result.stderr)
        self.assertIn("colima start --profile argo-remotelab --activate=false", calls)

    def test_does_not_restart_when_host_is_offline(self):
        result, calls = self.run_helper(host=False)
        self.assertIn("result=2 refreshed=false", result.stdout)
        self.assertIn("Mac cannot reach public.ecr.aws", result.stderr)
        self.assertFalse(any(call.startswith("colima restart ") for call in calls))

    def test_transient_vm_failure_does_not_restart(self):
        result, calls = self.run_helper(vm_succeeds_after=1)
        self.assertIn("result=0 refreshed=false", result.stdout)
        self.assertEqual(sum(call.startswith("colima ssh ") for call in calls), 2)
        self.assertFalse(any(call.startswith(("colima restart ", "colima stop ")) for call in calls))

    def test_vm_recovery_during_other_profile_check_does_not_restart(self):
        result, calls = self.run_helper(
            vm_succeeds_after=3, other_profile="default", other_vm_ok=True,
        )
        self.assertIn("result=0 refreshed=false", result.stdout)
        self.assertFalse(any(call.startswith(("colima restart ", "colima stop ")) for call in calls))

    def test_host_connection_transition_is_retried_before_recovery(self):
        result, calls = self.run_helper(
            host_succeeds_after=1, vm_after=True,
            other_profile="default", other_vm_ok=True,
        )
        self.assertIn("result=0 refreshed=true", result.stdout)
        self.assertEqual(sum(call.startswith("host curl ") for call in calls), 2)
        self.assertEqual(sum(call.startswith("colima restart ") for call in calls), 1)

    def test_shared_failure_restarts_both_and_restores_running_containers(self):
        result, calls = self.run_helper(
            vm_after=True, other_profile="default", other_vm_after=True,
            containers=True,
        )
        self.assertIn("result=0 refreshed=true", result.stdout)
        self.assertEqual(
            [call for call in calls if call.startswith(("colima stop ", "colima start "))],
            ["colima stop --profile argo-remotelab", "colima stop --profile default",
             "colima start --profile default --activate=false",
             "colima start --profile argo-remotelab --activate=false"],
        )
        self.assertTrue(any(call.endswith(" start abc") for call in calls))
        self.assertTrue(any(call.endswith(" start ghi") for call in calls))
        self.assertFalse(any(call.endswith(" start def") for call in calls))
        self.assertIn("kubectl --context colima-argo-remotelab cluster-info", calls)

    def test_shared_failure_does_not_stop_vms_without_container_snapshot(self):
        result, calls = self.run_helper(other_profile="default", docker_ok=False)
        self.assertIn("result=2 refreshed=false", result.stdout)
        self.assertIn("Could not record running containers", result.stderr)
        self.assertFalse(any(call.startswith("colima stop ") for call in calls))

    def test_shared_restart_failure_starts_lab_again_and_restores_containers(self):
        result, calls = self.run_helper(
            vm_after=True, other_profile="default", other_vm_after=True,
            containers=True, start_fail_once="argo-remotelab",
        )
        self.assertIn("result=2 refreshed=true", result.stdout)
        self.assertIn("Shared Colima restart failed", result.stderr)
        self.assertEqual(calls.count("colima start --profile argo-remotelab --activate=false"), 2)
        self.assertTrue(any(call.endswith(" start abc") for call in calls))

    def test_shared_restart_failure_starts_default_and_lab_again(self):
        result, calls = self.run_helper(
            vm_after=True, other_profile="default", other_vm_after=True,
            containers=True, start_fail_once="default",
        )
        self.assertIn("result=2 refreshed=true", result.stdout)
        self.assertEqual(calls.count("colima start --profile default --activate=false"), 2)
        self.assertIn("colima start --profile argo-remotelab --activate=false", calls)
        self.assertTrue(any(call.endswith(" start abc") for call in calls))

    def test_shared_failure_with_another_running_profile_does_not_restart(self):
        result, calls = self.run_helper(other_profile="default\nanother")
        self.assertIn("result=2 refreshed=false", result.stdout)
        self.assertIn("requires only the default and argo-remotelab profiles", result.stderr)
        self.assertFalse(any(call.startswith("colima stop ") for call in calls))

    def test_shared_restart_stops_deployment_if_registry_stays_unreachable(self):
        result, calls = self.run_helper(other_profile="default", containers=True)
        self.assertIn("result=2 refreshed=true", result.stdout)
        self.assertIn("still cannot reach public.ecr.aws", result.stderr)
        self.assertIn("Probe from argo-remotelab", result.stderr)
        self.assertIn("Probe from default", result.stderr)
        self.assertTrue(any(call.endswith(" start abc") for call in calls))

    def test_profile_listing_failure_skips_restart(self):
        result, calls = self.run_helper(list_ok=False)
        self.assertIn("result=2 refreshed=false", result.stdout)
        self.assertIn("Could not list Colima profiles", result.stderr)
        self.assertFalse(any(call.startswith("colima restart ") for call in calls))

    def test_other_profile_lookup_accepts_json_array_and_running_broken_profile(self):
        result = self.run_other_profile_lookup(
            '[{"name":"argo-remotelab","status":"Broken"},'
            '{"name":"default","status":"Broken"},'
            '{"name":"unused","status":"Stopped"}]'
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "default")

    def test_other_profile_lookup_skips_genuinely_broken_profile(self):
        result = self.run_other_profile_lookup(
            '{"name":"default","status":"Broken"}', status_ok=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "")

    def test_context_setup_returns_network_failure_before_kubectl(self):
        harness = r'''
source "$PLATFORM_HELPER"
PLATFORM=macos
ensure_colima_registry_access() { printf 'registry checked\n'; return 2; }
kubectl() { printf 'unexpected kubectl call\n'; return 1; }
if switch_to_local_context; then result_code=0; else result_code=$?; fi
printf 'result=%s\n' "$result_code"
'''
        result = subprocess.run(
            ["bash", "-c", harness],
            env={**os.environ, "PLATFORM_HELPER": str(PLATFORM)},
            capture_output=True, text=True, timeout=5, check=False,
        )
        self.assertIn("registry checked", result.stdout)
        self.assertIn("result=2", result.stdout)
        self.assertNotIn("unexpected kubectl call", result.stdout)

    def test_cleanup_can_switch_context_without_registry_access(self):
        harness = r'''
source "$PLATFORM_HELPER"
PLATFORM=macos
COLIMA_REGISTRY_REQUIRED=false
ensure_colima_registry_access() { printf 'unexpected registry check\n'; return 2; }
kubectl() {
    if [[ "$1 $2" == 'config get-contexts' ]]; then
        printf 'colima-argo-remotelab\n'
    elif [[ "$1 $2" == 'config view' ]]; then
        printf 'apiVersion: v1\n'
    fi
}
if switch_to_local_context; then result_code=0; else result_code=$?; fi
printf 'result=%s\n' "$result_code"
if [[ -n "${LAB_KUBECONFIG:-}" ]]; then rm -f "$LAB_KUBECONFIG"; fi
'''
        result = subprocess.run(
            ["bash", "-c", harness],
            env={**os.environ, "PLATFORM_HELPER": str(PLATFORM)},
            capture_output=True, text=True, timeout=5, check=False,
        )
        self.assertIn("result=0", result.stdout)
        self.assertNotIn("unexpected registry check", result.stdout)


if __name__ == "__main__":
    unittest.main()
