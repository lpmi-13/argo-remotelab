package main

import (
	"context"
	"log"
	"math/rand"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/lpmi-13/argo-remotelab/scenario-controller/internal/api"
	"github.com/lpmi-13/argo-remotelab/scenario-controller/internal/argocd"
	"github.com/lpmi-13/argo-remotelab/scenario-controller/internal/git"
	"github.com/lpmi-13/argo-remotelab/scenario-controller/internal/scenarios"
)

func main() {
	log.SetFlags(log.Ldate | log.Ltime | log.LUTC)
	log.Println("scenario-controller starting up")

	// Load configuration from environment variables.
	argocdServer := requireEnv("ARGOCD_SERVER")
	argocdAppName := requireEnv("ARGOCD_APP_NAME")
	argocdUsername := requireEnv("ARGOCD_USERNAME")
	argocdPassword := requireEnv("ARGOCD_PASSWORD")
	giteaURL := requireEnv("GITEA_URL")
	giteaUsername := requireEnv("GITEA_USERNAME")
	giteaPassword := requireEnv("GITEA_PASSWORD")
	giteaRepo := requireEnv("GITEA_REPO")
	sopsAgeKey := requireEnv("SOPS_AGE_KEY")
	agePublicKey := requireEnv("AGE_PUBLIC_KEY")

	minDelay := envInt("MIN_DELAY_SECONDS", 0)
	maxDelay := envInt("MAX_DELAY_SECONDS", 0)

	log.Printf("config: argocd_server=%s app=%s gitea=%s repo=%s min_delay=%ds max_delay=%ds",
		argocdServer, argocdAppName, giteaURL, giteaRepo, minDelay, maxDelay)

	// Set up context with signal handling for graceful shutdown.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		sig := <-sigCh
		log.Printf("received signal %v, shutting down", sig)
		cancel()
	}()

	// Initialise clients.
	argoClient, err := argocd.NewClient(argocdServer, argocdAppName, argocdUsername, argocdPassword)
	if err != nil {
		log.Fatalf("failed to create argocd client: %v", err)
	}

	gitClient := git.NewClient(giteaURL, giteaUsername, giteaPassword, giteaRepo, sopsAgeKey, agePublicKey)

	// Register all scenarios.
	registry := scenarios.NewRegistry()
	registry.Register(&scenarios.MissingConfigMap{})
	registry.Register(&scenarios.SopsDecryptFailure{})
	registry.Register(&scenarios.SopsGlobalMACMismatch{})
	registry.Register(&scenarios.HMACMismatch{})
	registry.Register(&scenarios.WrongTypeSops{})
	registry.Register(&scenarios.StuckSync{})
	registry.Register(&scenarios.StaleJob{})
	registry.Register(&scenarios.OrphanedResource{})
	registry.Register(&scenarios.EnvDrift{})
	if os.Getenv("LAB_MODE") == "api" {
		registry.Register(&scenarios.RepoAuth{})
	}

	if first := os.Getenv("FIRST_SCENARIO"); first != "" {
		pool := splitAndTrim(first, ",")
		registry.SetFirstScenarios(pool)
		log.Printf("first scenario picked from pool %v (subsequent runs are random)", pool)
	}

	log.Printf("registered %d scenarios: %v", registry.Count(), registry.Names())
	if os.Getenv("LAB_MODE") == "api" {
		server := &http.Server{Addr: ":8092", Handler: api.NewServer(argoClient, gitClient, registry), ReadHeaderTimeout: 10 * time.Second}
		go func() {
			<-ctx.Done()
			shutdownCtx, done := context.WithTimeout(context.Background(), 5*time.Second)
			defer done()
			_ = server.Shutdown(shutdownCtx)
		}()
		log.Println("run API listening on :8092")
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("run API failed: %v", err)
		}
		return
	}

	// Main control loop.
	if err := runLoop(ctx, argoClient, gitClient, registry, minDelay, maxDelay); err != nil {
		if ctx.Err() != nil {
			log.Println("controller shut down gracefully")
			return
		}
		log.Fatalf("controller loop failed: %v", err)
	}
}

