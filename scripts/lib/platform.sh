#!/bin/bash
# Platform detection and cross-platform utilities

detect_platform() {
    case "$(uname -s)" in
        Darwin*)  echo "macos" ;;
        Linux*)   echo "linux" ;;
        *)        echo "unknown" ;;
    esac
}

PLATFORM=$(detect_platform)

get_node_ip() {
    if [[ "$PLATFORM" == "macos" ]]; then
        ipconfig getifaddr en0 2>/dev/null || echo "127.0.0.1"
    else
        ip route get 1 2>/dev/null | awk '{print $7; exit}' || echo "127.0.0.1"
    fi
}

get_ram_gb() {
    if [[ "$PLATFORM" == "macos" ]]; then
        local bytes=$(sysctl -n hw.memsize 2>/dev/null)
        echo $((bytes / 1024 / 1024 / 1024))
    else
        free -g 2>/dev/null | awk '/^Mem:/{print $2}'
    fi
}

get_disk_space_gb() {
    if [[ "$PLATFORM" == "macos" ]]; then
        df -g / 2>/dev/null | awk 'NR==2{print $4}'
    else
        df / | awk 'NR==2{print int($4/1024/1024)}'
    fi
}

is_colima() {
    [[ "$PLATFORM" == "macos" ]] && command -v colima &>/dev/null && colima status &>/dev/null
}

detect_local_context() {
    if [[ "$PLATFORM" == "macos" ]]; then
        local profile="${COLIMA_PROFILE:-argo-remotelab}"
        if [[ "$profile" == "default" ]]; then
            echo "colima"
        else
            echo "colima-${profile}"
        fi
    else
        echo "default"
    fi
}

check_kubernetes_available() {
    kubectl cluster-info &>/dev/null 2>&1
}

switch_to_local_context() {
    local target_context
    target_context=$(detect_local_context)
    if ! kubectl config get-contexts "$target_context" -o name 2>/dev/null | grep -Fxq "$target_context"; then
        error "Local Kubernetes context ${target_context} is missing"
        return 1
    fi

    # A minified kubeconfig keeps every command in this script, including Helm,
    # on the selected lab cluster without changing the user's active context.
    local lab_kubeconfig
    lab_kubeconfig=$(mktemp "${TMPDIR:-/tmp}/argo-remotelab-kubeconfig.XXXXXX") || return 1
    chmod 600 "$lab_kubeconfig"
    if ! kubectl config view --raw --flatten --minify --context="$target_context" > "$lab_kubeconfig"; then
        rm -f "$lab_kubeconfig"
        error "Could not isolate context ${target_context}"
        return 1
    fi
    LAB_ORIGINAL_KUBECONFIG="${KUBECONFIG:-}"
    export LAB_ORIGINAL_KUBECONFIG
    export KUBECONFIG="$lab_kubeconfig"
    LAB_KUBECONFIG="$lab_kubeconfig"
    if ! kubectl cluster-info >/dev/null 2>&1; then
        rm -f "$lab_kubeconfig"
        error "Local Kubernetes context ${target_context} is unreachable"
        return 1
    fi
    log "Using isolated Kubernetes context ${target_context}"
}

log() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Colors for output (needed for log functions)
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color
