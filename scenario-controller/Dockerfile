FROM public.ecr.aws/docker/library/golang:1.27.1-alpine3.24 AS builder

RUN apk add --no-cache git

WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o /scenario-controller ./cmd

FROM quay.io/argoproj/argocd:v3.5.3 AS argocd-tools

FROM public.ecr.aws/docker/library/alpine:3.24.2

RUN apk add --no-cache git age ca-certificates && \
    wget -qO /usr/local/bin/sops https://github.com/getsops/sops/releases/download/v3.13.3/sops-v3.13.3.linux.$(uname -m | sed 's/aarch64/arm64/;s/x86_64/amd64/') && \
    chmod +x /usr/local/bin/sops

COPY --from=builder /scenario-controller /usr/local/bin/scenario-controller
COPY --from=argocd-tools /usr/local/bin/helm /usr/local/bin/helm

ENTRYPOINT ["/usr/local/bin/scenario-controller"]
