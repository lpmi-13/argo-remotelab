# syntax=docker/dockerfile:1
ARG ROOTFS_RELEASE=e015d4ac.1

FROM ghcr.io/iximiuz/labs/rootfs:ubuntu-k3s-server-${ROOTFS_RELEASE}

ARG TARGETARCH
ARG SOPS_VERSION=3.13.0
ARG AGE_VERSION=1.1.1

USER root
ENV HOME=/root

COPY argocd-apps /opt/argo-remotelab/argocd-apps
COPY manifests /opt/argo-remotelab/manifests
COPY playground/iximiuz /opt/argo-remotelab/playground/iximiuz
COPY sample-django-app/chart /opt/argo-remotelab/sample-django-app/chart
COPY sample-django-app/platform /opt/argo-remotelab/sample-django-app/platform
COPY scripts /opt/argo-remotelab/scripts
COPY playground/iximiuz/image/bootstrap-gitops-lab.sh /opt/iximiuz-labs/bootstrap-gitops-lab.sh
COPY playground/iximiuz/image/gitops-lab-bootstrap.service /etc/systemd/system/gitops-lab-bootstrap.service

RUN <<'EOF'
set -eu

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  ca-certificates \
  curl \
  git \
  jq \
  tar
rm -rf /var/lib/apt/lists/*

case "${TARGETARCH:-$(dpkg --print-architecture)}" in
  amd64|x86_64) arch="amd64" ;;
  arm64|aarch64) arch="arm64" ;;
  *) echo "unsupported architecture: ${TARGETARCH:-$(dpkg --print-architecture)}" >&2; exit 1 ;;
esac

curl -fsSL -o /usr/local/bin/sops \
  "https://github.com/getsops/sops/releases/download/v${SOPS_VERSION}/sops-v${SOPS_VERSION}.linux.${arch}"
chmod 755 /usr/local/bin/sops

age_tmp="$(mktemp -d)"
curl -fsSL "https://github.com/FiloSottile/age/releases/download/v${AGE_VERSION}/age-v${AGE_VERSION}-linux-${arch}.tar.gz" \
  | tar xz -C "${age_tmp}" --strip-components=1
install -m 0755 "${age_tmp}/age" /usr/local/bin/age
install -m 0755 "${age_tmp}/age-keygen" /usr/local/bin/age-keygen
rm -rf "${age_tmp}"

mkdir -p /var/lib/argo-remotelab /opt/argo-remotelab/secrets/keys

chmod 755 /opt/iximiuz-labs/bootstrap-gitops-lab.sh
chmod 755 /opt/argo-remotelab/scripts/deploy-preloaded-vm.sh
chmod 755 /opt/argo-remotelab/scripts/wait-first-scenario-ready.sh

for cmd in bash kubectl k3s jq git curl sops age-keygen; do
  command -v "${cmd}" >/dev/null 2>&1 || {
    echo "missing expected tool: ${cmd}" >&2
    exit 1
  }
done

ln -sf /etc/systemd/system/gitops-lab-bootstrap.service \
  /etc/systemd/system/multi-user.target.wants/gitops-lab-bootstrap.service
EOF

USER laborant
ENV HOME=/home/laborant
