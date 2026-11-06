"""Keep warm deployment tied to infrastructure inputs, not build orchestration."""

import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
HASH_SCRIPT = ROOT / "scripts/lib/image-source-hash.py"
namespace = {"__name__": "image_source_hash_test"}
exec(compile(HASH_SCRIPT.read_text(), str(HASH_SCRIPT), "exec"), namespace)
source_hash = namespace["source_hash"]
sources = namespace["SOURCES"]


class InfrastructureHashTests(unittest.TestCase):
    def test_build_script_and_image_version_edits_keep_warm_deployment_available(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            paths = set(sources["dependencies"]) | {
                "scripts/deploy-all.sh", "scripts/lib/versions.sh"
            }
            for relative in paths:
                path = root / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("original\n")

            original = source_hash(root, "dependencies")
            (root / "scripts/deploy-all.sh").write_text("build orchestration changed\n")
            (root / "scripts/lib/versions.sh").write_text("first-party image tag changed\n")
            self.assertEqual(source_hash(root, "dependencies"), original)

            (root / "scripts/lib/infrastructure-settings.sh").write_text("new setting\n")
            self.assertNotEqual(source_hash(root, "dependencies"), original)


if __name__ == "__main__":
    unittest.main()
