#!/bin/bash
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
source "${SCRIPT_DIR}/lib/platform.sh"
source "${SCRIPT_DIR}/lib/versions.sh"

TRAEFIK_CRD_DEFINITIONS_URL="https://raw.githubusercontent.com/traefik/traefik/v3.7.13/docs/content/reference/dynamic-configuration/kubernetes-crd-definition-v1.yml"
ARGOCD_ADMIN_PASSWORD="remotelab"
# bcrypt hash for ARGOCD_ADMIN_PASSWORD. ArgoCD stores the admin password hash
# in argocd-secret rather than the generated initial-admin secret.
ARGOCD_ADMIN_PASSWORD_HASH='$2a$10$53xm8W5NWtQbIe2oMGQlheoTFSxh4El7pz1Mdf3NHiRGdund2oPya'
IMAGE_TAG="${IMAGE_TAG:-${DEFAULT_FIRST_PARTY_IMAGE_TAG}}"
SCENARIO_CONTROLLER_IMAGE="${SCENARIO_CONTROLLER_IMAGE_REPO}:${IMAGE_TAG}"
LEARNING_SERVICE_IMAGE="${LEARNING_SERVICE_IMAGE_REPO}:${IMAGE_TAG}"
LAB_GATEWAY_IMAGE="${LAB_GATEWAY_IMAGE_REPO}:${IMAGE_TAG}"
LAB_TERMINAL_IMAGE="${LAB_TERMINAL_IMAGE_REPO}:${IMAGE_TAG}"
DJANGO_IMAGE="${DJANGO_IMAGE_REPO}:${IMAGE_TAG}"
GITEA_LOCAL_URL="http://localhost:3000"
K3S_READY_TIMEOUT=15

show_help() {
    echo "Usage: ./deploy-all.sh [OPTIONS]"
    echo ""
    echo "Deploy the GitOps failure lab. Reuse a ready lab; otherwise run the full setup."
    echo ""
    echo "Options:"
    echo "  --warm            Require an existing lab and run the warm deployment"
    echo "  --full            Rebuild the lab even when a warm deployment is available"
    echo "  --skip-cleanup    Run the full setup without deleting existing resources"
    echo "  COLIMA_PROFILE    Environment variable for the macOS Colima profile (default: argo-remotelab)"
    echo "  --help, -h        Show this help message"
    echo ""
}

run_privileged() {
    if [ "$(id -u)" -eq 0 ]; then
        "$@"
    else
        sudo "$@"
    fi
}

require_linux_sudo() {
    if [ "$(id -u)" -eq 0 ]; then
        return 0
    fi
    if ! sudo -v; then
        echo "  ERROR: Linux deployment needs sudo access for k3s service and image operations." >&2
        echo "         Run deploy-all.sh in an interactive terminal and enter your sudo password." >&2
        return 1
    fi
}

import_docker_image_to_k3s() {
    local image="$1"

    require_linux_sudo
    if [ "$(id -u)" -eq 0 ]; then
        docker save "$image" | k3s ctr images import -
    else
        docker save "$image" | sudo -n k3s ctr images import -
    fi
}

wait_for_k3s_api() {
    local waited=0
    local kubectl_output
    local config_file="${KUBECONFIG:-${HOME}/.kube/config}"

    while true; do
        if kubectl_output=$(kubectl cluster-info 2>&1); then
            return 0
        fi
        if [[ "$kubectl_output" == *"You must be logged in"* ||
              "$kubectl_output" == *"the server has asked for the client to provide credentials"* ||
              "$kubectl_output" == *"Unauthorized"* ||
              "$kubectl_output" == *"certificate has expired"* ]]; then
            echo "  ERROR: k3s is running, but kubectl credentials in $config_file were rejected." >&2
            echo "         MANUAL ACTION REQUIRED: run ./scripts/manual-refresh.sh from the repository root, then rerun deploy-all.sh." >&2
            return 1
        fi
        if [ "$waited" -ge "$K3S_READY_TIMEOUT" ]; then
            echo "  ERROR: k3s API did not become ready within ${K3S_READY_TIMEOUT}s" >&2
            printf '%s\n' "$kubectl_output" | tail -1 >&2
            return 1
        fi
        sleep 3
        waited=$((waited + 3))
    done
}

