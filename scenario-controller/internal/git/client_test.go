package git

import (
	"os"
	"path/filepath"
	"testing"
)

func TestHeadIgnoresGitRedirectWarning(t *testing.T) {
	binDir := t.TempDir()
	gitPath := filepath.Join(binDir, "git")
	gitScript := "#!/bin/sh\n" +
		"printf '%s\\n' 'warning: redirecting to http://gitea/repo.git/' >&2\n" +
		"printf '%s\\t%s\\n' 'deb5f2aecc4f94b72a1132c244699b86507bd6da' 'refs/heads/main'\n"
	if err := os.WriteFile(gitPath, []byte(gitScript), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))

	client := NewClient("http://gitea", "remotelab", "remotelab", "repo", "", "")
	head, err := client.Head()
	if err != nil {
		t.Fatal(err)
	}
	if want := "deb5f2aecc4f94b72a1132c244699b86507bd6da"; head != want {
		t.Fatalf("Head() = %q, want %q", head, want)
	}
}
