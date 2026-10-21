package cli

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/otinstaller/otinstaller/cli/internal/api"
)

func TestTokenCommands(t *testing.T) {
	var posted []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		posted = append(posted, r.Method+" "+r.URL.Path+" "+string(body))
		if r.Header.Get("Authorization") != "Bearer ot_me" {
			w.WriteHeader(401)
			return
		}
		switch r.Method + " " + r.URL.Path {
		case "POST /v1/me/tokens":
			w.WriteHeader(201)
			w.Write([]byte(`{"id":"tk1","token":"ot_new","scopes":["read","publish"],"expires_at":1800000000000}`))
		case "GET /v1/me/tokens":
			w.Write([]byte(`{"tokens":[{"id":"tk1","name":"ci","scopes":["read","publish"],"scoped":true,"expires_at":1800000000000,"created_at":1},
				{"id":"tk0","name":"ot CLI","scopes":["read","publish","manage","feedback","staff"],"scoped":false,"created_at":1,"current":true}]}`))
		case "DELETE /v1/me/tokens/tk1":
			w.WriteHeader(204)
		default:
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()
	a, out, errb := newTestApp(t, &fakeExec{}, "")
	a.API = api.New(srv.URL+"/v1", "test")

	if code := run(a, "token", "create", "ci"); code != ExitUsage {
		t.Fatalf("not signed in: exit %d", code)
	}
	a.API.Token = "ot_me"
	if code := run(a, "token", "create", "ci", "--scope", "publish", "--expires", "30"); code != 0 {
		t.Fatalf("create: exit %d: %s", code, errb)
	}
	if strings.TrimSpace(out.String()) != "ot_new" || !strings.Contains(errb.String(), "shown once") {
		t.Fatalf("create output: %q / %q", out, errb)
	}
	var sent map[string]any
	json.Unmarshal([]byte(strings.SplitN(posted[len(posted)-1], " ", 3)[2]), &sent)
	if sent["name"] != "ci" || sent["expires_in_days"].(float64) != 30 || sent["scopes"].([]any)[0] != "publish" {
		t.Fatalf("sent %v", sent)
	}
	if code := run(a, "token", "create", "x", "--scope", "staff"); code != ExitUsage {
		t.Errorf("staff tokens are made on the website: exit %d", code)
	}
	out.Reset()
	if code := run(a, "token", "list"); code != 0 || !strings.Contains(out.String(), "ot CLI (this one)") || !strings.Contains(out.String(), "all (older token)") {
		t.Fatalf("list: exit %d\n%s", code, out)
	}
	out.Reset()
	if code := run(a, "token", "revoke", "tk1", "--json"); code != 0 || !strings.Contains(out.String(), `"revoked": true`) {
		t.Fatalf("revoke: exit %d\n%s", code, out)
	}
}
