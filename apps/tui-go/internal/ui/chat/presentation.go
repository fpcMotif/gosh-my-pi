package chat

import (
	"fmt"
	"strings"
	"unicode"

	"github.com/charmbracelet/x/ansi"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/message"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ui/styles"
)

type presentationToolRenderer struct {
	fallback ToolRenderer
}

func newPresentationToolRenderer(fallback ToolRenderer) ToolRenderer {
	return &presentationToolRenderer{fallback: fallback}
}

func (r *presentationToolRenderer) RenderTool(
	sty *styles.Styles,
	width int,
	opts *ToolRenderOpts,
) string {
	presentation := opts.ToolCall.Presentation
	if opts.Result != nil {
		presentation = opts.Result.Presentation
	}
	if !presentation.Usable() {
		return r.fallback.RenderTool(sty, width, opts)
	}

	width = max(width, 1)
	switch presentation.Type {
	case message.ToolPresentationTypeStatus:
		return renderPresentationStatus(sty, width, opts, presentation.Status)
	case message.ToolPresentationTypeBlock:
		return renderPresentationBlock(sty, width, opts, presentation)
	case message.ToolPresentationTypeCode:
		return renderPresentationCode(sty, width, opts, presentation.Code)
	default:
		return r.fallback.RenderTool(sty, width, opts)
	}
}

func renderPresentationStatus(
	sty *styles.Styles,
	width int,
	opts *ToolRenderOpts,
	status *message.ToolPresentationStatus,
) string {
	header := renderPresentationHeader(sty, width, opts, status.Title, status.Description, status.Icon)
	if opts.Compact || len(status.Meta) == 0 {
		return header
	}
	meta := make([]string, 0, len(status.Meta))
	for _, value := range status.Meta {
		if value = sanitizePresentationLine(value); value != "" {
			meta = append(meta, value)
		}
	}
	if len(meta) == 0 {
		return header
	}
	body := renderPresentationText(sty, strings.Join(meta, " · "), width-toolBodyLeftPaddingTotal, false, responseContextHeight)
	return joinToolParts(header, sty.Tool.Body.Render(body))
}

func renderPresentationBlock(
	sty *styles.Styles,
	width int,
	opts *ToolRenderOpts,
	presentation *message.ToolPresentation,
) string {
	title := humanizedToolName(opts.ToolCall.Name)
	description := ""
	if presentation.Status != nil {
		title = presentation.Status.Title
		description = presentation.Status.Description
	}
	header := renderPresentationHeader(sty, width, opts, title, description, blockPresentationIcon(presentation))
	if opts.Compact {
		return header
	}

	lines := make([]string, 0, len(presentation.Sections)*2)
	for _, section := range presentation.Sections {
		if label := sanitizePresentationLine(section.Label); label != "" {
			lines = append(lines, label)
		}
		for _, line := range section.Lines {
			lines = append(lines, sanitizePresentationLine(line))
		}
	}
	body := renderPresentationLines(sty, lines, width-toolBodyLeftPaddingTotal, opts.ExpandedContent, responseContextHeight)
	if body == "" {
		return header
	}
	return joinToolParts(header, sty.Tool.Body.Render(body))
}

func renderPresentationCode(
	sty *styles.Styles,
	width int,
	opts *ToolRenderOpts,
	code *message.ToolPresentationCode,
) string {
	title := code.Title
	if title == "" {
		title = humanizedToolName(opts.ToolCall.Name)
	}
	header := renderPresentationHeader(sty, width, opts, title, "", codePresentationIcon(code.Status))
	if opts.Compact {
		return header
	}

	codeWidth := max(width-toolBodyLeftPaddingTotal, 1)
	content := sanitizePresentationText(code.Code)
	if width < 6 {
		body := sty.Tool.Body.Render(renderPresentationText(
			sty,
			content,
			codeWidth,
			opts.ExpandedContent,
			presentationPreviewLimit(code.CodeMaxLines),
		))
		body = appendPresentationOutput(sty, body, code.Output, codeWidth, opts, code.OutputMaxLines)
		return joinToolParts(header, truncatePresentationWidth(body, width))
	}
	lines := strings.Split(content, "\n")
	limit := presentationPreviewLimit(code.CodeMaxLines)
	displayLines, hidden := presentationVisibleLines(lines, opts.ExpandedContent, limit)
	path := sanitizePresentationLine(code.Title)
	if path == "" {
		path = "presentation." + sanitizePresentationLine(code.Language)
	}
	body := toolOutputCodeContentLanguage(
		sty,
		path,
		sanitizePresentationLine(code.Language),
		strings.Join(displayLines, "\n"),
		0,
		width,
		true,
	)
	if hidden > 0 {
		body = strings.Join([]string{
			body,
			sty.Tool.ContentCodeTruncation.Width(codeWidth).Render(fmt.Sprintf(assistantMessageTruncateFormat, hidden)),
		}, "\n")
	}

	body = appendPresentationOutput(sty, body, code.Output, codeWidth, opts, code.OutputMaxLines)
	return joinToolParts(header, truncatePresentationWidth(body, width))
}

