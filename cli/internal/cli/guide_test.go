package cli

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/charmbracelet/glamour"

	"github.com/otinstaller/otinstaller/cli/internal/api"
	"github.com/otinstaller/otinstaller/cli/internal/manifest"
	"github.com/otinstaller/otinstaller/cli/internal/state"
)

var guidePages = []struct{ path, title, body string }{
	{"index.md", "Email playbook", "# Email playbook\n\nStart here.\n"},
	{"01-scope.md", "Scope and legal", "# Scope and legal\n\n> [!WARNING]\n> Lawful targets only.\n"},
	{"sub/02-pivot.md", "Pivoting", "# Pivoting\n\nRun `ot run alice/whois-plus`.\n"},
}

// fakeGuideRegistry serves one guide (alice/email-playbook 1.1.0) with three pages, the tool docs of
// alice/whois-plus, and that tool's manifest for installs.
func fakeGuideRegistry(t *testing.T) *httptest.Server {
	t.Helper()
	nav := []map[string]any{}
	for i, p := range guidePages {
		nav = append(nav, map[string]any{"path": p.path, "title": p.title, "words": 3, "dead_links": i % 2})
	}
	raw, err := os.ReadFile(filepath.Join(fixtures, "valid", "docker-tool.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	doc, _, err := manifest.Parse([]byte(strings.ReplaceAll(strings.ReplaceAll(string(raw), "holehe-lite", "whois-plus"), "namespace: dheeraj", "namespace: alice")))
	if err != nil {
		t.Fatal(err)
	}
	page := func(w http.ResponseWriter, ref, wanted string, pages []struct{ path, title, body string }) {
		for i, p := range pages {
			if p.path == wanted || p.path == wanted+".md" || fmt.Sprint(i+1) == wanted {
				out := map[string]any{"ref": ref, "version": "1.1.0", "path": p.path, "title": p.title, "position": i + 1, "pages": len(pages), "format": "md", "body": p.body}
				if i+1 < len(pages) {
					out["next"] = map[string]string{"path": pages[i+1].path, "title": pages[i+1].title}
				}
				json.NewEncoder(w).Encode(out)
				return
			}
		}
		w.WriteHeader(404)
		w.Write([]byte(`{"error":{"code":"page_not_found","message":"` + ref + ` has no page ` + wanted + `"}}`))
	}
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		switch {
		case p == "/v1/guides":
			if r.URL.Query().Get("level") != "intermediate" {
				json.NewEncoder(w).Encode(map[string]any{"results": []any{}})
				return
			}
			json.NewEncoder(w).Encode(map[string]any{"results": []map[string]any{{
				"namespace": "alice", "name": "email-playbook", "kind": "guide", "latest_version": "1.1.0", "summary": "From one email to accounts",
				"title": "Email playbook", "level": "intermediate", "format": "guide", "needs_update": true,
			}}})
		case p == "/v1/guides/alice/email-playbook" || p == "/v1/guides/alice/email-playbook/1.1.0":
			json.NewEncoder(w).Encode(map[string]any{
				"ref": "alice/email-playbook", "version": "1.1.0", "title": "Email playbook", "nav": nav,
				"related_tools": []map[string]any{
					{"ref": "alice/whois-plus", "available": true, "latest_version": "1.2.0", "summary": "WHOIS lookups"},
					{"ref": "gone/old-tool", "available": false},
				},
			})
		case strings.HasPrefix(p, "/v1/guides/alice/email-playbook/") && strings.Contains(p, "/pages/"):
			if r.URL.Query().Get("format") != "md" {
				t.Errorf("pages must be asked for as Markdown, got %s", r.URL.RawQuery)
			}
			page(w, "alice/email-playbook", strings.SplitN(p, "/pages/", 2)[1], guidePages)
		case p == "/v1/tools/alice/whois-plus/docs":
			json.NewEncoder(w).Encode(map[string]any{"ref": "alice/whois-plus", "version": "1.2.0", "nav": []map[string]any{{"path": "usage.md", "title": "Usage"}}})
		case p == "/v1/tools/alice/whois-plus/docs/usage.md" || p == "/v1/tools/alice/whois-plus/docs/1":
			page(w, "alice/whois-plus", "usage.md", []struct{ path, title, body string }{{"usage.md", "Usage", "# Usage\n\nRun it.\n"}})
		case p == "/v1/tools/alice/no-docs/docs/1":
			w.WriteHeader(404)
			w.Write([]byte(`{"error":{"code":"docs_not_found","message":"alice/no-docs ships no docs"}}`))
		case p == "/v1/tools/alice/whois-plus/latest/manifest":
			json.NewEncoder(w).Encode(map[string]any{"ref": "alice/whois-plus", "version": "1.2.0", "status": "published", "verified_publisher": true, "manifest": doc})
		case p == "/v1/guides/alice/broken":
			w.WriteHeader(500)
			w.Write([]byte(`{"error":{"code":"internal_error","message":"Something went wrong on our side.","request_id":"01ABC"}}`))
		case p == "/v1/me":
			w.Header().Set("Cf-Ray", "8f0a-LHR")
			w.WriteHeader(502)
		default:
			w.WriteHeader(404)
		}
	}))
}

