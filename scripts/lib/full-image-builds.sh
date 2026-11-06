#!/usr/bin/env bash
# Functions sourced by deploy-all.sh after the local Kubernetes context is ready.

k3s_nerdctl() {
    local nerdctl_bin
    nerdctl_bin=$(command -v nerdctl) || return 127
    if [[ $(id -u) -eq 0 || ( -r /run/k3s/containerd/containerd.sock && -w /run/k3s/containerd/containerd.sock ) ]]; then
        "$nerdctl_bin" --address /run/k3s/containerd/containerd.sock --namespace k8s.io "$@"
    else
        sudo -n "$nerdctl_bin" --address /run/k3s/containerd/containerd.sock --namespace k8s.io "$@"
    fi
}

full_image_present() {
    local image="$1"

    if [[ "$PLATFORM" == macos ]]; then
        colima --profile "$COLIMA_PROFILE" nerdctl -- image inspect --namespace k8s.io "$image" >/dev/null 2>&1
    elif command -v nerdctl >/dev/null 2>&1; then
        k3s_nerdctl image inspect "$image" >/dev/null 2>&1
    else
        docker image inspect "$image" >/dev/null 2>&1 || return 1
        if [[ $(id -u) -eq 0 ]]; then
            k3s ctr --namespace k8s.io images ls -q | grep -Fx "$image" >/dev/null
        else
            sudo -n k3s ctr --namespace k8s.io images ls -q | grep -Fx "$image" >/dev/null
        fi
    fi
}

build_full_image() {
    local component="$1" image="$2" context dockerfile
    if [[ "$component" == scenario-controller || "$component" == sample-django-app ]]; then
        context="$REPO_DIR/$component"
    else
        context="$REPO_DIR"
    fi
    dockerfile="$REPO_DIR/$component/Dockerfile"

    if [[ "$PLATFORM" == macos ]]; then
        colima --profile "$COLIMA_PROFILE" nerdctl -- build --namespace k8s.io \
            -f "$dockerfile" -t "$image" "$context"
    elif command -v nerdctl >/dev/null 2>&1; then
        k3s_nerdctl build -f "$dockerfile" -t "$image" "$context"
    else
        docker build -f "$dockerfile" -t "$image" "$context" || return 1
        if [[ $(id -u) -eq 0 ]]; then
            docker save "$image" | k3s ctr --namespace k8s.io images import -
        else
            docker save "$image" | sudo -n k3s ctr --namespace k8s.io images import -
        fi
    fi
}

prepare_full_images() {
    local hash_script="$SCRIPT_DIR/lib/image-source-hash.py"
    local recorded_tag component image key source_hash recorded_hash
    local index batch failure=0
    local -a components=(sample-django-app scenario-controller learning-service lab-gateway lab-terminal)
    local -a images=("$DJANGO_IMAGE" "$SCENARIO_CONTROLLER_IMAGE" "$LEARNING_SERVICE_IMAGE" "$LAB_GATEWAY_IMAGE" "$LAB_TERMINAL_IMAGE")
    local -a pending_components=() pending_images=() pids=() names=()

    # Image inspection may need the same k3s socket access as an image import.
    if [[ "$PLATFORM" == linux && $(id -u) -ne 0 ]]; then
        sudo -v || return 1
    fi
    recorded_tag=$(kubectl -n argocd get configmap remotelab-deploy-state \
        -o jsonpath='{.data.image_tag}' 2>/dev/null || true)
    for ((index=0; index<${#components[@]}; index++)); do
        component=${components[index]}
        image=${images[index]}
        key=${component//-/_}
        source_hash=$(python3 "$hash_script" "$component")
        recorded_hash=$(kubectl -n argocd get configmap remotelab-deploy-state \
            -o "jsonpath={.data.$key}" 2>/dev/null || true)
        if [[ "$recorded_tag" == "$IMAGE_TAG" && "$recorded_hash" == "$source_hash" ]] && \
            full_image_present "$image"; then
            echo "  Reusing $component image"
        else
            pending_components+=("$component")
            pending_images+=("$image")
        fi
    done

    if ((${#pending_components[@]} == 0)); then
        return 0
    fi
    for ((batch=0; batch<${#pending_components[@]}; batch+=2)); do
        pids=()
        names=()
        for ((index=batch; index<batch+2 && index<${#pending_components[@]}; index++)); do
            component=${pending_components[index]}
            image=${pending_images[index]}
            echo "  Building $component ($image)..."
            names+=("$component")
            (build_full_image "$component" "$image" 2>&1 | while IFS= read -r line || [[ -n "$line" ]]; do
                printf '[%s] %s\n' "$component" "$line"
            done) &
            pids+=("$!")
        done
        for ((index=0; index<${#pids[@]}; index++)); do
            if wait "${pids[index]}"; then
                echo "  OK: ${names[index]} image ready"
            else
                echo "  ERROR: ${names[index]} image build failed" >&2
                failure=1
            fi
        done
        if ((failure)); then
            break
        fi
    done
    return "$failure"
}
