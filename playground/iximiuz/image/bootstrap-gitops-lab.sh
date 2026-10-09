#!/usr/bin/env bash
set -euo pipefail

repo_root="${ARGO_REMOTELAB_REPO_ROOT:-/opt/argo-remotelab}"
images_archive="${repo_root}/playground/iximiuz/k3s-images.tar"
state_dir="${ARGO_REMOTELAB_STATE_DIR:-/var/lib/argo-remotelab}"
import_marker="${state_dir}/images-imported"
provision_marker="${state_dir}/provisioned-version"
# Bump when an image or deployment schema change requires a fresh lab build.
provision_version="1"

export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"

log_phase() {
  printf '%s [bootstrap] %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$*" >&2
}

run_phase() {
  local label="$1"
  local started_at=$SECONDS
  shift
  log_phase "START ${label}"
  "$@"
  log_phase "DONE ${label} ($((SECONDS - started_at))s)"
}

wait_for_gateway_health() {
  local attempt
  for attempt in $(seq 1 120); do
    if curl -fsS http://127.0.0.1:30080/healthz >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "lab gateway did not recover on port 30080" >&2
  return 1
}

wait_for_existing_lab() {
  local target namespace deployment
  for target in \
    argocd/argocd-server argocd/argocd-repo-server \
    applications/postgresql applications/gitea \
    applications/scenario-controller applications/learning-service \
    applications/lab-terminal applications/lab-gateway; do
    namespace="${target%%/*}"
    deployment="${target#*/}"
    run_phase "${target} recovery" kubectl -n "${namespace}" rollout status \
      "deployment/${deployment}" --timeout=180s
  done

  run_phase "Gitea API recovery" curl --retry 30 --retry-delay 2 --retry-connrefused \
    --fail --silent --show-error http://127.0.0.1:30082/api/healthz
  run_phase "gateway readiness" wait_for_gateway_health
}

mkdir -p "${state_dir}"

phase_started=$SECONDS
log_phase "START k3s API readiness"
for _ in $(seq 1 120); do
  if kubectl get --raw=/readyz >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

kubectl get --raw=/readyz >/dev/null 2>&1 || {
  echo "k3s API did not become ready in time" >&2
  exit 1
}
log_phase "DONE k3s API readiness ($((SECONDS - phase_started))s)"

if [[ -f "${provision_marker}" ]] &&
   [[ "$(cat "${provision_marker}")" == "${provision_version}" ]]; then
  log_phase "Provisioned version ${provision_version} found; waiting for existing workloads"
  wait_for_existing_lab
  log_phase "Existing lab is ready; learner state preserved"
  exit 0
fi

if [[ ! -f "${import_marker}" ]]; then
  run_phase "Kubernetes image import" k3s ctr -n k8s.io images import "${images_archive}"
  touch "${import_marker}"
else
  log_phase "Kubernetes image import already completed"
fi

run_phase "fresh lab deployment" bash "${repo_root}/scripts/deploy-preloaded-vm.sh"

# Publish the marker only after every workload and the gateway are healthy.
marker_tmp="$(mktemp "${state_dir}/provisioned-version.XXXXXX")"
printf '%s\n' "${provision_version}" > "${marker_tmp}"
mv "${marker_tmp}" "${provision_marker}"
log_phase "Provisioned version ${provision_version} is ready"
