// Package api is a client for the OTInstaller Registry API.
package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type Client struct {
	Base      string
	HTTP      *http.Client
	UserAgent string
	// Token is an `ot_` API token from `ot login`; requests are anonymous without it.
	Token string
}

func New(base, version string) *Client {
	return &Client{
		Base:      strings.TrimRight(base, "/"),
		HTTP:      &http.Client{Timeout: 30 * time.Second},
		UserAgent: "ot/" + version,
	}
}

// Error is the registry's error shape: {"error": {"code", "message", "hint", "docs"}}.
type Error struct {
	Status  int    `json:"-"`
	Code    string `json:"code"`
	Message string `json:"message"`
	Hint    string `json:"hint,omitempty"`
	Docs    string `json:"docs,omitempty"`
	// Problems lists what is wrong with a manifest, for errors about one.
	Problems []Problem `json:"problems,omitempty"`
	// RequestID identifies a failed request in the registry's logs (server errors only).
	RequestID string `json:"request_id,omitempty"`
	// Number is the tool request that exists already (request_exists); Ref the package that does (already_in_registry).
	Number int    `json:"number,omitempty"`
	Ref    string `json:"ref,omitempty"`
}

func (e *Error) Error() string {
	s := e.Message
	if e.Hint != "" {
		s += " (" + e.Hint + ")"
	}
	if e.RequestID != "" {
		s += " If it keeps happening, report it to support@otinstaller.com with request ID " + e.RequestID + "."
	}
	return s
}

// UnreachableError means no answer came back from the registry (DNS, TLS, timeout), so a retry may work.
type UnreachableError struct {
	Base string
	Err  error
}

func (e *UnreachableError) Error() string {
	return fmt.Sprintf("cannot reach the registry at %s: %v", e.Base, e.Err)
}
func (e *UnreachableError) Unwrap() error { return e.Err }

type ToolSummary struct {
	Namespace     string   `json:"namespace"`
	Name          string   `json:"name"`
	Kind          string   `json:"kind"`
	Summary       string   `json:"summary"`
	LatestVersion string   `json:"latest_version"`
	Categories    []string `json:"categories"`
	Inputs        []string `json:"inputs"`
	Outputs       []string `json:"outputs"`
	Runtime       string   `json:"runtime"`
	Stars         int      `json:"stars"`
	Installs30d   int      `json:"installs_30d"`
	Health        string   `json:"health"`
	Verified      bool     `json:"verified"`
	Signed        bool     `json:"signed"`
	NeedsKeys     bool     `json:"needs_keys"`
	ManifestHeld  bool     `json:"manifest_held_by_registry"`
	// SourceGone means the source repository is gone, so no new versions will come.
	SourceGone bool   `json:"source_unavailable"`
	Status     string `json:"status"`
	// Tools only: what a run does (from the manifest), so callers can tell which runs need consent.
	Ethics *Ethics `json:"ethics,omitempty"`
	Egress *bool   `json:"egress,omitempty"`
	// Guides only.
	Title       string `json:"title,omitempty"`
	Level       string `json:"level,omitempty"`
	Format      string `json:"format,omitempty"`
	Language    string `json:"language,omitempty"`
	NeedsUpdate bool   `json:"needs_update,omitempty"`
}

// Ethics is the manifest's ethics section as search results carry it.
type Ethics struct {
	TouchesTarget        bool `json:"touches_target"`
	AuthRequired         bool `json:"auth_required"`
	CollectsPersonalData bool `json:"collects_personal_data"`
	// NotifiesTarget is set only when the publisher says.
	NotifiesTarget *bool `json:"notifies_target,omitempty"`
}

type SearchResult struct {
	Results    []ToolSummary `json:"results"`
	NextCursor string        `json:"next_cursor,omitempty"`
	Total      int           `json:"total,omitempty"`
}

