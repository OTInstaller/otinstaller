package cli

// The MCP server's share_runs tool: `ot share` for an agent. It always asks the person first (agent.DecideShare), and
// every share goes in the audit log.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/otinstaller/otinstaller/cli/internal/agent"
	"github.com/otinstaller/otinstaller/cli/internal/share"
)

type shareIn struct {
	RunIDs       []string `json:"run_ids,omitempty" jsonschema:"the saved runs to share, by run_id (list_runs lists them)"`
	Case         string   `json:"case,omitempty" jsonschema:"share every saved run in this case"`
	Anonymous    bool     `json:"anonymous,omitempty" jsonschema:"don't link the share to the person's OTInstaller account, even when ot is signed in"`
	ConsentToken string   `json:"consent_token,omitempty" jsonschema:"only after the person said yes to the summary of a consent_required error for this exact call"`
}

type shareOut struct {
	ID        string   `json:"id"`
	URL       string   `json:"url" jsonschema:"the page on otinstaller.com; give it to the person"`
	ExpiresAt string   `json:"expires_at" jsonschema:"when the link stops working (RFC 3339)"`
	Runs      int      `json:"runs"`
	Tools     []string `json:"tools"`
	Owned     bool     `json:"owned" jsonschema:"linked to the person's OTInstaller account, which only they can see"`
	Note      string   `json:"note"`
}

func (s *mcpServer) addShareTool() {
	mcp.AddTool(s.srv, &mcp.Tool{Name: "share_runs", Title: "Share saved runs", Annotations: effectful("Share saved runs", false, false),
		Description: "Put saved runs (by run_id, or a whole case) on a page on otinstaller.com that anyone with the link can open for 24 hours: the inputs and everything the tools found, without file paths, the case name or the command line. Always asks the person first. Linked to their account when ot is signed in, unless anonymous is true."},
		s.shareRuns)
}

func (s *mcpServer) shareRuns(ctx context.Context, req *mcp.CallToolRequest, in shareIn) (*mcp.CallToolResult, *shareOut, error) {
	runs, err := collectSaved(in.RunIDs, in.Case, false)
	if err != nil {
		return nil, nil, asToolError(err)
	}
	p, err := buildShare(runs)
	if err != nil {
		return nil, nil, asToolError(err)
	}
	body, err := share.Encode(p)
	if err != nil {
		return nil, nil, &toolError{Code: "share_too_large", Message: err.Error(), Hint: "share fewer runs at once"}
	}
	ids := make([]string, len(runs))
	for i, r := range runs {
		ids[i] = orDefault(r.meta.RunID, idFromPath(r.output))
	}
	d := s.sess.DecideShare()
	if d.Verdict == agent.Refuse {
		return nil, nil, refusal(d)
	}
	owned := s.a.API.Token != "" && !in.Anonymous
	// The consent is bound to exactly what would be uploaded.
	sum := sha256.Sum256(body)
	ans, err := s.ask(ctx, consentRequest{req: req, kind: "share", artifact: "sha256:" + hex.EncodeToString(sum[:]), token: in.ConsentToken,
		question: shareQuestion(p), details: shareDetails(owned)})
	if err != nil {
		if te, ok := err.(*toolError); ok && te.Code == "consent_declined" {
			s.auditShare(req, p, ids, "declined", "declined", "", "")
		}
		return nil, nil, err
	}
	if ans.pending != nil {
		return ans.pending, nil, nil
	}
	made, err := s.a.API.CreateShare(ctx, body, !owned)
	if err != nil {
		s.auditShare(req, p, ids, ans.method, "error", "", err.Error())
		return nil, nil, asToolError(err)
	}
	s.a.rememberShare(made)
	s.auditShare(req, p, ids, ans.method, "shared", made.ID, "")
	return nil, &shareOut{
		ID: made.ID, URL: made.URL, ExpiresAt: time.UnixMilli(made.ExpiresAt).UTC().Format(time.RFC3339), Runs: made.Runs, Tools: share.Tools(p), Owned: made.Owned,
		Note: "Give the person the link. It stops working after 24 hours; `ot shares rm " + made.ID + "` deletes it sooner.",
	}, nil
}

// auditShare writes a share, or a declined or failed one, to the local audit log.
func (s *mcpServer) auditShare(req *mcp.CallToolRequest, p share.Payload, runIDs []string, consent, outcome, shareID, errText string) {
	tools := make([]string, len(p.Runs))
	for i, r := range p.Runs {
		tools[i] = r.Tool
	}
	e := agent.Entry{Client: clientName(req.Session), Action: "share", Tool: strings.Join(tools, ", "), Consent: consent, Outcome: outcome,
		RunID: strings.Join(runIDs, ","), Share: shareID, Error: errText}
	if err := agent.Record(s.sess.Policy, e); err != nil {
		fmt.Fprintf(s.a.Err, "warning: could not write the audit log: %v\n", err)
	}
}
