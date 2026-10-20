package cli

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/zalando/go-keyring"

	"github.com/otinstaller/otinstaller/cli/internal/api"
	"github.com/otinstaller/otinstaller/cli/internal/keys"
)

func TestLoginDeviceFlow(t *testing.T) {
	keyring.MockInit()
	pollSleep = func(context.Context, time.Duration) error { return nil }
	polls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]string
		json.NewDecoder(r.Body).Decode(&body)
		switch r.URL.Path {
		case "/v1/auth/device/start":
			json.NewEncoder(w).Encode(map[string]any{"provider": body["provider"], "device_code": "dc", "user_code": "ABCD-1234",
				"verification_uri": "https://github.com/login/device", "interval": 5, "expires_in": 900})
		case "/v1/auth/device/token":
			polls++
			if polls < 3 {
				json.NewEncoder(w).Encode(map[string]string{"status": "pending"})
				return
			}
			json.NewEncoder(w).Encode(map[string]string{"status": "ok", "token": "ot_secret", "login": "alice"})
		case "/v1/me":
			if r.Header.Get("Authorization") != "Bearer ot_secret" {
				w.WriteHeader(401)
				w.Write([]byte(`{"error":{"code":"unauthenticated","message":"sign in first"}}`))
				return
			}
			w.Write([]byte(`{"login":"alice","accounts":[{"provider":"github","login":"alice"}],"namespaces":[{"name":"alice","status":"pending_review","role":"owner"}]}`))
		}
	}))
	defer srv.Close()

	a, out, _ := newTestApp(t, &fakeExec{}, "")
	a.API = api.New(srv.URL+"/v1", "test")
	if code := run(a, "login"); code != 0 {
		t.Fatalf("login exit %d: %s", code, out)
	}
	if !strings.Contains(out.String(), "ABCD-1234") || !strings.Contains(out.String(), "Signed in as alice") {
		t.Fatalf("unexpected output: %s", out)
	}
	if tok, _ := keys.Get(TokenKey); tok != "ot_secret" {
		t.Fatalf("token not stored, got %q", tok)
	}
	out.Reset()
	a.API.Token = "ot_secret"
	if code := run(a, "whoami"); code != 0 || !strings.Contains(out.String(), "namespace alice: owner, pending review") {
		t.Fatalf("whoami exit %d: %s", code, out)
	}
	a.API.Token = "ot_stale"
	if code := run(a, "whoami"); code != ExitUsage {
		t.Fatalf("stale token: want %d, got %d", ExitUsage, code)
	}
	run(a, "logout")
	if _, err := keys.Get(TokenKey); err == nil {
		t.Fatal("logout did not remove the token")
	}
}

func TestLoginWithOSINTverse(t *testing.T) {
	keyring.MockInit()
	pollSleep = func(context.Context, time.Duration) error { return nil }
	var providers []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]string
		json.NewDecoder(r.Body).Decode(&body)
		providers = append(providers, body["provider"])
		switch r.URL.Path {
		case "/v1/auth/device/start":
			json.NewEncoder(w).Encode(map[string]any{"provider": "osintverse", "device_code": "dc", "user_code": "BCDF-GHJK",
				"verification_uri": "https://api.otinstaller.com/v1/auth/osintverse/device", "interval": 5, "expires_in": 600})
		case "/v1/auth/device/token":
			json.NewEncoder(w).Encode(map[string]string{"status": "ok", "token": "ot_ov", "login": "ada-lovelace"})
		}
	}))
	defer srv.Close()

	a, out, _ := newTestApp(t, &fakeExec{}, "")
	a.API = api.New(srv.URL+"/v1", "test")
	if code := run(a, "login", "--osintverse"); code != 0 {
		t.Fatalf("login exit %d: %s", code, out)
	}
	if strings.Join(providers, ",") != "osintverse,osintverse" {
		t.Fatalf("providers sent: %v", providers)
	}
	if !strings.Contains(out.String(), "/v1/auth/osintverse/device") || !strings.Contains(out.String(), "Signed in as ada-lovelace (osintverse)") {
		t.Fatalf("unexpected output: %s", out)
	}
	if code := run(a, "login", "--osintverse", "--gitlab"); code != ExitUsage {
		t.Fatalf("both flags: exit %d, want %d", code, ExitUsage)
	}
}
