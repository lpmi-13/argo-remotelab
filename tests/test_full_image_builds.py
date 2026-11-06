"""Check full-deployment image reuse and bounded builds without a cluster."""

import os
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / "scripts/lib/full-image-builds.sh"


class FullImageBuildTests(unittest.TestCase):
    def run_prepare(self, *, recorded_hash="current", failing_component=""):
        with tempfile.TemporaryDirectory() as directory:
            calls = Path(directory) / "calls"
            harness = f"""set -eo pipefail
source "{HELPER}"
SCRIPT_DIR="{ROOT}/scripts"
REPO_DIR="{ROOT}"
PLATFORM=macos
COLIMA_PROFILE=argo-remotelab
IMAGE_TAG=v12
DJANGO_IMAGE=django:v12
SCENARIO_CONTROLLER_IMAGE=controller:v12
LEARNING_SERVICE_IMAGE=learning:v12
LAB_GATEWAY_IMAGE=gateway:v12
LAB_TERMINAL_IMAGE=terminal:v12
kubectl() {{
    if [[ "$*" == *image_tag* ]]; then printf 'v12'; else printf '%s' "$RECORDED_HASH"; fi
}}
python3() {{ printf 'current'; }}
full_image_present() {{ return 0; }}
build_full_image() {{
    printf 'start %s\\n' "$1" >> "$CALLS"
    sleep 0.1
    printf 'end %s\\n' "$1" >> "$CALLS"
    [[ "$1" != "$FAILING_COMPONENT" ]]
}}
prepare_full_images
"""
            result = subprocess.run(
                ["bash", "-c", harness],
                env={**os.environ, "CALLS": str(calls), "RECORDED_HASH": recorded_hash,
                     "FAILING_COMPONENT": failing_component},
                text=True, capture_output=True, check=False, timeout=10,
            )
            return result, calls.read_text().splitlines() if calls.exists() else []

    def test_matching_images_are_reused(self):
        result, calls = self.run_prepare()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.count("Reusing "), 5)
        self.assertEqual(calls, [])

    def test_changed_images_build_at_most_two_at_a_time(self):
        result, calls = self.run_prepare(recorded_hash="old")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(sum(call.startswith("start ") for call in calls), 5)
        running = maximum = 0
        for call in calls:
            running += 1 if call.startswith("start ") else -1
            maximum = max(maximum, running)
        self.assertEqual(maximum, 2)
        self.assertEqual(running, 0)

    def test_failed_build_stops_before_next_batch(self):
        result, calls = self.run_prepare(recorded_hash="old", failing_component="scenario-controller")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("scenario-controller image build failed", result.stderr)
        self.assertEqual({call for call in calls if call.startswith("start ")},
                         {"start sample-django-app", "start scenario-controller"})

    def test_linux_nerdctl_targets_k3s_containerd(self):
        with tempfile.TemporaryDirectory() as directory:
            temp = Path(directory)
            calls = temp / "calls"
            nerdctl = temp / "nerdctl"
            nerdctl.write_text('#!/bin/sh\nprintf "%s\\n" "$*" > "$CALLS"\n')
            nerdctl.chmod(0o755)
            harness = f'''set -eo pipefail
source "{HELPER}"
id() {{ printf '0\\n'; }}
k3s_nerdctl build -t example:v1 /repo
'''
            result = subprocess.run(
                ["bash", "-c", harness],
                env={**os.environ, "PATH": f"{temp}:/usr/bin:/bin", "CALLS": str(calls)},
                text=True, capture_output=True, check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(calls.read_text().strip(),
                             "--address /run/k3s/containerd/containerd.sock --namespace k8s.io "
                             "build -t example:v1 /repo")

    def test_linux_docker_fallback_imports_into_k3s(self):
        with tempfile.TemporaryDirectory() as directory:
            temp = Path(directory)
            calls = temp / "calls"
            docker = temp / "docker"
            docker.write_text('''#!/bin/sh
printf 'docker %s\\n' "$*" >> "$CALLS"
if [ "$1" = save ]; then printf archive; fi
''')
            docker.chmod(0o755)
            k3s = temp / "k3s"
            k3s.write_text('''#!/bin/sh
printf 'k3s %s\\n' "$*" >> "$CALLS"
case "$*" in *'images ls -q'*) printf 'example:v1\\n';; *'images import -'*) cat >/dev/null;; esac
''')
            k3s.chmod(0o755)
            harness = f'''set -eo pipefail
source "{HELPER}"
PLATFORM=linux
REPO_DIR="{ROOT}"
id() {{ printf '0\\n'; }}
full_image_present example:v1
build_full_image sample-django-app example:v1
'''
            result = subprocess.run(
                ["bash", "-c", harness],
                env={**os.environ, "PATH": f"{temp}:/usr/bin:/bin", "CALLS": str(calls)},
                text=True, capture_output=True, check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("k3s ctr --namespace k8s.io images ls -q", calls.read_text())
            self.assertIn("k3s ctr --namespace k8s.io images import -", calls.read_text())


if __name__ == "__main__":
    unittest.main()
