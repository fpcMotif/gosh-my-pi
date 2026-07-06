package ompclient

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"sync"
	"sync/atomic"
	"time"
)

// Channel buffer sizes for fan-out from the read loop. The shutdown drain
// goroutines (see commit 7635a1d "unblock omp bridge stderr discard and
// side-channel deadlock") rely on these being non-zero so dispatch isn't
// blocked when consumers haven't subscribed yet.
const (
	eventsBufferSize         = 256
	sideChannelBufferSize    = 16
	subprocessShutdownGrace  = 2 * time.Second
	scannerInitialBufferSize = 64 * 1024
	scannerMaxBufferSize     = 16 * 1024 * 1024
)

// Options configures the omp RPC subprocess.
type Options struct {
	// Bin is the binary to spawn. Defaults to "gmp" (the local fork's
	// renamed coding-agent binary; intentionally not "omp" to avoid
	// collision with an upstream `omp` install on PATH).
	// Override with the GMP_TUI_BACKEND env var or legacy OMP_TUI_BACKEND
	// alias (handled by caller).
	Bin string

	// PrefixArgs are placed before "--mode rpc". This supports commands
	// such as `bun packages/coding-agent/src/cli.ts --mode rpc`.
	PrefixArgs []string

	// Args are appended after "--mode rpc".
	Args []string

	// Cwd, if non-empty, sets the subprocess working directory.
	Cwd string

	// Env, if non-nil, replaces the inherited environment. Use
	// os.Environ() and append for the additive case.
	Env []string

	// Stderr, if non-nil, receives the subprocess stderr stream.
	// Defaults to os.Stderr so log lines surface to the user.
	Stderr io.Writer
}

// Client is a thin wrapper around an omp `--mode rpc` subprocess.
// It owns the stdin/stdout pipes, dispatches frames to per-call
// channels and to a fan-out event channel, and serialises writes.
//
// Lifecycle:
//
//	c, err := ompclient.Spawn(ctx, opts)
//	defer c.Close()
//	resp, err := c.Call(ctx, ompclient.Command{Type: "prompt", Message: "hi"})
//	for ev := range c.Events() { ... }
//
// Concurrency: Call is safe for concurrent use. Events() returns the
// same channel on each call.
type Client struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout io.ReadCloser

	writeMu sync.Mutex

	mu        sync.Mutex
	pending   map[string]chan *Response
	closed    atomic.Bool
	closeOnce sync.Once

	events         chan *AgentEvent
	extensionUI    chan *ExtensionUIReq
	hostToolCall   chan *HostToolCallReq
	hostToolCancel chan *HostToolCancelReq

	idCounter atomic.Uint64
	readErr   atomic.Pointer[error]
	done      chan struct{}

	// exited is closed exactly once when the read loop terminates
	// unexpectedly (peer EOF / subprocess crash) rather than via an
	// intentional Close. closeRequested gates this: Close sets it before
	// winding the loop down so the EOF that Close itself triggers does NOT
	// surface as a backend-exited signal (no false "connection lost" banner
	// on a clean quit). BackendExited exposes the channel; the UI observes
	// it to enter a legible "backend exited" render state.
	exited         chan struct{}
	exitedOnce     sync.Once
	closeRequested atomic.Bool

	// schema holds the wire schema string from the `ready` handshake frame
	// (empty until the frame arrives). schemaMismatch records whether it
	// diverged from ExpectedSchema. Soft-buffer per OMP-RPC v1: a mismatch
	// is surfaced via slog.Warn and the flag, never a crash.
	schema         atomic.Pointer[string]
	schemaMismatch atomic.Bool
}

