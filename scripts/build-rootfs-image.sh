#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${repo_root}"
source "${repo_root}/scripts/lib/versions.sh"

app_image_tag="${IMAGE_TAG:-${DEFAULT_FIRST_PARTY_IMAGE_TAG}}"
rootfs_image="${ROOTFS_IMAGE:-${ROOTFS_IMAGE_REPO}:${app_image_tag}}"
rootfs_release="${ROOTFS_RELEASE:-${DEFAULT_IXIMIUZ_ROOTFS_RELEASE}}"
build_images="${BUILD_IMAGES:-1}"
pull_runtime_images="${PULL_RUNTIME_IMAGES:-1}"
push_images="${PUSH_IMAGES:-0}"
push_rootfs_image="${PUSH_ROOTFS_IMAGE:-${PUSH_IMAGE:-${push_images}}}"

scenario_controller_image="${SCENARIO_CONTROLLER_IMAGE_REPO}:${app_image_tag}"
argocd_tools_image="${ARGOCD_TOOLS_IMAGE_REPO}:${app_image_tag}"
django_image="${DJANGO_IMAGE_REPO}:${app_image_tag}"
learning_service_image="${LEARNING_SERVICE_IMAGE_REPO}:${app_image_tag}"
lab_gateway_image="${LAB_GATEWAY_IMAGE_REPO}:${app_image_tag}"
lab_terminal_image="${LAB_TERMINAL_IMAGE_REPO}:${app_image_tag}"

# The preloaded VM uses these directly; Argo CD and Redis come from argocd-install.yaml.
runtime_images=(
  "${POSTGRES_IMAGE}"
  "${GITEA_IMAGE}"
)

first_party_images=(
  "${scenario_controller_image}"
  "${argocd_tools_image}"
  "${django_image}"
  "${learning_service_image}"
  "${lab_gateway_image}"
  "${lab_terminal_image}"
)

ensure_image() {
  local image="$1"

  if ! docker image inspect "${image}" >/dev/null 2>&1; then
    echo "error: Docker image ${image} does not exist." >&2
    exit 1
  fi
}

pull_if_missing() {
  local image="$1"

  if docker image inspect "${image}" >/dev/null 2>&1; then
    return 0
  fi

  echo "Pulling ${image}..."
  docker pull "${image}"
}

copy_dir() {
  local source="$1"
  local destination_parent="$2"

  mkdir -p "${destination_parent}"
  cp -R "${source}" "${destination_parent}/"
}

manifest_images() {
  local manifest="$1"

  test -f "${manifest}" || { echo "error: missing manifest ${manifest}." >&2; exit 1; }

  awk '
    /^[[:space:]]*image:[[:space:]]*/ {
      image = $0
      sub(/^[[:space:]]*image:[[:space:]]*/, "", image)
      sub(/[[:space:]]+#.*$/, "", image)
      gsub(/"/, "", image)
      gsub(/\047/, "", image)
      if (image != "") print image
    }
  ' "${manifest}" | sort -u
}

unique_images() {
  local image
  declare -A seen=()

  for image in "$@"; do
    [[ -n "${image}" ]] || continue
    if [[ -z "${seen[$image]+x}" ]]; then
      seen["${image}"]=1
      printf '%s\n' "${image}"
    fi
  done
}

mapfile -t argocd_install_images < <(manifest_images "${repo_root}/manifests/gitops/argocd-install.yaml")
mapfile -t runtime_images < <(unique_images "${runtime_images[@]}" "${argocd_install_images[@]}")

if [[ "${build_images}" != "0" ]]; then
  echo "Building ${scenario_controller_image}..."
  docker build -t "${scenario_controller_image}" "${repo_root}/scenario-controller"

  echo "Building ${argocd_tools_image}..."
  docker build -t "${argocd_tools_image}" "${repo_root}/docker/argocd-tools"

  echo "Building ${django_image}..."
  docker build -t "${django_image}" "${repo_root}/sample-django-app"

  echo "Building ${learning_service_image}..."
  docker build -f "${repo_root}/learning-service/Dockerfile" -t "${learning_service_image}" "${repo_root}"

  echo "Building ${lab_gateway_image}..."
  docker build -f "${repo_root}/lab-gateway/Dockerfile" -t "${lab_gateway_image}" "${repo_root}"

  echo "Building ${lab_terminal_image}..."
  docker build -f "${repo_root}/lab-terminal/Dockerfile" -t "${lab_terminal_image}" "${repo_root}"
fi

if [[ "${pull_runtime_images}" != "0" ]]; then
  for image in "${runtime_images[@]}"; do
    pull_if_missing "${image}"
  done
  if [[ "${build_images}" == "0" ]]; then
    for image in "${first_party_images[@]}"; do
      pull_if_missing "${image}"
    done
  fi
fi

for image in "${first_party_images[@]}" "${runtime_images[@]}"; do
  ensure_image "${image}"
done

if [[ "${push_images}" != "0" ]]; then
  for image in "${first_party_images[@]}"; do
    echo "Pushing ${image}..."
    docker push "${image}"
  done
fi

build_context="$(mktemp -d /tmp/argo-remotelab-rootfs-build.XXXXXX)"
trap 'rm -rf "${build_context}"' EXIT

mkdir -p "${build_context}/playground/iximiuz" "${build_context}/sample-django-app"
cp "${repo_root}/playground/iximiuz/Dockerfile" "${build_context}/Dockerfile"
copy_dir "${repo_root}/argocd-apps" "${build_context}"
copy_dir "${repo_root}/manifests" "${build_context}"
copy_dir "${repo_root}/playground" "${build_context}"
copy_dir "${repo_root}/sample-django-app/chart" "${build_context}/sample-django-app"
copy_dir "${repo_root}/sample-django-app/platform" "${build_context}/sample-django-app"
copy_dir "${repo_root}/scripts" "${build_context}"

echo "Syncing copied manifests to image tag ${app_image_tag} and rootfs ${rootfs_image}..."
bash "${repo_root}/scripts/update-version-refs.sh" \
  --repo-root "${build_context}" \
  --app-image-tag "${app_image_tag}" \
  --rootfs-image "${rootfs_image}"

echo "Saving Kubernetes images into the rootfs build context..."
docker save -o "${build_context}/playground/iximiuz/k3s-images.tar" \
  "${first_party_images[@]}" \
  "${runtime_images[@]}"

echo "Building ${rootfs_image}..."
docker build \
  --build-arg ROOTFS_RELEASE="${rootfs_release}" \
  -t "${rootfs_image}" \
  "${build_context}"

if [[ "${push_rootfs_image}" != "0" ]]; then
  echo "Pushing ${rootfs_image}..."
  docker push "${rootfs_image}"
fi

echo "Updating checked-in version references..."
bash "${repo_root}/scripts/update-version-refs.sh" \
  --app-image-tag "${app_image_tag}" \
  --rootfs-image "${rootfs_image}"

echo
echo "Built rootfs image ${rootfs_image}"
if [[ "${push_rootfs_image}" != "0" ]]; then
  echo "Pushed ${rootfs_image}"
fi
