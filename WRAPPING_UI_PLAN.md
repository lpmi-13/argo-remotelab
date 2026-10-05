# Wrapping the Argo CD UI — Three-Mode Learning Plan

Implementation and Phase 0 verification findings are tracked in [WRAPPING_UI_PHASE0.md](docs/WRAPPING_UI_PHASE0.md).

**MVP decision (2026-10-03):** Guided learning requires evidence gathered in the Argo CD UI and a durable repair. The lab terminal is the supported Git repair surface. Gitea remains the in-cluster Git host and webhook source, but its browser editor is optional. Demonstration can make a server-side reference commit while showing the exact diff in the coach. Gitea editor automation is deferred until it helps the learning goal.

## Purpose

**Help someone who has never used the Argo CD console learn to navigate it well enough to find the information they need to fix real deployment problems, in an environment that looks and behaves like production or staging.**

Everything in this plan follows from that goal:

- **The Argo CD UI is where learners get their information.** The lab exists to build a habit of *opening the console, knowing where each kind of fact lives, and reading it correctly*.
- **Fixing the deployment is how the lab measures success.** A run ends when the app is actually healthy again, not when the right buttons have been clicked. The fix itself may happen in the Argo UI (Sync, Terminate, Prune, Delete), in the **Gitea UI**, or in a **terminal** (`git`, `sops`, `kubectl`).
- **UI clicks are a means, not the goal.** The lab watches console navigation to coach and give feedback. It never counts clicks as proof of learning. Proof is (a) the learner can show what they found in the console, and (b) the deployment is fixed in a durable way.

The lab supports three assistance modes over one scenario definition:

- **Demonstration**: the coach navigates the console, reads the evidence aloud, and carries out the fix while explaining each step. Unscored.
- **Guided**: the learner does the work. The coach points them to the right part of the console, checks that they read what is there, and helps with the fix when asked.
- **Challenge**: the learner gets only an incident brief. The run is scored on whether the deployment was fixed, the evidence gathered from the console, the diagnosis, and safe operating habits.

The coach's panels, callouts and dialogs are **styled to match the Argo CD UI closely**, so the lab feels like one product and learners get used to the real console's visual language (§8).

This plan reuses the proven mechanics of [ELK-guide](../ELK-guide/PLAN.md): a same-origin gateway injects the coach, a learning service runs a goal-graph engine, scenario packs are data, and runs are seeded and reproducible. It departs from ELK-guide on purpose where the goals differ (§2).

---

## 1. What we carry over from ELK-guide

| ELK-guide piece | Argo equivalent | Reuse level |
|---|---|---|
| `kibana-gateway` (nginx `sub_filter` injection, learning WS proxy) | `lab-gateway`: the same pattern in front of `argocd-server`, plus Gitea and the lab terminal on one origin | Pattern reused |
| `kibana-coach/src/ui/*` (cursor, spotlight, coach panel, briefing, debrief) | `argocd-coach/src/ui/*` | **Behaviour copied; visual layer rebuilt** on Argo design tokens (§8) |
| `kibana-bootstrap.js` (one-use handoff, URL scrubbing, boot overlay) | `argocd-bootstrap.js`, which also installs the network observer before Argo's bundle loads | Pattern reused |
| `session-client.js`, `GuidedStepClock`, check-in and recovery cards | Same | Copied |
| `kibana-adapter.js`, `action-observer.js`, `adapters/*` | `argocd-adapter.js`, `gitea-adapter.js`, `terminal-adapter.js`, `action-observer.js` | Rewritten |
| `learning-service` engine (sessions, commands, evaluator, debrief) | `learning-service` | Engine copied. Validators, scoring and debrief **reshaped** around fixing and console evidence (§10, §12) |
| Schemas, scenario-pack layout, `${param.…}`, scenario key → seed | Same, plus parameters passed to the Go injectors | Reused |
| `ENHANCED_FEEDBACK_PLAN.md` (dead ends, drift, step clock, check-ins) | Same machinery; Argo-specific rules (§11.2) | Reused |
| Launcher and "Preparing…" handoff | `lab-launcher` | Pattern reused, restyled |
| Playwright `scenario-recorder` | Reference videos, selector checks, **visual-regression checks for the coach's styling** | Deferred (Phase 5) |

Start by *copying* the ELK engine and coach behaviour into this repo. Whether to extract a shared package is decided later (§19). Given the divergence described below, that may never be worth it.

---

## 2. Where this project departs from ELK-guide

ELK-guide teaches **reading telemetry to reach a conclusion**. Its outcome is a correct diagnosis backed by evidence. This lab teaches **reading the Argo console to fix a broken deployment**. That changes several core decisions:

