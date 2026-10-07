#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != Linux ]]; then
    echo "ERROR: manual-refresh.sh is only for a local Linux k3s cluster" >&2
    exit 1
fi
if (( $# != 0 )); then
    echo "Usage: ./scripts/manual-refresh.sh" >&2
    exit 2
fi

config_file="${KUBECONFIG:-${HOME}/.kube/config}"
if [[ "$config_file" == *:* || ! -f "$config_file" || -L "$config_file" ]]; then
    echo "ERROR: Expected a single, regular kubeconfig file at $config_file" >&2
    exit 1
fi

contexts=$(KUBECONFIG="$config_file" kubectl config get-contexts -o name)
server=$(KUBECONFIG="$config_file" kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')
if [[ "$contexts" != default || "$server" != https://127.0.0.1:6443 ]]; then
    echo "ERROR: This kubeconfig is not the single local k3s default context; refusing to replace it" >&2
    exit 1
fi

temp_file=$(mktemp "${config_file}.refresh.XXXXXXXX")
trap 'rm -f "$temp_file"' EXIT
sudo cat /etc/rancher/k3s/k3s.yaml > "$temp_file"
chmod 600 "$temp_file"
KUBECONFIG="$temp_file" kubectl cluster-info >/dev/null

backup_file="${config_file}.bak.$(date +%Y%m%d%H%M%S).$$"
install -m 600 "$config_file" "$backup_file"
mv -f "$temp_file" "$config_file"

if ! kubectl cluster-info; then
    echo "ERROR: Refreshed kubeconfig did not connect. Previous config: $backup_file" >&2
    exit 1
fi
echo "Refreshed $config_file (backup: $backup_file)"
