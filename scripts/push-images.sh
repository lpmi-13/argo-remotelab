#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "${repo_root}/scripts/lib/versions.sh"

usage() {
  cat <<'EOF'
Usage: IMAGE_TAG=v6 bash scripts/push-images.sh

Pushes the first-party lab images and rootfs image to GHCR.

Environment:
  IMAGE_TAG      Image tag to push. Defaults to DEFAULT_FIRST_PARTY_IMAGE_TAG.
  ROOTFS_IMAGE   Full rootfs image reference. Defaults to ROOTFS_IMAGE_REPO:IMAGE_TAG.
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

if [[ $# -gt 0 ]]; then
  echo "error: unknown argument '$1'." >&2
  usage >&2
  exit 1
fi

image_tag="${IMAGE_TAG:-${DEFAULT_FIRST_PARTY_IMAGE_TAG}}"
rootfs_image="${ROOTFS_IMAGE:-${ROOTFS_IMAGE_REPO}:${image_tag}}"

if [[ "${rootfs_image}" == oci://* ]]; then
  rootfs_image="${rootfs_image#oci://}"
fi

if [[ ! "${image_tag}" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]]; then
  echo "error: invalid IMAGE_TAG '${image_tag}'." >&2
  exit 1
fi

images=(
  "${SCENARIO_CONTROLLER_IMAGE_REPO}:${image_tag}"
  "${LEARNING_SERVICE_IMAGE_REPO}:${image_tag}"
  "${LAB_GATEWAY_IMAGE_REPO}:${image_tag}"
  "${LAB_TERMINAL_IMAGE_REPO}:${image_tag}"
  "${ARGOCD_TOOLS_IMAGE_REPO}:${image_tag}"
  "${DJANGO_IMAGE_REPO}:${image_tag}"
  "${rootfs_image}"
)

for image in "${images[@]}"; do
  if ! docker image inspect "${image}" >/dev/null 2>&1; then
    echo "error: Docker image ${image} does not exist locally." >&2
    exit 1
  fi
done

for image in "${images[@]}"; do
  echo "Pushing ${image}..."
  docker push "${image}"
done
