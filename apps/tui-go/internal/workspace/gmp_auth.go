package workspace

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/auth"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ompclient"
)

// translateAuthRequest returns a Bubble Tea message for an inbound
// auth.* extension_ui_request, or nil if the method is not a known auth
// flow method (in which case drainExtensionUI falls back to its
// default-cancel response). The pure decode layer — payload structs,
// decoder table, and startup parity check — lives in the `auth` package
// alongside the method constants and message types it pairs with.
func (w *GmpWorkspace) translateAuthRequest(req *ompclient.ExtensionUIReq) tea.Msg {
	if !strings.HasPrefix(req.Method, "auth.") {
		return nil
	}
	msg, ok, err := auth.Decode(req.Method, req.ID, req.Raw)
	if !ok {
		slog.Debug("gmp workspace: unknown auth.* method, falling back to cancel", "method", req.Method, "id", req.ID)
		return nil
	}
	if err != nil {
		slog.Warn("gmp workspace: failed to parse auth payload", "method", req.Method, "id", req.ID, "error", err)
		return nil
	}
	return msg
}

// SendAuthCommand fires an auth.login or auth.logout Command at the
// gmp backend. Returns when the backend acknowledges the command (the
// actual login flow is driven asynchronously by extension_ui_request
// frames once the dialog is open).
func (w *GmpWorkspace) SendAuthCommand(method string, provider string) error {
	if w.client == nil {
		return errors.New("gmp client not initialised")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	resp, err := w.client.Call(ctx, buildAuthCommand(method, provider))
	if err != nil {
		return err
	}
	return interpretAuthResponse(resp)
}

// buildAuthCommand assembles the wire frame for an auth.login / auth.logout
// command. Pure for testability.
func buildAuthCommand(method, provider string) ompclient.Command {
	return ompclient.Command{Type: method, Provider: provider}
}

// interpretAuthResponse converts an `auth.*` Response back into a Go error
// (nil on success). Pure for testability.
func interpretAuthResponse(resp *ompclient.Response) error {
	if resp != nil && !resp.Success && resp.Error != "" {
		return errors.New(resp.Error)
	}
	return nil
}

// HandleAuthReply translates a Bubble Tea reply (auth.Submit /
// Confirm / Cancel) into the matching extension_ui_response on the
// wire. The model layer calls this when the user dismisses an auth
// dialog.
func (w *GmpWorkspace) HandleAuthReply(msg tea.Msg) {
	resp, ok := buildAuthReplyFrame(msg)
	if !ok {
		return
	}
	if err := w.client.Send(resp); err != nil {
		slog.Debug("gmp workspace: auth reply send failed", "id", resp.ID, "error", err)
	}
}

// buildAuthReplyFrame converts an inbound Bubble Tea auth reply message into
// the wire-level ExtensionUIResp. Returns ok=false for any unrelated message.
// Pure for testability.
func buildAuthReplyFrame(msg tea.Msg) (ompclient.ExtensionUIResp, bool) {
	switch m := msg.(type) {
	case auth.Submit:
		return ompclient.ExtensionUIResp{Type: "extension_ui_response", ID: m.ID, Value: m.Value}, true
	case auth.Confirm:
		confirmed := true
		return ompclient.ExtensionUIResp{Type: "extension_ui_response", ID: m.ID, Confirmed: &confirmed}, true
	case auth.Cancel:
		return ompclient.ExtensionUIResp{Type: "extension_ui_response", ID: m.ID, Cancelled: true}, true
	default:
		return ompclient.ExtensionUIResp{}, false
	}
}
