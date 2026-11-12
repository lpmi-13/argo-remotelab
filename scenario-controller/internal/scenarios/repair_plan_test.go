package scenarios

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/lpmi-13/argo-remotelab/scenario-controller/internal/git"
)

const repoURL = "http://gitea.applications.svc.cluster.local:3000/remotelab/django-app.git"

func chartFor(environment string) string {
	if environment == "staging" {
		return "chart/django-app-staging"
	}
	return "chart/django-app"
}

func input(scenario, environment string, seed int64) RepairInput {
	namespace := map[string]string{"prod": "applications", "staging": "shop-staging"}[environment]
	return RepairInput{Scenario: scenario, Environment: environment, Application: "shop-web-" + environment,
		Namespace: namespace, ChartPath: chartFor(environment), RepoURL: repoURL, Seed: seed}
}

func command(t *testing.T, dir string, env []string, name string, args ...string) string {
	t.Helper()
	cmd := exec.Command(name, args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), env...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("%s %s: %v\n%s", name, strings.Join(args, " "), err, output)
	}
	return string(output)
}

// The lab terminal is Alpine, whose sed and grep are BusyBox. Run the plans
// with BusyBox too when it is installed, so GNU-only syntax fails here.
func busyboxPath(t *testing.T) string {
	busybox, err := exec.LookPath("busybox")
	if err != nil {
		t.Log("busybox is not installed; repair commands run with the host's sed and grep")
		return os.Getenv("PATH")
	}
	dir := t.TempDir()
	for _, applet := range []string{"sed", "grep"} {
		script := fmt.Sprintf("#!/bin/sh\nexec %s %s \"$@\"\n", busybox, applet)
		if err := os.WriteFile(filepath.Join(dir, applet), []byte(script), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return dir + string(os.PathListSeparator) + os.Getenv("PATH")
}

// snapshot reads every file of one chart at the remote's main branch.
func snapshot(t *testing.T, remote, chart string) map[string]string {
	t.Helper()
	dir := t.TempDir()
	command(t, dir, nil, "git", "clone", "-q", "--depth=1", "file://"+remote, ".")
	files := map[string]string{}
	err := filepath.WalkDir(filepath.Join(dir, chart), func(path string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return err
		}
		data, err := os.ReadFile(path)
		relative, _ := filepath.Rel(dir, path)
		files[relative] = string(data)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return files
}

func decrypted(t *testing.T, keyFile, ciphertext string) map[string]any {
	t.Helper()
	cmd := exec.Command("sops", "decrypt", "--input-type", "yaml", "--output-type", "json", "/dev/stdin")
	cmd.Env = append(os.Environ(), "SOPS_AGE_KEY_FILE="+keyFile)
	cmd.Stdin = strings.NewReader(ciphertext)
	output, err := cmd.Output()
	if err != nil {
		t.Fatalf("decrypt repaired secrets: %v", err)
	}
	values := map[string]any{}
	if err := json.Unmarshal(output, &values); err != nil {
		t.Fatal(err)
	}
	return values
}

func TestRepairPlansRestoreTheBaseline(t *testing.T) {
	for _, tool := range []string{"git", "bash", "sops", "age-keygen"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skipf("%s is not installed", tool)
		}
	}
	work := t.TempDir()
	keyFile := filepath.Join(work, "age-key.txt")
	command(t, work, nil, "age-keygen", "-o", keyFile)
	privateKey, err := os.ReadFile(keyFile)
	if err != nil {
		t.Fatal(err)
	}
	publicKey := strings.TrimSpace(command(t, work, nil, "age-keygen", "-y", keyFile))
	knownGood, err := filepath.Abs("../../../lab-terminal/known-good/secrets.yaml")
	if err != nil {
		t.Fatal(err)
	}

	// The baseline as scripts/reset-gitea-repo.sh seeds it.
	remote := filepath.Join(work, "remote.git")
	seed := filepath.Join(work, "seed")
	command(t, work, nil, "git", "init", "-q", "--bare", remote)
	command(t, work, nil, "git", "init", "-q", "-b", "main", seed)
	sampleChart, err := filepath.Abs("../../../sample-django-app/chart")
	if err != nil {
		t.Fatal(err)
	}
	command(t, work, nil, "cp", "-r", sampleChart, filepath.Join(seed, "chart"))
	command(t, seed, []string{"SOPS_AGE_KEY_FILE=" + keyFile}, "sops", "encrypt", "--age", publicKey,
		"--input-type", "yaml", "--output-type", "yaml", "--output", "chart/django-app/secrets.yaml.enc", knownGood)
	command(t, seed, nil, "cp", "-r", "chart/django-app", "chart/django-app-staging")
	baselineSecrets, err := os.ReadFile(filepath.Join(seed, "chart/django-app/secrets.yaml.enc"))
	if err != nil {
		t.Fatal(err)
	}
	knownValues := decrypted(t, keyFile, string(baselineSecrets))
	if len(knownValues) != 1 || knownValues["secrets"] == nil {
		t.Fatalf("known-good file should hold one secrets map: %v", knownValues)
	}
	gitConfig := filepath.Join(work, "gitconfig")
	client := git.NewClient("https://gitea.invalid", "remotelab", "password", "django-app", string(privateKey), publicKey)
	config := "[user]\n\tname = Lab Learner\n\temail = learner@remotelab.local\n" +
		"[url \"file://" + remote + "\"]\n\tinsteadOf = https://remotelab:password@gitea.invalid/remotelab/django-app.git\n" +
		"[init]\n\tdefaultBranch = main\n"
	if err := os.WriteFile(gitConfig, []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GIT_CONFIG_GLOBAL", gitConfig)
	t.Setenv("GIT_ALLOW_PROTOCOL", "file")
	for _, args := range [][]string{{"add", "-A"}, {"commit", "-q", "-m", "baseline"}, {"tag", "baseline"},
		{"remote", "add", "origin", remote}, {"push", "-q", "origin", "main", "baseline"}} {
		command(t, seed, nil, "git", args...)
	}

	terminalEnv := []string{"SOPS_AGE_KEY_FILE=" + keyFile, "SOPS_AGE_RECIPIENTS=" + publicKey,
		"GIT_PAGER=cat", "PATH=" + busyboxPath(t)}
	type run struct {
		scenario Scenario
		seeds    []int64
	}
	runs := []run{
		{&MissingConfigMap{}, []int64{0, 1, 2}},
		{&EnvDrift{}, []int64{5}},
		{&StuckSync{}, []int64{5}},
		{&StaleJob{}, []int64{5}},
		{&OrphanedResource{}, []int64{5}},
		{&SopsDecryptFailure{}, []int64{5}},
		{&SopsGlobalMACMismatch{}, []int64{5}},
		{&HMACMismatch{}, []int64{5}},
		{&WrongTypeSops{}, []int64{1, 2, 3, 4}},
	}
	count := 0
	for _, item := range runs {
		for _, runSeed := range item.seeds {
			for _, environment := range []string{"prod", "staging"} {
				name := fmt.Sprintf("%s/seed-%d/%s", item.scenario.Name(), runSeed, environment)
				t.Run(name, func(t *testing.T) {
					count++
					chart := chartFor(environment)
					if err := client.ResetToBaseline(fmt.Sprintf("run-%016x", count)); err != nil {
						t.Fatal(err)
					}
					want := snapshot(t, remote, chart)
					if err := item.scenario.Inject(client.ForChart(chart).ForSeed(runSeed)); err != nil {
						t.Fatal(err)
					}
					if reflect.DeepEqual(snapshot(t, remote, chart), want) {
						t.Fatal("the fault did not change the chart")
					}
					plan, err := BuildRepairPlan(input(item.scenario.Name(), environment, runSeed))
					if err != nil {
						t.Fatal(err)
					}
					// The terminal's checkout, as lab-terminal/session.sh clones it.
					checkout := t.TempDir()
					command(t, checkout, nil, "git", "clone", "-q", "--depth=1", "file://"+remote, ".")
					typed := 0
					for _, step := range plan.Steps {
						for _, line := range step.Commands {
							line = strings.ReplaceAll(line, KnownGoodSecretsPath, knownGood)
							command(t, checkout, terminalEnv, "bash", "-c", line)
							typed++
						}
					}
					if typed == 0 {
						t.Fatal("the plan has no terminal commands")
					}
					got := snapshot(t, remote, chart)
					secrets := chart + "/secrets.yaml.enc"
					if !reflect.DeepEqual(decrypted(t, keyFile, got[secrets]), knownValues) {
						t.Fatalf("%s does not decrypt to the known-good values", secrets)
					}
					delete(got, secrets)
					delete(want, secrets)
					for path, content := range want {
						if got[path] != content {
							t.Errorf("%s differs from the baseline after the repair:\n%s", path, got[path])
						}
					}
					if len(got) != len(want) {
						t.Errorf("the repair added or removed chart files: %d, want %d", len(got), len(want))
					}
				})
			}
		}
	}
}

func TestRepairPlansFollowTheMission(t *testing.T) {
	order := func(plan RepairPlan) string {
		var actions []string
		for _, step := range plan.Steps {
			actions = append(actions, step.Action)
		}
		return strings.Join(actions, " ")
	}
	for scenario, want := range map[string]string{
		"missing-configmap":        "view-source run-commands view-commit",
		"env-drift":                "run-commands view-commit",
		"stuck-sync":               "terminate-operation run-commands view-commit",
		"stale-job":                "run-commands view-commit terminate-operation sync",
		"orphaned-resource":        "run-commands view-commit diff prune",
		"sops-decrypt-failure":     "run-commands view-commit",
		"sops-global-mac-mismatch": "run-commands view-commit",
		"hmac-mismatch":            "run-commands view-commit",
		"wrong-type-sops":          "run-commands terminate-operation view-commit",
		"repo-auth":                "set-repo-url refresh",
	} {
		plan, err := BuildRepairPlan(input(scenario, "staging", 7))
		if err != nil {
			t.Fatal(err)
		}
		if got := order(plan); got != want {
			t.Errorf("%s: %s, want %s", scenario, got, want)
		}
		for _, step := range plan.Steps {
			if step.What == "" || step.Why == "" {
				t.Errorf("%s/%s needs what and why", scenario, step.ID)
			}
			for _, line := range step.Commands {
				if strings.Contains(line, "chart/django-app/") {
					t.Errorf("%s: staging command edits the prod chart: %s", scenario, line)
				}
			}
			if step.Action == "view-commit" || step.Action == "view-source" {
				if !strings.HasPrefix(step.Path, "chart/django-app-staging/") {
					t.Errorf("%s: staging Git page is outside the staging chart: %s", scenario, step.Path)
				}
			}
		}
	}
	plan, _ := BuildRepairPlan(input("repo-auth", "prod", 1))
	if plan.Steps[0].Value != repoURL {
		t.Fatalf("repo-auth restores %q", plan.Steps[0].Value)
	}
	plan, _ = BuildRepairPlan(input("orphaned-resource", "staging", 1))
	if resource := plan.Steps[3].Resource; resource == nil || resource.Name != "django-web" || resource.Namespace != "shop-staging" {
		t.Fatalf("prune targets %+v", resource)
	}
	if _, err := BuildRepairPlan(input("console-history", "prod", 1)); err == nil {
		t.Fatal("a Level 1 mission has no repair plan")
	}
}

// testdata/repair-plans.json holds real plans for the coach's contract check
// (learning-service/session_view_samples.py). Regenerate it with
// UPDATE_REPAIR_PLANS=1 go test ./internal/scenarios/.
func TestRepairPlanSamplesAreCurrent(t *testing.T) {
	samples := map[string]RepairPlan{}
	for _, scenario := range []string{"missing-configmap", "env-drift", "stuck-sync", "stale-job", "orphaned-resource",
		"sops-decrypt-failure", "sops-global-mac-mismatch", "hmac-mismatch", "wrong-type-sops", "repo-auth"} {
		seeds := []int64{4}
		if scenario == "missing-configmap" {
			seeds = []int64{0, 1, 2}
		}
		for _, seed := range seeds {
			for _, environment := range []string{"prod", "staging"} {
				plan, err := BuildRepairPlan(input(scenario, environment, seed))
				if err != nil {
					t.Fatal(err)
				}
				samples[fmt.Sprintf("%s · seed %d · %s", scenario, seed, environment)] = plan
			}
		}
	}
	data, err := json.MarshalIndent(samples, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	data = append(data, '\n')
	path := filepath.Join("testdata", "repair-plans.json")
	if os.Getenv("UPDATE_REPAIR_PLANS") == "1" {
		if err := os.MkdirAll("testdata", 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, data, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	current, err := os.ReadFile(path)
	if err != nil || string(current) != string(data) {
		t.Fatalf("%s is out of date; run UPDATE_REPAIR_PLANS=1 go test ./internal/scenarios/", path)
	}
}
