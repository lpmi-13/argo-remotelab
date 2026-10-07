# Argo RemoteLab

Argo RemoteLab teaches a new operator to find deployment evidence in the Argo CD console and use that evidence to repair a GitOps release. The [UI plan](WRAPPING_UI_PLAN.md) describes the curriculum and architecture; [Phase 0 findings](docs/WRAPPING_UI_PHASE0.md) record what has been verified against pinned components and what still needs a running lab.

## Learning modes

| Mode | What happens | Completion |
| --- | --- | --- |
| Demonstration | The coach navigates and explains the evidence, then applies a reference fix. | Unscored debrief. |
| Guided | The learner finds the target in Argo, answers a short evidence check, and makes the fix with optional hints. | Healthy deployment, evidence checks, and incident note. |
| Challenge | The learner gets an incident brief and can investigate freely. | Healthy deployment and incident note; remediation, console evidence, diagnosis, and operating habits are scored. |

The launcher defaults to **Demonstration** and recommends **Console orientation** until it is completed. A preparation screen stays open while the lab sets up the mission, then opens Argo CD and its briefing automatically when the scenario is ready. A 15-second progress bar counts down before the coach enters the demonstration. **Start now** skips the countdown. Every subsequent automatic step waits at least 15 seconds, with a visible countdown, so there is time to read each explanation and result. **Advance** completes the current countdown immediately and continues the demonstration. The coach points to Argo controls, opens the evidence, advances the checks, applies the reference fix when needed, and shows the debrief automatically. Three short Level 1 missions cover finding an Application, reading a resource manifest, and reading release history. The other scenarios progress from a missing ConfigMap and failed probe through sync operations, SOPS rendering failures, and multi-environment incidents. One run owns the shared cluster at a time. Starting another mission, including from a fresh tab after closing Argo, stops the previous run and waits for its worker before resetting the Git repository to the `baseline` tag and restoring the shop Applications.

Each mission opens with a short statement of the problem. Demonstration explains the next evidence view, why that view helps, and what the observed result means before moving to the next step. Guided practice keeps the reason visible while the learner investigates, then pauses on the finding before continuing. The scenario-specific narrative lives in `learning/incident-framing.json`; the scenario packs continue to define the facts, answers, and evidence targets.

The console contains `shop-web-prod`, `shop-web-staging`, and three healthy platform Applications. The coach watches the browser's Argo URL and API actions, while the controller checks the actual Application status, endpoint, Git revision, and scenario-specific outcome. Opening a tab alone does not complete a Guided evidence check.

## Run locally

On macOS, use an isolated Colima k3s cluster. The deployment script creates or reuses the `argo-remotelab` profile with 4 CPUs and 8 GiB of memory. It uses a temporary kubeconfig scoped to that profile, leaving your active `kubectl` context alone. Set `COLIMA_PROFILE` to use another dedicated profile; use the same value for cleanup. On Linux, the script starts the host k3s service if it is stopped and allows up to 15 seconds for its API to respond before deploying. If the local kubeconfig credentials are rejected, it stops and points to `./scripts/manual-refresh.sh`, which verifies the current k3s credentials and backs up the local kubeconfig before replacing it. Full Linux deployment prompts for sudo before changing lab resources and again if needed before importing Docker images into k3s. If k3s advertises an IP different from the host's current IP, it updates k3s's advertised IPs and allows 15 seconds for the API, node, and Kubernetes endpoint to recover after restarting k3s.

Prerequisites: Colima with k3s and containerd on macOS, or an installed k3s systemd service on Linux; plus `kubectl`, `helm`, `age-keygen`, `sops`, `jq`, and Docker or `nerdctl` for local image builds. Local development pins Node 24.21.0 in `.nvmrc` and Python 3.14.8 in `.python-version`; deployment images carry their own runtime pins. The script checks the required tools during setup.

```bash
bash scripts/deploy-all.sh
# Later, to remove only this lab's resources:
bash scripts/cleanup-all.sh
```

Run `bash scripts/deploy-all.sh` for both initial setup and later reruns. When the existing lab is ready and its infrastructure dependency pins match this checkout, it selects a warm deployment; otherwise it runs the full setup and recreates the lab namespaces. Use `--full` to request a complete rebuild explicitly. PostgreSQL 16 volumes need a data migration before PostgreSQL 18 can reuse them; `--skip-cleanup` stops if it finds an older PostgreSQL deployment, and the database pod checks the volume version before startup. Use `--full` for a disposable lab.

Warm deployment resets the current mission while keeping the Colima profile, Argo CD, PostgreSQL, Gitea, persistent volumes, and SOPS key. It restores the Git baseline, waits for the Applications to become Healthy and Synced, and rebuilds first-party images whose source or image tag changed, including the sample Django app. If the local app, chart, or platform source changed, it seeds a new baseline and release history.

