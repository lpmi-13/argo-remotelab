package argocd

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/rest"
)

// applicationGVR is the GroupVersionResource for ArgoCD Application CRs.
var applicationGVR = schema.GroupVersionResource{
	Group:    "argoproj.io",
	Version:  "v1alpha1",
	Resource: "applications",
}

var deploymentGVR = schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "deployments"}
var configMapGVR = schema.GroupVersionResource{Group: "", Version: "v1", Resource: "configmaps"}

const (
	FirstScenarioReadyAnnotation = "remotelab.io/first-scenario-ready"
	CurrentScenarioAnnotation    = "remotelab.io/current-scenario"
)

// Client reads Application state from Kubernetes and uses Argo's API for
// operation termination, which must also stop Argo's internal retry loop.
type Client struct {
	dynClient dynamic.Interface
	appName   string
	namespace string // ArgoCD applications live in the "argocd" namespace
	serverURL string
	username  string
	password  string
}

// NewClient creates a new ArgoCD client that reads Application CRs from the
// Kubernetes API using in-cluster configuration.
func NewClient(argocdServer, appName, username, password string) (*Client, error) {
	if parsed, err := url.Parse(argocdServer); err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return nil, fmt.Errorf("ARGOCD_SERVER must be a complete URL")
	}

	config, err := rest.InClusterConfig()
	if err != nil {
		return nil, fmt.Errorf("failed to get in-cluster config: %w", err)
	}

	dynClient, err := dynamic.NewForConfig(config)
	if err != nil {
		return nil, fmt.Errorf("failed to create dynamic client: %w", err)
	}

	log.Printf("argocd client initialised: watching application %q in namespace %q via K8s API", appName, "argocd")

	return &Client{
		dynClient: dynClient,
		appName:   appName,
		namespace: "argocd",
		serverURL: strings.TrimRight(argocdServer, "/"),
		username:  username,
		password:  password,
	}, nil
}

// ForApplication returns a client for another lab Application using the same
// in-cluster credentials.
func (c *Client) ForApplication(name string) *Client {
	view := *c
	view.appName = name
	return &view
}

// AppName reports the Application this client is watching.
func (c *Client) AppName() string { return c.appName }

// GetAppStatus returns the health, sync, and operation phase of the ArgoCD
// Application. It reads .status.health.status, .status.sync.status, and the
// active operation state from the Application CR.
//
// Typical health values: "Healthy", "Degraded", "Progressing", "Missing", "Unknown"
// Typical sync values:   "Synced", "OutOfSync", "Unknown"
// Typical operation phases: "Running", "Succeeded", "Failed", "Error", "Unknown"
func (c *Client) GetAppStatus(ctx context.Context) (health string, sync string, operationPhase string, err error) {
	app, err := c.dynClient.Resource(applicationGVR).Namespace(c.namespace).Get(ctx, c.appName, metav1.GetOptions{})
	if err != nil {
		return "", "", "", fmt.Errorf("failed to get application %q: %w", c.appName, err)
	}

	health, err = extractNestedString(app, "status", "health", "status")
	if err != nil {
		return "", "", "", fmt.Errorf("failed to read health status: %w", err)
	}

	sync, err = extractNestedString(app, "status", "sync", "status")
	if err != nil {
		return "", "", "", fmt.Errorf("failed to read sync status: %w", err)
	}

	// ArgoCD can leave .status.operationState.phase as "Running" after a user
	// terminates a failed sync retry. The top-level .operation field is the
	// active operation; if it is absent, the app should not be considered busy.
	if _, found, err := unstructured.NestedMap(app.Object, "operation"); err != nil {
		return "", "", "", fmt.Errorf("failed to read active operation: %w", err)
	} else if !found {
		return health, sync, "Succeeded", nil
	}

	operationPhase, err = extractNestedString(app, "status", "operationState", "phase")
	if err != nil {
		return "", "", "", fmt.Errorf("failed to read operation phase: %w", err)
	}

	return health, sync, operationPhase, nil
}

