#!/bin/sh
set -eu

dns_resolver="$(awk '/^nameserver / { print $2; exit }' /etc/resolv.conf)"
if [ -z "$dns_resolver" ]; then
  echo "No DNS resolver found in /etc/resolv.conf" >&2
  exit 1
fi

sed "s/__DNS_RESOLVER__/${dns_resolver}/g" \
  /etc/nginx/nginx.conf.template > /etc/nginx/nginx.conf
