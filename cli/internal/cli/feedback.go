package cli

import (
	"fmt"
	"io"
	"os"
	"runtime"
	"strings"

	"github.com/spf13/cobra"
	"golang.org/x/term"
)

func (a *App) feedbackCmd() *cobra.Command {
	var kind, email, about string
	cmd := &cobra.Command{
		Use:   "feedback [message]",
		Short: "Send feedback to the OTInstaller team",
		Long: "Sends a message to the OTInstaller team, with your ot version and OS. It is linked to your account if you are\n" +
			"signed in. Without a message it reads one from standard input, or opens the feedback form on the website.\n" +
			"Kinds: bug, idea, question, other. For a bug that blocks you, also open an issue on GitHub.",
		Example: "  ot feedback --kind bug --about \"ot install\" \"install hangs at 'pulling image' behind a proxy\"\n" +
			"  ot doctor 2>&1 | ot feedback --kind bug",
		RunE: func(cmd *cobra.Command, args []string) error {
			message := strings.TrimSpace(strings.Join(args, " "))
			if message == "" && !isTerminal(a.In) {
				b, err := io.ReadAll(io.LimitReader(a.In, 5000))
				if err != nil {
					return err
				}
				message = strings.TrimSpace(string(b))
			}
			if message == "" {
				u := strings.TrimRight(a.Config.SiteURL, "/") + "/feedback"
				return a.openLink(u, "open the link yourself, or run ot feedback \"your message\"")
			}
			switch kind {
			case "bug", "idea", "question", "other":
			default:
				return exitErr(ExitUsage, "--kind must be bug, idea, question or other")
			}
			client := fmt.Sprintf("ot %s (%s/%s)", Version, runtime.GOOS, runtime.GOARCH)
			r, err := a.API.Feedback(cmd.Context(), kind, message, email, about, client)
			if err != nil {
				return a.requestError(err)
			}
			if a.jsonMode() {
				return writeJSON(a.Out, r)
			}
			fmt.Fprintf(a.Out, "Feedback %s sent. %s\n", r.ID, r.Note)
			return nil
		},
	}
	cmd.Flags().StringVar(&kind, "kind", "other", "bug, idea, question or other")
	cmd.Flags().StringVar(&email, "email", "", "where to reply, if you aren't signed in")
	cmd.Flags().StringVar(&about, "about", "", "the command or package it is about")
	return cmd
}

// isTerminal reports whether r is an interactive terminal (so there is nothing piped to read).
func isTerminal(r io.Reader) bool {
	f, ok := r.(*os.File)
	return ok && term.IsTerminal(int(f.Fd()))
}
