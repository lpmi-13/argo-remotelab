/* The parts of Argo CD's own API the coach reads. Unlike the session view,
 * nothing checks these against a real Argo CD: review them, and the selectors
 * in selectors/argocd-*.json, when moving to a new Argo CD version. */

/** A node in GET /api/v1/applications/{name}/resource-tree (Argo CD 3.5). */
interface ArgoResourceNode {
  group?: string;
  kind: string;
  namespace?: string;
  name: string;
  health?: {status?: string};
}

/** The parts of GET /api/v1/applications/{name} (Argo CD 3.5) a demonstration's repair reads. */
interface ArgoApplication {
  status?: {
    sync?: {status?: string; revision?: string};
    operationState?: {phase?: string; startedAt?: string};
    resources?: {group?: string; kind: string; namespace?: string; name: string; requiresPruning?: boolean}[];
  };
}

/* ttyd 1.7 serves xterm.js and exposes its terminal as window.term. A
 * demonstration types through it, so the shell echoes each keystroke. */

/** The parts of xterm.js's Terminal the coach uses. */
interface XtermTerminal {
  cols: number;
  rows: number;
  element?: HTMLElement;
  focus(): void;
  /** Sends data as if the user typed it. */
  input(data: string, wasUserInput?: boolean): void;
  buffer: {active: {
    baseY: number;
    cursorX: number;
    cursorY: number;
    getLine(row: number): {isWrapped: boolean; translateToString(trimRight?: boolean): string} | undefined;
  }};
}

interface TtydWindow extends Window {
  term?: XtermTerminal;
}
