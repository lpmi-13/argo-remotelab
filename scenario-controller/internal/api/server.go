package api

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash/fnv"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/lpmi-13/argo-remotelab/scenario-controller/internal/argocd"
	"github.com/lpmi-13/argo-remotelab/scenario-controller/internal/git"
	"github.com/lpmi-13/argo-remotelab/scenario-controller/internal/scenarios"
)

const (
	prodApp        = "shop-web-prod"
	stagingApp     = "shop-web-staging"
	normalRepoURL  = "http://gitea.applications.svc.cluster.local:3000/remotelab/django-app.git"
	brokenRepoURL  = "ssh://git@gitea.applications.svc.cluster.local:22/remotelab/django-app.git"
	maxRunLifetime = 75 * time.Minute
)

var orientationMissions = []string{"console-orientation", "console-resources", "console-history"}

func isOrientation(name string) bool {
	for _, mission := range orientationMissions {
		if name == mission {
			return true
		}
	}
	return false
}

type Run struct {
	ID                  string         `json:"id"`
	Scenario            string         `json:"scenario"`
	Environment         string         `json:"environment"`
	Application         string         `json:"application"`
	TriggerRevision     string         `json:"trigger_revision,omitempty"`
	TriggerChartTree    string         `json:"-"`
	TriggerRenderHash   string         `json:"-"`
	TriggerRenderFailed bool           `json:"-"`
	Seed                int64          `json:"seed"`
	State               string         `json:"state"`
	Error               string         `json:"error,omitempty"`
	Manifest            map[string]any `json:"manifest,omitempty"`
	Probe               map[string]any `json:"probe,omitempty"`
	CreatedAt           time.Time      `json:"created_at"`
	UpdatedAt           time.Time      `json:"updated_at"`

	cancel context.CancelFunc
	done   chan struct{}
}

type Server struct {
	createMu    sync.Mutex
	mu          sync.Mutex
	runs        map[string]*Run
	activeID    string
	argo        *argocd.Client
	git         *git.Client
	registry    *scenarios.Registry
	treeCache   map[string]string
	renderCache map[string]string
}

func NewServer(argo *argocd.Client, gitClient *git.Client, registry *scenarios.Registry) *Server {
	return &Server{runs: make(map[string]*Run), argo: argo, git: gitClient,
		registry: registry, treeCache: make(map[string]string), renderCache: make(map[string]string)}
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	path := strings.Trim(r.URL.Path, "/")
	parts := strings.Split(path, "/")
	switch {
	case r.Method == http.MethodGet && path == "healthz":
		respond(w, 200, map[string]any{"status": "ok"})
	case r.Method == http.MethodGet && path == "api/catalog":
		respond(w, 200, map[string]any{"scenarios": append(append([]string{}, orientationMissions...), s.registry.Names()...)})
	case r.Method == http.MethodGet && path == "probe":
		s.probe(w, r)
	case r.Method == http.MethodPost && path == "api/refresh":
		s.refreshShopApplications(w, r.Context())
	case r.Method == http.MethodPost && path == "api/runs":
		request, err := readRequest(r)
		if err != nil {
			respondError(w, 400, err)
			return
		}
		s.create(w, request)
	case len(parts) == 3 && parts[0] == "api" && parts[1] == "runs" && r.Method == http.MethodGet:
		s.get(w, parts[2])
	case len(parts) == 3 && parts[0] == "api" && parts[1] == "runs" && r.Method == http.MethodDelete:
		s.abort(w, parts[2])
	case len(parts) == 4 && parts[0] == "api" && parts[1] == "runs" && parts[3] == "state" && r.Method == http.MethodPost:
		request, err := readRequest(r)
		if err != nil {
			respondError(w, 400, err)
			return
		}
		s.transition(w, r.Context(), parts[2], request)
	case len(parts) == 4 && parts[0] == "api" && parts[1] == "runs" && parts[3] == "reset" && r.Method == http.MethodPost:
		s.reset(w, parts[2], r)
	case len(parts) == 4 && parts[0] == "api" && parts[1] == "runs" && parts[3] == "reference-fix" && r.Method == http.MethodPost:
		s.referenceFix(w, parts[2])
	default:
		respondError(w, 404, errors.New("not found"))
	}
}

