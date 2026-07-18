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

const (
	exitOpen uint32 = iota
	exitIntentional
	exitUnexpected
)

// ErrIngressFull means a required inbound frame could not be handed to its
// consumer. The client fails closed rather than dropping the frame or growing
// an unbounded backlog.
var ErrIngressFull = errors.New("ompclient: inbound queue full")

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

	processReapOnce sync.Once
	processDone     chan struct{}
	processErr      error

	events         chan *AgentEvent
	extensionUI    chan *ExtensionUIReq
	hostToolCall   chan *HostToolCallReq
	hostToolCancel chan *HostToolCancelReq

	idCounter atomic.Uint64
	readErr   atomic.Pointer[error]
	done      chan struct{}

	// exitKind arbitrates the first terminal cause. Close claims intentional
	// before touching pipes; inbound overflow claims unexpected at detection.
	// This prevents a concurrent Close from masking an already-detected fault.
	exited     chan struct{}
	exitedOnce sync.Once
	exitKind   atomic.Uint32

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
		processDone:    make(chan struct{}),
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
		processDone:    make(chan struct{}),
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

// Done is closed once the read loop exits. Automatic process reaping may still
// be in progress after an unexpected exit.
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
			return nil, c.exitError()
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
		return nil, c.exitError()
	}
}

func (c *Client) exitError() error {
	if errp := c.readErr.Load(); errp != nil && *errp != nil {
		return fmt.Errorf("ompclient: subprocess exited: %w", *errp)
	}
	return errors.New("ompclient: subprocess exited")
}

// Close terminates the subprocess and releases resources.
func (c *Client) Close() error {
	var firstErr error
	c.closeOnce.Do(func() {
		// Mark the shutdown as intentional BEFORE closing stdin so the read
		// loop's resulting EOF is not mistaken for a crash and does not fire
		// the BackendExited signal.
		c.exitKind.CompareAndSwap(exitOpen, exitIntentional)
		c.stopBackend()
		if err := c.waitForReadLoop(); err != nil {
			firstErr = err
		}
		if c.cmd != nil {
			c.startProcessReaper()
			select {
			case <-c.processDone:
				if firstErr == nil && c.processErr != nil {
					firstErr = c.processErr
				}
			case <-time.After(2 * subprocessShutdownGrace):
				if firstErr == nil {
					firstErr = errors.New("ompclient: timed out reaping subprocess")
				}
			}
		}
	})
	return firstErr
}

// waitForReadLoop gives the backend one grace period, then closes the local
// stdout pipe so descendants cannot retain it and hold Scanner open. The
// second wait is also bounded: a broken ReadCloser cannot hang Close.
func (c *Client) waitForReadLoop() error {
	select {
	case <-c.done:
		return nil
	case <-time.After(subprocessShutdownGrace):
		if c.cmd != nil && c.cmd.Process != nil {
			_ = c.cmd.Process.Kill()
		}
		_ = c.stdout.Close()
	}

	select {
	case <-c.done:
		return nil
	case <-time.After(subprocessShutdownGrace):
		return errors.New("ompclient: timed out stopping read loop")
	}
}

// startProcessReaper gives Cmd.Wait exactly one owner. Unexpected read-loop
// exits call this after Done closes; Close may call it concurrently.
func (c *Client) startProcessReaper() {
	if c.cmd == nil {
		return
	}
	c.processReapOnce.Do(func() {
		go func() {
			c.processErr = c.reapProcess()
			close(c.processDone)
		}()
	})
}

// reapProcess bounds process reaping. A backend can ignore both closed stdin
// and Interrupt; in that case the reaper escalates to Kill.
func (c *Client) reapProcess() error {
	result := make(chan error, 1)
	go func() { result <- c.cmd.Wait() }()

	select {
	case err := <-result:
		return err
	case <-time.After(subprocessShutdownGrace):
		if c.cmd.Process != nil {
			_ = c.cmd.Process.Kill()
		}
	}

	select {
	case err := <-result:
		return err
	case <-time.After(subprocessShutdownGrace):
		return errors.New("ompclient: subprocess did not exit after kill")
	}
}

