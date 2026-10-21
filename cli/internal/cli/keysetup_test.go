package cli

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"github.com/zalando/go-keyring"

	"github.com/otinstaller/otinstaller/cli/internal/keys"
)

func TestKeysSetupWalksThroughAKey(t *testing.T) {
	keyring.MockInit()
	// Open the sign-up page, then paste the key.
	a, out, errb := newTestApp(t, &fakeExec{}, "y\nhibp-secret-value\n")
	if code := run(a, "install", filepath.Join(fixtures, "valid", "docker-tool.yaml")); code != 0 {
		t.Fatalf("install: %d %s", code, errb)
	}
	var opened []string
	a.OpenURL = func(u string) error { opened = append(opened, u); return nil }
	out.Reset()
	if code := run(a, "keys", "setup", "dheeraj/holehe-lite"); code != 0 {
		t.Fatalf("keys setup: exit %d: %s", code, errb)
	}
	for _, want := range []string{"HIBP_API_KEY (optional, used by dheeraj/holehe-lite)", "Adds breach data", "Cost: paid",
		"Get one at https://haveibeenpwned.com/API/Key", "Saved HIBP_API_KEY", "1 saved, 0 skipped"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("output lacks %q:\n%s", want, out)
		}
	}
	if len(opened) != 1 || opened[0] != "https://haveibeenpwned.com/API/Key" {
		t.Errorf("opened %v", opened)
	}
	if v, err := keys.Get("HIBP_API_KEY"); err != nil || v != "hibp-secret-value" {
		t.Errorf("stored %q, %v", v, err)
	}
	if strings.Contains(out.String()+errb.String(), "hibp-secret-value") {
		t.Error("the key's value was printed")
	}

	// Once it is set, it is skipped.
	out.Reset()
	a.In = strings.NewReader("")
	if code := run(a, "keys", "setup"); code != 0 || !strings.Contains(out.String(), "Already set (keychain); skipped.") {
		t.Errorf("second setup: %d\n%s", code, out)
	}
}

func TestKeysSetupNeedsATerminal(t *testing.T) {
	keyring.MockInit()
	a, _, errb := newTestApp(t, &fakeExec{}, "a-key-from-a-pipe\n")
	t.Setenv("OT_NONINTERACTIVE", "1")
	t.Setenv("OT_OUTPUT", "json")
	if code := run(a, "keys", "setup", "dheeraj/holehe-lite"); code != ExitUsage {
		t.Fatalf("exit %d, want %d", code, ExitUsage)
	}
	var e struct{ Error struct{ Code string } }
	if err := json.Unmarshal(errb.Bytes(), &e); err != nil || e.Error.Code != "needs_terminal" {
		t.Errorf("error %q: %v", errb, err)
	}
	if _, err := keys.Get("HIBP_API_KEY"); err == nil {
		t.Error("a key was stored without a terminal")
	}
}

func TestMCPKeySetupNeverShowsValues(t *testing.T) {
	keyring.MockInit()
	h := newMCP(t, `{"entities":[]}`, "", nil, filepath.Join(fixtures, "valid", "docker-tool.yaml"))
	if err := keys.Set("HIBP_API_KEY", "do-not-show-me"); err != nil {
		t.Fatal(err)
	}
	out, e := h.call("key_setup", map[string]any{"tools": []string{"dheeraj/holehe-lite"}})
	if e != nil {
		t.Fatalf("key_setup: %v", e)
	}
	b, _ := json.Marshal(out)
	if strings.Contains(string(b), "do-not-show-me") {
		t.Fatal("key_setup shows a key's value")
	}
	if out["command"] != "ot keys setup dheeraj/holehe-lite" {
		t.Errorf("command %v", out["command"])
	}
	k := out["keys"].([]any)[0].(map[string]any)
	if k["name"] != "HIBP_API_KEY" || k["set"] != true || k["source"] != "keychain" || k["pricing"] != "paid" || k["command"] != "ot keys set HIBP_API_KEY" {
		t.Errorf("key %v", k)
	}
}
