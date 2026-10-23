package cli

import (
	"archive/tar"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/otinstaller/otinstaller/cli/internal/api"
)

const publishManifest = `schema: 1
name: whois-plus
namespace: alice
version: 1.2.0
summary: WHOIS lookups with registrar and creation dates
readme: README.md
license: MIT
categories: [domain-dns]
inputs:
  - name: domain
    type: domain
    required: true
outputs:
  - type: organization
runtime:
  kind: docker
  image: docker.io/alice/whois-plus@sha256:` + "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" + `
  platforms: [linux/amd64]
  command: ["whois-plus", "{domain}"]
  output_format: json
ethics:
  touches_target: false
  auth_required: false
  collects_personal_data: false
`

// publishDir writes a package with a README that shows two images, plus images and folders that never upload.
func publishDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	write := func(rel string, data []byte) {
		p := filepath.Join(dir, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, data, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("otinstaller.yaml", []byte(publishManifest))
	write("README.md", []byte("# whois-plus\n\n![shot](img/shot.png)\n\n<img src=\"logo.svg\" alt=\"logo\">\n"))
	write("img/shot.png", []byte("\x89PNG\r\n\x1a\nshot"))
	write("logo.svg", []byte("<svg xmlns='http://www.w3.org/2000/svg'/>"))
	write("node_modules/pkg/icon.png", []byte("\x89PNG"))
	write(".github/banner.png", []byte("\x89PNG"))
	write("main.py", []byte("print('hi')\n"))
	return dir
}

type fakePublish struct {
	files    map[string]string
	query    string
	statuses []string // returned in turn by GET /me/publish-jobs/:id; the last one repeats
	polls    int
	job      map[string]any
}

func (f *fakePublish) server(t *testing.T) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer ot_t" {
			w.WriteHeader(401)
			w.Write([]byte(`{"error":{"code":"unauthenticated","message":"sign in first"}}`))
			return
		}
		switch {
		case r.Method == "POST" && r.URL.Path == "/v1/publish":
			f.query = r.URL.RawQuery
			if err := r.ParseMultipartForm(32 << 20); err != nil {
				t.Errorf("not multipart: %v", err)
			}
			f.files = map[string]string{}
			for name, fhs := range r.MultipartForm.File {
				rd, _ := fhs[0].Open()
				b, _ := io.ReadAll(rd)
				f.files[name] = string(b)
			}
			w.WriteHeader(202)
			json.NewEncoder(w).Encode(map[string]any{"job_id": "job1", "status": "queued", "ref": "alice/whois-plus", "version": "1.2.0", "url": "https://otinstaller.com/dashboard/publish/job1"})
		case r.Method == "GET" && r.URL.Path == "/v1/me/publish-jobs/job1":
			i := f.polls
			if i >= len(f.statuses) {
				i = len(f.statuses) - 1
			}
			f.polls++
			job := map[string]any{"id": "job1", "method": "direct", "status": f.statuses[i], "ref": "alice/whois-plus", "version": "1.2.0", "problems": []any{},
				"url": "https://otinstaller.com/dashboard/publish/job1"}
			for k, v := range f.job {
				job[k] = v
			}
			json.NewEncoder(w).Encode(job)
		default:
			w.WriteHeader(404)
		}
	}))
}

func publishApp(t *testing.T, f *fakePublish) (*App, *strings.Builder, *strings.Builder) {
	t.Helper()
	old := pollSleep
	pollSleep = func(context.Context, time.Duration) error { return nil }
	t.Cleanup(func() { pollSleep = old })
	srv := f.server(t)
	t.Cleanup(srv.Close)
	a, out, errb := newTestApp(t, &fakeExec{}, "")
	a.API = api.New(srv.URL+"/v1", "test")
	a.API.Token = "ot_t"
	o, e := &strings.Builder{}, &strings.Builder{}
	a.Out, a.Err = io.MultiWriter(out, o), io.MultiWriter(errb, e)
	return a, o, e
}