// The learning service calls this after verifying Gitea's push signature.
// Gitea advertises its browser-facing URL in the push payload, while Argo's
// Application source uses the in-cluster URL, so Argo's generic webhook cannot
// match the repository reliably on its own.
func (s *Server) refreshShopApplications(w http.ResponseWriter, ctx context.Context) {
	for _, application := range []string{prodApp, stagingApp} {
		if err := s.argo.ForApplication(application).RequestHardRefresh(ctx); err != nil {
			respondError(w, 503, fmt.Errorf("refresh %s: %w", application, err))
			return
		}
	}
	respond(w, 202, map[string]any{"refreshed": []string{prodApp, stagingApp}})
}

func readRequest(r *http.Request) (map[string]any, error) {
	defer r.Body.Close()
	data, err := io.ReadAll(io.LimitReader(r.Body, 64*1024+1))
	if err != nil {
		return nil, err
	}
	if len(data) > 64*1024 {
		return nil, errors.New("request body is too large")
	}
	request := map[string]any{}
	if len(data) == 0 {
		return request, nil
	}
	if err := json.Unmarshal(data, &request); err != nil {
		return nil, err
	}
	return request, nil
}

func newID() string {
	buf := make([]byte, 8)
	if _, err := rand.Read(buf); err != nil {
		panic(err)
	}
	return "run-" + hex.EncodeToString(buf)
}

func seedFor(request map[string]any) int64 {
	if raw, ok := request["seed"].(float64); ok {
		return int64(raw)
	}
	key, _ := request["scenario_key"].(string)
	if key == "" {
		key = newID()
	}
	hash := fnv.New64a()
	_, _ = hash.Write([]byte(key))
	// JSON clients commonly decode numbers as float64, so keep seeds exact.
	return int64(hash.Sum64() & 0x1fffffffffffff)
}

func environmentFor(request map[string]any, seed int64) (string, error) {
	if value, ok := request["environment"].(string); ok && value != "" {
		if value != "prod" && value != "staging" {
			return "", fmt.Errorf("environment must be prod or staging")
		}
		return value, nil
	}
	if seed%2 == 0 {
		return "prod", nil
	}
	return "staging", nil
}

func appFor(environment string) string {
	if environment == "staging" {
		return stagingApp
	}
	return prodApp
}

func chartFor(environment string) string {
	if environment == "staging" {
		return "chart/django-app-staging"
	}
	return "chart/django-app"
}

func namespaceFor(environment string) string {
	if environment == "staging" {
		return "shop-staging"
	}
	return "applications"
}

func expectsRenderFailure(scenario string) bool {
	return strings.Contains(scenario, "sops") || scenario == "hmac-mismatch"
}

func (s *Server) create(w http.ResponseWriter, request map[string]any) {
	s.createMu.Lock()
	defer s.createMu.Unlock()
	s.createRun(w, request)
}

func (s *Server) createRun(w http.ResponseWriter, request map[string]any) {
	name, _ := request["scenario"].(string)
	if name == "" {
		name = "console-orientation"
	}
	if !isOrientation(name) && s.registry.Find(name) == nil {
		respondError(w, 404, fmt.Errorf("unknown scenario %q", name))
		return
	}
	seed := seedFor(request)
	environment, err := environmentFor(request, seed)
	if err != nil {
		respondError(w, 400, err)
		return
	}

	if err := s.prepareCreate(request["replace_existing"] == true); err != nil {
		respondError(w, 409, err)
		return
	}
	s.mu.Lock()
	ctx, cancel := context.WithCancel(context.Background())
	now := time.Now().UTC()
	run := &Run{
		ID: newID(), Scenario: name, Environment: environment, Application: appFor(environment),
		Seed: seed, State: "CREATED", CreatedAt: now, UpdatedAt: now, cancel: cancel, done: make(chan struct{}),
	}
	run.Manifest = manifestFor(run)
	s.runs[run.ID] = run
	s.activeID = run.ID
	view := publicRun(run)
	s.mu.Unlock()
	go s.execute(ctx, run)
	respond(w, 202, view)
}

