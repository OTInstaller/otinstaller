package api

import (
	"context"
	"net/http"
	"net/url"
)

// ShareCreated is the registry's answer to a share: the link, until when it works, and the token that deletes it.
type ShareCreated struct {
	ID          string   `json:"id"`
	URL         string   `json:"url"`
	CreatedAt   int64    `json:"created_at"`
	ExpiresAt   int64    `json:"expires_at"`
	DeleteToken string   `json:"delete_token"`
	Owned       bool     `json:"owned"`
	Runs        int      `json:"runs"`
	Tools       []string `json:"tools"`
}

// MyShare is one of the signed-in person's shares that still work.
type MyShare struct {
	ID        string   `json:"id"`
	URL       string   `json:"url"`
	Source    string   `json:"source"`
	RunCount  int      `json:"run_count"`
	Tools     []string `json:"tools"`
	Bytes     int64    `json:"bytes"`
	CreatedAt int64    `json:"created_at"`
	ExpiresAt int64    `json:"expires_at"`
}

// CreateShare uploads a share-v1 body. Signed in, the share is linked to the account (only its owner sees that);
// anonymous leaves the token out so it isn't.
func (c *Client) CreateShare(ctx context.Context, body []byte, anonymous bool) (*ShareCreated, error) {
	cl := c
	if anonymous {
		cl = c.anon()
	}
	var out ShareCreated
	return &out, cl.send(ctx, cl.HTTP, http.MethodPost, "/shares", "application/json", body, &out)
}

// MyShares lists the signed-in person's shares that still work.
func (c *Client) MyShares(ctx context.Context) ([]MyShare, error) {
	var out struct {
		Shares []MyShare `json:"shares"`
	}
	return out.Shares, c.do(ctx, http.MethodGet, "/me/shares", nil, &out)
}

// DeleteShare deletes a share with its delete token, or, without one, as its signed-in owner.
func (c *Client) DeleteShare(ctx context.Context, id, deleteToken string) error {
	path := "/shares/" + url.PathEscape(id)
	if deleteToken != "" {
		return c.anon().do(ctx, http.MethodDelete, path, map[string]string{"delete_token": deleteToken}, nil)
	}
	return c.do(ctx, http.MethodDelete, path, nil, nil)
}
