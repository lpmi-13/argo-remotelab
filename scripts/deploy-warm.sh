#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"
source "${script_dir}/lib/platform.sh"
source "${script_dir}/lib/versions.sh"

colima_profile="${COLIMA_PROFILE:-argo-remotelab}"
image_tag="${IMAGE_TAG:-${DEFAULT_FIRST_PARTY_IMAGE_TAG}}"
django_image="${DJANGO_IMAGE_REPO}:${image_tag}"
hash_script="${script_dir}/lib/image-source-hash.py"
check_only=false
started_at=$SECONDS
forward_pids=()
forward_logs=()
controller_url=""
reset_run_id=""

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

invalid_setup() {
  echo "ERROR: $*" >&2
  exit 2
}

cleanup() {
  local status=$?
  if [[ -n "$reset_run_id" && -n "$controller_url" ]]; then
    curl -fsS -X DELETE "$controller_url/api/runs/$reset_run_id" >/dev/null 2>&1 || true
  fi
  if ((${#forward_pids[@]})); then
    for pid in "${forward_pids[@]}"; do
      kill "$pid" >/dev/null 2>&1 || true
      wait "$pid" >/dev/null 2>&1 || true
    done
  fi
  if ((${#forward_logs[@]})); then
    for log_file in "${forward_logs[@]}"; do
      rm -f "$log_file"
    done
  fi
  if [[ -n "${LAB_KUBECONFIG:-}" ]]; then
    rm -f "$LAB_KUBECONFIG"
  fi
  return "$status"
}
trap cleanup EXIT

start_forward() {
  local service="$1" remote_port="$2" health_path="$3"
  local port pid log_file
  port="$(python3 -c 'import socket; sock=socket.socket(); sock.bind(("127.0.0.1", 0)); print(sock.getsockname()[1]); sock.close()')"
  log_file="$(mktemp)"
  kubectl -n applications port-forward --address 127.0.0.1 "svc/$service" "$port:$remote_port" >"$log_file" 2>&1 &
  pid=$!
  forward_pids+=("$pid")
  forward_logs+=("$log_file")
  forward_url="http://127.0.0.1:$port"
  for _ in $(seq 1 30); do
    if curl -fsS "$forward_url$health_path" >/dev/null 2>&1; then
      return 0
    fi
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      cat "$log_file" >&2
      fail "$service port-forward exited"
    fi
    sleep 1
  done
  cat "$log_file" >&2
  fail "$service did not become reachable"
}

image_present() {
  local image="$1"
  if [[ "$PLATFORM" == macos ]]; then
    colima --profile "$colima_profile" nerdctl -- image inspect --namespace k8s.io "$image" >/dev/null 2>&1
  elif command -v nerdctl >/dev/null 2>&1; then
    nerdctl image inspect --namespace k8s.io "$image" >/dev/null 2>&1
  else
    docker image inspect "$image" >/dev/null 2>&1
  fi
}

build_image() {
  local component="$1" image="$2" context dockerfile
  if [[ "$component" == scenario-controller || "$component" == sample-django-app ]]; then
    context="$repo_root/$component"
  else
    context="$repo_root"
  fi
  dockerfile="$repo_root/$component/Dockerfile"
  if [[ "$PLATFORM" == macos ]]; then
    colima --profile "$colima_profile" nerdctl -- build --namespace k8s.io \
      -f "$dockerfile" -t "$image" "$context"
  elif command -v nerdctl >/dev/null 2>&1; then
    nerdctl build --namespace k8s.io -f "$dockerfile" -t "$image" "$context"
  else
    docker build -f "$dockerfile" -t "$image" "$context"
    docker save "$image" | sudo k3s ctr images import -
  fi
}

deploy_component() {
  local component="$1" image="$2" container="$3" restart_for_state="$4"
  local key source_hash recorded_hash deployed_image rebuild
  key="${component//-/_}"
  source_hash="$(python3 "$hash_script" "$component")"
  recorded_hash="$(kubectl -n argocd get configmap remotelab-deploy-state \
    -o "jsonpath={.data.$key}" 2>/dev/null || true)"
  deployed_image="$(kubectl -n applications get "deployment/$component" \
    -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null || true)"
  rebuild=false
  if [[ "$recorded_tag" != "$image_tag" || "$recorded_hash" != "$source_hash" || "$deployed_image" != "$image" ]] ||
      ! image_present "$image"; then
    echo "  Building $component (source or image changed)..."
    build_image "$component" "$image"
    rebuild=true
  else
    echo "  Reusing $component image"
  fi

  kubectl apply -f "$repo_root/manifests/applications/$component.yaml"
  deployed_image="$(kubectl -n applications get "deployment/$component" \
    -o jsonpath='{.spec.template.spec.containers[0].image}')"
  if [[ "$deployed_image" != "$image" ]]; then
    kubectl -n applications set image "deployment/$component" "$container=$image" >/dev/null
  fi
  if [[ "$rebuild" == true || "$restart_for_state" == true ]]; then
    kubectl -n applications rollout restart "deployment/$component" >/dev/null
  fi
  kubectl -n applications rollout status "deployment/$component" --timeout=180s
}

if (($# > 1)); then
  invalid_setup "usage: deploy-warm.sh [--check]"
fi
case "${1:-}" in
  --check) check_only=true ;;
  "") echo "=== Argo RemoteLab warm deployment ===" ;;
  *) invalid_setup "usage: deploy-warm.sh [--check]" ;;
esac
if [[ ! "$colima_profile" =~ ^[a-z][a-z0-9-]*$ ]]; then
  invalid_setup "COLIMA_PROFILE must contain lowercase letters, numbers, and hyphens"
fi
for command in kubectl python3 git curl jq age-keygen sops; do
  command -v "$command" >/dev/null 2>&1 || invalid_setup "missing required tool: $command"
done

if [[ "$PLATFORM" == macos ]]; then
  command -v colima >/dev/null 2>&1 || invalid_setup "Colima is required"
  if ! colima_json="$(env -u COLIMA_PROFILE colima list --json 2>/dev/null)"; then
    invalid_setup "could not list Colima profiles"
  fi
  colima_status="$(printf '%s\n' "$colima_json" | python3 -c '
import json, sys
for line in sys.stdin:
    item = json.loads(line)
    if item.get("name") == sys.argv[1]:
        print(item.get("status", ""))
        break
' "$colima_profile")"
  case "$colima_status" in
    Running) ;;
    Stopped) colima start --profile "$colima_profile" --activate=false --cpu 4 ;;
    "") fail "Colima profile $colima_profile does not exist" ;;
    *) invalid_setup "Colima profile $colima_profile is $colima_status; repair it before deployment" ;;
  esac
fi
switch_to_local_context || fail "the lab Kubernetes context is unavailable"

echo "Step 1: Checking the existing lab..."
for namespace in argocd applications shop-staging; do
  phase="$(kubectl get namespace "$namespace" -o jsonpath='{.status.phase}' 2>/dev/null || true)"
  [[ "$phase" == Active ]] || fail "namespace $namespace is not active"
done
for target in argocd/argocd-server argocd/argocd-repo-server \
              applications/postgresql applications/gitea \
              applications/scenario-controller applications/learning-service \
              kube-system/traefik; do
  namespace="${target%%/*}"
  deployment="${target#*/}"
  kubectl -n "$namespace" rollout status "deployment/$deployment" --timeout=15s >/dev/null ||
    fail "$target is not ready"
done
expected_dependencies_hash="$(python3 "$hash_script" dependencies)"
deployed_dependencies_hash="$(kubectl -n argocd get configmap remotelab-deploy-state \
  -o jsonpath='{.data.dependencies_hash}' 2>/dev/null || true)"
[[ "$expected_dependencies_hash" == "$deployed_dependencies_hash" ]] ||
  fail "pinned infrastructure dependencies changed; run the full deployment to replace Argo CD, PostgreSQL, and Gitea"
key_file="$repo_root/secrets/keys/local.key"
[[ -s "$key_file" ]] || fail "missing $key_file"
for namespace in argocd applications; do
  if ! kubectl -n "$namespace" get secret sops-age-key -o jsonpath='{.data.key\.txt}' |
      python3 -c 'import base64, pathlib, sys; sys.exit(base64.b64decode(sys.stdin.read()) != pathlib.Path(sys.argv[1]).read_bytes())' "$key_file"; then
    fail "$namespace SOPS key differs from $key_file"
  fi
done
age_public_key="$(age-keygen -y "$key_file")"
kubectl -n argocd get application shop-web-prod shop-web-staging >/dev/null ||
  fail "shop Applications are missing"
start_forward scenario-controller 8092 /healthz
controller_url="$forward_url"
start_forward gitea 3000 /api/healthz
gitea_url="$forward_url"
GIT_TERMINAL_PROMPT=0 git ls-remote --exit-code \
  "http://remotelab:remotelab@${gitea_url#http://}/remotelab/django-app.git" \
  refs/tags/baseline >/dev/null 2>&1 ||
  fail "Gitea baseline tag is missing"
echo "  OK: Existing Kubernetes services and SOPS key are ready"
if [[ "$check_only" == true ]]; then
  exit 0
fi

echo "Step 2: Resetting the lab to its baseline..."
created="$(curl -fsS -X POST -H 'Content-Type: application/json' \
  --data '{"scenario":"console-orientation","environment":"prod","replace_existing":true}' \
  "$controller_url/api/runs")"
reset_run_id="$(jq -er '.id' <<<"$created")"
deadline=$((SECONDS + 420))
while (( SECONDS < deadline )); do
  run="$(curl -fsS "$controller_url/api/runs/$reset_run_id")"
  state="$(jq -r '.state // ""' <<<"$run")"
  case "$state" in
    READY) break ;;
    FAILED|ABORTED) fail "baseline reset $state: $(jq -r '.error // "no detail"' <<<"$run")" ;;
  esac
  sleep 3
