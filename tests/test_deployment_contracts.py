"""Cross-file checks for the gateway, Applications, and scenario packs."""

import json
import re
import subprocess
import unittest
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[1]


def documents(path):
    return [item for item in yaml.safe_load_all((ROOT / path).read_text()) if item]


class DeploymentContractTests(unittest.TestCase):
    def test_preloaded_manifests_use_final_vm_settings(self):
        renderer = ROOT / "scripts/render-preloaded-manifest.sh"

        def render(kind, *args):
            result = subprocess.run(
                ["bash", str(renderer), kind, *args],
                check=True,
                text=True,
                capture_output=True,
            )
            return [document for document in yaml.safe_load_all(result.stdout) if document]

        gitea = render("gitea", "https://lab.example/")
        deployment = next(item for item in gitea if item["kind"] == "Deployment")
        container = deployment["spec"]["template"]["spec"]["containers"][0]
        self.assertEqual(deployment["spec"]["strategy"]["type"], "Recreate")
        self.assertEqual(container["ports"][0]["hostPort"], 30082)
        self.assertEqual(
            next(item["value"] for item in container["env"]
                 if item["name"] == "GITEA__server__ROOT_URL"),
            "https://lab.example/gitea/",
        )
        self.assertEqual({item["kind"] for item in gitea},
                         {"Deployment", "PersistentVolumeClaim", "Service"})

        gateway = render("gateway")
        deployment = next(item for item in gateway if item["kind"] == "Deployment")
        container = deployment["spec"]["template"]["spec"]["containers"][0]
        self.assertEqual(deployment["spec"]["strategy"]["type"], "Recreate")
        self.assertEqual(container["ports"][0]["hostPort"], 30080)
        self.assertEqual({item["kind"] for item in gateway}, {"Deployment", "Service"})

    def test_gateway_routes_match_services_and_packaged_assets(self):
        config = (ROOT / "lab-gateway/nginx.conf").read_text()
        services = {}
        for path in ("lab-gateway", "lab-terminal", "learning-service"):
            for item in documents(f"manifests/applications/{path}.yaml"):
                if item["kind"] == "Service":
                    services[item["metadata"]["name"]] = item["spec"]["ports"][0]["port"]
        for name, port in services.items():
            if name == "lab-gateway":
                continue
            self.assertIn(f"{name}.applications.svc.cluster.local:{port}", config)
        for asset in re.findall(r'/coach/assets/([\w/.-]+)', config):
            self.assertTrue((ROOT / "argocd-coach/src" / asset).is_file() or
                            (ROOT / "argocd-coach" / asset).is_file(), asset)
        self.assertIn("ttyd -W -b /terminal", (ROOT / "lab-terminal/entrypoint.sh").read_text())
        self.assertIn("set $terminal_upstream lab-terminal.applications.svc.cluster.local:7681;", config)
        self.assertIn("proxy_pass http://$terminal_upstream;", config)
        self.assertIn("resolver __DNS_RESOLVER__ valid=5s ipv6=off;", config)

    def test_shop_applications_and_fix_paths_use_both_charts(self):
        applications = documents("argocd-apps/django-app.yaml")
        self.assertEqual({item["metadata"]["name"] for item in applications},
                         {"shop-web-prod", "shop-web-staging"})
        paths = {item["spec"]["source"]["path"] for item in applications}
        self.assertEqual(paths, {"chart/django-app", "chart/django-app-staging"})
        self.assertEqual({item["spec"]["project"] for item in applications}, {"shop"})
        catalog = json.loads((ROOT / "learning/catalog.json").read_text())
        for name in catalog["scenarios"]:
            pack = json.loads((ROOT / "learning/scenarios" / name / "pack.json").read_text())
            for path in pack["fix_paths"]:
                source = Path(path)
                self.assertEqual(source.parts[:2], ("chart", "django-app"), path)
                if source.name == "secrets.yaml.enc":
                    # Each deployment path creates encrypted values after generating an age key.
                    self.assertIn("reset-gitea-repo.sh", (ROOT / "scripts/deploy-all.sh").read_text())
                    self.assertIn("secrets.yaml.enc", (ROOT / "scripts/reset-gitea-repo.sh").read_text())
                    self.assertIn("secrets.yaml.enc", (ROOT / "scripts/deploy-preloaded-vm.sh").read_text())
                else:
                    self.assertTrue((ROOT / "sample-django-app" / source).is_file(), path)


if __name__ == "__main__":
    unittest.main()