// RequestHardRefresh asks ArgoCD to immediately refresh the Application and
// invalidate cached manifest generation results.
func (c *Client) RequestHardRefresh(ctx context.Context) error {
	if err := c.patchAnnotations(ctx, map[string]string{"argocd.argoproj.io/refresh": "hard"}); err != nil {
		return fmt.Errorf("failed to request hard refresh for application %q: %w", c.appName, err)
	}
	return nil
}

// MarkScenarioReady records that ArgoCD has detected an injected scenario and
// the lab can be shown to the learner.
func (c *Client) MarkScenarioReady(ctx context.Context, scenarioName string) error {
	annotations, err := scenarioReadyAnnotations(scenarioName)
	if err != nil {
		return err
	}

	if err := c.patchAnnotations(ctx, annotations); err != nil {
		return fmt.Errorf("failed to mark scenario %q ready on application %q: %w", scenarioName, c.appName, err)
	}
	return nil
}

// ClearScenarioReady removes the previous run's handoff marker during reset.
func (c *Client) ClearScenarioReady(ctx context.Context) error {
	return c.patchAnnotations(ctx, map[string]string{
		FirstScenarioReadyAnnotation: "false",
		CurrentScenarioAnnotation:    "",
	})
}

func scenarioReadyAnnotations(scenarioName string) (map[string]string, error) {
	if scenarioName == "" {
		return nil, fmt.Errorf("scenario name cannot be empty")
	}

	return map[string]string{
		FirstScenarioReadyAnnotation: "true",
		CurrentScenarioAnnotation:    scenarioName,
	}, nil
}

func annotationPatch(annotations map[string]string) ([]byte, error) {
	return json.Marshal(map[string]any{
		"metadata": map[string]any{
			"annotations": annotations,
		},
	})
}

func (c *Client) patchAnnotations(ctx context.Context, annotations map[string]string) error {
	patch, err := annotationPatch(annotations)
	if err != nil {
		return fmt.Errorf("failed to encode annotation patch: %w", err)
	}

	_, err = c.dynClient.Resource(applicationGVR).Namespace(c.namespace).Patch(
		ctx,
		c.appName,
		types.MergePatchType,
		patch,
		metav1.PatchOptions{},
	)
	if err != nil {
		return err
	}
	return nil
}

// extractNestedString safely reads a nested string field from an unstructured
// object. Returns "Unknown" if the field path does not exist.
func extractNestedString(obj *unstructured.Unstructured, fields ...string) (string, error) {
	val, found, err := unstructured.NestedString(obj.Object, fields...)
	if err != nil {
		return "", err
	}
	if !found {
		return "Unknown", nil
	}
	return val, nil
}

// GetAppRaw returns the full Application CR as raw JSON (useful for debugging).
func (c *Client) GetAppRaw(ctx context.Context) ([]byte, error) {
	app, err := c.dynClient.Resource(applicationGVR).Namespace(c.namespace).Get(ctx, c.appName, metav1.GetOptions{})
	if err != nil {
		return nil, fmt.Errorf("failed to get application %q: %w", c.appName, err)
	}
	return json.MarshalIndent(app.Object, "", "  ")
}

// Probe reads the controller's authoritative Application snapshot. The
// learning service uses it for readiness and outcome validation.
func (c *Client) Probe(ctx context.Context) (map[string]any, error) {
	app, err := c.dynClient.Resource(applicationGVR).Namespace(c.namespace).Get(ctx, c.appName, metav1.GetOptions{})
	if err != nil {
		return nil, err
	}
	status, _, err := unstructured.NestedMap(app.Object, "status")
	if err != nil {
		return nil, err
	}
	_, busy, err := unstructured.NestedMap(app.Object, "operation")
	if err != nil {
		return nil, err
	}
	repoURL, _, _ := unstructured.NestedString(app.Object, "spec", "source", "repoURL")
	return map[string]any{
		"application":       c.appName,
		"labels":            app.GetLabels(),
		"annotations":       app.GetAnnotations(),
		"status":            status,
		"operation_running": busy,
		"repo_url":          repoURL,
	}, nil
}

// SetRepoURL changes only the target Application's source URL. This powers
// the repository-auth exercise and restores the known baseline on reset.
func (c *Client) SetRepoURL(ctx context.Context, repoURL string) error {
	patch, err := json.Marshal(map[string]any{"spec": map[string]any{"source": map[string]any{"repoURL": repoURL}}})
	if err != nil {
		return err
	}
	_, err = c.dynClient.Resource(applicationGVR).Namespace(c.namespace).Patch(ctx, c.appName, types.MergePatchType, patch, metav1.PatchOptions{})
	return err
}

