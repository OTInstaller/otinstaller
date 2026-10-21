package api

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

// NavEntry is one page in a guide's or a tool's docs navigation.
type NavEntry struct {
	Path      string `json:"path"`
	Title     string `json:"title"`
	Words     int    `json:"words"`
	DeadLinks int    `json:"dead_links"`
}

// RelatedTool is a tool a guide uses; Available is false when it is not (or no longer) published.
type RelatedTool struct {
	Ref       string `json:"ref"`
	Available bool   `json:"available"`
	Install   string `json:"install,omitempty"`
	Summary   string `json:"summary,omitempty"`
	Version   string `json:"latest_version,omitempty"`
}

type GuideDetail struct {
	ToolSummary
	Ref          string        `json:"ref"`
	Version      string        `json:"version"`
	Title        string        `json:"title"`
	Level        string        `json:"level"`
	Format       string        `json:"format"`
	Language     string        `json:"language"`
	License      string        `json:"license"`
	RepoURL      string        `json:"repo_url"`
	MovedTo      string        `json:"moved_to,omitempty"`
	Nav          []NavEntry    `json:"nav"`
	RelatedTools []RelatedTool `json:"related_tools"`
	Checks       struct {
		NeedsUpdate bool `json:"needs_update"`
		Links       *struct {
			Checked int `json:"checked"`
			Dead    int `json:"dead"`
			Missing int `json:"missing"`
		} `json:"links"`
	} `json:"checks"`
}

type PageRef struct {
	Path  string `json:"path"`
	Title string `json:"title"`
}

// Page is one rendered page; Body is HTML or the author's Markdown, as requested.
type Page struct {
	Ref      string   `json:"ref"`
	Version  string   `json:"version"`
	Path     string   `json:"path"`
	Title    string   `json:"title"`
	Position int      `json:"position"`
	Pages    int      `json:"pages"`
	Format   string   `json:"format"`
	Body     string   `json:"body"`
	Prev     *PageRef `json:"prev"`
	Next     *PageRef `json:"next"`
}

type Docs struct {
	Ref     string     `json:"ref"`
	Version string     `json:"version"`
	Nav     []NavEntry `json:"nav"`
}

func pkgPath(ns, name string) string { return url.PathEscape(ns) + "/" + url.PathEscape(name) }

// pagePath keeps the slashes of a page path inside a guide while escaping each part.
func pagePath(p string) string {
	parts := strings.Split(p, "/")
	for i, s := range parts {
		parts[i] = url.PathEscape(s)
	}
	return strings.Join(parts, "/")
}

func (c *Client) SearchGuides(ctx context.Context, p SearchParams) (*SearchResult, error) {
	q := url.Values{}
	for k, v := range map[string]string{"q": p.Query, "input": p.Input, "category": p.Category, "level": p.Level, "format": p.Format, "lang": p.Lang} {
		if v != "" {
			q.Set(k, v)
		}
	}
	if p.Limit > 0 {
		q.Set("limit", fmt.Sprint(p.Limit))
	}
	var out SearchResult
	return &out, c.anon().do(ctx, http.MethodGet, "/guides?"+q.Encode(), nil, &out)
}

// Guide returns a guide's navigation, related tools and checks; version "" means the latest.
func (c *Client) Guide(ctx context.Context, ns, name, version string) (*GuideDetail, error) {
	p := "/guides/" + pkgPath(ns, name)
	if version != "" {
		p += "/" + url.PathEscape(version)
	}
	var out GuideDetail
	return &out, c.anon().do(ctx, http.MethodGet, p, nil, &out)
}

// GuidePage returns one page by path or 1-based position, as "md" or "html".
func (c *Client) GuidePage(ctx context.Context, ns, name, version, page, format string) (*Page, error) {
	if version == "" {
		version = "latest"
	}
	var out Page
	p := "/guides/" + pkgPath(ns, name) + "/" + url.PathEscape(version) + "/pages/" + pagePath(page) + "?format=" + url.QueryEscape(format)
	return &out, c.anon().do(ctx, http.MethodGet, p, nil, &out)
}

func (c *Client) ToolDocs(ctx context.Context, ns, name string) (*Docs, error) {
	var out Docs
	return &out, c.anon().do(ctx, http.MethodGet, "/tools/"+pkgPath(ns, name)+"/docs", nil, &out)
}

func (c *Client) ToolDocPage(ctx context.Context, ns, name, page, format string) (*Page, error) {
	var out Page
	return &out, c.anon().do(ctx, http.MethodGet, "/tools/"+pkgPath(ns, name)+"/docs/"+pagePath(page)+"?format="+url.QueryEscape(format), nil, &out)
}
