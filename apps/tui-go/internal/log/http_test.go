package log

import (
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestHTTPRoundTripLogger(t *testing.T) {
	client := &http.Client{
		Transport: &HTTPRoundTripLogger{
			Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
				if req.Method != http.MethodPost {
					t.Fatalf("expected POST, got %s", req.Method)
				}
				return &http.Response{
					StatusCode:    http.StatusInternalServerError,
					Status:        "500 Internal Server Error",
					Header:        http.Header{"Content-Type": []string{"application/json"}, "X-Custom-Header": []string{"test-value"}},
					Body:          io.NopCloser(strings.NewReader(`{"error": "Internal server error", "code": 500}`)),
					ContentLength: int64(len(`{"error": "Internal server error", "code": 500}`)),
					Request:       req,
				}, nil
			}),
		},
	}

	req, err := http.NewRequestWithContext(
		t.Context(),
		http.MethodPost,
		"https://example.test/fail",
		strings.NewReader(`{"test": "data"}`),
	)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer secret-token")

	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	// Verify response
	if resp.StatusCode != http.StatusInternalServerError {
		t.Errorf("Expected status code 500, got %d", resp.StatusCode)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

func TestFormatHeaders(t *testing.T) {
	headers := http.Header{
		"Content-Type":  []string{"application/json"},
		"Authorization": []string{"Bearer secret-token"},
		"X-API-Key":     []string{"api-key-123"},
		"User-Agent":    []string{"test-agent"},
	}

	formatted := formatHeaders(headers)

	// Check that sensitive headers are redacted
	if formatted["Authorization"][0] != "[REDACTED]" {
		t.Error("Authorization header should be redacted")
	}
	if formatted["X-API-Key"][0] != "[REDACTED]" {
		t.Error("X-API-Key header should be redacted")
	}

	// Check that non-sensitive headers are preserved
	if formatted["Content-Type"][0] != "application/json" {
		t.Error("Content-Type header should be preserved")
	}
	if formatted["User-Agent"][0] != "test-agent" {
		t.Error("User-Agent header should be preserved")
	}
}
