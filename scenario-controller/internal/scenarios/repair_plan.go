package scenarios

import (
	"fmt"
	"strings"
)

// KnownGoodSecretsPath is where the lab terminal keeps the team's known-good
// plaintext secrets, the source a learner re-encrypts from when an encrypted
// file cannot be recovered.
const KnownGoodSecretsPath = "/known-good/secrets.yaml"

// RepairStep is one thing a person does to repair a run. A Demonstration
// performs the steps in order, through the same Argo CD controls, Gitea pages
// and terminal commands a learner would use.
//
// Surfaces and actions:
//   - gitea view-source: open Path from the coach and point at Find.
//   - gitea view-commit: open Path, then its latest commit, which is the push.
//   - terminal run-commands: type each of Commands in the lab terminal.
//   - argo terminate-operation, sync, refresh: the Application's own controls.
//   - argo set-repo-url: edit the Application source's Repo URL to Value.
//   - argo diff, prune: inspect Diff, then prune only Resource.
type RepairStep struct {
	ID       string          `json:"id"`
	Surface  string          `json:"surface"`
	Action   string          `json:"action"`
	What     string          `json:"what"`
	Why      string          `json:"why"`
	Commands []string        `json:"commands,omitempty"`
	Path     string          `json:"path,omitempty"`
	Find     string          `json:"find,omitempty"`
	Value    string          `json:"value,omitempty"`
	Resource *RepairResource `json:"resource,omitempty"`
	// When names a condition the step needs; without it the step is skipped.
	// "operation-running": Argo is still running a sync operation.
	// "not-fixed": the Application has not recovered on its own.
	When string `json:"when,omitempty"`
}

// RepairResource is a Kubernetes resource an Argo CD step acts on.
type RepairResource struct {
	Group     string `json:"group"`
	Kind      string `json:"kind"`
	Namespace string `json:"namespace"`
	Name      string `json:"name"`
}

// RepairPlan is the ordered repair for one run.
type RepairPlan struct {
	Scenario    string       `json:"scenario"`
	Application string       `json:"application"`
	ChartPath   string       `json:"chart_path"`
	Steps       []RepairStep `json:"steps"`
}

// RepairInput describes the run a plan is for. The fault depends on the
// scenario, the environment's chart and the seed's variant, so the plan does too.
type RepairInput struct {
	Scenario    string
	Environment string
	Application string
	Namespace   string
	ChartPath   string
	RepoURL     string
	Seed        int64
}

// MissingConfigVariant is the seeded variant missing-configmap injects:
// 0 envFrom, 1 a configMapKeyRef in an env block, 2 a mounted volume.
func MissingConfigVariant(seed int64) int { return int(uint64(seed) % 3) }

// commitAndPush reviews the change, then commits and pushes it. Encrypted
// files only differ in ciphertext, so their review is a summary.
func commitAndPush(message string, summary bool) []string {
	review := "git diff"
	if summary {
		review = "git diff --stat"
	}
	return []string{review, "git commit -am '" + message + "'", "git push"}
}

func terminalStep(what, why string, commands ...string) RepairStep {
	return RepairStep{ID: "terminal", Surface: "terminal", Action: "run-commands", What: what, Why: why, Commands: commands}
}

func viewCommit(path string) RepairStep {
	return RepairStep{ID: "commit", Surface: "gitea", Action: "view-commit", Path: path,
		What: "Open the file in Git, then its latest commit, which is the one just pushed.",
		Why:  "The commit is the reviewable record of the repair, and the revision Argo CD should deploy next."}
}

func terminate(why string) RepairStep {
	return RepairStep{ID: "terminate", Surface: "argo", Action: "terminate-operation", When: "operation-running",
		What: "Open Sync Status and terminate the running operation.", Why: why}
}