func TestGuideSearchAndRead(t *testing.T) {
	srv := fakeGuideRegistry(t)
	defer srv.Close()
	a, out, errb := newTestApp(t, &fakeExec{}, "")
	a.API = api.New(srv.URL+"/v1", "test")

	if code := run(a, "guide", "search", "--level", "intermediate", "email"); code != 0 || !strings.Contains(out.String(), "alice/email-playbook") ||
		!strings.Contains(out.String(), "Email playbook [needs update]") {
		t.Fatalf("search exit %d:\n%s", code, out)
	}
	out.Reset()
	if code := run(a, "guide", "read", "alice/email-playbook"); code != 0 {
		t.Fatalf("read exit %d: %s", code, errb)
	}
	// Output that is not a terminal stays plain Markdown, so it can be piped or saved.
	if out.String() != guidePages[0].body || !strings.Contains(errb.String(), "Page 1 of 3 of alice/email-playbook 1.1.0 · next: ot guide read alice/email-playbook 2 (Scope and legal)") {
		t.Fatalf("read output:\n%s\n%s", out, errb)
	}
	out.Reset()
	errb.Reset()
	if code := run(a, "guide", "read", "alice/email-playbook@1.1.0", "sub/02-pivot"); code != 0 || !strings.Contains(out.String(), "ot run alice/whois-plus") {
		t.Fatalf("read by path exit %d: %s %s", code, out, errb)
	}
	if strings.Contains(errb.String(), "next:") {
		t.Errorf("the last page has no next page: %s", errb)
	}
	out.Reset()
	if code := run(a, "guide", "read", "--list", "alice/email-playbook"); code != 0 || !strings.Contains(out.String(), "  2. Scope and legal (01-scope.md) [1 dead link(s)]") {
		t.Fatalf("list exit %d:\n%s", code, out)
	}
	if code := run(a, "guide", "read", "alice/email-playbook", "9"); code != ExitUsage || !strings.Contains(errb.String(), "has no page 9") {
		t.Fatalf("missing page: exit %d: %s", code, errb)
	}
	if code := run(a, "guide", "read", "./otinstaller.yaml"); code != ExitUsage {
		t.Errorf("a local path is not a guide: exit %d", code)
	}
}

func TestForTerminal(t *testing.T) {
	md := "> [!WARNING]\n> Lawful targets only.\n\n![Map](../img/map.png) ![Badge](https://img.example/b.svg)\n\n" +
		"See [pivoting](02-pivot.md#scope), [home](../index.md), [gone](99-gone.md) and [the spec](https://example.org/spec.md).\n"
	got := forTerminal(md, "sub/01-scope.md", []string{"index.md", "sub/01-scope.md", "sub/02-pivot.md"})
	want := "> **Warning:** \n> Lawful targets only.\n\n(image: Map) [image: Badge](https://img.example/b.svg)\n\n" +
		"See pivoting (page 3), home (page 1), gone and [the spec](https://example.org/spec.md).\n"
	if got != want {
		t.Fatalf("got:\n%s\nwant:\n%s", got, want)
	}
	out := regexp.MustCompile(`\x1b\[[0-9;]*m`).ReplaceAllString(renderWith(got, 80, glamour.WithStandardStyle("dark")), "")
	if !strings.Contains(out, "Warning: Lawful targets only.") || !strings.Contains(out, "(image: Map)") || strings.Contains(out, "**") {
		t.Errorf("rendered:\n%s", out)
	}
}

