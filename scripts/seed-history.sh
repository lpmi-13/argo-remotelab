#!/usr/bin/env bash
set -euo pipefail

gitea_url="${1:?pass the reachable Gitea base URL}"
mode="${2:-}"
if [[ -n "${mode}" && "${mode}" != "--wait-only" ]]; then
  echo "usage: seed-history.sh GITEA_URL [--wait-only]" >&2
  exit 2
fi
repo_url="${gitea_url%/}/remotelab/django-app.git"
case "$repo_url" in
  http://*) repo_url="http://remotelab:remotelab@${repo_url#http://}" ;;
  https://*) repo_url="https://remotelab:remotelab@${repo_url#https://}" ;;
  *) echo "Gitea URL must use HTTP or HTTPS" >&2; exit 1 ;;
esac
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

git clone -q "$repo_url" "$work_dir"
git -C "$work_dir" config user.email baseline@remotelab.local
git -C "$work_dir" config user.name "Release Manager"

apps=(shop-web-prod shop-web-staging platform-config release-policy ingress-config)

wait_for_revision() {
  local wanted="$1" app current health sync
  for app in "${apps[@]}"; do
    local deadline=$((SECONDS + 300))
    while (( SECONDS < deadline )); do
      current="$(kubectl -n argocd get application "$app" -o jsonpath='{.status.sync.revision}' 2>/dev/null || true)"
      health="$(kubectl -n argocd get application "$app" -o jsonpath='{.status.health.status}' 2>/dev/null || true)"
      sync="$(kubectl -n argocd get application "$app" -o jsonpath='{.status.sync.status}' 2>/dev/null || true)"
      if [[ "$current" == "$wanted" && "$health" == Healthy && "$sync" == Synced ]]; then
        break
      fi
      sleep 3
    done
    if [[ "$current" != "$wanted" || "$health" != Healthy || "$sync" != Synced ]]; then
      echo "baseline history did not sync for $app (revision=$current health=$health sync=$sync)" >&2
      exit 1
    fi
  done
}

current="$(git -C "$work_dir" rev-parse HEAD)"
for app in "${apps[@]}"; do
  kubectl -n argocd annotate application "$app" argocd.argoproj.io/refresh=hard --overwrite >/dev/null
done
wait_for_revision "$current"
if [[ "${mode}" == "--wait-only" ]]; then
  echo "  OK: All lab Applications are Healthy and Synced at ${current:0:10}"
  exit 0
fi

for number in 1 2; do
  for chart in django-app django-app-staging; do
    file="$work_dir/chart/$chart/values.yaml"
    sed -E -i.bak "s/MAX_CONNECTIONS: \"[0-9]+\"/MAX_CONNECTIONS: \"$((100 + number))\"/" "$file"
    rm -f "$file.bak"
  done
  for file in "$work_dir"/platform/*/configmap.yaml; do
    if grep -q 'baseline-revision:' "$file"; then
      sed -E -i.bak "s/baseline-revision: \"[0-9]+\"/baseline-revision: \"${number}\"/" "$file"
      rm -f "$file.bak"
    else
      printf '  baseline-revision: "%s"\n' "$number" >> "$file"
    fi
  done
  git -C "$work_dir" add chart platform
  git -C "$work_dir" commit -q -m "chore: baseline release $number"
  git -C "$work_dir" push -q origin main
  current="$(git -C "$work_dir" rev-parse HEAD)"
  for app in "${apps[@]}"; do
    kubectl -n argocd annotate application "$app" argocd.argoproj.io/refresh=hard --overwrite >/dev/null
  done
  wait_for_revision "$current"
done

git -C "$work_dir" tag -f baseline
git -C "$work_dir" push -q --force origin baseline
