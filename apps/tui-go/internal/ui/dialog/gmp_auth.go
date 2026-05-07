// Package dialog: GmpAuthDialog routes auth.* extension_ui_request frames
// (originated by gmp's AuthStorage.login) to a single self-contained dialog
// without depending on charm.land/catwalk.
//
// Why a separate dialog (rather than reusing oauth.go / api_key_input.go):
//   - oauth.go owns its own device-flow polling loop. gmp's AuthStorage.login
//     already runs the OAuth flow on the backend; the dialog only needs to
//     surface URLs, prompts, progress, and the final result.
//   - oauth.go and api_key_input.go both terminate by writing to Crush's
//     local config (catwalk-driven SetProviderAPIKey). gmp credentials live
//     in gmp's SQLite (AuthStorage); a parallel Crush write would diverge.
//   - Both existing dialogs require catwalk.Provider / config.SelectedModel,
//     which the gmp wire frame does not carry.
//
// State model:
//
//	GmpAuthIdle       — newly opened, no payload yet
//	GmpAuthShowURL    — display verification URL + instructions; "Open" / Esc
//	GmpAuthPromptCode — text input for verification code or API key paste
//	GmpAuthPromptURL  — text input for full callback URL (manual redirect)
//	GmpAuthPicker     — list selector for /login with no provider
//	GmpAuthResult     — terminal success / error display
//
// Reply protocol (sent via dialog.ActionCmd carrying a tea.Cmd):
//
//	auth.Submit  — for prompt / picker (carries Value)
//	auth.Confirm — for show_login_url ack
//	auth.Cancel  — for Esc on any prompt
package dialog

import (
	"strings"

	"charm.land/bubbles/v2/help"
	"charm.land/bubbles/v2/key"
	"charm.land/bubbles/v2/textinput"
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	uv "github.com/charmbracelet/ultraviolet"
	"github.com/pkg/browser"

	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/auth"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ui/common"
)

// GmpAuthID is the identifier for the gmp auth dialog.
const GmpAuthID = "gmp_auth"

// GmpAuthState enumerates the dialog's render states.
type GmpAuthState int

const (
	GmpAuthIdle GmpAuthState = iota
	GmpAuthShowURL
	GmpAuthPromptCode
	GmpAuthPromptURL
	GmpAuthPicker
	GmpAuthResult
)

// GmpAuth implements [Dialog] for gmp-routed OAuth flows.
type GmpAuth struct {
	com *common.Common

	state GmpAuthState

	// Active request identity (mirrors the inbound extension_ui_request id).
	requestID string
	provider  string

	// State-specific payload.
	url          string
	instructions string
	progressLog  []string
	options      []string
	defaultID    string
	pickerCursor int

	// Result-state payload.
	resultSuccess bool
	resultError   string

	input textinput.Model
	help  help.Model

	keyMap struct {
		Submit  key.Binding
		OpenURL key.Binding
		Up      key.Binding
		Down    key.Binding
		Close   key.Binding
	}

	width int
}

var _ Dialog = (*GmpAuth)(nil)

// NewGmpAuth creates an empty dialog. The first auth.* message routed via
// HandleMsg populates state.
func NewGmpAuth(com *common.Common) *GmpAuth {
	d := &GmpAuth{com: com, width: 60, state: GmpAuthIdle}
	d.input = textinput.New()
	d.input.SetVirtualCursor(false)
	d.input.SetStyles(com.Styles.TextInput)
	d.help = help.New()
	d.help.Styles = com.Styles.DialogHelpStyles()
	d.keyMap.Submit = key.NewBinding(
		key.WithKeys("enter", "ctrl+y"),
		key.WithHelp("enter", "submit"),
	)
	d.keyMap.OpenURL = key.NewBinding(
		key.WithKeys("o", "O", "enter"),
		key.WithHelp("o/enter", "open browser"),
	)
	d.keyMap.Up = key.NewBinding(key.WithKeys("up", "k"), key.WithHelp("↑/k", "up"))
	d.keyMap.Down = key.NewBinding(key.WithKeys("down", "j"), key.WithHelp("↓/j", "down"))
	d.keyMap.Close = CloseKey
	return d
}

