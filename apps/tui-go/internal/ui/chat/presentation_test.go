package chat

import (
	"fmt"
	"strings"
	"testing"

	"github.com/charmbracelet/x/ansi"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/message"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ui/styles"
	"github.com/stretchr/testify/require"
)

type fallbackToolRenderer struct {
	output string
}

func (r fallbackToolRenderer) RenderTool(*styles.Styles, int, *ToolRenderOpts) string {
	return r.output
}

func TestPresentationRendererSanitizesStatusAndBoundsWidth(t *testing.T) {
	t.Parallel()
	sty := styles.CharmtonePantera()
	renderer := newPresentationToolRenderer(fallbackToolRenderer{output: "LEGACY"})
	opts := &ToolRenderOpts{
		ToolCall: message.ToolCall{Presentation: &message.ToolPresentation{
			Type: message.ToolPresentationTypeStatus,
			Status: &message.ToolPresentationStatus{
				Title:       "Run\t\x1b[31mred\x1b[0m",
				Description: "line\tvalue\a",
			},
		}},
		Status:     ToolStatusRunning,
		IsSpinning: true,
	}

	got := renderer.RenderTool(&sty, 24, opts)
	plain := ansi.Strip(got)
	require.NotContains(t, got, "LEGACY", "usable status presentation delegated to legacy renderer")
	require.False(t, strings.ContainsAny(plain, "\t\a\x1b"), "render retained unsafe terminal text: %q", plain)
	require.Contains(t, plain, "Run    red")
	require.Contains(t, plain, "line    va")
	for _, line := range strings.Split(plain, "\n") {
		require.LessOrEqual(t, ansi.StringWidth(line), 24, "line exceeds width: %q", line)
	}
}

func TestPresentationRendererPreservesBlockSectionOrder(t *testing.T) {
	t.Parallel()
	sty := styles.CharmtonePantera()
	renderer := newPresentationToolRenderer(fallbackToolRenderer{output: "LEGACY"})
	opts := &ToolRenderOpts{
		ToolCall: message.ToolCall{Presentation: &message.ToolPresentation{
			Type: message.ToolPresentationTypeBlock,
			Sections: []message.ToolPresentationSection{
				{Label: "First", Lines: []string{"alpha"}},
				{Label: "Second", Lines: []string{"beta"}},
			},
		}},
		Status: ToolStatusSuccess,
	}

	plain := ansi.Strip(renderer.RenderTool(&sty, 50, opts))
	first := strings.Index(plain, "First")
	second := strings.Index(plain, "Second")
	require.GreaterOrEqual(t, first, 0, "first section missing: %q", plain)
	require.GreaterOrEqual(t, second, 0, "second section missing: %q", plain)
	require.Less(t, first, second, "block sections out of order: %q", plain)
}

func TestPresentationRendererWrapsTextAtNarrowWidths(t *testing.T) {
	t.Parallel()
	sty := styles.CharmtonePantera()
	renderer := newPresentationToolRenderer(fallbackToolRenderer{output: "LEGACY"})
	opts := &ToolRenderOpts{
		ToolCall: message.ToolCall{Presentation: &message.ToolPresentation{
			Type: message.ToolPresentationTypeBlock,
			Sections: []message.ToolPresentationSection{
				{Lines: []string{"alpha beta gamma delta"}},
			},
		}},
		Status: ToolStatusSuccess,
	}

	plain := ansi.Strip(renderer.RenderTool(&sty, 12, opts))
	require.Contains(t, plain, "alpha")
	require.Contains(t, plain, "delta")
	for _, line := range strings.Split(plain, "\n") {
		require.LessOrEqual(t, ansi.StringWidth(line), 12, "line exceeded width: %q", line)
	}
}

func TestPresentationRendererCodeExpansionUsesLocalState(t *testing.T) {
	t.Parallel()
	sty := styles.CharmtonePantera()
	renderer := newPresentationToolRenderer(fallbackToolRenderer{output: "LEGACY"})
	lines := make([]string, 12)
	for i := range lines {
		lines[i] = fmt.Sprintf("line-%02d", i+1)
	}
	opts := &ToolRenderOpts{
		ToolCall: message.ToolCall{Presentation: &message.ToolPresentation{
			Type: message.ToolPresentationTypeCode,
			Code: &message.ToolPresentationCode{
				Code:     strings.Join(lines, "\n"),
				Title:    "Read value.go",
				Expanded: true,
			},
		}},
		Status: ToolStatusSuccess,
	}

	collapsed := ansi.Strip(renderer.RenderTool(&sty, 32, opts))
	require.NotContains(t, collapsed, "line-12", "wire expanded hint overrode collapsed local state")
	require.Contains(t, collapsed, "2 lines", "collapsed code omitted preview count")
	for _, line := range strings.Split(collapsed, "\n") {
		require.LessOrEqual(t, ansi.StringWidth(line), 32, "collapsed code line exceeds width: %q", line)
	}

	opts.ExpandedContent = true
	expanded := ansi.Strip(renderer.RenderTool(&sty, 80, opts))
	require.Contains(t, expanded, "line-12", "expanded code omitted final line")
}

