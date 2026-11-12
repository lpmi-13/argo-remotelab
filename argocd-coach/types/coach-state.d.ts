/* Demonstration progress that coach.js keeps in sessionStorage, so a
 * demonstration resumes where it was after Argo CD or Gitea loads a new page. */

/** Where a demonstration's repair has got to (see the repair section of coach.js). */
interface DemoRepair {
  plan: RepairPlan;
  /** The step in progress; plan.steps.length once the repair is complete. */
  step: number;
  /** How far a step that spans page loads has got, such as 'opening' or 'shown'. */
  stage: string | null;
  /** Commands of the current terminal step that have already run. */
  command: number;
  /** The terminal's checkout was checked, and stashed if needed, for this repair. */
  checkoutReady?: boolean;
  /** HEAD in the terminal after its last command: the pushed repair commit. */
  commit?: string;
  /** The step that could not finish, after which the reference repair took over. */
  fellBack?: string;
}

/** The reference repair's commit and diff, shown as "Source change" after a fallback. */
interface DemoPatch {
  commit: string;
  diff: string;
}

/** What the demonstration panel is narrating for one step. */
interface DemoNarration {
  id: string;
  phase: 'what' | 'locate' | 'doing' | 'learning';
  detail?: string;
  detailReason?: string;
}

/** How many times the demonstration has tried to open one check's location. */
interface DemoAttempts {
  id: string;
  count: number;
}
