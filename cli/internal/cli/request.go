package cli

import (
	"bufio"
	"errors"
	"fmt"
	"strings"

	"github.com/spf13/cobra"

	"github.com/otinstaller/otinstaller/cli/internal/api"
)

// requestCmd asks for an open-source tool to be packaged for the registry, or votes for the request someone else
// made for the same repository.
func (a *App) requestCmd() *cobra.Command {
	var note string
	var vote bool
	cmd := &cobra.Command{
		Use:   "request <repository-url>",
		Short: "Ask for an open-source tool to be packaged, or vote for someone's request",
		Long: "Asks the registry's community to package a GitHub or GitLab repository. The registry checks that it is public, " +
			"not packaged or requested already, and has a license it may redistribute. When someone asked for it already, " +
			"`--vote` (or answering yes at a terminal) adds your vote instead. Needs `ot login`. See https://otinstaller.com/requests.",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if a.API.Token == "" {
				return exitErr(ExitUsage, "asking for a tool needs a sign-in: run `ot login`")
			}
			made, err := a.API.RequestTool(cmd.Context(), args[0], strings.TrimSpace(note))
			var ae *api.Error
			if errors.As(err, &ae) && ae.Code == "request_exists" && ae.Number > 0 {
				if !vote && !a.askVote(ae) {
					return a.requestError(err)
				}
				v, err := a.API.VoteRequest(cmd.Context(), ae.Number)
				if err != nil {
					return a.requestError(err)
				}
				if a.jsonMode() {
					return writeJSON(a.Out, v)
				}
				fmt.Fprintf(a.Out, "Voted for request #%d (%s): %s\n", v.Number, plural(v.Votes, "vote", "votes"), a.requestURL(v.Number))
				return nil
			}
			if err != nil {
				return a.requestError(err)
			}
			if a.jsonMode() {
				return writeJSON(a.Out, made)
			}
			r := made.Request
			switch {
			case r.Status == "declined":
				fmt.Fprintf(a.Out, "Recorded %s as request #%d, declined: %s\n", r.Repo, r.Number, made.URL)
			case made.Held:
				fmt.Fprintf(a.Out, "Asked for %s as request #%d; a moderator looks at it before it shows: %s\n", r.Repo, r.Number, made.URL)
			default:
				fmt.Fprintf(a.Out, "Asked for %s as request #%d. Others can vote for it at %s\n", r.Repo, r.Number, made.URL)
			}
			for _, n := range made.Notes {
				fmt.Fprintf(a.Err, "note: %s\n", n)
			}
			return nil
		},
	}
	cmd.Flags().StringVar(&note, "note", "", "why it's worth packaging (plain text, up to 500 characters; never personal data)")
	cmd.Flags().BoolVar(&vote, "vote", false, "vote for the existing request when someone asked for it already")
	return cmd
}

// askVote offers, at a terminal, to vote for the request that exists already.
func (a *App) askVote(e *api.Error) bool {
	if !a.interactive() || a.jsonMode() {
		return false
	}
	fmt.Fprintf(a.Err, "%s. Vote for it instead? [Y/n] ", e.Message)
	answer, _ := bufio.NewReader(a.In).ReadString('\n')
	ans := strings.ToLower(strings.TrimSpace(answer))
	return ans == "" || ans == "y" || ans == "yes"
}

func (a *App) requestURL(number int) string {
	return fmt.Sprintf("%s/requests/%d", strings.TrimRight(a.Config.SiteURL, "/"), number)
}