type ToolDetail struct {
	ToolSummary
	Homepage      string          `json:"homepage"`
	RepoURL       string          `json:"repo_url"`
	License       string          `json:"license"`
	DeprecatedMsg string          `json:"deprecated_message,omitempty"`
	Replacement   string          `json:"deprecated_replacement,omitempty"`
	CommunityWrap bool            `json:"community_packaged"`
	Manifest      json.RawMessage `json:"manifest"`
	MovedTo       string          `json:"moved_to,omitempty"`
}

// ManifestResponse is what install needs: the manifest plus the trust facts recorded at publish.
type ManifestResponse struct {
	Ref            string          `json:"ref"`
	Version        string          `json:"version"`
	Status         string          `json:"status"`
	RemovedReason  string          `json:"removed_reason,omitempty"`
	SignerIdentity string          `json:"signer_identity,omitempty"`
	SignerIssuer   string          `json:"signer_issuer,omitempty"`
	ScanStatus     string          `json:"scan_status,omitempty"`
	Health         string          `json:"health,omitempty"`
	Verified       bool            `json:"verified_publisher"`
	SourceGone     bool            `json:"source_unavailable"`
	MovedTo        string          `json:"moved_to,omitempty"`
	Manifest       json.RawMessage `json:"manifest"`
	// ManifestFull is the manifest with every field. Manifest leaves out optional fields added since ot v0.12, whose
	// schema rejects them; see registryManifest in the cli package.
	ManifestFull json.RawMessage `json:"manifest_full,omitempty"`
	// Backups the registry keeps, used when the original registry or PyPI refuses the artifact.
	MirrorImage string `json:"mirror_image,omitempty"`
	WheelURL    string `json:"wheel_url,omitempty"`
}

func (c *Client) do(ctx context.Context, method, path string, body any, out any) error {
	var r io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		r = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.Base+path, r)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", c.UserAgent)
	req.Header.Set("Accept", "application/json")
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return &UnreachableError{Base: c.Base, Err: err}
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if resp.StatusCode >= 400 {
		var e struct {
			Error *Error `json:"error"`
		}
		if json.Unmarshal(data, &e) == nil && e.Error != nil {
			e.Error.Status = resp.StatusCode
			return e.Error
		}
		msg := "the registry answered " + resp.Status
		if ray := resp.Header.Get("Cf-Ray"); ray != "" && resp.StatusCode >= 500 {
			return &Error{Status: resp.StatusCode, Code: "http_error", Message: msg + ".", RequestID: ray}
		}
		return &Error{Status: resp.StatusCode, Code: "http_error", Message: msg}
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(data, out)
}

type SearchParams struct {
	Query, Input, Output, Category, Runtime, Kind string
	// Guides only.
	Level, Format, Lang string
	NoKeys              bool
	Limit               int
	// Cursor is a previous page's next_cursor.
	Cursor string
	// PassiveOnly keeps tools that run offline, touch no target and collect no personal data.
	PassiveOnly bool
}

func (c *Client) Search(ctx context.Context, p SearchParams) (*SearchResult, error) {
	q := url.Values{}
	set := func(k, v string) {
		if v != "" {
			q.Set(k, v)
		}
	}
	set("q", p.Query)
	set("input", p.Input)
	set("output", p.Output)
	set("category", p.Category)
	set("runtime", p.Runtime)
	set("kind", p.Kind)
	set("cursor", p.Cursor)
	if p.PassiveOnly {
		q.Set("passive_only", "1")
	}
	if p.NoKeys {
		q.Set("no_keys", "1")
	}
	if p.Limit > 0 {
		q.Set("limit", fmt.Sprint(p.Limit))
	}
	var out SearchResult
	return &out, c.anon().do(ctx, http.MethodGet, "/tools?"+q.Encode(), nil, &out)
}

func (c *Client) Tool(ctx context.Context, ns, name string) (*ToolDetail, error) {
	var out ToolDetail
	return &out, c.anon().do(ctx, http.MethodGet, "/tools/"+url.PathEscape(ns)+"/"+url.PathEscape(name), nil, &out)
}