// ID implements [Dialog].
func (*GmpAuth) ID() string { return GmpAuthID }

// HandleMsg implements [Dialog]. Auth route messages reset/transition state;
// key presses act on the active state and may return Submit / Confirm /
// Cancel via ActionCmd.
func (d *GmpAuth) HandleMsg(msg tea.Msg) Action {
	switch m := msg.(type) {
	case auth.ShowLoginURL:
		d.requestID = m.ID
		d.provider = m.Provider
		d.url = m.URL
		d.instructions = m.Instructions
		d.state = GmpAuthShowURL
		d.input.SetValue("")
		d.input.Blur()
		return ActionCmd{Cmd: openURLCmd(m.URL)}

	case auth.ShowProgress:
		d.progressLog = append(d.progressLog, m.Message)
		// progress is informational; keep state as-is. The id is not tracked
		// (gmp side did not register a correlated wait).
		return nil

	case auth.PromptCode:
		d.requestID = m.ID
		d.provider = m.Provider
		d.state = GmpAuthPromptCode
		d.input.Reset()
		if m.Placeholder != "" {
			d.input.Placeholder = m.Placeholder
		} else {
			d.input.Placeholder = "Paste code or API key…"
		}
		d.input.Focus()
		return nil

	case auth.PromptManualRedirect:
		d.requestID = m.ID
		d.provider = m.Provider
		d.state = GmpAuthPromptURL
		d.input.Reset()
		d.input.Placeholder = "Paste the full callback URL…"
		d.instructions = m.Instructions
		d.input.Focus()
		return nil

	case auth.PickProvider:
		d.requestID = m.ID
		d.options = m.Options
		d.defaultID = m.DefaultID
		d.state = GmpAuthPicker
		d.pickerCursor = 0
		for i, opt := range m.Options {
			if opt == m.DefaultID {
				d.pickerCursor = i
				break
			}
		}
		return nil

	case auth.ShowResult:
		d.requestID = m.ID
		d.provider = m.Provider
		d.state = GmpAuthResult
		d.resultSuccess = m.Success
		d.resultError = m.Error
		d.input.Blur()
		return nil

	case tea.KeyPressMsg:
		return d.handleKey(m)
	}
	return nil
}

func (d *GmpAuth) handleKey(msg tea.KeyPressMsg) Action {
	if key.Matches(msg, d.keyMap.Close) {
		id := d.requestID
		// Result state has no pending wait; just close.
		if d.state == GmpAuthResult || d.state == GmpAuthIdle {
			return ActionClose{}
		}
		return ActionCmd{Cmd: tea.Sequence(replyCancelCmd(id), closeCmd())}
	}

	switch d.state {
	case GmpAuthShowURL:
		if key.Matches(msg, d.keyMap.OpenURL) {
			return ActionCmd{Cmd: tea.Batch(openURLCmd(d.url), replyConfirmCmd(d.requestID))}
		}
	case GmpAuthPromptCode, GmpAuthPromptURL:
		if key.Matches(msg, d.keyMap.Submit) {
			value := strings.TrimSpace(d.input.Value())
			id := d.requestID
			return ActionCmd{Cmd: tea.Sequence(replySubmitCmd(id, value), closeCmd())}
		}
		var cmd tea.Cmd
		d.input, cmd = d.input.Update(msg)
		if cmd != nil {
			return ActionCmd{Cmd: cmd}
		}
	case GmpAuthPicker:
		switch {
		case key.Matches(msg, d.keyMap.Up):
			if d.pickerCursor > 0 {
				d.pickerCursor--
			}
		case key.Matches(msg, d.keyMap.Down):
			if d.pickerCursor < len(d.options)-1 {
				d.pickerCursor++
			}
		case key.Matches(msg, d.keyMap.Submit):
			if len(d.options) == 0 {
				return ActionCmd{Cmd: tea.Sequence(replyCancelCmd(d.requestID), closeCmd())}
			}
			value := d.options[d.pickerCursor]
			return ActionCmd{Cmd: tea.Sequence(replySubmitCmd(d.requestID, value), closeCmd())}
		}
	case GmpAuthResult:
		if key.Matches(msg, d.keyMap.Submit) {
			return ActionClose{}
		}
	}
	return nil
}