ensure_linux_k3s_running() {
    if [[ "$PLATFORM" != "linux" ]]; then
        return 0
    fi

    if ! systemctl is-active --quiet k3s; then
        echo "  Starting k3s service..."
        if ! run_privileged systemctl start k3s; then
            echo "  ERROR: Could not start k3s service" >&2
            return 1
        fi
        echo "  Waiting for k3s API..."
    fi
    wait_for_k3s_api
    echo "  OK: k3s API reachable"
}

SKIP_CLEANUP=false
if (( $# > 1 )); then
    echo "Error: Pass at most one option" >&2
    show_help >&2
    exit 2
fi
case "${1:-}" in
  --help|-h) show_help; exit 0 ;;
  --warm) ensure_linux_k3s_running; exec bash "$SCRIPT_DIR/deploy-warm.sh" ;;
  --full) ensure_linux_k3s_running ;;
  --skip-cleanup) ensure_linux_k3s_running; SKIP_CLEANUP=true ;;
  "")
    ensure_linux_k3s_running
    if warm_check_output=$(bash "$SCRIPT_DIR/deploy-warm.sh" --check 2>&1); then
        echo "Existing lab is ready; running warm deployment."
        exec bash "$SCRIPT_DIR/deploy-warm.sh"
    else
        warm_check_status=$?
        printf '%s\n' "$warm_check_output" >&2
        if [[ "$warm_check_status" -ne 1 ]]; then
            echo "Warm deployment check could not run; full deployment was not started." >&2
            exit "$warm_check_status"
        fi
        echo "Existing lab is not ready; running the full deployment."
    fi
    ;;
  *)
    echo "Error: Unknown option '$1'" >&2
    show_help >&2
    exit 2
    ;;
esac

get_k3s_node_internal_ip() {
    local node_name="$1"
    kubectl get node "$node_name" \
        -o jsonpath='{range .status.addresses[?(@.type=="InternalIP")]}{.address}{end}' 2>/dev/null || true
}

get_kubernetes_endpoint_ip() {
    local endpoint_ip
    endpoint_ip=$(kubectl get endpointslices.discovery.k8s.io -n default \
        -l kubernetes.io/service-name=kubernetes \
        -o jsonpath='{.items[0].endpoints[0].addresses[0]}' 2>/dev/null || true)

    if [ -z "$endpoint_ip" ]; then
        endpoint_ip=$(kubectl get endpoints kubernetes -n default \
            -o jsonpath='{.subsets[0].addresses[0].ip}' 2>/dev/null || true)
    fi

    echo "$endpoint_ip"
}

update_k3s_ip_config() {
    local desired_ip="$1"
    local config_file="/etc/rancher/k3s/config.yaml"
    local temp_file
    local next_file
    local timestamp

    temp_file=$(mktemp)
    next_file=$(mktemp)
    timestamp=$(date +%Y%m%d%H%M%S)

    if run_privileged test -f "$config_file"; then
        run_privileged awk '!/^(node-ip|advertise-address):[[:space:]]/' "$config_file" > "$temp_file"
        run_privileged cp "$config_file" "${config_file}.bak.${timestamp}"
    else
        : > "$temp_file"
        run_privileged mkdir -p "$(dirname "$config_file")"
    fi

    cat "$temp_file" > "$next_file"
    if [ -s "$next_file" ]; then
        printf '\n' >> "$next_file"
    fi
    {
        printf 'node-ip: %s\n' "$desired_ip"
        printf 'advertise-address: %s\n' "$desired_ip"
    } >> "$next_file"

    run_privileged install -m 0644 "$next_file" "$config_file"
    rm -f "$temp_file" "$next_file"
}