done
[[ "$state" == READY ]] || fail "baseline reset did not reach READY in time"
curl -fsS -X DELETE "$controller_url/api/runs/$reset_run_id" >/dev/null
reset_run_id=""
for app in shop-web-prod shop-web-staging; do
  kubectl -n argocd annotate application "$app" \
    remotelab.io/first-scenario-ready=false \
    remotelab.io/current-scenario= --overwrite >/dev/null
done

repository_hash="$(python3 "$hash_script" repository)"
recorded_repository_hash="$(kubectl -n argocd get configmap remotelab-deploy-state \
  -o jsonpath='{.data.repository_hash}' 2>/dev/null || true)"
source_changed=false
if [[ "$repository_hash" != "$recorded_repository_hash" ]]; then
  source_changed=true
fi
if [[ "$source_changed" == true ]]; then
  command -v sops >/dev/null 2>&1 || fail "sops is required to update the lab repository"
  echo "  Chart or platform source changed; seeding a new baseline"
  bash "$script_dir/reset-gitea-repo.sh" "$gitea_url" "$age_public_key"
else
  echo "  Reusing the existing baseline and release history"
fi

django_source_hash="$(python3 "$hash_script" sample-django-app)"
deployed_django_hash="$(kubectl -n argocd get configmap remotelab-deploy-state \
  -o jsonpath='{.data.sample_django_app}' 2>/dev/null || true)"