| Aspect | ELK-guide | Argo RemoteLab |
|---|---|---|
| What ends a run | A diagnosis is submitted | **The deployment is fixed** (outcome predicates pass), then the learner writes a short incident note |
| Main score component | Diagnosis correctness | **Remediation**: fixed, durable (in git, survives self-heal), with no collateral damage |
| What the UI is for | Everything happens in Kibana | The Argo UI is the **source of information**; the fix may happen anywhere |
| How "learning the UI" is checked | UI state validators (query, filters, expanded row) | **Information targets** plus short **evidence checks**: did the learner get to the right part of the console *and read it correctly* (§6) |
| Alternate routes | Equivalent Kibana routes accepted | `kubectl` equivalents are accepted for progress, but the coach **steers back to the console**, and console coverage is reported separately (§10.3) |
| Path efficiency | Scored against a reference route | Weighted low. Exploring the console is encouraged, since learning to navigate is the point |
| Curriculum shape | A catalog of independent scenarios | A **progression**: console orientation → UI + git fixes → terminal/SOPS fixes → multi-environment incidents (§5) |
| Environment | One synthetic app topology | A **realistic console**: several Applications, staging and production, projects and labels, mostly healthy (§4) |
| Operating habits | Read-only, no risk | Real, destructive actions. The lab teaches **safe habits**: diff before sync, fix through git rather than live edits, prune only what you mean to (§10.2) |
| Look and feel | Coach styled as a distinct overlay | Coach styled **as part of Argo CD** (§8) |

---

## 3. What makes Argo different

1. **The fix can span several surfaces.** The **Argo UI** is used to diagnose, and to sync, terminate, prune and delete. The **terminal** handles `git`, `sops` and `kubectl`; a terminal push is the supported Git repair route for MVP. The Gitea editor is optional. Six of the eight original failure scenarios are fixed in git, and four of those need `sops`.
2. **Failures are persistent state.** A run is "ready" once Argo has detected the failure and it shows in the console.
3. **One shared cluster, so one active run at a time.** Every run begins with a reset to a clean baseline.
4. **Argo's UI is a thin REST/SSE client.** UI actions map to `/api/v1/...` calls, and much of the view state is in the URL. This makes observation reliable (§7).
5. **Auto-sync with `selfHeal: true` and `prune: false`.** Pushed fixes apply automatically, live edits get reverted, and orphaned resources stay until someone prunes them. These behaviours are *part of what the learner must understand*, and the coach explains them when they matter.
6. **Some scenarios rewrite branch history.** Reset and validation can't assume a linear history.

---

## 4. A realistic console

A newcomer learns little from a console with one Application. The lab environment should look like a small team's real Argo instance, with the failure hidden among healthy apps:

- **Several Applications across two environments.** `shop-web-staging` and `shop-web-prod` are the Django chart deployed into separate namespaces with different values (1 replica each, to keep resource use low). Add two or three healthy, cheap platform apps as distractors, for example `postgres`, `gitea`, and `ingress-config`. These are already running in the cluster and only need to be declared as Applications. The current `django-app` becomes one of the environment apps. Names are decided in Phase 1.
- **Projects and labels.** For example `platform` and `shop` AppProjects, with `env=staging|prod` and `team=` labels, so filtering the Applications list and project scoping are real skills.
- **A history.** Each app is seeded with several past syncs (benign commits applied during baseline creation), so **History and Rollback** has something to show.
- **Scenario targeting.** Each pack gets an `environment` parameter, so a run may break staging or production. Some briefings are about production ("customers are seeing 503s") and some about staging ("the release to staging is blocked"). The first skill is *finding the right Application*.
- **Realistic briefing sources**: an on-call page, a Slack message from the release manager, a failed synthetic check. They are written the way real reports are: symptom first, cause never named.

Resource budget: the iximiuz VM has 4 CPU and 8 GiB of RAM. Phase 0 checks that two chart instances plus the lab services fit. If they don't, staging runs at 0 replicas and scales up only when it is the scenario target.

---

## 5. Curriculum

The progression follows what a complete newcomer needs, in order:

| Level | Title | What the learner practices | Fix surface |
|---|---|---|---|
| **0** | **Console orientation** (no failure) | Log in; filter the Applications list; open an app; read the app header (repo, path, target revision, sync/health); switch between the tree, network, list and pods views; open a resource and its Summary, Events, Logs and Live/Desired manifest tabs; read History; see Diff | None (evidence checks only) |
| **1** | **Read the tree, fix in git** | Degraded or Progressing apps; find the failing resource; read Events and container state; fix a YAML value | Terminal Git push (Gitea editor optional) |
| **2** | **Operations in the console** | Stuck and failed sync operations, hooks, orphaned resources; Terminate, Sync options (prune, dry-run), Delete with care; History and Rollback as a *temporary* measure | Argo UI + git |
| **3** | **When rendering fails** | ComparisonError / Unknown; app conditions; reading repo-server errors; SOPS failures | Terminal |
| **4** | **Multi-environment incidents** | Staging is fine but prod is broken, or the other way round; compare revisions and values between environments; repo credentials (the ssh→https scenario from `notes.txt`) | Mixed |

Level 1 runs as a set of short Guided and Demonstration "missions" (for example, *"Find which Git revision `shop-web-prod` is running"*), and each one ends with an evidence check. It's the entry point for new users, and the launcher recommends it until it has been completed once. Levels 2–5 are the failure scenarios. §14 maps the current eight scenarios onto them.