func appendPresentationOutput(
	sty *styles.Styles,
	body string,
	output string,
	width int,
	opts *ToolRenderOpts,
	maxLines *int,
) string {
	if output == "" {
		return body
	}
	rendered := renderPresentationText(
		sty,
		output,
		width,
		opts.ExpandedContent,
		presentationPreviewLimit(maxLines),
	)
	if rendered == "" {
		return body
	}
	return strings.Join([]string{body, sty.Tool.Body.Render(rendered)}, "\n")
}

func renderPresentationHeader(
	sty *styles.Styles,
	width int,
	opts *ToolRenderOpts,
	title string,
	description string,
	icon message.ToolPresentationIcon,
) string {
	title = sanitizePresentationLine(title)
	description = sanitizePresentationLine(description)
	header := toolHeaderWithIcon(sty, presentationToolIcon(sty, opts.Status, icon), title, width, opts.Compact, description)
	if opts.IsSpinning && opts.Anim != nil {
		header += " " + opts.Anim.Render()
	}
	return ansi.Truncate(header, width, "…")
}

func presentationToolIcon(sty *styles.Styles, lifecycle ToolStatus, hint message.ToolPresentationIcon) string {
	if lifecycle != ToolStatusSuccess {
		return toolIcon(sty, lifecycle)
	}
	switch hint {
	case message.ToolPresentationIconWarning:
		return sty.Tool.IconWarning.String()
	case message.ToolPresentationIconInfo:
		return sty.Tool.IconInfo.String()
	default:
		return toolIcon(sty, lifecycle)
	}
}

func blockPresentationIcon(presentation *message.ToolPresentation) message.ToolPresentationIcon {
	if presentation.Status != nil && presentation.Status.Icon != "" {
		return presentation.Status.Icon
	}
	switch presentation.State {
	case message.ToolPresentationStatePending:
		return message.ToolPresentationIconPending
	case message.ToolPresentationStateRunning:
		return message.ToolPresentationIconRunning
	case message.ToolPresentationStateSuccess:
		return message.ToolPresentationIconSuccess
	case message.ToolPresentationStateError:
		return message.ToolPresentationIconError
	case message.ToolPresentationStateWarning:
		return message.ToolPresentationIconWarning
	default:
		return ""
	}
}

func codePresentationIcon(status message.ToolPresentationCodeStatus) message.ToolPresentationIcon {
	switch status {
	case message.ToolPresentationCodeStatusPending:
		return message.ToolPresentationIconPending
	case message.ToolPresentationCodeStatusRunning:
		return message.ToolPresentationIconRunning
	case message.ToolPresentationCodeStatusWarning:
		return message.ToolPresentationIconWarning
	case message.ToolPresentationCodeStatusComplete:
		return message.ToolPresentationIconSuccess
	case message.ToolPresentationCodeStatusError:
		return message.ToolPresentationIconError
	default:
		return ""
	}
}

func renderPresentationText(
	sty *styles.Styles,
	content string,
	width int,
	expanded bool,
	limit int,
) string {
	return renderPresentationLines(sty, strings.Split(sanitizePresentationText(content), "\n"), width, expanded, limit)
}

func renderPresentationLines(
	sty *styles.Styles,
	lines []string,
	width int,
	expanded bool,
	limit int,
) string {
	width = max(width, 1)
	contentWidth := max(width-1, 1)
	wrappedLines := make([]string, 0, len(lines))
	for _, line := range lines {
		wrappedLines = append(
			wrappedLines,
			strings.Split(ansi.Wrap(sanitizePresentationLine(line), contentWidth, " "), "\n")...,
		)
	}
	displayLines, hidden := presentationVisibleLines(wrappedLines, expanded, limit)
	out := make([]string, 0, len(displayLines)+1)
	for _, line := range displayLines {
		out = append(out, sty.Tool.ContentLine.Width(width).Render(" "+line))
	}
	if hidden > 0 {
		out = append(out, sty.Tool.ContentTruncation.Width(width).Render(fmt.Sprintf(assistantMessageTruncateFormat, hidden)))
	}
	return strings.Join(out, "\n")
}

func presentationVisibleLines(lines []string, expanded bool, limit int) ([]string, int) {
	if expanded || len(lines) <= limit {
		return lines, 0
	}
	return lines[:limit], len(lines) - limit
}

func presentationPreviewLimit(hint *int) int {
	if hint == nil || *hint <= 0 {
		return responseContextHeight
	}
	return min(*hint, responseContextHeight)
}

func sanitizePresentationLine(text string) string {
	return strings.ReplaceAll(sanitizePresentationText(text), "\n", " ")
}

func sanitizePresentationText(text string) string {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")
	text = strings.ReplaceAll(text, "\t", "    ")
	text = ansi.Strip(text)
	return strings.Map(func(r rune) rune {
		if r == '\n' {
			return r
		}
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, text)
}

func truncatePresentationWidth(text string, width int) string {
	lines := strings.Split(text, "\n")
	for i, line := range lines {
		lines[i] = ansi.Truncate(line, max(width, 1), "…")
	}
	return strings.Join(lines, "\n")
}

var _ ToolRenderer = (*presentationToolRenderer)(nil)
