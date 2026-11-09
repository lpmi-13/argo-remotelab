package scenarios

import (
	"strings"
	"testing"
)

func TestWrongTypeSopsVariantsCoverExpectedShapes(t *testing.T) {
	want := map[string]string{
		"string": `secrets: "not-a-map"`,
		"list":   "secrets:\n  - DB_PASSWORD=not-a-map",
		"int":    "secrets: 404",
		"map":    `invalid=env-name: "wrong-map-shape"`,
	}

	if len(wrongTypeSopsVariants) != len(want) {
		t.Fatalf("expected %d wrong-type-sops variants, got %d", len(want), len(wrongTypeSopsVariants))
	}

	for _, variant := range wrongTypeSopsVariants {
		marker, ok := want[variant.name]
		if !ok {
			t.Fatalf("unexpected wrong-type-sops variant %q", variant.name)
		}

		if !strings.Contains(variant.plaintext, marker) {
			t.Fatalf("variant %q plaintext does not include marker %q:\n%s", variant.name, marker, variant.plaintext)
		}
	}
}
