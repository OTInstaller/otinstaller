package api

import (
	"context"
	"net/http"
)

// What ot sends to count installs and runs. These structs are everything that can be sent: never inputs, targets,
// results, entity values, paths, run ids, case names, command lines, keys, tokens or account names. Both requests go
// through anon(), so they never carry the token, and the registry keeps only daily totals.

// Install is the body of POST /installs, sent after each install of a registry package.
type Install struct {
	Tool    string `json:"tool"`
	Version string `json:"version"`
	// Client is cli, ci or mcp.
	Client string `json:"client"`
	// FromBackup says the image or wheel came from the registry's mirror or copy; First, the machine's first install.
	FromBackup bool   `json:"from_backup"`
	First      bool   `json:"first"`
	OS         string `json:"os"`
	Arch       string `json:"arch"`
	// Engine is docker, podman, native or none.
	Engine    string `json:"engine"`
	OTVersion string `json:"ot_version"`
}

// InstallPing counts an install. Registries before run counts read only tool, version and client.
func (c *Client) InstallPing(ctx context.Context, in Install) error {
	return c.anon().do(ctx, http.MethodPost, "/installs", in, nil)
}

// RunCount is one run: how it ended, how long it took, its engine and what started it.
type RunCount struct {
	Tool    string `json:"tool"`
	Version string `json:"version"`
	// Outcome is ok, empty, error, timeout, interrupted, engine_error, no_engine, not_started or missing_key.
	Outcome    string `json:"outcome"`
	DurationMS int64  `json:"duration_ms"`
	// Engine is docker, podman, native or none; Via is run, all, playbook, auto or mcp.
	Engine string `json:"engine"`
	Via    string `json:"via"`
}

// InstallFailure is an install that failed, and why: no_engine, pull_failed, verify_failed, build_failed, refused,
// interrupted or error. It rides in POST /runs, so a registry that only knows /installs can't count it as an install.
type InstallFailure struct {
	Tool    string `json:"tool"`
	Version string `json:"version"`
	Reason  string `json:"reason"`
}

// RunsBody is POST /runs: up to 100 runs and install failures from one client, and the machine's first-time
// milestones (first_run, first_ok_run).
type RunsBody struct {
	OTVersion string `json:"ot_version"`
	// Client is cli, ci or mcp; MCPClient, under ot mcp, the AI client (claude_code, cursor, ... or other).
	Client          string           `json:"client"`
	OS              string           `json:"os"`
	Arch            string           `json:"arch"`
	MCPClient       string           `json:"mcp_client,omitempty"`
	Runs            []RunCount       `json:"runs"`
	InstallFailures []InstallFailure `json:"install_failures,omitempty"`
	Milestones      []string         `json:"milestones,omitempty"`
}

// Runs counts runs. A registry from before run counts answers 404, which callers ignore.
func (c *Client) Runs(ctx context.Context, body RunsBody) error {
	return c.anon().do(ctx, http.MethodPost, "/runs", body, nil)
}
