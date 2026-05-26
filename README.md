# Argo GitOps Failure Lab

A hands-on ArgoCD troubleshooting environment that randomly injects realistic GitOps failures into a running application. You diagnose and fix each issue using the ArgoCD UI and kubectl, then the system explains what went wrong and moves on to the next challenge.

## How It Works

1. A Django application is deployed via ArgoCD from a Helm chart stored in Gitea
2. Secrets are encrypted with SOPS/age and decrypted at sync time by helm-secrets
3. A scenario controller watches the ArgoCD Application health status
4. When the app is healthy, the controller waits a random interval then injects a failure by pushing a malicious commit to Gitea
5. ArgoCD detects the drift and the app becomes unhealthy/out-of-sync
6. You troubleshoot and fix the issue using ArgoCD UI + kubectl
7. Once fixed, the controller logs an explanation of what happened and the cycle repeats

## Failure Scenarios

| Scenario | What Breaks | How to Fix |
|----------|-------------|------------|
| **Missing ConfigMap** | Deployment references a non-existent ConfigMap | Restore the ConfigMap reference |
| **SOPS Decrypt Failure** | SOPS age data-key block corrupted in encrypted secrets file | Recreate the plaintext and encrypt a fresh file |
| **SOPS Global MAC Mismatch** | Only the `sops.mac` metadata value is corrupted | Decrypt with `sops --ignore-mac`, then re-encrypt |
| **HMAC Mismatch** | Encrypted secret value ciphertext is tampered | Re-encrypt the secrets file from known-good plaintext |
| **Wrong Type in SOPS** | Encrypted `secrets` value is randomized to a wrong shape | Re-encrypt the file with `secrets` as a valid env-var map |
| **Stuck Sync** | Health check path changed to non-existent endpoint, pods never become Ready | Fix the health check path in values.yaml |
| **Stale Job** | PreSync migration Job template changed so the hook fails before sync | Restore the migration Job command and re-sync |
| **Orphaned Resource** | Deployment/Service renamed, old resources remain (prune disabled) | Delete orphaned resources via ArgoCD UI |

The Wrong Type in SOPS scenario chooses a variant at injection time: `secrets`
may be replaced with a string, list, int, or an invalid map shape such as a bad
environment variable name.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Local K3s Cluster                    │
│                                                         │
│  ┌──────────┐    watches     ┌──────────────────────┐   │
│  │ Scenario │───────────────>│   ArgoCD             │   │
│  │Controller│                │   (Application CR)   │   │
│  └─────┬────┘                └──────────┬───────────┘   │
│        │ pushes                         │ syncs         │
│        │ bad commits                    │               │
│        v                                v               │
│  ┌──────────┐                ┌──────────────────────┐   │
│  │  Gitea   │<───────────────│   Django App         │   │
│  │  (Git)   │   helm chart   │   (Deployment,       │   │
│  └──────────┘   + SOPS       │    ConfigMap,        │   │
│                  secrets     │    Service, Job)     │   │
│                              └──────────────────────┘   │
│                                                         │
│  Backing services: PostgreSQL                           │
│  Ingress: Traefik (path-based routing)                  │
└─────────────────────────────────────────────────────────┘
```

- **ArgoCD** - GitOps controller, syncs Helm chart from Gitea to cluster
- **Gitea** - Local Git server (no CI, no registry, git-only)
- **Django** - Target application image built locally or published to GHCR
- **Scenario Controller** - Go binary that injects failures and monitors recovery
- **SOPS/age** - Secrets encryption (helm-secrets plugin on ArgoCD repo-server)
- **Traefik** - Ingress controller with path-based routing

## Run Locally After Cloning

### Prerequisites

| Tool | macOS Install | Purpose |
|------|---------------|---------|
| Colima | `brew install colima` | Lightweight VM with k3s |
| kubectl | `brew install kubectl` | Kubernetes CLI |
| age | `brew install age` | Encryption key generation |
| sops | `brew install sops` | Secrets encryption |
| Helm | `brew install helm` | Required for Traefik install |

On Linux, you need k3s installed directly (no Colima needed), plus `age`, `sops`, and `helm`.
Initial Linux setup needs `sudo` for k3s installation and may prompt again during `deploy-all.sh` if the script has to repair `/etc/rancher/k3s/config.yaml`, restart k3s, or import the locally built scenario-controller image into k3s containerd. Normal lab use after deployment is through `kubectl`, ArgoCD, and git access to the internal Gitea service and does not require `sudo`.

### Clone And Deploy

```bash
git clone https://github.com/lpmi-13/argo-remotelab.git
cd argo-remotelab
bash scripts/deploy-all.sh
```

This takes about 5-10 minutes and:
1. Starts Colima with k3s (or verifies existing k3s on Linux)
2. Installs the pinned ArgoCD v3.3.7 manifest with SOPS/helm-secrets support
3. Generates age encryption keys
4. Deploys PostgreSQL and Gitea
5. Pushes the Django Helm chart to Gitea with encrypted secrets
6. Creates the ArgoCD Application
7. Builds and deploys the scenario controller
8. Waits for everything to be healthy

### Local Access

| Service | URL | Credentials |
|---------|-----|-------------|
| ArgoCD | https://localhost/argocd | admin / remotelab |
| Django | https://localhost/django/api/health/ | - |

Accept the self-signed certificate warning in your browser.
The deploy script patches ArgoCD's admin password to `remotelab` directly and
restarts `argocd-server`; deployment fails if that password cannot be applied.

### Local Cleanup

```bash
bash scripts/cleanup-all.sh
```

## Workflow

Once deployed, the scenario controller logs its activity:

```bash
# Watch the controller in real-time
kubectl logs -n applications deployment/scenario-controller -f
```

You'll see:
```
waiting for ArgoCD application to be Healthy and Synced...
application is Healthy and Synced
waiting 2m30s before injecting next scenario...
=== INJECTING SCENARIO: sops-decrypt-failure ===
description: Corrupts the age-encrypted SOPS data key...
scenario "sops-decrypt-failure" injected successfully, pushed to git
waiting for user to fix the issue (app must return to Healthy + Synced)...
```

### Diagnosing Issues

```bash
# Check ArgoCD Application status
kubectl get applications -n argocd django-app

