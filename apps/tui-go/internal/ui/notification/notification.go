// Package notification provides desktop notification support for the UI.
//
// This package supports multiple notification backends:
//   - NativeBackend: Uses the native OS notification system (macOS, Windows, Linux)
//     via beeep.
//   - OSCBackend: Uses OSC escape sequences with automatic protocol detection.
//     Prefers OSC 99 (modern standard with rich notifications) if supported,
//     falling back to OSC 777 (urxvt extension, widely supported). Used for
//     remote/SSH sessions where the native OS notification daemon is unreachable.
//   - BellBackend: Triggers the terminal bell character (\x07), causing an audible
//     beep or visual flash. Works in virtually all terminals but provides no message
//     text. Last-resort fallback for headless/remote terminals.
//   - NoopBackend: A no-op backend that silently discards notifications. Used when
//     notifications are disabled or no suitable backend is available.
//
// Backend selection is based on terminal capabilities and environment:
//   - Remote/SSH sessions use the OSC backend (auto-detects OSC 99 vs 777).
//   - Local sessions use native OS notifications when focus events are supported.
//   - When nothing else is available, the terminal bell is used as a last resort.
package notification

import tea "charm.land/bubbletea/v2"

// Notification represents a desktop notification request.
type Notification struct {
	Title   string
	Message string
}

// Backend defines the interface for sending desktop notifications.
// Implementations return a [tea.Cmd] that performs the notification, allowing
// each backend to choose between synchronous (native OS) and asynchronous
// (terminal escape sequences) delivery. Policy decisions (config checks,
// focus state) are handled by the caller.
type Backend interface {
	Send(n Notification) tea.Cmd
}