// A new launcher start may replace the previous run, even if its browser tab
// was closed without sending Stop. Wait for its worker to exit before touching
// the shared Git repository or Argo Applications again.
func (s *Server) prepareCreate(replace bool) error {
	s.mu.Lock()
	active := s.runs[s.activeID]
	if active == nil {
		s.mu.Unlock()
		return nil
	}
	working := active.State != "COMPLETED" && active.State != "FAILED" && active.State != "ABORTED"
	if working && !replace {
		s.mu.Unlock()
		return fmt.Errorf("run %s is still active", active.ID)
	}
	if working {
		active.State = "ABORTED"
		active.UpdatedAt = time.Now().UTC()
		active.cancel()
	}
	done := active.done
	s.mu.Unlock()
	if done == nil {
		return nil
	}
	if !replace {
		select {
		case <-done:
			return nil
		default:
			return errors.New("previous run is still stopping")
		}
	}
	select {
	case <-done:
		return nil
	case <-time.After(15 * time.Second):
		return errors.New("previous run is still stopping")
	}
}

func manifestFor(run *Run) map[string]any {
	brief := map[string]string{
		"console-orientation":      "Find the application for this environment and identify its deployed revision in Argo CD.",
		"console-resources":        "Find the shop Deployment in the tree and read its readiness probe in the Desired manifest.",
		"console-history":          "Read the latest deployed revision in History and the result of the last sync operation.",
		"missing-configmap":        "A release is not starting. Find the affected workload and the most recent warning in Argo CD.",
		"stuck-sync":               "The release is still progressing and traffic is failing. Find what keeps the pods from becoming ready.",
		"stale-job":                "The release is blocked before the workload updates. Find the failed sync hook.",
		"orphaned-resource":        "The application has a new deployment but the service is returning errors. Check the resource tree and diff.",
		"sops-decrypt-failure":     "Argo CD cannot compare the new revision. Read the application condition and restore the encrypted source.",
		"sops-global-mac-mismatch": "The encrypted configuration no longer renders. Find the comparison error in Argo CD.",
		"hmac-mismatch":            "The latest encrypted configuration cannot be decrypted. Find the failing source in Argo CD.",
		"wrong-type-sops":          "The latest secrets change blocked deployment. Read the render or sync failure in Argo CD.",
		"env-drift":                "One shop environment is healthy while the other release is failing. Compare their values and revisions.",
		"repo-auth":                "The shop Application cannot fetch its source. Read the repository error and compare it with the working entry.",
	}
	level := 4
	switch run.Scenario {
	case "console-orientation", "console-resources", "console-history":
		level = 1
	case "missing-configmap", "stuck-sync":
		level = 2
	case "stale-job", "orphaned-resource":
		level = 3
	case "env-drift", "repo-auth":
		level = 5
	}
	return map[string]any{
		"run_id": run.ID, "seed": run.Seed, "template_id": run.Scenario,
		"parameters": map[string]any{"environment": run.Environment, "application": run.Application, "chart_path": chartFor(run.Environment)},
		"scenario": map[string]any{
			"id": run.Scenario, "title": strings.ReplaceAll(run.Scenario, "-", " "), "level": level,
			"brief": brief[run.Scenario], "environment": run.Environment, "application": run.Application,
		},
		"starting_view": map[string]any{"path": "/argocd/applications"},
	}
}

