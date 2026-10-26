// Package state manages ot's local files: config, installed packages and caches.
package state

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"time"

	"github.com/otinstaller/otinstaller/cli/internal/manifest"
)

// Home is ot's data directory: $OT_HOME, %APPDATA%\ot on Windows, ~/.ot elsewhere.
func Home() string {
	if h := os.Getenv("OT_HOME"); h != "" {
		return h
	}
	if runtime.GOOS == "windows" {
		if appdata := os.Getenv("APPDATA"); appdata != "" {
			return filepath.Join(appdata, "ot")
		}
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ".ot"
	}
	return filepath.Join(home, ".ot")
}

func Path(parts ...string) string { return filepath.Join(append([]string{Home()}, parts...)...) }

// Installed describes one installed package version.
type Installed struct {
	Ref         string             `json:"ref"`
	Version     string             `json:"version"`
	Runtime     string             `json:"runtime"`
	Artifact    string             `json:"artifact"` // image digest ref or wheel hash
	LocalImage  string             `json:"local_image,omitempty"`
	Native      bool               `json:"native,omitempty"`
	FromBackup  bool               `json:"from_backup,omitempty"` // installed from the registry's mirror or wheel copy
	Signer      string             `json:"signer,omitempty"`      // the cosign identity the image was verified against
	Held        bool               `json:"held,omitempty"`        // installed at an exact version: `ot update --all` leaves it
	InstalledAt time.Time          `json:"installed_at"`
	Manifest    *manifest.Manifest `json:"manifest"`
	ManifestRaw json.RawMessage    `json:"manifest_raw"`
}

type State struct {
	Installed map[string]*Installed `json:"installed"`
}

func Load() (*State, error) {
	s := &State{Installed: map[string]*Installed{}}
	b, err := os.ReadFile(Path("state.json"))
	if errors.Is(err, os.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(b, s); err != nil {
		return nil, err
	}
	if s.Installed == nil {
		s.Installed = map[string]*Installed{}
	}
	return s, nil
}

// Save writes state atomically so a crash never leaves a half-written file.
func (s *State) Save() error {
	if err := os.MkdirAll(Home(), 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	tmp := Path("state.json.tmp")
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, Path("state.json"))
}

func (s *State) Sorted() []*Installed {
	out := make([]*Installed, 0, len(s.Installed))
	for _, i := range s.Installed {
		out = append(out, i)
	}
	sort.Slice(out, func(a, b int) bool { return out[a].Ref < out[b].Ref })
	return out
}

// Config is ~/.ot/config.json. Environment variables override it. Only `ot start` writes it (SetConfig).
type Config struct {
	APIURL    string `json:"api_url,omitempty"`
	SiteURL   string `json:"site_url,omitempty"`
	Telemetry *bool  `json:"telemetry,omitempty"`
	Format    string `json:"format,omitempty"`
	// ResultsDir is where runs are saved when neither --results-dir nor $OT_RESULTS_DIR says.
	ResultsDir string `json:"results_dir,omitempty"`
}

const (
	DefaultAPIURL  = "https://api.otinstaller.com/v1"
	DefaultSiteURL = "https://otinstaller.com"
)

// FileConfig is config.json as written, without environment overrides or defaults: what `ot start` shows and changes.
func FileConfig() *Config {
	c := &Config{}
	if b, err := os.ReadFile(Path("config.json")); err == nil {
		_ = json.Unmarshal(b, c)
	}
	return c
}

// SetConfig changes keys of config.json and keeps the rest, unknown keys included; a nil value removes its key. It
// never writes LoadConfig's result, which has environment overrides and defaults folded in.
func SetConfig(changes map[string]any) error {
	doc := map[string]any{}
	b, err := os.ReadFile(Path("config.json"))
	switch {
	case err == nil:
		if len(b) > 0 {
			if err := json.Unmarshal(b, &doc); err != nil {
				return fmt.Errorf("%s is not valid JSON (%v); fix or remove it first", Path("config.json"), err)
			}
		}
	case !errors.Is(err, os.ErrNotExist):
		return err
	}
	for k, v := range changes {
		if v == nil {
			delete(doc, k)
		} else {
			doc[k] = v
		}
	}
	if err := os.MkdirAll(Home(), 0o700); err != nil {
		return err
	}
	out, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return err
	}
	tmp := Path("config.json.tmp")
	if err := os.WriteFile(tmp, append(out, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, Path("config.json"))
}

func LoadConfig() *Config {
	c := FileConfig()
	if v := os.Getenv("OT_API_URL"); v != "" {
		c.APIURL = v
	}
	if c.APIURL == "" {
		c.APIURL = DefaultAPIURL
	}
	if v := os.Getenv("OT_SITE_URL"); v != "" {
		c.SiteURL = v
	}
	if c.SiteURL == "" {
		c.SiteURL = DefaultSiteURL
	}
	if os.Getenv("OT_NO_TELEMETRY") != "" {
		f := false
		c.Telemetry = &f
	}
	return c
}

func (c *Config) TelemetryEnabled() bool { return c.Telemetry == nil || *c.Telemetry }
