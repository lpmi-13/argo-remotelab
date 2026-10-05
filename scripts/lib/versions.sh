#!/usr/bin/env bash

readonly DEFAULT_FIRST_PARTY_IMAGE_TAG="v7"
readonly ROOTFS_IMAGE_REPO="ghcr.io/lpmi-13/argo-remotelab-k3s-rootfs"
readonly DEFAULT_IXIMIUZ_ROOTFS_IMAGE="ghcr.io/lpmi-13/argo-remotelab-k3s-rootfs:v7"
readonly DEFAULT_IXIMIUZ_ROOTFS_RELEASE="b3903e8c.1"

readonly DJANGO_IMAGE_REPO="ghcr.io/lpmi-13/argo-remotelab-django"
readonly SCENARIO_CONTROLLER_IMAGE_REPO="ghcr.io/lpmi-13/argo-remotelab-scenario-controller"
readonly LEARNING_SERVICE_IMAGE_REPO="ghcr.io/lpmi-13/argo-remotelab-learning-service"
readonly LAB_GATEWAY_IMAGE_REPO="ghcr.io/lpmi-13/argo-remotelab-lab-gateway"
readonly LAB_TERMINAL_IMAGE_REPO="ghcr.io/lpmi-13/argo-remotelab-lab-terminal"
readonly ARGOCD_TOOLS_IMAGE_REPO="ghcr.io/lpmi-13/argo-remotelab-argocd-tools"

readonly POSTGRES_IMAGE="postgres:18.6"
readonly GITEA_IMAGE="gitea/gitea:28.0.0"
readonly GITEA_ADMIN_IMAGE="${GITEA_IMAGE}"
readonly BUSYBOX_IMAGE="busybox:1.37.0"
readonly ALPINE_IMAGE="alpine:3.24.2"
readonly CURL_IMAGE="curlimages/curl:8.22.0"
