package cli

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/otinstaller/otinstaller/cli/internal/api"
)

// fakeImports is the registry's import wizard: a Docker repository whose draft lacks what can't be detected.
type fakeImports struct {
	edits     []map[string]any
	finished  string
	community bool
	wrapper   string
}

func (f *fakeImports) handler(t *testing.T) http.HandlerFunc {
	draft := map[string]any{
		"schema": 1, "name": "whois-plus", "namespace": "alice", "version": "1.10.0", "summary": "WHOIS lookups with registrar dates",
		"license": "MIT", "readme": "README.md", "categories": []string{"domain-dns"},
		"runtime": map[string]any{"kind": "docker", "image": "ghcr.io/alice/whois-plus@sha256:" + strings.Repeat("a", 64), "platforms": []string{"linux/amd64"}, "output_format": "json"},
	}
	view := func(status string, missing, suggested []string) map[string]any {
		return map[string]any{
			"id": "imp1", "provider": "github", "repo": "alice/whois-plus", "status": status, "namespace": "alice", "detected_kind": "docker",
			"signals": []string{"Dockerfile"}, "assumed": []string{`runtime.output_format: "json"`}, "finish_modes": []string{"pr", "registry"},
			"can_hold_manifest": !f.community, "community": f.community, "draft": draft, "draft_yaml": "name: whois-plus\n", "problems": []any{}, "missing": missing, "suggested": suggested,
		}
	}
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer ot_t" {
			w.WriteHeader(401)
			return
		}
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		switch {
		case r.Method == "POST" && r.URL.Path == "/v1/imports":
			if repos, ok := body["repos"].([]any); ok {
				var imps []map[string]any
				for i, repo := range repos {
					imps = append(imps, map[string]any{"id": "b" + string(rune('1'+i)), "repo": repo, "status": "detecting"})
				}
				w.WriteHeader(202)
				json.NewEncoder(w).Encode(map[string]any{"batch_id": "batch1", "imports": imps})
				return
			}
			if body["repo"] != "https://github.com/alice/whois-plus" {
				t.Errorf("unexpected repo %v", body["repo"])
			}
			w.WriteHeader(201)
			f.community, _ = body["community"].(bool)
			v := view("draft", []string{"inputs", "outputs", "command", "ethics"}, []string{"test"})
			if f.community {
				v["finish_modes"] = []string{"wrapper"}
			}
			json.NewEncoder(w).Encode(v)
		case r.Method == "PATCH" && r.URL.Path == "/v1/imports/imp1":
			f.edits = append(f.edits, body)
			json.NewEncoder(w).Encode(view("ready", []string{}, []string{}))
		case r.Method == "POST" && r.URL.Path == "/v1/imports/imp1/finish":
			f.finished, _ = body["mode"].(string)
			f.wrapper, _ = body["wrapper_repo"].(string)
			v := view("finished", []string{}, []string{})
			v["finish_mode"] = f.finished
			v["pr_url"] = "https://github.com/alice/whois-plus/pull/7"
			json.NewEncoder(w).Encode(v)
		case r.Method == "GET" && r.URL.Path == "/v1/imports":
			json.NewEncoder(w).Encode(map[string]any{"imports": []any{view("draft", []string{"ethics"}, nil)}})
		default:
			w.WriteHeader(404)
			w.Write([]byte(`{"error":{"code":"not_found","message":"No such endpoint."}}`))
		}
	}
}

func importApp(t *testing.T, stdin string) (*App, *fakeImports, *bytes.Buffer) {
	f := &fakeImports{}
	srv := httptest.NewServer(f.handler(t))
	t.Cleanup(srv.Close)
	a, out, _ := newTestApp(t, &fakeExec{}, stdin)
	a.API = api.New(srv.URL+"/v1", "test")
	a.API.Token = "ot_t"
	return a, f, out
}

