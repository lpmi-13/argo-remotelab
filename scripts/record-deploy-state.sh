#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
image_tag="${1:?pass the first-party image tag}"
hash_script="${repo_root}/scripts/lib/image-source-hash.py"

kubectl -n argocd create configmap remotelab-deploy-state \
  --from-literal="image_tag=${image_tag}" \
  --from-literal="repository_hash=$(python3 "${hash_script}" repository)" \
  --from-literal="dependencies_hash=$(python3 "${hash_script}" dependencies)" \
  --from-literal="sample_django_app=$(python3 "${hash_script}" sample-django-app)" \
  --from-literal="scenario_controller=$(python3 "${hash_script}" scenario-controller)" \
  --from-literal="learning_service=$(python3 "${hash_script}" learning-service)" \
  --from-literal="lab_gateway=$(python3 "${hash_script}" lab-gateway)" \
  --from-literal="lab_terminal=$(python3 "${hash_script}" lab-terminal)" \
  --dry-run=client -o yaml | kubectl apply -f -