// Spawn launches the configured omp binary in RPC mode and returns a
// ready-to-use Client. The caller must Close the client to terminate
// the subprocess and release pipes.
func Spawn(ctx context.Context, opts Options) (*Client, error) {
	bin := opts.Bin
	if bin == "" {
		bin = "gmp"
	}
	args := append([]string{}, opts.PrefixArgs...)
	args = append(args, "--mode", "rpc")
	args = append(args, opts.Args...)

	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Dir = opts.Cwd
	if opts.Env != nil {
		cmd.Env = opts.Env
	}
	stderr := opts.Stderr
	if stderr == nil {
		stderr = os.Stderr
	}
	cmd.Stderr = stderr

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("ompclient: stdin pipe: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		return nil, fmt.Errorf("ompclient: stdout pipe: %w", err)
	}
	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		_ = stdout.Close()
		return nil, fmt.Errorf("ompclient: start %q: %w", bin, err)
	}

	c := &Client{
		cmd:            cmd,
		stdin:          stdin,
		stdout:         stdout,
		pending:        make(map[string]chan *Response),
		events:         make(chan *AgentEvent, eventsBufferSize),
		extensionUI:    make(chan *ExtensionUIReq, sideChannelBufferSize),
		hostToolCall:   make(chan *HostToolCallReq, sideChannelBufferSize),
		hostToolCancel: make(chan *HostToolCancelReq, sideChannelBufferSize),
		done:           make(chan struct{}),
		exited:         make(chan struct{}),
	}
	go c.readLoop()
	return c, nil
}

// NewWithIO constructs a Client wired directly to the given stdin / stdout
// pipes. There is no subprocess; callers (typically tests) own both ends and
// must implement the peer side themselves.
//
// This is intended for unit tests that want to drive Send / Call against a
// fake peer instead of forking a real gmp process.
func NewWithIO(stdin io.WriteCloser, stdout io.ReadCloser) *Client {
	c := &Client{
		stdin:          stdin,
		stdout:         stdout,
		pending:        make(map[string]chan *Response),
		events:         make(chan *AgentEvent, eventsBufferSize),
		extensionUI:    make(chan *ExtensionUIReq, sideChannelBufferSize),
		hostToolCall:   make(chan *HostToolCallReq, sideChannelBufferSize),
		hostToolCancel: make(chan *HostToolCancelReq, sideChannelBufferSize),
		done:           make(chan struct{}),
		exited:         make(chan struct{}),
	}
	go c.readLoop()
	return c
}

// Events returns the agent event channel. Closed when the subprocess
// exits or Close is called.
func (c *Client) Events() <-chan *AgentEvent { return c.events }

// ExtensionUIRequests yields incoming extension UI prompts.
func (c *Client) ExtensionUIRequests() <-chan *ExtensionUIReq { return c.extensionUI }

// HostToolCalls yields incoming host tool call requests.
func (c *Client) HostToolCalls() <-chan *HostToolCallReq { return c.hostToolCall }

// HostToolCancels yields incoming host tool cancellation requests.
func (c *Client) HostToolCancels() <-chan *HostToolCancelReq { return c.hostToolCancel }

// Done is closed once the read loop exits (subprocess gone).
func (c *Client) Done() <-chan struct{} { return c.done }

// BackendExited is closed exactly once when the read loop terminates
// unexpectedly — peer EOF or subprocess crash — and NOT when the loop is
// wound down by an intentional Close. Consumers select on it to surface a
// legible "backend connection lost" state instead of a frozen UI. An
// intentional quit leaves this channel open so no false banner appears.
func (c *Client) BackendExited() <-chan struct{} { return c.exited }

// Schema returns the wire schema negotiated on the `ready` handshake
// frame, or "" if no ready frame has been observed yet.
func (c *Client) Schema() string {
	if s := c.schema.Load(); s != nil {
		return *s
	}
	return ""
}

// SchemaMismatch reports whether the `ready` frame declared a schema
// other than ExpectedSchema. Always false until a ready frame arrives;
// a mismatch is soft-buffered (warned, not fatal) per OMP-RPC v1.
func (c *Client) SchemaMismatch() bool { return c.schemaMismatch.Load() }

// nextID returns a monotonically-increasing client-side correlation id.
func (c *Client) nextID() string {
	n := c.idCounter.Add(1)
	return fmt.Sprintf("c%d", n)
}

// Send writes a fire-and-forget command (no response correlation).
// Use this for stdin-side messages that don't return a Response, e.g.
// HostToolResult / ExtensionUIResp.
func (c *Client) Send(payload any) error {
	if c.closed.Load() {
		return errors.New("ompclient: closed")
	}
	buf, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("ompclient: marshal: %w", err)
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if _, err := c.stdin.Write(append(buf, '\n')); err != nil {
		return fmt.Errorf("ompclient: write: %w", err)
	}
	return nil
}

