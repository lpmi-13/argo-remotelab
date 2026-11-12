#!/usr/bin/env bash

readonly DEFAULT_FIRST_PARTY_IMAGE_TAG="v14"
readonly ROOTFS_IMAGE_REPO="ghcr.io/lpmi-13/argo-remotelab-k3s-rootfs"
readonly DEFAULT_IXIMIUZ_ROOTFS_IMAGE="ghcr.io/lpmi-13/argo-remotelab-k3s-rootfs:v14"
# This iximiuz base ships k3s v1.36.4+k3s1, matching LAB_K3S_VERSION's minor version.
readonly DEFAULT_IXIMIUZ_ROOTFS_RELEASE="0f076c61"

# New Colima profiles install this k3s release; Argo CD 3.5 is tested on Kubernetes 1.33-1.36.
readonly LAB_K3S_VERSION="v1.36.6+k3s1"

readonly DJANGO_IMAGE_REPO="ghcr.io/lpmi-13/argo-remotelab-django"
readonly SCENARIO_CONTROLLER_IMAGE_REPO="ghcr.io/lpmi-13/argo-remotelab-scenario-controller"
readonly LEARNING_SERVICE_IMAGE_REPO="ghcr.io/lpmi-13/argo-remotelab-learning-service"
readonly LAB_GATEWAY_IMAGE_REPO="ghcr.io/lpmi-13/argo-remotelab-lab-gateway"
readonly LAB_TERMINAL_IMAGE_REPO="ghcr.io/lpmi-13/argo-remotelab-lab-terminal"
readonly ARGOCD_TOOLS_IMAGE_REPO="ghcr.io/lpmi-13/argo-remotelab-argocd-tools"

readonly POSTGRES_IMAGE="public.ecr.aws/docker/library/postgres:18.6"
readonly GITEA_IMAGE="ghcr.io/go-gitea/gitea:28.0.0"
