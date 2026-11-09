/* Demonstration progress that coach.js keeps in sessionStorage, so a
 * demonstration resumes where it was after Argo CD or Gitea loads a new page. */

/** Where a demonstration's Git repair has got to. */
interface DemoGitStep {
  phase: 'source' | 'commit' | 'committing' | 'review' | 'return';
  /** Gitea path of the file being repaired. */
  source?: string;
  commit?: string;
}

/** The reference fix's commit and diff, shown as "Source change". */
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
