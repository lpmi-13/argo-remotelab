#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
IXIMIUZ_DIR="${REPO_DIR}/playground/iximiuz"

ARGOCD_ADMIN_PASSWORD="remotelab"
ARGOCD_ADMIN_PASSWORD_HASH='$2a$10$53xm8W5NWtQbIe2oMGQlheoTFSxh4El7pz1Mdf3NHiRGdund2oPya'
GITEA_URL="http://127.0.0.1:30082"
STATE_DIR="/var/lib/argo-remotelab"

export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"

log_phase() {
    printf '%s [deploy] %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$*" >&2
}

run_phase() {
    local label="$1"
    local started_at=$SECONDS
    shift
    log_phase "START ${label}"
    "$@"
    log_phase "DONE ${label} ($((SECONDS - started_at))s)"
}

wait_for_k3s_api() {
    for _ in $(seq 1 180); do
        if kubectl get --raw=/readyz >/dev/null 2>&1; then
            return 0
        fi
        sleep 1
    done

    echo "k3s API did not become ready in time" >&2
    exit 1
}

cleanup_namespace() {
    local namespace="$1"

    if ! kubectl get namespace "${namespace}" >/dev/null 2>&1; then
        return 0
    fi

    if [[ "${namespace}" == "argocd" ]]; then
        kubectl get applications.argoproj.io -n argocd -o name 2>/dev/null \
            | xargs -r -I {} kubectl patch {} -n argocd --type=merge -p '{"metadata":{"finalizers":null}}' >/dev/null 2>&1 || true
    fi

    kubectl get jobs -n "${namespace}" -o name 2>/dev/null \
        | xargs -r -I {} kubectl patch {} -n "${namespace}" --type=merge -p '{"metadata":{"finalizers":null}}' >/dev/null 2>&1 || true
    kubectl delete namespace "${namespace}" --ignore-not-found=true --wait=false >/dev/null 2>&1 || true
}

wait_for_namespace_deletion() {
    local namespace="$1"

    for _ in $(seq 1 90); do
        if ! kubectl get namespace "${namespace}" >/dev/null 2>&1; then
            return 0
        fi
        kubectl patch namespace "${namespace}" --type=merge -p '{"metadata":{"finalizers":null}}' >/dev/null 2>&1 || true
        sleep 1
    done

    echo "namespace ${namespace} did not delete in time" >&2
    exit 1
}

