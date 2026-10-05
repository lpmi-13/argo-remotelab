#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${script_dir}/lib/platform.sh"

action="${1:-}"
service="${2:-}"
if [[ "${LAB_ORIGINAL_KUBECONFIG+x}" ]]; then
  original_kubeconfig="$LAB_ORIGINAL_KUBECONFIG"
else
  original_kubeconfig="${KUBECONFIG:-}"
fi
if [[ "$PLATFORM" == macos ]]; then
  context="$(detect_local_context)"
  [[ "$context" =~ ^[a-z0-9-]+$ ]] || { echo "Invalid lab context: $context" >&2; exit 2; }
  file_suffix="$context"
else
  if [[ -n "$original_kubeconfig" ]]; then
    context="$(KUBECONFIG="$original_kubeconfig" kubectl config current-context)"
  else
    context="$(env -u KUBECONFIG kubectl config current-context)"
  fi
  file_suffix=linux
fi

configure_service() {
  case "$1" in
    gitea)
      namespace=applications
      resource=gitea
      local_port=3000
      remote_port=3000
      ;;
    traefik)
      namespace=kube-system
      resource=traefik
      local_port=8443
      remote_port=443
      ;;
    *) echo "Unknown port-forward service: $1" >&2; exit 2 ;;
  esac
  pid_file="/tmp/argo-remotelab-${file_suffix}-${resource}-pf.pid"
  log_file="/tmp/argo-remotelab-${file_suffix}-${resource}-pf.log"
  label="com.lpmi13.argo-remotelab.${file_suffix}.${resource}"
}

matches_forward() {
  local pid="$1" command_line
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  command_line="$(ps -p "$pid" -o args= 2>/dev/null)" || return 1
  [[ "$command_line" == *"kubectl --context $context"* &&
     "$command_line" == *"port-forward"* &&
     "$command_line" == *"svc/$resource $local_port:$remote_port"* ]]
}

forward_ready() {
  if [[ "$resource" == traefik ]]; then
    curl -kfsS --max-time 3 "https://127.0.0.1:$local_port/launcher/" >/dev/null 2>&1
  else
    curl -fsS --max-time 3 "http://127.0.0.1:$local_port/api/healthz" >/dev/null 2>&1
  fi
}

launch_job_pid() {
  launchctl list "$label" 2>/dev/null | sed -n 's/.*"PID" = \([0-9][0-9]*\);/\1/p'
}

owns_listener() {
  local wanted_pid="$1" listener listeners
  command -v lsof >/dev/null 2>&1 || return 0
  listeners="$(lsof -nP -t -iTCP:"$local_port" -sTCP:LISTEN 2>/dev/null || true)"
  for listener in $listeners; do
    [[ "$listener" == "$wanted_pid" ]] && return 0
  done
  return 1
}

stop_legacy_gitea() {
  local legacy_file=/tmp/argo-remotelab-gitea-pf.pid pid command_line
  [[ -f "$legacy_file" ]] || return 0
  pid="$(cat "$legacy_file")"
  if [[ "$pid" =~ ^[0-9]+$ ]]; then
    command_line="$(ps -p "$pid" -o args= 2>/dev/null || true)"
    if [[ "$command_line" == *'kubectl port-forward svc/gitea -n applications 3000:3000'* ]]; then
      kill "$pid" 2>/dev/null || true
    fi
  fi
  rm -f "$legacy_file"
}

stop_one() {
  local pid
  configure_service "$1"
  if [[ "$PLATFORM" == macos ]]; then
    launchctl remove "$label" >/dev/null 2>&1 || true
  fi
  if [[ -f "$pid_file" ]]; then
    pid="$(cat "$pid_file")"
    if matches_forward "$pid"; then
      kill "$pid" 2>/dev/null || true
    fi
    rm -f "$pid_file"
  fi
  if [[ "$resource" == gitea ]]; then
    stop_legacy_gitea
  fi
}