// TerminateOperation uses Argo's API so the retry state is terminated too.
// Clearing the CR's top-level operation alone leaves Argo retrying its stale
// PreSync hook and blocks a successful sync of the repaired revision.
func (c *Client) TerminateOperation(ctx context.Context) error {
	probe, err := c.Probe(ctx)
	if err != nil || probe["operation_running"] != true {
		return err
	}
	token, err := c.sessionToken(ctx)
	if err != nil {
		return err
	}
	endpoint := c.serverURL + "/api/v1/applications/" + url.PathEscape(c.appName) + "/operation?appNamespace=" + url.QueryEscape(c.namespace)
	request, err := http.NewRequestWithContext(ctx, http.MethodDelete, endpoint, nil)
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	response, err := (&http.Client{Timeout: 15 * time.Second}).Do(request)
	if err != nil {
		return fmt.Errorf("terminate Argo operation: %w", err)
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
	if response.StatusCode < 300 {
		return nil
	}
	if after, err := c.Probe(ctx); err == nil && after["operation_running"] != true {
		return nil
	}
	return fmt.Errorf("terminate Argo operation: HTTP %d", response.StatusCode)
}

func (c *Client) sessionToken(ctx context.Context) (string, error) {
	data, err := json.Marshal(map[string]string{"username": c.username, "password": c.password})
	if err != nil {
		return "", err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.serverURL+"/api/v1/session", bytes.NewReader(data))
	if err != nil {
		return "", err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := (&http.Client{Timeout: 15 * time.Second}).Do(request)
	if err != nil {
		return "", fmt.Errorf("Argo login: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", fmt.Errorf("Argo login: HTTP %d", response.StatusCode)
	}
	var result struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 1024*1024)).Decode(&result); err != nil || result.Token == "" {
		return "", fmt.Errorf("Argo login returned no token")
	}
	return result.Token, nil
}

// RequestSync starts a hook-aware sync at the revision that Git has just
// published. The stale-job reference route uses this after the failed hook
// operation is terminated; otherwise Argo may consider the old live resources
// already equal to the repaired source and never rerun the hook.
func (c *Client) RequestSync(ctx context.Context, revision string) error {
	patch, err := json.Marshal(map[string]any{"operation": map[string]any{
		"initiatedBy": map[string]any{"username": "scenario-controller"},
		"sync": map[string]any{"revision": revision, "prune": false,
			"syncStrategy": map[string]any{"hook": map[string]any{}}},
	}})
	if err != nil {
		return err
	}
	_, err = c.dynClient.Resource(applicationGVR).Namespace(c.namespace).Patch(
		ctx, c.appName, types.MergePatchType, patch, metav1.PatchOptions{})
	return err
}

// ResourceExists and DeleteResource are limited to Deployment resources used
// by the orphaned-resource exercise.
func (c *Client) ResourceExists(ctx context.Context, namespace, name string) (bool, error) {
	_, err := c.dynClient.Resource(deploymentGVR).Namespace(namespace).Get(ctx, name, metav1.GetOptions{})
	if err == nil {
		return true, nil
	}
	if apierrors.IsNotFound(err) {
		return false, nil
	}
	return false, err
}

func (c *Client) DeleteResource(ctx context.Context, namespace, name string) error {
	err := c.dynClient.Resource(deploymentGVR).Namespace(namespace).Delete(ctx, name, metav1.DeleteOptions{})
	if apierrors.IsNotFound(err) {
		return nil
	}
	return err
}

// DeleteMissingConfigMap removes the exact live-only workaround a learner can
// create during the missing-configmap exercise. It is absent from the chart.
func (c *Client) DeleteMissingConfigMap(ctx context.Context, namespace string) error {
	err := c.dynClient.Resource(configMapGVR).Namespace(namespace).Delete(
		ctx, "django-app-missing-config", metav1.DeleteOptions{},
	)
	if apierrors.IsNotFound(err) {
		return nil
	}
	return err
}
