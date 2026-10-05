package git

import (
	"crypto/sha256"
	"fmt"
	"log"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
)

// Client provides git operations against a Gitea repository using os/exec to
// shell out to the git CLI. All operations clone to a temporary directory,
// apply changes, and push back.
type Client struct {
	giteaURL     string
	username     string
	password     string
	repo         string
	sopsAgeKey   string
	agePublicKey string
	chartPath    string
	seed         int64

	mu *sync.Mutex // serialise git operations across environment views
}

// NewClient creates a new git client for the given Gitea repository.
func NewClient(giteaURL, username, password, repo, sopsAgeKey, agePublicKey string) *Client {
	return &Client{
		giteaURL:     strings.TrimRight(giteaURL, "/"),
		username:     username,
		password:     password,
		repo:         repo,
		sopsAgeKey:   sopsAgeKey,
		agePublicKey: agePublicKey,
		chartPath:    "chart/django-app",
		mu:           &sync.Mutex{},
	}
}

// ForChart returns a view of the same repository whose scenario file paths
// point at the requested environment's chart. The lock remains shared.
func (c *Client) ForChart(path string) *Client {
	view := *c
	view.chartPath = path
	return &view
}

// ForSeed makes variant selection repeatable for a scenario key.
func (c *Client) ForSeed(seed int64) *Client {
	view := *c
	view.seed = seed
	return &view
}

func (c *Client) Seed() int64 { return c.seed }

// SopsAgeKey returns the SOPS age private key (for creating SOPS files).
func (c *Client) SopsAgeKey() string {
	return c.sopsAgeKey
}

// AgePublicKey returns the age public key (for encrypting SOPS files).
func (c *Client) AgePublicKey() string {
	return c.agePublicKey
}

// cloneURL builds the authenticated HTTP clone URL.
func (c *Client) cloneURL() string {
	u, err := url.Parse(c.giteaURL)
	if err != nil {
		// Fallback to simple string interpolation.
		return fmt.Sprintf("%s/%s/%s.git", c.giteaURL, c.username, c.repo)
	}
	u.User = url.UserPassword(c.username, c.password)
	u.Path = fmt.Sprintf("/%s/%s.git", c.username, c.repo)
	return u.String()
}

// WorkDir represents a temporary working directory with a cloned repo.
type WorkDir struct {
	dir    string
	client *Client
}

// Dir returns the absolute path to the cloned repository root.
func (w *WorkDir) Dir() string {
	return w.dir
}

// FilePath returns the absolute path to a file within the cloned repo.
func (w *WorkDir) FilePath(relPath string) string {
	if w.client != nil && w.client.chartPath != "" {
		relPath = strings.Replace(relPath, "chart/django-app/", w.client.chartPath+"/", 1)
	}
	return filepath.Join(w.dir, relPath)
}

// ReadFile reads a file from the cloned repo.
func (w *WorkDir) ReadFile(relPath string) ([]byte, error) {
	return os.ReadFile(w.FilePath(relPath))
}

// WriteFile writes content to a file in the cloned repo, creating parent
// directories as needed.
func (w *WorkDir) WriteFile(relPath string, data []byte) error {
	fullPath := w.FilePath(relPath)
	if err := os.MkdirAll(filepath.Dir(fullPath), 0o755); err != nil {
		return fmt.Errorf("failed to create directories for %s: %w", relPath, err)
	}
	return os.WriteFile(fullPath, data, 0o644)
}

// DeleteFile removes a file from the cloned repo.
func (w *WorkDir) DeleteFile(relPath string) error {
	return os.Remove(w.FilePath(relPath))
}

// Cleanup removes the temporary working directory.
func (w *WorkDir) Cleanup() {
	if w.dir != "" {
		os.RemoveAll(w.dir)
	}
}

// CloneAndModify clones the repo, calls the modifier function to make changes,
// then commits and pushes. This is the primary way scenarios interact with git.
func (c *Client) CloneAndModify(commitMsg string, modifier func(w *WorkDir) error) error {
	return c.cloneAndModify(commitMsg, modifier, false)
}

// CloneAndModifyOrphan clones the repo, applies changes, then force-pushes the
// result as a new root commit on main. SOPS integrity scenarios use this to
// avoid leaving an obvious previous good encrypted blob in branch history.
func (c *Client) CloneAndModifyOrphan(commitMsg string, modifier func(w *WorkDir) error) error {
	return c.cloneAndModify(commitMsg, modifier, true)
}

