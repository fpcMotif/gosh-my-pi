// Package ompclient implements a Go client for the omp coding-agent
// RPC mode (JSONL over stdin/stdout). The protocol mirrors
// packages/coding-agent/src/modes/rpc/rpc-types.ts.
//
// This is the lowest layer of the omp <-> Crush TUI bridge. It is
// transport-only: it spawns `omp --mode rpc` (or an override binary),
// sends commands as JSON lines, and yields responses, agent events,
// extension UI requests, and host tool requests as typed Go values.
//
// Higher layers (internal/workspace) translate this into the
// crush.workspace.Workspace interface that the TUI consumes.
package ompclient

import "encoding/json"

// Command is the discriminated union of messages the host (TUI) can
// send to the omp RPC server. Mirrors RpcCommand in rpc-types.ts.
//
// Only the fields that the current MVP actually uses are typed
// individually; everything else round-trips through Extra so callers
// can pass arbitrary additional command shapes without modifying this
// package.
type Command struct {
	ID   string `json:"id,omitempty"`
	Type string `json:"type"`

	// Common command payload fields (kept as a union for ease of use).
	Message string         `json:"message,omitempty"`
	Images  []ImageContent `json:"images,omitempty"`

	// Streaming behavior for prompt: "steer" | "followUp".
	StreamingBehavior string `json:"streamingBehavior,omitempty"`

	// new_session
	ParentSession string `json:"parentSession,omitempty"`

	// set_model
	Provider string `json:"provider,omitempty"`
	ModelID  string `json:"modelId,omitempty"`

	// set_thinking_level
	Level string `json:"level,omitempty"`

	// queue modes / interrupt mode
	Mode string `json:"mode,omitempty"`

	// compact
	CustomInstructions string `json:"customInstructions,omitempty"`

	// set_auto_compaction / set_auto_retry
	Enabled *bool `json:"enabled,omitempty"`

	// bash
	Command string `json:"command,omitempty"`

	// switch_session
	SessionPath string `json:"sessionPath,omitempty"`

	// branch
	EntryID string `json:"entryId,omitempty"`

	// set_session_name
	Name string `json:"name,omitempty"`

	// set_todos
	Phases []TodoPhase `json:"phases,omitempty"`

	// set_host_tools
	Tools []HostToolDefinition `json:"tools,omitempty"`

	// Catch-all for forwards-compat: any extra fields you want on the
	// outgoing command. Marshalled inline at the top level by Marshal.
	Extra map[string]any `json:"-"`
}

// MarshalJSON merges Extra into the top-level object.
func (c Command) MarshalJSON() ([]byte, error) {
	type alias Command
	base, err := json.Marshal(alias(c))
	if err != nil {
		return nil, err
	}
	if len(c.Extra) == 0 {
		return base, nil
	}
	// Merge: decode -> overlay extras -> re-encode. Cheap and explicit.
	var m map[string]any
	if err := json.Unmarshal(base, &m); err != nil {
		return nil, err
	}
	for k, v := range c.Extra {
		if _, exists := m[k]; !exists {
			m[k] = v
		}
	}
	return json.Marshal(m)
}

// ImageContent is the omp/pi-ai image payload.
type ImageContent struct {
	Type     string `json:"type"`
	Source   string `json:"source,omitempty"`
	Data     string `json:"data,omitempty"`
	MimeType string `json:"mimeType,omitempty"`
}

// TodoPhase is opaque (matches packages/coding-agent/src/tools/todo-write.ts).
// We pass it through as raw JSON.
type TodoPhase = json.RawMessage

// HostToolDefinition mirrors RpcHostToolDefinition.
type HostToolDefinition struct {
	Name        string         `json:"name"`
	Label       string         `json:"label,omitempty"`
	Description string         `json:"description"`
	Parameters  map[string]any `json:"parameters"`
	Hidden      bool           `json:"hidden,omitempty"`
}

// Response is a typed response to a command. Mirrors RpcResponse.
type Response struct {
	ID      string          `json:"id,omitempty"`
	Command string          `json:"command"`
	Success bool            `json:"success"`
	Error   string          `json:"error,omitempty"`
	Data    json.RawMessage `json:"data,omitempty"`
}

// AgentEvent is the streaming event channel from the agent runtime.
// The discriminated set lives in @oh-my-pi/pi-agent-core; the most
// important subtypes for the MVP are:
//
//	message_update          - streamed assistant / thinking text
//	tool_execution_start    - tool card created
//	tool_execution_update   - tool card progress
//	tool_execution_end      - tool card finalised
//
// We keep the payload as RawMessage; consumers parse based on Kind.
type AgentEvent struct {
	Kind    string          `json:"type"`
	Payload json.RawMessage `json:"-"`
}

// ExtensionUIReq mirrors RpcExtensionUIRequest. Always carries id
// + method; remaining fields depend on method.
type ExtensionUIReq struct {
	ID      string          `json:"id"`
	Method  string          `json:"method"`
	Title   string          `json:"title,omitempty"`
	Message string          `json:"message,omitempty"`
	Options []string        `json:"options,omitempty"`
	Timeout *int            `json:"timeout,omitempty"`
	Raw     json.RawMessage `json:"-"`
}

// HostToolCallReq mirrors RpcHostToolCallRequest.
type HostToolCallReq struct {
	ID         string         `json:"id"`
	ToolCallID string         `json:"toolCallId"`
	ToolName   string         `json:"toolName"`
	Arguments  map[string]any `json:"arguments"`
}

// HostToolCancelReq mirrors RpcHostToolCancelRequest.
type HostToolCancelReq struct {
	ID       string `json:"id"`
	TargetID string `json:"targetId"`
}

// HostToolResult mirrors RpcHostToolResult.
type HostToolResult struct {
	Type    string `json:"type"` // "host_tool_result"
	ID      string `json:"id"`
	Result  any    `json:"result"`
	IsError bool   `json:"isError,omitempty"`
}

// HostToolUpdate mirrors RpcHostToolUpdate.
type HostToolUpdate struct {
	Type          string `json:"type"` // "host_tool_update"
	ID            string `json:"id"`
	PartialResult any    `json:"partialResult"`
}

// ExtensionUIResp mirrors RpcExtensionUIResponse. Exactly one of
// Value / Confirmed / Cancelled should be set.
type ExtensionUIResp struct {
	Type      string `json:"type"` // "extension_ui_response"
	ID        string `json:"id"`
	Value     string `json:"value,omitempty"`
	Confirmed *bool  `json:"confirmed,omitempty"`
	Cancelled bool   `json:"cancelled,omitempty"`
	TimedOut  bool   `json:"timedOut,omitempty"`
}