# See sync errors and conditions
kubectl get applications -n argocd django-app -o jsonpath='{.status.conditions}' | jq .

# Check ArgoCD repo-server logs (SOPS/render errors show here)
kubectl logs -n argocd -l app.kubernetes.io/name=argocd-repo-server --tail=50

# Check pod status
kubectl get pods -n applications

# Describe failing pods
kubectl describe pod -n applications -l app=django
```

### Fixing Issues

Most fixes involve editing the Helm chart in the internal Gitea git repository. No Gitea browser UI is required for the learner path. If you want to work one issue at a time without the controller immediately injecting the next scenario, pause it first:

```bash
kubectl scale deployment/scenario-controller -n applications --replicas=0
```

Resume the lab later with:

```bash
kubectl scale deployment/scenario-controller -n applications --replicas=1
```

Use the Application annotation to see which scenario is active:

```bash
kubectl get application django-app -n argocd \
  -o jsonpath='{.metadata.annotations.remotelab\.io/current-scenario}{"\n"}'
```

```bash
# Clone the repo locally. deploy-all.sh leaves this port-forward running; start
# it yourself only if localhost:3000 is not already reachable.
kubectl port-forward svc/gitea -n applications 3000:3000 &
git clone http://remotelab:remotelab@localhost:3000/remotelab/django-app.git /tmp/fix
cd /tmp/fix

# Make the scenario-specific fix, then push it.
git add -A && git commit -m "fix: restore broken config" && git push

# Ask ArgoCD to refresh immediately instead of waiting for the poll interval.
kubectl annotate application django-app -n argocd \
  argocd.argoproj.io/refresh=hard --overwrite
```

ArgoCD will automatically detect the change and re-sync. The hard refresh just speeds up the feedback loop.

For SOPS-encrypted YAML files, pass explicit input/output types because the
`.enc` suffix is otherwise ambiguous to `sops`:

```bash
LAB_REPO=/home/adam/projects/argo-remotelab
export SOPS_AGE_KEY_FILE="$LAB_REPO/secrets/keys/local.key"
sops --decrypt --input-type yaml --output-type yaml chart/django-app/secrets.yaml.enc
```

The SOPS scenarios intentionally force-push the broken state as a new root
commit on `main`. That removes the easy `git restore HEAD~1 --
chart/django-app/secrets.yaml.enc` path from the learner repository and better
matches environments where an old encrypted blob is no longer a valid repair.

The lab's original plaintext secret values are:

```yaml
secrets:
  DB_PASSWORD: "remotelab"
  SECRET_KEY: "django-production-secret-key-argo-remotelab-2024"
  API_TOKEN: "tok_prod_abc123def456"