// ResetToBaseline makes main point at the immutable baseline tag. The tag is
// retained even when an injector creates an orphan commit and rewrites main.
func (c *Client) ResetToBaseline() error {
	c.mu.Lock()
	defer c.mu.Unlock()

	tmpDir, err := os.MkdirTemp("", "scenario-reset-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmpDir)
	if err := runGit(tmpDir, "init", "-q"); err != nil {
		return err
	}
	if err := runGit(tmpDir, "remote", "add", "origin", c.cloneURL()); err != nil {
		return err
	}
	if err := runGit(tmpDir, "fetch", "--no-tags", "origin", "refs/tags/baseline:refs/tags/baseline"); err != nil {
		return fmt.Errorf("fetch baseline tag: %w", err)
	}
	if err := runGit(tmpDir, "push", "--force", "origin", "refs/tags/baseline:refs/heads/main"); err != nil {
		return fmt.Errorf("reset main to baseline: %w", err)
	}
	return nil
}

// Head returns the current main commit, including after a history rewrite.
func (c *Client) Head() (string, error) {
	cmd := exec.Command("git", "ls-remote", c.cloneURL(), "refs/heads/main")
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	output, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("git ls-remote main: %w: %s", err, redactGitOutput(string(output)))
	}
	fields := strings.Fields(string(output))
	if len(fields) < 2 || fields[1] != "refs/heads/main" {
		return "", fmt.Errorf("main branch not found")
	}
	return fields[0], nil
}

// HeadChartTree returns the Git tree object for this environment's chart at
// main. A different commit that only changes another app or a platform file
// leaves this object unchanged and cannot establish a durable shop fix.
func (c *Client) HeadChartTree(expectedHead string) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	tmpDir, err := os.MkdirTemp("", "scenario-tree-*")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(tmpDir)
	if err := runGit(tmpDir, "clone", "--depth=1", c.cloneURL(), "."); err != nil {
		return "", fmt.Errorf("clone for chart tree: %w", err)
	}
	cmd := exec.Command("git", "rev-parse", "HEAD", "HEAD:"+c.chartPath)
	cmd.Dir = tmpDir
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	output, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("chart tree %s: %w: %s", c.chartPath, err, redactGitOutput(string(output)))
	}
	lines := strings.Fields(string(output))
	if len(lines) != 2 || lines[0] != expectedHead {
		return "", fmt.Errorf("main changed while checking chart tree for %s", c.chartPath)
	}
	return lines[1], nil
}

// HeadRenderedHash hashes the desired manifests produced by the chart at main.
// The decrypted values and rendered YAML exist only in a private temporary
// directory, and neither is included in errors or logs.
func (c *Client) HeadRenderedHash(expectedHead, release, namespace string) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	tmpDir, err := os.MkdirTemp("", "scenario-render-*")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(tmpDir)
	if err := runGit(tmpDir, "clone", "--depth=1", c.cloneURL(), "."); err != nil {
		return "", fmt.Errorf("clone for chart render: %w", err)
	}
	head := exec.Command("git", "rev-parse", "HEAD")
	head.Dir = tmpDir
	actualHead, err := head.Output()
	if err != nil || strings.TrimSpace(string(actualHead)) != expectedHead {
		return "", fmt.Errorf("main changed while rendering chart")
	}
	chartDir := filepath.Join(tmpDir, c.chartPath)
	keyFile := filepath.Join(tmpDir, ".render-age-key")
	if err := os.WriteFile(keyFile, []byte(c.sopsAgeKey), 0o600); err != nil {
		return "", err
	}
	decrypt := exec.Command("sops", "--decrypt", "--input-type", "yaml", "--output-type", "yaml",
		filepath.Join(chartDir, "secrets.yaml.enc"))
	decrypt.Env = append(os.Environ(), "SOPS_AGE_KEY_FILE="+keyFile)
	plaintext, err := decrypt.Output()
	if err != nil {
		return "", fmt.Errorf("encrypted chart values cannot be decrypted")
	}
	valuesFile := filepath.Join(tmpDir, ".render-values.yaml")
	if err := os.WriteFile(valuesFile, plaintext, 0o600); err != nil {
		return "", err
	}
	render := exec.Command("helm", "template", release, chartDir, "--namespace", namespace,
		"--values", filepath.Join(chartDir, "values.yaml"), "--values", valuesFile)
	manifests, err := render.Output()
	if err != nil {
		return "", fmt.Errorf("chart values do not render")
	}
	digest := sha256.Sum256(manifests)
	return fmt.Sprintf("%x", digest), nil
}

// RestoreChartFromBaseline makes a normal, reviewable fix commit for a
// demonstration. It restores only the affected chart, preserving changes to
// other environments and platform applications.
func (c *Client) RestoreChartFromBaseline() error {
	return c.CloneAndModify("fix: restore the affected deployment chart", func(w *WorkDir) error {
		if err := runGit(w.dir, "fetch", "--no-tags", "origin", "refs/tags/baseline:refs/tags/baseline"); err != nil {
			return err
		}
		return runGit(w.dir, "checkout", "baseline", "--", c.chartPath)
	})
}

