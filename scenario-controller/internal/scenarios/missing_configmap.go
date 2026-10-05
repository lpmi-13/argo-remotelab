package scenarios

import (
	"fmt"
	"strings"

	"github.com/lpmi-13/argo-remotelab/scenario-controller/internal/git"
)

// MissingConfigMap changes the Deployment's envFrom reference to a ConfigMap
// that does not exist. This causes pods to fail to start because the required
// ConfigMap cannot be mounted into the environment.
type MissingConfigMap struct{}

func (s *MissingConfigMap) Name() string {
	return "missing-configmap"
}

func (s *MissingConfigMap) Description() string {
	return "Changes the Deployment to reference a non-existent ConfigMap via envFrom, " +
		"causing pod startup failure."
}

func (s *MissingConfigMap) Inject(gitClient *git.Client) error {
	return gitClient.CloneAndModify(
		"chore: update application configuration",
		func(w *git.WorkDir) error {
			data, err := w.ReadFile(DeploymentFile)
			if err != nil {
				return fmt.Errorf("failed to read %s: %w", DeploymentFile, err)
			}

			modified, err := missingConfigVariant(string(data), gitClient.Seed())
			if err != nil {
				return err
			}
			return w.WriteFile(DeploymentFile, []byte(modified))
		},
	)
}

// Keep the missing name stable for evidence checks and reset RBAC, while the
// failing Kubernetes reference varies deterministically with the run seed.
func missingConfigVariant(content string, seed int64) (string, error) {
	const missingName = "django-app-missing-config"
	var marker, replacement string
	switch uint64(seed) % 3 {
	case 0: // envFrom: container configuration cannot be built.
		marker = "name: {{ include \"django-app.fullname\" . }}-config"
		replacement = "name: " + missingName
	case 1: // A required key in an otherwise valid environment block.
		marker = "        env:\n"
		replacement = "        env:\n        - name: LAB_REQUIRED_CONFIG\n          valueFrom:\n            configMapKeyRef:\n              name: " + missingName + "\n              key: APP_ENVIRONMENT\n"
	case 2: // A volume mount yields a FailedMount event in the Pod.
		marker = "    spec:\n      initContainers:"
		replacement = "    spec:\n      volumes:\n      - name: lab-required-config\n        configMap:\n          name: " + missingName + "\n      initContainers:"
	}
	modified := strings.Replace(content, marker, replacement, 1)
	if modified == content {
		return "", fmt.Errorf("failed to add missing ConfigMap reference to %s", DeploymentFile)
	}
	if uint64(seed)%3 == 2 {
		const containerMarker = "        imagePullPolicy: {{ .Values.image.pullPolicy }}"
		modified = strings.Replace(modified, containerMarker,
			containerMarker+"\n        volumeMounts:\n        - name: lab-required-config\n          mountPath: /etc/lab-required-config", 1)
		if !strings.Contains(modified, "        volumeMounts:\n        - name: lab-required-config") {
			return "", fmt.Errorf("failed to mount missing ConfigMap in %s", DeploymentFile)
		}
	}
	return modified, nil
}

func (s *MissingConfigMap) Revert(gitClient *git.Client) error {
	return gitClient.CloneAndModify(
		"chore: restore application configuration",
		func(w *git.WorkDir) error {
			data, err := w.ReadFile(DeploymentFile)
			if err != nil {
				return fmt.Errorf("failed to read %s: %w", DeploymentFile, err)
			}

			content := string(data)
			modified := strings.Replace(content,
				"name: django-app-missing-config",
				"name: {{ include \"django-app.fullname\" . }}-config",
				1,
			)

			return w.WriteFile(DeploymentFile, []byte(modified))
		},
	)
}

func (s *MissingConfigMap) Explanation() string {
	return "The Deployment's envFrom reference was changed to point at a ConfigMap that " +
		"does not exist. Kubernetes cannot start the pods while a required ConfigMap " +
		"reference is missing. The fix is to restore the ConfigMap reference or create " +
		"the expected ConfigMap."
}

func (s *MissingConfigMap) DiagnoseCommands() []string {
	return []string{
		"kubectl get pods -n applications",
		"kubectl describe pod -n applications -l app=django",
		"kubectl get configmap -n applications",
		"kubectl get events -n applications --sort-by=.lastTimestamp",
	}
}
