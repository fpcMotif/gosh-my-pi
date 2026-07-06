package model

import (
	"testing"

	uv "github.com/charmbracelet/ultraviolet"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ui/common"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ui/notification"
	"github.com/stretchr/testify/require"
)

// TestSelectNotificationBackend asserts the backend chosen for each terminal
// environment. The contract is the turn-complete fallback chain: remote/SSH
// sessions get OSC (never silence), local focus-reporting sessions get native,
// and headless local terminals fall back to OSC-if-supported-else-bell.
func TestSelectNotificationBackend(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name string
		caps common.Capabilities
		want notification.Backend
	}{
		{
			name: "ssh session selects OSC backend",
			caps: common.Capabilities{Env: uv.Environ{"SSH_TTY=/dev/pts/0"}},
			want: &notification.OSCBackend{},
		},
		{
			name: "ssh connection without tty still selects OSC backend",
			caps: common.Capabilities{Env: uv.Environ{"SSH_CONNECTION=1.2.3.4 22 5.6.7.8 22"}},
			want: &notification.OSCBackend{},
		},
		{
			name: "local with focus events selects native backend",
			caps: common.Capabilities{Env: uv.Environ{}, ReportFocusEvents: true},
			want: &notification.NativeBackend{},
		},
		{
			name: "headless local with OSC 99 selects OSC backend",
			caps: common.Capabilities{Env: uv.Environ{}, OSC99Notifications: true},
			want: &notification.OSCBackend{},
		},
		{
			name: "headless local without OSC falls back to bell",
			caps: common.Capabilities{Env: uv.Environ{}},
			want: &notification.BellBackend{},
		},
		{
			name: "ssh takes priority over focus events",
			caps: common.Capabilities{Env: uv.Environ{"SSH_TTY=/dev/pts/1"}, ReportFocusEvents: true},
			want: &notification.OSCBackend{},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := selectNotificationBackend(tc.caps)
			require.IsType(t, tc.want, got)
		})
	}
}

// TestUpdateNotificationBackend asserts the model re-selects its backend from
// the current capabilities, switching away from the default Noop backend once
// a remote session is detected.
func TestUpdateNotificationBackend(t *testing.T) {
	t.Parallel()

	m := &UI{notifyBackend: notification.NoopBackend{}}
	m.caps = common.Capabilities{Env: uv.Environ{"SSH_TTY=/dev/pts/0"}}

	m.updateNotificationBackend()

	require.IsType(t, &notification.OSCBackend{}, m.notifyBackend)
}
