package scenarios

import (
	"fmt"

	"github.com/lpmi-13/argo-remotelab/scenario-controller/internal/git"
)

// RepoAuth is injected through the Argo Application source, not a chart file.
// The run API handles its source URL change directly.
type RepoAuth struct{}

func (s *RepoAuth) Name() string { return "repo-auth" }
func (s *RepoAuth) Description() string {
	return "Switches the Application to an SSH repository URL without credentials."
}
func (s *RepoAuth) Inject(_ *git.Client) error {
	return fmt.Errorf("repo-auth must be injected by the run API")
}
func (s *RepoAuth) Revert(_ *git.Client) error { return nil }
func (s *RepoAuth) Explanation() string {
	return "The Application source was switched to an SSH URL without a deploy key. The working local lab repository uses authenticated HTTP."
}
func (s *RepoAuth) DiagnoseCommands() []string {
	return []string{"kubectl get application shop-web-prod -n argocd -o yaml", "kubectl get secret gitea-repo -n argocd -o yaml"}
}
