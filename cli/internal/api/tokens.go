package api

import (
	"context"
	"net/http"
	"net/url"
)

// Token is an API token as /me/tokens lists it; the value itself is only ever shown when it is created.
type Token struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	Scopes     []string `json:"scopes"`
	Scoped     bool     `json:"scoped"`
	ExpiresAt  *int64   `json:"expires_at"`
	LastUsedAt *int64   `json:"last_used_at"`
	CreatedAt  int64    `json:"created_at"`
	Current    bool     `json:"current"`
}

// NewToken is a token just created.
type NewToken struct {
	ID        string   `json:"id"`
	Token     string   `json:"token"`
	Scopes    []string `json:"scopes"`
	ExpiresAt *int64   `json:"expires_at"`
}

func (c *Client) Tokens(ctx context.Context) ([]Token, error) {
	var out struct {
		Tokens []Token `json:"tokens"`
	}
	err := c.do(ctx, http.MethodGet, "/me/tokens", nil, &out)
	return out.Tokens, err
}

// CreateToken mints a token with these scopes (none: the registry's default) that expires after days (0: the default).
func (c *Client) CreateToken(ctx context.Context, name string, scopes []string, days int) (*NewToken, error) {
	body := map[string]any{"name": name}
	if len(scopes) > 0 {
		body["scopes"] = scopes
	}
	if days > 0 {
		body["expires_in_days"] = days
	}
	var out NewToken
	return &out, c.do(ctx, http.MethodPost, "/me/tokens", body, &out)
}

func (c *Client) RevokeToken(ctx context.Context, id string) error {
	return c.do(ctx, http.MethodDelete, "/me/tokens/"+url.PathEscape(id), nil, nil)
}
