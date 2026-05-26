package scenarios

import (
	"fmt"
	"log"
	"math/rand"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/lpmi-13/argo-remotelab/scenario-controller/internal/git"
)

type wrongTypeSopsVariant struct {
	name      string
	plaintext string
}

var wrongTypeSopsVariants = []wrongTypeSopsVariant{
	{
		name: "string",
		plaintext: `# Secrets for django-app
secrets: "not-a-map"
`,
	},
	{
		name: "list",
		plaintext: `# Secrets for django-app
secrets:
  - DB_PASSWORD=not-a-map
  - SECRET_KEY=wrong-list-shape
`,
	},
	{
		name: "int",
		plaintext: `# Secrets for django-app
secrets: 404
`,
	},
	{
		name: "map",
		plaintext: `# Secrets for django-app
secrets:
  invalid-env-name: "wrong-map-shape"
`,
	},
}

// WrongTypeSops re-encrypts the secrets file with a value that does not match
// the chart's expected secrets map of environment variable names to scalar
// strings. Depending on the variant, ArgoCD fails during manifest generation or
// while applying the rendered Deployment.
type WrongTypeSops struct{}

func (s *WrongTypeSops) Name() string {
	return "wrong-type-sops"
}

func (s *WrongTypeSops) Description() string {
	return "Re-encrypts the secrets file with a random wrong YAML shape for .Values.secrets " +
		"(string, list, int, or invalid map), causing ArgoCD rendering or sync to fail."
}

func (s *WrongTypeSops) Inject(gitClient *git.Client) error {
	return gitClient.CloneAndModifyOrphan(
		"chore: update database secrets",
		func(w *git.WorkDir) error {
			ageKey := gitClient.SopsAgeKey()
			agePubKey := gitClient.AgePublicKey()

			if ageKey == "" || agePubKey == "" {
				return fmt.Errorf("SOPS_AGE_KEY or AGE_PUBLIC_KEY not configured")
			}

			variant := randomWrongTypeSopsVariant()
			log.Printf("injecting wrong-type-sops variant: %s", variant.name)
			plaintext := variant.plaintext

			plaintextPath := filepath.Join(w.Dir(), "plaintext-secrets.yaml")
			if err := os.WriteFile(plaintextPath, []byte(plaintext), 0o644); err != nil {
				return fmt.Errorf("failed to write plaintext secrets: %w", err)
			}
			defer os.Remove(plaintextPath)

			// Write the age key to a temp file for sops.
			keyFile, err := os.CreateTemp("", "age-key-*")
			if err != nil {
				return fmt.Errorf("failed to create temp key file: %w", err)
			}
			defer os.Remove(keyFile.Name())

			if _, err := keyFile.WriteString(ageKey); err != nil {
				keyFile.Close()
				return fmt.Errorf("failed to write age key: %w", err)
			}
			keyFile.Close()

			// Encrypt with sops.
			outputPath := w.FilePath(SecretsFile)
			cmd := exec.Command("sops",
				"--encrypt",
				"--age", agePubKey,
				"--input-type", "yaml",
				"--output-type", "yaml",
				"--output", outputPath,
				plaintextPath,
			)
			cmd.Env = append(os.Environ(),
				fmt.Sprintf("SOPS_AGE_KEY_FILE=%s", keyFile.Name()),
			)

			output, err := cmd.CombinedOutput()
			if err != nil {
				return fmt.Errorf("sops encrypt failed: %w\noutput: %s", err, string(output))
			}

			return nil
		},
	)
}

func (s *WrongTypeSops) Revert(gitClient *git.Client) error {
	// The user must restore or re-encrypt the SOPS file with a valid map. Once
	// ArgoCD is Healthy+Synced again, their fixed file is already the desired
	// state and the controller should not overwrite it with a fresh encryption.
	return nil
}

func (s *WrongTypeSops) Explanation() string {
	return "The secrets.yaml.enc file was re-encrypted with .Values.secrets set to a value " +
		"that does not match the chart's expected map of environment variable names to scalar " +
		"strings. The injected value may be a string, list, int, or a map with an invalid " +
		"environment variable name, so ArgoCD cannot render or apply the Deployment as expected. " +
		"The fix is to re-encrypt secrets.yaml.enc with a proper secrets map."
}

func (s *WrongTypeSops) DiagnoseCommands() []string {
	return []string{
		"kubectl get pods -n applications",
		"kubectl describe pod -n applications -l app=django",
		"kubectl logs -n applications -l app=django --tail=30",
		"kubectl get applications -n argocd django-app -o jsonpath='{.status.operationState.message}'",
	}
}

func randomWrongTypeSopsVariant() wrongTypeSopsVariant {
	return wrongTypeSopsVariants[rand.Intn(len(wrongTypeSopsVariants))]
}
