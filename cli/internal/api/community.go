package api

import (
	"context"
	"net/http"
	"net/url"
	"strconv"
)

// Issue is one issue in a package's list (GET /tools/:ns/:name/issues).
type Issue struct {
	Number   int    `json:"number"`
	Kind     string `json:"kind"`
	Status   string `json:"status"`
	Title    string `json:"title"`
	Version  string `json:"version,omitempty"`
	Platform string `json:"platform,omitempty"`
	Comments int    `json:"comments"`
	MeToo    int    `json:"me_too"`
	Locked   bool   `json:"locked"`
	Author   struct {
		Handle string `json:"handle"`
		System bool   `json:"system,omitempty"`
	} `json:"author"`
	CreatedAt      int64 `json:"created_at"`
	LastActivityAt int64 `json:"last_activity_at"`
}

type IssueList struct {
	Ref    string `json:"ref"`
	Counts struct {
		Open   int `json:"open"`
		Closed int `json:"closed"`
	} `json:"counts"`
	Issues []Issue `json:"issues"`
}

// Issues lists a package's issues; status is open, closed or all. Public, so it goes without the token.
func (c *Client) Issues(ctx context.Context, ns, name, status string) (*IssueList, error) {
	var out IssueList
	q := url.Values{"status": {status}}
	return &out, c.anon().do(ctx, http.MethodGet, "/tools/"+pkgPath(ns, name)+"/issues?"+q.Encode(), nil, &out)
}

// RunReport is what ot's failure prompt sends: never inputs or output.
type RunReport struct {
	Version   string `json:"version"`
	ExitCode  *int   `json:"exit_code"`
	TimedOut  bool   `json:"timed_out,omitempty"`
	OS        string `json:"os"`
	Arch      string `json:"arch"`
	Engine    string `json:"engine,omitempty"`
	OTVersion string `json:"ot_version,omitempty"`
}

// RunReportResult says what the report became: a "me too" on an issue or a new one (signed in), or a count.
type RunReportResult struct {
	Issue      int    `json:"issue,omitempty"`
	Created    bool   `json:"created,omitempty"`
	Moderation string `json:"moderation,omitempty"`
	Counted    bool   `json:"counted,omitempty"`
}

// ReportRun sends a failed run. With anonymous true (or no token) it goes without the token and only adds to a count.
func (c *Client) ReportRun(ctx context.Context, ns, name string, r RunReport, anonymous bool) (*RunReportResult, error) {
	var out RunReportResult
	client := c
	if anonymous {
		client = c.anon()
	}
	return &out, client.do(ctx, http.MethodPost, "/tools/"+pkgPath(ns, name)+"/run-reports", r, &out)
}

// Confirmation is a version's works and broken counts after an answer.
type Confirmation struct {
	Version string `json:"version"`
	Works   int    `json:"works"`
	Broken  int    `json:"broken"`
}

// Confirm says a version works (or is broken) for the signed-in person on a platform.
func (c *Client) Confirm(ctx context.Context, ns, name, result, version, platform, engine, otVersion string) (*Confirmation, error) {
	var out Confirmation
	body := map[string]string{"result": result, "platform": platform}
	if version != "" {
		body["version"] = version
	}
	if engine != "" {
		body["engine"] = engine
	}
	if otVersion != "" {
		body["ot_version"] = otVersion
	}
	return &out, c.do(ctx, http.MethodPut, "/tools/"+pkgPath(ns, name)+"/confirmations", body, &out)
}

// ToolRequest is a request to package a tool (POST /requests, GET /requests/:number).
type ToolRequest struct {
	Number      int    `json:"number"`
	Repo        string `json:"repo"`
	URL         string `json:"url"`
	Status      string `json:"status"`
	DeclineCode string `json:"decline_code,omitempty"`
	Votes       int    `json:"votes"`
	Tool        string `json:"tool,omitempty"`
	Otlite      string `json:"otlite,omitempty"`
}

// RequestMade is the registry's answer to a new request: the request, whether it waits for a moderator, and notes.
type RequestMade struct {
	Request ToolRequest `json:"request"`
	Held    bool        `json:"held"`
	Notes   []string    `json:"notes"`
	URL     string      `json:"url"`
}

// RequestVote is a request's votes after voting.
type RequestVote struct {
	Number int  `json:"number"`
	Votes  int  `json:"votes"`
	Voted  bool `json:"voted"`
}

// RequestTool asks for the repository at repo (a GitHub or GitLab URL) to be packaged.
func (c *Client) RequestTool(ctx context.Context, repo, note string) (*RequestMade, error) {
	var out RequestMade
	body := map[string]string{"repo": repo}
	if note != "" {
		body["note"] = note
	}
	return &out, c.do(ctx, http.MethodPost, "/requests", body, &out)
}

// VoteRequest adds the signed-in person's vote to a request.
func (c *Client) VoteRequest(ctx context.Context, number int) (*RequestVote, error) {
	var out RequestVote
	return &out, c.do(ctx, http.MethodPut, "/requests/"+strconv.Itoa(number)+"/vote", nil, &out)
}