func TestPublishUploadsTheManifestPagesAndImages(t *testing.T) {
	dir := publishDir(t)
	f := &fakePublish{statuses: []string{"validating", "scanning"}}
	a, out, errb := publishApp(t, f)
	if code := run(a, "publish", dir); code != 0 {
		t.Fatalf("exit %d: %s %s", code, out, errb)
	}
	var paths []string
	for p := range f.files {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	if got := strings.Join(paths, ","); got != "README.md,img/shot.png,logo.svg,otinstaller.yaml" {
		t.Errorf("uploaded %s", got)
	}
	if f.query != "name=whois-plus&namespace=alice&version=1.2.0" {
		t.Errorf("query %s", f.query)
	}
	if !strings.Contains(f.files["otinstaller.yaml"], "name: whois-plus") {
		t.Errorf("manifest not uploaded as otinstaller.yaml")
	}
	// By default ot stops once validation is over.
	if !strings.Contains(out.String(), "checks are running") || !strings.Contains(errb.String(), "validating the manifest") {
		t.Errorf("out %q err %q", out, errb)
	}
}

func TestPublishWaitsForTheOutcome(t *testing.T) {
	f := &fakePublish{statuses: []string{"queued", "validating", "scanning", "scanning", "published"}}
	a, out, errb := publishApp(t, f)
	if code := run(a, "publish", "--wait", publishDir(t)); code != 0 {
		t.Fatalf("exit %d: %s", code, errb)
	}
	if !strings.Contains(out.String(), "Published alice/whois-plus 1.2.0") || !strings.Contains(out.String(), "ot install alice/whois-plus") {
		t.Errorf("out: %s", out)
	}
}

func TestPublishReportsRejections(t *testing.T) {
	// Refused while validating: the manifest's problems, exit 2.
	f := &fakePublish{statuses: []string{"rejected"}, job: map[string]any{"error_code": "artifact_image_not_found",
		"problems": []map[string]any{{"code": "artifact_image_not_found", "path": "/runtime/image", "message": "the image is not public"}}}}
	a, _, errb := publishApp(t, f)
	if code := run(a, "publish", publishDir(t)); code != ExitUsage || !strings.Contains(errb.String(), "the image is not public") {
		t.Fatalf("exit %d: %s", code, errb)
	}
	// Refused by a check: exit 1, with the code in the JSON error.
	f = &fakePublish{statuses: []string{"scanning", "rejected"}, job: map[string]any{"error_code": "signature_mismatch", "error_detail": "signed by someone else"}}
	a, out, errb := publishApp(t, f)
	if code := run(a, "--json", "publish", "--wait", publishDir(t)); code != ExitToolError {
		t.Fatalf("exit %d: %s", code, errb)
	}
	if !strings.Contains(out.String(), `"status": "rejected"`) || !strings.Contains(errb.String(), `"code":"signature_mismatch"`) {
		t.Errorf("out %s err %s", out, errb)
	}
}

func TestPublishChecksBeforeUploading(t *testing.T) {
	f := &fakePublish{statuses: []string{"queued"}}
	a, out, errb := publishApp(t, f)
	// A dry run lists the files and needs no sign-in.
	a.API.Token = ""
	if code := run(a, "publish", "--dry-run", publishDir(t)); code != 0 || !strings.Contains(out.String(), "would upload 4 files") {
		t.Fatalf("dry run exit %d: %s %s", code, out, errb)
	}
	if code := run(a, "publish", publishDir(t)); code != ExitUsage || !strings.Contains(errb.String(), "ot login") {
		t.Fatalf("signed out: exit %d: %s", code, errb)
	}
	a.API.Token = "ot_t"
	bad := publishDir(t)
	os.WriteFile(filepath.Join(bad, "otinstaller.yaml"), []byte(strings.Replace(publishManifest, "version: 1.2.0", "version: v1", 1)), 0o644)
	if code := run(a, "publish", bad); code != ExitUsage || !strings.Contains(errb.String(), "manifest_version_invalid") {
		t.Fatalf("invalid manifest: exit %d: %s", code, errb)
	}
	if f.files != nil {
		t.Errorf("uploaded despite problems: %v", f.files)
	}
}

// ociArchive writes a one-platform OCI image layout tar, as `docker buildx build --output type=oci` does.
func ociArchive(t *testing.T, arch string) string {
	t.Helper()
	files := map[string][]byte{}
	put := func(b []byte) (string, int) {
		sum := sha256.Sum256(b)
		d := "sha256:" + hex.EncodeToString(sum[:])
		files["blobs/sha256/"+hex.EncodeToString(sum[:])] = b
		return d, len(b)
	}
	cfgD, cfgN := put([]byte(`{"os":"linux","architecture":"` + arch + `"}`))
	layD, layN := put([]byte("a layer"))
	man, _ := json.Marshal(map[string]any{"schemaVersion": 2, "mediaType": "application/vnd.oci.image.manifest.v1+json",
		"config": map[string]any{"mediaType": "application/vnd.oci.image.config.v1+json", "digest": cfgD, "size": cfgN},
		"layers": []any{map[string]any{"mediaType": "application/vnd.oci.image.layer.v1.tar", "digest": layD, "size": layN}}})
	manD, manN := put(man)
	files["index.json"], _ = json.Marshal(map[string]any{"schemaVersion": 2, "manifests": []any{
		map[string]any{"mediaType": "application/vnd.oci.image.manifest.v1+json", "digest": manD, "size": manN}}})
	p := filepath.Join(t.TempDir(), "image.tar")
	f, _ := os.Create(p)
	tw := tar.NewWriter(f)
	for name, b := range files {
		tw.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(b)), Typeflag: tar.TypeReg})
		tw.Write(b)
	}
	tw.Close()
	f.Close()
	return p
}