func TestPresentationRendererCodeHandlesMinimumWidth(t *testing.T) {
	t.Parallel()
	sty := styles.CharmtonePantera()
	renderer := newPresentationToolRenderer(fallbackToolRenderer{output: "LEGACY"})
	opts := &ToolRenderOpts{
		ToolCall: message.ToolCall{Presentation: &message.ToolPresentation{
			Type: message.ToolPresentationTypeCode,
			Code: &message.ToolPresentationCode{Code: "const value = 1;", Language: "typescript"},
		}},
		Status: ToolStatusSuccess,
	}

	for _, width := range []int{1, 2, 3, 6} {
		var got string
		require.NotPanics(t, func() { got = renderer.RenderTool(&sty, width, opts) })
		for _, line := range strings.Split(ansi.Strip(got), "\n") {
			require.LessOrEqual(t, ansi.StringWidth(line), width, "line exceeded width: %q", line)
		}
	}
}

func TestPresentationRendererUsesLifecycleErrorOverPresentationHint(t *testing.T) {
	t.Parallel()
	sty := styles.CharmtonePantera()
	renderer := newPresentationToolRenderer(fallbackToolRenderer{output: "LEGACY"})
	opts := &ToolRenderOpts{
		ToolCall: message.ToolCall{Presentation: &message.ToolPresentation{
			Type: message.ToolPresentationTypeStatus,
			Status: &message.ToolPresentationStatus{
				Icon:  "pending",
				Title: "Failed tool",
			},
		}},
		Result: &message.ToolResult{IsError: true, Presentation: &message.ToolPresentation{
			Type: message.ToolPresentationTypeStatus,
			Status: &message.ToolPresentationStatus{
				Icon:  "running",
				Title: "Failed tool",
			},
		}},
		Status:     ToolStatusError,
		IsSpinning: false,
	}

	plain := ansi.Strip(renderer.RenderTool(&sty, 40, opts))
	require.True(t, strings.HasPrefix(plain, styles.ToolError+" "), "presentation hint overrode lifecycle error: %q", plain)
}

func TestPresentationRendererUsesSemanticWarningAfterSuccessfulLifecycle(t *testing.T) {
	t.Parallel()
	sty := styles.CharmtonePantera()
	renderer := newPresentationToolRenderer(fallbackToolRenderer{output: "LEGACY"})

	for name, presentation := range map[string]*message.ToolPresentation{
		"status icon": {
			Type: message.ToolPresentationTypeStatus,
			Status: &message.ToolPresentationStatus{
				Icon:  message.ToolPresentationIconWarning,
				Title: "Read",
			},
		},
		"block state": {
			Type:     message.ToolPresentationTypeBlock,
			State:    message.ToolPresentationStateWarning,
			Sections: []message.ToolPresentationSection{},
		},
		"code status": {
			Type: message.ToolPresentationTypeCode,
			Code: &message.ToolPresentationCode{
				Code:   "const value = 1;",
				Status: message.ToolPresentationCodeStatusWarning,
			},
		},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			got := ansi.Strip(renderer.RenderTool(&sty, 40, &ToolRenderOpts{
				ToolCall: message.ToolCall{Name: "read", Presentation: presentation},
				Status:   ToolStatusSuccess,
			}))
			require.True(t, strings.HasPrefix(got, styles.ToolWarning+" "), "semantic warning missing: %q", got)
		})
	}
}

func TestPresentationRendererUsesOnlyCurrentPhase(t *testing.T) {
	t.Parallel()
	sty := styles.CharmtonePantera()
	renderer := newPresentationToolRenderer(fallbackToolRenderer{output: "LEGACY"})
	call := message.ToolCall{Presentation: &message.ToolPresentation{
		Type:   message.ToolPresentationTypeStatus,
		Status: &message.ToolPresentationStatus{Title: "Call presentation"},
	}}

	for name, result := range map[string]*message.ToolResult{
		"absent":          {},
		"unknown":         {Presentation: &message.ToolPresentation{Type: "future"}},
		"malformed known": {Presentation: &message.ToolPresentation{Type: message.ToolPresentationTypeCode}},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			got := renderer.RenderTool(&sty, 50, &ToolRenderOpts{ToolCall: call, Result: result})
			require.Equal(t, "LEGACY", got, "current unusable result rendered stale call presentation: %q", ansi.Strip(got))
		})
	}
}

func TestPresentationArrivingAfterItemConstructionReplacesCallSnapshot(t *testing.T) {
	t.Parallel()
	sty := styles.CharmtonePantera()
	item := NewGenericToolMessageItem(&sty, message.ToolCall{
		ID:       "call-1",
		Name:     "future_tool",
		Finished: true,
		Presentation: &message.ToolPresentation{
			Type:   message.ToolPresentationTypeStatus,
			Status: &message.ToolPresentationStatus{Title: "Call snapshot"},
		},
	}, nil, false)

	require.Contains(t, ansi.Strip(item.Render(80)), "Call snapshot", "initial item ignored call presentation")
	item.SetResult(&message.ToolResult{Presentation: &message.ToolPresentation{
		Type:   message.ToolPresentationTypeStatus,
		Status: &message.ToolPresentationStatus{Title: "Result snapshot"},
	}})
	got := ansi.Strip(item.Render(80))
	require.Contains(t, got, "Result snapshot")
	require.NotContains(t, got, "Call snapshot", "result snapshot did not replace cached call snapshot")
	require.Nil(t, item.(Animatable).StartAnimation(), "completed tool presentation kept spinner alive")
}
