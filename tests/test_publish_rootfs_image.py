"""Exercise publish ordering without pushing images or changing a playground."""

import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CURRENT_TAG = re.search(
    r'^readonly DEFAULT_FIRST_PARTY_IMAGE_TAG="([^"]+)"',
    (ROOT / "scripts/lib/versions.sh").read_text(),
    re.MULTILINE,
).group(1)
TAG = "publish-smoke" if CURRENT_TAG != "publish-smoke" else "publish-smoke-2"
PLAYGROUND_NAME = re.search(
    r"^name:\s+(\S+)",
    (ROOT / "playground/iximiuz/manifest.yaml").read_text(),
    re.MULTILINE,
).group(1)


class PublishRootfsImageTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="argo-publish-test-")
        self.addCleanup(temporary.cleanup)
        self.fixture = Path(temporary.name)
        self.repo = self.fixture / "repo"
        self.bin_dir = self.fixture / "bin"
        self.repo.mkdir()
        self.bin_dir.mkdir()

        for directory in ("scripts", "argocd-apps", "manifests", "playground"):
            shutil.copytree(ROOT / directory, self.repo / directory)
        for directory in ("chart", "platform"):
            shutil.copytree(
                ROOT / "sample-django-app" / directory,
                self.repo / "sample-django-app" / directory,
            )

        self._write_executable("docker", """#!/usr/bin/env bash
set -euo pipefail
printf 'docker %s\\n' "$*" >> "$CALL_LOG"
if [[ "$1" == save ]]; then : > "$3"; fi
if [[ "$1" == push && "$2" == *-rootfs:* && "${FAIL_ROOTFS_PUSH:-0}" == 1 ]]; then exit 53; fi
""")
        self._write_executable("labctl", """#!/usr/bin/env bash
set -euo pipefail
printf 'labctl %s\\n' "$*" >> "$CALL_LOG"
case "$1 $2" in
  'auth whoami') test -f "$AUTH_MARKER" ;;
  'auth login') : > "$AUTH_MARKER" ;;
  'playground update')
    test "$3" = "$PLAYGROUND_NAME"
    test "$4" = --file
    grep -Fq "source: oci://ghcr.io/lpmi-13/argo-remotelab-k3s-rootfs:${TEST_TAG}" "$5"
    test "${FAIL_REMOTE_UPDATE:-0}" != 1
    ;;
  *) exit 2 ;;
esac
""")
        self.log = self.fixture / "calls.log"
        self.auth_marker = self.fixture / "authenticated"
        self.env = os.environ.copy()
        self.env.update(
            PATH=f"{self.bin_dir}:/usr/bin:/bin",
            CALL_LOG=str(self.log),
            AUTH_MARKER=str(self.auth_marker),
            PLAYGROUND_NAME=PLAYGROUND_NAME,
            TEST_TAG=TAG,
        )

    def _write_executable(self, name, contents):
        path = self.bin_dir / name
        path.write_text(contents)
        path.chmod(0o755)

    def _run(self, *arguments, **environment):
        return subprocess.run(
            ["bash", str(self.repo / "scripts/publish-rootfs-image.sh"), *arguments],
            cwd=self.repo,
            env={**self.env, **environment},
            text=True,
            capture_output=True,
            check=False,
        )

    def _calls(self):
        return self.log.read_text().splitlines() if self.log.exists() else []

    def test_login_precedes_build_and_remote_update_uses_new_manifest(self):
        result = self._run(TAG)
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self._calls()
        self.assertEqual(calls[:3], [
            "labctl auth whoami", "labctl auth login", "labctl auth whoami",
        ])
        self.assertTrue(calls[3].startswith("docker build "))
        self.assertTrue(calls[-1].startswith("labctl playground update "))
        self.assertIn(
            f"argo-remotelab-k3s-rootfs:{TAG}",
            (self.repo / "playground/iximiuz/manifest.yaml").read_text(),
        )

    def test_failed_rootfs_push_does_not_change_manifest_or_update_playground(self):
        result = self._run(TAG, FAIL_ROOTFS_PUSH="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(f"docker push ghcr.io/lpmi-13/argo-remotelab-k3s-rootfs:{TAG}", self._calls())
        self.assertFalse(any(call.startswith("labctl playground update") for call in self._calls()))
        self.assertNotIn(
            f"argo-remotelab-k3s-rootfs:{TAG}",
            (self.repo / "playground/iximiuz/manifest.yaml").read_text(),
        )

    def test_missing_labctl_fails_before_build(self):
        (self.bin_dir / "labctl").unlink()
        result = self._run(TAG)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("labctl is required", result.stderr)
        self.assertEqual(self._calls(), [])

    def test_remote_failure_can_be_retried_without_rebuilding(self):
        result = self._run(TAG, FAIL_REMOTE_UPDATE="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("--sync-remote", result.stderr)
        self.assertIn(
            f"argo-remotelab-k3s-rootfs:{TAG}",
            (self.repo / "playground/iximiuz/manifest.yaml").read_text(),
        )

        self.log.write_text("")
        retry = self._run("--sync-remote")
        self.assertEqual(retry.returncode, 0, retry.stderr)
        self.assertEqual(len(self._calls()), 2)
        self.assertEqual(self._calls()[0], "labctl auth whoami")
        self.assertTrue(self._calls()[1].startswith("labctl playground update "))


if __name__ == "__main__":
    unittest.main()
