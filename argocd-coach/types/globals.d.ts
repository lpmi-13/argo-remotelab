/* What the coach scripts share at runtime. The gateway injects them as classic
 * scripts (lab-gateway/nginx.conf): argocd-bootstrap, ui/theme, step-clock,
 * action-observer, then coach. They talk through these window globals and
 * window events. scenario-recorder/coach-ui.test.mjs stubs some globals, so
 * keep these surfaces small. */

/** sessionStorage `argo-coach:handoff`, written by the launcher or URL handoff. */
interface CoachHandoff {
  session: string;
  token: string;
  run: string;
  mode: CoachMode;
}

/** sessionStorage `argo-coach:preparing`, read by lab-launcher/preparing.html. */
interface PreparingRun {
  run_id: string;
  session_id: string;
  token: string;
  mode: CoachMode;
}

interface CoachBootstrapState {
  handoffKey: string;
  /** True while the bootstrap signs in to Argo CD or Gitea and will reload the page. */
  authPending: boolean;
}

/** An Argo CD API request seen by the bootstrap's fetch, XHR and EventSource hooks. */
interface CoachNetworkDetail {
  method: string;
  path: string;
  search: string;
  /** Present for POST .../sync, reported once Argo CD answers; accepted is false when it refused the sync. */
  sync?: {prune: boolean; dryRun: boolean; resources: {kind: string; name: string}[]; accepted?: boolean};
}

/** Records one learner action; coach.js sends it to the learning service. */
type CoachActionEmitter = (type: string, details: Record<string, unknown>) => unknown;

interface ArgoActionObserverInstance {
  visit(target: string, application?: string): void;
  fromURL(href: string): void;
}

interface CoachTheme {
  /** Keeps host's data-theme and colors in step with Argo; returns a stop function. */
  followTheme(host: HTMLElement): () => void;
}

interface Window {
  ArgoCoachBootstrap?: CoachBootstrapState;
  ArgoCoachTheme?: CoachTheme;
  GuidedStepClock: typeof import('../src/step-clock.js');
  ArgoActionObserver: new (emit: CoachActionEmitter) => ArgoActionObserverInstance;
}

interface WindowEventMap {
  'argo-coach:url': CustomEvent<{href: string}>;
  'argo-coach:network': CustomEvent<CoachNetworkDetail>;
  'argo-coach:auth-failed': Event;
}

/* Every element the coach meets is an HTML, SVG or MathML element, and all
 * three have focus(), dataset and style. Declaring them on Element spares a
 * cast at each querySelector() in the DOM-probing code. HTML-only members such
 * as click(), hidden and value still need an HTMLElement type. */
interface Element extends HTMLOrSVGElement, ElementCSSInlineStyle {}

interface XMLHttpRequest {
  /** Set by the bootstrap's open() hook so send() can report the request. */
  __argoCoachRequest?: {method: string; url: string | URL};
}
