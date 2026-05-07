package auth

// Method names for auth.* extension_ui_request frames.
//
// These mirror the AuthMethod constants in
// packages/coding-agent/src/modes/rpc/rpc-types.ts. Keep both sides in
// sync — a typo in either silently falls through to the workspace's
// default cancel path and dismisses the dialog with no diagnostic.
const (
	MethodShowLoginURL         = "auth.show_login_url"
	MethodShowProgress         = "auth.show_progress"
	MethodPromptCode           = "auth.prompt_code"
	MethodPromptManualRedirect = "auth.prompt_manual_redirect"
	MethodShowResult           = "auth.show_result"
	MethodPickProvider         = "auth.pick_provider"
)

// CommandLogin / CommandLogout / CommandSetAPIKey are the RpcCommand `type`
// values for the outbound /login, /logout, and api-key-write commands.
// Mirror of AuthCommand in rpc-types.ts.
const (
	CommandLogin     = "auth.login"
	CommandLogout    = "auth.logout"
	CommandSetAPIKey = "auth.set_api_key"
)
