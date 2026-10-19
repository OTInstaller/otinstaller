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
}

func (e *Error) Error() string {
	s := e.Message
	if e.Hint != "" {
		s += " (" + e.Hint + ")"
	}
	return s
}

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
	Status        string   `json:"status"`
}

type SearchResult struct {
	Results    []ToolSummary `json:"results"`
	NextCursor string        `json:"next_cursor,omitempty"`
}

type ToolDetail struct {
	ToolSummary
	Homepage      string          `json:"homepage"`
	RepoURL       string          `json:"repo_url"`
	License       string          `json:"license"`
	DeprecatedMsg string          `json:"deprecated_message,omitempty"`
	ManifestHeld  bool            `json:"manifest_held_by_registry"`
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
	MovedTo        string          `json:"moved_to,omitempty"`
	Manifest       json.RawMessage `json:"manifest"`
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
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return fmt.Errorf("cannot reach the registry at %s: %w", c.Base, err)
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
		return &Error{Status: resp.StatusCode, Code: "http_error", Message: resp.Status}
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(data, out)
}

type SearchParams struct {
	Query, Input, Output, Category, Runtime, Kind string
	NoKeys                                        bool
	Limit                                         int
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
	if p.NoKeys {
		q.Set("no_keys", "1")
	}
	if p.Limit > 0 {
		q.Set("limit", fmt.Sprint(p.Limit))
	}
	var out SearchResult
	return &out, c.do(ctx, http.MethodGet, "/tools?"+q.Encode(), nil, &out)
}

func (c *Client) Tool(ctx context.Context, ns, name string) (*ToolDetail, error) {
	var out ToolDetail
	return &out, c.do(ctx, http.MethodGet, "/tools/"+url.PathEscape(ns)+"/"+url.PathEscape(name), nil, &out)
}

func (c *Client) Manifest(ctx context.Context, ns, name, version string) (*ManifestResponse, error) {
	if version == "" {
		version = "latest"
	}
	var out ManifestResponse
	p := "/tools/" + url.PathEscape(ns) + "/" + url.PathEscape(name) + "/" + url.PathEscape(version) + "/manifest"
	return &out, c.do(ctx, http.MethodGet, p, nil, &out)
}

// InstallPing is anonymous: only the package and version are sent.
func (c *Client) InstallPing(ctx context.Context, ref, version string) error {
	return c.do(ctx, http.MethodPost, "/installs", map[string]string{"tool": ref, "version": version}, nil)
}