// mirrorPaths adds a minimal OCI registry to a fake registry server: /token, blob uploads and manifests.
func mirrorPaths(t *testing.T, next http.Handler) (http.Handler, *map[string][]byte) {
	manifests := map[string][]byte{}
	uploads := map[string][]byte{}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/token":
			if u, p, _ := r.BasicAuth(); u != "ot" || p != "ot_t" {
				w.WriteHeader(401)
				return
			}
			w.Write([]byte(`{"token":"pt"}`))
		case strings.HasPrefix(r.URL.Path, "/v2/"):
			if r.Header.Get("Authorization") != "Bearer pt" {
				w.WriteHeader(401)
				return
			}
			rest := strings.TrimPrefix(r.URL.Path, "/v2/alice/whois-plus/")
			switch {
			case r.Method == "HEAD":
				w.WriteHeader(404)
			case r.Method == "POST":
				w.Header().Set("Location", "/v2/alice/whois-plus/blobs/uploads/u1")
				w.WriteHeader(202)
			case r.Method == "PATCH":
				b, _ := io.ReadAll(r.Body)
				uploads["u1"] = append(uploads["u1"], b...)
				w.Header().Set("Location", r.URL.Path)
				w.WriteHeader(202)
			case r.Method == "PUT" && strings.HasPrefix(rest, "blobs/"):
				uploads["u1"] = nil
				w.WriteHeader(201)
			case r.Method == "PUT":
				b, _ := io.ReadAll(r.Body)
				manifests[strings.TrimPrefix(rest, "manifests/")] = b
				w.WriteHeader(201)
			}
		default:
			next.ServeHTTP(w, r)
		}
	}), &manifests
}

func TestPublishHostsTheImageOnTheMirror(t *testing.T) {
	dir := publishDir(t)
	f := &fakePublish{statuses: []string{"scanning"}}
	a, out, errb := publishApp(t, f)
	apiSrv := f.server(t)
	defer apiSrv.Close()
	handler, manifests := mirrorPaths(t, apiSrv.Config.Handler)
	srv := httptest.NewServer(handler)
	defer srv.Close()
	a.API.Base = srv.URL + "/v1"
	t.Setenv("OT_MIRROR_URL", srv.URL)

	if code := run(a, "publish", "--image-archive", ociArchive(t, "amd64"), dir); code != 0 {
		t.Fatalf("exit %d: %s %s", code, out, errb)
	}
	host := strings.TrimPrefix(srv.URL, "http://")
	pinned := regexp.MustCompile(`image: ` + regexp.QuoteMeta(host) + `/alice/whois-plus@sha256:[0-9a-f]{64}`)
	if !pinned.MatchString(f.files["otinstaller.yaml"]) {
		t.Errorf("uploaded manifest:\n%s", f.files["otinstaller.yaml"])
	}
	if disk, _ := os.ReadFile(filepath.Join(dir, "otinstaller.yaml")); !pinned.Match(disk) {
		t.Errorf("otinstaller.yaml was not pinned:\n%s", disk)
	}
	if _, ok := (*manifests)["1.2.0"]; !ok {
		t.Errorf("the image was not tagged with the version: %v", *manifests)
	}
	if !strings.Contains(errb.String(), "not signed") {
		t.Errorf("no unsigned note: %s", errb)
	}

	// An arm64-only image is refused before anything is pushed or uploaded.
	f.files = nil
	if code := run(a, "publish", "--image-archive", ociArchive(t, "arm64"), publishDir(t)); code != ExitUsage || !strings.Contains(errb.String(), "linux/amd64") {
		t.Fatalf("arm64: exit %d: %s", code, errb)
	}
	if f.files != nil {
		t.Error("uploaded an arm64-only release")
	}
	// The flags are for Docker tools, and --sign signs only what ot pushes.
	if code := run(a, "publish", "--sign", publishDir(t)); code != ExitUsage {
		t.Errorf("--sign alone: exit %d", code)
	}
}