---

## 6. Information targets and evidence checks

This section describes how the lab checks that someone *learned to use the console*, without scoring clicks.

### 6.1 Information targets

A versioned catalog lists the places in the console where facts live. Every scenario says which targets hold the evidence it needs:

| Target id | Where in the console | Typical facts |
|---|---|---|
| `apps.list` / `apps.filter` | Applications list, filters, search | Which app is unhealthy; environment; project |
| `app.header` | App details header and summary | Repo URL, path, target revision, current revision, sync/health |
| `app.tree` / `app.network` / `app.list` / `app.pods` | App views | Which resource is failing; ownership; orphaned resources |
| `app.conditions` | App conditions panel | ComparisonError text, repo errors |
| `app.operation` | Sync status / last operation panel | Operation phase, message, the hook that failed, sync result per resource |
| `app.history` | History and Rollback | Deployed revisions, when a change arrived, the commit message |
| `app.diff` | App Diff | What the desired state would change |
| `resource.summary` | Resource panel → Summary | Status, health message, owner |
| `resource.events` | Resource panel → Events | `FailedMount`, `Unhealthy`, `BackOff`, … |
| `resource.logs` | Resource panel → Logs | Container / hook output |
| `resource.manifest` | Live / Desired manifest | The actual field values (probe path, selector, env refs) |
| `settings.repos` | Settings → Repositories | Connection status and auth method |

The observer records each visit (§7). The **Locate** and **Diagnose** goals are satisfied by reaching the scenario's targets *and* passing its evidence check. Opening a tab alone is never enough.

### 6.2 Evidence checks

An evidence check is a short question, built from this run's values, that the learner can only answer by reading what the target shows:

- *"What reason does the pod's most recent warning event give?"* The options are 3–4 real event reasons generated from the run, including distractors taken from healthy resources.
- *"Which revision is `shop-web-prod` running, and what was its commit message?"* (free text, matched flexibly)
- *"Which resource does Argo say requires pruning?"*

Behaviour by mode:

- **Guided**: when a target is reached, a one-line check appears in the coach panel (no modal). A wrong answer gives a "look again" nudge that points to the exact spot, with no penalty. A right answer unlocks the next goal and briefly explains *why* this is where that fact lives.
- **Challenge**: no inline checks. The **incident note** at the end asks for the same facts (failing resource, decisive evidence, the revision that caused it, the fix). They're scored against the run's truth.
- **Demonstration**: the coach asks the question aloud, pauses, then highlights the answer on screen.

Checks are authored per pack, with answers taken from `truth` and the probe snapshot, so they stay correct across seeds.

---

## 7. Observation and validation

### 7.1 Sources

| Layer | Source | Yields |
|---|---|---|
| **Browser: network** | The bootstrap wraps `XMLHttpRequest`, `fetch` and `EventSource` before Argo's bundle loads | `sync_requested` (+ prune/dry-run/selected resources), `operation_terminated`, `refresh_requested`, `resource_deleted`, `rollback_requested`, `events_viewed`, `logs_viewed`, `manifest_viewed`, `diff_viewed`, `history_viewed` |
| **Browser: URL** | `pushState`/`popstate` hooks; Argo's query parameters (view, node, tab, …) | `app_opened`, `view_changed`, `resource_selected`, `resource_tab_opened`, list filter changes → **information target visits** |
| **Browser: DOM** | A small, versioned selector registry | Panels with no network or URL signal (conditions, operation panel), dialogs, Gitea editor state |
| **Server: Argo/K8s** | Controller `/probe` | `state_observed`: health, sync and operation changes, conditions, pods, events, revision |
| **Server: git** | Gitea push webhook | `commit_pushed` {files, sha, message, via, force} |
| **Terminal** | `lab-terminal` prompt hook | `terminal_command` {normalized verb, exit code, redacted args} |

Network and URL observation carry most of the load; the DOM registry stays small (decision D3).

### 7.2 Validation principles

1. **Remediation is validated by outcome.** Pack-specific Go `Fixed()` predicates check the app is Healthy + Synced with no running operation, the endpoint returns 200, orphans are gone, secrets decrypt with the right shape, and so on. File contents are never compared with the original.
2. **Durability is checked separately.** A fix that exists only in the live cluster (a `kubectl edit` or a UI live-manifest edit) is detected when `git HEAD` still renders the broken state. Self-heal will revert it, and the coach explains that when it happens.
3. **Learning the console is validated by information targets plus evidence checks**, never by a click sequence.
4. **Safe-habit signals** are taken from observed actions (§10.2). They feed the debrief and a small score component, and never block progress.

### 7.3 Vocabulary and validators

