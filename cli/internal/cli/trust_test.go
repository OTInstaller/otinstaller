package cli

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/otinstaller/otinstaller/cli/internal/api"
	"github.com/otinstaller/otinstaller/cli/internal/selfupdate"
	"github.com/otinstaller/otinstaller/cli/internal/state"
)

// fakeTrustRegistry answers the week 10 endpoints and records what was posted.
func fakeTrustRegistry(t *testing.T, posted *[]string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		*posted = append(*posted, r.Method+" "+r.URL.Path+" "+string(body))
		switch {
		case r.URL.Path == "/v1/removed":
			w.Write([]byte(`{"removed":[{"ref":"alice/bad-tool","version":"1.0.0","category":"malware","removed_at":1792400000000}]}`))
		case r.URL.Path == "/v1/tools/alice/gone/latest/manifest":
			w.WriteHeader(410)
			w.Write([]byte(`{"error":{"code":"tool_removed","message":"alice/gone was removed from the registry (policy) on 2026-10-20"}}`))
		case r.URL.Path == "/v1/tools/alice/whois-plus/reports":
			w.WriteHeader(201)
			w.Write([]byte(`{"id":"r1","status":"open","note":"Thank you."}`))
		case r.URL.Path == "/v1/tools/osintverse-community/sherlock/claim":
			w.WriteHeader(201)
			w.Write([]byte(`{"id":"t1","kind":"claim","status":"pending","ref":"osintverse-community/sherlock","to":"sherlock-project",
				"verification_error":"your GitHub account is not an admin of sherlock-project/sherlock","claim_token":"otclaim_abc",
				"instructions":"commit .otinstaller-claim"}`))
		case r.URL.Path == "/v1/transfers/t1/verify":
			w.Write([]byte(`{"id":"t1","kind":"claim","status":"verified","verification":"claim_file","ref":"osintverse-community/sherlock","to":"sherlock-project"}`))
		case r.URL.Path == "/v1/tools/alice/whois-plus/transfer":
			w.WriteHeader(201)
			w.Write([]byte(`{"id":"t2","kind":"transfer","status":"pending","ref":"alice/whois-plus","from":"alice","to":"bob"}`))
		case r.URL.Path == "/v1/transfers/t2/decline":
			w.Write([]byte(`{"id":"t2","status":"declined"}`))
		case strings.HasSuffix(r.URL.Path, "/yank") || strings.HasSuffix(r.URL.Path, "/deprecate"):
			w.Write([]byte(`{}`))
		default:
			w.WriteHeader(404)
		}
	}))
}

