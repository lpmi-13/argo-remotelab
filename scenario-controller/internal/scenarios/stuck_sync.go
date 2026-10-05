package scenarios

import (
	"fmt"
	"strings"

	"github.com/lpmi-13/argo-remotelab/scenario-controller/internal/git"
)

// StuckSync changes the health check path in values.yaml to a non-existent
// endpoint. This causes the readiness and liveness probes to fail, meaning pods
// never become Ready. The ArgoCD sync will be stuck in "Progressing" because the
// Deployment can never reach a healthy state. The user must terminate the sync,
// fix the health check path, and re-sync.
type StuckSync struct{}

func (s *StuckSync) Name() string {
	return "stuck-sync"
}

func (s *StuckSync) Description() string {
	return "Changes the health check path to a non-existent endpoint (/api/nonexistent/), " +
		"causing readiness probes to fail and the sync to get stuck in Progressing state."
}

func (s *StuckSync) Inject(gitClient *git.Client) error {
	return gitClient.CloneAndModify(
		"chore: update health check configuration",
		func(w *git.WorkDir) error {
			data, err := w.ReadFile(ValuesFile)
			if err != nil {
				return fmt.Errorf("failed to read %s: %w", ValuesFile, err)
			}

			content := string(data)

			// Replace the health check path with a non-existent one.
			modified := strings.Replace(content,
				"path: /api/health/",
				"path: /api/nonexistent/",
				1,
			)

			if modified == content {
				return fmt.Errorf("health check path not found in values.yaml")
			}

			modified = strings.Replace(modified, "postSyncVerify: false", "postSyncVerify: true", 1)
			if !strings.Contains(modified, "postSyncVerify: true") {
				return fmt.Errorf("post-sync verification flag not found in values.yaml")
			}
			return w.WriteFile(ValuesFile, []byte(modified))
		},
	)
}

func (s *StuckSync) Revert(gitClient *git.Client) error {
	return gitClient.CloneAndModify(
		"chore: restore health check configuration",
		func(w *git.WorkDir) error {
			data, err := w.ReadFile(ValuesFile)
			if err != nil {
				return fmt.Errorf("failed to read %s: %w", ValuesFile, err)
			}

			content := string(data)
			modified := strings.Replace(content,
				"path: /api/nonexistent/",
				"path: /api/health/",
				1,
			)
			modified = strings.Replace(modified, "postSyncVerify: true", "postSyncVerify: false", 1)

			return w.WriteFile(ValuesFile, []byte(modified))
		},
	)
}

func (s *StuckSync) Explanation() string {
	return "The healthCheck.path in values.yaml was changed from /api/health/ to " +
		"/api/nonexistent/. This caused both the readiness and liveness probes to fail " +
		"because the endpoint does not exist (returns 404). Kubernetes never marks the pod " +
		"as Ready, so the Deployment rollout cannot complete, and ArgoCD's sync stays stuck " +
		"in the 'Progressing' state. The fix is to change the healthCheck.path back to " +
		"/api/health/ (or another valid endpoint) in values.yaml."
}

func (s *StuckSync) DiagnoseCommands() []string {
	return []string{
		"kubectl get pods -n applications",
		"kubectl describe pod -n applications -l app=django",
		"kubectl get events -n applications --sort-by=.lastTimestamp | grep -i unhealthy",
		"kubectl get applications -n argocd django-app -o jsonpath='{.status.health.status}'",
		"kubectl rollout status deployment/django -n applications --timeout=10s",
	}
}