// readLoop owns stdout. It decodes JSONL frames and dispatches them.
func (c *Client) readLoop() {
	unexpectedExit := false
	defer func() {
		_ = c.stdout.Close()
		close(c.hostToolCancel)
		close(c.hostToolCall)
		close(c.extensionUI)
		close(c.events)
		close(c.done)
		if unexpectedExit {
			c.startProcessReaper()
		}
	}()

	scanner := bufio.NewScanner(c.stdout)
	scanner.Buffer(make([]byte, scannerInitialBufferSize), scannerMaxBufferSize)

	var readErr error
	for {
		if !scanner.Scan() {
			unexpectedExit = c.claimUnexpectedExit()
			break
		}
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		if err := c.dispatch(line); err != nil {
			readErr = err
			unexpectedExit = c.claimUnexpectedExit()
			break
		}
	}
	if readErr == nil {
		readErr = scanner.Err()
	}
	if readErr != nil {
		c.readErr.Store(&readErr)
	}
	// The loop only reaches here when stdout hits EOF / error, i.e. the peer
	// is gone. If Close did not request this shutdown, it is an unexpected
	// exit (subprocess crash / peer EOF): fire BackendExited exactly once so
	// the UI can render a legible "connection lost" state.
	if unexpectedExit {
		c.stopBackend()
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

// claimUnexpectedExit atomically preserves the first terminal cause.
func (c *Client) claimUnexpectedExit() bool {
	if c.exitKind.CompareAndSwap(exitOpen, exitUnexpected) {
		return true
	}
	return c.exitKind.Load() == exitUnexpected
}

// stopBackend requests subprocess termination without waiting.
func (c *Client) stopBackend() {
	c.closed.Store(true)
	_ = c.stdin.Close()
	if c.cmd != nil && c.cmd.Process != nil {
		_ = c.cmd.Process.Signal(os.Interrupt)
	}
}

// emitEvent offers an event without blocking response dispatch. A full queue
// is terminal: dropping agent frames loses protocol state.
func (c *Client) emitEvent(ev *AgentEvent) error {
	select {
	case c.events <- ev:
		return nil
	default:
		c.claimUnexpectedExit()
		return fmt.Errorf("%w: events", ErrIngressFull)
	}
}

// sendSideChannel offers a required side-channel frame without blocking the
// read loop. A full queue is terminal: every frame represents a backend
// promise that must not be dropped or deferred in an unbounded goroutine.
func sendSideChannel[T any](c *Client, ch chan<- T, frame T, name string) error {
	select {
	case ch <- frame:
		return nil
	default:
		c.claimUnexpectedExit()
		return fmt.Errorf("%w: %s", ErrIngressFull, name)
	}
}

// dispatch routes a single decoded frame to the right channel.
func (c *Client) dispatch(line []byte) error {
	var probe struct {
		Type string `json:"type"`
		ID   string `json:"id,omitempty"`
	}
	if err := json.Unmarshal(line, &probe); err != nil {
		// Malformed; surface as best-effort agent_event with raw payload.
		return c.emitEvent(&AgentEvent{Kind: "_raw", Payload: bytes.Clone(line)})
	}

	switch probe.Type {
	case "response":
		var r Response
		if err := json.Unmarshal(line, &r); err != nil {
			return c.emitEvent(&AgentEvent{Kind: "_raw", Payload: bytes.Clone(line)})
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
			return sendSideChannel(c, c.extensionUI, &r, "extension UI requests")
		}
	case "host_tool_call":
		var r HostToolCallReq
		if err := json.Unmarshal(line, &r); err == nil {
			return sendSideChannel(c, c.hostToolCall, &r, "host tool calls")
		}
	case "host_tool_cancel":
		var r HostToolCancelReq
		if err := json.Unmarshal(line, &r); err == nil {
			return sendSideChannel(c, c.hostToolCancel, &r, "host tool cancels")
		}
	case "ready":
		c.recordReadySchema(line)
		// Soft-buffer: preserve the ready frame as a raw agent event so a
		// consumer can still observe the handshake (and any unknown schema)
		// instead of silently dropping it.
		return c.emitEvent(&AgentEvent{Kind: probe.Type, Payload: bytes.Clone(line)})
	default:
		// Treat everything else as an agent event. The frame's "type"
		// becomes the event Kind (message_update, tool_execution_start,
		// etc.); the full body is preserved for the consumer to parse.
		return c.emitEvent(&AgentEvent{
			Kind:    probe.Type,
			Payload: bytes.Clone(line),
		})
	}
	return nil
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
