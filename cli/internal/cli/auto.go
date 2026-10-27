package cli

import (
	"fmt"
	"strings"

	"github.com/spf13/cobra"

	"github.com/otinstaller/otinstaller/cli/internal/runner"
)

const autoHelp = `Guess what kind of target this is and run every installed tool that takes it.

Usage:
  ot auto <target> [...] [flags]

The target type is guessed in this order: url (http:// or https://), ip, email, phone (an
international number starting with +), domain (ending in a known top-level domain), otherwise
username. A target can also be given with its prefix (u:, d:, e:, p:, ip:, url:), which is never
second-guessed. Tools that can't run unattended (another required input, a missing key) are
skipped and listed.

Flags:
      --type string         the target's type instead of guessing: username, email, domain, phone, ip or url
      --dry-run             list the tools that would run, without running them
  -f, --format string       summary as table (default) or json
      --parallel int        how many tools run at once (default 4)
      --results-dir string  where runs are saved (default $OT_RESULTS_DIR, else results_dir in config.json, else ./results)
      --case string         save under <results-dir>/cases/<case>
`

// typeNames maps the names --type accepts to typed-input prefixes.
var typeNames = map[string]string{
	"username": "u", "email": "e", "domain": "d", "phone": "p", "ip": "ip", "url": "url",
}

func (a *App) autoCmd() *cobra.Command {
	return &cobra.Command{
		Use:                "auto <target>",
		Short:              "Guess a target's type and run every installed tool that takes it",
		DisableFlagParsing: true,
		RunE: func(cmd *cobra.Command, args []string) error {
			var typ string
			rest := []string{"--all"}
			for i := 0; i < len(args); i++ {
				arg := args[i]
				if arg == "--all" {
					return exitErr(ExitUsage, "auto already runs every installed tool that fits; --all is for `ot run`")
				}
				if v, ok := strings.CutPrefix(arg, "--type="); ok {
					typ = v
					continue
				}
				if arg == "--type" {
					if i+1 >= len(args) {
						return exitErr(ExitUsage, "--type needs a value")
					}
					i++
					typ = args[i]
					continue
				}
				rest = append(rest, arg)
			}
			ra, err := parseArgs(rest, true)
			if err != nil {
				return err
			}
			if ra.Help {
				fmt.Fprint(a.Out, autoHelp)
				return nil
			}
			if typ != "" {
				prefix, ok := typeNames[typ]
				if !ok {
					if _, isPrefix := runner.TypedPrefixes[typ]; !isPrefix {
						return exitErr(ExitUsage, "--type must be username, email, domain, phone, ip or url, not %q", typ)
					}
					prefix = typ
				}
				if len(ra.Typed) != 1 {
					return exitErr(ExitUsage, "--type applies to one target; give exactly one")
				}
				ra.Typed[0].Prefix = prefix
			}
			if len(ra.Typed) == 0 {
				fmt.Fprint(a.Out, autoHelp)
				return &ExitError{Code: ExitUsage}
			}
			if orDefault(ra.Format, "table") == "table" {
				for _, t := range ra.Typed {
					fmt.Fprintf(a.Err, "%s is %s\n", t.Value, withArticle(runner.TypedPrefixes[t.Prefix]))
				}
			}
			ra.via = "auto"
			return a.runAll(cmd.Context(), ra, "auto", nil)
		},
	}
}
