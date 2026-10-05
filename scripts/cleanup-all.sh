#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/platform.sh"

show_help() {
    echo "Usage: ./cleanup-all.sh [OPTIONS]"
    echo ""
    echo "Clean up all resources created by deploy-all.sh from the K3s cluster."
    echo ""
    echo "Options:"
    echo "  --yes, -y         Skip confirmation prompt"
    echo "  --help, -h        Show this help message"
    echo "  COLIMA_PROFILE    Colima profile to clean on macOS (default: argo-remotelab)"
    echo ""
    exit 0
}

SKIP_CONFIRMATION=false
if [[ "$1" == "--help" ]] || [[ "$1" == "-h" ]]; then
    show_help
elif [[ "$1" == "--yes" ]] || [[ "$1" == "-y" ]]; then
    SKIP_CONFIRMATION=true
fi

force_delete_namespace() {
    local namespace=$1
    local max_wait=90
    local waited=0

    if ! kubectl get namespace "$namespace" &>/dev/null; then
        return 0
    fi

    echo "  Removing namespace: $namespace"

    # Remove all finalizers that could block deletion
    if [ "$namespace" = "argocd" ]; then
        kubectl get applications.argoproj.io -n argocd -o name 2>/dev/null | \
            xargs -I {} kubectl patch {} -n argocd -p '{"metadata":{"finalizers":null}}' --type=merge 2>/dev/null || true
    fi
    # Remove ArgoCD hook finalizers from Jobs (common blocker)
    kubectl get jobs -n "$namespace" -o name 2>/dev/null | \
        xargs -I {} kubectl patch {} -n "$namespace" -p '{"metadata":{"finalizers":null}}' --type=merge 2>/dev/null || true
    # Remove finalizers from any remaining resources
    for resource in deployments statefulsets services configmaps secrets pvc; do
        kubectl get "$resource" -n "$namespace" -o name 2>/dev/null | \
            xargs -I {} kubectl patch {} -n "$namespace" -p '{"metadata":{"finalizers":null}}' --type=merge 2>/dev/null || true
    done

    kubectl delete namespace "$namespace" --ignore-not-found=true --wait=false 2>/dev/null || true
    sleep 2

    while kubectl get namespace "$namespace" &>/dev/null; do
        if [ $waited -ge $max_wait ]; then
            echo "  WARNING: Namespace $namespace still exists after ${max_wait}s, forcing..."
            # Nuclear option: patch spec finalizers
            kubectl get namespace "$namespace" -o json 2>/dev/null | \
                python3 -c 'import sys,json; ns=json.load(sys.stdin); ns["spec"]["finalizers"]=[]; print(json.dumps(ns))' 2>/dev/null | \
                kubectl replace --raw "/api/v1/namespaces/$namespace/finalize" -f - 2>/dev/null || true
            sleep 5
            if kubectl get namespace "$namespace" &>/dev/null; then
                echo "  ERROR: Could not delete namespace $namespace"
                return 1
            fi
            break
        fi
        # Keep clearing finalizers while waiting
        kubectl get jobs -n "$namespace" -o name 2>/dev/null | \
            xargs -I {} kubectl patch {} -n "$namespace" -p '{"metadata":{"finalizers":null}}' --type=merge 2>/dev/null || true
        kubectl patch namespace "$namespace" -p '{"metadata":{"finalizers":null}}' --type=merge 2>/dev/null || true
        sleep 3
        waited=$((waited + 3))
    done

    echo "  OK: $namespace deleted"
    return 0
}

if [ "$SKIP_CONFIRMATION" = false ]; then
    echo "=== GitOps Failure Lab - Cleanup ==="
    echo ""
    echo "This will delete all lab namespaces (applications, shop-staging, argocd) and their data."
    read -p "Proceed? (yes/no): " -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy][Ee][Ss]$ ]]; then
        echo "Cancelled."
        exit 0
    fi
fi

echo "=== Starting Cleanup ==="
echo ""

# Switch context
switch_to_local_context || {
    echo "ERROR: cleanup requires a recognized local Kubernetes context" >&2
    exit 1
}
trap 'rm -f "${LAB_KUBECONFIG:-}"' EXIT

echo "Step 1: Deleting namespaces..."
force_delete_namespace "applications" || true
force_delete_namespace "shop-staging" || true
force_delete_namespace "argocd" || true
echo ""

echo "Step 2: Removing Traefik (if installed via Helm)..."
if helm list -n kube-system 2>/dev/null | grep -q "^traefik"; then
    helm uninstall traefik -n kube-system 2>/dev/null || true
    echo "  OK: Traefik uninstalled"
else
    echo "  OK: Traefik not managed by Helm"
fi
echo ""

echo "Step 3: Cleaning up cluster-scoped resources..."
# Remove ClusterRole and ClusterRoleBinding for scenario controller
kubectl delete clusterrole scenario-controller --ignore-not-found=true 2>/dev/null || true
kubectl delete clusterrole lab-terminal-workload --ignore-not-found=true 2>/dev/null || true
kubectl delete clusterrolebinding scenario-controller --ignore-not-found=true 2>/dev/null || true
# Remove ArgoCD cluster-scoped resources
kubectl delete clusterrole argocd-application-controller argocd-applicationset-controller argocd-server --ignore-not-found=true 2>/dev/null || true
kubectl delete clusterrolebinding argocd-application-controller argocd-applicationset-controller argocd-server --ignore-not-found=true 2>/dev/null || true
echo "  OK"
echo ""

echo "Step 4: Cleaning orphaned PVs..."
while read -r pv; do
    [ -n "$pv" ] && kubectl delete pv "$pv" --ignore-not-found=true 2>/dev/null || true
done < <(kubectl get pv -o json 2>/dev/null | python3 -c '
import json, sys
try:
    volumes = json.load(sys.stdin).get("items", [])
except (ValueError, OSError):
    volumes = []
for volume in volumes:
    claim = volume.get("spec", {}).get("claimRef", {})
    if claim.get("namespace") in {"applications", "shop-staging"}:
        print(volume["metadata"]["name"])
')
echo "  OK"
echo ""

echo "Step 5: Stopping the lab's host port-forwards..."
bash "$SCRIPT_DIR/host-port-forwards.sh" stop
echo "  OK"
echo ""

echo "========================================"
echo "  Cleanup Complete!"
echo "========================================"
echo ""
echo "To redeploy: ./scripts/deploy-all.sh"
echo ""
