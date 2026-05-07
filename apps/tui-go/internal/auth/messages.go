// Package auth carries Bubble Tea message types for OAuth/auth flows
// driven by the gmp backend over the RPC bridge.
//
// The gmp coding-agent (packages/coding-agent in the same repo) emits
// extension_ui_request frames whose method begins with "auth." when it
// runs an OAuth login orchestrated by AuthStorage.login(). The
// workspace bridge (internal/workspace/gmp_workspace.go drainExtensionUI)
// converts those frames into the message types defined here and posts
// them to the Bubble Tea program. Higher layers (internal/ui/model)
// route them to the existing oauth.go and api_key_input.go dialogs and
// send a Submit / Cancel message back, which the workspace then
// translates into an extension_ui_response frame on the wire.
package auth

// ShowLoginURL signals that an OAuth flow has surfaced a verification
// URL. The dialog should display the URL (and optional instructions),
// open it in the user's browser, and reply with Confirm. The reply ID
// must match the inbound request ID so the gmp side correlator unblocks.
type ShowLoginURL struct {
	ID           string
	Provider     string
	URL          string
	Instructions string
}

// ShowProgress is a fire-and-forget status update sent during an
// OAuth flow (e.g. "exchanging code", "registering device"). The UI
// should append it to the active dialog's progress log; no reply
// frame is required because the gmp side did not register a
// correlated request.
type ShowProgress struct {
	ID       string
	Provider string
	Message  string
}

// PromptCode requests a string from the user — typically an API key
// paste, a verification code, or a device-code string. The dialog
// should capture the input and reply with Submit{Value: ...}.
type PromptCode struct {
	ID          string
	Provider    string
	Placeholder string
	AllowEmpty  bool
}

// PromptManualRedirect requests the user paste the full callback URL
// from their browser (used when the device-code flow's local callback
// server cannot bind a port). Reply with Submit{Value: ...}.
type PromptManualRedirect struct {
	ID           string
	Provider     string
	Instructions string
}

// ShowResult is the terminal frame for an auth flow. Success=true
// indicates the credential has been saved by gmp's AuthStorage; the
// dialog should transition to its "success" state and self-dismiss.
// Success=false carries an error string for display.
type ShowResult struct {
	ID       string
	Provider string
	Success  bool
	Error    string
}

// PickProvider asks the user to choose one of Options. Used when
// /login is invoked without an explicit provider argument. Reply
// with Submit{Value: <picked id>}.
type PickProvider struct {
	ID        string
	Options   []string
	DefaultID string
}

// Submit is the reply for prompt-style auth requests (PromptCode,
// PromptManualRedirect, PickProvider). The workspace converts it
// into an extension_ui_response with `value`.
type Submit struct {
	ID    string
	Value string
}

// Confirm is the reply for ack-only requests (ShowLoginURL after the
// browser opens). The workspace converts it into an
// extension_ui_response with `confirmed: true`.
type Confirm struct {
	ID string
}

// Cancel is the reply when the user dismisses an auth dialog. The
// workspace converts it into an extension_ui_response with
// `cancelled: true`. Sent for any of the inbound request types.
type Cancel struct {
	ID string
}
