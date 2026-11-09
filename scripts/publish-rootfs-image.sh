#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "${repo_root}/scripts/lib/versions.sh"

usage() {
  cat <<'EOF'
Usage: bash scripts/publish-rootfs-image.sh [new-image-tag]
       bash scripts/publish-rootfs-image.sh --sync-remote

Builds and pushes the first-party images and iximiuz rootfs image, then updates
the checked-in image references and the remote iximiuz playground after a
successful push. Without a tag, it publishes the next version after the current
one in scripts/lib/versions.sh (v12 becomes v13). --sync-remote retries only the
playground update.
EOF
}

next_image_tag() {
  local current="$1"

  if [[ ! "${current}" =~ ^v([0-9]+)$ ]]; then
    echo "error: cannot increment image tag '${current}'; pass a new tag explicitly." >&2
    return 1
  fi
  printf 'v%d\n' "$((10#${BASH_REMATCH[1]} + 1))"
}

playground_manifest="${repo_root}/playground/iximiuz/manifest.yaml"
playground_name="$(awk '/^name:[[:space:]]*/ { print $2; exit }' "${playground_manifest}")"
if [[ -z "${playground_name}" ]]; then
  echo "error: could not read the playground name from ${playground_manifest}." >&2
  exit 1
fi

ensure_labctl_authenticated() {
  if ! command -v labctl >/dev/null 2>&1; then
    echo "error: labctl is required to update the iximiuz playground." >&2
    exit 1
  fi

  if ! labctl auth whoami >/dev/null 2>&1; then
    echo "labctl is not authenticated; starting labctl auth login..."
    labctl auth login
    if ! labctl auth whoami >/dev/null 2>&1; then
      echo "error: labctl authentication could not be verified." >&2
      exit 1
    fi
  fi
}

sync_remote_playground() {
  echo "Updating iximiuz playground ${playground_name} from ${playground_manifest}..."
  if ! labctl playground update "${playground_name}" --file "${playground_manifest}"; then
    echo "error: remote playground update failed; retry with: bash scripts/publish-rootfs-image.sh --sync-remote" >&2
    return 1
  fi
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

if [[ "${1:-}" == "--sync-remote" && $# -eq 1 ]]; then
  ensure_labctl_authenticated
  sync_remote_playground
  exit 0
fi

if [[ $# -gt 1 || "${1:-}" == -* ]]; then
  usage >&2
  exit 1
fi

if [[ $# -eq 1 ]]; then
  image_tag="$1"
else
  image_tag="$(next_image_tag "${DEFAULT_FIRST_PARTY_IMAGE_TAG}")"
fi
if [[ ! "${image_tag}" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]]; then
  echo "error: invalid image tag '${image_tag}'." >&2
  exit 1
fi

rootfs_image="${ROOTFS_IMAGE_REPO}:${image_tag}"
if [[ "${image_tag}" == "${DEFAULT_FIRST_PARTY_IMAGE_TAG}" || "${rootfs_image}" == "${DEFAULT_IXIMIUZ_ROOTFS_IMAGE}" ]]; then
  echo "error: ${image_tag} is already referenced by this checkout; choose a new image tag." >&2
  exit 1
fi

ensure_labctl_authenticated

echo "Publishing ${image_tag} (replacing ${DEFAULT_FIRST_PARTY_IMAGE_TAG})..."
IMAGE_TAG="${image_tag}" \
ROOTFS_IMAGE="${rootfs_image}" \
BUILD_IMAGES=1 \
PUSH_IMAGES=1 \
PUSH_ROOTFS_IMAGE=1 \
  bash "${repo_root}/scripts/build-rootfs-image.sh"

sync_remote_playground