func TestReportClaimTransfer(t *testing.T) {
	var posted []string
	srv := fakeTrustRegistry(t, &posted)
	defer srv.Close()
	a, out, errb := newTestApp(t, &fakeExec{}, "")
	a.API = api.New(srv.URL+"/v1", "test")
	var opened []string
	a.OpenURL = func(u string) error { opened = append(opened, u); return nil }

	run(a, "report", "alice/whois-plus@1.2.0")
	if len(opened) != 1 || opened[0] != "https://otinstaller.com/alice/whois-plus/report?v=1.2.0" {
		t.Fatalf("report form: %v", opened)
	}
	if code := run(a, "report", "alice/whois-plus", "--reason", "malware", "--details", "uploads keys"); code != 0 || !strings.Contains(out.String(), "Report r1 filed") {
		t.Fatalf("report exit %d: %s %s", code, out, errb)
	}
	if !strings.Contains(strings.Join(posted, "\n"), `POST /v1/tools/alice/whois-plus/reports {"details":"uploads keys","reason":"malware"}`) {
		t.Errorf("report body: %v", posted)
	}

	if code := run(a, "claim", "osintverse-community/sherlock"); code != ExitUsage {
		t.Errorf("claim signed out: exit %d", code)
	}
	a.API.Token = "ot_t"
	out.Reset()
	if code := run(a, "claim", "osintverse-community/sherlock", "--to", "sherlock-project"); code != 0 {
		t.Fatalf("claim exit %d: %s", code, errb)
	}
	for _, want := range []string{"Claim t1: osintverse-community/sherlock → sherlock-project (pending)", "Claim token (shown once): otclaim_abc", "ot claim --verify t1"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("claim output lacks %q:\n%s", want, out)
		}
	}
	out.Reset()
	if code := run(a, "claim", "--verify", "t1"); code != 0 || !strings.Contains(out.String(), "(verified)") || !strings.Contains(out.String(), "Verified by claim file") {
		t.Fatalf("verify exit %d: %s", code, out)
	}
	out.Reset()
	if code := run(a, "transfer", "alice/whois-plus", "--to", "bob"); code != 0 || !strings.Contains(out.String(), "Transfer t2: alice/whois-plus → bob (pending)") {
		t.Fatalf("transfer exit %d: %s", code, out)
	}
	out.Reset()
	if code := run(a, "transfer", "--decline", "t2"); code != 0 || !strings.Contains(out.String(), "Declined t2.") {
		t.Fatalf("decline exit %d: %s", code, out)
	}
	if code := run(a, "yank", "alice/whois-plus"); code != ExitUsage {
		t.Errorf("yank without a version: exit %d", code)
	}
	if code := run(a, "yank", "alice/whois-plus@1.2.0"); code != 0 {
		t.Errorf("yank exit %d: %s", code, errb)
	}
	if code := run(a, "deprecate", "alice/whois-plus", "--message", "use v2", "--replacement", "alice/whois-plus-2"); code != 0 {
		t.Errorf("deprecate exit %d: %s", code, errb)
	}
	all := strings.Join(posted, "\n")
	for _, want := range []string{"POST /v1/tools/alice/whois-plus/1.2.0/yank", `POST /v1/tools/alice/whois-plus/deprecate {"message":"use v2","replacement":"alice/whois-plus-2"}`} {
		if !strings.Contains(all, want) {
			t.Errorf("missing request %q in %v", want, posted)
		}
	}
}

func TestRemovedPackages(t *testing.T) {
	var posted []string
	srv := fakeTrustRegistry(t, &posted)
	defer srv.Close()
	a, _, errb := newTestApp(t, &fakeExec{}, "")
	a.API = api.New(srv.URL+"/v1", "test")
	a.CheckRemovals = true

	// A whole package removed: install says so and refuses with the trust exit code.
	if code := run(a, "install", "alice/gone"); code != ExitTrust || !strings.Contains(errb.String(), "alice/gone was removed from the registry (policy)") {
		t.Fatalf("install removed: exit %d: %s", code, errb)
	}

	// An installed version removed later: a warning on any command, and run refuses it.
	st, _ := state.Load()
	st.Installed["alice/bad-tool"] = &state.Installed{Ref: "alice/bad-tool", Version: "1.0.0", Runtime: "docker", InstalledAt: time.Now()}
	if err := st.Save(); err != nil {
		t.Fatal(err)
	}
	errb.Reset()
	run(a, "list")
	if !strings.Contains(errb.String(), "warning: alice/bad-tool@1.0.0 was removed from the registry (malware)") {
		t.Fatalf("no removal warning: %s", errb)
	}
	errb.Reset()
	if code := run(a, "run", "alice/bad-tool", "--domain", "example.com"); code != ExitTrust || !strings.Contains(errb.String(), "remove it with `ot uninstall alice/bad-tool`") {
		t.Fatalf("run removed: exit %d: %s", code, errb)
	}
	// The list is cached, so a day's commands ask the registry once.
	n := 0
	for _, p := range posted {
		if strings.HasPrefix(p, "GET /v1/removed") {
			n++
		}
	}
	if n != 1 {
		t.Errorf("fetched the removal list %d times", n)
	}
}