// runLoop is the main control loop that waits for healthy state, injects a
// failure scenario, waits for the user to fix it, then repeats.
func runLoop(
	ctx context.Context,
	argoClient *argocd.Client,
	gitClient *git.Client,
	registry *scenarios.Registry,
	minDelay, maxDelay int,
) error {
	for {
		// Step 1: Wait for ArgoCD app to be healthy and synced.
		log.Println("waiting for ArgoCD application to be Healthy and Synced...")
		if err := waitForHealthy(ctx, argoClient); err != nil {
			return err
		}
		log.Println("application is Healthy and Synced")

		// Step 2: Wait before injecting a failure (skip if delay is 0).
		delay := randomDuration(minDelay, maxDelay)
		if delay > 0 {
			log.Printf("waiting %v before injecting next scenario...", delay)
			if err := sleepCtx(ctx, delay); err != nil {
				return err
			}
		}

		// Step 3: Pick a random scenario and inject the failure.
		scenario := registry.Random()
		log.Printf("=== INJECTING SCENARIO: %s ===", scenario.Name())
		log.Printf("description: %s", scenario.Description())

		if err := scenario.Inject(gitClient); err != nil {
			log.Printf("ERROR: failed to inject scenario %q: %v", scenario.Name(), err)
			log.Println("will retry with a different scenario on next iteration")
			continue
		}
		log.Printf("scenario %q injected successfully, pushed to git", scenario.Name())

		// Step 4: Prompt ArgoCD to detect the new Git state immediately.
		if err := argoClient.RequestHardRefresh(ctx); err != nil {
			log.Printf("WARNING: failed to request ArgoCD hard refresh: %v", err)
		} else {
			log.Println("requested ArgoCD hard refresh")
		}

		log.Println("waiting for ArgoCD to report a sync or health problem...")
		if err := waitForUnhealthy(ctx, argoClient); err != nil {
			return err
		}
		log.Println("application is now reporting a sync or health problem - scenario injection confirmed")
		if err := markScenarioReady(ctx, argoClient, scenario.Name()); err != nil {
			return err
		}
		log.Printf("marked scenario %q ready for lab entry", scenario.Name())
		log.Println("helpful diagnostic commands:")
		for _, cmd := range scenario.DiagnoseCommands() {
			log.Printf("  $ %s", cmd)
		}

		// Step 5: Wait for the user to fix it (app becomes healthy again).
		log.Println("waiting for user to fix the issue (app must return to Healthy + Synced)...")
		if err := waitForHealthy(ctx, argoClient); err != nil {
			return err
		}

		// Step 6: Log the explanation and revert any leftover state.
		log.Printf("=== SCENARIO RESOLVED: %s ===", scenario.Name())
		log.Printf("explanation: %s", scenario.Explanation())

		if err := scenario.Revert(gitClient); err != nil {
			log.Printf("WARNING: failed to revert scenario %q: %v (may self-heal)", scenario.Name(), err)
		}

		log.Println("--- cycle complete, starting next round ---")
	}
}

func markScenarioReady(ctx context.Context, client *argocd.Client, scenarioName string) error {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()

	for {
		if err := client.MarkScenarioReady(ctx, scenarioName); err != nil {
			log.Printf("warning: failed to mark scenario ready: %v", err)
		} else {
			return nil
		}

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

// waitForHealthy polls the ArgoCD application status until it is Healthy,
// Synced, and not carrying a running or failed operation.
func waitForHealthy(ctx context.Context, client *argocd.Client) error {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	for {
		health, sync, operationPhase, err := client.GetAppStatus(ctx)
		if err != nil {
			log.Printf("warning: failed to get app status: %v", err)
		} else if health == "Healthy" && sync == "Synced" && operationPhaseIsSettled(operationPhase) {
			return nil
		} else {
			log.Printf("  app status: health=%s sync=%s operation=%s", health, sync, operationPhase)
		}

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

// waitForUnhealthy polls the ArgoCD application status until it is NOT in a
// Healthy+Synced state, indicating the injected failure has been detected.
func waitForUnhealthy(ctx context.Context, client *argocd.Client) error {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	for {
		health, sync, operationPhase, err := client.GetAppStatus(ctx)
		if err != nil {
			log.Printf("warning: failed to get app status: %v", err)
		} else if health != "Healthy" || sync != "Synced" || !operationPhaseIsSettled(operationPhase) {
			log.Printf("  app status changed: health=%s sync=%s operation=%s", health, sync, operationPhase)
			return nil
		}

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

func operationPhaseIsSettled(phase string) bool {
	return phase == "Succeeded" || phase == "Unknown"
}

// sleepCtx sleeps for the given duration, or returns early if ctx is cancelled.
func sleepCtx(ctx context.Context, d time.Duration) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(d):
		return nil
	}
}

// randomDuration returns a random duration between min and max seconds.
func randomDuration(minSec, maxSec int) time.Duration {
	n := minSec + rand.Intn(maxSec-minSec+1)
	return time.Duration(n) * time.Second
}

// requireEnv reads a required environment variable or exits.
func requireEnv(key string) string {
	val := os.Getenv(key)
	if val == "" {
		log.Fatalf("required environment variable %s is not set", key)
	}
	return val
}

// splitAndTrim splits s on sep and returns non-empty trimmed parts.
func splitAndTrim(s, sep string) []string {
	parts := strings.Split(s, sep)
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if t := strings.TrimSpace(p); t != "" {
			out = append(out, t)
		}
	}
	return out
}

// envInt reads an integer environment variable with a default fallback.
func envInt(key string, defaultVal int) int {
	val := os.Getenv(key)
	if val == "" {
		return defaultVal
	}
	n, err := strconv.Atoi(val)
	if err != nil {
		log.Printf("warning: invalid integer for %s=%q, using default %d", key, val, defaultVal)
		return defaultVal
	}
	return n
}