wait_for_k3s_ip_repair() {
    local node_name="$1"
    local desired_ip="$2"
    local waited=0
    local api_ready=false
    local node_ready=""
    local node_ip=""
    local endpoint_ip=""

    while true; do
        if kubectl cluster-info &>/dev/null; then
            api_ready=true
            node_ready=$(kubectl get node "$node_name" \
                -o jsonpath='{range .status.conditions[?(@.type=="Ready")]}{.status}{end}' 2>/dev/null || true)
            node_ip=$(get_k3s_node_internal_ip "$node_name")
            endpoint_ip=$(get_kubernetes_endpoint_ip)

            if [[ "$node_ready" == "True" && "$node_ip" == "$desired_ip" && "$endpoint_ip" == "$desired_ip" ]]; then
                return 0
            fi
        else
            api_ready=false
        fi

        if [ "$waited" -ge "$K3S_READY_TIMEOUT" ]; then
            break
        fi
        sleep 3
        waited=$((waited + 3))
    done

    echo "  ERROR: k3s IP repair did not become ready within ${K3S_READY_TIMEOUT}s" >&2
    echo "         API reachable: $api_ready; node Ready: ${node_ready:-unknown}" >&2
    echo "         Node IP: ${node_ip:-unknown}; API endpoint: ${endpoint_ip:-unknown}; expected: $desired_ip" >&2
    return 1
}

refresh_linux_coredns() {
    if ! kubectl -n kube-system get deployment coredns &>/dev/null; then
        echo "  WARNING: CoreDNS deployment not found; skipping DNS refresh"
        return 0
    fi

    echo "  Refreshing CoreDNS resolver state..."
    kubectl -n kube-system rollout restart deployment/coredns >/dev/null
    if ! kubectl -n kube-system rollout status deployment/coredns --timeout=120s >/dev/null; then
        echo "  ERROR: CoreDNS did not become ready after restart"
        exit 1
    fi
    echo "  OK: CoreDNS ready"
}

wait_for_traefik_middleware_api() {
    local waited=0

    while [ $waited -lt 60 ]; do
        if kubectl get middlewares.traefik.io -A &>/dev/null; then
            return 0
        fi
        sleep 2
        waited=$((waited + 2))
    done

    echo "  ERROR: Traefik Middleware API did not become discoverable"
    exit 1
}

set_argocd_admin_password() {
    local password_mtime

    password_mtime=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    kubectl -n argocd patch secret argocd-secret --type=merge \
        --patch "{\"stringData\":{\"admin.password\":\"${ARGOCD_ADMIN_PASSWORD_HASH}\",\"admin.passwordMtime\":\"${password_mtime}\",\"accounts.learner.password\":\"${ARGOCD_ADMIN_PASSWORD_HASH}\",\"accounts.learner.passwordMtime\":\"${password_mtime}\"}}" >/dev/null
    kubectl -n argocd delete secret argocd-initial-admin-secret --ignore-not-found=true >/dev/null
    kubectl -n argocd rollout restart deployment/argocd-server >/dev/null
    kubectl -n argocd rollout status deployment/argocd-server --timeout=300s >/dev/null
}

ensure_traefik_crds() {
    if kubectl get crd middlewares.traefik.io &>/dev/null; then
        wait_for_traefik_middleware_api
        echo "  OK: Traefik CRDs present"
        return 0
    fi

    echo "  Installing Traefik CRDs..."
    kubectl apply -f "$TRAEFIK_CRD_DEFINITIONS_URL"
    kubectl wait --for=condition=Established --timeout=120s crd/middlewares.traefik.io >/dev/null
    wait_for_traefik_middleware_api
    echo "  OK: Traefik CRDs present"
}

