package main

import (
	"archive/zip"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestBundles(t *testing.T) {
	t.Setenv("OT_HOME", t.TempDir())
	dir := t.TempDir()
	for _, f := range []string{"ot", "ot.exe"} {
		os.WriteFile(filepath.Join(dir, f), []byte("binary "+f), 0o755)
	}
	arts, _ := json.Marshal([]artifact{
		{Name: "ot", Path: filepath.Join(dir, "ot"), Goos: "linux", Goarch: "arm64", Type: "Binary"},
		{Name: "ot.exe", Path: filepath.Join(dir, "ot.exe"), Goos: "windows", Goarch: "amd64", Type: "Binary"},
		{Name: "ot_1.0.0_linux_arm64.tar.gz", Path: "x", Goos: "linux", Goarch: "arm64", Type: "Archive"},
	})
	os.WriteFile(filepath.Join(dir, "artifacts.json"), arts, 0o644)
	out := filepath.Join(dir, "out")
	if err := run("1.0.0", dir, out, "https://example.com/dl", "../../../LICENSE"); err != nil {
		t.Fatal(err)
	}

	zr, err := zip.OpenReader(filepath.Join(out, "ot_1.0.0_windows_amd64.mcpb"))
	if err != nil {
		t.Fatal(err)
	}
	defer zr.Close()
	files := map[string]string{}
	for _, f := range zr.File {
		r, _ := f.Open()
		b, _ := io.ReadAll(r)
		r.Close()
		files[f.Name] = string(b)
	}
	if files["server/ot.exe"] != "binary ot.exe" || !strings.Contains(files["LICENSE"], "Apache License") {
		t.Fatalf("bundle contents: %v", keys(files))
	}
	var m struct {
		ManifestVersion string `json:"manifest_version"`
		Version         string
		Server          struct {
			Type       string
			EntryPoint string `json:"entry_point"`
			MCPConfig  struct {
				Command string
				Args    []string
			} `json:"mcp_config"`
		}
		Compatibility struct{ Platforms []string }
		Tools         []struct{ Name string }
	}
	if err := json.Unmarshal([]byte(files["manifest.json"]), &m); err != nil {
		t.Fatal(err)
	}
	if m.ManifestVersion != "0.3" || m.Version != "1.0.0" || m.Server.Type != "binary" || m.Server.EntryPoint != "server/ot.exe" ||
		m.Server.MCPConfig.Command != "${__dirname}/server/ot.exe" || m.Server.MCPConfig.Args[0] != "mcp" ||
		m.Compatibility.Platforms[0] != "win32" || len(m.Tools) < 20 {
		t.Fatalf("manifest: %+v", m)
	}

	var s struct {
		Name     string
		Packages []struct {
			RegistryType string
			Identifier   string
			FileSha256   string
		}
	}
	b, _ := os.ReadFile(filepath.Join(out, "server.json"))
	json.Unmarshal(b, &s)
	if s.Name != "com.otinstaller/ot" || len(s.Packages) != 2 {
		t.Fatalf("server.json: %s", b)
	}
	for _, p := range s.Packages {
		sum, _ := fileSHA256(filepath.Join(out, filepath.Base(p.Identifier)))
		if p.RegistryType != "mcpb" || p.FileSha256 != sum || !strings.HasPrefix(p.Identifier, "https://example.com/dl/ot_1.0.0_") {
			t.Errorf("package: %+v", p)
		}
	}
}

func keys(m map[string]string) []string {
	var out []string
	for k := range m {
		out = append(out, k)
	}
	return out
}
