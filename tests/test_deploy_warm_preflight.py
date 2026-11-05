"""Exercise warm readiness classification without touching a Kubernetes cluster."""

import os
import subprocess
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts/deploy-warm.sh"


class WarmPreflightTests(unittest.TestCase):
    def run_check(self, *, deployment_present=True):
        with tempfile.TemporaryDirectory() as directory:
            temp = Path(directory)
            calls = temp / "calls"
            kubectl = temp / "kubectl"
            kubectl.write_text("""#!/bin/sh
printf 'kubectl %s\\n' "$*" >> "$CALLS"
case "$1" in
    config)
        if [ "$2" = get-contexts ]; then printf 'default\\n'; fi
        if [ "$2" = view ]; then printf 'apiVersion: v1\\n'; fi
        ;;
    cluster-info) exit 0 ;;
    get)
        if [ "$2" = namespace ]; then printf 'Active'; fi
        ;;
    -n)
        if [ "$3" = get ]; then
            [ "$DEPLOYMENT_PRESENT" = 1 ] || exit 1
            printf '%s\\n' "$4"
        fi
        if [ "$3" = rollout ]; then exit 1; fi
        ;;
esac
""")
            kubectl.chmod(0o755)
            uname = temp / "uname"
            uname.write_text("#!/bin/sh\nprintf 'Linux\\n'\n")
            uname.chmod(0o755)
            for name in ("git", "curl", "jq", "age-keygen", "sops"):
                command = temp / name
                command.write_text("#!/bin/sh\nexit 0\n")
                command.chmod(0o755)
            environment = {
                **os.environ,
                "PATH": f"{temp}:{os.environ['PATH']}",
                "CALLS": str(calls),
                "DEPLOYMENT_PRESENT": str(int(deployment_present)),
            }
            result = subprocess.run(
                ["bash", str(SCRIPT), "--check"], env=environment,
                capture_output=True, text=True, timeout=10, check=False,
            )
            return result, calls.read_text().splitlines()

    def test_existing_unready_deployment_stops_without_full_rebuild(self):
        result, calls = self.run_check()
        self.assertEqual(result.returncode, 2)
        self.assertIn("exists but is not ready", result.stderr)
        self.assertTrue(any("rollout status" in call and "--timeout=60s" in call
                            for call in calls))

    def test_missing_deployment_allows_full_rebuild(self):
        result, calls = self.run_check(deployment_present=False)
        self.assertEqual(result.returncode, 1)
        self.assertIn("argocd/argocd-server is missing", result.stderr)
        self.assertFalse(any("rollout status" in call for call in calls))


if __name__ == "__main__":
    unittest.main()
