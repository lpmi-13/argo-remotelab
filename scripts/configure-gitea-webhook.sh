#!/usr/bin/env bash
set -euo pipefail

gitea_url="${1:?pass the reachable Gitea base URL}"
webhook_url="${2:-http://learning-service.applications.svc.cluster.local:8091/api/webhooks/gitea}"
secret="${GITEA_WEBHOOK_SECRET:-remotelab-local-webhook}"

payload="$(jq -n --arg url "$webhook_url" --arg secret "$secret" '{
  type: "gitea",
  active: true,
  events: ["push"],
  config: {url: $url, content_type: "json", secret: $secret}
}')"

curl -fsS -u remotelab:remotelab \
  -H 'Content-Type: application/json' \
  -X POST \
  --data "$payload" \
  "${gitea_url%/}/api/v1/repos/remotelab/django-app/hooks" >/dev/null

argo_payload="$(jq -n '{
  type: "gitea",
  active: true,
  events: ["push"],
  config: {url: "http://argocd-server.argocd.svc.cluster.local:80/argocd/api/webhook", content_type: "json"}
}')"
curl -fsS -u remotelab:remotelab \
  -H 'Content-Type: application/json' \
  -X POST \
  --data "$argo_payload" \
  "${gitea_url%/}/api/v1/repos/remotelab/django-app/hooks" >/dev/null