func (s *Server) execute(ctx context.Context, run *Run) {
	defer close(run.done)
	s.setState(run, "RESETTING", "")
	for _, app := range []string{prodApp, stagingApp} {
		_ = s.argo.ForApplication(app).ClearScenarioReady(ctx)
		if err := s.argo.ForApplication(app).SetRepoURL(ctx, normalRepoURL); err != nil {
			s.fail(run, fmt.Errorf("restore repository URL for %s: %w", app, err))
			return
		}
		if err := s.argo.ForApplication(app).TerminateOperation(ctx); err != nil {
			log.Printf("run %s: terminate %s: %v", run.ID, app, err)
		}
	}
	if err := s.git.ResetToBaseline(); err != nil {
		s.fail(run, err)
		return
	}
	baselineHead, err := s.git.Head()
	if err != nil {
		s.fail(run, err)
		return
	}
	s.mu.Lock()
	run.TriggerRevision = baselineHead
	s.mu.Unlock()
	for _, app := range []string{prodApp, stagingApp} {
		_ = s.argo.ForApplication(app).RequestHardRefresh(ctx)
	}
	for _, app := range []string{prodApp, stagingApp} {
		if err := s.waitFor(ctx, app, 6*time.Minute, func(probe map[string]any) bool { return revision(probe) == baselineHead }); err != nil {
			s.fail(run, fmt.Errorf("baseline revision was not observed for %s: %w", app, err))
			return
		}
	}
	for _, namespace := range []string{"applications", "shop-staging"} {
		if err := s.argo.DeleteResource(ctx, namespace, "django-web"); err != nil {
			log.Printf("run %s: cleanup %s/django-web: %v", run.ID, namespace, err)
		}
		if err := s.argo.DeleteMissingConfigMap(ctx, namespace); err != nil {
			log.Printf("run %s: cleanup %s/django-app-missing-config: %v", run.ID, namespace, err)
		}
	}
	for _, app := range []string{prodApp, stagingApp} {
		environment := "prod"
		if app == stagingApp {
			environment = "staging"
		}
		if err := s.waitFor(ctx, app, 6*time.Minute, func(probe map[string]any) bool {
			return isFixed(probe) && revision(probe) == baselineHead && s.httpOK(ctx, environment)
		}); err != nil {
			s.fail(run, fmt.Errorf("baseline did not recover for %s: %w", app, err))
			return
		}
	}
	if !isOrientation(run.Scenario) {
		s.setState(run, "INJECTING", "")
		if run.Scenario == "repo-auth" {
			if err := s.argo.ForApplication(run.Application).SetRepoURL(ctx, brokenRepoURL); err != nil {
				s.fail(run, err)
				return
			}
		} else {
			selected := s.registry.Find(run.Scenario)
			if err := selected.Inject(s.git.ForChart(chartFor(run.Environment)).ForSeed(run.Seed)); err != nil {
				s.fail(run, err)
				return
			}
		}
		triggerRevision, err := s.git.Head()
		if err != nil {
			s.fail(run, err)
			return
		}
		var triggerTree string
		var triggerRenderHash string
		var triggerRenderFailed bool
		if run.Scenario != "repo-auth" {
			chart := s.git.ForChart(chartFor(run.Environment))
			triggerTree, err = chart.HeadChartTree(triggerRevision)
			if err != nil {
				s.fail(run, err)
				return
			}
			triggerRenderHash, err = chart.HeadRenderedHash(triggerRevision, run.Application, namespaceFor(run.Environment))
			if err != nil {
				if !expectsRenderFailure(run.Scenario) {
					s.fail(run, fmt.Errorf("injected chart did not render: %w", err))
					return
				}
				triggerRenderFailed = true
			}
		}
		s.mu.Lock()
		run.TriggerRevision = triggerRevision
		run.TriggerChartTree = triggerTree
		run.TriggerRenderHash = triggerRenderHash
		run.TriggerRenderFailed = triggerRenderFailed
		s.mu.Unlock()
		_ = s.argo.ForApplication(run.Application).RequestHardRefresh(ctx)
		s.setState(run, "AWAITING_DETECTION", "")
		if err := s.waitFor(ctx, run.Application, 6*time.Minute, func(probe map[string]any) bool { return s.detected(ctx, run, probe) }); err != nil {
			s.fail(run, fmt.Errorf("failure was not detected: %w", err))
			return
		}
	}
	if err := s.argo.ForApplication(run.Application).MarkScenarioReady(ctx, run.Scenario); err != nil {
		s.fail(run, err)
		return
	}
	s.setState(run, "READY", "")
	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(5 * time.Second):
			if time.Since(run.CreatedAt) >= maxRunLifetime {
				s.fail(run, fmt.Errorf("run timed out after %s", maxRunLifetime))
				return
			}
			probe, err := s.argo.ForApplication(run.Application).Probe(ctx)
			if err != nil {
				continue
			}
			s.mu.Lock()
			run.Probe = probe
			state := run.State
			s.mu.Unlock()
			if state == "COMPLETED" || state == "ABORTED" {
				return
			}
			if state == "READY" || state == "INVESTIGATING" {
				if s.fixed(ctx, run, probe) && !isOrientation(run.Scenario) {
					s.setState(run, "FIXED", "")
				}
			}
		}
	}
}

func (s *Server) waitFor(ctx context.Context, application string, timeout time.Duration, predicate func(map[string]any) bool) error {
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		if probe, err := s.argo.ForApplication(application).Probe(ctx); err == nil && predicate(probe) {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline.C:
			return errors.New("timed out")
		case <-ticker.C:
		}
	}
}

