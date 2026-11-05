#!/usr/bin/env bash

# A running Colima VM can lose outbound HTTPS while its Kubernetes API remains
# healthy. Check from inside the VM before any deployment can delete resources.
COLIMA_REFRESHED=false
COLIMA_REGISTRY_PROBE_URL="https://public.ecr.aws/v2/"

colima_registry_reachable() {
    local http_code
    http_code=$(colima ssh --profile "$1" -- curl -sS -o /dev/null -w '%{http_code}' \
        --connect-timeout 5 --max-time 10 "$COLIMA_REGISTRY_PROBE_URL" 2>/dev/null) || return 1
    [[ "$http_code" == 401 ]]
}

colima_registry_reachable_after_retry() {
    local attempt
    for ((attempt = 1; attempt <= 3; attempt++)); do
        if colima_registry_reachable "$1"; then
            return 0
        fi
        if ((attempt < 3)); then
            sleep 2
        fi
    done
    return 1
}

colima_host_registry_reachable_after_retry() {
    local attempt http_code
    for ((attempt = 1; attempt <= 3; attempt++)); do
        http_code=$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 5 \
            --max-time 10 "$COLIMA_REGISTRY_PROBE_URL" 2>/dev/null) || http_code=""
        if [[ "$http_code" == 401 ]]; then
            return 0
        fi
        if ((attempt < 3)); then
            sleep 2
        fi
    done
    return 1
}

