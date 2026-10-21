package cli

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"testing"

	"github.com/otinstaller/otinstaller/cli/internal/api"
)

func TestFeedback(t *testing.T) {
	var bodies []map[string]string
	var auth []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/feedback" {
			w.WriteHeader(404)
			return
		}
		b, _ := io.ReadAll(r.Body)
		var m map[string]string
		json.Unmarshal(b, &m)
		bodies = append(bodies, m)
		auth = append(auth, r.Header.Get("Authorization"))
		w.WriteHeader(201)
		w.Write([]byte(`{"id":"f1","status":"open","note":"Thank you."}`))
	}))
	defer srv.Close()

	a, out, errb := newTestApp(t, &fakeExec{}, "")
	a.API = api.New(srv.URL+"/v1", "test")
	a.API.Token = "ot_tok"
	var opened []string
	a.OpenURL = func(u string) error { opened = append(opened, u); return nil }

	if code := run(a, "feedback", "--kind", "bug", "--about", "ot install", "install", "hangs", "behind a proxy"); code != 0 || !strings.Contains(out.String(), "Feedback f1 sent. Thank you.") {
		t.Fatalf("feedback exit %d: %s %s", code, out, errb)
	}
	want := map[string]string{"kind": "bug", "message": "install hangs behind a proxy", "page": "ot install", "source": "cli",
		"client": "ot dev (" + runtime.GOOS + "/" + runtime.GOARCH + ")"}
	for k, v := range want {
		if bodies[0][k] != v {
			t.Errorf("%s = %q, want %q", k, bodies[0][k], v)
		}
	}
	if _, ok := bodies[0]["email"]; ok || auth[0] != "Bearer ot_tok" {
		t.Errorf("email sent unasked or no token: %v %v", bodies[0], auth)
	}

	// Piped text is the message (ot doctor 2>&1 | ot feedback --kind bug).
	a.In = strings.NewReader("docker: not found\n")
	if code := run(a, "feedback", "--kind", "bug", "--email", "pat@example.com"); code != 0 || bodies[1]["message"] != "docker: not found" || bodies[1]["email"] != "pat@example.com" {
		t.Fatalf("piped feedback exit %d: %v %s", code, bodies, errb)
	}

	// Nothing to send opens the form on the website.
	a.In = strings.NewReader("")
	if code := run(a, "feedback"); code != 0 || len(opened) != 1 || opened[0] != "https://otinstaller.com/feedback" || len(bodies) != 2 {
		t.Fatalf("form: exit %d, opened %v, sent %d", code, opened, len(bodies))
	}

	if code := run(a, "feedback", "--kind", "rant", "hello"); code != ExitUsage {
		t.Errorf("bad kind exit %d", code)
	}
}
