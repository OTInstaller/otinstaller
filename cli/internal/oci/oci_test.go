package oci

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// writeTar writes files (name → content) to a tar archive in dir.
func writeTar(t *testing.T, dir string, files map[string][]byte) string {
	t.Helper()
	p := filepath.Join(dir, "image.tar")
	f, err := os.Create(p)
	if err != nil {
		t.Fatal(err)
	}
	tw := tar.NewWriter(f)
	for name, b := range files {
		tw.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(b)), Typeflag: tar.TypeReg})
		tw.Write(b)
	}
	tw.Close()
	f.Close()
	return p
}

func mustJSON(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}

// layout builds an OCI layout with one platform manifest per platform; platforms in `missing` are listed in the index
// but their blobs are left out, as `docker save` does for platforms that were never pulled.
func layout(platforms []string, missing map[string]bool) map[string][]byte {
	files := map[string][]byte{"oci-layout": []byte(`{"imageLayoutVersion":"1.0.0"}`)}
	blob := func(b []byte) Descriptor {
		d := Descriptor{Digest: digestOf(b), Size: int64(len(b))}
		files["blobs/sha256/"+strings.TrimPrefix(d.Digest, "sha256:")] = b
		return d
	}
	var children []Descriptor
	for _, p := range platforms {
		os, arch, _ := strings.Cut(p, "/")
		cfg := blob(mustJSON(map[string]string{"os": os, "architecture": arch}))
		cfg.MediaType = MediaConfig
		layer := blob([]byte("layer for " + p + strings.Repeat("x", 40)))
		layer.MediaType = "application/vnd.oci.image.layer.v1.tar"
		m := blob(mustJSON(manifestDoc{SchemaVersion: 2, MediaType: MediaManifest, Config: &cfg, Layers: []Descriptor{layer}}))
		m.MediaType = MediaManifest
		m.Platform = &Platform{OS: os, Architecture: arch}
		if missing[p] {
			for _, d := range []Descriptor{cfg, layer, m} {
				delete(files, "blobs/sha256/"+strings.TrimPrefix(d.Digest, "sha256:"))
			}
		}
		children = append(children, m)
	}
	idx := blob(mustJSON(manifestDoc{SchemaVersion: 2, MediaType: MediaIndex, Manifests: children}))
	idx.MediaType = MediaIndex
	files["index.json"] = mustJSON(manifestDoc{SchemaVersion: 2, Manifests: []Descriptor{idx}})
	return files
}