func isFixed(probe map[string]any) bool {
	status, _ := probe["status"].(map[string]any)
	health, _ := status["health"].(map[string]any)
	syncState, _ := status["sync"].(map[string]any)
	return health["status"] == "Healthy" && syncState["status"] == "Synced" && probe["operation_running"] != true
}

func healthOf(probe map[string]any) string {
	status, _ := probe["status"].(map[string]any)
	health, _ := status["health"].(map[string]any)
	value, _ := health["status"].(string)
	return value
}

func operationPhase(probe map[string]any) string {
	status, _ := probe["status"].(map[string]any)
	operation, _ := status["operationState"].(map[string]any)
	phase, _ := operation["phase"].(string)
	return phase
}

func operationRevision(probe map[string]any) string {
	status, _ := probe["status"].(map[string]any)
	operation, _ := status["operationState"].(map[string]any)
	request, _ := operation["operation"].(map[string]any)
	sync, _ := request["sync"].(map[string]any)
	value, _ := sync["revision"].(string)
	return value
}

func hasFailedSyncHook(probe map[string]any) bool {
	status, _ := probe["status"].(map[string]any)
	operation, _ := status["operationState"].(map[string]any)
	result, _ := operation["syncResult"].(map[string]any)
	resources, _ := result["resources"].([]any)
	for _, raw := range resources {
		resource, _ := raw.(map[string]any)
		if resource["hookPhase"] == "Failed" && resource["hookType"] != "" {
			return true
		}
	}
	return false
}

func hasComparisonError(probe map[string]any) bool {
	status, _ := probe["status"].(map[string]any)
	conditions, _ := status["conditions"].([]any)
	for _, raw := range conditions {
		condition, _ := raw.(map[string]any)
		if condition["type"] == "ComparisonError" || condition["type"] == "InvalidSpecError" {
			return true
		}
	}
	return false
}

func (s *Server) httpOK(ctx context.Context, environment string) bool {
	namespace := "applications"
	if environment == "staging" {
		namespace = "shop-staging"
	}
	url := fmt.Sprintf("http://django.%s.svc.cluster.local:8000/api/health/", namespace)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return false
	}
	client := &http.Client{Timeout: 2 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		return false
	}
	defer response.Body.Close()
	return response.StatusCode == http.StatusOK
}

func (s *Server) detected(ctx context.Context, run *Run, probe map[string]any) bool {
	switch run.Scenario {
	case "missing-configmap", "env-drift":
		return healthOf(probe) == "Degraded" || healthOf(probe) == "Progressing"
	case "stuck-sync":
		return probe["operation_running"] == true && (healthOf(probe) == "Degraded" || healthOf(probe) == "Progressing")
	case "stale-job":
		return operationPhase(probe) == "Failed" || operationPhase(probe) == "Error" || hasFailedSyncHook(probe)
	case "orphaned-resource":
		namespace := "applications"
		if run.Environment == "staging" {
			namespace = "shop-staging"
		}
		exists, err := s.argo.ResourceExists(ctx, namespace, "django-web")
		return err == nil && exists && !s.httpOK(ctx, run.Environment)
	case "sops-decrypt-failure", "sops-global-mac-mismatch", "hmac-mismatch":
		return hasComparisonError(probe) || operationPhase(probe) == "Failed" || operationPhase(probe) == "Error"
	case "wrong-type-sops":
		if hasComparisonError(probe) || operationPhase(probe) == "Failed" || operationPhase(probe) == "Error" {
			return true
		}
		// Some wrong shapes render successfully but Kubernetes rejects a Job
		// while Argo's automated operation is still retrying. Its failure text
		// is already visible in the operation panel, so the learner can begin.
		status, _ := probe["status"].(map[string]any)
		operation, _ := status["operationState"].(map[string]any)
		message, _ := operation["message"].(string)
		return operationPhase(probe) == "Running" && operationRevision(probe) == run.TriggerRevision &&
			strings.Contains(strings.ToLower(message), "failed to apply")
	case "repo-auth":
		return probe["repo_url"] == brokenRepoURL && hasComparisonError(probe)
	default:
		return !isFixed(probe)
	}
}