check_api_services_available() {
    local unavailable

    unavailable=$(kubectl get apiservices -o json | python3 -c '
import json, sys
for item in json.load(sys.stdin)["items"]:
    condition = next((value for value in item.get("status", {}).get("conditions", [])
                      if value.get("type") == "Available"), {})
    if condition.get("status") != "True":
        name = item["metadata"]["name"]
        reason = condition.get("reason", "unknown reason")
        print(f"{name}: {reason}")
')
    if [[ -n "$unavailable" ]]; then
        echo "  ERROR: Kubernetes API discovery is unhealthy; namespace deletion may stall." >&2
        printf '         %s\n' "$unavailable" >&2
        echo "         Repair the unavailable APIService before rerunning deployment." >&2
        return 1
    fi
}

repair_linux_k3s_ip_if_needed() {
    local desired_ip
    local node_name
    local node_ip
    local endpoint_ip

    desired_ip=$(get_node_ip)
    if [[ -z "$desired_ip" || "$desired_ip" == "127."* ]]; then
        echo "  ERROR: Could not determine a non-loopback host IP for k3s"
        exit 1
    fi

    node_name=$(kubectl get nodes -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
    if [ -z "$node_name" ]; then
        echo "  ERROR: Could not determine k3s node name"
        exit 1
    fi

    node_ip=$(get_k3s_node_internal_ip "$node_name")
    endpoint_ip=$(get_kubernetes_endpoint_ip)

    if [[ "$node_ip" == "$desired_ip" && "$endpoint_ip" == "$desired_ip" ]]; then
        echo "  OK: k3s advertises current host IP ($desired_ip)"
        return 0
    fi

    echo "  Detected k3s IP drift:"
    echo "    current host IP:       $desired_ip"
    echo "    k3s node InternalIP:   ${node_ip:-unknown}"
    echo "    Kubernetes API endpoint: ${endpoint_ip:-unknown}"
    echo "  Updating /etc/rancher/k3s/config.yaml and restarting k3s..."

    update_k3s_ip_config "$desired_ip"
    run_privileged systemctl restart k3s

    echo "  Waiting up to ${K3S_READY_TIMEOUT}s for k3s to advertise $desired_ip..."
    wait_for_k3s_ip_repair "$node_name" "$desired_ip"
    echo "  OK: k3s now advertises $desired_ip"
}

echo "=== GitOps Failure Lab - Deployment ==="
echo ""

# --- Platform Setup ---
OS=$(uname -s)

if [[ "$OS" == "Darwin" ]]; then
    echo "Step 1: Setting up Colima with k3s..."
    COLIMA_PROFILE="${COLIMA_PROFILE:-argo-remotelab}"
    if [[ ! "$COLIMA_PROFILE" =~ ^[a-z][a-z0-9-]*$ ]]; then
        echo "  ERROR: COLIMA_PROFILE must contain lowercase letters, numbers, and hyphens" >&2
        exit 1
    fi

    if ! command -v colima &>/dev/null; then
        echo "  ERROR: Colima is not installed. Install with: brew install colima"
        exit 1
    fi

    if ! COLIMA_JSON=$(env -u COLIMA_PROFILE colima list --json 2>/dev/null); then
        echo "  ERROR: Could not list Colima profiles" >&2
        exit 1
    fi
    COLIMA_STATUS=$(printf '%s\n' "$COLIMA_JSON" | python3 -c '
import json, sys
profile = sys.argv[1]
for line in sys.stdin:
    item = json.loads(line)
    if item.get("name") == profile:
        print(item.get("status", ""))
        break
' "$COLIMA_PROFILE")
    case "$COLIMA_STATUS" in
        Running) ;;
        Stopped) colima start --profile "$COLIMA_PROFILE" --activate=false --cpu 4 ;;
        "")
            echo "  Starting isolated Colima profile ${COLIMA_PROFILE}..."
            colima start --profile "$COLIMA_PROFILE" --activate=false \
                --kubernetes --runtime containerd --cpu 4 --memory 8 --disk 60
            ;;
        *)
            echo "  ERROR: Colima profile ${COLIMA_PROFILE} is ${COLIMA_STATUS}; repair it before deployment" >&2
            exit 1
            ;;
    esac
    switch_to_local_context || {
        echo "  ERROR: Profile ${COLIMA_PROFILE} needs a healthy Kubernetes cluster" >&2
        exit 1
    }
    trap 'rm -f "${LAB_KUBECONFIG:-}"' EXIT
    echo "  OK: Using Colima profile ${COLIMA_PROFILE}"
else
    echo "Step 1: Verifying k3s..."
    if ! kubectl cluster-info &>/dev/null; then
        echo "  ERROR: Cannot connect to Kubernetes cluster"
        exit 1
    fi
    require_linux_sudo
    echo "  OK: kubectl connected"
    repair_linux_k3s_ip_if_needed
    refresh_linux_coredns
fi

# Verify cluster connectivity
if ! kubectl cluster-info &>/dev/null; then
    echo "  ERROR: Cluster not responding"
    exit 1
fi
echo ""

if [ "$SKIP_CLEANUP" = true ] && kubectl -n applications get pvc postgresql-pvc &>/dev/null; then
    existing_postgres_image=$(kubectl -n applications get deployment postgresql \
        -o jsonpath='{.spec.template.spec.containers[?(@.name=="postgresql")].image}' 2>/dev/null || true)
    if [[ "${existing_postgres_image##*/}" != postgres:18.* ]]; then
        echo "  ERROR: --skip-cleanup cannot reuse PostgreSQL data from ${existing_postgres_image:-an older release}." >&2
        echo "         Migrate the data to PostgreSQL 18, or run --full to recreate the lab volume." >&2
        exit 1
    fi
