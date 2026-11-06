package scenarios

import (
	"fmt"
	"strings"

	"github.com/lpmi-13/argo-remotelab/scenario-controller/internal/git"
)

// UnhealthyVersion leaves the previous ready pod serving while a new revision
// fails readiness. The learner must distinguish Argo's latest sync from the
// revision still receiving traffic.
type UnhealthyVersion struct{}

const rollingStrategy = "  strategy:\n    type: RollingUpdate\n    rollingUpdate:\n      maxSurge: 1\n      maxUnavailable: 0\n"

func (s *UnhealthyVersion) Name() string { return "console-unhealthy-version" }
func (s *UnhealthyVersion) Description() string {
	return "Starts an unready shop rollout while the previous ready release keeps serving."
}
func (s *UnhealthyVersion) Explanation() string {
	return "The new release has a readiness path that returns 404. Argo records its sync, but the previous ready pod still serves the shop."
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
			"  replicas: 1\n  selector:", "  replicas: 1\n"+rollingStrategy+"  selector:", 1)
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
			"  replicas: 1\n"+rollingStrategy+"  selector:", "  replicas: 1\n  selector:", 1)
		if changedDeployment == string(deployment) {
			return fmt.Errorf("rolling update strategy not found in %s", DeploymentFile)
		}
		if err := w.WriteFile(ValuesFile, []byte(changedValues)); err != nil {
			return err
		}
		return w.WriteFile(DeploymentFile, []byte(changedDeployment))
	})
}