start_one() {
  local pid listeners listener attempt kubectl_path
  configure_service "$1"
  if [[ "$resource" == gitea ]]; then
    stop_legacy_gitea
  fi
  if [[ "$PLATFORM" == macos ]]; then
    pid="$(launch_job_pid || true)"
    if [[ -n "$pid" ]] && owns_listener "$pid" && forward_ready; then
      echo "  Reusing $resource port-forward on localhost:$local_port"
      return 0
    fi
    launchctl remove "$label" >/dev/null 2>&1 || true
  fi
  if [[ -f "$pid_file" ]]; then
    pid="$(cat "$pid_file")"
    if matches_forward "$pid"; then
      if forward_ready; then
        echo "  Reusing $resource port-forward on localhost:$local_port"
        return 0
      fi
      kill "$pid" 2>/dev/null || true
    fi
    rm -f "$pid_file"
  fi

  # Adopt a matching forward started manually with the selected lab context.
  if command -v lsof >/dev/null 2>&1; then
    listeners="$(lsof -nP -t -iTCP:"$local_port" -sTCP:LISTEN 2>/dev/null || true)"
    for listener in $listeners; do
      if matches_forward "$listener" && forward_ready; then
        printf '%s\n' "$listener" > "$pid_file"
        echo "  Reusing $resource port-forward on localhost:$local_port"
        return 0
      fi
    done
  fi

  : > "$log_file"
  if [[ "$PLATFORM" == macos ]]; then
    kubectl_path="$(command -v kubectl)"
    if [[ -n "$original_kubeconfig" ]]; then
      launchctl submit -l "$label" -o "$log_file" -e "$log_file" -- \
        /usr/bin/env "KUBECONFIG=$original_kubeconfig" "$kubectl_path" \
        --context "$context" -n "$namespace" port-forward --address 127.0.0.1 \
        "svc/$resource" "$local_port:$remote_port"
    else
      launchctl submit -l "$label" -o "$log_file" -e "$log_file" -- \
        /usr/bin/env -u KUBECONFIG "$kubectl_path" \
        --context "$context" -n "$namespace" port-forward --address 127.0.0.1 \
        "svc/$resource" "$local_port:$remote_port"
    fi
    for ((attempt = 0; attempt < 30; attempt++)); do
      pid="$(launch_job_pid || true)"
      if [[ -n "$pid" ]] && owns_listener "$pid" && forward_ready; then
        echo "  Started $resource port-forward on localhost:$local_port"
        return 0
      fi
      sleep 1
    done
    launchctl remove "$label" >/dev/null 2>&1 || true
  else
    if [[ -n "$original_kubeconfig" ]]; then
      nohup env "KUBECONFIG=$original_kubeconfig" \
        kubectl --context "$context" -n "$namespace" port-forward --address 127.0.0.1 \
        "svc/$resource" "$local_port:$remote_port" > "$log_file" 2>&1 < /dev/null &
    else
      nohup env -u KUBECONFIG \
        kubectl --context "$context" -n "$namespace" port-forward --address 127.0.0.1 \
        "svc/$resource" "$local_port:$remote_port" > "$log_file" 2>&1 < /dev/null &
    fi
    pid=$!
    disown "$pid" 2>/dev/null || true
    printf '%s\n' "$pid" > "$pid_file"
    for ((attempt = 0; attempt < 30; attempt++)); do
      if kill -0 "$pid" 2>/dev/null && owns_listener "$pid" && forward_ready; then
        echo "  Started $resource port-forward on localhost:$local_port"
        return 0
      fi
      if ! kill -0 "$pid" 2>/dev/null; then
        break
      fi
      sleep 1
    done
    if matches_forward "$pid"; then
      kill "$pid" 2>/dev/null || true
    fi
    rm -f "$pid_file"
  fi
  echo "Could not start $resource port-forward on localhost:$local_port" >&2
  sed -n '1,30p' "$log_file" >&2
  exit 1
}

case "$action" in
  start)
    [[ -n "$service" && $# -eq 2 ]] || { echo "usage: host-port-forwards.sh start {gitea|traefik}" >&2; exit 2; }
    start_one "$service"
    ;;
  stop)
    [[ $# -eq 1 ]] || { echo "usage: host-port-forwards.sh stop" >&2; exit 2; }
    stop_one gitea
    stop_one traefik
    ;;
  *) echo "usage: host-port-forwards.sh {start SERVICE|stop}" >&2; exit 2 ;;
esac