fi

# --- Cleanup ---
if [ "$SKIP_CLEANUP" = false ]; then
    check_api_services_available
    echo "Step 2: Cleaning up existing resources..."
    for ns in applications shop-staging argocd; do
        if kubectl get namespace "$ns" &>/dev/null; then
            echo "  Removing namespace: $ns"
            # Remove ArgoCD finalizers from Applications and Jobs
            if [ "$ns" = "argocd" ]; then
                kubectl get applications.argoproj.io -n argocd -o name 2>/dev/null | \
                    xargs -I {} kubectl patch {} -n argocd -p '{"metadata":{"finalizers":null}}' --type=merge 2>/dev/null || true
            fi
            # Remove ArgoCD hook finalizers from Jobs (prevents namespace stuck in Terminating)
            kubectl get jobs -n "$ns" -o name 2>/dev/null | \
                xargs -I {} kubectl patch {} -n "$ns" -p '{"metadata":{"finalizers":null}}' --type=merge 2>/dev/null || true
            kubectl delete namespace "$ns" --ignore-not-found=true --wait=false 2>/dev/null || true
        fi
    done
    # Wait for deletion
    for ns in applications shop-staging argocd; do
        waited=0
        while kubectl get namespace "$ns" &>/dev/null && [ $waited -lt 90 ]; do
            # Clear any remaining finalizers blocking deletion
            kubectl get jobs -n "$ns" -o name 2>/dev/null | \
                xargs -I {} kubectl patch {} -n "$ns" -p '{"metadata":{"finalizers":null}}' --type=merge 2>/dev/null || true
            kubectl patch namespace "$ns" -p '{"metadata":{"finalizers":null}}' --type=merge 2>/dev/null || true
            sleep 3
            waited=$((waited + 3))
        done
        if kubectl get namespace "$ns" &>/dev/null; then
            echo "  ERROR: Namespace $ns is still terminating after 90s; deployment cannot continue." >&2
            kubectl describe namespace "$ns" >&2 || true
            exit 1
        fi
    done
    echo "  OK: Cleanup complete"
else
    echo "Step 2: Skipping cleanup"
fi
echo ""

# --- Create Namespaces ---
echo "Step 3: Creating namespaces..."
kubectl apply -f "$REPO_DIR/manifests/applications/namespace.yaml"
kubectl apply -f "$REPO_DIR/manifests/gitops/argocd-namespace.yaml"
for ns in applications argocd; do
    phase=$(kubectl get namespace "$ns" -o jsonpath='{.status.phase}')
    if [[ "$phase" != "Active" ]]; then
        echo "  ERROR: Namespace $ns is $phase; deployment cannot continue." >&2
        exit 1
    fi
done
echo "  OK: Namespaces created"
echo ""

# --- Install ArgoCD ---
echo "Step 4: Installing ArgoCD..."
kubectl apply --server-side --force-conflicts -n argocd \
    -f "$REPO_DIR/manifests/gitops/argocd-install.yaml"
echo "  Waiting for ArgoCD server..."
kubectl wait --for=condition=available --timeout=300s deployment/argocd-server -n argocd
echo "  OK: ArgoCD installed"
echo ""

# --- Configure ArgoCD ---
echo "Step 5: Configuring ArgoCD (ingress, subpath)..."

# Apply ArgoCD customizations (non-SOPS parts first)
kubectl apply -f "$REPO_DIR/manifests/gitops/argocd-cmd-params-cm.yaml"
kubectl apply -f "$REPO_DIR/manifests/gitops/argocd-learner-rbac.yaml"
kubectl apply -f "$REPO_DIR/manifests/gitops/argocd-ingress.yaml"

# Patch ArgoCD server for subpath
kubectl patch deployment argocd-server -n argocd --type='strategic' \
    --patch-file "$REPO_DIR/manifests/gitops/argocd-server-patch.yaml"

kubectl wait --for=condition=available --timeout=300s deployment/argocd-server -n argocd

# Set a deterministic admin password.
echo "  Setting ArgoCD admin password..."
set_argocd_admin_password
echo "  OK: ArgoCD password set to '${ARGOCD_ADMIN_PASSWORD}'"

