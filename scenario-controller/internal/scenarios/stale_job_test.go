package scenarios

import (
	"os"
	"strings"
	"testing"
)

func TestStaleJobTriggerSurvivesRunStamp(t *testing.T) {
	data, err := os.ReadFile("../../../sample-django-app/chart/django-app/templates/deployment.yaml")
	if err != nil {
		t.Fatal(err)
	}
	// ResetToBaseline stamps every run directly under the pod annotations.
	const annotations = "      annotations:\n"
	stamped := strings.Replace(string(data), annotations,
		annotations+"        remotelab.local/run-id: \"run-0000000000000001\"\n", 1)

	for name, deployment := range map[string]string{"baseline": string(data), "stamped": stamped} {
		injected, err := addStaleJobTrigger(deployment)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if !strings.Contains(injected, staleJobTrigger+staleJobAnchor) {
			t.Fatalf("%s: trigger was not added next to the scrape annotation", name)
		}
		if reverted := strings.Replace(injected, staleJobTrigger, "", 1); reverted != deployment {
			t.Fatalf("%s: revert did not restore the deployment", name)
		}
	}
}