func TestGuideRenderedForTerminals(t *testing.T) {
	got := renderWith(guidePages[1].body, 60, glamour.WithStandardStyle("notty"))
	if !strings.Contains(got, "Scope and legal") || !strings.Contains(got, "Lawful targets only.") || strings.Contains(got, "> [!WARNING]\n>") {
		t.Fatalf("unexpected rendering:\n%s", got)
	}
}

func TestGuideGetThenReadOffline(t *testing.T) {
	srv := fakeGuideRegistry(t)
	a, out, errb := newTestApp(t, &fakeExec{}, "")
	a.API = api.New(srv.URL+"/v1", "test")
	if code := run(a, "guide", "get", "alice/email-playbook"); code != 0 {
		t.Fatalf("get exit %d: %s", code, errb)
	}
	dir := state.Path("guides", "alice", "email-playbook", "1.1.0")
	if !strings.Contains(out.String(), "(3 pages) to "+dir) {
		t.Fatalf("get output: %s", out)
	}
	if b, err := os.ReadFile(filepath.Join(dir, "sub", "02-pivot.md")); err != nil || string(b) != guidePages[2].body {
		t.Fatalf("saved page: %q %v", b, err)
	}

	// With the registry gone, read falls back to the saved copy.
	srv.Close()
	out.Reset()
	errb.Reset()
	if code := run(a, "guide", "read", "alice/email-playbook", "2"); code != 0 || out.String() != guidePages[1].body {
		t.Fatalf("offline read exit %d:\n%s\n%s", code, out, errb)
	}
	if !strings.Contains(errb.String(), "showing the copy saved by `ot guide get`") {
		t.Errorf("no offline note: %s", errb)
	}
	out.Reset()
	if code := run(a, "guide", "read", "--list", "alice/email-playbook"); code != 0 || !strings.Contains(out.String(), "3. Pivoting") {
		t.Fatalf("offline list exit %d: %s", code, out)
	}
}

func TestGuideTools(t *testing.T) {
	srv := fakeGuideRegistry(t)
	defer srv.Close()
	fx := &fakeExec{}
	a, out, errb := newTestApp(t, fx, "n\n")
	a.API = api.New(srv.URL+"/v1", "test")
	if code := run(a, "guide", "tools", "alice/email-playbook"); code != 0 || !strings.Contains(out.String(), "Nothing installed.") {
		t.Fatalf("declined exit %d: %s %s", code, out, errb)
	}
	if !strings.Contains(out.String(), "gone/old-tool: not in the registry any more, skipped") || !strings.Contains(out.String(), "Install 1 tool(s)? [y/N]") {
		t.Errorf("unexpected listing: %s", out)
	}
	a.In = strings.NewReader("y\n")
	out.Reset()
	if code := run(a, "guide", "tools", "alice/email-playbook"); code != 0 || !strings.Contains(out.String(), "Installed 1 tool(s) from alice/email-playbook.") {
		t.Fatalf("install exit %d: %s %s", code, out, errb)
	}
	if st, _ := state.Load(); st.Installed["alice/whois-plus"] == nil {
		t.Fatal("alice/whois-plus was not recorded as installed")
	}
	out.Reset()
	if code := run(a, "guide", "tools", "-y", "alice/email-playbook"); code != 0 || !strings.Contains(out.String(), "alice/whois-plus: already installed") {
		t.Fatalf("second run exit %d: %s", code, out)
	}
}

