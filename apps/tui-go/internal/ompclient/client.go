package ompclient

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
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
	// Bin is the binary to spawn. Defaults to "omp".
	// Override with the OMP_TUI_BACKEND env var (handled by caller).
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
}

// Spawn launches the configured omp binary in RPC mode and returns a
// ready-to-use Client. The caller must Close the client to terminate
// the subprocess and release pipes.
func Spawn(ctx context.Context, opts Options) (*Client, error) {
	bin := opts.Bin
	if bin == "" {
		bin = "omp"
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
	}
	go c.readLoop()
	return c, nil
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
		c.closed.Store(true)
		_ = c.stdin.Close()
		// Best-effort termination if it doesn't exit on its own.
		if c.cmd.Process != nil {
			_ = c.cmd.Process.Signal(os.Interrupt)
		}
		// Wait for read loop to drain.
		select {
		case <-c.done:
		case <-time.After(subprocessShutdownGrace):
			if c.cmd.Process != nil {
				_ = c.cmd.Process.Kill()
			}
			<-c.done
		}
		if err := c.cmd.Wait(); err != nil {
			firstErr = err
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
	// Wake any pending callers.
	c.mu.Lock()
	for _, ch := range c.pending {
		close(ch)
	}
	c.pending = nil
	c.mu.Unlock()
}

// dispatch routes a single decoded frame to the right channel.
func (c *Client) dispatch(line []byte) {
	var probe struct {
		Type string `json:"type"`
		ID   string `json:"id,omitempty"`
	}
	if err := json.Unmarshal(line, &probe); err != nil {
		// Malformed; surface as best-effort agent_event with raw payload.
		c.events <- &AgentEvent{Kind: "_raw", Payload: bytes.Clone(line)}
		return
	}

	switch probe.Type {
	case "response":
		var r Response
		if err := json.Unmarshal(line, &r); err != nil {
			c.events <- &AgentEvent{Kind: "_raw", Payload: bytes.Clone(line)}
			return
		}
		c.mu.Lock()
		ch, ok := c.pending[r.ID]
		c.mu.Unlock()
		if ok {
			ch <- &r
		}
	case "extension_ui_request":
		var r ExtensionUIReq
		if err := json.Unmarshal(line, &r); err == nil {
			r.Raw = bytes.Clone(line)
			c.extensionUI <- &r
		}
	case "host_tool_call":
		var r HostToolCallReq
		if err := json.Unmarshal(line, &r); err == nil {
			c.hostToolCall <- &r
		}
	case "host_tool_cancel":
		var r HostToolCancelReq
		if err := json.Unmarshal(line, &r); err == nil {
			c.hostToolCancel <- &r
		}
	default:
		// Treat everything else as an agent event. The frame's "type"
		// becomes the event Kind (message_update, tool_execution_start,
		// etc.); the full body is preserved for the consumer to parse.
		c.events <- &AgentEvent{
			Kind:    probe.Type,
			Payload: bytes.Clone(line),
		}
	}
}
