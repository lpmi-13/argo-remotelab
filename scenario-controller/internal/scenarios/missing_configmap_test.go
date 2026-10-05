package scenarios

import (
	"os"
	"strings"
	"testing"
)

func TestMissingConfigVariantsUseDistinctRequiredReferences(t *testing.T) {
	data, err := os.ReadFile("../../../sample-django-app/chart/django-app/templates/deployment.yaml")
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for seed, signal := range []string{"envFrom", "configMapKeyRef", "volumeMounts"} {
		modified, err := missingConfigVariant(string(data), int64(seed))
		if err != nil {
			t.Fatalf("seed %d: %v", seed, err)
		}
		if !strings.Contains(modified, "django-app-missing-config") || !strings.Contains(modified, signal) {
			t.Fatalf("seed %d did not include %s or the missing name", seed, signal)
		}
		if seen[modified] {
			t.Fatalf("seed %d repeated a prior variant", seed)
		}
		seen[modified] = true
	}
}