// Call sends a command and waits for the matching Response. The
// command's ID is set automatically if empty.
func (c *Client) Call(ctx context.Context, cmd Command) (*Response, error) {
	if cmd.ID == "" {
		cmd.ID = c.nextID()
	}
	respCh := make(chan *Response, 1)

	c.mu.Lock()
	if c.pending == nil {
		c.mu.Unlock()
		return nil, errors.New("ompclient: subprocess exited")
	}
	c.pending[cmd.ID] = respCh
	c.mu.Unlock()

	cleanup := func() {
		c.mu.Lock()
		if c.pending != nil {
			delete(c.pending, cmd.ID)
		}
		c.mu.Unlock()
	}

	if err := c.Send(cmd); err != nil {
		cleanup()
		return nil, err
	}

	select {
	case resp := <-respCh:
		cleanup()
		if resp == nil {
			return nil, errors.New("ompclient: subprocess exited before response")
		}
		if !resp.Success {
			return resp, fmt.Errorf("omp rpc error (%s): %s", resp.Command, resp.Error)
		}
		return resp, nil
	case <-ctx.Done():
		cleanup()
		return nil, ctx.Err()
	case <-c.done:
		cleanup()
		if errp := c.readErr.Load(); errp != nil && *errp != nil {
			return nil, fmt.Errorf("ompclient: subprocess exited: %w", *errp)
		}
		return nil, errors.New("ompclient: subprocess exited")
	}
}

// Close terminates the subprocess and releases resources.
func (c *Client) Close() error {
	var firstErr error
	c.closeOnce.Do(func() {
		// Mark the shutdown as intentional BEFORE closing stdin so the read
		// loop's resulting EOF is not mistaken for a crash and does not fire
		// the BackendExited signal.
		c.closeRequested.Store(true)
		c.closed.Store(true)
		_ = c.stdin.Close()
		// Best-effort termination if it doesn't exit on its own. cmd is nil
		// for NewWithIO clients (no subprocess); closing stdin is enough to
		// wind down the peer-driven read loop.
		if c.cmd != nil && c.cmd.Process != nil {
			_ = c.cmd.Process.Signal(os.Interrupt)
		}
		// Wait for read loop to drain.
		select {
		case <-c.done:
		case <-time.After(subprocessShutdownGrace):
			if c.cmd != nil && c.cmd.Process != nil {
				_ = c.cmd.Process.Kill()
			}
			<-c.done
		}
		if c.cmd != nil {
			if err := c.cmd.Wait(); err != nil {
				firstErr = err
			}
		}
	})
	return firstErr
}

// readLoop owns stdout. It decodes JSONL frames and dispatches them.
func (c *Client) readLoop() {
	defer close(c.done)
	defer close(c.events)
	defer close(c.extensionUI)
	defer close(c.hostToolCall)
	defer close(c.hostToolCancel)

	scanner := bufio.NewScanner(c.stdout)
	scanner.Buffer(make([]byte, scannerInitialBufferSize), scannerMaxBufferSize)

	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		c.dispatch(line)
	}
	if err := scanner.Err(); err != nil {
		c.readErr.Store(&err)
	}
	// The loop only reaches here when stdout hits EOF / error, i.e. the peer
	// is gone. If Close did not request this shutdown, it is an unexpected
	// exit (subprocess crash / peer EOF): fire BackendExited exactly once so
	// the UI can render a legible "connection lost" state.
	if !c.closeRequested.Load() {
		c.exitedOnce.Do(func() { close(c.exited) })
	}
	// Wake any pending callers.
	c.mu.Lock()
	for _, ch := range c.pending {
		close(ch)
	}
	c.pending = nil
	c.mu.Unlock()
}

// emitEvent delivers an agent event to the Events() consumer without ever
// blocking the read loop. A blocked send would also stall response dispatch
// (both run in this single goroutine), freezing every in-flight Call. The
// 256-slot buffer plus a fast consumer means the default branch is a
// last-resort safety valve; dropping is correctness-safe because v1 streaming
// frames each carry a full accumulated snapshot, so a later frame restores any
// skipped intermediate state.
func (c *Client) emitEvent(ev *AgentEvent) {
	select {
	case c.events <- ev:
	default:
		slog.Warn("ompclient: events buffer full, dropping frame to keep response dispatch alive", "kind", ev.Kind)
	}
}

