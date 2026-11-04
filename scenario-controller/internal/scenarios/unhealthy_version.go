package scenarios

import (
	"fmt"
	"strings"

	"github.com/lpmi-13/argo-remotelab/scenario-controller/internal/git"
)

// UnhealthyVersion gives the Level 1 health exercise a deployed revision whose
// workload cannot become ready. Recreate removes the old ready pod so the
// selected shop service also has no healthy endpoint.
type UnhealthyVersion struct{}

func (s *UnhealthyVersion) Name() string { return "console-unhealthy-version" }
func (s *UnhealthyVersion) Description() string {
	return "Deploys a shop release with a failing readiness probe and no ready service endpoint."
}
func (s *UnhealthyVersion) Explanation() string {
	return "The deployed release has a readiness path that returns 404. History identifies its commit while Application health shows the workload is not ready."
}
func (s *UnhealthyVersion) DiagnoseCommands() []string { return nil }

func (s *UnhealthyVersion) Inject(client *git.Client) error {
	return client.CloneAndModify("release: update shop readiness policy", func(w *git.WorkDir) error {
		values, err := w.ReadFile(ValuesFile)
		if err != nil {
			return err
		}
		changedValues := strings.Replace(string(values), "path: /api/health/", "path: /api/unready/", 1)
		if changedValues == string(values) {
			return fmt.Errorf("health path not found in %s", ValuesFile)
		}
		deployment, err := w.ReadFile(DeploymentFile)
		if err != nil {
			return err
		}
		changedDeployment := strings.Replace(string(deployment),
			"  replicas: 1\n  selector:", "  replicas: 1\n  strategy:\n    type: Recreate\n    rollingUpdate: null\n  selector:", 1)
		if changedDeployment == string(deployment) {
			return fmt.Errorf("deployment strategy anchor not found in %s", DeploymentFile)
		}
		if err := w.WriteFile(ValuesFile, []byte(changedValues)); err != nil {
			return err
		}
		return w.WriteFile(DeploymentFile, []byte(changedDeployment))
	})
}

func (s *UnhealthyVersion) Revert(client *git.Client) error {
	return client.CloneAndModify("fix: restore shop readiness policy", func(w *git.WorkDir) error {
		values, err := w.ReadFile(ValuesFile)
		if err != nil {
			return err
		}
		changedValues := strings.Replace(string(values), "path: /api/unready/", "path: /api/health/", 1)
		if changedValues == string(values) {
			return fmt.Errorf("unhealthy path not found in %s", ValuesFile)
		}
		deployment, err := w.ReadFile(DeploymentFile)
		if err != nil {
			return err
		}
		changedDeployment := strings.Replace(string(deployment),
			"  replicas: 1\n  strategy:\n    type: Recreate\n    rollingUpdate: null\n  selector:", "  replicas: 1\n  selector:", 1)
		if changedDeployment == string(deployment) {
			return fmt.Errorf("Recreate strategy not found in %s", DeploymentFile)
		}
		if err := w.WriteFile(ValuesFile, []byte(changedValues)); err != nil {
			return err
		}
		return w.WriteFile(DeploymentFile, []byte(changedDeployment))
	})
}