// release builds a signed fake release of ot for this platform.
func release(t *testing.T, version string, bin []byte, key ed25519.PrivateKey, tamper bool) *httptest.Server {
	t.Helper()
	u := &selfupdate.Updater{OS: "linux", Arch: "amd64"}
	name := u.ArchiveName(version)
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	tw.WriteHeader(&tar.Header{Name: "ot", Mode: 0o755, Size: int64(len(bin)), Typeflag: tar.TypeReg})
	tw.Write(bin)
	tw.Close()
	gz.Close()
	archive := buf.Bytes()
	sum := sha256.Sum256(archive)
	sums := []byte(fmt.Sprintf("%s  %s\n", hex.EncodeToString(sum[:]), name))
	sig := ed25519.Sign(key, sums)
	if tamper {
		archive = append(archive, 0)
	}
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// As get.otinstaller.com/ot/latest and github.com's release downloads answer.
		if file, ok := strings.CutPrefix(r.URL.Path, "/"+selfupdate.Repo+"/releases/download/"+version+"/"); ok {
			r.URL.Path = map[string]string{"checksums.txt": "/sums", "checksums.txt.sig": "/sig", name: "/archive"}[file]
		}
		switch r.URL.Path {
		case "/ot/latest":
			json.NewEncoder(w).Encode(map[string]string{"version": version})
		case "/repos/" + selfupdate.Repo + "/releases/latest":
			json.NewEncoder(w).Encode(map[string]any{"tag_name": version, "assets": []map[string]string{
				{"name": "checksums.txt", "browser_download_url": srv.URL + "/sums"},
				{"name": "checksums.txt.sig", "browser_download_url": srv.URL + "/sig"},
				{"name": name, "browser_download_url": srv.URL + "/archive"},
			}})
		case "/sums":
			w.Write(sums)
		case "/sig":
			w.Write(sig)
		case "/archive":
			w.Write(archive)
		}
	}))
	return srv
}

func TestSelfUpdate(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	_, otherPriv, _ := ed25519.GenerateKey(rand.Reader)
	old := Version
	Version = "v1.0.0"
	defer func() { Version = old }()

	for _, tc := range []struct {
		name    string
		key     ed25519.PrivateKey
		tamper  bool
		version string
		code    int
		want    string
	}{
		{"updates", priv, false, "v1.1.0", 0, "Updated ot from v1.0.0 to v1.1.0."},
		{"already latest", priv, false, "v1.0.0", 0, "ot v1.0.0 is the latest release."},
		{"wrong key", otherPriv, false, "v1.1.0", ExitTrust, "not signed by the ot release key"},
		{"tampered archive", priv, true, "v1.1.0", ExitTrust, "does not match its signed checksum"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := release(t, tc.version, []byte("new ot binary"), tc.key, tc.tamper)
			defer srv.Close()
			a, out, errb := newTestApp(t, &fakeExec{}, "")
			a.Updater = &selfupdate.Updater{HTTP: srv.Client(), API: srv.URL, Key: pub, OS: "linux", Arch: "amd64"}
			a.SelfPath = filepath.Join(t.TempDir(), "ot")
			os.WriteFile(a.SelfPath, []byte("old ot binary"), 0o755)
			code := run(a, "self-update")
			if code != tc.code || !strings.Contains(out.String()+errb.String(), tc.want) {
				t.Fatalf("exit %d, want %d with %q:\n%s%s", code, tc.code, tc.want, out, errb)
			}
			got, _ := os.ReadFile(a.SelfPath)
			if want := map[bool]string{true: "new ot binary", false: "old ot binary"}[tc.name == "updates"]; string(got) != want {
				t.Errorf("binary is %q, want %q", got, want)
			}
		})
	}
	if !selfupdate.Newer("v1.10.0", "v1.9.9") || selfupdate.Newer("v1.0.0-rc.1", "v1.0.0") || !selfupdate.Newer("v1.0.0", "v1.0.0-rc.1") {
		t.Error("version ordering")
	}
}

