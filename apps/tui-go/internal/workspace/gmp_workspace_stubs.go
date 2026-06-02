package workspace

import (
	"context"
	"time"

	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/agent/tools/mcp"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/config"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/history"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/lsp"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/oauth"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/permission"
)

func (w *GmpWorkspace) DeleteSession(ctx context.Context, sessionID string) error {
	return ErrUnsupported
}

// -- Permissions --

func (w *GmpWorkspace) PermissionGrant(perm permission.PermissionRequest)           {}
func (w *GmpWorkspace) PermissionGrantPersistent(perm permission.PermissionRequest) {}
func (w *GmpWorkspace) PermissionDeny(perm permission.PermissionRequest)            {}
func (w *GmpWorkspace) PermissionSkipRequests() bool {
	w.mu.RLock()
	defer w.mu.RUnlock()
	return w.skipPermissions
}
func (w *GmpWorkspace) PermissionSetSkipRequests(skip bool) {
	w.mu.Lock()
	w.skipPermissions = skip
	w.mu.Unlock()
}

// -- FileTracker --

func (w *GmpWorkspace) FileTrackerRecordRead(ctx context.Context, sessionID, path string) {}
func (w *GmpWorkspace) FileTrackerLastReadTime(ctx context.Context, sessionID, path string) time.Time {
	return time.Time{}
}
func (w *GmpWorkspace) FileTrackerListReadFiles(ctx context.Context, sessionID string) ([]string, error) {
	return nil, nil
}

// -- History --

func (w *GmpWorkspace) ListSessionHistory(ctx context.Context, sessionID string) ([]history.File, error) {
	return nil, nil
}

// -- LSP --

func (w *GmpWorkspace) LSPStart(ctx context.Context, path string) {}
func (w *GmpWorkspace) LSPStopAll(ctx context.Context)            {}
func (w *GmpWorkspace) LSPGetStates() map[string]LSPClientInfo    { return nil }
func (w *GmpWorkspace) LSPGetDiagnosticCounts(name string) lsp.DiagnosticCounts {
	return lsp.DiagnosticCounts{}
}

func (w *GmpWorkspace) SetProviderAPIKey(scope config.Scope, providerID string, apiKey any) error {
	return nil
}
func (w *GmpWorkspace) RemoveConfigField(scope config.Scope, key string) error { return nil }
func (w *GmpWorkspace) ImportCopilot() (*oauth.Token, bool)                    { return nil, false }
func (w *GmpWorkspace) RefreshOAuthToken(ctx context.Context, scope config.Scope, providerID string) error {
	return nil
}

// -- Project lifecycle --

func (w *GmpWorkspace) ProjectNeedsInitialization() (bool, error) { return false, nil }
func (w *GmpWorkspace) MarkProjectInitialized() error             { return nil }
func (w *GmpWorkspace) InitializePrompt() (string, error)         { return "", nil }

// -- MCP operations --

func (w *GmpWorkspace) MCPGetStates() map[string]mcp.ClientInfo              { return nil }
func (w *GmpWorkspace) MCPRefreshPrompts(ctx context.Context, name string)   {}
func (w *GmpWorkspace) MCPRefreshResources(ctx context.Context, name string) {}
func (w *GmpWorkspace) RefreshMCPTools(ctx context.Context, name string)     {}
func (w *GmpWorkspace) ReadMCPResource(ctx context.Context, name, uri string) ([]MCPResourceContents, error) {
	return nil, ErrUnsupported
}
func (w *GmpWorkspace) GetMCPPrompt(clientID, promptID string, args map[string]string) (string, error) {
	return "", ErrUnsupported
}
func (w *GmpWorkspace) EnableDockerMCP(ctx context.Context) error { return ErrUnsupported }
func (w *GmpWorkspace) DisableDockerMCP() error                   { return nil }