colima_running_other_profiles() {
    local profiles rows name status
    profiles=$(env -u COLIMA_PROFILE colima list --json 2>/dev/null) || return 1
    rows=$(printf '%s' "$profiles" | python3 -c '
import json, sys
raw = sys.stdin.read().strip()
if not raw:
    raise SystemExit(0)
try:
    profiles = json.loads(raw)
except json.JSONDecodeError:
    profiles = [json.loads(line) for line in raw.splitlines() if line.strip()]
if isinstance(profiles, dict):
    profiles = [profiles]
if not isinstance(profiles, list):
    raise SystemExit("Unexpected JSON from colima list")
for profile in profiles:
    if isinstance(profile, dict) and profile.get("name") != sys.argv[1]:
        print("{}\t{}".format(profile.get("name", ""), profile.get("status", "")))
' "$1") || return 1
    while IFS=$'\t' read -r name status; do
        [[ -n "$name" ]] || continue
        if [[ "$status" == Running ]] ||
            { [[ "$status" == Broken ]] && colima status --profile "$name" >/dev/null 2>&1; }; then
            printf '%s\n' "$name"
        fi
    done <<< "$rows"
}

colima_default_docker() {
    docker --host "unix://${HOME}/.colima/default/docker.sock" "$@"
}

# Docker does not restart containers with restart=no or on-failure after its VM starts.
colima_running_no_restart_containers() {
    local running_ids container_id policy
    running_ids=$(colima_default_docker ps --filter status=running --format '{{.ID}}') || return 1
    while IFS= read -r container_id; do
        [[ -n "$container_id" ]] || continue
        policy=$(colima_default_docker inspect --format '{{.HostConfig.RestartPolicy.Name}}' "$container_id") || return 1
        if [[ "$policy" == no || "$policy" == on-failure ]]; then
            printf '%s\n' "$container_id"
        fi
    done <<< "$running_ids"
}

colima_wait_for_default_docker() {
    local attempt
    for ((attempt = 1; attempt <= 12; attempt++)); do
        if colima_default_docker info >/dev/null 2>&1; then
            return 0
        fi
        sleep 5
    done
    echo "  ERROR: Docker in the default Colima profile did not recover." >&2
    return 1
}

colima_restore_running_containers() {
    local containers="$1" container_id running failed=false
    while IFS= read -r container_id; do
        [[ -n "$container_id" ]] || continue
        if ! running=$(colima_default_docker inspect --format '{{.State.Running}}' "$container_id"); then
            echo "  ERROR: Could not inspect previously running container $container_id." >&2
            failed=true
        elif [[ "$running" != true ]] && ! colima_default_docker start "$container_id" >/dev/null; then
            echo "  ERROR: Could not restore previously running container $container_id." >&2
            failed=true
        fi
    done <<< "$containers"
    [[ "$failed" == false ]]
}

colima_start_if_stopped() {
    if colima status --profile "$1" >/dev/null 2>&1; then
        return 0
    fi
    colima start --profile "$1" --activate=false
}

colima_restart_shared_network() {
    local profile="$1" containers operation_failed=false

    if ! containers=$(colima_running_no_restart_containers); then
        echo "  ERROR: Could not record running containers in the default Colima profile; leaving both profiles running." >&2
        return 2
    fi

    echo "  Both Colima profiles cannot reach public.ecr.aws; restarting their shared Lima network..."
    # shellcheck disable=SC2034 # Read by deploy-warm.sh after sourcing this file.
    COLIMA_REFRESHED=true
    if ! colima stop --profile "$profile"; then
        operation_failed=true
    elif ! colima stop --profile default; then
        operation_failed=true
    elif ! colima start --profile default --activate=false; then
        operation_failed=true
    elif ! colima start --profile "$profile" --activate=false; then
        operation_failed=true
    fi

    if [[ "$operation_failed" == true ]]; then
        echo "  ERROR: Shared Colima restart failed; attempting to start both profiles again." >&2
        colima_start_if_stopped default || echo "  ERROR: Could not restart default Colima profile." >&2
        colima_start_if_stopped "$profile" || echo "  ERROR: Could not restart $profile Colima profile." >&2
    fi

    if colima status --profile default >/dev/null 2>&1; then
        if colima_wait_for_default_docker; then
            colima_restore_running_containers "$containers" || operation_failed=true
        else
            operation_failed=true
        fi
    else
        echo "  ERROR: Default Colima profile is still stopped; its containers could not be restored." >&2
        operation_failed=true
    fi
    [[ "$operation_failed" == false ]] || return 2
}

colima_wait_for_kubernetes() {
    local context attempt
    context=$(detect_local_context)
    for ((attempt = 1; attempt <= 24; attempt++)); do
        if kubectl --context "$context" cluster-info >/dev/null 2>&1; then
            return 0
        fi
        sleep 5
    done
    echo "  ERROR: Kubernetes in Colima profile $1 did not recover after restart." >&2
    return 2
}

colima_wait_for_registry() {
    local attempt profile reachable
    for ((attempt = 1; attempt <= 12; attempt++)); do
        reachable=true
        for profile in "$@"; do
            if ! colima_registry_reachable "$profile"; then
                reachable=false
            fi
        done
        if [[ "$reachable" == true ]]; then
            echo "  OK: Colima registry access recovered"
            return 0
        fi
        if ((attempt < 12)); then
            sleep 5
        fi
    done
    echo "  ERROR: Colima still cannot reach public.ecr.aws after restart." >&2
    for profile in "$@"; do
        if ! colima_registry_reachable "$profile"; then
            echo "         Probe from $profile:" >&2
            colima ssh --profile "$profile" -- curl -sS -o /dev/null \
                -w 'HTTP %{http_code}; remote IP %{remote_ip}\n' --connect-timeout 5 \
                --max-time 10 "$COLIMA_REGISTRY_PROBE_URL" >&2 || true
        fi
    done
    return 2
}

ensure_colima_registry_access() {
    local profile="$1" restart_output other_profile other_profiles failed_other_profiles=""

    if colima_registry_reachable_after_retry "$profile"; then
        return 0
    fi
    if ! colima_host_registry_reachable_after_retry; then
        echo "  ERROR: The Mac cannot reach public.ecr.aws; restarting Colima cannot repair the host connection." >&2
        curl -sS -o /dev/null -w '         Host probe: HTTP %{http_code}; remote IP %{remote_ip}\n' \
            --connect-timeout 5 --max-time 10 "$COLIMA_REGISTRY_PROBE_URL" >&2 || true
        return 2
    fi

    if ! other_profiles=$(colima_running_other_profiles "$profile"); then
        echo "  ERROR: Could not list Colima profiles to check the shared network." >&2
        return 2
    fi
    while IFS= read -r other_profile; do
        [[ -n "$other_profile" ]] || continue
        if ! colima_registry_reachable_after_retry "$other_profile"; then
            failed_other_profiles="${failed_other_profiles}${other_profile} "
        fi
    done <<< "$other_profiles"

    # A host or VPN transition can complete while the other VM is probed.
    # Recheck immediately before disturbing either profile.
    if colima_registry_reachable "$profile"; then
        return 0
    fi
    if [[ "$failed_other_profiles" == 'default ' ]] && colima_registry_reachable default; then
        failed_other_profiles=""
    fi
    if [[ -n "$failed_other_profiles" ]]; then
        if [[ "$profile" == argo-remotelab && "$other_profiles" == default &&
              "$failed_other_profiles" == 'default ' ]]; then
            colima_restart_shared_network "$profile" || return 2
            colima_wait_for_kubernetes "$profile" || return 2
            colima_wait_for_registry "$profile" default
            return $?
        fi
        echo "  ERROR: Other Colima profiles also cannot reach public.ecr.aws: ${failed_other_profiles% }." >&2
        echo "         Automatic shared-network recovery requires only the default and argo-remotelab profiles to be running." >&2
        return 2
    fi

    echo "  Colima profile $profile cannot reach public.ecr.aws; restarting it..."
    if ! restart_output=$(colima restart --profile "$profile" 2>&1); then
        echo "  ERROR: Could not restart Colima profile $profile." >&2
        printf '%s\n' "$restart_output" | tail -n 15 >&2
        colima_start_if_stopped "$profile" || echo "  ERROR: Could not start Colima profile $profile after the failed restart." >&2
        return 2
    fi
    # shellcheck disable=SC2034 # Read by deploy-warm.sh after sourcing this file.
    COLIMA_REFRESHED=true

    colima_wait_for_kubernetes "$profile" || return 2
    colima_wait_for_registry "$profile"
}
