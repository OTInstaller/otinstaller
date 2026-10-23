// Package oci reads a container image saved to disk and pushes it to an OCI registry: the registry's own mirror, for
// `ot publish --image`. It reads an OCI image layout (`docker buildx build --output type=oci`, `docker save` on
// Docker 25+, `podman save --format oci-archive`) or an older docker-archive, and uploads blobs in chunks small enough
// for the mirror, a Cloudflare Worker that takes at most 100 MB per request.
package oci

import (
	"archive/tar"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
)

// Media types this package reads and writes.
const (
	MediaIndex        = "application/vnd.oci.image.index.v1+json"
	MediaManifest     = "application/vnd.oci.image.manifest.v1+json"
	MediaConfig       = "application/vnd.oci.image.config.v1+json"
	MediaLayerGzip    = "application/vnd.oci.image.layer.v1.tar+gzip"
	MediaDockerList   = "application/vnd.docker.distribution.manifest.list.v2+json"
	MediaDockerSchema = "application/vnd.docker.distribution.manifest.v2+json"
)

// Descriptor points at a blob or manifest by digest.
type Descriptor struct {
	MediaType   string            `json:"mediaType"`
	Digest      string            `json:"digest"`
	Size        int64             `json:"size"`
	Platform    *Platform         `json:"platform,omitempty"`
	Annotations map[string]string `json:"annotations,omitempty"`
}

// Platform is an index entry's operating system and architecture.
type Platform struct {
	OS           string `json:"os"`
	Architecture string `json:"architecture"`
	Variant      string `json:"variant,omitempty"`
}

func (p *Platform) String() string {
	if p == nil {
		return ""
	}
	return p.OS + "/" + p.Architecture
}

type manifestDoc struct {
	SchemaVersion int          `json:"schemaVersion"`
	MediaType     string       `json:"mediaType,omitempty"`
	Config        *Descriptor  `json:"config,omitempty"`
	Layers        []Descriptor `json:"layers,omitempty"`
	Manifests     []Descriptor `json:"manifests,omitempty"`
}

// Image is an image read from disk: the manifest (or index) to tag, the platform manifests of an index, and the file
// holding each blob they need.
type Image struct {
	Top     []byte
	TopType string
	// Children are an index's platform manifests, in index order.
	Children []Child
	Blobs    map[string]string
	// Platforms the image runs on, such as linux/amd64.
	Platforms []string
}

// Child is one platform manifest of an index.
type Child struct {
	Digest    string
	MediaType string
	Body      []byte
}

// Digest is the image's digest: that of its top manifest or index.
func (img *Image) Digest() string { return digestOf(img.Top) }

// HasPlatform reports whether the image runs on platform ("linux/amd64").
func (img *Image) HasPlatform(platform string) bool {
	for _, p := range img.Platforms {
		if p == platform {
			return true
		}
	}
	return false
}

// Size is the total size of the image's blobs.
func (img *Image) Size() int64 {
	var n int64
	for _, f := range img.Blobs {
		if fi, err := os.Stat(f); err == nil {
			n += fi.Size()
		}
	}
	return n
}

func digestOf(b []byte) string {
	sum := sha256.Sum256(b)
	return "sha256:" + hex.EncodeToString(sum[:])
}

// Read unpacks an image archive (a tar file) into dir and reads it.
func Read(archive, dir string) (*Image, error) {
	if err := untar(archive, dir); err != nil {
		return nil, err
	}
	if _, err := os.Stat(filepath.Join(dir, "index.json")); err == nil {
		return readLayout(dir)
	}
	if _, err := os.Stat(filepath.Join(dir, "manifest.json")); err == nil {
		return readDockerArchive(dir)
	}
	return nil, errors.New("the archive is not an image: it has neither index.json (an OCI layout) nor manifest.json (docker save)")
}

func untar(archive, dir string) error {
	f, err := os.Open(archive)
	if err != nil {
		return err
	}
	defer f.Close()
	tr := tar.NewReader(f)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return fmt.Errorf("reading %s: %w", archive, err)
		}
		name := path.Clean(strings.TrimPrefix(h.Name, "./"))
		if name == "." || strings.HasPrefix(name, "../") || path.IsAbs(name) {
			continue
		}
		target := filepath.Join(dir, filepath.FromSlash(name))
		switch h.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			out, err := os.Create(target)
			if err != nil {
				return err
			}
			if _, err := io.Copy(out, tr); err != nil {
				out.Close()
				return err
			}
			if err := out.Close(); err != nil {
				return err
			}
		}
	}
}

func blobPath(dir, digest string) string {
	return filepath.Join(dir, "blobs", "sha256", strings.TrimPrefix(digest, "sha256:"))
}

func readJSON(file string, v any) ([]byte, error) {
	b, err := os.ReadFile(file)
	if err != nil {
		return nil, err
	}
	return b, json.Unmarshal(b, v)
}

func isIndex(mediaType string) bool { return mediaType == MediaIndex || mediaType == MediaDockerList }