set_argocd_admin_password() {
    local password_mtime

    password_mtime="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    kubectl -n argocd patch secret argocd-secret --type=merge \
        --patch "{\"stringData\":{\"admin.password\":\"${ARGOCD_ADMIN_PASSWORD_HASH}\",\"admin.passwordMtime\":\"${password_mtime}\",\"accounts.learner.password\":\"${ARGOCD_ADMIN_PASSWORD_HASH}\",\"accounts.learner.passwordMtime\":\"${password_mtime}\"}}" >/dev/null
    kubectl -n argocd delete secret argocd-initial-admin-secret --ignore-not-found=true >/dev/null
}

configure_argocd_server_for_vm() {
    kubectl -n argocd patch configmap argocd-cmd-params-cm --type=merge \
        --patch '{"data":{"server.insecure":"true","server.rootpath":"/argocd","server.basehref":"/argocd"}}' >/dev/null
}

apply_preloaded_gitea() {
    bash "${SCRIPT_DIR}/render-preloaded-manifest.sh" gitea \
        "${LAB_PUBLIC_URL:-http://127.0.0.1:30080}" | kubectl apply -f - >/dev/null
}

apply_preloaded_gateway() {
    bash "${SCRIPT_DIR}/render-preloaded-manifest.sh" gateway \
        | kubectl apply -f - >/dev/null
}

create_sops_key() {
    local age_key_file="${STATE_DIR}/secrets/local.key"
    local age_public_key
    local phase_started

    mkdir -p "$(dirname "${age_key_file}")"
    rm -f "${age_key_file}"
    age-keygen -o "${age_key_file}" >/dev/null 2>&1
    chmod 644 "${age_key_file}"
    age_public_key="$(awk '/public key:/ {print $NF}' "${age_key_file}")"

    phase_started=$SECONDS
    log_phase "START Argo CD SOPS Secret apply"
    kubectl create secret generic sops-age-key \
        --namespace argocd \
        --from-file=key.txt="${age_key_file}" \
        --dry-run=client -o yaml | kubectl apply -f - >/dev/null
    log_phase "DONE Argo CD SOPS Secret apply ($((SECONDS - phase_started))s)"

    phase_started=$SECONDS
    log_phase "START applications SOPS Secret apply"
    kubectl create secret generic sops-age-key \
        --namespace applications \
        --from-file=key.txt="${age_key_file}" \
        --dry-run=client -o yaml | kubectl apply -f - >/dev/null
    log_phase "DONE applications SOPS Secret apply ($((SECONDS - phase_started))s)"

    phase_started=$SECONDS
    log_phase "START SOPS ConfigMap apply"
    kubectl create configmap sops-config \
        --namespace applications \
        --from-literal=age-public-key="${age_public_key}" \
        --dry-run=client -o yaml | kubectl apply -f - >/dev/null
    log_phase "DONE SOPS ConfigMap apply ($((SECONDS - phase_started))s)"

    printf '%s\n' "${age_public_key}"
}

wait_for_gitea_api() {
    for _ in $(seq 1 120); do
        if curl -fsS "${GITEA_URL}/api/healthz" >/dev/null; then
            return 0
        fi
        sleep 1
    done

    echo "Gitea API did not become ready at ${GITEA_URL}" >&2
    exit 1
}

init_gitea_repo() {
    local age_public_key="$1"
    local age_key_file="${STATE_DIR}/secrets/local.key"
    local work_dir
    local repo_status

    wait_for_gitea_api

    repo_status="$(curl -s -o /dev/null -w "%{http_code}" \
        -u "remotelab:remotelab" \
        "${GITEA_URL}/api/v1/repos/remotelab/django-app")"

    if [[ "${repo_status}" == "200" ]]; then
        curl -fsS -X DELETE "${GITEA_URL}/api/v1/repos/remotelab/django-app" \
            -u "remotelab:remotelab" >/dev/null
        sleep 2
    fi

    curl -fsS -X POST "${GITEA_URL}/api/v1/user/repos" \
        -H "Content-Type: application/json" \
        -u "remotelab:remotelab" \
        -d '{"name":"django-app","description":"Django app with Helm chart and SOPS secrets","private":false,"auto_init":true,"default_branch":"main"}' >/dev/null
    sleep 3

    work_dir="$(mktemp -d)"
    trap "rm -rf '${work_dir}'" RETURN

    cd "${work_dir}"
    git init -q -b main
    git config user.email "remotelab@localhost"
    git config user.name "Remotelab"
    cp -R "${REPO_DIR}/sample-django-app/chart" .
    cp -R "${REPO_DIR}/sample-django-app/platform" .

    cat > chart/django-app/.sops.yaml <<SOPSEOF
creation_rules:
  - path_regex: '.*\.enc$'
    age: '${age_public_key}'
SOPSEOF

    cat > "${work_dir}/secrets-plain.yaml" <<SECRETSEOF
secrets:
  DB_PASSWORD: "remotelab"
  SECRET_KEY: "django-production-secret-key-argo-remotelab-2024"
  API_TOKEN: "tok_prod_abc123def456"
SECRETSEOF

    export SOPS_AGE_KEY_FILE="${age_key_file}"
    sops encrypt --age "${age_public_key}" --input-type yaml --output-type yaml \
        "${work_dir}/secrets-plain.yaml" > chart/django-app/secrets.yaml.enc
    rm -f "${work_dir}/secrets-plain.yaml"
    cp -R chart/django-app chart/django-app-staging
    sed -i.bak 's/DB_HOST: "postgresql"/DB_HOST: "postgresql.applications.svc.cluster.local"/;s/APP_ENVIRONMENT: "production"/APP_ENVIRONMENT: "staging"/' chart/django-app-staging/values.yaml
    rm -f chart/django-app-staging/values.yaml.bak
    rm -f chart/django-app-*.tgz

    cat > README.md <<'READMEEOF'
# Django Application

Helm chart managed by ArgoCD with SOPS-encrypted secrets.
READMEEOF

    git add -A
    git commit -q -m "Initial commit: Django app with Helm chart and SOPS secrets"
    git tag baseline
    git remote add origin "http://remotelab:remotelab@127.0.0.1:30082/remotelab/django-app.git"
    git push -f -u origin main -q
    git push origin baseline -q

    cd "${REPO_DIR}"
}

prepare_gitea_repo() {
    local age_public_key="$1"

    run_phase "PostgreSQL rollout" kubectl -n applications wait --for=condition=available --timeout=300s deployment/postgresql
    run_phase "Gitea rollout" kubectl -n applications wait --for=condition=available --timeout=300s deployment/gitea
    run_phase "Gitea user manifest apply" kubectl apply -f "${REPO_DIR}/manifests/applications/gitea-init-user.yaml"
    run_phase "Gitea user job" kubectl -n applications wait --for=condition=complete --timeout=180s job/gitea-init-user
    run_phase "Gitea repository initialization" init_gitea_repo "${age_public_key}"
}

wait_for_gateway_health() {
    local attempt
    for attempt in $(seq 1 60); do
        if curl -fsS http://127.0.0.1:30080/healthz >/dev/null 2>&1; then
            return 0
        fi
        sleep 1
    done
    echo "lab gateway did not become healthy on port 30080" >&2
    return 1
}

log_phase "Deploying the preloaded iximiuz VM stack"
run_phase "k3s API readiness" wait_for_k3s_api

phase_started=$SECONDS
log_phase "START namespace cleanup"
cleanup_namespace applications
cleanup_namespace shop-staging
cleanup_namespace argocd
wait_for_namespace_deletion applications
wait_for_namespace_deletion shop-staging
wait_for_namespace_deletion argocd
log_phase "DONE namespace cleanup ($((SECONDS - phase_started))s)"

run_phase "applications namespace apply" kubectl apply -f "${REPO_DIR}/manifests/applications/namespace.yaml"
run_phase "Argo CD namespace apply" kubectl apply -f "${REPO_DIR}/manifests/gitops/argocd-namespace.yaml"

# These workloads can start while Argo CD installs and is configured.
run_phase "PostgreSQL manifest apply" kubectl apply -f "${REPO_DIR}/manifests/applications/postgresql.yaml"
run_phase "Gitea manifest apply" apply_preloaded_gitea
phase_started=$SECONDS
log_phase "START SOPS key generation and Secret apply"
age_public_key="$(create_sops_key)"
log_phase "DONE SOPS key generation and Secret apply ($((SECONDS - phase_started))s)"

prepare_gitea_repo "${age_public_key}" &
gitea_prepare_pid=$!
trap 'kill "${gitea_prepare_pid}" 2>/dev/null || true' EXIT

phase_started=$SECONDS
log_phase "START Argo CD install manifest apply"
sed 's/imagePullPolicy: Always/imagePullPolicy: IfNotPresent/g' "${REPO_DIR}/manifests/gitops/argocd-install.yaml" \
    | kubectl apply --server-side --force-conflicts -n argocd -f - >/dev/null
log_phase "DONE Argo CD install manifest apply ($((SECONDS - phase_started))s)"

run_phase "Argo CD VM parameters apply" configure_argocd_server_for_vm
run_phase "Argo CD learner RBAC apply" kubectl apply -f "${REPO_DIR}/manifests/gitops/argocd-learner-rbac.yaml"
run_phase "Argo CD passwords apply" set_argocd_admin_password
run_phase "Argo CD SOPS manifest apply" kubectl apply -f "${IXIMIUZ_DIR}/manifests/argocd-sops-config-preloaded.yaml"
# The command parameters are read from the ConfigMap at container start.
# Restart once after every setting is present, then wait for the final pod.
run_phase "Argo CD server restart" kubectl -n argocd rollout restart deployment/argocd-server

run_phase "Argo CD server rollout" kubectl -n argocd rollout status deployment/argocd-server --timeout=300s
run_phase "Argo CD repo-server rollout" kubectl -n argocd rollout status deployment/argocd-repo-server --timeout=300s
run_phase "Gitea repository path" wait "${gitea_prepare_pid}"
trap - EXIT

phase_started=$SECONDS
log_phase "START Argo CD repository Secret apply"
cat <<EOF | kubectl apply -f - >/dev/null
apiVersion: v1
kind: Secret
metadata:
  name: gitea-repo
  namespace: argocd
  labels:
    argocd.argoproj.io/secret-type: repository
stringData:
  type: git
  url: http://gitea.applications.svc.cluster.local:3000/remotelab/django-app.git
  username: remotelab
  password: remotelab
EOF
log_phase "DONE Argo CD repository Secret apply ($((SECONDS - phase_started))s)"

run_phase "Argo CD projects manifest apply" kubectl apply -f "${REPO_DIR}/argocd-apps/projects.yaml"
run_phase "Django Applications manifest apply" kubectl apply -f "${REPO_DIR}/argocd-apps/django-app.yaml"
run_phase "Platform Applications manifest apply" kubectl apply -f "${REPO_DIR}/argocd-apps/platform-apps.yaml"
run_phase "Gitea webhook configuration" bash "${REPO_DIR}/scripts/configure-gitea-webhook.sh" "${GITEA_URL}"

phase_started=$SECONDS
log_phase "START initial Django readiness"
for _ in $(seq 1 36); do
    ready_replicas="$(kubectl -n applications get deployment django -o jsonpath='{.status.readyReplicas}' 2>/dev/null || true)"
    if [[ "${ready_replicas:-0}" -ge 1 ]]; then
        break
    fi
    sleep 5
done
log_phase "DONE initial Django readiness ($((SECONDS - phase_started))s)"
run_phase "release history seeding" bash "${REPO_DIR}/scripts/seed-history.sh" "${GITEA_URL}"

run_phase "scenario controller manifest apply" kubectl apply -f "${REPO_DIR}/manifests/applications/scenario-controller.yaml"
run_phase "scenario controller rollout" kubectl -n applications rollout status deployment/scenario-controller --timeout=180s

run_phase "learning service manifest apply" kubectl apply -f "${REPO_DIR}/manifests/applications/learning-service.yaml"
run_phase "learning service rollout" kubectl -n applications rollout status deployment/learning-service --timeout=180s
run_phase "lab terminal manifest apply" kubectl apply -f "${REPO_DIR}/manifests/applications/lab-terminal.yaml"
run_phase "lab terminal rollout" kubectl -n applications rollout status deployment/lab-terminal --timeout=180s
run_phase "lab gateway manifest apply" apply_preloaded_gateway
run_phase "lab gateway rollout" kubectl -n applications rollout status deployment/lab-gateway --timeout=180s
run_phase "lab gateway health" wait_for_gateway_health

# The launcher creates the first run after the baseline is healthy.

echo "GitOps Failure Lab is ready:"
echo "  Lab:    http://127.0.0.1:30080"
echo "  Gitea:  http://127.0.0.1:30082"
echo "  Login:  admin / ${ARGOCD_ADMIN_PASSWORD}"
echo ""
echo "Fix scenarios by cloning the lab repo, editing, and pushing:"
echo "  git clone http://remotelab:remotelab@127.0.0.1:30082/remotelab/django-app.git"
echo "  # for SOPS-encrypted files: export SOPS_AGE_KEY_FILE=${STATE_DIR}/secrets/local.key"