// Version is one version of a package as GET /tools/:ns/:name/versions lists it, newest first.
type Version struct {
	Version string `json:"version"`
	// Status is published, yanked or removed.
	Status      string `json:"status"`
	ScanStatus  string `json:"scan_status"`
	PublishedAt *int64 `json:"published_at"`
	YankedAt    *int64 `json:"yanked_at"`
	Signed      bool   `json:"signed"`
	// Changelog is the version's release notes in Markdown (the host's release, or its CHANGELOG.md section); nil when
	// the registry has none, or answered before it kept them.
	Changelog       *string `json:"changelog"`
	ChangelogSource string  `json:"changelog_source,omitempty"`
}

func (c *Client) Versions(ctx context.Context, ns, name string) ([]Version, error) {
	var out struct {
		Versions []Version `json:"versions"`
	}
	err := c.anon().do(ctx, http.MethodGet, "/tools/"+url.PathEscape(ns)+"/"+url.PathEscape(name)+"/versions", nil, &out)
	return out.Versions, err
}

func (c *Client) Manifest(ctx context.Context, ns, name, version string) (*ManifestResponse, error) {
	if version == "" {
		version = "latest"
	}
	var out ManifestResponse
	p := "/tools/" + url.PathEscape(ns) + "/" + url.PathEscape(name) + "/" + url.PathEscape(version) + "/manifest"
	return &out, c.anon().do(ctx, http.MethodGet, p, nil, &out)
}

// InstallPing is anonymous: only the package and version are sent.
// InstallPing counts an install anonymously; client is cli, mcp or ci (no identifiers).
func (c *Client) InstallPing(ctx context.Context, ref, version, client string) error {
	return c.anon().do(ctx, http.MethodPost, "/installs", map[string]string{"tool": ref, "version": version, "client": client}, nil)
}

type DeviceStart struct {
	Provider        string `json:"provider"`
	DeviceCode      string `json:"device_code"`
	UserCode        string `json:"user_code"`
	VerificationURI string `json:"verification_uri"`
	Interval        int    `json:"interval"`
	ExpiresIn       int    `json:"expires_in"`
}

type DeviceToken struct {
	Status string   `json:"status"` // ok, pending, slow_down, expired, denied
	Token  string   `json:"token,omitempty"`
	Login  string   `json:"login,omitempty"`
	Scopes []string `json:"scopes,omitempty"`
}

func (c *Client) StartDeviceLogin(ctx context.Context, provider string) (*DeviceStart, error) {
	var out DeviceStart
	return &out, c.anon().do(ctx, http.MethodPost, "/auth/device/start", map[string]string{"provider": provider}, &out)
}

// PollDeviceLogin asks whether a device sign-in was approved. scopes, when given, limit the token it mints.
func (c *Client) PollDeviceLogin(ctx context.Context, provider, deviceCode, tokenName string, scopes ...string) (*DeviceToken, error) {
	var out DeviceToken
	body := map[string]any{"provider": provider, "device_code": deviceCode, "token_name": tokenName}
	if len(scopes) > 0 {
		body["scopes"] = scopes
	}
	return &out, c.anon().do(ctx, http.MethodPost, "/auth/device/token", body, &out)
}

type Me struct {
	Login    string `json:"login"`
	Admin    bool   `json:"admin"`
	Reviewer bool   `json:"reviewer"`
	Accounts []struct {
		Provider string `json:"provider"`
		Login    string `json:"login"`
	} `json:"accounts"`
	Namespaces []struct {
		Name   string `json:"name"`
		Status string `json:"status"`
		Role   string `json:"role"`
	} `json:"namespaces"`
}

func (c *Client) Me(ctx context.Context) (*Me, error) {
	var out Me
	return &out, c.do(ctx, http.MethodGet, "/me", nil, &out)
}

// anon is the client without its token, for public reads: the registry answers them the same either
// way, and anonymous requests can be served from its edge cache.
func (c *Client) anon() *Client {
	cp := *c
	cp.Token = ""
	return &cp
}