func (s *Server) fixed(ctx context.Context, run *Run, probe map[string]any) bool {
	if !isFixed(probe) || !s.httpOK(ctx, run.Environment) {
		return false
	}
	if run.Scenario == "stale-job" && (operationPhase(probe) != "Succeeded" || operationRevision(probe) != revision(probe)) {
		return false
	}
	if strings.Contains(run.Scenario, "sops") || run.Scenario == "hmac-mismatch" {
		return isFixed(probe) && !hasComparisonError(probe)
	}
	if run.Scenario == "repo-auth" {
		return probe["repo_url"] == normalRepoURL && isFixed(probe) && !hasComparisonError(probe)
	}
	if run.Scenario == "orphaned-resource" {
		namespace := "applications"
		if run.Environment == "staging" {
			namespace = "shop-staging"
		}
		exists, err := s.argo.ResourceExists(ctx, namespace, "django-web")
		return err == nil && !exists
	}
	return true
}

func revision(probe map[string]any) string {
	status, _ := probe["status"].(map[string]any)
	syncState, _ := status["sync"].(map[string]any)
	revision, _ := syncState["revision"].(string)
	return revision
}

func sourceRevisionChanged(run *Run, head string) bool {
	if run == nil || isOrientation(run.Scenario) || run.Scenario == "repo-auth" {
		return true
	}
	return run.TriggerRevision != "" && head != run.TriggerRevision
}

func sourceTreeChanged(run *Run, head, tree string) bool {
	if run == nil || isOrientation(run.Scenario) || run.Scenario == "repo-auth" {
		return true
	}
	return sourceRevisionChanged(run, head) && run.TriggerChartTree != "" &&
		tree != "" && tree != run.TriggerChartTree
}

func sourceRenderChanged(run *Run, renderHash string) bool {
	if run == nil || isOrientation(run.Scenario) || run.Scenario == "repo-auth" {
		return true
	}
	if renderHash == "" {
		return false
	}
	if run.TriggerRenderFailed {
		return true
	}
	return run.TriggerRenderHash != "" && renderHash != run.TriggerRenderHash
}

func (s *Server) chartTreeAtHead(head, environment string) (string, error) {
	key := head + ":" + chartFor(environment)
	s.mu.Lock()
	if tree, found := s.treeCache[key]; found {
		s.mu.Unlock()
		return tree, nil
	}
	s.mu.Unlock()
	tree, err := s.git.ForChart(chartFor(environment)).HeadChartTree(head)
	if err != nil {
		return "", err
	}
	s.mu.Lock()
	s.treeCache[key] = tree
	s.mu.Unlock()
	return tree, nil
}

func (s *Server) chartRenderAtHead(head string, run *Run) (string, error) {
	key := head + ":" + chartFor(run.Environment)
	s.mu.Lock()
	if hash, found := s.renderCache[key]; found {
		s.mu.Unlock()
		return hash, nil
	}
	s.mu.Unlock()
	hash, err := s.git.ForChart(chartFor(run.Environment)).HeadRenderedHash(head, run.Application, namespaceFor(run.Environment))
	if err != nil {
		return "", err
	}
	s.mu.Lock()
	s.renderCache[key] = hash
	s.mu.Unlock()
	return hash, nil
}

func (s *Server) setState(run *Run, state, message string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if run.State == "ABORTED" || run.State == "COMPLETED" {
		return
	}
	run.State, run.Error, run.UpdatedAt = state, message, time.Now().UTC()
	log.Printf("run %s: %s", run.ID, state)
}

func (s *Server) fail(run *Run, err error) {
	if errors.Is(err, context.Canceled) {
		return
	}
	log.Printf("run %s failed: %v", run.ID, err)
	s.setState(run, "FAILED", err.Error())
}

func publicRun(run *Run) map[string]any {
	return map[string]any{
		"id": run.ID, "scenario": run.Scenario, "environment": run.Environment,
		"application": run.Application, "seed": run.Seed, "state": run.State,
		"trigger_revision": run.TriggerRevision,
		"error":            run.Error, "manifest": run.Manifest, "probe": run.Probe,
		"created_at": run.CreatedAt, "updated_at": run.UpdatedAt,
	}
}

func (s *Server) get(w http.ResponseWriter, id string) {
	s.mu.Lock()
	run := s.runs[id]
	if run == nil {
		s.mu.Unlock()
		respondError(w, 404, errors.New("run not found"))
		return
	}
	view := publicRun(run)
	s.mu.Unlock()
	respond(w, 200, view)
}

