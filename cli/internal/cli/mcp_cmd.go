package cli

// `ot mcp`: serve the MCP server over stdio, add it to a client's configuration, read the audit log, and show the
// agent policy. The server itself is in mcp_server.go.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/spf13/cobra"

	"github.com/otinstaller/otinstaller/cli/internal/agent"
	"github.com/otinstaller/otinstaller/cli/internal/api"
	"github.com/otinstaller/otinstaller/cli/internal/runner"
	"github.com/otinstaller/otinstaller/cli/internal/state"
)

func (a *App) mcpCmd() *cobra.Command {
	var resultsDir string
	cmd := &cobra.Command{
		Use:   "mcp",
		Short: "Run ot as an MCP server for AI agents (Claude, Cursor, Codex, VS Code, ...)",
		Long: "Serves the Model Context Protocol over stdio, so an AI agent can search, install and run tools and read their results.\n" +
			"Tools still run on this machine in their sandbox. Runs that touch a target, go online or involve a person's identifiers\n" +
			"ask you first, through your client. The rules are in " + agent.PolicyPath() + " (see `ot mcp policy`), and\n" +
			"every run is logged (see `ot mcp audit`). Add it to a client with `ot mcp install <client>`.\n\n" +
			"Runs are saved under --results-dir, else $OT_RESULTS_DIR, else <ot home>/results.",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			p, err := agent.LoadPolicy()
			if err != nil {
				return &ExitError{Code: ExitUsage, Err: err}
			}
			s := a.serveMCP(cmd.Context(), p, resultsDir)
			fmt.Fprintf(a.Err, "ot %s: MCP server on stdio (policy: %s)\n", Version, agent.PolicyPath())
			err = s.srv.Run(cmd.Context(), &mcp.StdioTransport{})
			// The client went away: stop what is still running, so no container keeps going unwatched, and let the
			// runs be saved and audited as interrupted.
			s.shutdown(15 * time.Second)
			if err != nil && errors.Is(err, context.Canceled) {
				return nil
			}
			return err
		},
	}
	cmd.Flags().StringVar(&resultsDir, "results-dir", "", "where runs are saved")
	cmd.AddCommand(a.mcpInstallCmd(), a.mcpAuditCmd(), a.mcpPolicyCmd(), a.mcpToolsCmd())
	return cmd
}

// serveMCP turns the app into the server's: stdout belongs to the protocol, nothing prompts, installs are strict.
func (a *App) serveMCP(ctx context.Context, p *agent.Policy, resultsDir string) *mcpServer {
	switch {
	case resultsDir != "":
		os.Setenv("OT_RESULTS_DIR", resultsDir)
	case os.Getenv("OT_RESULTS_DIR") == "" && os.Getenv("OTINSTALLER_RESULTS_DIR") == "" && a.Config.ResultsDir == "":
		// Clients start servers in any folder, often one that isn't writable; results_dir from `ot start` is a
		// folder the person chose, so it is used as it is.
		os.Setenv("OT_RESULTS_DIR", state.Path("results"))
	}
	a.AgentMode = true
	a.Out = io.Discard
	a.Runner.Stderr = a.Err
	return a.newMCPServer(ctx, p)
}

// ---------- ot mcp install ----------

var mcpClients = []string{"claude", "claude-desktop", "cursor", "vscode", "codex", "gemini"}

func (a *App) mcpInstallCmd() *cobra.Command {
	var print bool
	cmd := &cobra.Command{
		Use:   "install <" + strings.Join(mcpClients, "|") + ">",
		Short: "Add ot's MCP server to an AI client's configuration",
		Long: "Adds `ot mcp` to a client's MCP configuration, using the full path of this ot:\n" +
			"  claude          Claude Code, with `claude mcp add --scope user` (printed when claude isn't on PATH)\n" +
			"  claude-desktop  Claude Desktop's claude_desktop_config.json\n" +
			"  cursor          ~/.cursor/mcp.json\n" +
			"  vscode          .vscode/mcp.json in this folder\n" +
			"  codex           ~/.codex/config.toml\n" +
			"  gemini          ~/.gemini/settings.json\n" +
			"Other settings in those files are kept. --print shows what would be added instead.",
		Args:      cobra.ExactArgs(1),
		ValidArgs: mcpClients,
		RunE: func(cmd *cobra.Command, args []string) error {
			exe, err := os.Executable()
			if err != nil {
				return err
			}
			if p, err := filepath.EvalSymlinks(exe); err == nil {
				exe = p
			}
			return a.installMCPClient(args[0], exe, print)
		},
	}
	cmd.Flags().BoolVar(&print, "print", false, "print the configuration instead of writing it")
	return cmd
}

