package api

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestPrepareCreateReplacesClosedTabRunAfterWorkerStops(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan struct{})
	server := &Server{runs: map[string]*Run{"old": {
		ID: "old", State: "READY", cancel: cancel, done: done,
	}}, activeID: "old"}
	if err := server.prepareCreate(false); err == nil {
		t.Fatal("an ordinary API request replaced an active run")
	}
	if server.runs["old"].State != "READY" {
		t.Fatal("rejected request changed the active run")
	}
	finished := make(chan error, 1)
	go func() { finished <- server.prepareCreate(true) }()
	<-ctx.Done()
	server.mu.Lock()
	state := server.runs["old"].State
	server.mu.Unlock()
	if state != "ABORTED" {
		t.Fatal("replacement did not mark the old run aborted")
	}
	select {
	case <-finished:
		t.Fatal("replacement proceeded before the old worker exited")
	default:
	}
	close(done)
	if err := <-finished; err != nil {
		t.Fatalf("replacement was rejected after worker exit: %v", err)
	}
}

func statusProbe(health, sync string, running bool) map[string]any {
	return map[string]any{
		"status": map[string]any{
			"health": map[string]any{"status": health},
			"sync":   map[string]any{"status": sync, "revision": "abc123"},
		},
		"operation_running": running,
	}
}

func TestSeededEnvironmentIsReproducible(t *testing.T) {
	request := map[string]any{"scenario_key": "incident-123"}
	first := seedFor(request)
	if first != seedFor(request) || first > 0x1fffffffffffff {
		t.Fatalf("seed is not stable and JSON-safe: %d", first)
	}
	if first == seedFor(map[string]any{"scenario_key": "incident-124"}) {
		t.Fatal("distinct keys produced the same seed")
	}
	firstEnv, _ := environmentFor(request, first)
	secondEnv, _ := environmentFor(request, seedFor(request))
	if firstEnv != secondEnv {
		t.Fatal("environment changed for the same key")
	}
}

func TestEnvironmentOverrideIsValidated(t *testing.T) {
	if got, err := environmentFor(map[string]any{"environment": "staging"}, 2); err != nil || got != "staging" {
		t.Fatalf("valid override rejected: %q, %v", got, err)
	}
	if _, err := environmentFor(map[string]any{"environment": "production"}, 2); err == nil {
		t.Fatal("invalid environment was accepted")
	}
}

func TestAppStatePredicates(t *testing.T) {
	if !isFixed(statusProbe("Healthy", "Synced", false)) {
		t.Fatal("healthy settled app should be fixed")
	}
	for _, probe := range []map[string]any{
		statusProbe("Progressing", "Synced", false),
		statusProbe("Healthy", "OutOfSync", false),
		statusProbe("Healthy", "Synced", true),
	} {
		if isFixed(probe) {
			t.Fatalf("incorrectly accepted app state: %#v", probe)
		}
	}
	server := &Server{}
	if !server.detected(t.Context(), &Run{Scenario: "missing-configmap"}, statusProbe("Progressing", "OutOfSync", false)) {
		t.Fatal("progressing workload was not detected")
	}
	if server.detected(t.Context(), &Run{Scenario: "missing-configmap"}, statusProbe("Healthy", "OutOfSync", false)) {
		t.Fatal("out-of-sync alone should not mark a pod failure ready")
	}
	if server.detected(t.Context(), &Run{Scenario: "stuck-sync"}, statusProbe("Progressing", "Synced", false)) {
		t.Fatal("a settled sync is not a stuck operation")
	}
	if !server.detected(t.Context(), &Run{Scenario: "stuck-sync"}, statusProbe("Progressing", "Synced", true)) {
		t.Fatal("a progressing app with an active sync should be ready")
	}
	sops := statusProbe("Unknown", "Unknown", false)
	sops["status"].(map[string]any)["conditions"] = []any{map[string]any{"type": "ComparisonError"}}
	if !server.detected(t.Context(), &Run{Scenario: "sops-decrypt-failure"}, sops) {
		t.Fatal("comparison error was not detected")
	}
	failedHook := statusProbe("Healthy", "OutOfSync", true)
	failedHook["status"].(map[string]any)["operationState"] = map[string]any{
		"phase": "Running", "syncResult": map[string]any{"resources": []any{
			map[string]any{"kind": "Job", "hookType": "PreSync", "hookPhase": "Failed"},
		}},
	}
	if !server.detected(t.Context(), &Run{Scenario: "stale-job"}, failedHook) {
		t.Fatal("failed PreSync hook was not detected during Argo's retry operation")
	}
	applyFailure := statusProbe("Healthy", "OutOfSync", true)
	applyFailure["status"].(map[string]any)["operationState"] = map[string]any{
		"phase":     "Running",
		"message":   "one or more objects failed to apply, reason: Job cannot be handled. Retrying attempt #4",
		"operation": map[string]any{"sync": map[string]any{"revision": "bad-secrets"}},
	}
	if !server.detected(t.Context(), &Run{Scenario: "wrong-type-sops", TriggerRevision: "bad-secrets"}, applyFailure) {
		t.Fatal("wrong-type SOPS apply error should be ready during Argo's retry operation")
	}
	if server.detected(t.Context(), &Run{Scenario: "wrong-type-sops", TriggerRevision: "another-revision"}, applyFailure) {
		t.Fatal("an old apply error should not make a new run ready")
	}
}

