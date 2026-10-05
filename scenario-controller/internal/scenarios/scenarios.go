package scenarios

import (
	"log"
	"math/rand"

	"github.com/lpmi-13/argo-remotelab/scenario-controller/internal/git"
)

// Scenario defines the interface that each failure scenario must implement.
type Scenario interface {
	// Name returns a short, unique identifier for the scenario.
	Name() string

	// Description returns a human-readable description of what the scenario does.
	Description() string

	// Inject performs the failure injection by modifying files in the git repository.
	Inject(gitClient *git.Client) error

	// Revert restores the original state after the user has fixed the issue.
	Revert(gitClient *git.Client) error

	// Explanation returns a detailed explanation of the scenario that is logged
	// after the user successfully fixes it.
	Explanation() string

	// DiagnoseCommands returns a list of kubectl commands that would help
	// diagnose the injected failure.
	DiagnoseCommands() []string
}

// Registry holds all registered scenarios and provides random selection.
type Registry struct {
	scenarios      []Scenario
	queue          []Scenario
	lastName       string
	firstPool      []string
	servedScenario bool
}

// SetFirstScenarios constrains the very first call to Random to pick from the
// supplied pool of scenario names. Subsequent calls fall back to the normal
// shuffled-queue rotation. Names not matching any registered scenario are
// silently skipped; an empty pool opts out entirely.
func (r *Registry) SetFirstScenarios(names []string) {
	r.firstPool = names
}

// NewRegistry creates a new empty scenario registry.
func NewRegistry() *Registry {
	return &Registry{}
}

// Register adds a scenario to the registry.
func (r *Registry) Register(s Scenario) {
	log.Printf("registered scenario: %s", s.Name())
	r.scenarios = append(r.scenarios, s)
}

// Random selects and returns a scenario from a shuffled queue. Each registered
// scenario is returned once before the queue is shuffled again.
//
// The very first call honours SetFirstScenarios when configured, so labs can
// pin a pool of fast-to-detect failures for the initial run and reduce
// startup latency.
func (r *Registry) Random() Scenario {
	if len(r.scenarios) == 0 {
		panic("no scenarios registered")
	}

	if !r.servedScenario {
		if scenario := r.pickFromFirstPool(); scenario != nil {
			r.servedScenario = true
			r.lastName = scenario.Name()
			return scenario
		}
	}

	if len(r.queue) == 0 {
		r.refillQueue()
	}

	scenario := r.queue[0]
	r.queue = r.queue[1:]
	r.lastName = scenario.Name()
	r.servedScenario = true
	return scenario
}

func (r *Registry) pickFromFirstPool() Scenario {
	if len(r.firstPool) == 0 {
		return nil
	}

	var matched []Scenario
	for _, name := range r.firstPool {
		for _, s := range r.scenarios {
			if s.Name() == name {
				matched = append(matched, s)
				break
			}
		}
	}
	if len(matched) == 0 {
		return nil
	}
	return matched[rand.Intn(len(matched))]
}

// Count returns the number of registered scenarios.
func (r *Registry) Count() int {
	return len(r.scenarios)
}

// Names returns the names of all registered scenarios.
func (r *Registry) Names() []string {
	names := make([]string, len(r.scenarios))
	for i, s := range r.scenarios {
		names[i] = s.Name()
	}
	return names
}

// Find returns a registered scenario by its stable name.
func (r *Registry) Find(name string) Scenario {
	for _, scenario := range r.scenarios {
		if scenario.Name() == name {
			return scenario
		}
	}
	return nil
}

func (r *Registry) refillQueue() {
	indices := rand.Perm(len(r.scenarios))
	r.queue = make([]Scenario, len(indices))
	for i, idx := range indices {
		r.queue[i] = r.scenarios[idx]
	}

	if len(r.queue) > 1 && r.queue[0].Name() == r.lastName {
		r.queue[0], r.queue[1] = r.queue[1], r.queue[0]
	}
}

// Common file paths within the cloned repo that scenarios operate on.
const (
	ValuesFile     = "chart/django-app/values.yaml"
	SecretsFile    = "chart/django-app/secrets.yaml.enc"
	DeploymentFile = "chart/django-app/templates/deployment.yaml"
	ServiceFile    = "chart/django-app/templates/service.yaml"
	ConfigMapFile  = "chart/django-app/templates/configmap.yaml"
	MigrateJobFile = "chart/django-app/templates/migrate-job.yaml"
	HelpersFile    = "chart/django-app/templates/_helpers.tpl"
)
