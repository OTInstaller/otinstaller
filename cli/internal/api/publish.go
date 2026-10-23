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
}

// PublishJob is one release attempt: a tag, an upload from CI or a direct upload (Method), and where it stands.
type PublishJob struct {
	ID     string `json:"id"`
	Method string `json:"method"` // tag, ci or direct
	Repo   string `json:"repo"`
	Tag    string `json:"tag"`
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
