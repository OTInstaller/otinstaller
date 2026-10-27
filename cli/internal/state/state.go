// Package state manages ot's local files: config, installed packages and caches.
package state

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"sort"
	"strings"
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
	Local       bool               `json:"local,omitempty"`       // installed from a local manifest, so its runs are never counted
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

// Config is ~/.ot/config.json. Environment variables override it. `ot start` and `ot telemetry on|off` write it
// (SetConfig), changing only their own keys.
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
	if off, _ := TelemetryOffByEnv(); off {
		f := false
		c.Telemetry = &f
	}
	return c
}

func (c *Config) TelemetryEnabled() bool { return c.Telemetry == nil || *c.Telemetry }

// DoNotTrack reports whether DO_NOT_TRACK (consoledonottrack.com) is set to anything but 0 or false.
func DoNotTrack() bool {
	v := strings.ToLower(strings.TrimSpace(os.Getenv("DO_NOT_TRACK")))
	return v != "" && v != "0" && v != "false"
}

// TelemetryOffByEnv says whether an environment variable turns telemetry off, and which one: OT_NO_TELEMETRY (any
// value) or DO_NOT_TRACK. Either wins over config.json.
func TelemetryOffByEnv() (bool, string) {
	if os.Getenv("OT_NO_TELEMETRY") != "" {
		return true, "OT_NO_TELEMETRY"
	}
	if DoNotTrack() {
		return true, "DO_NOT_TRACK"
	}
	return false, ""
}

// Milestones are the first times that usage counts report once per machine.
var Milestones = []string{"first_install", "first_run", "first_ok_run"}

// Telemetry is <home>/telemetry.json: what ot remembers about counting, apart from the setting itself (config.json's
// telemetry). It has its own file because state.json's fixed temporary file would race with parallel runs.
type Telemetry struct {
	// NoticeShownAt is when the one-time notice about counting was printed (or `ot start` or `ot telemetry` said it).
	NoticeShownAt time.Time `json:"notice_shown_at,omitzero"`
	// UnreachableAt is when counts last couldn't reach the registry; for an hour after it, ot doesn't wait for them.
	UnreachableAt time.Time `json:"unreachable_at,omitzero"`
	// Milestones are the ones reached, each reported once.
	Milestones []string `json:"milestones"`
	// path is where it was read, so it is saved there even if OT_HOME changes meanwhile.
	path string
}

// LoadTelemetry reads telemetry.json, creating it when it is missing or broken. A machine that has packages installed
// when the file is created starts with every milestone reached, so upgrading ot doesn't look like a new person's first
// install and run.
func LoadTelemetry() *Telemetry {
	path := Path("telemetry.json")
	t := &Telemetry{Milestones: []string{}, path: path}
	b, err := os.ReadFile(path)
	if err == nil && json.Unmarshal(b, t) == nil {
		if t.Milestones == nil {
			t.Milestones = []string{}
		}
		return t
	}
	t = &Telemetry{Milestones: []string{}, path: path}
	if st, err := Load(); err != nil || len(st.Installed) > 0 {
		t.Milestones = append(t.Milestones, Milestones...)
	}
	_ = t.Save()
	return t
}

// Reached says whether a milestone was reached.
func (t *Telemetry) Reached(m string) bool { return slices.Contains(t.Milestones, m) }

// Save writes telemetry.json atomically through a temporary file of its own, so two ot processes never mix halves.
func (t *Telemetry) Save() error {
	if t.path == "" {
		t.path = Path("telemetry.json")
	}
	dir := filepath.Dir(t.path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(t, "", "  ")
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, "telemetry-*.tmp")
	if err != nil {
		return err
	}
	_, err = f.Write(append(b, '\n'))
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Rename(f.Name(), t.path)
	}
	if err != nil {
		os.Remove(f.Name())
	}
	return err
}