// HeadCommitDiff returns the exact patch in the latest fix commit for the
// affected chart. It is used to show Demonstration learners what was changed.
func (c *Client) HeadCommitDiff(expectedHead string) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	tmpDir, err := os.MkdirTemp("", "scenario-diff-*")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(tmpDir)
	if err := runGit(tmpDir, "clone", "--depth=2", c.cloneURL(), "."); err != nil {
		return "", fmt.Errorf("clone for fix diff: %w", err)
	}
	cmd := exec.Command("git", "rev-parse", "HEAD")
	cmd.Dir = tmpDir
	actualHead, err := cmd.Output()
	if err != nil || strings.TrimSpace(string(actualHead)) != expectedHead {
		return "", fmt.Errorf("main changed while reading fix diff")
	}
	cmd = exec.Command("git", "show", "--format=", "--no-ext-diff", "HEAD", "--", c.chartPath)
	cmd.Dir = tmpDir
	output, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("cannot read fix diff")
	}
	const maxDiffBytes = 16 * 1024
	if len(output) > maxDiffBytes {
		return string(output[:maxDiffBytes]) + "\n… diff truncated; open the commit in Gitea for the full patch.", nil
	}
	return string(output), nil
}

func (c *Client) cloneAndModify(commitMsg string, modifier func(w *WorkDir) error, replaceHistory bool) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	// Create a temporary directory for the clone.
	tmpDir, err := os.MkdirTemp("", "scenario-git-*")
	if err != nil {
		return fmt.Errorf("failed to create temp dir: %w", err)
	}
	defer os.RemoveAll(tmpDir)

	w := &WorkDir{dir: tmpDir, client: c}

	// Clone the repository.
	log.Printf("git: cloning %s/%s/%s", c.giteaURL, c.username, c.repo)
	if err := runGit(tmpDir, "clone", "--depth=1", c.cloneURL(), "."); err != nil {
		return fmt.Errorf("git clone failed: %w", err)
	}

	// Configure git user for commits.
	if err := runGit(tmpDir, "config", "user.email", "scenario-controller@remotelab.local"); err != nil {
		return fmt.Errorf("git config email failed: %w", err)
	}
	if err := runGit(tmpDir, "config", "user.name", "Scenario Controller"); err != nil {
		return fmt.Errorf("git config name failed: %w", err)
	}

	// Apply modifications.
	if err := modifier(w); err != nil {
		return fmt.Errorf("modifier function failed: %w", err)
	}

	if replaceHistory {
		if err := runGit(tmpDir, "checkout", "--orphan", "scenario-rewrite"); err != nil {
			return fmt.Errorf("git checkout orphan failed: %w", err)
		}
	}

	// Stage all changes.
	if err := runGit(tmpDir, "add", "-A"); err != nil {
		return fmt.Errorf("git add failed: %w", err)
	}

	// Check if there are changes to commit.
	if err := runGit(tmpDir, "diff", "--cached", "--quiet"); err == nil {
		log.Println("git: no changes to commit")
		return nil
	}

	// Commit.
	if err := runGit(tmpDir, "commit", "-m", commitMsg); err != nil {
		return fmt.Errorf("git commit failed: %w", err)
	}

	// Push.
	if replaceHistory {
		if err := runGit(tmpDir, "branch", "-M", "main"); err != nil {
			return fmt.Errorf("git branch rename failed: %w", err)
		}
		log.Println("git: force pushing rewritten main history")
		if err := runGit(tmpDir, "push", "--force", "origin", "main"); err != nil {
			return fmt.Errorf("git force push failed: %w", err)
		}
	} else {
		log.Println("git: pushing changes")
		if err := runGit(tmpDir, "push", "origin", "main"); err != nil {
			return fmt.Errorf("git push failed: %w", err)
		}
	}

	log.Println("git: changes pushed successfully")
	return nil
}

// runGit executes a git command in the given directory.
func runGit(dir string, args ...string) error {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(),
		"GIT_TERMINAL_PROMPT=0",
		"GIT_ASKPASS=",
	)

	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("git %s: %w\noutput: %s", redactGitOutput(strings.Join(args, " ")), err, redactGitOutput(string(output)))
	}
	return nil
}

var credentialsInURL = regexp.MustCompile(`://[^/@\s]+@`)

func redactGitOutput(value string) string {
	value = credentialsInURL.ReplaceAllString(value, "://***@")
	if password := os.Getenv("GITEA_PASSWORD"); password != "" {
		value = strings.ReplaceAll(value, password, "***")
	}
	return value
}