// BuildRepairPlan returns the repair a person makes for this run's fault.
func BuildRepairPlan(in RepairInput) (RepairPlan, error) {
	chart := in.ChartPath
	deployment := chart + "/templates/deployment.yaml"
	service := chart + "/templates/service.yaml"
	migrateJob := chart + "/templates/migrate-job.yaml"
	values := chart + "/values.yaml"
	secrets := chart + "/secrets.yaml.enc"
	sops := "--input-type yaml --output-type yaml"
	plan := RepairPlan{Scenario: in.Scenario, Application: in.Application, ChartPath: chart}

	switch in.Scenario {
	case "missing-configmap":
		var edits []string
		switch MissingConfigVariant(in.Seed) {
		case 0:
			edits = []string{`sed -i 's|name: django-app-missing-config|name: {{ include "django-app.fullname" . }}-config|' ` + deployment}
		case 1:
			edits = []string{"sed -i '/name: LAB_REQUIRED_CONFIG/,/key: APP_ENVIRONMENT/d' " + deployment}
		case 2:
			edits = []string{
				"sed -i '/^      volumes:$/,/name: django-app-missing-config/d' " + deployment,
				"sed -i '/^        volumeMounts:$/,/mountPath: \\/etc\\/lab-required-config/d' " + deployment,
			}
		}
		commands := append([]string{"grep -n django-app-missing-config " + deployment}, edits...)
		plan.Steps = []RepairStep{
			{ID: "source", Surface: "gitea", Action: "view-source", Path: deployment, Find: "django-app-missing-config",
				What: "Open the Deployment template in Git and find the ConfigMap name the Pod could not load.",
				Why:  "The Pod's warning names django-app-missing-config; the template shows where the chart asks for it."},
			terminalStep("In the terminal, remove the reference to the missing ConfigMap, review the change, then commit and push it.",
				"Argo CD deploys what Git holds, so the repair must be a commit to survive the next sync.",
				append(commands, commitAndPush("fix: restore the ConfigMap reference", false)...)...),
			viewCommit(deployment),
		}
	case "env-drift":
		plan.Steps = []RepairStep{
			terminalStep("Compare both environments' readiness paths, restore the "+in.Environment+" path, then commit and push.",
				"The healthy environment shows the expected path, so only the affected environment's values file changes.",
				append([]string{
					"grep -n 'path: /api/' chart/django-app*/values.yaml",
					"sed -i 's|path: /api/legacy-health/|path: /api/health/|' " + values,
				}, commitAndPush("fix: restore the "+in.Environment+" readiness path", false)...)...),
			viewCommit(values),
		}
	case "stuck-sync":
		plan.Steps = []RepairStep{
			terminate("The operation waits for Pods that can never become ready, and it blocks a sync of the fix."),
			terminalStep("Restore the readiness probe path and the post-sync setting in values.yaml, then commit and push.",
				"Pods only become ready when the probe calls a real endpoint; the change must be in Git for Argo CD to keep it.",
				append([]string{
					"grep -n -e 'path: /api/' -e postSyncVerify " + values,
					"sed -i -e 's|path: /api/nonexistent/|path: /api/health/|' -e 's|postSyncVerify: true|postSyncVerify: false|' " + values,
				}, commitAndPush("fix: restore the readiness probe path", false)...)...),
			viewCommit(values),
		}
	case "stale-job":
		plan.Steps = []RepairStep{
			terminalStep("Remove the failing step from the migration hook, restore its retry limit and the Deployment's annotations, then commit and push.",
				"The PreSync Job runs before each sync, and it must succeed before Argo CD updates the Deployment.",
				append([]string{
					"grep -n -e 'dependency check' -e backoffLimit " + migrateJob,
					"sed -i -e '/migration dependency check failed/,/exit 1/d' -e 's/backoffLimit: 0/backoffLimit: 3/' " + migrateJob,
					"sed -i '/stale-job-trigger/d' " + deployment,
				}, commitAndPush("fix: repair the migration hook", false)...)...),
			viewCommit(migrateJob),
			terminate("Argo CD keeps retrying the failed sync of the old revision, and it starts no sync of the fix until that operation ends."),
			{ID: "sync", Surface: "argo", Action: "sync", When: "not-fixed",
				What: "Sync " + in.Application + " so the repaired PreSync Job runs.",
				Why:  "Argo CD records the hook's failure; a new sync runs the Job again from the repaired template."},
		}
	case "orphaned-resource":
		orphan := &RepairResource{Group: "apps", Kind: "Deployment", Namespace: in.Namespace, Name: "django-web"}
		plan.Steps = []RepairStep{
			terminalStep("Restore the Deployment's name and the Service's selector, then commit and push.",
				"The Service must select the Pods the chart creates, and restoring the name makes django the desired Deployment again.",
				append([]string{
					"grep -n django-web " + deployment + " " + service,
					"sed -i 's/^  name: django-web$/  name: django/' " + deployment,
					"sed -i -e '/^    app.kubernetes.io\\/instance: /d' -e '/^    app.kubernetes.io\\/name: /d' " +
						`-e 's#^    app: django-web$#    {{- include "django-app.selectorLabels" . | nindent 4 }}#' ` + service,
				}, commitAndPush("fix: restore the Deployment name and Service selector", false)...)...),
			viewCommit(deployment),
			{ID: "diff", Surface: "argo", Action: "diff", Resource: orphan,
				What: "Open Diff and confirm the only resource left to remove is the django-web Deployment.",
				Why:  "A prune deletes live resources; Diff shows exactly what Git no longer contains."},
			{ID: "prune", Surface: "argo", Action: "prune", Resource: orphan,
				What: "Sync with Prune, selecting only the django-web Deployment.",
				Why:  "A targeted prune removes the leftover workload without touching the Deployment serving traffic."},
		}
	case "sops-decrypt-failure", "hmac-mismatch", "wrong-type-sops":
		why := map[string]string{
			"sops-decrypt-failure": "The file's data key is damaged, so none of its values can be recovered; a fresh encryption replaces it.",
			"hmac-mismatch":        "A value's ciphertext fails authentication and cannot be decrypted, so encrypt the known-good values again.",
			"wrong-type-sops":      "The chart expects secrets to be a map of names to values, which the known-good file has.",
		}[in.Scenario]
		plan.Steps = []RepairStep{
			terminalStep("Read the team's known-good secrets, encrypt them over the broken file, check that it decrypts, then commit and push.", why,
				append([]string{
					"cat " + KnownGoodSecretsPath,
					"sops encrypt " + sops + " --output " + secrets + " " + KnownGoodSecretsPath,
					"sops decrypt " + sops + " " + secrets,
				}, commitAndPush("fix: re-encrypt the secrets from known-good values", true)...)...),
		}
		if in.Scenario == "wrong-type-sops" {
			plan.Steps = append(plan.Steps,
				terminate("Argo CD keeps retrying the broken revision while that operation runs; ending it lets Argo sync the fix."))
		}
		plan.Steps = append(plan.Steps, viewCommit(secrets))
	case "sops-global-mac-mismatch":
		plan.Steps = []RepairStep{
			terminalStep("Recover the values with --ignore-mac, re-encrypt them to write a fresh MAC, check that it decrypts, then commit and push.",
				"Only the file's integrity record is wrong; the encrypted values still decrypt.",
				append([]string{
					"sops decrypt --ignore-mac " + sops + " " + secrets + " | sops encrypt " + sops + " --output " + secrets + " /dev/stdin",
					"sops decrypt " + sops + " " + secrets,
				}, commitAndPush("fix: re-encrypt the secrets with a fresh MAC", true)...)...),
			viewCommit(secrets),
		}
	case "repo-auth":
		plan.ChartPath = ""
		plan.Steps = []RepairStep{
			{ID: "repo-url", Surface: "argo", Action: "set-repo-url", Value: in.RepoURL,
				What: "Open " + in.Application + "'s Details, edit its Source, and set Repo URL to the working Gitea address.",
				Why:  "Settings → Repositories lists this authenticated HTTP URL; the SSH URL has no deploy key."},
			{ID: "refresh", Surface: "argo", Action: "refresh",
				What: "Refresh " + in.Application + " so Argo CD fetches from the restored URL.",
				Why:  "A refresh compares the Application now instead of at the next poll."},
		}
	default:
		return RepairPlan{}, fmt.Errorf("%s has no repair", in.Scenario)
	}
	for _, step := range plan.Steps {
		for _, command := range step.Commands {
			// Interactive bash expands ! in typed commands.
			if strings.Contains(command, "!") {
				return RepairPlan{}, fmt.Errorf("repair command for %s contains !", in.Scenario)
			}
		}
	}
	return plan, nil
}
