package git

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
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

func TestRunStampChangesPodTemplateForEachRun(t *testing.T) {
	source, err := os.ReadFile(filepath.Join("..", "..", "..", "sample-django-app", "chart", "django-app", "templates", "deployment.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	first, err := stampRunDeployment(source, "run-0000000000000001")
	if err != nil {
		t.Fatal(err)
	}
	second, err := stampRunDeployment(source, "run-0000000000000002")
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(first, second) || !strings.Contains(string(first), `remotelab.local/run-id: "run-0000000000000001"`) {
		t.Fatal("pod template did not receive a distinct run annotation")
	}
	if _, err := stampRunDeployment([]byte("metadata: {}\n"), "run-0000000000000003"); err == nil {
		t.Fatal("missing pod template annotations should fail run preparation")
	}
}

func TestRunBaselineAndOrphanRevisionsChangeEachRun(t *testing.T) {
	remote := filepath.Join(t.TempDir(), "remote.git")
	seed := t.TempDir()
	if err := runGit(seed, "init", "-q", "--bare", remote); err != nil {
		t.Fatal(err)
	}
	if err := runGit(seed, "init", "-q"); err != nil {
		t.Fatal(err)
	}
	if err := runGit(seed, "checkout", "-b", "main"); err != nil {
		t.Fatal(err)
	}
	for _, chart := range []string{"chart/django-app", "chart/django-app-staging"} {
		path := filepath.Join(seed, chart, "templates", "deployment.yaml")
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("spec:\n  template:\n    metadata:\n      annotations:\n        prometheus.io/scrape: \"true\"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	for _, args := range [][]string{
		{"config", "user.email", "test@remotelab.local"}, {"config", "user.name", "Test"},
		{"add", "-A"}, {"commit", "-m", "baseline"}, {"tag", "baseline"},
		{"remote", "add", "origin", remote}, {"push", "origin", "main", "baseline"},
	} {
		if err := runGit(seed, args...); err != nil {
			t.Fatal(err)
		}
	}

	client := NewClient("https://gitea.invalid", "remotelab", "password", "django-app", "", "")
	config := filepath.Join(t.TempDir(), "gitconfig")
	if err := os.WriteFile(config, []byte("[url \"file://"+remote+"\"]\n\tinsteadOf = "+client.cloneURL()+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GIT_CONFIG_GLOBAL", config)
	t.Setenv("GIT_ALLOW_PROTOCOL", "file")
	var baselines, normalRevisions, orphans []string
	for _, runID := range []string{"run-0000000000000001", "run-0000000000000002"} {
		if err := client.ResetToBaseline(runID); err != nil {
			t.Fatal(err)
		}
		baseline, err := client.Head()
		if err != nil {
			t.Fatal(err)
		}
		baselines = append(baselines, baseline)
		for _, chart := range []string{"chart/django-app", "chart/django-app-staging"} {
			content, err := exec.Command("git", "--git-dir", remote, "show", "main:"+chart+"/templates/deployment.yaml").Output()
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(string(content), `remotelab.local/run-id: "`+runID+`"`) {
				t.Fatalf("%s did not get the run annotation", chart)
			}
		}
		if err := client.CloneAndModify("release: same incident", func(w *WorkDir) error {
			deployment, err := w.ReadFile("chart/django-app/templates/deployment.yaml")
			if err != nil {
				return err
			}
			return w.WriteFile("chart/django-app/templates/deployment.yaml", append(deployment, []byte("# same incident\n")...))
		}); err != nil {
			t.Fatal(err)
		}
		normal, err := client.Head()
		if err != nil {
			t.Fatal(err)
		}
		normalRevisions = append(normalRevisions, normal)
		if err := client.CloneAndModifyOrphan("release: same incident", func(_ *WorkDir) error { return nil }); err != nil {
			t.Fatal(err)
		}
		orphan, err := client.Head()
		if err != nil {
			t.Fatal(err)
		}
		orphans = append(orphans, orphan)
		if err := client.RestoreChartFromBaseline(); err != nil {
			t.Fatal(err)
		}
		fixed, err := client.Head()
		if err != nil {
			t.Fatal(err)
		}
		diff, err := client.HeadCommitDiff(fixed)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(diff, "-# same incident") ||
			strings.Contains(diff, "\n+        remotelab.local/run-id") ||
			strings.Contains(diff, "\n-        remotelab.local/run-id") {
			t.Fatalf("repair diff should remove the incident without changing the run annotation: %s", diff)
		}
	}
	if baselines[0] == baselines[1] || normalRevisions[0] == normalRevisions[1] || orphans[0] == orphans[1] {
		t.Fatalf("new runs reused revisions: baselines %v, normal %v, orphans %v", baselines, normalRevisions, orphans)
	}
}
