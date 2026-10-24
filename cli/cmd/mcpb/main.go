// Command mcpb packs ot's release binaries into MCP Bundles (.mcpb), one per platform, and writes the server.json
// for the official MCP Registry that lists them. The release workflow runs it from cli/ after GoReleaser:
//
//	go run ./cmd/mcpb -version 1.4.0 -dist dist -out dist/mcpb -release-url https://github.com/OTInstaller/ot/releases/download/v1.4.0
//
// It reads GoReleaser's dist/artifacts.json, so it packs exactly the binaries that were built and signed. The release
// archives ot self-update relies on are not touched. The bundle format is
// https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md (manifest_version 0.3, a binary server).
package main

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/otinstaller/otinstaller/cli/internal/cli"
)

// artifact is the part of a GoReleaser artifacts.json entry this needs.
type artifact struct {
	Name   string `json:"name"`
	Path   string `json:"path"`
	Goos   string `json:"goos"`
	Goarch string `json:"goarch"`
	Type   string `json:"type"`
}

// mcpbPlatform is the bundle spec's name for an operating system.
var mcpbPlatform = map[string]string{"windows": "win32", "darwin": "darwin", "linux": "linux"}

func main() {
	version := flag.String("version", "", "the release version, without v")
	dist := flag.String("dist", "dist", "GoReleaser's dist folder")
	out := flag.String("out", "dist/mcpb", "where the bundles and server.json go")
	releaseURL := flag.String("release-url", "", "the release's download URL, where the bundles will be uploaded")
	license := flag.String("license", "../LICENSE", "the license file to include")
	flag.Parse()
	if *version == "" || *releaseURL == "" {
		fmt.Fprintln(os.Stderr, "mcpb: -version and -release-url are required")
		os.Exit(2)
	}
	if err := run(*version, *dist, *out, strings.TrimRight(*releaseURL, "/"), *license); err != nil {
		fmt.Fprintln(os.Stderr, "mcpb:", err)
		os.Exit(1)
	}
}

func run(version, dist, out, releaseURL, license string) error {
	b, err := os.ReadFile(filepath.Join(dist, "artifacts.json"))
	if err != nil {
		return err
	}
	var all []artifact
	if err := json.Unmarshal(b, &all); err != nil {
		return fmt.Errorf("artifacts.json: %w", err)
	}
	tools, _, err := cli.DescribeMCP(context.Background())
	if err != nil {
		return err
	}
	if err := os.MkdirAll(out, 0o755); err != nil {
		return err
	}
	var packages []map[string]any
	for _, a := range all {
		if a.Type != "Binary" || a.Name == "" || mcpbPlatform[a.Goos] == "" {
			continue
		}
		name := fmt.Sprintf("ot_%s_%s_%s.mcpb", version, a.Goos, a.Goarch)
		path := filepath.Join(out, name)
		if err := bundle(path, a, version, license, tools); err != nil {
			return fmt.Errorf("%s: %w", name, err)
		}
		sum, err := fileSHA256(path)
		if err != nil {
			return err
		}
		packages = append(packages, map[string]any{
			"registryType": "mcpb",
			"identifier":   releaseURL + "/" + name,
			"version":      version,
			"fileSha256":   sum,
			"transport":    map[string]string{"type": "stdio"},
		})
		fmt.Println(path, sum)
	}
	if len(packages) == 0 {
		return fmt.Errorf("no binaries in %s", filepath.Join(dist, "artifacts.json"))
	}
	sort.Slice(packages, func(i, j int) bool { return packages[i]["identifier"].(string) < packages[j]["identifier"].(string) })
	server := map[string]any{
		"$schema": "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
		"name":    "com.otinstaller/ot",
		"title":   "OTInstaller",
		// The registry refuses descriptions over 100 characters.
		"description": "The OSINT package manager for agents: install and run OSINT tools in a sandbox, with your consent.",
		"version":     version,
		"websiteUrl":  "https://otinstaller.com/docs/agents",
		"repository":  map[string]string{"url": "https://github.com/OTInstaller/otinstaller", "source": "github", "subfolder": "cli"},
		"packages":    packages,
	}
	sj, _ := json.MarshalIndent(server, "", "  ")
	return os.WriteFile(filepath.Join(out, "server.json"), append(sj, '\n'), 0o644)
}

// bundle writes one .mcpb: manifest.json, the binary under server/, and the license.
func bundle(path string, a artifact, version, license string, tools []*mcp.Tool) error {
	exe := "ot"
	if a.Goos == "windows" {
		exe = "ot.exe"
	}
	type named struct {
		Name        string `json:"name"`
		Description string `json:"description,omitempty"`
	}
	var mt []named
	for _, t := range tools {
		mt = append(mt, named{t.Name, t.Description})
	}
	manifest := map[string]any{
		"manifest_version": "0.3",
		"name":             "otinstaller",
		"display_name":     "OTInstaller",
		"version":          version,
		"description":      "The OSINT package manager: search, install and run OSINT tools on your machine, each in a sandbox, asking you before runs that touch a target.",
		"long_description": "OTInstaller is the package manager and largest registry built only for OSINT tools: every tool installs and runs with one call, takes the same typed inputs and returns the same JSON. This bundle runs `ot mcp`: tools run locally in locked-down containers (Docker or Podman must be installed), runs that touch a target, go online or involve a person's identifiers ask you first, and every run is logged on your machine. See https://otinstaller.com/docs/agents.",
		"author":           map[string]string{"name": "OTInstaller Registry", "email": "support@otinstaller.com", "url": "https://otinstaller.com"},
		"homepage":         "https://otinstaller.com",
		"repository":       map[string]string{"type": "git", "url": "https://github.com/OTInstaller/otinstaller.git"},
		"license":          "Apache-2.0",
		"keywords":         []string{"osint", "investigation", "security-research", "threat-intelligence"},
		"privacy_policies": []string{"https://otinstaller.com/policy/privacy"},
		"compatibility":    map[string]any{"platforms": []string{mcpbPlatform[a.Goos]}},
		"server": map[string]any{
			"type":        "binary",
			"entry_point": "server/" + exe,
			"mcp_config":  map[string]any{"command": "${__dirname}/server/" + exe, "args": []string{"mcp"}},
		},
		// The server lists its prompts itself; the manifest's prompts are templates the host would serve instead.
		"tools": mt,
	}
	mj, _ := json.MarshalIndent(manifest, "", "  ")

	f, err := os.Create(path)
	if err != nil {
		return err
	}
	zw := zip.NewWriter(f)
	add := func(name string, mode os.FileMode, r io.Reader) error {
		h := &zip.FileHeader{Name: name, Method: zip.Deflate, Modified: time.Now().UTC()}
		h.SetMode(mode)
		w, err := zw.CreateHeader(h)
		if err != nil {
			return err
		}
		_, err = io.Copy(w, r)
		return err
	}
	if err := add("manifest.json", 0o644, strings.NewReader(string(mj)+"\n")); err != nil {
		return err
	}
	bin, err := os.Open(a.Path)
	if err != nil {
		return err
	}
	defer bin.Close()
	if err := add("server/"+exe, 0o755, bin); err != nil {
		return err
	}
	if lic, err := os.Open(license); err == nil {
		defer lic.Close()
		if err := add("LICENSE", 0o644, lic); err != nil {
			return err
		}
	}
	if err := zw.Close(); err != nil {
		return err
	}
	return f.Close()
}

func fileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
