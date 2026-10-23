package oci

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"time"
)

// ChunkSize is how much of a blob goes in one upload request; the mirror's Worker takes at most 100 MB per request.
// Tests make it small.
var ChunkSize int64 = 50 << 20

// Registry is an OCI registry to push to, signing in with HTTP Basic credentials for a push token.
type Registry struct {
	// Base is the registry's URL, such as https://mirror.otinstaller.com.
	Base     string
	Username string
	Password string
	HTTP     *http.Client
	// Progress receives a line per blob pushed; nil for none.
	Progress io.Writer

	token string
	repo  string
}

// Host is the registry's host as image references name it (mirror.otinstaller.com, or 127.0.0.1:8789).
func (r *Registry) Host() string {
	u, err := url.Parse(r.Base)
	if err != nil {
		return r.Base
	}
	return u.Host
}

// RegistryError is a refusal from the registry, with its OCI error code (DENIED, SIZE_INVALID, TOOMANYREQUESTS, ...).
type RegistryError struct {
	Status  int
	Code    string
	Message string
	What    string
}

func (e *RegistryError) Error() string {
	msg := e.Message
	if msg == "" {
		msg = http.StatusText(e.Status)
	}
	return fmt.Sprintf("%s: the registry answered %d %s: %s", e.What, e.Status, e.Code, msg)
}

func registryError(res *http.Response, what string) error {
	var body struct {
		Errors []struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"errors"`
	}
	b, _ := io.ReadAll(io.LimitReader(res.Body, 64<<10))
	e := &RegistryError{Status: res.StatusCode, What: what}
	if json.Unmarshal(b, &body) == nil && len(body.Errors) > 0 {
		e.Code, e.Message = body.Errors[0].Code, body.Errors[0].Message
	}
	return e
}

// signIn asks the registry's token endpoint for a push token for repo.
func (r *Registry) signIn(ctx context.Context, repo string) error {
	q := url.Values{"service": {r.Host()}, "scope": {"repository:" + repo + ":pull,push"}}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(r.Base, "/")+"/token?"+q.Encode(), nil)
	if err != nil {
		return err
	}
	req.SetBasicAuth(r.Username, r.Password)
	res, err := r.client().Do(req)
	if err != nil {
		return fmt.Errorf("cannot reach %s: %w", r.Base, err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return registryError(res, "signing in to "+r.Host())
	}
	var t struct {
		Token       string `json:"token"`
		AccessToken string `json:"access_token"`
	}
	if err := json.NewDecoder(res.Body).Decode(&t); err != nil {
		return err
	}
	r.token, r.repo = t.Token, repo
	if r.token == "" {
		r.token = t.AccessToken
	}
	return nil
}

func (r *Registry) client() *http.Client {
	if r.HTTP != nil {
		return r.HTTP
	}
	return &http.Client{Timeout: 10 * time.Minute}
}

// do makes a request with the push token, signing in again once if the token has expired (it lasts minutes).
func (r *Registry) do(ctx context.Context, method, target string, headers map[string]string, body func() io.Reader) (*http.Response, error) {
	for attempt := 0; ; attempt++ {
		u, err := url.Parse(target)
		if err != nil {
			return nil, err
		}
		if !u.IsAbs() {
			base, _ := url.Parse(r.Base)
			u = base.ResolveReference(u)
		}
		var rd io.Reader
		if body != nil {
			rd = body()
		}
		req, err := http.NewRequestWithContext(ctx, method, u.String(), rd)
		if err != nil {
			return nil, err
		}
		// Go sends Content-Length from the body (a bytes.Reader), so chunks always carry one.
		for k, v := range headers {
			req.Header.Set(k, v)
		}
		req.Header.Set("Authorization", "Bearer "+r.token)
		res, err := r.client().Do(req)
		if err != nil {
			return nil, fmt.Errorf("cannot reach %s: %w", r.Base, err)
		}
		if res.StatusCode == http.StatusUnauthorized && attempt == 0 {
			res.Body.Close()
			if err := r.signIn(ctx, r.repo); err != nil {
				return nil, err
			}
			continue
		}
		return res, nil
	}
}

// Push uploads img to repo and tags it; it returns the image's digest. Blobs the repository has are skipped.
func (r *Registry) Push(ctx context.Context, repo, tag string, img *Image) (string, error) {
	if err := r.signIn(ctx, repo); err != nil {
		return "", err
	}
	for _, d := range sortedKeys(img.Blobs) {
		if err := r.pushBlob(ctx, repo, d, img.Blobs[d]); err != nil {
			return "", err
		}
	}
	for _, c := range img.Children {
		if err := r.putManifest(ctx, repo, c.Digest, c.MediaType, c.Body); err != nil {
			return "", err
		}
	}
	if err := r.putManifest(ctx, repo, tag, img.TopType, img.Top); err != nil {
		return "", err
	}
	return img.Digest(), nil
}

func (r *Registry) pushBlob(ctx context.Context, repo, digest, file string) error {
	res, err := r.do(ctx, http.MethodHead, "/v2/"+repo+"/blobs/"+digest, nil, nil)
	if err != nil {
		return err
	}
	res.Body.Close()
	if res.StatusCode == http.StatusOK {
		return nil
	}
	fi, err := os.Stat(file)
	if err != nil {
		return err
	}
	if r.Progress != nil {
		fmt.Fprintf(r.Progress, "  pushing %s (%.1f MB)\n", short(digest), float64(fi.Size())/(1<<20))
	}
	res, err = r.do(ctx, http.MethodPost, "/v2/"+repo+"/blobs/uploads/", nil, nil)
	if err != nil {
		return err
	}
	res.Body.Close()
	if res.StatusCode != http.StatusAccepted {
		return registryError(res, "starting the upload of "+short(digest))
	}
	loc := res.Header.Get("Location")
	f, err := os.Open(file)
	if err != nil {
		return err
	}
	defer f.Close()
	buf := make([]byte, ChunkSize)
	for off := int64(0); off < fi.Size(); {
		n, err := io.ReadFull(f, buf)
		if err != nil && err != io.ErrUnexpectedEOF && err != io.EOF {
			return err
		}
		chunk := buf[:n]
		res, err := r.do(ctx, http.MethodPatch, loc, map[string]string{
			"Content-Type":  "application/octet-stream",
			"Content-Range": fmt.Sprintf("%d-%d", off, off+int64(n)-1),
		}, func() io.Reader { return bytes.NewReader(chunk) })
		if err != nil {
			return err
		}
		res.Body.Close()
		if res.StatusCode != http.StatusAccepted {
			return registryError(res, "uploading "+short(digest))
		}
		loc = res.Header.Get("Location")
		off += int64(n)
	}
	sep := "?"
	if strings.Contains(loc, "?") {
		sep = "&"
	}
	res, err = r.do(ctx, http.MethodPut, loc+sep+"digest="+url.QueryEscape(digest), nil, func() io.Reader { return bytes.NewReader(nil) })
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusCreated {
		return registryError(res, "finishing the upload of "+short(digest))
	}
	return nil
}

func (r *Registry) putManifest(ctx context.Context, repo, ref, mediaType string, body []byte) error {
	res, err := r.do(ctx, http.MethodPut, "/v2/"+repo+"/manifests/"+ref, map[string]string{"Content-Type": mediaType},
		func() io.Reader { return bytes.NewReader(body) })
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusCreated {
		return registryError(res, "pushing the manifest "+ref)
	}
	return nil
}

func short(digest string) string {
	if len(digest) > 19 {
		return digest[:19]
	}
	return digest
}

func sortedKeys(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
