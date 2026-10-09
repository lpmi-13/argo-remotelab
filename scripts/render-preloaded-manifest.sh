#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
kind="${1:?usage: render-preloaded-manifest.sh gitea|gateway [public-base-url]}"

case "${kind}" in
    gitea)
        root_url="${2:-http://127.0.0.1:30080}"
        root_url="${root_url%/}/gitea/"
        manifest="$(awk -v root_url="${root_url}" '
            $0 == "          value: \"https://localhost:8443/gitea/\"" {
                print "          value: \"" root_url "\""; root_count++; next
            }
            $0 == "        - containerPort: 3000" {
                print; print "          hostPort: 30082"; port_count++; next
            }
            { print }
            END { if (root_count != 1 || port_count != 1) exit 1 }
        ' "${repo_dir}/manifests/applications/gitea.yaml")"
        ;;
    gateway)
        manifest="$(awk '
            /^kind: Deployment$/ { in_deployment = 1 }
            /^---$/ { in_deployment = 0 }
            in_deployment && /^spec:$/ {
                print; print "  strategy:"; print "    type: Recreate"; strategy_count++; next
            }
            $0 == "          containerPort: 8080" {
                print; print "          hostPort: 30080"; port_count++; next
            }
            { print }
            END { if (strategy_count != 1 || port_count != 1) exit 1 }
        ' "${repo_dir}/manifests/applications/lab-gateway.yaml")"
        ;;
    *)
        echo "usage: render-preloaded-manifest.sh gitea|gateway [public-base-url]" >&2
        exit 2
        ;;
esac

printf '%s\n' "${manifest}"
