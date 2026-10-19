package api

import (
	"context"
	"net/http"
	"net/url"
)

// Problem is one thing wrong with a draft manifest, in the same shape `ot validate --json` prints.
type Problem struct {
	Code    string `json:"code"`
	Path    string `json:"path,omitempty"`
	Message string `json:"message"`
	Hint    string `json:"hint,omitempty"`
}

// Import is an import-wizard draft: what detection found, the draft manifest and what it still needs.
type Import struct {
	ID               string         `json:"id"`
	BatchID          string         `json:"batch_id,omitempty"`
	Community        bool           `json:"community"`
	WrapperRepo      string         `json:"wrapper_repo,omitempty"`
	Provider         string         `json:"provider"`
	Repo             string         `json:"repo"`
	URL              string         `json:"url"`
	Status           string         `json:"status"` // detecting, draft, ready, finished, failed
	Error            *Error         `json:"error,omitempty"`
	Namespace        string         `json:"namespace"`
	DetectedKind     string         `json:"detected_kind"`
	Signals          []string       `json:"signals"`
	Assumed          []string       `json:"assumed"`
	Warnings         []string       `json:"warnings"`
	ExistingManifest bool           `json:"existing_manifest"`
	InstallURL       string         `json:"install_url,omitempty"`
	CanHoldManifest  bool           `json:"can_hold_manifest"`
	FinishModes      []string       `json:"finish_modes"`
	Draft            map[string]any `json:"draft"`
	DraftYAML        string         `json:"draft_yaml"`
	Problems         []Problem      `json:"problems"`
	Missing          []string       `json:"missing"`
	Suggested        []string       `json:"suggested"`
	FinishMode       string         `json:"finish_mode,omitempty"`
	PRURL            string         `json:"pr_url,omitempty"`
	QueuedTag        string         `json:"queued_tag,omitempty"`
	Package          *struct {
		Ref       string `json:"ref"`
		Published bool   `json:"published"`
	} `json:"package,omitempty"`
}

type ImportBatch struct {
	BatchID string   `json:"batch_id"`
	Imports []Import `json:"imports"`
}

// StartImport detects one repository (a GitHub or GitLab URL) and returns its draft.
func (c *Client) StartImport(ctx context.Context, repo string) (*Import, error) {
	var out Import
	return &out, c.do(ctx, http.MethodPost, "/imports", map[string]any{"repo": repo}, &out)
}

// StartImports queues up to 50 repositories; detection runs in the background. With community set they
// are packaged as community wrappers.
func (c *Client) StartImports(ctx context.Context, repos []string, community bool) (*ImportBatch, error) {
	var out ImportBatch
	return &out, c.do(ctx, http.MethodPost, "/imports", map[string]any{"repos": repos, "community": community}, &out)
}

func (c *Client) Import(ctx context.Context, id string) (*Import, error) {
	var out Import
	return &out, c.do(ctx, http.MethodGet, "/imports/"+url.PathEscape(id), nil, &out)
}

func (c *Client) Imports(ctx context.Context) ([]Import, error) {
	var out struct {
		Imports []Import `json:"imports"`
	}
	return out.Imports, c.do(ctx, http.MethodGet, "/imports", nil, &out)
}

// EditImport changes the draft: {"manifest": partial} merges top-level keys, {"yaml": text} replaces it,
// {"kind": "docker"|"pipx"|"guide"} rebuilds it for another kind.
func (c *Client) EditImport(ctx context.Context, id string, change map[string]any) (*Import, error) {
	var out Import
	return &out, c.do(ctx, http.MethodPatch, "/imports/"+url.PathEscape(id), change, &out)
}

// FinishImport opens a pull/merge request ("pr"), keeps the manifest on the registry ("registry"), or
// connects a repository that already has otinstaller.yaml ("connect").
func (c *Client) FinishImport(ctx context.Context, id, mode string) (*Import, error) {
	var out Import
	return &out, c.do(ctx, http.MethodPost, "/imports/"+url.PathEscape(id)+"/finish", map[string]string{"mode": mode}, &out)
}

// StartCommunityImport packages someone else's repository as a community wrapper (osintverse-community admins).
func (c *Client) StartCommunityImport(ctx context.Context, repo string) (*Import, error) {
	var out Import
	return &out, c.do(ctx, http.MethodPost, "/imports", map[string]any{"repo": repo, "community": true}, &out)
}

// FinishWrapper finishes a community import with a pull/merge request in the wrapper repository.
func (c *Client) FinishWrapper(ctx context.Context, id, wrapperRepo string) (*Import, error) {
	var out Import
	body := map[string]string{"mode": "wrapper", "wrapper_repo": wrapperRepo}
	return &out, c.do(ctx, http.MethodPost, "/imports/"+url.PathEscape(id)+"/finish", body, &out)
}

// SyncResult is what a manual sync found.
type SyncResult struct {
	Status string   `json:"status"` // ok, archived, unarchived, unavailable, transfer_pending, paused, error
	Queued []string `json:"queued"`
}

// Sync checks a package's source repository now (at most 10 times an hour per package).
func (c *Client) Sync(ctx context.Context, ns, name string) (*SyncResult, error) {
	var out SyncResult
	return &out, c.do(ctx, http.MethodPost, "/packages/"+url.PathEscape(ns)+"/"+url.PathEscape(name)+"/sync", nil, &out)
}

type SyncLog struct {
	Source struct {
		Provider     string `json:"provider"`
		Path         string `json:"path"`
		URL          string `json:"url"`
		SyncStatus   string `json:"sync_status"`
		LastError    string `json:"last_error"`
		LastEventAt  int64  `json:"last_event_at"`
		LastPollAt   int64  `json:"last_poll_at"`
		ManifestMode string `json:"manifest_mode"`
	} `json:"source"`
	Events []struct {
		Kind       string `json:"kind"`
		Summary    string `json:"summary"`
		Status     string `json:"status"`
		Error      string `json:"error"`
		ReceivedAt int64  `json:"received_at"`
	} `json:"events"`
}

// SyncLog returns a package's sync status and its last 50 sync events.
func (c *Client) SyncLog(ctx context.Context, ns, name string) (*SyncLog, error) {
	var out SyncLog
	return &out, c.do(ctx, http.MethodGet, "/packages/"+url.PathEscape(ns)+"/"+url.PathEscape(name)+"/sync-log", nil, &out)
}