func TestImportWizardCompletesDraftAndOpensPR(t *testing.T) {
	// Answers: input type, input name, outputs, command, three ethics questions, test value, finish mode.
	stdin := "domain\n\norganization, domain\nwhois-plus --json {domain}\nn\nn\ny\nexample.com\n\n"
	a, f, out := importApp(t, stdin)
	if code := run(a, "import", "https://github.com/alice/whois-plus"); code != 0 {
		t.Fatalf("exit %d: %s", code, out)
	}
	if len(f.edits) != 1 {
		t.Fatalf("want one edit, got %v", f.edits)
	}
	m := f.edits[0]["manifest"].(map[string]any)
	if got := m["inputs"].([]any)[0].(map[string]any); got["name"] != "domain" || got["type"] != "domain" || got["required"] != true {
		t.Errorf("inputs = %v", got)
	}
	if outs := m["outputs"].([]any); len(outs) != 2 || outs[1].(map[string]any)["type"] != "domain" {
		t.Errorf("outputs = %v", outs)
	}
	rt := m["runtime"].(map[string]any)
	if strings.Join(toStrings(rt["command"].([]any)), " ") != "whois-plus --json {domain}" || rt["image"] == nil {
		t.Errorf("runtime = %v", rt)
	}
	if e := m["ethics"].(map[string]any); e["touches_target"] != false || e["collects_personal_data"] != true {
		t.Errorf("ethics = %v", e)
	}
	if ti := m["test"].(map[string]any)["input"].(map[string]any); ti["domain"] != "example.com" {
		t.Errorf("test = %v", ti)
	}
	if f.finished != "pr" {
		t.Errorf("finished with %q", f.finished)
	}
	for _, want := range []string{"alice/whois-plus", "Dockerfile", "https://github.com/alice/whois-plus/pull/7"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("output lacks %q:\n%s", want, out)
		}
	}
}

func TestImportRegistryFlagAndYes(t *testing.T) {
	a, f, out := importApp(t, "")
	// --yes cannot answer the questions that need the author.
	if code := run(a, "import", "--yes", "https://github.com/alice/whois-plus"); code != ExitUsage {
		t.Fatalf("want exit %d, got %d: %s", ExitUsage, code, out)
	}
	if f.finished != "" {
		t.Fatal("finished without the required fields")
	}
	a, f, out = importApp(t, "domain\ndomain\nother\nwhois-plus {domain}\nn\nn\ny\n\n")
	if code := run(a, "import", "--registry", "https://github.com/alice/whois-plus"); code != 0 {
		t.Fatalf("exit %d: %s", code, out)
	}
	if f.finished != "registry" {
		t.Errorf("finished with %q", f.finished)
	}
}

func TestImportCommunityWrapper(t *testing.T) {
	// Answers as in the PR test, then Enter to accept the suggested wrapper repository.
	a, f, out := importApp(t, "domain\n\nother\nwhois-plus {domain}\nn\nn\ny\n\n\n")
	if code := run(a, "import", "--community", "https://github.com/alice/whois-plus"); code != 0 {
		t.Fatalf("exit %d: %s", code, out)
	}
	if !f.community || f.finished != "wrapper" || f.wrapper != "https://github.com/osintverse-community/whois-plus" {
		t.Errorf("community=%v mode=%q wrapper=%q", f.community, f.finished, f.wrapper)
	}
	a, f, out = importApp(t, "domain\n\nother\nwhois-plus {domain}\nn\nn\ny\n\n")
	if code := run(a, "import", "--community", "--wrapper", "osintverse-community/whois", "https://github.com/alice/whois-plus"); code != 0 {
		t.Fatalf("exit %d: %s", code, out)
	}
	if f.wrapper != "osintverse-community/whois" {
		t.Errorf("wrapper = %q", f.wrapper)
	}
}

func TestImportBulkAndList(t *testing.T) {
	a, _, out := importApp(t, "")
	if code := run(a, "import", "https://github.com/alice/a", "https://gitlab.com/alice/b"); code != 0 {
		t.Fatalf("exit %d: %s", code, out)
	}
	if !strings.Contains(out.String(), "Importing 2 repositories") || !strings.Contains(out.String(), "alice/b") {
		t.Errorf("bulk output: %s", out)
	}
	out.Reset()
	if code := run(a, "import", "--list"); code != 0 || !strings.Contains(out.String(), "needs ethics") {
		t.Errorf("list exit %d: %s", code, out)
	}
	a.API.Token = ""
	if code := run(a, "import", "https://github.com/alice/a"); code != ExitUsage {
		t.Errorf("signed out: want %d, got %d", ExitUsage, code)
	}
}

func toStrings(v []any) []string {
	out := make([]string, len(v))
	for i, s := range v {
		out[i], _ = s.(string)
	}
	return out
}
