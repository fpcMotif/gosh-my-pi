package cmd

import (
	"bytes"
	"strings"
	"testing"

	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/workspace"
)

func TestWriteModelCatalogNonTerminalIncludesUnavailableModels(t *testing.T) {
	catalog := workspace.ModelCatalog{Models: []workspace.ModelCatalogEntry{
		{Provider: "zeta", ID: "later", Available: true},
		{Provider: "alpha", ID: "unavailable", Available: false},
		{Provider: "alpha", ID: "earlier", Available: true},
	}}
	var output bytes.Buffer

	if err := writeModelCatalog(&output, catalog, "", false); err != nil {
		t.Fatalf("writeModelCatalog: %v", err)
	}
	if got, want := output.String(), "alpha/earlier\nalpha/unavailable\nzeta/later\n"; got != want {
		t.Fatalf("output = %q, want %q", got, want)
	}
}

func TestWriteModelCatalogFiltersEveryBackendLabel(t *testing.T) {
	catalog := workspace.ModelCatalog{Models: []workspace.ModelCatalogEntry{
		{Provider: "provider-id", ProviderName: "Provider Name", ID: "model-id", Name: "Model Name"},
	}}

	for _, query := range []string{"PROVIDER-ID", "provider name", "MODEL-ID", "model name"} {
		t.Run(query, func(t *testing.T) {
			var output bytes.Buffer
			if err := writeModelCatalog(&output, catalog, query, false); err != nil {
				t.Fatalf("writeModelCatalog: %v", err)
			}
			if got, want := output.String(), "provider-id/model-id\n"; got != want {
				t.Fatalf("output = %q, want %q", got, want)
			}
		})
	}
}

func TestWriteModelCatalogMatchesAllSearchTermsAcrossLabels(t *testing.T) {
	catalog := workspace.ModelCatalog{Models: []workspace.ModelCatalogEntry{
		{Provider: "openai", ProviderName: "OpenAI", ID: "gpt-5", Name: "Codex"},
		{Provider: "openai", ProviderName: "OpenAI", ID: "gpt-4", Name: "Legacy"},
	}}
	var output bytes.Buffer

	if err := writeModelCatalog(&output, catalog, "gpt 5", false); err != nil {
		t.Fatalf("writeModelCatalog: %v", err)
	}
	if got, want := output.String(), "openai/gpt-5\n"; got != want {
		t.Fatalf("output = %q, want %q", got, want)
	}
}

func TestWriteModelCatalogTerminalGroupsReadableNamesAndIDs(t *testing.T) {
	catalog := workspace.ModelCatalog{Models: []workspace.ModelCatalogEntry{
		{Provider: "openai", ProviderName: "OpenAI", ID: "gpt-5", Name: "GPT-5"},
		{Provider: "openai", ProviderName: "OpenAI", ID: "gpt-5-mini", Name: "GPT-5 mini"},
	}}
	var output bytes.Buffer

	if err := writeModelCatalog(&output, catalog, "", true); err != nil {
		t.Fatalf("writeModelCatalog: %v", err)
	}
	for _, want := range []string{"OpenAI (openai)", "GPT-5 (gpt-5)", "GPT-5 mini (gpt-5-mini)"} {
		if !strings.Contains(output.String(), want) {
			t.Fatalf("terminal output missing %q:\n%s", want, output.String())
		}
	}
}

func TestWriteModelCatalogReportsNoMatches(t *testing.T) {
	var output bytes.Buffer
	err := writeModelCatalog(&output, workspace.ModelCatalog{Models: []workspace.ModelCatalogEntry{{Provider: "openai", ID: "gpt-5"}}}, "claude", false)
	if err == nil || err.Error() != `no models found matching "claude"` {
		t.Fatalf("error = %v", err)
	}
}