// clientConfigPath is where a client keeps its MCP servers.
func clientConfigPath(client string) (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	switch client {
	case "claude-desktop":
		switch runtime.GOOS {
		case "windows":
			if d := os.Getenv("APPDATA"); d != "" {
				return filepath.Join(d, "Claude", "claude_desktop_config.json"), nil
			}
			return filepath.Join(home, "AppData", "Roaming", "Claude", "claude_desktop_config.json"), nil
		case "darwin":
			return filepath.Join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"), nil
		}
		return filepath.Join(home, ".config", "Claude", "claude_desktop_config.json"), nil
	case "cursor":
		return filepath.Join(home, ".cursor", "mcp.json"), nil
	case "vscode":
		return filepath.Join(".vscode", "mcp.json"), nil
	case "codex":
		return filepath.Join(home, ".codex", "config.toml"), nil
	case "gemini":
		return filepath.Join(home, ".gemini", "settings.json"), nil
	}
	return "", exitErr(ExitUsage, "unknown client %q; use one of %s", client, strings.Join(mcpClients, ", "))
}

func (a *App) installMCPClient(client, exe string, print bool) error {
	if print {
		return a.printMCPClient(client, exe)
	}
	where, err := a.addMCPServer(client, exe)
	if err != nil {
		return err
	}
	return a.mcpInstalled(client, where)
}

// printMCPClient prints what `ot mcp install` would add to a client's configuration.
func (a *App) printMCPClient(client, exe string) error {
	if client == "claude" {
		return a.printMCPConfig(client, "", claudeAddLine(exe))
	}
	path, err := clientConfigPath(client)
	if err != nil {
		return err
	}
	if client == "codex" {
		return a.printMCPConfig(client, path, codexBlock(exe))
	}
	key, entry := mcpEntry(client, exe)
	b, _ := json.MarshalIndent(map[string]any{key: map[string]any{"otinstaller": entry}}, "", "  ")
	return a.printMCPConfig(client, path, string(b))
}

