/* Contract between learning-service/server.py and the coach.
 *
 * SessionView is what build_session_view() returns: the body of
 * GET /api/sessions/{id}, each WebSocket stream message, and the `session` in
 * action and run responses. Feedback is what score() returns.
 *
 * `npm run typecheck:contract` generates real server output for every
 * scenario, mode and run phase (learning-service/session_view_samples.py) and
 * checks it against these types with excess-property checks. When the server
 * adds, removes, renames or retypes a field, that check fails until this file
 * changes, and then `npm run typecheck` shows each coach use that must follow.
 */

type CoachMode = 'demonstration' | 'guided' | 'challenge';

type LabEnvironment = 'prod' | 'staging';

/** scenario-controller run states, plus UNKNOWN when the controller is unreachable. */
type RunState =
  | 'CREATED' | 'RESETTING' | 'INJECTING' | 'AWAITING_DETECTION'
  | 'READY' | 'INVESTIGATING' | 'FIXED'
  | 'COMPLETED' | 'FAILED' | 'ABORTED'
  | 'UNKNOWN';

type FixSurface = 'none' | 'argo' | 'git' | 'argo-and-git' | 'terminal';

/** Information targets named in learning/targets/argocd-3.5.json. */
type TargetId =
  | 'apps.list' | 'apps.filter'
  | 'app.header' | 'app.tree' | 'app.network' | 'app.list' | 'app.pods'
  | 'app.conditions' | 'app.operation' | 'app.history' | 'app.diff'
  | 'resource.summary' | 'resource.events' | 'resource.logs' | 'resource.manifest'
  | 'settings.repos';

interface Briefing {
  source: string;
  headline: string;
  summary: string;
}

/** Demonstration narration for one step (learning/incident-framing.json `demo`). */
interface DemoCopy {
  what: string;
  why: string;
  /** Present for evidence checks; the repair step has none. */
  look?: string;
}

/** One debrief line (learning/incident-framing.json `debrief`). */
interface DebriefCopy {
  action: string;
  finding: string;
}

interface Repair {
  action: string;
  reason: string;
  demo: DemoCopy;
  debrief: DebriefCopy;
}

interface SessionTarget {
  id: TargetId;
  where: string;
  visited: boolean;
}

interface NextCheck {
  id: string;
  target: TargetId;
  where: string;
  question: string;
  hint: string;
  action: string;
  reason: string;
  learning: string;
  demo: DemoCopy;
  /** True once the learner has visited one of the check's targets. */
  available: boolean;
  /** Demonstration mode only. */
  demonstration_answer?: string;
}

interface SessionAlert {
  reason_code: 'secret_leaked' | 'live_edit_reverted' | 'wrong_file_edited' | 'fix_broke_render';
  message: string;
}

/** A scenario's reference finding (pack.json `truth`). */
interface Truth {
  resource: string;
  cause: string;
  fix: string;
  evidence?: string;
}

interface DemonstrationNote extends Truth {
  revision: string;
}

/** The incident note the learner submits (POST /api/sessions/{id}/note). */
interface IncidentNote {
  resource: string;
  evidence: string;
  revision: string;
  cause: string;
  fix: string;
}

interface ScoreBreakdown {
  remediation: number;
  console_evidence: number;
  diagnosis: number;
  operational_practice: number;
  efficiency: number;
}

interface EvidenceMapEntry {
  target: TargetId;
  where: string;
  visited: boolean;
  fact: string;
}

/** Details of a Gitea push, recorded by the webhook. */
interface CommitDetails {
  files: string[];
  sha: string;
  message: string;
  force: boolean;
  via: 'gitea';
}

interface Feedback {
  /** Challenge mode only; null in Demonstration and Guided. */
  total: number | null;
  out_of: 100 | null;
  fixed: boolean;
  durable: boolean;
  breakdown: ScoreBreakdown;
  evidence_map: EvidenceMapEntry[];
  truth: Truth;
  trigger_revision: string;
  deployed_revision: string;
  fix_commit: CommitDetails | null;
  debrief_steps: DebriefCopy[];
  practice_notes: string[];
  note: IncidentNote;
  leaked_secret: boolean;
  assistance: {hints: number; show_me: number};
  message: string;
}

interface SessionView {
  session_id: string;
  run_id: string;
  mode: CoachMode;
  /** Null when the scenario controller could not be reached. */
  seed: number | null;
  state: RunState;
  run_error: string | null;
  run_updated_at: string | null;
  application: string;
  environment: LabEnvironment;
  scenario: {id: string; title: string; level: number};
  next_scenario: string | null;
  brief: string;
  briefing: Briefing;
  /** Null for level 1 orientation scenarios, which have no repair. */
  repair: Repair | null;
  fix_surface: FixSurface;
  fix_paths: string[];
  targets: SessionTarget[];
  /** Null in Challenge mode and once every check has passed. */
  next_check: NextCheck | null;
  checks_passed: number;
  checks_total: number;
  fixed: boolean;
  durable: boolean;
  /** Argo CD health and sync status; null before the first probe. */
  health: string | null;
  sync: string | null;
  revision: string;
  trigger_revision: string;
  serving_revision: string;
  feedback: Feedback | null;
  note_draft: IncidentNote | null;
  alert?: SessionAlert;
  /** Demonstration mode only. */
  demonstration_note?: DemonstrationNote;
}

/** The session in a POST /api/runs response, which carries its credentials once. */
interface NewSessionView extends SessionView {
  connection_token: string;
  investigation_url: string;
}

/** record_action() result. */
interface ActionEvaluation {
  accepted: boolean;
  correct?: boolean;
  message?: string;
  reason_code?: string;
}

/** POST /api/sessions/{id}/actions response. */
interface ActionResponse {
  evaluation: ActionEvaluation;
  session: SessionView;
}

/** A scenario-controller run, passed through by GET /api/runs/{id}. */
interface LabRun {
  id: string;
  scenario: string;
  environment: LabEnvironment;
  application: string;
  trigger_revision?: string;
  serving_revision?: string;
  seed: number;
  state: RunState;
  error?: string;
  created_at: string;
  updated_at: string;
}

/** POST /api/runs response. */
interface RunCreatedResponse {
  run: LabRun;
  session: NewSessionView;
}

/** POST /api/sessions/{id}/demonstrate-fix response (the controller's reference fix). */
interface DemonstrateFixResponse {
  commit?: string;
  diff?: string;
}
