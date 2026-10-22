package api

import (
	"context"
	"net/http"
	"net/url"
)

// Social is a link on a publisher's profile; Provider is x, linkedin, mastodon, bluesky, other...
type Social struct {
	Provider string `json:"provider"`
	URL      string `json:"url"`
}

// ProfileHost is a GitHub or GitLab account shown on a profile. Primary is the account the namespace belongs to.
type ProfileHost struct {
	Provider string `json:"provider"`
	Login    string `json:"login"`
	URL      string `json:"url"`
	Primary  bool   `json:"primary"`
}

// Profile is what a publisher's page shows about them, after the owner's overrides.
type Profile struct {
	Bio      string        `json:"bio,omitempty"`
	Location string        `json:"location,omitempty"`
	Website  string        `json:"website,omitempty"`
	Company  string        `json:"company,omitempty"`
	Socials  []Social      `json:"socials"`
	Hosts    []ProfileHost `json:"hosts"`
	Members  []struct {
		Login string `json:"login"`
		URL   string `json:"url"`
	} `json:"members"`
	AboutHTML     string   `json:"about_html,omitempty"`
	Pins          []string `json:"pins"`
	DetailsHidden bool     `json:"details_hidden"`
	HostSince     int64    `json:"host_since,omitempty"`
}

// NamespaceStats are the numbers at the top of a profile.
type NamespaceStats struct {
	Packages        int   `json:"packages"`
	Tools           int   `json:"tools"`
	Guides          int   `json:"guides"`
	Installs30d     int   `json:"installs_30d"`
	InstallsTotal   int   `json:"installs_total"`
	Stars           int   `json:"stars"`
	Healthy         int   `json:"healthy"`
	Broken          int   `json:"broken"`
	LastPublishedAt int64 `json:"last_published_at,omitempty"`
}

// Namespace is a publisher's public profile (GET /namespaces/:ns).
type Namespace struct {
	Name        string          `json:"name"`
	Kind        string          `json:"kind"`
	Provider    string          `json:"provider"`
	Status      string          `json:"status"`
	DisplayName string          `json:"display_name"`
	AvatarURL   string          `json:"avatar_url,omitempty"`
	Verified    bool            `json:"verified"`
	CreatedAt   int64           `json:"created_at"`
	Profile     *Profile        `json:"profile,omitempty"`
	Stats       *NamespaceStats `json:"stats,omitempty"`
	Tools       []ToolSummary   `json:"tools"`
}

// Namespace reads a publisher's public profile.
func (c *Client) Namespace(ctx context.Context, ns string) (*Namespace, error) {
	var out Namespace
	return &out, c.anon().do(ctx, http.MethodGet, "/namespaces/"+url.PathEscape(ns), nil, &out)
}

// ProfileSettings is the owner's view of a profile: host values, overrides and sync state.
type ProfileSettings struct {
	Namespace struct {
		Name     string `json:"name"`
		Provider string `json:"provider"`
		Status   string `json:"status"`
	} `json:"namespace"`
	Custom      map[string]any `json:"custom"`
	Effective   Profile        `json:"effective"`
	AboutMD     string         `json:"about_md,omitempty"`
	Pins        []string       `json:"pins"`
	HideDetails bool           `json:"hide_details"`
	Sync        struct {
		Status   string `json:"status"`
		Error    string `json:"error,omitempty"`
		SyncedAt int64  `json:"synced_at,omitempty"`
	} `json:"sync"`
	Hosts []ProfileHost `json:"hosts"`
}

func profilePath(ns string) string { return "/me/namespaces/" + url.PathEscape(ns) + "/profile" }

// ProfileSettings reads the owner's view of a namespace's profile.
func (c *Client) ProfileSettings(ctx context.Context, ns string) (*ProfileSettings, error) {
	var out ProfileSettings
	return &out, c.do(ctx, http.MethodGet, profilePath(ns), nil, &out)
}

// UpdateProfile sends {custom, about, pins, hide_details}; a nil custom value goes back to the host value.
func (c *Client) UpdateProfile(ctx context.Context, ns string, body map[string]any) (*ProfileSettings, error) {
	var out ProfileSettings
	return &out, c.do(ctx, http.MethodPatch, profilePath(ns), body, &out)
}

// SyncProfile refreshes a profile from GitHub and GitLab now.
func (c *Client) SyncProfile(ctx context.Context, ns string) (*ProfileSettings, error) {
	var out ProfileSettings
	return &out, c.do(ctx, http.MethodPost, profilePath(ns)+"/sync", map[string]any{}, &out)
}
