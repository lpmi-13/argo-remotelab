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