func (s *Server) probe(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("application")
	if name != prodApp && name != stagingApp {
		respondError(w, 400, errors.New("unknown application"))
		return
	}
	probe, err := s.argo.ForApplication(name).Probe(r.Context())
	if err != nil {
		respondError(w, 503, err)
		return
	}
	environment := "prod"
	if name == stagingApp {
		environment = "staging"
	}
	probe["http_ok"] = s.httpOK(r.Context(), environment)
	probe["fixed"] = isFixed(probe) && probe["http_ok"] == true
	s.mu.Lock()
	run := s.runs[s.activeID]
	if run != nil {
		snapshot := *run
		run = &snapshot
	}
	s.mu.Unlock()
	if run != nil && run.Application == name {
		probe["fixed"] = s.fixed(r.Context(), run, probe)
	}
	if head, err := s.git.Head(); err == nil {
		probe["git_revision"] = head
		durable := probe["fixed"] == true && revision(probe) == head && sourceRevisionChanged(run, head)
		if durable && run != nil && !isOrientation(run.Scenario) && run.Scenario != "repo-auth" {
			if tree, err := s.chartTreeAtHead(head, run.Environment); err == nil {
				durable = sourceTreeChanged(run, head, tree)
			} else {
				log.Printf("run %s: check durable chart tree: %v", run.ID, err)
				durable = false
			}
			if durable {
				if hash, err := s.chartRenderAtHead(head, run); err == nil {
					durable = sourceRenderChanged(run, hash)
				} else {
					log.Printf("run %s: check durable rendered chart: %v", run.ID, err)
					durable = false
				}
			}
		}
		probe["durable"] = durable
	}
	othersHealthy := true
	for _, other := range []string{prodApp, stagingApp, "platform-config", "release-policy", "ingress-config"} {
		if other == name {
			continue
		}
		snapshot, err := s.argo.ForApplication(other).Probe(r.Context())
		if err != nil || !isFixed(snapshot) {
			othersHealthy = false
			break
		}
	}
	probe["other_application_healthy"] = othersHealthy
	respond(w, 200, probe)
}

func (s *Server) referenceFix(w http.ResponseWriter, id string) {
	s.mu.Lock()
	run := s.runs[id]
	if run == nil {
		s.mu.Unlock()
		respondError(w, 404, errors.New("run not found"))
		return
	}
	if run.State != "READY" && run.State != "INVESTIGATING" {
		s.mu.Unlock()
		respondError(w, 409, errors.New("run is not ready for a fix"))
		return
	}
	s.mu.Unlock()
	if isOrientation(run.Scenario) {
		respondError(w, 409, errors.New("orientation has no failure to fix"))
		return
	}
	if run.Scenario == "repo-auth" {
		if err := s.argo.ForApplication(run.Application).SetRepoURL(context.Background(), normalRepoURL); err != nil {
			respondError(w, 500, err)
			return
		}
		_ = s.argo.ForApplication(run.Application).RequestHardRefresh(context.Background())
		respond(w, 202, map[string]any{"status": "repository URL restored",
			"diff": "- " + brokenRepoURL + "\n+ " + normalRepoURL + "\n"})
		return
	}
	terminate := run.Scenario == "stuck-sync" || run.Scenario == "stale-job"
	if run.Scenario == "wrong-type-sops" {
		probe, err := s.argo.ForApplication(run.Application).Probe(context.Background())
		if err != nil {
			respondError(w, 500, err)
			return
		}
		terminate = probe["operation_running"] == true
	}
	if terminate {
		if err := s.argo.ForApplication(run.Application).TerminateOperation(context.Background()); err != nil {
			respondError(w, 500, err)
			return
		}
	}
	if err := s.git.ForChart(chartFor(run.Environment)).RestoreChartFromBaseline(); err != nil {
		respondError(w, 500, err)
		return
	}
	_ = s.argo.ForApplication(run.Application).RequestHardRefresh(context.Background())
	if run.Scenario == "stale-job" {
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
			defer cancel()
			head, err := s.git.Head()
			if err != nil {
				log.Printf("run %s: find stale-job fix revision: %v", run.ID, err)
				return
			}
			if err := s.waitFor(ctx, run.Application, 5*time.Minute, func(probe map[string]any) bool {
				return revision(probe) == head && probe["operation_running"] != true
			}); err != nil {
				log.Printf("run %s: wait to re-sync fixed Job: %v", run.ID, err)
				return
			}
			if err := s.argo.ForApplication(run.Application).RequestSync(ctx, head); err != nil {
				log.Printf("run %s: re-sync fixed Job: %v", run.ID, err)
			}
		}()
	}
	if run.Scenario == "orphaned-resource" {
		namespace := "applications"
		if run.Environment == "staging" {
			namespace = "shop-staging"
		}
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
			defer cancel()
			head, err := s.git.Head()
			if err != nil {
				log.Printf("run %s: find fix revision: %v", run.ID, err)
				return
			}
			if err := s.waitFor(ctx, run.Application, 5*time.Minute, func(probe map[string]any) bool { return revision(probe) == head }); err != nil {
				log.Printf("run %s: wait for orphan fix revision: %v", run.ID, err)
				return
			}
			if err := s.argo.DeleteResource(ctx, namespace, "django-web"); err != nil {
				log.Printf("run %s: prune orphan: %v", run.ID, err)
			}
		}()
	}
	result := map[string]any{"status": "fix committed", "chart_path": chartFor(run.Environment)}
	if head, err := s.git.Head(); err == nil {
		result["commit"] = head
		if diff, err := s.git.ForChart(chartFor(run.Environment)).HeadCommitDiff(head); err == nil {
			result["diff"] = diff
		} else {
			log.Printf("run %s: read demonstration diff: %v", run.ID, err)
		}
	}
	respond(w, 202, result)
}

