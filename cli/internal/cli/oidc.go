package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// ciAudience is the audience the registry accepts on CI ID tokens (trusted publishing).
const ciAudience = "otinstaller"

// ciIDTokenOffered reports whether this looks like a CI job that can hand out an ID token for the registry: a GitHub
// Actions job with `permissions: id-token: write`, or a GitLab CI job whose `id_tokens:` sets OTINSTALLER_ID_TOKEN.
func ciIDTokenOffered() bool {
	return os.Getenv("ACTIONS_ID_TOKEN_REQUEST_URL") != "" || os.Getenv("OTINSTALLER_ID_TOKEN") != ""
}

// ciIDToken gets this CI job's OIDC ID token for the registry. GitHub Actions hands one out over HTTP for the audience
// asked for; GitLab CI puts the one the job's `id_tokens:` declares in OTINSTALLER_ID_TOKEN.
func ciIDToken(ctx context.Context) (string, error) {
	if t := strings.TrimSpace(os.Getenv("OTINSTALLER_ID_TOKEN")); t != "" {
		return t, nil
	}
	reqURL, reqToken := os.Getenv("ACTIONS_ID_TOKEN_REQUEST_URL"), os.Getenv("ACTIONS_ID_TOKEN_REQUEST_TOKEN")
	if reqURL == "" || reqToken == "" {
		hint := "in GitLab CI, add `id_tokens: {OTINSTALLER_ID_TOKEN: {aud: otinstaller}}` to the job"
		if os.Getenv("GITHUB_ACTIONS") == "true" {
			hint = "give the job `permissions: id-token: write`"
		}
		return "", &ExitError{Code: ExitUsage, Reason: "oidc_token_invalid", Err: fmt.Errorf("--oidc needs an ID token from the CI, and this job has none"), Hint: hint}
	}
	u, err := url.Parse(reqURL)
	if err != nil {
		return "", fmt.Errorf("ACTIONS_ID_TOKEN_REQUEST_URL is not a URL: %w", err)
	}
	q := u.Query()
	q.Set("audience", ciAudience)
	u.RawQuery = q.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "bearer "+reqToken)
	req.Header.Set("Accept", "application/json")
	res, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		return "", fmt.Errorf("asking GitHub Actions for an ID token: %w", err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 64<<10))
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("GitHub Actions refused an ID token: %s %s", res.Status, strings.TrimSpace(string(body)))
	}
	var out struct {
		Value string `json:"value"`
	}
	if err := json.Unmarshal(body, &out); err != nil || out.Value == "" {
		return "", fmt.Errorf("GitHub Actions returned no ID token")
	}
	return out.Value, nil
}

// useCIToken trades the CI's ID token for a registry token that publishes pkg into ns, and uses it from now on (for
// the upload, any image push and following the job).
func (a *App) useCIToken(ctx context.Context, ns, pkg string) error {
	id, err := ciIDToken(ctx)
	if err != nil {
		return err
	}
	t, err := a.API.ExchangeIDToken(ctx, id, ns, pkg)
	if err != nil {
		return a.requestError(err)
	}
	a.API.Token = t.Token
	fmt.Fprintf(a.Err, "Publishing as %s (%s) through %s's trusted publisher\n", t.Repository, t.Workflow, t.Namespace)
	return nil
}
