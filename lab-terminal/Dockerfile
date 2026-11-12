FROM public.ecr.aws/docker/library/alpine:3.24.3
RUN apk add --no-cache bash git curl jq yq age ttyd kubectl ca-certificates && \
    wget -qO /usr/local/bin/sops https://github.com/getsops/sops/releases/download/v3.13.3/sops-v3.13.3.linux.$(uname -m | sed 's/aarch64/arm64/;s/x86_64/amd64/') && \
    chmod 755 /usr/local/bin/sops
COPY lab-terminal/entrypoint.sh /usr/local/bin/lab-terminal-entrypoint
COPY lab-terminal/session.sh /usr/local/bin/lab-terminal-session
COPY lab-terminal/telemetry.sh /etc/profile.d/lab-telemetry.sh
# The team's known-good secret values, which a learner re-encrypts when an
# encrypted file cannot be recovered. scripts/reset-gitea-repo.sh seeds Git from it.
COPY --chmod=444 lab-terminal/known-good/secrets.yaml /known-good/secrets.yaml
RUN chmod 755 /usr/local/bin/lab-terminal-entrypoint /usr/local/bin/lab-terminal-session
WORKDIR /workspace
EXPOSE 7681
ENTRYPOINT ["/usr/local/bin/lab-terminal-entrypoint"]