// addMCPServer adds `ot mcp` to a client's configuration and says where, for `ot mcp install` and `ot start`.
func (a *App) addMCPServer(client, exe string) (string, error) {
	if client == "claude" {
		line := claudeAddLine(exe)
		claude, err := exec.LookPath("claude")
		if err != nil {
			fmt.Fprintln(a.Err, "Run this where Claude Code is installed:")
			fmt.Fprintln(a.Err, line)
			return "", &ExitError{Code: ExitRuntimeMissing, Reason: "runtime_missing", Err: errors.New("claude (Claude Code) is not on PATH, so nothing was added")}
		}
		c := exec.Command(claude, claudeAddArgs(exe)...)
		c.Stdout, c.Stderr = a.Err, a.Err
		if err := c.Run(); err != nil {
			return "", fmt.Errorf("`%s` failed: %w", line, err)
		}
		return "Claude Code (user scope)", nil
	}
	path, err := clientConfigPath(client)
	if err != nil {
		return "", err
	}
	if client == "codex" {
		old, err := os.ReadFile(path)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return "", err
		}
		if strings.Contains(string(old), "[mcp_servers.otinstaller]") {
			return "", exitErr(ExitUsage, "%s already has [mcp_servers.otinstaller]; edit it there if it needs changing", path)
		}
		text := string(old)
		if text != "" && !strings.HasSuffix(text, "\n") {
			text += "\n"
		}
		if text != "" {
			text += "\n"
		}
		if err := writeConfig(path, []byte(text+codexBlock(exe))); err != nil {
			return "", err
		}
		return path, nil
	}
	key, entry := mcpEntry(client, exe)
	doc := map[string]any{}
	if b, err := os.ReadFile(path); err == nil {
		if len(strings.TrimSpace(string(b))) > 0 {
			if err := json.Unmarshal(b, &doc); err != nil {
				return "", exitErr(ExitUsage, "%s is not plain JSON (%v), so ot won't rewrite it; add the server yourself (`ot mcp install %s --print`)", path, err, client)
			}
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	servers, _ := doc[key].(map[string]any)
	if servers == nil {
		servers = map[string]any{}
	}
	if _, had := servers["otinstaller"]; had {
		fmt.Fprintf(a.Err, "note: replacing the otinstaller server already in %s\n", path)
	}
	servers["otinstaller"] = entry
	doc[key] = servers
	b, _ := json.MarshalIndent(doc, "", "  ")
	if err := writeConfig(path, append(b, '\n')); err != nil {
		return "", err
	}
	return path, nil
}

// mcpConfigured reports whether a client's configuration file already has the otinstaller server. Claude Code keeps
// its own list, so for it the answer is always no.
func mcpConfigured(client string) bool {
	path, err := clientConfigPath(client)
	if err != nil || client == "claude" {
		return false
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	if client == "codex" {
		return strings.Contains(string(b), "[mcp_servers.otinstaller]")
	}
	var doc map[string]any
	if json.Unmarshal(b, &doc) != nil {
		return false
	}
	key, _ := mcpEntry(client, "")
	servers, _ := doc[key].(map[string]any)
	_, ok := servers["otinstaller"]
	return ok
}

// mcpEntry is the JSON key a client lists servers under and the entry for ot.
func mcpEntry(client, exe string) (string, map[string]any) {
	if client == "vscode" {
		return "servers", map[string]any{"type": "stdio", "command": exe, "args": []string{"mcp"}}
	}
	return "mcpServers", map[string]any{"command": exe, "args": []string{"mcp"}}
}

func claudeAddArgs(exe string) []string {
	return []string{"mcp", "add", "--scope", "user", "otinstaller", "--", exe, "mcp"}
}

func claudeAddLine(exe string) string {
	return "claude " + strings.Join(quoteArgs(claudeAddArgs(exe)), " ")
}

func codexBlock(exe string) string {
	return fmt.Sprintf("[mcp_servers.otinstaller]\ncommand = %s\nargs = [\"mcp\"]\n", tomlString(exe))
}

func writeConfig(path string, b []byte) error {
	if dir := filepath.Dir(path); dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
	}
	return os.WriteFile(path, b, 0o644)
}

func (a *App) printMCPConfig(client, path, text string) error {
	if a.jsonMode() {
		return writeJSON(a.Out, map[string]string{"client": client, "path": path, "config": text})
	}
	if path != "" {
		fmt.Fprintf(a.Out, "Add to %s:\n\n", path)
	}
	fmt.Fprintln(a.Out, text)
	return nil
}

func (a *App) mcpInstalled(client, where string) error {
	if a.jsonMode() {
		return writeJSON(a.Out, map[string]any{"client": client, "path": where, "installed": true})
	}
	fmt.Fprintf(a.Out, "Added the otinstaller MCP server to %s. Restart %s to load it.\n", where, clientNames[client])
	fmt.Fprintf(a.Out, "Agents ask you before runs that touch a target; the rules are in %s (`ot mcp policy`).\n", agent.PolicyPath())
	return nil
}

// clientNames are how the clients call themselves, for messages.
var clientNames = map[string]string{"claude": "Claude Code", "claude-desktop": "Claude Desktop", "cursor": "Cursor", "vscode": "VS Code", "codex": "Codex", "gemini": "Gemini CLI"}

// quoteArgs quotes arguments for a POSIX shell (Git Bash on Windows too): single quotes keep backslashes in paths.
func quoteArgs(args []string) []string {
	out := make([]string, len(args))
	for i, s := range args {
		if strings.ContainsAny(s, " \t\"'\\$`") {
			s = "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
		}
		out[i] = s
	}
	return out
}

// tomlString quotes a path for TOML with a literal string, so Windows backslashes need no escaping.
func tomlString(s string) string {
	if !strings.Contains(s, "'") {
		return "'" + s + "'"
	}
	b, _ := json.Marshal(s)
	return string(b)
}

// ---------- ot mcp audit ----------

func (a *App) mcpAuditCmd() *cobra.Command {
	var since time.Duration
	cmd := &cobra.Command{
		Use:   "audit",
		Short: "Show what agents (and unattended runs) did",
		Long: "Lists the runs, installs and uninstalls asked for through `ot mcp` or by `ot run` without a terminal: when, which\n" +
			"client, what ran on which inputs, how it was allowed, and how it ended. The log is " + agent.AuditPath() + ";\n" +
			"it never leaves this machine.",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			entries, err := agent.ReadAudit(time.Now().Add(-since))
			if err != nil {
				return err
			}
			if a.jsonMode() {
				if entries == nil {
					entries = []agent.Entry{}
				}
				return writeJSON(a.Out, entries)
			}
			if len(entries) == 0 {
				fmt.Fprintf(a.Out, "Nothing in the last %s.\n", since)
				return nil
			}
			for _, e := range entries {
				fmt.Fprintln(a.Out, e.Summary())
			}
			return nil
		},
	}
	cmd.Flags().DurationVar(&since, "since", 24*time.Hour, "how far back, such as 1h or 168h")
	return cmd
}

// ---------- ot mcp policy ----------

