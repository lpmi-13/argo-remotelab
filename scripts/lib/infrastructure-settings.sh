#!/usr/bin/env bash
# Settings applied only by the full local deployment. Changes here require
# replacing the infrastructure before a warm deployment can run.

TRAEFIK_CRD_DEFINITIONS_URL="https://raw.githubusercontent.com/traefik/traefik/v3.7.13/docs/content/reference/dynamic-configuration/kubernetes-crd-definition-v1.yml"
ARGOCD_ADMIN_PASSWORD="remotelab"
# bcrypt hash for ARGOCD_ADMIN_PASSWORD. Argo CD stores this in argocd-secret.
ARGOCD_ADMIN_PASSWORD_HASH='$2a$10$53xm8W5NWtQbIe2oMGQlheoTFSxh4El7pz1Mdf3NHiRGdund2oPya'