```

To re-encrypt from that plaintext, write the plaintext to a temporary file and encrypt it with the generated age public key:

```bash
cat > /tmp/remotelab-secrets.yaml <<'EOF'
secrets:
  DB_PASSWORD: "remotelab"
  SECRET_KEY: "django-production-secret-key-argo-remotelab-2024"
  API_TOKEN: "tok_prod_abc123def456"
EOF

LAB_REPO=/home/adam/projects/argo-remotelab
export SOPS_AGE_KEY_FILE="$LAB_REPO/secrets/keys/local.key"
age_public_key="$(age-keygen -y "$SOPS_AGE_KEY_FILE")"

sops --encrypt --age "$age_public_key" \
  --input-type yaml --output-type yaml \
  /tmp/remotelab-secrets.yaml > chart/django-app/secrets.yaml.enc
```

#### Missing ConfigMap

Symptoms:
- `kubectl describe pod -n applications -l app=django` reports that `django-app-missing-config` was not found.
- The Deployment has pods stuck in `CreateContainerConfigError` or a similar startup state.

Fix:
1. Edit `chart/django-app/templates/deployment.yaml`.
2. Restore the `envFrom.configMapRef.name` value to `{{ include "django-app.fullname" . }}-config`.
3. Commit and push. ArgoCD should render the original ConfigMap reference and start new pods.

#### SOPS Decrypt Failure

Symptoms:
- The Application sync status is `Unknown`.
- Repo-server logs contain `Failed to get the data key required to decrypt the SOPS file`.

The age-encrypted SOPS data key is damaged, so the broken file cannot recover its plaintext. Recreate the known plaintext and encrypt a fresh `secrets.yaml.enc` using the helper commands above. Verify the new file before pushing:

```bash
sops --decrypt --input-type yaml --output-type yaml chart/django-app/secrets.yaml.enc
```

#### SOPS Global MAC Mismatch

Symptoms:
- Repo-server logs report a SOPS MAC verification failure.
- The encrypted values still decrypt if MAC verification is disabled.

Only the global `sops.mac` metadata is corrupted. Decrypt with MAC verification disabled, inspect the plaintext, then re-encrypt it so SOPS writes a new MAC:

```bash
LAB_REPO=/home/adam/projects/argo-remotelab
export SOPS_AGE_KEY_FILE="$LAB_REPO/secrets/keys/local.key"
age_public_key="$(age-keygen -y "$SOPS_AGE_KEY_FILE")"

sops --ignore-mac --decrypt \
  --input-type yaml --output-type yaml \
  chart/django-app/secrets.yaml.enc > /tmp/remotelab-secrets.yaml

sops --encrypt --age "$age_public_key" \
  --input-type yaml --output-type yaml \
  /tmp/remotelab-secrets.yaml > chart/django-app/secrets.yaml.enc
```

#### HMAC Mismatch

Symptoms:
- Repo-server logs contain `Could not decrypt with AES_GCM: cipher: message authentication failed`.
- `sops --ignore-mac` does not recover the damaged value, because the individual encrypted value authentication fails.

Fix it the same way as a data-key corruption: re-encrypt `chart/django-app/secrets.yaml.enc` from the lab plaintext shown above.

#### Wrong Type In SOPS

Symptoms:
- The encrypted file decrypts, but `.Values.secrets` is a string, list, integer, or a map with an invalid environment variable name.
- ArgoCD may fail during Helm rendering, Kubernetes apply, or pod startup depending on the injected variant.

Inspect the decrypted values:

```bash
sops --decrypt --input-type yaml --output-type yaml chart/django-app/secrets.yaml.enc
```

Fix by re-encrypting `secrets.yaml.enc` so the top-level `secrets` value is a map of valid environment variable names to scalar strings:

```yaml
secrets:
  DB_PASSWORD: "remotelab"
  SECRET_KEY: "django-production-secret-key-argo-remotelab-2024"
  API_TOKEN: "tok_prod_abc123def456"