echo "  OK: ArgoCD configured"
echo ""

# --- Generate SOPS age key ---
echo "Step 6: Setting up SOPS encryption..."

# Check if age is installed on the host
if ! command -v age-keygen &>/dev/null; then
    echo "  ERROR: 'age' is not installed. Install with: brew install age (macOS) or apt install age (Linux)"
    exit 1
fi

# Generate a fresh age keypair
AGE_KEY_FILE="/tmp/age-key-remotelab-$$"
rm -f "$AGE_KEY_FILE"
age-keygen -o "$AGE_KEY_FILE" 2>/dev/null
AGE_PUBLIC_KEY=$(grep "public key:" "$AGE_KEY_FILE" | awk '{print $NF}')
AGE_PRIVATE_KEY=$(grep "AGE-SECRET-KEY" "$AGE_KEY_FILE")
echo "  Generated age keypair (public: ${AGE_PUBLIC_KEY:0:20}...)"

# Create the secret in argocd namespace for helm-secrets decryption
kubectl create secret generic sops-age-key \
    --namespace argocd \
    --from-file=key.txt="$AGE_KEY_FILE" \
    --dry-run=client -o yaml | kubectl apply -f -

# Create the secret in applications namespace for the init job and scenario controller
kubectl create secret generic sops-age-key \
    --namespace applications \
    --from-file=key.txt="$AGE_KEY_FILE" \
    --dry-run=client -o yaml | kubectl apply -f -

# Create a configmap with the public key (needed by init job and scenario controller)
kubectl create configmap sops-config \
    --namespace applications \
    --from-literal=age-public-key="$AGE_PUBLIC_KEY" \
    --dry-run=client -o yaml | kubectl apply -f -

# Save the key locally for reference
mkdir -p "$REPO_DIR/secrets/keys"
cp "$AGE_KEY_FILE" "$REPO_DIR/secrets/keys/local.key"
rm "$AGE_KEY_FILE"

# Now configure ArgoCD SOPS (needs the secret to exist first)
kubectl apply -f "$REPO_DIR/manifests/gitops/argocd-sops-config.yaml"
echo "  Waiting for ArgoCD repo-server with SOPS tools..."
kubectl rollout status deployment/argocd-repo-server -n argocd --timeout=300s
echo "  OK: SOPS encryption configured"
echo "  Private key saved to: secrets/keys/local.key"
echo ""

# --- Deploy Infrastructure ---
echo "Step 7: Deploying PostgreSQL and Gitea..."
kubectl apply -f "$REPO_DIR/manifests/applications/postgresql.yaml"
kubectl apply -f "$REPO_DIR/manifests/applications/gitea.yaml"

echo "  Waiting for PostgreSQL..."
kubectl wait --for=condition=available --timeout=300s deployment/postgresql -n applications
echo "  Waiting for Gitea..."
kubectl wait --for=condition=available --timeout=300s deployment/gitea -n applications
echo "  OK: Infrastructure ready"
echo ""

# --- Ensure Traefik ---
echo "Step 8: Verifying Traefik ingress..."
if ! kubectl get deployment traefik -n kube-system &>/dev/null; then
    echo "  Installing Traefik via Helm..."
    if ! helm repo list 2>/dev/null | grep -q "^traefik"; then
        helm repo add traefik https://traefik.github.io/charts
    fi
    helm repo update traefik
    helm install traefik traefik/traefik \
        --namespace kube-system \
        --set service.type=LoadBalancer \
        --set ingressClass.enabled=true \
        --set ingressClass.isDefaultClass=true
    kubectl wait --for=condition=available --timeout=120s deployment/traefik -n kube-system
fi
echo "  OK: Traefik ready"
ensure_traefik_crds

# Apply ingress rules
kubectl apply -f "$REPO_DIR/manifests/infrastructure/"
echo ""

# --- Create Gitea user ---
echo "Step 9: Creating Gitea admin user..."
kubectl delete job gitea-init-user -n applications --ignore-not-found=true 2>/dev/null || true
kubectl apply -f "$REPO_DIR/manifests/applications/gitea-init-user.yaml"
kubectl wait --for=condition=complete --timeout=180s job/gitea-init-user -n applications 2>/dev/null || {
    echo "  WARNING: User creation may have had issues, continuing..."
}
echo "  OK: Gitea user ready (remotelab/remotelab)"
echo ""