// sendSideChannel delivers a side-channel frame (extension UI request, host
// tool call/cancel) without ever blocking the read loop. A blocked send in
// dispatch would also stall response and agent-event delivery — they all run in
// this single goroutine — so a stuck side-channel consumer would otherwise
// wedge the whole stream once the 16-slot buffer fills. Unlike agent events,
// these frames cannot be dropped: each one carries a backend promise that
// strands (until its multi-minute deadline) without a reply. So on a full
// buffer we spill to a short-lived goroutine that completes the blocking send.
// The goroutine recovers because the read loop closes these channels on exit;
// a spill still in flight at that moment would otherwise panic on
// send-to-closed-channel and crash the process.
func sendSideChannel[T any](ch chan T, frame T) {
	select {
	case ch <- frame:
	default:
		go func() {
			defer func() {
				if r := recover(); r != nil {
					// Lost a frame: the read loop closed the side-channels
					// mid-spill. Recovering avoids a send-on-closed-channel
					// crash; log so a frame dropped during shutdown (which
					// strands its backend promise until deadline) is observable.
					slog.Debug("ompclient: dropped spilled side-channel frame on shutdown", "recover", r)
				}
			}()
			ch <- frame
		}()
	}
}

// dispatch routes a single decoded frame to the right channel.
func (c *Client) dispatch(line []byte) {
	var probe struct {
		Type string `json:"type"`
		ID   string `json:"id,omitempty"`
	}
	if err := json.Unmarshal(line, &probe); err != nil {
		// Malformed; surface as best-effort agent_event with raw payload.
		c.emitEvent(&AgentEvent{Kind: "_raw", Payload: bytes.Clone(line)})
		return
	}

	switch probe.Type {
	case "response":
		var r Response
		if err := json.Unmarshal(line, &r); err != nil {
			c.emitEvent(&AgentEvent{Kind: "_raw", Payload: bytes.Clone(line)})
			return
		}
		// Delete the pending entry under the lock before delivering so a
		// duplicate/late response with the same id finds no waiter (ok=false)
		// instead of blocking forever on the already-drained buffer-1 channel.
		c.mu.Lock()
		ch, ok := c.pending[r.ID]
		if ok {
			delete(c.pending, r.ID)
		}
		c.mu.Unlock()
		if ok {
			select {
			case ch <- &r:
			default:
				slog.Warn("ompclient: dropping duplicate/late response", "id", r.ID)
			}
		}
	case "extension_ui_request":
		var r ExtensionUIReq
		if err := json.Unmarshal(line, &r); err == nil {
			r.Raw = bytes.Clone(line)
			sendSideChannel(c.extensionUI, &r)
		}
	case "host_tool_call":
		var r HostToolCallReq
		if err := json.Unmarshal(line, &r); err == nil {
			sendSideChannel(c.hostToolCall, &r)
		}
	case "host_tool_cancel":
		var r HostToolCancelReq
		if err := json.Unmarshal(line, &r); err == nil {
			sendSideChannel(c.hostToolCancel, &r)
		}
	case "ready":
		c.recordReadySchema(line)
		// Soft-buffer: preserve the ready frame as a raw agent event so a
		// consumer can still observe the handshake (and any unknown schema)
		// instead of silently dropping it.
		c.emitEvent(&AgentEvent{Kind: probe.Type, Payload: bytes.Clone(line)})
	default:
		// Treat everything else as an agent event. The frame's "type"
		// becomes the event Kind (message_update, tool_execution_start,
		// etc.); the full body is preserved for the consumer to parse.
		c.emitEvent(&AgentEvent{
			Kind:    probe.Type,
			Payload: bytes.Clone(line),
		})
	}
}

// recordReadySchema decodes the `ready` handshake frame, stores the
// negotiated schema, and validates it against ExpectedSchema. On
// mismatch it surfaces a slog.Warn and sets the schemaMismatch flag but
// does NOT crash or stop the read loop — OMP-RPC v1 mandates soft
// buffering so a host on a newer/older minor still functions on the
// frames it understands.
func (c *Client) recordReadySchema(line []byte) {
	var frame ReadyFrame
	if err := json.Unmarshal(line, &frame); err != nil {
		slog.Warn("ompclient: malformed ready frame", "error", err)
		return
	}
	schema := frame.Schema
	c.schema.Store(&schema)
	if schema != ExpectedSchema {
		c.schemaMismatch.Store(true)
		slog.Warn("ompclient: RPC wire schema mismatch; continuing in soft-buffer mode",
			"expected", ExpectedSchema, "got", schema)
	}
}