// Draw implements [Dialog].
func (d *GmpAuth) Draw(scr uv.Screen, area uv.Rectangle) *tea.Cursor {
	t := d.com.Styles
	body := d.body()
	view := t.Dialog.View.Render(body)
	if d.state == GmpAuthPromptCode || d.state == GmpAuthPromptURL {
		cur := d.input.Cursor()
		DrawCenterCursor(scr, area, view, cur)
		return InputCursor(t, cur)
	}
	DrawCenter(scr, area, view)
	return nil
}

func (d *GmpAuth) body() string {
	t := d.com.Styles
	title := t.Dialog.Title.Render("Sign in: " + d.provider)
	switch d.state {
	case GmpAuthShowURL:
		lines := []string{title, ""}
		if d.instructions != "" {
			lines = append(lines, d.instructions, "")
		}
		lines = append(lines, "Open this URL in your browser:")
		lines = append(lines, d.url)
		if len(d.progressLog) > 0 {
			lines = append(lines, "", strings.Join(d.progressLog, "\n"))
		}
		lines = append(lines, "", d.help.View(d))
		return lipgloss.JoinVertical(lipgloss.Left, lines...)
	case GmpAuthPromptCode, GmpAuthPromptURL:
		hint := d.instructions
		if hint == "" {
			if d.state == GmpAuthPromptURL {
				hint = "Paste the full callback URL from your browser"
			} else {
				hint = "Paste the verification code or API key"
			}
		}
		lines := []string{title, "", hint, "", d.input.View()}
		if len(d.progressLog) > 0 {
			lines = append(lines, "", strings.Join(d.progressLog, "\n"))
		}
		lines = append(lines, "", d.help.View(d))
		return lipgloss.JoinVertical(lipgloss.Left, lines...)
	case GmpAuthPicker:
		lines := []string{t.Dialog.Title.Render("Pick a provider"), ""}
		for i, opt := range d.options {
			marker := "  "
			if i == d.pickerCursor {
				marker = "▸ "
			}
			lines = append(lines, marker+opt)
		}
		lines = append(lines, "", d.help.View(d))
		return lipgloss.JoinVertical(lipgloss.Left, lines...)
	case GmpAuthResult:
		head := title
		var body string
		if d.resultSuccess {
			body = "Authentication successful."
		} else {
			body = "Authentication failed: " + d.resultError
		}
		return lipgloss.JoinVertical(lipgloss.Left, head, "", body, "", d.help.View(d))
	default:
		return lipgloss.JoinVertical(lipgloss.Left, title, "", "Waiting for backend…")
	}
}

// ShortHelp implements [help.KeyMap].
func (d *GmpAuth) ShortHelp() []key.Binding {
	switch d.state {
	case GmpAuthShowURL:
		return []key.Binding{d.keyMap.OpenURL, d.keyMap.Close}
	case GmpAuthPromptCode, GmpAuthPromptURL:
		return []key.Binding{d.keyMap.Submit, d.keyMap.Close}
	case GmpAuthPicker:
		return []key.Binding{d.keyMap.Up, d.keyMap.Down, d.keyMap.Submit, d.keyMap.Close}
	case GmpAuthResult:
		return []key.Binding{d.keyMap.Submit, d.keyMap.Close}
	}
	return []key.Binding{d.keyMap.Close}
}

// FullHelp implements [help.KeyMap].
func (d *GmpAuth) FullHelp() [][]key.Binding {
	return [][]key.Binding{d.ShortHelp()}
}

// ----- reply command builders -----

func openURLCmd(url string) tea.Cmd {
	if url == "" {
		return nil
	}
	return func() tea.Msg {
		_ = browser.OpenURL(url)
		return nil
	}
}

func replySubmitCmd(id, value string) tea.Cmd {
	return func() tea.Msg { return auth.Submit{ID: id, Value: value} }
}

func replyConfirmCmd(id string) tea.Cmd {
	return func() tea.Msg { return auth.Confirm{ID: id} }
}

func replyCancelCmd(id string) tea.Cmd {
	return func() tea.Msg { return auth.Cancel{ID: id} }
}

func closeCmd() tea.Cmd {
	return func() tea.Msg { return ActionClose{} }
}