// Asked through get.otinstaller.com, the release still has to carry the release key's signature, and an older
// version is never installed over a newer one.
func TestSelfUpdateViaLatestURL(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	_, otherPriv, _ := ed25519.GenerateKey(rand.Reader)
	old := Version
	Version = "v1.0.0"
	defer func() { Version = old }()
	for _, tc := range []struct {
		name, version string
		key           ed25519.PrivateKey
		code          int
		want          string
	}{
		{"updates", "v1.1.0", priv, 0, "Updated ot from v1.0.0 to v1.1.0."},
		{"no downgrade", "v0.9.0", priv, 0, "ot v1.0.0 is the latest release."},
		{"wrong key", "v1.1.0", otherPriv, ExitTrust, "not signed by the ot release key"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := release(t, tc.version, []byte("new ot binary"), tc.key, false)
			defer srv.Close()
			a, out, errb := newTestApp(t, &fakeExec{}, "")
			// The GitHub API isn't there: only the latest URL and the downloads are.
			a.Updater = &selfupdate.Updater{HTTP: srv.Client(), API: "http://127.0.0.1:9", LatestURL: srv.URL + "/ot/latest", Downloads: srv.URL,
				Key: pub, OS: "linux", Arch: "amd64"}
			a.SelfPath = filepath.Join(t.TempDir(), "ot")
			os.WriteFile(a.SelfPath, []byte("old ot binary"), 0o755)
			if code := run(a, "self-update"); code != tc.code || !strings.Contains(out.String()+errb.String(), tc.want) {
				t.Fatalf("exit %d, want %d with %q:\n%s%s", code, tc.code, tc.want, out, errb)
			}
		})
	}
}

// `ot outdated` notes a newer ot, looked up at most once a day, and never for dev builds, agents, CI or
// OT_NO_UPDATE_CHECK=1.
func TestNewerOTNote(t *testing.T) {
	asked := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		asked++
		w.Write([]byte(`{"version":"v1.1.0"}`))
	}))
	defer srv.Close()
	old := Version
	defer func() { Version = old }()
	a, _, errb := newTestApp(t, &fakeExec{}, "")
	t.Setenv("CI", "")
	t.Setenv("OT_NO_UPDATE_CHECK", "")
	a.Updater = &selfupdate.Updater{HTTP: srv.Client(), API: "http://127.0.0.1:9", LatestURL: srv.URL, Downloads: srv.URL}
	const note = "note: ot v1.1.0 is out (you have v1.0.0); `ot self-update` installs it"

	for _, c := range []struct {
		name, version, env string
		agent              bool
		want               bool
		asks               int
	}{
		{"dev build", "dev", "", false, false, 0},
		{"switched off", "v1.0.0", "OT_NO_UPDATE_CHECK", false, false, 0},
		{"CI", "v1.0.0", "CI", false, false, 0},
		{"agent", "v1.0.0", "", true, false, 0},
		{"newer out", "v1.0.0", "", false, true, 1},
		{"cached for a day", "v1.0.0", "", false, true, 1},
		{"already the newest", "v1.1.0", "", false, false, 1},
	} {
		Version, a.AgentMode = c.version, c.agent
		if c.env != "" {
			t.Setenv(c.env, "1")
		}
		errb.Reset()
		if code := run(a, "outdated"); code != 0 {
			t.Fatalf("%s: exit %d: %s", c.name, code, errb)
		}
		if strings.Contains(errb.String(), note) != c.want || asked != c.asks {
			t.Errorf("%s: asked %d times, stderr: %s", c.name, asked, errb)
		}
		if c.env != "" {
			t.Setenv(c.env, "")
		}
	}
	// The cache is per day: an old one is looked up again.
	os.WriteFile(state.Path("cache", "ot-latest.json"), []byte(`{"checked_at":"2020-01-01T00:00:00Z","version":"v0.1.0"}`), 0o644)
	Version = "v1.0.0"
	errb.Reset()
	run(a, "outdated")
	if asked != 2 || !strings.Contains(errb.String(), note) {
		t.Errorf("stale cache: asked %d times: %s", asked, errb)
	}
}
