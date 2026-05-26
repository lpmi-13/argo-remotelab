package scenarios

import (
	"fmt"
	"strings"

	"github.com/lpmi-13/argo-remotelab/scenario-controller/internal/git"
)

// SopsGlobalMACMismatch corrupts only the SOPS metadata MAC. The encrypted data
// key and encrypted values remain decryptable, so users can recover plaintext
// with sops --ignore-mac and then re-encrypt the file to write a valid MAC.
type SopsGlobalMACMismatch struct{}

func (s *SopsGlobalMACMismatch) Name() string {
	return "sops-global-mac-mismatch"
}

func (s *SopsGlobalMACMismatch) Description() string {
	return "Corrupts only the global SOPS MAC metadata, leaving encrypted values " +
		"recoverable with sops --ignore-mac before re-encryption."
}

func (s *SopsGlobalMACMismatch) Inject(gitClient *git.Client) error {
	return gitClient.CloneAndModifyOrphan(
		"chore: update encrypted secrets metadata",
		func(w *git.WorkDir) error {
			data, err := w.ReadFile(SecretsFile)
			if err != nil {
				return fmt.Errorf("failed to read %s: %w", SecretsFile, err)
			}

			modified, err := tamperSopsGlobalMAC(string(data))
			if err != nil {
				return fmt.Errorf("%w in %s", err, SecretsFile)
			}

			return w.WriteFile(SecretsFile, []byte(modified))
		},
	)
}

func tamperSopsGlobalMAC(content string) (string, error) {
	sopsIdx := strings.Index(content, "\nsops:\n")
	if sopsIdx == -1 {
		if !strings.HasPrefix(content, "sops:\n") {
			return "", fmt.Errorf("sops metadata block not found")
		}
		sopsIdx = 0
	} else {
		sopsIdx++
	}

	dataSection := content[:sopsIdx]
	sopsSection := content[sopsIdx:]
	macPrefix := "mac: ENC[AES256_GCM,data:"
	searchStart := 0

	for {
		relativeIdx := strings.Index(sopsSection[searchStart:], macPrefix)
		if relativeIdx == -1 {
			return "", fmt.Errorf("sops mac metadata not found")
		}

		macIdx := searchStart + relativeIdx
		lineStart := strings.LastIndex(sopsSection[:macIdx], "\n") + 1
		if strings.TrimSpace(sopsSection[lineStart:macIdx]) != "" {
			searchStart = macIdx + len(macPrefix)
			continue
		}

		dataStart := macIdx + len(macPrefix)
		commaIdx := strings.Index(sopsSection[dataStart:], ",")
		if commaIdx == -1 {
			return "", fmt.Errorf("malformed sops mac metadata")
		}

		macData := sopsSection[dataStart : dataStart+commaIdx]
		if len(macData) < 4 {
			return "", fmt.Errorf("sops mac metadata is too short to tamper with")
		}

		tampered := []byte(macData)
		for i := 0; i < len(tampered) && i < 4; i++ {
			tampered[i] = replaceBase64Byte(tampered[i])
		}

		modifiedSopsSection := sopsSection[:dataStart] + string(tampered) + sopsSection[dataStart+commaIdx:]
		return dataSection + modifiedSopsSection, nil
	}
}

func replaceBase64Byte(b byte) byte {
	if b == 'A' {
		return 'B'
	}
	return 'A'
}

func (s *SopsGlobalMACMismatch) Revert(gitClient *git.Client) error {
	// Once the user re-encrypts the file, their repaired SOPS MAC is already
	// the desired state.
	return nil
}

func (s *SopsGlobalMACMismatch) Explanation() string {
	return "Only the global sops.mac metadata value in secrets.yaml.enc was corrupted. " +
		"The encrypted data key and secret values were still intact, so the plaintext " +
		"could be recovered with sops --ignore-mac --decrypt. Re-encrypting that " +
		"plaintext writes a fresh valid MAC."
}

func (s *SopsGlobalMACMismatch) DiagnoseCommands() []string {
	return []string{
		"kubectl get applications -n argocd django-app -o jsonpath='{.status.conditions}'",
		"kubectl logs -n argocd -l app.kubernetes.io/name=argocd-repo-server --tail=50",
		"kubectl get applications -n argocd django-app -o jsonpath='{.status.sync.status}'",
	}
}
