FROM alpine:3.24.2
RUN apk add --no-cache bash git curl jq yq age ttyd kubectl ca-certificates && \
    wget -qO /usr/local/bin/sops https://github.com/getsops/sops/releases/download/v3.13.3/sops-v3.13.3.linux.$(uname -m | sed 's/aarch64/arm64/;s/x86_64/amd64/') && \
    chmod 755 /usr/local/bin/sops
COPY lab-terminal/entrypoint.sh /usr/local/bin/lab-terminal-entrypoint
COPY lab-terminal/session.sh /usr/local/bin/lab-terminal-session
COPY lab-terminal/telemetry.sh /etc/profile.d/lab-telemetry.sh
RUN chmod 755 /usr/local/bin/lab-terminal-entrypoint /usr/local/bin/lab-terminal-session
WORKDIR /workspace
EXPOSE 7681
ENTRYPOINT ["/usr/local/bin/lab-terminal-entrypoint"]