// cosignExec records how cosign is run, and what DOCKER_CONFIG it was given.
type cosignExec struct {
	fakeExec
	args   []string
	config string
}

func (c *cosignExec) Run(ctx context.Context, name string, args, env []string, stdin io.Reader, stdout, stderr io.Writer) (int, error) {
	if name == "cosign" {
		c.args = args
		for _, e := range env {
			if dir, ok := strings.CutPrefix(e, "DOCKER_CONFIG="); ok {
				b, _ := os.ReadFile(filepath.Join(dir, "config.json"))
				c.config = string(b)
			}
		}
		return 0, nil
	}
	return c.fakeExec.Run(ctx, name, args, env, stdin, stdout, stderr)
}

func TestPublishSignsWithoutPuttingTheTokenInArgv(t *testing.T) {
	f := &fakePublish{statuses: []string{"scanning"}}
	a, out, errb := publishApp(t, f)
	ce := &cosignExec{}
	a.Runner.Exec = ce
	apiSrv := f.server(t)
	defer apiSrv.Close()
	handler, _ := mirrorPaths(t, apiSrv.Config.Handler)
	srv := httptest.NewServer(handler)
	defer srv.Close()
	a.API.Base = srv.URL + "/v1"
	t.Setenv("OT_MIRROR_URL", srv.URL)
	if code := run(a, "publish", "--image-archive", ociArchive(t, "amd64"), "--sign", publishDir(t)); code != 0 {
		t.Fatalf("exit %d: %s %s", code, out, errb)
	}
	if len(ce.args) < 3 || ce.args[0] != "sign" || !strings.Contains(strings.Join(ce.args, " "), "--allow-http-registry") || strings.Contains(strings.Join(ce.args, " "), "ot_t") {
		t.Errorf("cosign args %v", ce.args)
	}
	if !strings.Contains(ce.config, base64.StdEncoding.EncodeToString([]byte("ot:ot_t"))) {
		t.Errorf("DOCKER_CONFIG %s", ce.config)
	}
}

func TestNamespaceCreate(t *testing.T) {
	var body map[string]string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || r.URL.Path != "/v1/namespaces" {
			w.WriteHeader(404)
			return
		}
		json.NewDecoder(r.Body).Decode(&body)
		if body["name"] == "taken" {
			w.WriteHeader(409)
			w.Write([]byte(`{"error":{"code":"namespace_taken","message":"taken is already a namespace","hint":"pick another name"}}`))
			return
		}
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(map[string]string{"name": body["name"], "kind": body["kind"], "status": "pending_review"})
	}))
	defer srv.Close()
	a, out, errb := newTestApp(t, &fakeExec{}, "")
	a.API = api.New(srv.URL+"/v1", "test")
	if code := run(a, "namespace", "create", "acme"); code != ExitUsage {
		t.Fatalf("signed out: exit %d", code)
	}
	a.API.Token = "ot_t"
	if code := run(a, "namespace", "create", "--org", "acme"); code != 0 || !strings.Contains(out.String(), "namespace: acme") || body["kind"] != "org" {
		t.Fatalf("exit %d: %s %v", code, out, body)
	}
	if code := run(a, "namespace", "create", "taken"); code != ExitUsage || !strings.Contains(errb.String(), "pick another name") {
		t.Fatalf("taken: exit %d: %s", code, errb)
	}
}
