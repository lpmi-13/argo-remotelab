package scenarios

import (
	"fmt"
	"strings"

	"github.com/lpmi-13/argo-remotelab/scenario-controller/internal/git"
)

// EnvDrift breaks the probe path in one environment while the sibling remains
// healthy. The learner compares the two Applications and repairs the value in
// the targeted chart.
type EnvDrift struct{}

func (s *EnvDrift) Name() string { return "env-drift" }
func (s *EnvDrift) Description() string {
	return "Changes one environment's readiness probe while the other remains healthy."
}
func (s *EnvDrift) Explanation() string {
	return "Only one environment's chart had an invalid readiness path. Comparing the two Application revisions and desired manifests exposes the drift."
}
func (s *EnvDrift) DiagnoseCommands() []string {
	return []string{"kubectl get applications -n argocd shop-web-prod shop-web-staging", "kubectl get pods -n applications", "kubectl get pods -n shop-staging"}
}
func (s *EnvDrift) Inject(client *git.Client) error {
	return client.CloneAndModify("release: adjust environment health endpoint", func(w *git.WorkDir) error {
		data, err := w.ReadFile(ValuesFile)
		if err != nil {
			return err
		}
		changed := strings.Replace(string(data), "path: /api/health/", "path: /api/legacy-health/", 1)
		if changed == string(data) {
			return fmt.Errorf("health path not found in %s", ValuesFile)
		}
		return w.WriteFile(ValuesFile, []byte(changed))
	})
}
func (s *EnvDrift) Revert(client *git.Client) error {
	return client.CloneAndModify("fix: restore environment health endpoint", func(w *git.WorkDir) error {
		data, err := w.ReadFile(ValuesFile)
		if err != nil {
			return err
		}
		return w.WriteFile(ValuesFile, []byte(strings.Replace(string(data), "path: /api/legacy-health/", "path: /api/health/", 1)))
	})
}