// readLayout reads an OCI image layout. Its index.json names one image: a platform manifest or an index of them.
// Platform manifests whose blobs are missing (`docker save` keeps only the platforms pulled or built here) are left out.
func readLayout(dir string) (*Image, error) {
	var root manifestDoc
	if _, err := readJSON(filepath.Join(dir, "index.json"), &root); err != nil {
		return nil, fmt.Errorf("reading index.json: %w", err)
	}
	if len(root.Manifests) != 1 {
		return nil, fmt.Errorf("the archive holds %d images; save or build one", len(root.Manifests))
	}
	top := root.Manifests[0]
	body, err := os.ReadFile(blobPath(dir, top.Digest))
	if err != nil {
		return nil, fmt.Errorf("the archive lacks %s", top.Digest)
	}
	img := &Image{Top: body, TopType: top.MediaType, Blobs: map[string]string{}}
	if !isIndex(top.MediaType) {
		var m manifestDoc
		if err := json.Unmarshal(body, &m); err != nil {
			return nil, fmt.Errorf("reading the image manifest: %w", err)
		}
		if err := img.addBlobs(dir, m); err != nil {
			return nil, err
		}
		p, err := configPlatform(blobPath(dir, m.Config.Digest))
		if err != nil {
			return nil, err
		}
		img.Platforms = []string{p}
		return img, nil
	}
	var idx manifestDoc
	if err := json.Unmarshal(body, &idx); err != nil {
		return nil, fmt.Errorf("reading the image index: %w", err)
	}
	var kept []Descriptor
	for _, d := range idx.Manifests {
		cb, err := os.ReadFile(blobPath(dir, d.Digest))
		if err != nil {
			continue
		}
		var m manifestDoc
		if json.Unmarshal(cb, &m) != nil || img.addBlobs(dir, m) != nil {
			continue
		}
		kept = append(kept, d)
		img.Children = append(img.Children, Child{Digest: d.Digest, MediaType: d.MediaType, Body: cb})
		if p := d.Platform.String(); p != "" && p != "unknown/unknown" {
			img.Platforms = append(img.Platforms, p)
		}
	}
	if len(kept) == 0 {
		return nil, errors.New("the archive holds none of the image's platforms")
	}
	if len(kept) != len(idx.Manifests) {
		// The index lists platforms the archive doesn't have: push an index of the ones it has.
		raw := map[string]any{}
		_ = json.Unmarshal(body, &raw)
		raw["manifests"] = kept
		if img.Top, err = json.Marshal(raw); err != nil {
			return nil, err
		}
	}
	sort.Strings(img.Platforms)
	return img, nil
}

// addBlobs records the config and layers of one platform manifest, which must all be in the archive.
func (img *Image) addBlobs(dir string, m manifestDoc) error {
	if m.Config == nil {
		return errors.New("a manifest has no config")
	}
	for _, d := range append([]Descriptor{*m.Config}, m.Layers...) {
		p := blobPath(dir, d.Digest)
		if _, err := os.Stat(p); err != nil {
			return fmt.Errorf("the archive lacks %s", d.Digest)
		}
		img.Blobs[d.Digest] = p
	}
	return nil
}

func configPlatform(file string) (string, error) {
	var c struct {
		OS           string `json:"os"`
		Architecture string `json:"architecture"`
	}
	if _, err := readJSON(file, &c); err != nil {
		return "", fmt.Errorf("reading the image config: %w", err)
	}
	return c.OS + "/" + c.Architecture, nil
}

// readDockerArchive reads `docker save` output from before Docker 25: a manifest.json, a config file and uncompressed
// layer tars. The layers are gzipped (the config's diff_ids name the uncompressed layers, so they still match) and an
// OCI manifest is written for them.
func readDockerArchive(dir string) (*Image, error) {
	var entries []struct {
		Config string   `json:"Config"`
		Layers []string `json:"Layers"`
	}
	if _, err := readJSON(filepath.Join(dir, "manifest.json"), &entries); err != nil {
		return nil, fmt.Errorf("reading manifest.json: %w", err)
	}
	if len(entries) != 1 {
		return nil, fmt.Errorf("the archive holds %d images; save one", len(entries))
	}
	e := entries[0]
	img := &Image{Blobs: map[string]string{}}
	cfgFile := filepath.Join(dir, filepath.FromSlash(e.Config))
	cfg, err := os.ReadFile(cfgFile)
	if err != nil {
		return nil, fmt.Errorf("the archive lacks its config %s", e.Config)
	}
	p, err := configPlatform(cfgFile)
	if err != nil {
		return nil, err
	}
	img.Platforms = []string{p}
	m := manifestDoc{SchemaVersion: 2, MediaType: MediaManifest, Config: &Descriptor{MediaType: MediaConfig, Digest: digestOf(cfg), Size: int64(len(cfg))}}
	img.Blobs[m.Config.Digest] = cfgFile
	for i, l := range e.Layers {
		gz := filepath.Join(dir, fmt.Sprintf("layer-%d.tar.gz", i))
		d, size, err := gzipFile(filepath.Join(dir, filepath.FromSlash(l)), gz)
		if err != nil {
			return nil, fmt.Errorf("compressing %s: %w", l, err)
		}
		img.Blobs[d] = gz
		m.Layers = append(m.Layers, Descriptor{MediaType: MediaLayerGzip, Digest: d, Size: size})
	}
	if img.Top, err = json.Marshal(m); err != nil {
		return nil, err
	}
	img.TopType = MediaManifest
	return img, nil
}

func gzipFile(src, dst string) (string, int64, error) {
	in, err := os.Open(src)
	if err != nil {
		return "", 0, err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return "", 0, err
	}
	defer out.Close()
	h := sha256.New()
	counter := &countWriter{w: io.MultiWriter(out, h)}
	zw := gzip.NewWriter(counter)
	if _, err := io.Copy(zw, in); err != nil {
		return "", 0, err
	}
	if err := zw.Close(); err != nil {
		return "", 0, err
	}
	return "sha256:" + hex.EncodeToString(h.Sum(nil)), counter.n, nil
}

type countWriter struct {
	w io.Writer
	n int64
}

func (c *countWriter) Write(p []byte) (int, error) {
	n, err := c.w.Write(p)
	c.n += int64(n)
	return n, err
}