func (a *App) mcpPolicyCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "policy",
		Short: "Show the rules agents run under",
		Long: "Shows the agent policy in effect: " + agent.PolicyPath() + " over the defaults. Edit that file to change it:\n" +
			"  enabled                       false refuses every run, install and uninstall from an agent\n" +
			"  mode                          live, or sandbox to run tools only on their own test input\n" +
			"  allow_tools / deny_tools      package patterns such as osintverse-community/*\n" +
			"  auto_approve                  none, passive (default) or networked; target and personal-data runs always ask\n" +
			"  consent_ttl_minutes           how long \"allow for this session\" lasts\n" +
			"  max_runs_per_hour, max_runs_per_target_per_hour, max_parallel, max_output_chars\n" +
			"  allow_install                 ask (default) or allow\n" +
			"  redact_targets_in_audit       leave input values out of the audit log",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			p, err := agent.LoadPolicy()
			if err != nil {
				return &ExitError{Code: ExitUsage, Err: err}
			}
			_, statErr := os.Stat(agent.PolicyPath())
			if a.jsonMode() {
				return writeJSON(a.Out, map[string]any{"path": agent.PolicyPath(), "file_exists": statErr == nil, "policy": p})
			}
			b, _ := json.MarshalIndent(p, "", "  ")
			where := agent.PolicyPath()
			if statErr != nil {
				where += " (not created: these are the defaults; `ot mcp policy reset` writes them there)"
			}
			fmt.Fprintf(a.Out, "%s\n%s\n", where, b)
			return nil
		},
	}
	cmd.AddCommand(&cobra.Command{
		Use:   "reset",
		Short: "Write the default policy to the policy file, replacing what is there",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := agent.DefaultPolicy().Save(); err != nil {
				return err
			}
			if a.jsonMode() {
				return writeJSON(a.Out, map[string]any{"path": agent.PolicyPath(), "reset": true})
			}
			fmt.Fprintf(a.Out, "Wrote the default policy to %s.\n", agent.PolicyPath())
			return nil
		},
	})
	return cmd
}

// ---------- ot mcp tools ----------

func (a *App) mcpToolsCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "tools",
		Short: "List the MCP server's tools, resources and prompts",
		Long:  "Lists what `ot mcp` offers, as a client sees it. With --json, the full definitions (input and output schemas included).",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			list, err := a.describeMCP(cmd.Context())
			if err != nil {
				return err
			}
			if a.jsonMode() {
				return writeJSON(a.Out, list)
			}
			tw := tabwriter.NewWriter(a.Out, 0, 4, 2, ' ', 0)
			fmt.Fprintln(tw, "TOOL\tKIND\tTITLE")
			for _, t := range list.Tools {
				kind := "read-only"
				if t.Annotations == nil || !t.Annotations.ReadOnlyHint {
					kind = "side effects"
				}
				fmt.Fprintf(tw, "%s\t%s\t%s\n", t.Name, kind, t.Title)
			}
			tw.Flush()
			fmt.Fprintf(a.Out, "\n%d resources, %d resource templates, %d prompts.\n", len(list.Resources), len(list.Templates), len(list.Prompts))
			return nil
		},
	}
}

type mcpDescription struct {
	Tools     []*mcp.Tool             `json:"tools"`
	Resources []*mcp.Resource         `json:"resources"`
	Templates []*mcp.ResourceTemplate `json:"resource_templates"`
	Prompts   []*mcp.Prompt           `json:"prompts"`
}

// describeMCP connects an in-memory client to a server and lists what it offers.
func (a *App) describeMCP(ctx context.Context) (*mcpDescription, error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	sa := *a
	sa.Out, sa.AgentMode = io.Discard, true
	s := sa.newMCPServer(ctx, agent.DefaultPolicy())
	ct, st := mcp.NewInMemoryTransports()
	if _, err := s.srv.Connect(ctx, st, nil); err != nil {
		return nil, err
	}
	cs, err := mcp.NewClient(&mcp.Implementation{Name: "ot-mcp-tools", Version: Version}, nil).Connect(ctx, ct, nil)
	if err != nil {
		return nil, err
	}
	defer cs.Close()
	out := &mcpDescription{}
	tools, err := cs.ListTools(ctx, nil)
	if err != nil {
		return nil, err
	}
	out.Tools = tools.Tools
	if r, err := cs.ListResources(ctx, nil); err == nil {
		out.Resources = r.Resources
	}
	if r, err := cs.ListResourceTemplates(ctx, nil); err == nil {
		out.Templates = r.ResourceTemplates
	}
	if r, err := cs.ListPrompts(ctx, nil); err == nil {
		out.Prompts = r.Prompts
	}
	sort.Slice(out.Tools, func(i, j int) bool { return out.Tools[i].Name < out.Tools[j].Name })
	return out, nil
}

// DescribeMCP lists the server's tools and prompts without serving, for the release step that writes the .mcpb
// manifest (cmd/mcpb).
func DescribeMCP(ctx context.Context) ([]*mcp.Tool, []*mcp.Prompt, error) {
	cfg := state.LoadConfig()
	a := &App{Out: io.Discard, Err: io.Discard, In: strings.NewReader(""), Config: cfg, API: api.New(cfg.APIURL, Version),
		Runner: &runner.Runner{Exec: runner.OSExec{}, Stderr: io.Discard}}
	d, err := a.describeMCP(ctx)
	if err != nil {
		return nil, nil, err
	}
	return d.Tools, d.Prompts, nil
}
