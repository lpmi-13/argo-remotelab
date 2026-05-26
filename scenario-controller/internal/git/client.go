package git

import (
	"fmt"
	"log"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
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

	mu sync.Mutex // serialise git operations
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
	}
}

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
		// Redact the password from any error output.
		sanitised := strings.ReplaceAll(string(output), os.Getenv("GITEA_PASSWORD"), "***")
		return fmt.Errorf("git %s: %w\noutput: %s", strings.Join(args, " "), err, sanitised)
	}
	return nil
}