# --- Initialize repository ---
echo "Step 10: Initializing Django app repository in Gitea..."

# Check for required tools
if ! command -v sops &>/dev/null; then
    echo "  ERROR: 'sops' is not installed on the host running this script"
    echo "         Step 10 encrypts the sample Django secrets locally before pushing them to Gitea."
    echo "         Install with: brew install sops (macOS), or use your Linux package manager / https://github.com/getsops/sops/releases"
    exit 1
fi

bash "$SCRIPT_DIR/host-port-forwards.sh" start gitea
echo "  OK: Gitea API reachable at ${GITEA_LOCAL_URL}"

bash "$REPO_DIR/scripts/reset-gitea-repo.sh" "$GITEA_LOCAL_URL" "$AGE_PUBLIC_KEY"
echo ""

# --- Create ArgoCD repo secret ---
echo "Step 11: Configuring ArgoCD repository access..."
cat <<EOF | kubectl apply -f -
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
echo "  OK: ArgoCD can access Gitea"
echo ""

# --- Build the sample application image ---
echo "Step 12: Building the sample Django image..."
if [[ "$OS" == "Darwin" ]]; then
    colima --profile "$COLIMA_PROFILE" nerdctl -- build -t "$DJANGO_IMAGE" \
        --namespace k8s.io "$REPO_DIR/sample-django-app"
elif command -v nerdctl &>/dev/null; then
    nerdctl build -t "$DJANGO_IMAGE" --namespace k8s.io "$REPO_DIR/sample-django-app"
else
    docker build -t "$DJANGO_IMAGE" "$REPO_DIR/sample-django-app"
    import_docker_image_to_k3s "$DJANGO_IMAGE"
fi
echo "  OK: Sample Django image built"
echo ""

# --- Deploy ArgoCD Application ---
echo "Step 13: Deploying ArgoCD Application..."
kubectl apply -f "$REPO_DIR/argocd-apps/projects.yaml"
kubectl apply -f "$REPO_DIR/argocd-apps/django-app.yaml"
kubectl apply -f "$REPO_DIR/argocd-apps/platform-apps.yaml"
bash "$REPO_DIR/scripts/configure-gitea-webhook.sh" "$GITEA_LOCAL_URL"
echo "  OK: ArgoCD Application created"
echo ""

# --- Wait for Django ---
echo "Step 14: Waiting for Django to be deployed by ArgoCD..."
MAX_WAIT=180
WAIT_COUNT=0
while [ $WAIT_COUNT -lt $MAX_WAIT ]; do
    if kubectl get deployment django -n applications &>/dev/null; then
        READY=$(kubectl get deployment django -n applications -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "0")
        if [ "${READY:-0}" -ge 1 ]; then
            echo "  OK: Django is running"
            break
        fi
    fi
    sleep 10
    WAIT_COUNT=$((WAIT_COUNT + 10))
    echo "  Waiting... (${WAIT_COUNT}s)"
done

if [ $WAIT_COUNT -ge $MAX_WAIT ]; then
    echo "  WARNING: Django not ready after ${MAX_WAIT}s"
    echo "  Check: kubectl get applications -n argocd shop-web-prod shop-web-staging"
    echo "  Check: kubectl get pods -n applications"
fi
echo ""
bash "$REPO_DIR/scripts/seed-history.sh" "$GITEA_LOCAL_URL"

# --- Build Scenario Controller Image ---
echo "Step 15: Building Scenario Controller image..."
if [[ "$OS" == "Darwin" ]]; then
    colima --profile "$COLIMA_PROFILE" nerdctl -- build -t "$SCENARIO_CONTROLLER_IMAGE" \
        --namespace k8s.io "$REPO_DIR/scenario-controller" 2>&1 | tail -3
else
    # On Linux with k3s, use ctr to import
    if command -v nerdctl &>/dev/null; then
        nerdctl build -t "$SCENARIO_CONTROLLER_IMAGE" \
            --namespace k8s.io "$REPO_DIR/scenario-controller"
    else
        # Fallback: build with docker and import
        docker build -t "$SCENARIO_CONTROLLER_IMAGE" "$REPO_DIR/scenario-controller"
        import_docker_image_to_k3s "$SCENARIO_CONTROLLER_IMAGE"
    fi