func (s *Server) transition(w http.ResponseWriter, ctx context.Context, id string, request map[string]any) {
	state, _ := request["state"].(string)
	state = strings.ToUpper(state)
	s.mu.Lock()
	run := s.runs[id]
	s.mu.Unlock()
	if run == nil {
		respondError(w, 404, errors.New("run not found"))
		return
	}
	confirmedFixed := false
	if state == "COMPLETED" && !isOrientation(run.Scenario) {
		probe, err := s.argo.ForApplication(run.Application).Probe(ctx)
		confirmedFixed = err == nil && s.fixed(ctx, run, probe)
	}
	s.mu.Lock()
	if state == "INVESTIGATING" && run.State == "READY" {
		run.State = state
	} else if state == "COMPLETED" && (confirmedFixed &&
		(run.State == "READY" || run.State == "INVESTIGATING" || run.State == "FIXED") ||
		isOrientation(run.Scenario) && run.State == "INVESTIGATING") {
		run.State = state
		run.cancel()
	} else {
		s.mu.Unlock()
		respondError(w, 409, fmt.Errorf("cannot transition %s to %s", run.State, state))
		return
	}
	run.UpdatedAt = time.Now().UTC()
	view := publicRun(run)
	s.mu.Unlock()
	respond(w, 200, view)
}

func (s *Server) abort(w http.ResponseWriter, id string) {
	s.mu.Lock()
	run := s.runs[id]
	if run == nil {
		s.mu.Unlock()
		respondError(w, 404, errors.New("run not found"))
		return
	}
	run.State = "ABORTED"
	run.UpdatedAt = time.Now().UTC()
	run.cancel()
	s.mu.Unlock()
	respond(w, 200, map[string]any{"aborted": true})
}

func (s *Server) reset(w http.ResponseWriter, id string, r *http.Request) {
	s.createMu.Lock()
	defer s.createMu.Unlock()
	request, err := readRequest(r)
	if err != nil {
		respondError(w, 400, err)
		return
	}
	s.mu.Lock()
	run := s.runs[id]
	if run == nil {
		s.mu.Unlock()
		respondError(w, 404, errors.New("run not found"))
		return
	}
	run.State = "ABORTED"
	run.cancel()
	done := run.done
	s.mu.Unlock()
	select {
	case <-done:
	case <-time.After(15 * time.Second):
		respondError(w, 409, errors.New("previous run is still stopping"))
		return
	}
	if _, present := request["scenario"]; !present {
		request["scenario"] = run.Scenario
	}
	if _, present := request["seed"]; !present {
		request["seed"] = float64(run.Seed)
	}
	s.createRun(w, request)
}

func respond(w http.ResponseWriter, code int, payload any) {
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(payload)
}

func respondError(w http.ResponseWriter, code int, err error) {
	respond(w, code, map[string]string{"error": err.Error(), "code": strconv.Itoa(code)})
}
