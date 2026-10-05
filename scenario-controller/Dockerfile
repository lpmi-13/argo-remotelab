FROM golang:1.25-alpine AS builder

RUN apk add --no-cache git

WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o /scenario-controller ./cmd

FROM quay.io/argoproj/argocd:v3.3.7 AS argocd-tools

FROM alpine:3.19

RUN apk add --no-cache git age ca-certificates && \
    wget -qO /usr/local/bin/sops https://github.com/getsops/sops/releases/download/v3.13.0/sops-v3.13.0.linux.$(uname -m | sed 's/aarch64/arm64/;s/x86_64/amd64/') && \
    chmod +x /usr/local/bin/sops

COPY --from=builder /scenario-controller /usr/local/bin/scenario-controller
COPY --from=argocd-tools /usr/local/bin/helm /usr/local/bin/helm

ENTRYPOINT ["/usr/local/bin/scenario-controller"]
