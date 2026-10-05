#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
gitea_url="${1:?pass the reachable Gitea base URL}"
age_public_key="${2:?pass the age public key}"
repo_api="${gitea_url%/}/api/v1/repos/remotelab/django-app"
repo_url="${gitea_url%/}/remotelab/django-app.git"
case "${repo_url}" in
  http://*) repo_url="http://remotelab:remotelab@${repo_url#http://}" ;;
  https://*) repo_url="https://remotelab:remotelab@${repo_url#https://}" ;;
  *) echo "Gitea URL must use HTTP or HTTPS" >&2; exit 1 ;;
esac

repo_status() {
  curl -sS -o /dev/null -w '%{http_code}' -u remotelab:remotelab "${repo_api}" || true
}

wait_for_repo_status() {
  local wanted="$1" actual
  for _ in $(seq 1 20); do
    actual="$(repo_status)"
    if [[ "${actual}" == "${wanted}" ]]; then
      return 0
    fi
    sleep 1
  done
  echo "Gitea repository status stayed at ${actual:-unknown}; expected ${wanted}" >&2
  return 1
}

status="$(repo_status)"
if [[ "${status}" != 200 && "${status}" != 404 ]]; then
  echo "Could not query the lab repository in Gitea (HTTP ${status:-unknown})" >&2
  exit 1
fi
if [[ "${status}" == 200 ]]; then
  curl -fsS -X DELETE -u remotelab:remotelab "${repo_api}" >/dev/null
  wait_for_repo_status 404
fi
curl -fsS -X POST -u remotelab:remotelab \
  -H 'Content-Type: application/json' \
  -d '{"name":"django-app","description":"Django app with Helm chart and SOPS secrets","private":false,"auto_init":true,"default_branch":"main"}' \
  "${gitea_url%/}/api/v1/user/repos" >/dev/null
wait_for_repo_status 200

work_dir="$(mktemp -d)"
trap 'rm -rf "${work_dir}"' EXIT
cd "${work_dir}"
git init -q -b main
git config user.email remotelab@localhost
git config user.name Remotelab
cp -r "${repo_root}/sample-django-app/chart" .
cp -r "${repo_root}/sample-django-app/platform" .

cat > chart/django-app/.sops.yaml <<EOF
creation_rules:
  - path_regex: '.*\.enc$'
    age: '${age_public_key}'
EOF
cat > "${work_dir}/secrets-plain.yaml" <<'EOF'
secrets:
  DB_PASSWORD: "remotelab"
  SECRET_KEY: "django-production-secret-key-argo-remotelab-2024"
  API_TOKEN: "tok_prod_abc123def456"
EOF
export SOPS_AGE_KEY_FILE="${repo_root}/secrets/keys/local.key"
sops encrypt --age "${age_public_key}" --input-type yaml --output-type yaml \
  "${work_dir}/secrets-plain.yaml" > chart/django-app/secrets.yaml.enc
rm -f "${work_dir}/secrets-plain.yaml"
cp -r chart/django-app chart/django-app-staging
sed -i.bak 's/DB_HOST: "postgresql"/DB_HOST: "postgresql.applications.svc.cluster.local"/;s/APP_ENVIRONMENT: "production"/APP_ENVIRONMENT: "staging"/' \
  chart/django-app-staging/values.yaml
rm -f chart/django-app-staging/values.yaml.bak chart/django-app-*.tgz

git add -A
git commit -q -m "Initial commit: Django app with Helm chart and SOPS secrets"
git tag baseline
git remote add origin "${repo_url}"
GIT_TERMINAL_PROMPT=0 git push -f -u origin main -q
GIT_TERMINAL_PROMPT=0 git push origin baseline -q
echo "  OK: Repository initialized with local Helm chart + SOPS secrets"