```

#### Stuck Sync

Symptoms:
- Pods are created but never become Ready.
- `kubectl describe pod -n applications -l app=django` shows readiness or liveness probe failures against `/api/nonexistent/`.
- The Application health stays `Progressing`.

Fix:
1. Edit `chart/django-app/values.yaml`.
2. Restore `healthCheck.path` to `/api/health/`.
3. Commit and push.
4. If ArgoCD still shows a running operation after the new commit, terminate the operation in the UI or run:

```bash
kubectl patch application django-app -n argocd --type=merge -p '{"operation":null}'
```

#### Stale Job

Symptoms:
- The PreSync migration hook Job fails.
- `kubectl logs -n applications -l app.kubernetes.io/component=migration --tail=50` contains `ERROR: migration dependency check failed`.

Fix:
1. Edit `chart/django-app/templates/migrate-job.yaml`.
2. Remove the injected failing lines so the command starts with:

```bash
set -e
echo "Running Django migrations..."
python manage.py migrate --noinput
```

3. Edit `chart/django-app/templates/deployment.yaml` and remove the injected `remotelab.io/stale-job-trigger: "enabled"` annotation if present.
4. Commit and push.
5. If ArgoCD is still stuck on the failed hook, terminate the operation or delete the failed hook Job:

```bash
kubectl patch application django-app -n argocd --type=merge -p '{"operation":null}'
kubectl delete job -n applications -l app.kubernetes.io/component=migration
```

#### Orphaned Resource

Symptoms:
- Both `django` and `django-web` Deployments may exist.
- `kubectl get svc,endpoints -n applications django` shows no endpoints.
- The Service selector points at `app: django-web`, but the rendered pods still use the normal chart labels.

Fix:
1. Edit `chart/django-app/templates/deployment.yaml` and restore `metadata.name` to `django`.
2. Edit `chart/django-app/templates/service.yaml` and restore the selector helper:

```yaml
selector:
  {{- include "django-app.selectorLabels" . | nindent 4 }}
```

3. Commit and push.
4. Because prune is disabled for the lab Application, delete the orphaned Deployment after the desired state is correct:

```bash
kubectl delete deployment django-web -n applications --ignore-not-found=true
```

### After a Fix

The controller detects the app is healthy again and logs the explanation:

```
application is Healthy and Synced
=== SCENARIO RESOLVED: sops-decrypt-failure ===
explanation: The age-encrypted SOPS data key in secrets.yaml.enc was corrupted...
--- cycle complete, starting next round ---
```

Then it waits another random interval before injecting the next failure.

## Directory Structure

```
├── argocd-apps/               # ArgoCD Application definition
│   └── django-app.yaml        # Points at Gitea repo, uses helm-secrets
├── manifests/
│   ├── applications/          # Gitea, PostgreSQL, scenario controller
│   ├── gitops/                # Pinned ArgoCD install, SOPS setup, ingress
│   └── infrastructure/        # Traefik ingress rules
├── sample-django-app/
│   ├── app/                   # Django runtime image source
│   ├── Dockerfile             # Runtime image build
│   └── chart/django-app/      # Helm chart (pushed to Gitea at deploy)
│       ├── templates/         # Deployment, Service, ConfigMap, Job
│       ├── values.yaml        # App configuration
│       └── .sops.yaml         # SOPS encryption rules
├── scenario-controller/       # Go source for the failure injector
│   ├── cmd/main.go            # Main loop
│   ├── internal/argocd/       # K8s dynamic client for Application CR
│   ├── internal/git/          # Git clone/modify/push via os/exec
│   ├── internal/scenarios/    # 8 scenario implementations
│   └── Dockerfile             # Multi-stage build
├── scripts/
│   ├── deploy-all.sh          # Full deployment script
│   ├── deploy-preloaded-vm.sh # iximiuz/preloaded VM deployment path
│   ├── build-rootfs-image.sh  # Build iximiuz rootfs image
│   ├── push-images.sh         # Push already-built GHCR images
│   ├── cleanup-all.sh         # Teardown script
│   ├── update-version-refs.sh # Keep image tag references aligned
│   └── lib/platform.sh        # Platform detection utilities
├── playground/iximiuz/        # iximiuz manifest, rootfs Dockerfile, bootstrap unit
└── secrets/keys/              # Generated age keys (gitignored)
```

## Platform Support

| Platform | Kubernetes | Notes |
|----------|-----------|-------|
| macOS (Apple Silicon / Intel) | Colima + k3s | Primary dev platform |
| Linux (Ubuntu/Debian) | Native k3s | Requires sudo for initial host setup |

### macOS Setup

```bash
brew install colima kubectl age sops helm
colima start --kubernetes --runtime containerd --cpu 4 --memory 6 --disk 60
```

### Linux Setup

```bash
# Install k3s
curl -sfL https://get.k3s.io | sudo sh -

