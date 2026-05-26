package scenarios

import (
	"fmt"
	"strings"

	"github.com/lpmi-13/argo-remotelab/scenario-controller/internal/git"
)

// HMACMismatch modifies encrypted secret value bytes in the SOPS file. This is
// stricter than a global SOPS MAC mismatch: the damaged value cannot be
// recovered with --ignore-mac because its AES-GCM authentication fails.
type HMACMismatch struct{}

func (s *HMACMismatch) Name() string {
	return "hmac-mismatch"
}

func (s *HMACMismatch) Description() string {
	return "Modifies encrypted secret value ciphertext in the SOPS file, causing " +
		"per-value AES-GCM authentication failure during decryption."
}

func (s *HMACMismatch) Inject(gitClient *git.Client) error {
	return gitClient.CloneAndModifyOrphan(
		"chore: update encrypted secrets configuration",
		func(w *git.WorkDir) error {
			data, err := w.ReadFile(SecretsFile)
			if err != nil {
				return fmt.Errorf("failed to read %s: %w", SecretsFile, err)
			}

			modified, err := tamperSopsCiphertext(string(data))
			if err != nil {
				return fmt.Errorf("%w in %s", err, SecretsFile)
			}

			return w.WriteFile(SecretsFile, []byte(modified))
		},
	)
}

func tamperSopsCiphertext(content string) (string, error) {
	// Find the sops metadata block to ensure we only modify encrypted values
	// above it. The encrypted top comment is not rendered into Helm values, so
	// changing that line does not create an ArgoCD failure.
	sopsIdx := strings.Index(content, "\nsops:\n")
	if sopsIdx == -1 {
		return "", fmt.Errorf("sops metadata block not found")
	}

	dataSection := content[:sopsIdx]
	sopsSection := content[sopsIdx:]

	encPrefix := "ENC[AES256_GCM,data:"
	searchStart := 0

	for {
		relativeIdx := strings.Index(dataSection[searchStart:], encPrefix)
		if relativeIdx == -1 {
			return "", fmt.Errorf("no encrypted data values found")
		}

		encIdx := searchStart + relativeIdx
		lineStart := strings.LastIndex(dataSection[:encIdx], "\n") + 1
		linePrefix := strings.TrimSpace(dataSection[lineStart:encIdx])
		if strings.HasPrefix(linePrefix, "#") {
			searchStart = encIdx + len(encPrefix)
			continue
		}

		dataStart := encIdx + len(encPrefix)
		commaIdx := strings.Index(dataSection[dataStart:], ",")
		if commaIdx == -1 {
			return "", fmt.Errorf("malformed encrypted value")
		}

		encData := dataSection[dataStart : dataStart+commaIdx]
		if len(encData) < 4 {
			return "", fmt.Errorf("encrypted data too short to tamper with")
		}

		tampered := []byte(encData)
		for i := 0; i < len(tampered) && i < 4; i++ {
			tampered[i] = flipBase64Byte(tampered[i])
		}

		modified := dataSection[:dataStart] + string(tampered) + dataSection[dataStart+commaIdx:]
		return modified + sopsSection, nil
	}
}

func flipBase64Byte(b byte) byte {
	switch {
	case b >= 'a' && b <= 'z':
		return 'A' + (b - 'a')
	case b >= 'A' && b <= 'Z':
		return 'a' + (b - 'A')
	case b >= '0' && b <= '9':
		return '9' - (b - '0')
	default:
		return b
	}
}

func (s *HMACMismatch) Revert(gitClient *git.Client) error {
	// The user must restore or re-encrypt the secrets file from known-good
	// plaintext to fix the damaged value ciphertext.
	// After they fix it, revert is a no-op since the file should be valid.
	return gitClient.CloneAndModify(
		"chore: restore encrypted secrets integrity",
		func(w *git.WorkDir) error {
			return nil
		},
	)
}

func (s *HMACMismatch) Explanation() string {
	return "Encrypted secret value bytes in secrets.yaml.enc were modified. This is not " +
		"recoverable with sops --ignore-mac because the individual value ciphertext no " +
		"longer passes AES-GCM authentication. This scenario rewrites the branch history " +
		"around the bad SOPS file, so the intended fix is to re-encrypt secrets.yaml.enc " +
		"from known-good plaintext."
}

func (s *HMACMismatch) DiagnoseCommands() []string {
	return []string{
		"kubectl get applications -n argocd django-app -o jsonpath='{.status.conditions}'",
		"kubectl logs -n argocd -l app.kubernetes.io/name=argocd-repo-server --tail=50",
		"kubectl get applications -n argocd django-app -o jsonpath='{.status.operationState.message}'",
	}
}
