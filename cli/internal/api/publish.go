package api

import (
	"bytes"
	"context"
	"mime/multipart"
	"net/http"
	"net/url"
	"path"
	"time"
)

// UploadFile is one file of a release upload: its path relative to otinstaller.yaml and its bytes.
type UploadFile struct {
	Path string
	Data []byte
}

// Upload is the registry's answer to an upload: the publish job that validates, scans and publishes it.
type Upload struct {
	JobID   string `json:"job_id"`
	Status  string `json:"status"`
	Ref     string `json:"ref"`
	Version string `json:"version"`
	URL     string `json:"url"`
	// AlreadyReceived is set when a CI run uploads a release the registry already has from its repository (the
	// GitHub App's webhook got the tag first, or the run is a retry); JobID is then that release's job.
	AlreadyReceived bool `json:"already_received,omitempty"`
}

// CIRun is the CI run an upload came from (trusted publishing).
type CIRun struct {
	Workflow string `json:"workflow"`
	Ref      string `json:"ref"`
	SHA      string `json:"sha"`
	Run      string `json:"run"`
}

// PublishJob is one release attempt: a tag, an upload from CI or a direct upload (Method), and where it stands.
type PublishJob struct {
	ID     string `json:"id"`
	Method string `json:"method"` // tag, ci or direct
	Repo   string `json:"repo"`
	Tag    string `json:"tag"`
	CI     *CIRun `json:"ci,omitempty"`
	// Status is queued, validating, scanning, awaiting_review, published, rejected or error.
	Status        string    `json:"status"`
	Ref           string    `json:"ref,omitempty"`
	Version       string    `json:"version,omitempty"`
	VersionStatus string    `json:"version_status,omitempty"`
	ScanStatus    string    `json:"scan_status,omitempty"`
	ErrorCode     string    `json:"error_code,omitempty"`
	ErrorDetail   string    `json:"error_detail,omitempty"`
	Problems      []Problem `json:"problems"`
	URL           string    `json:"url"`
}

// NewNamespace is a namespace just created on the registry (POST /namespaces).
type NewNamespace struct {
	Name   string `json:"name"`
	Kind   string `json:"kind"`
	Status string `json:"status"`
}

// uploadTimeout allows for a 25 MB upload on a slow connection.
const uploadTimeout = 10 * time.Minute

// Publish uploads a release: the files as multipart/form-data, one part each, named by its path. (A part's filename is
// often cut down to its last segment by parsers; its name never is.)
func (c *Client) Publish(ctx context.Context, ns, name, version string, files []UploadFile) (*Upload, error) {
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	for _, f := range files {
		part, err := w.CreateFormFile(f.Path, path.Base(f.Path))
		if err != nil {
			return nil, err
		}
		if _, err := part.Write(f.Data); err != nil {
			return nil, err
		}
	}
	if err := w.Close(); err != nil {
		return nil, err
	}
	q := url.Values{"namespace": {ns}, "name": {name}, "version": {version}}
	hc := &http.Client{Timeout: uploadTimeout, Transport: c.HTTP.Transport}
	var out Upload
	return &out, c.send(ctx, hc, http.MethodPost, "/publish?"+q.Encode(), w.FormDataContentType(), buf.Bytes(), &out)
}

// PublishJob reads one publish job of a namespace the user belongs to.
func (c *Client) PublishJob(ctx context.Context, id string) (*PublishJob, error) {
	var out PublishJob
	return &out, c.do(ctx, http.MethodGet, "/me/publish-jobs/"+url.PathEscape(id), nil, &out)
}

// CreateNamespace creates a registry namespace owned by the signed-in user; kind is user or org.
func (c *Client) CreateNamespace(ctx context.Context, name, kind string) (*NewNamespace, error) {
	var out NewNamespace
	return &out, c.do(ctx, http.MethodPost, "/namespaces", map[string]string{"name": name, "kind": kind}, &out)
}

// CIToken is the registry's token for a CI run (trusted publishing): it publishes only into Namespace (and Package,
// when set) and expires within the hour.
type CIToken struct {
	Token      string `json:"token"`
	ExpiresAt  int64  `json:"expires_at"`
	Namespace  string `json:"namespace"`
	Package    string `json:"package"`
	Repository string `json:"repository"`
	Workflow   string `json:"workflow"`
}

// ExchangeIDToken trades a CI run's OIDC ID token for a registry token that publishes pkg into ns. It is anonymous:
// the ID token is the credential.
func (c *Client) ExchangeIDToken(ctx context.Context, idToken, ns, pkg string) (*CIToken, error) {
	var out CIToken
	body := map[string]string{"id_token": idToken, "namespace": ns, "package": pkg}
	return &out, c.anon().do(ctx, http.MethodPost, "/auth/oidc/token", body, &out)
}

// TrustedPublisher is a GitHub Actions workflow or GitLab CI pipeline a namespace trusts to publish into it.
type TrustedPublisher struct {
	ID          string `json:"id"`
	Provider    string `json:"provider"`
	Repository  string `json:"repository"`
	Workflow    string `json:"workflow,omitempty"`
	Environment string `json:"environment,omitempty"`
	Package     string `json:"package,omitempty"`
	// Pinned is set once a run has published through it: the repository's id is then recorded.
	Pinned     bool   `json:"pinned"`
	CreatedBy  string `json:"created_by,omitempty"`
	CreatedAt  int64  `json:"created_at"`
	LastUsedAt *int64 `json:"last_used_at"`
}

// TrustedPublishers lists a namespace's trusted publishers (owners only).
func (c *Client) TrustedPublishers(ctx context.Context, ns string) ([]TrustedPublisher, error) {
	var out struct {
		Publishers []TrustedPublisher `json:"publishers"`
	}
	err := c.do(ctx, http.MethodGet, "/me/namespaces/"+url.PathEscape(ns)+"/trusted-publishers", nil, &out)
	return out.Publishers, err
}

// AddTrustedPublisher trusts p's repository (and, when set, its workflow, environment and package) to publish into ns.
func (c *Client) AddTrustedPublisher(ctx context.Context, ns string, p TrustedPublisher) (*TrustedPublisher, error) {
	body := map[string]string{"provider": p.Provider, "repository": p.Repository, "workflow": p.Workflow, "environment": p.Environment, "package": p.Package}
	var out TrustedPublisher
	return &out, c.do(ctx, http.MethodPost, "/me/namespaces/"+url.PathEscape(ns)+"/trusted-publishers", body, &out)
}

// RemoveTrustedPublisher stops trusting a publisher; tokens its runs hold stop working at once.
func (c *Client) RemoveTrustedPublisher(ctx context.Context, ns, id string) error {
	return c.do(ctx, http.MethodDelete, "/me/namespaces/"+url.PathEscape(ns)+"/trusted-publishers/"+url.PathEscape(id), nil, nil)
}