fi
echo "  OK: Scenario controller image built"
echo ""

# --- Deploy Scenario Controller ---
echo "Step 16: Deploying Scenario Controller..."
kubectl apply -f "$REPO_DIR/manifests/applications/scenario-controller.yaml"
kubectl set image deployment/scenario-controller -n applications controller="$SCENARIO_CONTROLLER_IMAGE" >/dev/null
kubectl rollout restart deployment/scenario-controller -n applications >/dev/null
kubectl rollout status deployment/scenario-controller -n applications --timeout=180s
echo "  OK: Scenario controller run API deployed; the launcher starts incidents"
echo ""

echo "Step 17: Building the learning UI services..."
for component in learning-service lab-gateway lab-terminal; do
    case "$component" in
        learning-service) image="$LEARNING_SERVICE_IMAGE" ;;
        lab-gateway) image="$LAB_GATEWAY_IMAGE" ;;
        lab-terminal) image="$LAB_TERMINAL_IMAGE" ;;
    esac
    if [[ "$OS" == "Darwin" ]]; then
        colima --profile "$COLIMA_PROFILE" nerdctl -- build -f "$REPO_DIR/$component/Dockerfile" -t "$image" \
            --namespace k8s.io "$REPO_DIR"
    elif command -v nerdctl &>/dev/null; then
        nerdctl build -f "$REPO_DIR/$component/Dockerfile" -t "$image" \
            --namespace k8s.io "$REPO_DIR"
    else
        docker build -f "$REPO_DIR/$component/Dockerfile" -t "$image" "$REPO_DIR"
        import_docker_image_to_k3s "$image"
    fi
done

kubectl apply -f "$REPO_DIR/manifests/applications/learning-service.yaml"
kubectl set image deployment/learning-service -n applications learning-service="$LEARNING_SERVICE_IMAGE" >/dev/null
kubectl rollout status deployment/learning-service -n applications --timeout=180s
kubectl apply -f "$REPO_DIR/manifests/applications/lab-terminal.yaml"
kubectl set image deployment/lab-terminal -n applications terminal="$LAB_TERMINAL_IMAGE" >/dev/null
kubectl rollout status deployment/lab-terminal -n applications --timeout=180s
kubectl apply -f "$REPO_DIR/manifests/applications/lab-gateway.yaml"
kubectl set image deployment/lab-gateway -n applications gateway="$LAB_GATEWAY_IMAGE" >/dev/null
kubectl rollout status deployment/lab-gateway -n applications --timeout=180s
bash "$REPO_DIR/scripts/record-deploy-state.sh" "$IMAGE_TAG"
bash "$SCRIPT_DIR/host-port-forwards.sh" start traefik

# --- Done ---
echo "========================================"
echo "  GitOps Failure Lab - Ready!"
echo "========================================"
echo ""
echo "Access:"
echo "  Lab:        https://localhost:8443/"
echo "  ArgoCD:     https://localhost:8443/argocd"
echo "  Django:     https://localhost:8443/django/api/health/"
echo ""
echo "Credentials:"
echo "  ArgoCD:  learner / ${ARGOCD_ADMIN_PASSWORD} (launched sessions)"
echo "  ArgoCD:  admin / ${ARGOCD_ADMIN_PASSWORD} (manual access)"
echo ""
echo "SOPS Key: secrets/keys/local.key"
echo ""
echo "How it works:"
echo "  1. Open the launcher and choose a scenario, mode, and environment"
echo "  2. The controller resets to baseline and injects that scenario"
echo "  3. The coach guides console evidence checks and accepts a Gitea or terminal fix"
echo "  4. Verify Healthy and Synced in ArgoCD, then submit the incident note"
echo ""
echo "Fix scenarios by cloning the lab repo, editing, and pushing:"
echo "  git clone http://remotelab:remotelab@localhost:3000/remotelab/django-app.git"
echo "  # for SOPS-encrypted files: export SOPS_AGE_KEY_FILE=${REPO_DIR}/secrets/keys/local.key"
echo ""
echo "Useful commands:"
echo "  kubectl get applications -n argocd"
echo "  kubectl logs -n applications deployment/scenario-controller"
echo "  kubectl get pods -n applications"
echo ""
echo "Start here: https://localhost:8443/"
