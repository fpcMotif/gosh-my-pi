package cmd

import (
	"context"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"
	"time"

	"charm.land/lipgloss/v2/tree"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ompclient"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/workspace"
	"github.com/mattn/go-isatty"
	"github.com/spf13/cobra"
)

var modelsCmd = &cobra.Command{
	Use:   "models [search terms...]",
	Short: "List models from the gmp backend",
	Long:  "List models from the gmp backend. Includes unavailable models so you can see supported login options.",
	Example: `# List all backend models
gmp-tui-go models

# Search models
gmp-tui-go models gpt 5`,
	Args: cobra.ArbitraryArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		return runModels(cmd, args, cmd.OutOrStdout(), isatty.IsTerminal(os.Stdout.Fd()))
	},
}

func runModels(cmd *cobra.Command, args []string, out io.Writer, isTerminal bool) error {
	cwd, err := ResolveCwd(cmd)
	if err != nil {
		return err
	}
	debug, _ := cmd.Flags().GetBool("debug")
	ompStderr, err := setupOmpLogging(debug)
	if err != nil {
		fmt.Fprintf(os.Stderr, "gmp-tui-go: warning: log setup failed: %v\n", err)
	}

	backend := resolveOmpBackend(cmd)
	client, err := ompclient.Spawn(cmd.Context(), ompclient.Options{
		Bin:        backend[0],
		PrefixArgs: backend[1:],
		Cwd:        cwd,
		Env:        os.Environ(),
		Stderr:     ompStderr,
	})
	if err != nil {
		return fmt.Errorf("spawn gmp backend: %w", err)
	}
	defer func() { _ = client.Close() }()

	callCtx, cancel := context.WithTimeout(cmd.Context(), 10*time.Second)
	defer cancel()
	catalog, err := workspace.FetchModelCatalog(callCtx, client)
	if err != nil {
		return fmt.Errorf("fetch model catalog: %w", err)
	}
	return writeModelCatalog(out, catalog, strings.Join(args, " "), isTerminal)
}

func writeModelCatalog(out io.Writer, catalog workspace.ModelCatalog, query string, isTerminal bool) error {
	models := filterCatalogModels(catalog.Models, query)
	if len(models) == 0 {
		if query == "" {
			return fmt.Errorf("gmp backend returned no models")
		}
		return fmt.Errorf("no models found matching %q", query)
	}

	if !isTerminal {
		for _, model := range models {
			if _, err := fmt.Fprintf(out, "%s/%s\n", model.Provider, model.ID); err != nil {
				return err
			}
		}
		return nil
	}

	for _, group := range groupCatalogModels(models) {
		provider := tree.Root(modelProviderLabel(group[0]))
		for _, model := range group {
			provider.Child(modelLabel(model))
		}
		if _, err := fmt.Fprintln(out, provider); err != nil {
			return err
		}
	}
	return nil
}

func filterCatalogModels(models []workspace.ModelCatalogEntry, query string) []workspace.ModelCatalogEntry {
	terms := strings.Fields(strings.ToLower(query))
	filtered := make([]workspace.ModelCatalogEntry, 0, len(models))
	for _, model := range models {
		if !catalogModelMatches(model, terms) {
			continue
		}
		filtered = append(filtered, model)
	}
	sort.Slice(filtered, func(i, j int) bool {
		if filtered[i].Provider != filtered[j].Provider {
			return filtered[i].Provider < filtered[j].Provider
		}
		return filtered[i].ID < filtered[j].ID
	})
	return filtered
}

func catalogModelMatches(model workspace.ModelCatalogEntry, terms []string) bool {
	haystack := strings.ToLower(strings.Join([]string{model.Provider, model.ProviderName, model.ID, model.Name}, " "))
	for _, term := range terms {
		if !strings.Contains(haystack, term) {
			return false
		}
	}
	return true
}

func groupCatalogModels(models []workspace.ModelCatalogEntry) [][]workspace.ModelCatalogEntry {
	var groups [][]workspace.ModelCatalogEntry
	for _, model := range models {
		if len(groups) == 0 || groups[len(groups)-1][0].Provider != model.Provider {
			groups = append(groups, []workspace.ModelCatalogEntry{model})
			continue
		}
		groups[len(groups)-1] = append(groups[len(groups)-1], model)
	}
	return groups
}

func modelProviderLabel(model workspace.ModelCatalogEntry) string {
	if model.ProviderName == "" || model.ProviderName == model.Provider {
		return model.Provider
	}
	return fmt.Sprintf("%s (%s)", model.ProviderName, model.Provider)
}

func modelLabel(model workspace.ModelCatalogEntry) string {
	if model.Name == "" || model.Name == model.ID {
		return model.ID
	}
	return fmt.Sprintf("%s (%s)", model.Name, model.ID)
}

func init() {
	rootCmd.AddCommand(modelsCmd)
}