Action and command enums extend ELK's schemas. The actions are those in §7.1 plus `evidence_check_answered`, `file_edited_in_browser`, `hint_requested`, `step_demonstrated`, `check_in_answered`, and `incident_note_submitted`. The commands are `open_application`, `filter_applications`, `set_app_view`, `select_resource`, `open_resource_tab`, `open_conditions`, `open_operation`, `open_history`, `open_diff`, `refresh_app`, `sync_app`, `terminate_operation`, `delete_resource`, `rollback_app`, `open_repo_file`, `edit_repo_file`, `commit_repo_change`, `open_terminal`, `run_terminal_command`, `ask_evidence_check`, `wait_for_state`, `request_incident_note`, `show_debrief`, `pause`, and `resume`. All commands are idempotent.

New validators: `target_visited`, `evidence_check_passed`, `app_state`, `condition_present`, `commit_touches`, `file_predicate` (YAML path, SOPS decrypts, decrypted shape), `terminal_verb`, `resource_absent`/`resource_present`, `http_ok`, `fixed`, and `durable`. ELK's generic validators are reused.

---

## 8. Look and feel: matching the Argo CD UI

The coach should look like **part of Argo CD**, while staying clearly identifiable as a coach. Learners are building visual memory for a tool they'll use without the lab, so the coach must not change how the console looks, and must never be mistaken for a real Argo control.

### 8.1 Design tokens taken from the real UI

