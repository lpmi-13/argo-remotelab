#!/usr/bin/env python3
"""Hash repository inputs or the files copied into one first-party image."""

import hashlib
import sys
from pathlib import Path


SOURCES = {
    "repository": (
        "sample-django-app/app",
        "sample-django-app/chart",
        "sample-django-app/platform",
        "scripts/reset-gitea-repo.sh",
        "scripts/seed-history.sh",
    ),
    "dependencies": (
        "manifests/gitops/argocd-install.yaml",
        "manifests/gitops/argocd-install.version",
        "manifests/gitops/argocd-sops-config.yaml",
        "manifests/applications/postgresql.yaml",
        "manifests/applications/gitea.yaml",
        "manifests/applications/gitea-init-user.yaml",
        "manifests/applications/gitea-init-repo.yaml",
        "scripts/lib/versions.sh",
        "scripts/deploy-all.sh",
    ),
    "sample-django-app": ("sample-django-app/Dockerfile", "sample-django-app/app"),
    "scenario-controller": ("scenario-controller",),
    "learning-service": ("learning-service/Dockerfile", "learning-service/server.py", "learning"),
    "lab-gateway": (
        "lab-gateway/Dockerfile",
        "lab-gateway/nginx.conf",
        "argocd-coach/src",
        "argocd-coach/selectors",
        "lab-launcher",
    ),
    "lab-terminal": ("lab-terminal",),
}
EXCLUDED_DIRS = {".git", ".venv", "node_modules", "__pycache__"}


def source_hash(repo_root: Path, component: str) -> str:
    digest = hashlib.sha256()
    files = []
    for source in SOURCES[component]:
        path = repo_root / source
        if not path.exists():
            raise FileNotFoundError(path)
        files.extend(path.rglob("*") if path.is_dir() else (path,))

    for path in sorted(files):
        if not path.is_file() or any(part in EXCLUDED_DIRS for part in path.parts):
            continue
        if component == "scenario-controller" and path == repo_root / "scenario-controller/main":
            continue
        if path.suffix == ".pyc":
            continue
        relative = path.relative_to(repo_root).as_posix().encode()
        content = path.read_bytes()
        digest.update(len(relative).to_bytes(8, "big"))
        digest.update(relative)
        digest.update(len(content).to_bytes(8, "big"))
        digest.update(content)
    return digest.hexdigest()


if __name__ == "__main__":
    if len(sys.argv) != 2 or sys.argv[1] not in SOURCES:
        raise SystemExit("usage: image-source-hash.py COMPONENT")
    root = Path(__file__).resolve().parents[2]
    print(source_hash(root, sys.argv[1]))
