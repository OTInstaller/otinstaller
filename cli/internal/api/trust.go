package api

import (
	"context"
	"net/http"
	"net/url"
)

// RemovedEntry is a removed package (Version empty) or version, from the transparency list.
type RemovedEntry struct {
	Ref       string `json:"ref"`
	Version   string `json:"version"`
	Category  string `json:"category"`
	RemovedAt int64  `json:"removed_at"`
}

type Removed struct {
	Removed []RemovedEntry `json:"removed"`
}

func (c *Client) Removed(ctx context.Context) (*Removed, error) {
	var out Removed
	return &out, c.anon().do(ctx, http.MethodGet, "/removed", nil, &out)
}

type ReportResult struct {
	ID   string `json:"id"`
	Note string `json:"note"`
}

func (c *Client) Report(ctx context.Context, ns, name, version, reason, details string) (*ReportResult, error) {
	var out ReportResult
	body := map[string]string{"reason": reason, "details": details}
	if version != "" {
		body["version"] = version
	}
	return &out, c.do(ctx, http.MethodPost, "/tools/"+pkgPath(ns, name)+"/reports", body, &out)
}

// Transfer is a claim or transfer as the people involved see it.
type Transfer struct {
	ID                string `json:"id"`
	Kind              string `json:"kind"`
	Status            string `json:"status"`
	Ref               string `json:"ref"`
	From              string `json:"from"`
	To                string `json:"to"`
	UpstreamURL       string `json:"upstream_url,omitempty"`
	Verification      string `json:"verification,omitempty"`
	VerificationError string `json:"verification_error,omitempty"`
	ClaimFile         string `json:"claim_file,omitempty"`
	ClaimToken        string `json:"claim_token,omitempty"`
	Instructions      string `json:"instructions,omitempty"`
}

func (c *Client) Claim(ctx context.Context, ns, name, to string) (*Transfer, error) {
	var out Transfer
	body := map[string]string{}
	if to != "" {
		body["to"] = to
	}
	return &out, c.do(ctx, http.MethodPost, "/tools/"+pkgPath(ns, name)+"/claim", body, &out)
}

func (c *Client) OfferTransfer(ctx context.Context, ns, name, to string) (*Transfer, error) {
	var out Transfer
	return &out, c.do(ctx, http.MethodPost, "/tools/"+pkgPath(ns, name)+"/transfer", map[string]string{"to": to}, &out)
}

// TransferAction is verify, accept or decline.
func (c *Client) TransferAction(ctx context.Context, id, action string) (*Transfer, error) {
	var out Transfer
	return &out, c.do(ctx, http.MethodPost, "/transfers/"+url.PathEscape(id)+"/"+action, map[string]string{}, &out)
}

func (c *Client) Yank(ctx context.Context, ns, name, version string, undo bool) error {
	action := "yank"
	if undo {
		action = "unyank"
	}
	return c.do(ctx, http.MethodPost, "/tools/"+pkgPath(ns, name)+"/"+url.PathEscape(version)+"/"+action, map[string]string{}, nil)
}

func (c *Client) Deprecate(ctx context.Context, ns, name, message, replacement string) error {
	return c.do(ctx, http.MethodPost, "/tools/"+pkgPath(ns, name)+"/deprecate", map[string]string{"message": message, "replacement": replacement}, nil)
}

func (c *Client) Undeprecate(ctx context.Context, ns, name string) error {
	return c.do(ctx, http.MethodDelete, "/tools/"+pkgPath(ns, name)+"/deprecate", nil, nil)
}

type FeedbackResult struct {
	ID   string `json:"id"`
	Note string `json:"note"`
}

// Feedback sends beta feedback; it is linked to the account when the client has a token.
func (c *Client) Feedback(ctx context.Context, kind, message, email, about, client string) (*FeedbackResult, error) {
	var out FeedbackResult
	body := map[string]string{"kind": kind, "message": message, "source": "cli", "client": client}
	if email != "" {
		body["email"] = email
	}
	if about != "" {
		body["page"] = about
	}
	return &out, c.do(ctx, http.MethodPost, "/feedback", body, &out)
}
