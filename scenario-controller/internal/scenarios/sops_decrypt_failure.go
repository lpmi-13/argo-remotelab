package scenarios

import (
	"fmt"
	"strings"

	"github.com/lpmi-13/argo-remotelab/scenario-controller/internal/git"
)

// SopsDecryptFailure corrupts the age-encrypted SOPS data key. SOPS can still
// identify the file as encrypted, but it cannot recover the data key, causing
// ArgoCD manifest generation to fail.
type SopsDecryptFailure struct{}

func (s *SopsDecryptFailure) Name() string {
	return "sops-decrypt-failure"
}

func (s *SopsDecryptFailure) Description() string {
	return "Corrupts the age-encrypted SOPS data key, making it impossible for " +
		"helm-secrets to decrypt the file during ArgoCD sync."
}

func (s *SopsDecryptFailure) Inject(gitClient *git.Client) error {
	return gitClient.CloneAndModifyOrphan(
		"chore: update encrypted secrets",
		func(w *git.WorkDir) error {
			data, err := w.ReadFile(SecretsFile)
			if err != nil {
				return fmt.Errorf("failed to read %s: %w", SecretsFile, err)
			}

			content := string(data)

			marker := "-----BEGIN AGE ENCRYPTED FILE-----\n"
			markerIdx := strings.Index(content, marker)
			if markerIdx == -1 {
				return fmt.Errorf("age encrypted data key block not found in %s", SecretsFile)
			}

			// Skip past the first line of base64 data (which encodes the age
			// protocol header "age-encryption.org/v1") so that SOPS/age can
			// still parse the envelope. Corrupt a byte on a later line so the
			// error is clearly about decryption failure, not format parsing.
			dataStart := markerIdx + len(marker)
			// Skip leading whitespace on first data line
			for dataStart < len(content) && (content[dataStart] == ' ' || content[dataStart] == '\t') {
				dataStart++
			}
			// Advance past the first base64 line to reach the second line
			newlineIdx := strings.IndexByte(content[dataStart:], '\n')
			if newlineIdx == -1 {
				return fmt.Errorf("age encrypted data key block is malformed in %s", SecretsFile)
			}
			corruptIdx := dataStart + newlineIdx + 1
			// Skip leading whitespace on second line
			for corruptIdx < len(content) && (content[corruptIdx] == ' ' || content[corruptIdx] == '\t') {
				corruptIdx++
			}
			if corruptIdx >= len(content) || content[corruptIdx] == '\n' || content[corruptIdx] == '-' {
				return fmt.Errorf("age encrypted data key block is too short in %s", SecretsFile)
			}

			replacement := byte('X')
			if content[corruptIdx] == replacement {
				replacement = 'Y'
			}

			modified := content[:corruptIdx] + string(replacement) + content[corruptIdx+1:]
			return w.WriteFile(SecretsFile, []byte(modified))
		},
	)
}

func (s *SopsDecryptFailure) Revert(gitClient *git.Client) error {
	// The user must restore or re-encrypt the SOPS file to fix this. Once the
	// application is healthy again, there is nothing else for the controller to
	// undo.
	return gitClient.CloneAndModify(
		"chore: restore encrypted secrets",
		func(w *git.WorkDir) error {
			return nil
		},
	)
}

func (s *SopsDecryptFailure) Explanation() string {
	return "The age-encrypted SOPS data key in secrets.yaml.enc was corrupted. SOPS can " +
		"still identify the file as encrypted, but it cannot decrypt the data key needed " +
		"to read the secret values, so helm-secrets fails during ArgoCD manifest " +
		"generation. This scenario rewrites the branch history around the bad SOPS file, " +
		"so the intended fix is to recreate the known plaintext secrets and encrypt a " +
		"fresh file with: " +
		"sops --encrypt --age <public-key> --input-type yaml --output-type yaml " +
		"secrets.yaml > secrets.yaml.enc"
}

func (s *SopsDecryptFailure) DiagnoseCommands() []string {
	return []string{
		"kubectl get applications -n argocd django-app -o jsonpath='{.status.conditions}'",
		"kubectl logs -n argocd -l app.kubernetes.io/name=argocd-repo-server --tail=50",
		"kubectl get applications -n argocd django-app -o jsonpath='{.status.sync.status}'",
	}
}