# Install tools
sudo apt install age
# Install sops and helm manually (see their GitHub releases)
```

The privileged Linux steps are mostly host setup: k3s installation, occasional k3s advertised-IP repair if your host IP changes, and local image import when Docker is used as the fallback builder. If `nerdctl` is installed and can build into the k3s/containerd namespace, `deploy-all.sh` can avoid the Docker `save | sudo k3s ctr images import` fallback. Re-running the lab after it is deployed should only require unprivileged `kubectl` commands unless you rebuild/redeploy the controller image or reset k3s.

## Build, Push, And Publish

The iximiuz path bakes the lab files and required container images into a k3s-capable rootfs image. The bootstrap unit imports the image archive into k3s containerd, runs `scripts/deploy-preloaded-vm.sh`, and only lets the playground init task finish after the first scenario has been injected and detected by ArgoCD.

This path requires Docker, GHCR push access, and `labctl`.

Pick one version tag — `IMAGE_TAG` is applied to both the app images and the rootfs image:

```bash
export IMAGE_TAG=v6

docker login ghcr.io
PUSH_IMAGES=1 bash scripts/build-rootfs-image.sh
```

If the images are already built locally and only need to be pushed, log in to
GHCR with an account/token that can write packages, then run:

```bash
docker login ghcr.io
IMAGE_TAG=v6 bash scripts/push-images.sh
```

The build script creates/pushes:
- `ghcr.io/lpmi-13/argo-remotelab-scenario-controller:${IMAGE_TAG}`
- `ghcr.io/lpmi-13/argo-remotelab-argocd-tools:${IMAGE_TAG}`
- `ghcr.io/lpmi-13/argo-remotelab-django:${IMAGE_TAG}`
- `ghcr.io/lpmi-13/argo-remotelab-k3s-rootfs:${IMAGE_TAG}`

Set `ROOTFS_IMAGE` only if you need to push the rootfs to a different registry or repo than the default.

After a successful build, the script also rewrites `playground/iximiuz/manifest.yaml` so its rootfs drive points at the new `oci://...` reference. Verify that before publishing the playground:

```bash
grep -n "source: oci://" playground/iximiuz/manifest.yaml
```

> NB: you will also need to update the visibility of the images in your packages settings to `public` so that the iximiuz platform can actually pull them.

Create or update the iximiuz custom playground from that manifest:

```bash
labctl auth login

# First publish
labctl playground create argo-remotelab-3bf4e8fb \
  --base flexbox \
  --file playground/iximiuz/manifest.yaml

# Later updates
labctl playground update argo-remotelab-3bf4e8fb \
  --file playground/iximiuz/manifest.yaml \
  --force
```

> The above UUIDs (ie, `3bf4e8fb` at the end of the playground name are autogenerated by the system so are included above for reference, but if you create one, they will be different.

Start it from iximiuz or with `labctl playground start argo-remotelab-3bf4e8fb`. The ArgoCD tab should not become ready until the init task sees the first injected failure marker inside the VM.

## Configuration

The scenario controller is configured via environment variables in `manifests/applications/scenario-controller.yaml`:

| Variable | Default | Description |
|----------|---------|-------------|
| `MIN_DELAY_SECONDS` | 0 | Minimum wait (seconds) between healthy detection and injection |
| `MAX_DELAY_SECONDS` | 0 | Maximum wait (seconds) before injection (0 = inject immediately) |
| `FIRST_SCENARIO` | sops-decrypt-failure,sops-global-mac-mismatch,hmac-mismatch,wrong-type-sops | Comma-separated pool the very first injection is picked from at random; later runs are fully random. Empty = always random. The default lists the render-time SOPS failures, which all detect within seconds of the next ArgoCD refresh. |
| `ARGOCD_APP_NAME` | django-app | ArgoCD Application to monitor |
| `GITEA_URL` | http://gitea... | Internal Gitea service URL |

## Troubleshooting the Lab Itself

### ArgoCD Can't Decrypt Secrets

Check repo-server logs:
```bash
kubectl logs -n argocd -l app.kubernetes.io/name=argocd-repo-server --tail=50
```

Common issues:
- `sops: not found` → SOPS binary not in PATH on repo-server
- `could not decrypt` → Age key mismatch between what encrypted and what's mounted

### Scenario Controller Not Injecting

```bash
kubectl logs -n applications deployment/scenario-controller
```

Common issues:
- Application stuck as "Unknown" sync status (repo-server can't render)
- Controller waiting for Healthy+Synced but app never recovers

### Complete Reset

```bash
./scripts/cleanup-all.sh -y
./scripts/deploy-all.sh
```

## License

MIT