The deployment script starts local port-forwards for the lab at `https://localhost:8443/` and Gitea at `http://localhost:3000/`. They keep running after deployment and are stopped by `cleanup-all.sh`. Open the lab URL and accept the local certificate.

Choose a scenario, assistance mode, environment, and optional scenario key. The preparation screen waits for the controller's scenario readiness check and keeps the Argo CD interface out of view until then. It signs in as the scoped `learner` account and opens the briefing automatically. If preparation fails or another run replaces it, the screen shows the reason and links back to the launcher. Direct Argo CD access at `https://localhost:8443/argocd/` still accepts `admin / remotelab` for manual exploration. If you chose another `COLIMA_PROFILE`, replace `colima-argo-remotelab` with `colima-<your-profile>` in the `kubectl` examples below.

The docked terminal is at `/terminal/`. Minimize it from its header to keep the shell open, and drag the upper-left corner to resize it. Gitea remains the Git host and webhook source, and its repository is viewable at `/gitea/`; the Guided repair does not require its browser editor. Gitea's lab credentials are `remotelab / remotelab`. The generated age key is saved at `secrets/keys/local.key` and mounted in the lab terminal. Gitea pushes notify both Argo CD and the learning service.

```bash
# Read the two shop Applications and the controller's current run activity.
kubectl --context colima-argo-remotelab -n argocd get applications shop-web-prod shop-web-staging
kubectl --context colima-argo-remotelab -n applications logs deployment/scenario-controller --tail=80
```

For a Git fix, edit the affected chart in the lab terminal, commit, and push. The chart paths are `chart/django-app/` for production and `chart/django-app-staging/` for staging. The terminal has `git`, `kubectl`, `sops`, `age`, `jq`, and `yq`. When editing encrypted values, keep `secrets.yaml.enc` encrypted in Git and pass explicit YAML types to SOPS:

```bash
sops --decrypt --input-type yaml --output-type yaml chart/django-app/secrets.yaml.enc
```

After a repair, verify **Healthy** and **Synced** in the Application header, then open **History and Rollback** to read the deployed revision. The incident note closes the run. The debrief lists the steps taken and what each revealed. Replay options return to the launcher.

The controller also retains its older autonomous scenario loop when started without `LAB_MODE=api`; the launcher deployment sets `LAB_MODE=api` to coordinate one reproducible run at a time.

## Components

| Path | Role |
| --- | --- |
| `argocd-apps/`, `sample-django-app/` | Staging and production Applications, projects, platform apps, and Helm chart source. |
| `scenario-controller/` | Go run API, baseline reset, injectors, readiness and outcome probes. |
| `learning/`, `learning-service/` | Scenario packs, evidence targets, sessions, checks, scoring, notes, webhook intake. |
| `argocd-coach/` | Same-origin bootstrap, Argo action observer, Guided clock, Shadow DOM coach. |
| `lab-gateway/`, `lab-launcher/`, `lab-terminal/` | Nginx gateway, curriculum entry page, browser terminal. |
| `scripts/`, `playground/iximiuz/` | Local and preloaded VM deployment paths. |

The iximiuz image exposes the launcher through the `argocd` tab on port `30080`. Its bootstrap uses `scripts/deploy-preloaded-vm.sh`; `scripts/build-rootfs-image.sh` packages the first-party images and manifests for that path.

## Checks

```bash
cd scenario-controller && go test ./...
cd ..
python3 -m unittest discover -s learning-service -p 'test*.py' -v
python3 -m unittest discover -s tests -p 'test*.py' -v
node --test argocd-coach/test/*.test.mjs
bash -n scripts/*.sh lab-terminal/*.sh
# With the dedicated local lab running:
python3 tests/live_reset_soak.py --context colima-argo-remotelab
python3 tests/live_mode_matrix.py --context colima-argo-remotelab
python3 tests/live_terminal_fix.py --context colima-argo-remotelab
cd scenario-recorder && npm ci && KUBE_CONTEXT=colima-argo-remotelab npm run record
KUBE_CONTEXT=colima-argo-remotelab npm run guided
KUBE_CONTEXT=colima-argo-remotelab npm run demo
DEMO_ONLY_SCENARIO=missing-configmap KUBE_CONTEXT=colima-argo-remotelab npm run demo
```

The live scripts reset the shared lab and must run one at a time. `scenario-recorder` checks the real Argo 3.5.3 list and History UI, Guided orientation, light and dark theme following, and versioned coach-panel image baselines. Its `guided` run follows a failure from Argo evidence through a docked-terminal Git push and back to History and debrief. Its `demo` run checks the default mode, replacement of a closed-tab run, the visible cursor and click cue, and automatic orientation completion; `DEMO_ONLY_SCENARIO` checks a full reference repair. After the full Argo CD 3.5.3 upgrade, review the captured panels and run with `UPDATE_BASELINES=1` to create its new visual baselines. The mode matrix uses the controller's reference fix as a fixture for Guided and Challenge; the separate terminal test exercises a learner Git push. See the verification findings for current live results and remaining gates.
