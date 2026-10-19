package cli

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/otinstaller/otinstaller/cli/internal/api"
)

func TestSync(t *testing.T) {
	syncs := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == "POST" && r.URL.Path == "/v1/packages/alice/whois-plus/sync":
			syncs++
			if syncs > 1 {
				w.WriteHeader(429)
				w.Write([]byte(`{"error":{"code":"sync_rate_limited","message":"at most 10 manual syncs per hour"}}`))
				return
			}
			json.NewEncoder(w).Encode(map[string]any{"status": "ok", "queued": []string{"v1.2.0"}})
		case r.Method == "POST" && r.URL.Path == "/v1/packages/alice/gone/sync":
			json.NewEncoder(w).Encode(map[string]any{"status": "unavailable", "queued": []string{}})
		case r.Method == "GET" && r.URL.Path == "/v1/packages/alice/whois-plus/sync-log":
			w.Write([]byte(`{"source":{"provider":"github","path":"alice/whois-plus","url":"https://github.com/alice/whois-plus","sync_status":"ok",
				"last_error":null,"last_event_at":1792400000000,"last_poll_at":null,"manifest_mode":"registry"},
				"events":[{"kind":"manual","summary":"queued v1.2.0","status":"ok","error":null,"received_at":1792400000000}]}`))
		default:
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()
	a, out, errb := newTestApp(t, &fakeExec{}, "")
	a.API = api.New(srv.URL+"/v1", "test")
	if code := run(a, "sync", "alice/whois-plus"); code != ExitUsage {
		t.Fatalf("signed out: want %d, got %d", ExitUsage, code)
	}
	a.API.Token = "ot_t"
	if code := run(a, "sync", "alice/whois-plus"); code != 0 || !strings.Contains(out.String(), "Publishing 1 new tag(s): [v1.2.0]") {
		t.Fatalf("sync exit %d: %s", code, out)
	}
	if code := run(a, "sync", "alice/whois-plus"); code != ExitUsage || !strings.Contains(errb.String(), "at most 10 manual syncs") {
		t.Fatalf("rate limit exit %d: %s", code, errb)
	}
	if code := run(a, "sync", "alice/gone"); code != ExitToolError {
		t.Fatalf("unavailable: want %d, got %d", ExitToolError, code)
	}
	out.Reset()
	if code := run(a, "sync", "--log", "alice/whois-plus"); code != 0 {
		t.Fatalf("log exit %d: %s", code, out)
	}
	for _, want := range []string{"https://github.com/alice/whois-plus", "Last poll:  never", "held by the registry", "manual", "queued v1.2.0"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("log lacks %q:\n%s", want, out)
		}
	}
	if code := run(a, "sync", "alice/whois-plus@1.0.0"); code != ExitUsage {
		t.Errorf("version: want %d, got %d", ExitUsage, code)
	}
}