deployed_django_tag="$(kubectl -n argocd get configmap remotelab-deploy-state \
  -o jsonpath='{.data.image_tag}' 2>/dev/null || true)"
django_rebuilt=false
if [[ "$django_source_hash" != "$deployed_django_hash" || "$deployed_django_tag" != "$image_tag" ]] ||
    ! image_present "$django_image"; then
  echo "  Building sample Django image (source or image changed)..."
  build_image sample-django-app "$django_image"
  django_rebuilt=true
fi

kubectl apply -f "$repo_root/argocd-apps/projects.yaml"
kubectl apply -f "$repo_root/argocd-apps/django-app.yaml"
kubectl apply -f "$repo_root/argocd-apps/platform-apps.yaml"
kubectl apply -f "$repo_root/manifests/gitops/argocd-ingress.yaml"
kubectl apply -f "$repo_root/manifests/infrastructure/"
if [[ "$source_changed" == true ]]; then
  bash "$script_dir/configure-gitea-webhook.sh" "$gitea_url"
  bash "$script_dir/seed-history.sh" "$gitea_url"
else
  bash "$script_dir/seed-history.sh" "$gitea_url" --wait-only
fi
if [[ "$django_rebuilt" == true ]]; then
  for namespace in applications shop-staging; do
    kubectl -n "$namespace" rollout restart deployment/django >/dev/null
    kubectl -n "$namespace" rollout status deployment/django --timeout=180s
  done
fi

echo "Step 3: Updating changed first-party images..."
recorded_tag="$(kubectl -n argocd get configmap remotelab-deploy-state \
  -o jsonpath='{.data.image_tag}' 2>/dev/null || true)"
deploy_component scenario-controller "${SCENARIO_CONTROLLER_IMAGE_REPO}:$image_tag" controller true
deploy_component learning-service "${LEARNING_SERVICE_IMAGE_REPO}:$image_tag" learning-service true
deploy_component lab-terminal "${LAB_TERMINAL_IMAGE_REPO}:$image_tag" terminal false
deploy_component lab-gateway "${LAB_GATEWAY_IMAGE_REPO}:$image_tag" gateway false
bash "$script_dir/record-deploy-state.sh" "$image_tag"
bash "$script_dir/host-port-forwards.sh" start gitea
bash "$script_dir/host-port-forwards.sh" start traefik

echo "Warm deployment ready in $((SECONDS - started_at))s"
echo ""
echo "Start here: https://localhost:8443/"
