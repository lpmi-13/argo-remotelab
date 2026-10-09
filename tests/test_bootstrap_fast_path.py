"""Exercise the VM bootstrap decision without a Kubernetes cluster."""

import os
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BOOTSTRAP = ROOT / "playground/iximiuz/image/bootstrap-gitops-lab.sh"


class BootstrapFastPathTests(unittest.TestCase):
    def run_bootstrap(self, provisioned_version, fail_rollout=False):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            bin_dir = base / "bin"
            state_dir = base / "state"
            repo_dir = base / "repo"
            script_dir = repo_dir / "scripts"
            for directory in (bin_dir, state_dir, script_dir):
                directory.mkdir(parents=True)

            calls = base / "calls"
            stub = (
                "#!/bin/sh\n"
                'printf "%s %s\\n" "${0##*/}" "$*" >> "$BOOTSTRAP_TEST_CALLS"\n'
                'if [ "${BOOTSTRAP_TEST_FAIL_ROLLOUT:-0}" = 1 ] && '
                '[ "${0##*/}" = kubectl ]; then\n'
                '  case "$*" in *"rollout status"*) exit 1 ;; esac\n'
                'fi\n'
                '[ "${0##*/}" != "k3s" ]\n'
            )
            for command in ("kubectl", "curl", "k3s"):
                executable = bin_dir / command
                executable.write_text(stub)
                executable.chmod(0o755)

            deploy = script_dir / "deploy-preloaded-vm.sh"
            deploy.write_text('#!/bin/sh\nprintf "deploy called\\n" >> "$BOOTSTRAP_TEST_CALLS"\n')
            deploy.chmod(0o755)
            (state_dir / "images-imported").touch()
            (state_dir / "provisioned-version").write_text(f"{provisioned_version}\n")

            env = os.environ.copy()
            env.update(
                PATH=f"{bin_dir}:{env['PATH']}",
                ARGO_REMOTELAB_REPO_ROOT=str(repo_dir),
                ARGO_REMOTELAB_STATE_DIR=str(state_dir),
                BOOTSTRAP_TEST_CALLS=str(calls),
                BOOTSTRAP_TEST_FAIL_ROLLOUT="1" if fail_rollout else "0",
            )
            result = subprocess.run(
                ["bash", str(BOOTSTRAP)], env=env, text=True, capture_output=True
            )
            return result, calls.read_text(), (state_dir / "provisioned-version").read_text()

    def test_matching_version_recovers_workloads_without_redeployment(self):
        result, calls, marker = self.run_bootstrap("1")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(marker, "1\n")
        self.assertEqual(calls.count("rollout status"), 8)
        self.assertIn("curl --retry", calls)
        self.assertNotIn("deploy called", calls)
        self.assertNotIn("k3s ", calls)
        self.assertNotIn("delete namespace", calls)

    def test_old_version_rebuilds_and_updates_marker(self):
        result, calls, marker = self.run_bootstrap("0")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("deploy called", calls)
        self.assertEqual(marker, "1\n")

    def test_failed_recovery_does_not_redeploy(self):
        result, calls, marker = self.run_bootstrap("1", fail_rollout=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("deploy called", calls)
        self.assertEqual(marker, "1\n")


if __name__ == "__main__":
    unittest.main()