- **Take tokens from the running version; don't hard-code them.** `scripts/extract-argocd-tokens.mjs` fetches the compiled stylesheet from the pinned `argocd-server` and writes `argocd-coach/src/ui/tokens.css`. That file holds CSS custom properties for:
  - **Typography**: Argo's font family, weights and sizes for body, panel titles and labels, and its monospace font for manifests and logs.
  - **Brand and neutrals**: the primary accent (Argo's teal/blue), the navigation sidebar background, page background, panel/card surfaces, borders and dividers, and text levels.
  - **Status colours**: the exact colours Argo uses for Healthy, Progressing, Degraded, Suspended, Missing and Unknown health, and Synced/OutOfSync sync status.
  - **Shape**: border radii, shadows, spacing scale, and button heights/paddings.
- The script **fails loudly** if an expected token can't be found, and prints a diff against the committed tokens when Argo is upgraded. It is wired into `scripts/update-version-refs.sh`.
- If extraction proves too brittle in the Phase 0 spike, fall back to a hand-audited `tokens.css` with a comment giving the Argo version and the source selector of each value.

### 8.2 Following Argo's theme

- Argo CD offers light, dark and auto themes in its user settings. The coach reads Argo's active theme (Phase 0 confirms whether the signal is a body/root class or a stored preference) and switches token sets to match, **live**, when the learner changes it.
- `auto` falls back to `prefers-color-scheme`.
- Both token sets are checked for WCAG AA contrast in CI (see §17).

### 8.3 Component mapping

| Coach element | Modelled on | Notes |
|---|---|---|
| Coach panel (docked) | Argo's **sliding resource panel** and white/dark cards | Same surface, border, header typography, and close/collapse affordances. Docks right by default, opposite Argo's left nav, and moves out of the way of Argo's own sliding panel when that opens |
| Buttons (Hint, Show me, Keep going, Submit) | Argo's primary and outlined buttons | Same height, radius, casing and focus ring |
| Incident briefing, incident note, debrief | Argo's **popup/dialog** style | Same backdrop, title bar and footer button layout |
| Status mentions in narration ("the app is **Degraded**") | Argo's **health/sync status icons and colours** | Reuse the same icon and colour so learners connect the words to the console's badges |
| Toasts (step complete, dead end) | Argo's notification style | Positioned so they don't overlap Argo's own notifications |
| Spotlight and callout | Argo's accent colour for the ring and arrow; callout body uses card styling | Dim level set so the dimmed console stays readable |
| Virtual cursor | Neutral, with an accent click ripple | Unchanged from ELK apart from colours |
| Terminal dock | Argo's **pod logs viewer** (monospace, dark surface, toolbar) | So the terminal feels like a native console panel |
| Launcher and Preparing page | Argo's **login and Applications list** pages | The whole journey feels like one product |
| Evidence check | Argo's form controls (radios, text input) | Inline in the coach panel |

### 8.4 Keeping the coach distinguishable

- Every coach surface has a small **coach mark** (an icon and the word "Coach") in its header, plus a thin accent stripe on its leading edge. This is the only styling that isn't Argo's.
- Coach elements never imitate Argo navigation, and never place coach buttons inside Argo's own toolbars.
- In Demonstration, the virtual cursor and a "Coach is driving" chip make it clear who is acting.

### 8.5 Technical approach

- All coach UI renders inside a **Shadow DOM** root, so Argo's CSS can't affect the coach and coach CSS can't affect Argo. Tokens are passed in as custom properties on the shadow host.
- The font is loaded from Argo's own same-origin asset if it ships one (check in Phase 0), otherwise the system stack Argo falls back to. No third-party font CDN.
- Gitea pages keep **Argo-styled coach elements** as well, so the coach feels the same across tabs even though the page underneath is Gitea.
- Reduced motion, keyboard navigation and screen-reader announcements are preserved from ELK.

---

## 9. Learner experience

```text
Launcher ─► Preparing… ─► Incident briefing
   ─► Find the app (Applications list) ─► Read the symptom (header / operation / conditions)
   ─► Locate & read the evidence (tree → resource → tab)  ◄── evidence checks
   ─► Fix (Argo action / Gitea / terminal) ─► Verify in the console (health, History, endpoint)
   ─► Incident note ─► Debrief ─► Replay / next level
```

**Verify happens in the console, on purpose.** Each run ends by asking the learner to confirm the fix *in Argo*: the app is Healthy + Synced, History shows the new revision with their commit message, and the operation panel shows success. This is the closing habit of real incident work and a last console-navigation exercise.

### 9.1 Demonstration

The coach finds the right app, reads each piece of evidence aloud while highlighting it, answers its own evidence checks, and carries out the fix: Argo actions for real and a reference Git commit with its exact diff shown in the coach. SOPS and learner Git fixes use the terminal. It then verifies in the console. Before destructive actions (Delete, Terminate, force-push) there is a short "about to…" beat, and **Stop** always wins. The run ends with a summary card that shows *where in the console each fact came from*.

### 9.2 Guided

Each goal is phrased as a question the console answers ("Which resource is actually unhealthy?"). The coach waits for the learner to reach the target, asks the evidence check, then moves on. Fix steps offer the hint ladder, Show me, and command templates with **Copy**. If the learner diagnoses with `kubectl` instead, the step still completes, and the coach adds a short **"you can see this in Argo too"** pointer that highlights the equivalent console location. Dead ends, drift, the step clock and check-ins follow §11.2.

### 9.3 Challenge

Only the briefing is shown, plus **Incident info**, **Hint** (with its cost shown first) and **Write incident note**. The run completes when `fixed` passes and the note is submitted. Scoring and debrief follow §10.

---

## 10. Scoring and debrief

### 10.1 Challenge score

| Category | Weight | What earns it |
|---|---:|---|
| **Remediation** | 35 | `fixed` passes (20); the fix is **durable**, i.e. in git (10); no collateral damage, such as an unrelated app broken, the live workload deleted, or plaintext secrets committed (5) |
| **Console evidence** | 25 | The incident note's facts match the truth *and* the matching information targets were visited in the Argo UI. Facts obtained only through `kubectl` earn half credit for this category (they still count fully toward the diagnosis) |
| **Diagnosis** | 20 | Failing resource, root cause and triggering revision are correct |
| **Operational practice** | 10 | Safe-habit signals (§10.2) |
| **Efficiency** | 10 | Weighted low; exploring the console is never penalized, only obvious thrashing (repeated no-op syncs, delete-and-hope loops) |

Rules:

- If the deployment isn't fixed, the run can't score above **50**, however good the diagnosis is.
- Assistance is reported separately, as in ELK.

### 10.2 Safe operating habits (observed, coached, lightly scored)

| Habit | Signal |
|---|---|
| Look before you sync | `diff_viewed` or `manifest_viewed` before a manual `sync_requested` |
| Don't fight a running operation | No `sync_requested` while an operation is Running; `operation_terminated` first |
| Fix the source, not the cluster | The final fix is in git; no reliance on live edits that self-heal reverts |
| Prune deliberately | Prune or Delete targets only the orphaned resources, not the whole app |
| Rollback as a stopgap | If `rollback_requested` is used, a git fix follows (with auto-sync on, rollback is refused or short-lived; the coach explains why) |
| Right environment | No actions on the healthy environment's app |
| Never commit plaintext secrets | No unencrypted `secrets.yaml` in any commit (always interrupts, even in Challenge) |

### 10.3 Debrief

The debrief is organized around the console. It shows a **map of where the evidence was**, meaning the information targets the learner visited and the ones they missed, each with a one-line "what you'd have seen there". It also shows the fix they made, as a commit link and a History entry. Lower down come the habit notes, the detours, and a reference route using this run's values. Replay options: same key, new key, less help, or the next level.

---

## 11. Mode mechanics

### 11.1 Demonstration pacing

ELK's timing (3× reading pause, cursor travel under 900 ms, visible typing) is kept. When auto-sync is slow, the coach narrates Argo's polling behaviour and presses **Refresh**. That is itself a lesson, not a workaround.

### 11.2 Guided dead ends (Argo rules)

| `reason_code` | Rule | Coach response |
|---|---|---|
| `wrong_app` | The learner acts on (not just views) an Application that isn't the target | "This one is healthy. The briefing mentioned production; check the env label." |
| `fix_broke_render` | A learner commit introduces a new ComparisonError | Quote the condition and point to `app.conditions` |
| `wrong_file_edited` | A commit doesn't touch the pack's `fix_paths` and doesn't change app state | Point back to the Desired manifest for the failing resource |
| `sync_while_running` | Sync requested during a Running operation | Explain, and point to Terminate in the operation panel |
| `live_edit_reverted` | A live-only change was undone by self-heal | Explain self-heal and show where the desired state comes from (`app.header` repo/path) |
| `deleted_live_workload` | The healthy Deployment was deleted during orphan cleanup | Explain that self-heal recreates it, and which resource was the orphan |
| `secret_leaked` | A plaintext secret was committed | Always shown in every mode, with removal steps |

The step clock (≥45 s; 90 s default for git and terminal steps), check-ins, drift logging and back-off are unchanged from ELK.

---

## 12. Architecture

```text
┌────────────────────────────────── k3s cluster ──────────────────────────────────┐
│   learner browser ──► lab-gateway (nginx, one origin)                           │
│                         ├─ /argocd/          ─► argocd-server  (+ coach injected)│
│                         ├─ /gitea/           ─► gitea          (+ coach injected)│
│                         ├─ /terminal/        ─► lab-terminal (ttyd, WS)          │
│                         ├─ /coach/assets/    ─► coach runtime + tokens.css       │
│                         ├─ /coach/learning/  ─► learning-service (HTTP + WS)     │
│                         └─ /                 ─► lab-launcher                     │
│   learning-service ◄──► scenario-controller (Go: run API, reset, injectors,     │
│                                              Detected/Fixed/Durable, /probe)    │
│   argocd 3.3.7 · gitea · shop-web-staging · shop-web-prod · postgres · …        │
└─────────────────────────────────────────────────────────────────────────────────┘
```

| Component | Responsibility |
|---|---|
| `lab-gateway` | Injects the bootstrap and coach into Argo and Gitea pages (`sub_filter`, `Accept-Encoding` stripped, `no-store` on `index.html`); proxies SSE unbuffered and WebSockets; sets the CSP header |
| `argocd-coach/` | Bootstrap, observer, adapters, Shadow-DOM UI on Argo tokens |
| `learning-service` | Ported ELK engine, information-target catalog, evidence checks, Argo validators, remediation-first scoring, Gitea webhook and terminal-event intake |
| `scenario-controller` | Run API; baseline reset (force-push the `baseline` tag + cleanup); parameterized injectors; `Detected` / `Fixed` / `Durable` predicates; `/probe`; **Free play** loop kept |
| `lab-terminal` | ttyd with `kubectl` (scoped RBAC), `git`, `sops`, `age`, `jq`, `yq`; key mounted; repo pre-cloned; prompt hook (redacted, best-effort, never required for credit) |
| `lab-launcher` | Curriculum view (levels, completion), mode, scenario key |

**Platform notes.** Locally, Traefik routes everything to the gateway. On iximiuz, the `argocd` tab on port 30080 points at the gateway, and the iximiuz terminal stays available (state-based validation still credits fixes made there). **Auth handoff**: the gateway sets `argocd.token` and a Gitea session from lab-only credentials. The admin/remotelab login keeps working for Free play (D4).

**Run lifecycle**: `CREATED → RESETTING → INJECTING → AWAITING_DETECTION → READY → INVESTIGATING → FIXED → COMPLETED` (plus `FAILED`/`ABORTED`), with one active run per cluster. Readiness uses pack-specific `Detected()` predicates, so the briefing never describes a symptom the console isn't showing yet. Level 1 missions skip INJECTING.

**Go scenario interface**: `Parameters()`, `Inject(ctx, git, params)`, `Detected()`, `Fixed()`, `Durable()`, `Cleanup()`. `Description`, `Explanation` and `DiagnoseCommands` move into the scenario packs, and `Revert` is replaced by baseline reset. Parameter values are chosen by the learning service's seeded `materialize()` and validated against `ParamSpec`.

---

## 13. Scenario pack contract

Same layout as ELK (`learning/{catalog.json, schemas/, selectors/, templates/, scenarios/<id>/}`), plus `learning/targets/argocd-3.3.json` (the information-target catalog). Each pack declares:

- `level`, `environment` parameter, `surfaces`, `skills`
- `injector` and `parameters`
- `readiness` (Detected), `fix_paths`, `fixed` and `durable` predicates
- `evidence`: the information targets that hold each decisive fact, plus the **evidence checks** built from them
- `truth`: failing resource, cause, triggering revision, acceptable fixes (described as outcomes)
- `habits`: which §10.2 habits apply
- `cleanup`

The shared goal arc is **Find → Read the symptom → Locate → Diagnose → Fix → Verify → Note**. Templates adjust it per category; for example, rendering failures have no meaningful tree to locate in, so *Locate* becomes `app.conditions`.

### Example: `stuck-sync` goals

| Goal | Information target(s) | Evidence check | Accepted remediation route(s) |
|---|---|---|---|
| Find | `apps.filter` → target env app | "Which app matches the briefing?" | — |
| Read the symptom | `app.header`, `app.operation` | "What phase is the current operation in, and for how long?" | — |
| Locate | `app.tree` → Pod | "Which resource is not Ready?" | — |
| Diagnose | `resource.events` (or `resource.manifest` for the probe) | "What does the probe failure event say?" (real event text + distractors) | — |
| Fix | `app.operation` (Terminate), `app.header` (repo/path to edit) | — | Terminate + commit a working probe path (Gitea or terminal) |
| Verify | `app.header`, `app.history` | "Which revision is now deployed?" | `fixed` + `durable` |
| Note | — | — | Incident note |

---

## 14. Scenarios by level, with randomization

| Scenario | Level | Key console targets | Fix | Seeded variation |
|---|---|---|---|---|
| Console orientation missions | 0 | All of §6.1 | — | Which app, revision, and resource each question asks about |
| missing-configmap | 1 | tree → pod → events, desired manifest | Git: restore the ref | Reference type (envFrom / keyRef / volume); missing name; environment |
| stuck-sync | 1–2 | operation panel, pod events | Terminate + git | Probe kind; bad path or port; environment |
| stale-job | 2 | operation panel → hook Job → logs | Git + re-sync | Failure mode (command / args / image tag) |
| orphaned-resource | 2 | tree/list "requires pruning", Service endpoints, diff | Git + **prune only the orphan** | New name; selector vs targetPort break |
| sops-decrypt-failure | 3 | app conditions | Terminal: re-encrypt | Corruption location |
| sops-global-mac-mismatch | 3 | app conditions | Terminal: `--ignore-mac` → re-encrypt | Corruption pattern |
| hmac-mismatch | 3 | app conditions | Terminal: re-encrypt from plaintext | Tampered value |
| wrong-type-sops | 3 | conditions / operation message | Terminal: re-encrypt a valid map | string / list / int / bad env name |
| env-drift *(new)* | 4 | compare staging vs prod `app.header` / `app.history` / diff | Git: align values | Which value; which env |
| repo-auth ssh→https *(new, notes.txt)* | 4 | `settings.repos`, app conditions | Argo settings / git | Auth method; error |

Applies to all of them: realistic commit messages and authors, and 0–2 **distractor commits**, so the newest commit isn't always the culprit and `app.history` must actually be read.

---

## 15. Delivery phases

### Phase 0: Spikes

- Gateway `sub_filter` injection into Argo 3.3.7; SSE passthrough; CSP; the `/tmp/extensions` alternative (D2).
- Network observer: the actual `/api/v1` endpoints and payloads for each UI action; URL parameters for view, node and tab. **Confirm everything against 3.3.7; don't guess.**
- **Styling**: prove the token extraction against the compiled Argo CSS; find the theme signal; check the font is available same-origin; build one coach panel inside Shadow DOM next to Argo's sliding panel in light and dark.
- Resource fit for the multi-app environment on the iximiuz VM.
- ttyd input over WS and the prompt hook; gateway auto-login.

Exit: a short findings note updating §7, §8 and §12.

### Phase 1: Realistic environment, run API, reset

- Multi-app environment (§4) with projects, labels and a seeded history; `baseline` tag.
- Controller run API, RESETTING, `Detected`/`Fixed`/`Durable`, `/probe`; Free play re-implemented on top of it.
- Schemas, target catalog, `materialize()`; packs for **stuck-sync** and **missing-configmap**.

Exit: seeded runs reach READY in either environment; reset recovers from any learner action; Go predicate tests pass across seeds.

### Phase 2: Coach shell, Argo styling, Demonstration, Level 1

- Gateway, bootstrap, handoff, auto-login; learning service; `argocd-adapter.js`, `gitea-adapter.js`.
- **The full Argo-styled component set (§8)**, generated `tokens.css`, theme following, coach mark.
- Launcher with the curriculum view; **Level 1 missions** in Demonstration and Guided (they need only navigation and evidence checks, so they're the cheapest end-to-end slice and the first thing a newcomer sees).
- Demonstration for the two Phase 1 packs.

Exit: a newcomer can complete Level 1 unaided in Guided; both packs run end to end in Demonstration, including a visible reference diff and Verify in the console; the coach matches Argo in light and dark themes.

### Phase 3: Guided failure scenarios

- Network/URL/DOM observers → information-target visits; evidence checks; Gitea webhook; `/probe` polling.
- Hint ladder, Show me, the "you can see this in Argo too" pointer, the §11.2 dead-end rules, and the guided debrief with the evidence map.

Exit: both packs are completable with a terminal Git push in Guided, with Argo evidence checks and an end-to-end debrief. A Gitea editor route is optional follow-up work.

### Phase 4: Terminal, Levels 3–4, Challenge

- `lab-terminal` and the terminal dock (styled like Argo's logs viewer).
- Packs: stale-job, orphaned-resource, the four SOPS scenarios.
- Challenge policy, the incident note, remediation-first scoring (§10), habit signals, and the debrief.

Exit: all eight scenarios × three modes pass the live matrix; an unfixed run can't score above 50; a live-only fix is flagged as not durable.

### Phase 5: Level 5, resilience, polish

- env-drift and repo-auth packs.
- Playwright recorder: reference videos, selector checks, and **visual-regression snapshots** of the coach over Argo pages in both themes, all run on Argo version bumps.
- Reconnect/resume, run timeouts, accessibility pass; iximiuz image and manifest updates so the launcher is the entry point.

---

## 16. Testing

- **Contracts (Python)**: packs match the schemas; `${param…}` references resolve; the target ids exist in the catalog; evidence checks resolve to answers across seeds; `ParamSpec` parity with Go.
- **Injectors and predicates (Go)**: inject → the render fails as expected → apply the reference fix → the render succeeds; `Detected`/`Fixed`/`Durable` checked against `/probe` fixtures, including a live-only fix (`Fixed` true, `Durable` false).
- **Evaluator fixtures**: the reference route; a kubectl-only diagnosis (full diagnosis credit, half console-evidence credit); fixed but no note; note but not fixed (≤50); plaintext leak; wrong environment.
- **Coach (node)**: ELK's clock and demo tests, plus network-observer tests against recorded Argo XHR fixtures and URL-parser tests.
- **Styling**: token extraction runs against the pinned Argo image and fails if tokens are missing; contrast checks on both themes; visual-regression snapshots (Phase 5).
- **Live**: the scenario × mode matrix; the Level 1 missions; a 20-reset soak with no drift from baseline.

---

## 17. Risks

| Risk | Mitigation |
|---|---|
| Argo UI changes break observers or styling | Network/URL-first observation; tokens extracted from the running version with a loud failure; a visual-regression check on each Argo bump |
| The coach is mistaken for real Argo UI | Coach mark, accent stripe, never inside Argo toolbars (§8.4) |
| The multi-app environment exceeds the iximiuz VM | Phase 0 sizing; staging runs at 0 replicas unless it's the target |
| Auto-sync latency makes Verify feel slow | Coach explains Refresh; enable the Gitea → Argo webhook (D11) |
| Evidence checks feel like a quiz | One line, inline, no penalty in Guided, built from real on-screen values, and always followed by *why* the fact lives there |
| Learners diagnose with kubectl and never learn the console | Accepted but steered back; console evidence is its own score category |
| Reset leaves state behind | Per-pack cleanup, terminate-before-reset, a health + HTTP gate, soak test |

---

## 18. Decision register

| # | Decision | Recommendation |
|---|---|---|
| D1 | Learning-service language | Port ELK's Python engine; Go stays for injection and k8s |
| D2 | Coach injection | nginx gateway `sub_filter`; evaluate Argo UI extensions in Phase 0 |
| D3 | Observation channel | Network + URL first, DOM as a small fallback |
| D4 | Learner identity | Gateway auto-login; define a scoped `learner` role that allows terminate, sync and delete in the lab apps |
| D5 | Fix surfaces | Argo UI and terminal are supported for MVP; Gitea editor is optional; SOPS requires the terminal |
| D6 | What ends a run | **Remediation** (`fixed`) plus an incident note, not a diagnosis alone |
| D7 | Proof of console learning | Information targets + evidence checks, never click sequences |
| D8 | Coach styling | Match Argo via extracted tokens, Shadow DOM, theme following; with a coach mark so it stays distinguishable |
| D9 | Environment | Multi-app, staging + production, projects and labels |
| D10 | Reset / concurrency | Force-push the baseline tag; one active run per cluster |
| D11 | Gitea → Argo webhook | Enable; faster, realistic feedback after a push |
| D12 | Free play | Keep as the default without the launcher |

---

## 19. Open questions

1. **App naming**: rename `django-app` to `shop-web-{staging,prod}` (more realistic, but touches every script and doc), or keep `django-app` for prod and add `django-app-staging`?
2. **Evidence checks in Challenge**: incident-note fields only (recommended), or also optional inline checks for learners who want confirmation?
3. **Demonstration git fixes**: MVP uses a server-side reference commit with an exact diff card. Revisit visible editor automation if learners need to see the editing process.
4. **Rollback scenarios**: add one where rollback is the *right* first move (auto-sync disabled for prod, which matches many real production setups), to teach when rollback is appropriate?
5. **Shared package with ELK-guide**: given the divergence in §2, probably only the UI primitives (cursor, spotlight, step clock) are worth sharing. Revisit after Phase 4.

---

## 20. Resulting repository layout

```text
argocd-coach/
├── src/
│   ├── argocd-bootstrap.js        handoff, boot overlay, network/URL observer install
│   ├── session-client.js · content-script.js (from ELK)
│   ├── action-observer.js         network + URL + DOM → actions + target visits
│   ├── argocd-adapter.js · gitea-adapter.js · terminal-adapter.js
│   └── ui/
│       ├── tokens.css             generated from Argo's compiled CSS
│       ├── theme.js               follows Argo's light/dark/auto setting
│       ├── shadow-host.js         Shadow DOM mount
│       └── cursor, spotlight, coach-panel, incident-briefing, evidence-check,
│           incident-note, debrief, terminal-dock
├── selectors/argocd-3.3.json
└── test/*.test.mjs
lab-gateway/ · lab-terminal/ · lab-launcher/
learning-service/                  server.py, engine/{contracts,evaluator,argo_validators,scoring}.py
learning/                          catalog, schemas, selectors, targets/, templates, scenarios/<id>/
scenario-controller/               + internal/{api,probe,reset}
scripts/extract-argocd-tokens.mjs
manifests/applications/            + staging/prod apps, projects, learning-service, gateway, terminal
tests/
```
