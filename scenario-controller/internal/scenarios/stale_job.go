package scenarios

import (
	"fmt"
	"strings"

	"github.com/lpmi-13/argo-remotelab/scenario-controller/internal/git"
)

// The trigger annotation goes on the pod template next to the scrape
// annotation. Anchoring on that line alone leaves room for other annotations,
// such as the run stamp the controller adds to every baseline.
const (
	staleJobAnchor  = "        prometheus.io/scrape: \"true\"\n"
	staleJobTrigger = "        remotelab.io/stale-job-trigger: \"enabled\"\n"
)

func addStaleJobTrigger(deployment string) (string, error) {
	if strings.Count(deployment, staleJobAnchor) != 1 {
		return "", fmt.Errorf("could not add sync trigger annotation in deployment.yaml")
	}
	return strings.Replace(deployment, staleJobAnchor, staleJobTrigger+staleJobAnchor, 1), nil
}

// StaleJob modifies the migration Job template so the PreSync migration fails.
// ArgoCD cannot complete the sync while the hook Job is failing.
type StaleJob struct{}

func (s *StaleJob) Name() string {
	return "stale-job"
}

func (s *StaleJob) Description() string {
	return "Modifies the migration Job template so the PreSync migration hook fails, " +
		"blocking the ArgoCD sync."
}

func (s *StaleJob) Inject(gitClient *git.Client) error {
	return gitClient.CloneAndModify(
		"chore: update migration job configuration",
		func(w *git.WorkDir) error {
			data, err := w.ReadFile(MigrateJobFile)
			if err != nil {
				return fmt.Errorf("failed to read %s: %w", MigrateJobFile, err)
			}

			content := string(data)

			marker := "          set -e\n          echo \"Running Django migrations...\""
			injection := "          set -e\n          echo \"ERROR: migration dependency check failed\"\n          exit 1\n          echo \"Running Django migrations...\""

			modified := strings.Replace(content, marker, injection, 1)

			if modified == content {
				return fmt.Errorf("could not find insertion point in migrate-job.yaml")
			}
			modified = strings.Replace(modified, "  backoffLimit: 3", "  backoffLimit: 0", 1)
			if !strings.Contains(modified, "  backoffLimit: 0") {
				return fmt.Errorf("could not set hook retry limit in migrate-job.yaml")
			}

			if err := w.WriteFile(MigrateJobFile, []byte(modified)); err != nil {
				return err
			}

			deployData, err := w.ReadFile(DeploymentFile)
			if err != nil {
				return fmt.Errorf("failed to read %s: %w", DeploymentFile, err)
			}

			deployModified, err := addStaleJobTrigger(string(deployData))
			if err != nil {
				return err
			}

			return w.WriteFile(DeploymentFile, []byte(deployModified))
		},
	)
}

func (s *StaleJob) Revert(gitClient *git.Client) error {
	return gitClient.CloneAndModify(
		"chore: restore migration job configuration",
		func(w *git.WorkDir) error {
			data, err := w.ReadFile(MigrateJobFile)
			if err != nil {
				return fmt.Errorf("failed to read %s: %w", MigrateJobFile, err)
			}

			content := string(data)

			injection := "          set -e\n          echo \"ERROR: migration dependency check failed\"\n          exit 1\n          echo \"Running Django migrations...\""
			marker := "          set -e\n          echo \"Running Django migrations...\""

			modified := strings.Replace(content, injection, marker, 1)
			modified = strings.Replace(modified, "  backoffLimit: 0", "  backoffLimit: 3", 1)
			if err := w.WriteFile(MigrateJobFile, []byte(modified)); err != nil {
				return err
			}

			deployData, err := w.ReadFile(DeploymentFile)
			if err != nil {
				return fmt.Errorf("failed to read %s: %w", DeploymentFile, err)
			}

			deployModified := strings.Replace(string(deployData), staleJobTrigger, "", 1)
			return w.WriteFile(DeploymentFile, []byte(deployModified))
		},
	)
}

func (s *StaleJob) Explanation() string {
	return "The PreSync migration Job was changed to fail before running Django migrations. " +
		"ArgoCD waits for hook Jobs to complete before applying the rest of the sync, so the " +
		"application stays stuck in a failed/progressing sync state. A Deployment annotation " +
		"was also changed to create a normal resource diff, which forces ArgoCD to run the " +
		"PreSync hook. The fix is to remove the failing command from the migration Job template " +
		"and sync again."
}

func (s *StaleJob) DiagnoseCommands() []string {
	return []string{
		"kubectl get jobs -n applications",
		"kubectl logs -n applications -l job-name=django-migrate-latest --tail=50",
		"kubectl get applications -n argocd django-app -o jsonpath='{.status.operationState.message}'",
		"kubectl get applications -n argocd django-app -o jsonpath='{.status.conditions}'",
		"kubectl describe job -n applications -l app.kubernetes.io/component=migration",
	}
}