func TestLiveOnlyRepairIsNotDurable(t *testing.T) {
	gitHead := "abc123"
	if sourceRevisionChanged(&Run{Scenario: "missing-configmap", TriggerRevision: gitHead}, gitHead) {
		t.Fatal("a live-only fix cannot be durable when git has not changed")
	}
	if !sourceRevisionChanged(&Run{Scenario: "missing-configmap", TriggerRevision: gitHead}, "fixed456") {
		t.Fatal("a changed source revision should be eligible for durability")
	}
	if !sourceRevisionChanged(&Run{Scenario: "repo-auth", TriggerRevision: gitHead}, gitHead) {
		t.Fatal("restoring the Application repository URL does not require a chart commit")
	}
	run := &Run{Scenario: "missing-configmap", TriggerRevision: gitHead, TriggerChartTree: "broken-tree"}
	if sourceTreeChanged(run, "fixed456", "broken-tree") {
		t.Fatal("an unrelated Git commit cannot make a live-only repair durable")
	}
	if !sourceTreeChanged(run, "fixed456", "fixed-tree") {
		t.Fatal("a changed chart tree should be eligible for durability")
	}
	run.TriggerRenderHash = "broken-manifests"
	if sourceRenderChanged(run, "broken-manifests") {
		t.Fatal("a chart edit that renders the same desired state is not durable")
	}
	if !sourceRenderChanged(run, "fixed-manifests") {
		t.Fatal("a changed rendered state should be eligible for durability")
	}
	if sourceRenderChanged(run, "") {
		t.Fatal("a chart that cannot render cannot be a durable fix")
	}
	run.TriggerRenderHash = ""
	run.TriggerRenderFailed = true
	if !sourceRenderChanged(run, "fixed-manifests") {
		t.Fatal("repairing a chart that failed to render should be eligible for durability")
	}
}

func TestReadRequestHandlesEmptyAndOversizedBodies(t *testing.T) {
	request := &http.Request{Body: io.NopCloser(strings.NewReader(""))}
	got, err := readRequest(request)
	if err != nil || len(got) != 0 {
		t.Fatalf("empty request: %#v, %v", got, err)
	}
	request = &http.Request{Body: io.NopCloser(strings.NewReader(strings.Repeat("a", 64*1024+1)))}
	if _, err := readRequest(request); err == nil {
		t.Fatal("oversized request accepted")
	}
}