func TestReadLayoutKeepsThePlatformsTheArchiveHas(t *testing.T) {
	dir := t.TempDir()
	img, err := Read(writeTar(t, dir, layout([]string{"linux/amd64", "linux/arm64"}, nil)), filepath.Join(dir, "x"))
	if err != nil {
		t.Fatal(err)
	}
	if !img.HasPlatform("linux/amd64") || !img.HasPlatform("linux/arm64") || len(img.Children) != 2 || len(img.Blobs) != 4 {
		t.Fatalf("platforms %v, children %d, blobs %d", img.Platforms, len(img.Children), len(img.Blobs))
	}
	original := img.Digest()

	// arm64 was never pulled: the index is rewritten with amd64 only, and gets a new digest.
	dir2 := t.TempDir()
	img2, err := Read(writeTar(t, dir2, layout([]string{"linux/amd64", "linux/arm64"}, map[string]bool{"linux/arm64": true})), filepath.Join(dir2, "x"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(img2.Platforms, ",") != "linux/amd64" || len(img2.Children) != 1 || img2.Digest() == original {
		t.Fatalf("platforms %v, children %d", img2.Platforms, len(img2.Children))
	}
	var idx manifestDoc
	json.Unmarshal(img2.Top, &idx)
	if len(idx.Manifests) != 1 {
		t.Errorf("index still lists %d manifests", len(idx.Manifests))
	}

	// An arm64-only image has no linux/amd64.
	dir3 := t.TempDir()
	img3, _ := Read(writeTar(t, dir3, layout([]string{"linux/arm64"}, nil)), filepath.Join(dir3, "x"))
	if img3.HasPlatform("linux/amd64") {
		t.Error("arm64 image claims amd64")
	}
}

func TestReadDockerArchiveGzipsItsLayers(t *testing.T) {
	dir := t.TempDir()
	layer := []byte("an uncompressed layer tar" + strings.Repeat("y", 100))
	files := map[string][]byte{
		"manifest.json":   mustJSON([]map[string]any{{"Config": "cfg.json", "RepoTags": []string{"tool:latest"}, "Layers": []string{"abc/layer.tar"}}}),
		"cfg.json":        mustJSON(map[string]string{"os": "linux", "architecture": "amd64"}),
		"abc/layer.tar":   layer,
		"../escape/x.txt": []byte("never written"),
	}
	img, err := Read(writeTar(t, dir, files), filepath.Join(dir, "x"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "escape")); err == nil {
		t.Error("an entry escaped the folder")
	}
	var m manifestDoc
	json.Unmarshal(img.Top, &m)
	if img.TopType != MediaManifest || len(m.Layers) != 1 || m.Layers[0].MediaType != MediaLayerGzip || !img.HasPlatform("linux/amd64") {
		t.Fatalf("manifest %s", img.Top)
	}
	gz, _ := os.ReadFile(img.Blobs[m.Layers[0].Digest])
	zr, err := gzip.NewReader(bytes.NewReader(gz))
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := io.ReadAll(zr); !bytes.Equal(got, layer) || digestOf(gz) != m.Layers[0].Digest {
		t.Error("the gzipped layer doesn't hold the original or match its digest")
	}
}

// fakeRegistry is just enough of an OCI registry: a token endpoint, blob uploads in chunks, and manifests.
type fakeRegistry struct {
	mu        sync.Mutex
	blobs     map[string][]byte
	uploads   map[string][]byte
	manifests map[string][]byte
	patches   int
	expire    bool // answer the next authenticated request with 401, as an expired token
}

func (f *fakeRegistry) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if r.URL.Path == "/token" {
		if u, p, ok := r.BasicAuth(); !ok || u != "ot" || p != "ot_secret" || !strings.Contains(r.URL.Query().Get("scope"), ":pull,push") {
			w.WriteHeader(401)
			return
		}
		json.NewEncoder(w).Encode(map[string]string{"token": "push-token"})
		return
	}
	if r.Header.Get("Authorization") != "Bearer push-token" || f.expire {
		f.expire = false
		w.WriteHeader(401)
		return
	}
	path := strings.TrimPrefix(r.URL.Path, "/v2/alice/tool/")
	switch {
	case r.Method == "HEAD" && strings.HasPrefix(path, "blobs/sha256:"):
		if _, ok := f.blobs[strings.TrimPrefix(path, "blobs/")]; ok {
			w.WriteHeader(200)
		} else {
			w.WriteHeader(404)
		}
	case r.Method == "POST" && path == "blobs/uploads/":
		id := "u" + string(rune('a'+len(f.uploads)))
		f.uploads[id] = nil
		w.Header().Set("Location", "/v2/alice/tool/blobs/uploads/"+id)
		w.WriteHeader(202)
	case r.Method == "PATCH" && strings.HasPrefix(path, "blobs/uploads/"):
		id := strings.TrimPrefix(path, "blobs/uploads/")
		b, _ := io.ReadAll(r.Body)
		if r.ContentLength != int64(len(b)) {
			w.WriteHeader(400)
			return
		}
		f.uploads[id] = append(f.uploads[id], b...)
		f.patches++
		w.Header().Set("Location", "/v2/alice/tool/blobs/uploads/"+id)
		w.WriteHeader(202)
	case r.Method == "PUT" && strings.HasPrefix(path, "blobs/uploads/"):
		id := strings.TrimPrefix(path, "blobs/uploads/")
		d := r.URL.Query().Get("digest")
		if digestOf(f.uploads[id]) != d {
			w.WriteHeader(400)
			w.Write([]byte(`{"errors":[{"code":"DIGEST_INVALID","message":"no"}]}`))
			return
		}
		f.blobs[d] = f.uploads[id]
		w.WriteHeader(201)
	case r.Method == "PUT" && strings.HasPrefix(path, "manifests/"):
		b, _ := io.ReadAll(r.Body)
		f.manifests[strings.TrimPrefix(path, "manifests/")] = b
		w.WriteHeader(201)
	default:
		w.WriteHeader(404)
	}
}

func TestPushUploadsInChunksAndTagsTheIndex(t *testing.T) {
	old := ChunkSize
	ChunkSize = 16
	defer func() { ChunkSize = old }()
	fr := &fakeRegistry{blobs: map[string][]byte{}, uploads: map[string][]byte{}, manifests: map[string][]byte{}}
	srv := httptest.NewServer(fr)
	defer srv.Close()
	dir := t.TempDir()
	img, err := Read(writeTar(t, dir, layout([]string{"linux/amd64", "linux/arm64"}, nil)), filepath.Join(dir, "x"))
	if err != nil {
		t.Fatal(err)
	}
	var progress bytes.Buffer
	reg := &Registry{Base: srv.URL, Username: "ot", Password: "ot_secret", Progress: &progress}
	digest, err := reg.Push(context.Background(), "alice/tool", "1.0.0", img)
	if err != nil {
		t.Fatal(err)
	}
	if digest != img.Digest() || len(fr.blobs) != 4 || fr.patches < 4 {
		t.Fatalf("digest %s, %d blobs, %d chunks", digest, len(fr.blobs), fr.patches)
	}
	if !bytes.Equal(fr.manifests["1.0.0"], img.Top) || len(fr.manifests) != 3 {
		t.Errorf("manifests %d", len(fr.manifests))
	}
	if !strings.Contains(progress.String(), "pushing sha256:") {
		t.Errorf("progress %q", progress.String())
	}

	// A second push skips the blobs the registry has, and signs in again when the token expires.
	fr.patches = 0
	fr.expire = true
	if _, err := reg.Push(context.Background(), "alice/tool", "1.0.1", img); err != nil {
		t.Fatal(err)
	}
	if fr.patches != 0 {
		t.Errorf("re-uploaded %d chunks", fr.patches)
	}

	// Wrong credentials are reported.
	bad := &Registry{Base: srv.URL, Username: "ot", Password: "wrong"}
	if _, err := bad.Push(context.Background(), "alice/tool", "1.0.0", img); err == nil || !strings.Contains(err.Error(), "401") {
		t.Errorf("wrong password: %v", err)
	}
}