func TestGuideOpenAndDocs(t *testing.T) {
	srv := fakeGuideRegistry(t)
	defer srv.Close()
	a, out, errb := newTestApp(t, &fakeExec{}, "")
	a.API = api.New(srv.URL+"/v1", "test")
	var opened []string
	a.OpenURL = func(u string) error { opened = append(opened, u); return nil }
	run(a, "guide", "open", "alice/email-playbook")
	run(a, "guide", "open", "alice/email-playbook", "3")
	want := []string{"https://otinstaller.com/guides/alice/email-playbook", "https://otinstaller.com/guides/alice/email-playbook/latest/sub/02-pivot"}
	if fmt.Sprint(opened) != fmt.Sprint(want) {
		t.Fatalf("opened %v, want %v", opened, want)
	}

	out.Reset()
	if code := run(a, "docs", "alice/whois-plus"); code != 0 || out.String() != "# Usage\n\nRun it.\n" || !strings.Contains(errb.String(), "Page 1 of 1 of the alice/whois-plus 1.1.0 docs") {
		t.Fatalf("docs exit %d:\n%s\n%s", code, out, errb)
	}
	out.Reset()
	if code := run(a, "docs", "--list", "alice/whois-plus"); code != 0 || !strings.Contains(out.String(), "1. Usage (usage.md)") {
		t.Fatalf("docs list exit %d: %s", code, out)
	}
	if code := run(a, "docs", "alice/no-docs"); code != ExitUsage || !strings.Contains(errb.String(), "ships no docs") {
		t.Fatalf("no docs: exit %d: %s", code, errb)
	}
	if code := run(a, "docs", "alice/whois-plus@1.0.0"); code != ExitUsage {
		t.Errorf("docs with a version: exit %d", code)
	}
}

func TestServerErrorsShowRequestID(t *testing.T) {
	srv := fakeGuideRegistry(t)
	defer srv.Close()
	c := api.New(srv.URL+"/v1", "test")
	_, err := c.Guide(t.Context(), "alice", "broken", "")
	if err == nil || !strings.Contains(err.Error(), "Something went wrong on our side. If it keeps happening, report it to support@otinstaller.com with request ID 01ABC.") {
		t.Errorf("registry error: %v", err)
	}
	// Errors without the registry's JSON (from Cloudflare in front of it) carry the ray ID instead.
	_, err = c.Me(t.Context())
	if err == nil || !strings.Contains(err.Error(), "the registry answered 502 Bad Gateway. If it keeps happening, report it to support@otinstaller.com with request ID 8f0a-LHR.") {
		t.Errorf("gateway error: %v", err)
	}
}

func TestValidateGuideContent(t *testing.T) {
	dir := t.TempDir()
	raw, _ := os.ReadFile(filepath.Join(fixtures, "valid", "guide.yaml"))
	os.WriteFile(filepath.Join(dir, "otinstaller.yaml"), raw, 0o644)
	os.MkdirAll(filepath.Join(dir, "docs"), 0o755)
	write := func(name, body string) { os.WriteFile(filepath.Join(dir, "docs", name), []byte(body), 0o644) }
	write("index.md", "# Index\n\n![map](img/map.png) ![photo](img/big.jpg) ![gone](img/gone.webp)\n\n```html\n<script>shown as code</script>\n```\n")
	os.MkdirAll(filepath.Join(dir, "docs", "img"), 0o755)
	os.WriteFile(filepath.Join(dir, "docs", "img", "map.png"), []byte("png"), 0o644)
	os.WriteFile(filepath.Join(dir, "docs", "img", "big.jpg"), make([]byte, 3<<20), 0o644)
	write("01-scope-and-legal.md", "# Scope\n\n<iframe src=\"https://x\"></iframe>\n")
	write("02-passive-checks.md", "# Checks\n\n![anim](img/a.gif)\n\n"+strings.Repeat("word ", 42_000))

	a, out, _ := newTestApp(t, &fakeExec{}, "")
	if code := run(a, "validate", "--json", dir); code != ExitUsage {
		t.Fatalf("want exit %d, got %d: %s", ExitUsage, code, out)
	}
	var res struct {
		Problems []struct{ Code, Path string }
	}
	json.Unmarshal(out.Bytes(), &res)
	var got []string
	for _, p := range res.Problems {
		got = append(got, p.Code+" "+p.Path)
	}
	want := []string{"content_image_too_large docs/img/big.jpg", "manifest_file_missing docs/img/gone.webp", "content_raw_html docs/01-scope-and-legal.md", "content_page_too_large docs/02-passive-checks.md", "content_image_type docs/02-passive-checks.md"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("problems %v, want %v", got, want)
	}
}
