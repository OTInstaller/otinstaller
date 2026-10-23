package cli

// What scripts, CI and agents rely on: JSON errors, the error codes behind them, and never prompting
// when nobody is at a terminal. The shapes are spec/schema/error-v1.json and /docs/automation.

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"golang.org/x/term"

	"github.com/otinstaller/otinstaller/cli/internal/api"
	"github.com/otinstaller/otinstaller/cli/internal/manifest"
	"github.com/otinstaller/otinstaller/cli/internal/runner"
)

// errorDocs is where every error code is explained, the same page the registry's errors link to.
const errorDocs = "https://otinstaller.com/docs/errors#"

// jsonError is the body of a JSON error, as the registry API sends it plus ot's exit code.
type jsonError struct {
	Code      string        `json:"code"`
	Message   string        `json:"message"`
	Hint      string        `json:"hint,omitempty"`
	Docs      string        `json:"docs"`
	ExitCode  int           `json:"exit_code"`
	RequestID string        `json:"request_id,omitempty"`
	Problems  []api.Problem `json:"problems,omitempty"`
	// Number and Ref come from the registry: the tool request or package that exists already.
	Number int    `json:"number,omitempty"`
	Ref    string `json:"ref,omitempty"`
}

// jsonRequested reports whether the command line asks for JSON, for errors raised before cobra has
// parsed the flags (an unknown flag) and for `ot run`, which parses its own: --json, or -f/--format json
// or jsonl.
func jsonRequested(args []string) bool {
	for i, arg := range args {
		switch {
		case arg == "--":
			return false
		case arg == "--json", arg == "--json=true", arg == "--format=json", arg == "-f=json", arg == "--format=jsonl", arg == "-f=jsonl":
			return true
		case (arg == "-f" || arg == "--format") && i+1 < len(args) && (args[i+1] == "json" || args[i+1] == "jsonl"):
			return true
		}
	}
	return false
}

// writeJSONError prints err as one line of JSON, so a caller can read stderr line by line.
func writeJSONError(w io.Writer, err error, exitCode int) {
	je := jsonError{Code: errorCode(err, exitCode), Message: err.Error(), ExitCode: exitCode}
	var ae *api.Error
	if errors.As(err, &ae) {
		// The registry's message and hint are kept apart; Error() folds them into one sentence.
		if err.Error() == ae.Error() {
			je.Message = ae.Message
		}
		je.Hint, je.RequestID, je.Problems = ae.Hint, ae.RequestID, ae.Problems
		je.Number, je.Ref = ae.Number, ae.Ref
		if ae.Docs != "" {
			je.Docs = ae.Docs
		}
	}
	var ee *ExitError
	if errors.As(err, &ee) && len(ee.Problems) > 0 {
		je.Problems = ee.Problems
	}
	if ee != nil && ee.Hint != "" {
		je.Hint = ee.Hint
	}
	if je.Docs == "" {
		je.Docs = errorDocs + je.Code
	}
	b, _ := json.Marshal(map[string]jsonError{"error": je})
	fmt.Fprintln(w, string(b))
}

// errorCode is the stable code for an error: the registry's own code, a reason the command gave, or
// one that follows from the exit code.
func errorCode(err error, exitCode int) string {
	var ae *api.Error
	var ee *ExitError
	var ue *api.UnreachableError
	switch {
	case errors.As(err, &ee) && ee.Reason != "":
		return ee.Reason
	case errors.As(err, &ae) && ae.Code != "":
		return ae.Code
	case errors.As(err, &ue):
		return "registry_unreachable"
	}
	var te *runner.TrustError
	if errors.As(err, &te) {
		return "trust_refused"
	}
	switch exitCode {
	case ExitUsage:
		return "usage"
	case ExitMissingKey:
		return "secret_missing"
	case ExitTrust:
		return "trust_refused"
	case ExitRuntimeMissing:
		return "runtime_missing"
	case ExitTimeout:
		return "timeout"
	case ExitInterrupted:
		return "interrupted"
	}
	return "failed"
}

// interactive reports whether someone can answer a prompt. ot never prompts otherwise: piped or
// closed stdin, CI and agents get an input_required error naming the flag to pass instead.
func (a *App) interactive() bool {
	if a.AgentMode || os.Getenv("OT_NONINTERACTIVE") == "1" {
		return false
	}
	if f, ok := a.In.(*os.File); ok {
		return term.IsTerminal(int(f.Fd()))
	}
	// Tests give a reader in place of a person typing.
	return true
}

// needsInput is the error for a prompt nobody can answer. what says what was asked; flags say how
// to answer it on the command line.
func needsInput(what string, flags ...string) error {
	msg := what + ", and there is no terminal to ask in"
	if len(flags) > 0 {
		msg += "; pass " + strings.Join(flags, " or ")
	}
	return &ExitError{Code: ExitUsage, Reason: "input_required", Err: errors.New(msg)}
}

// openLink sends someone to a page: it opens the browser for a person at a terminal, and otherwise
// only prints the link (as {"url": ...} in JSON mode), since scripts and agents have no browser to open.
func (a *App) openLink(u, ifFailed string) error {
	if a.jsonMode() {
		return writeJSON(a.Out, map[string]string{"url": u})
	}
	if !a.interactive() {
		fmt.Fprintln(a.Out, u)
		return nil
	}
	fmt.Fprintf(a.Out, "Opening %s\n", u)
	if err := a.OpenURL(u); err != nil {
		fmt.Fprintf(a.Err, "could not open a browser (%v); %s\n", err, ifFailed)
	}
	return nil
}

// problemsError is a manifest with problems as an error: exit 2, code manifest_invalid, and the problems
// in the JSON error.
func problemsError(msg string, ps []*manifest.Problem) error {
	list := make([]api.Problem, len(ps))
	for i, p := range ps {
		list[i] = api.Problem{Code: p.Code, Path: p.Path, Message: p.Message, Hint: p.Hint}
	}
	return &ExitError{Code: ExitUsage, Reason: "manifest_invalid", Err: errors.New(msg), Problems: list}
}

// errNotSignedIn is the error for commands that need `ot login` first (exit 2, code not_signed_in).
func errNotSignedIn(msg string) error {
	return &ExitError{Code: ExitUsage, Reason: "not_signed_in", Err: errors.New(msg)}
}

// cobraUsage turns cobra's own errors for a bad command line (an unknown command or flag, the wrong
// number of arguments) into usage errors, so they exit 2 like ot's.
func cobraUsage(err error) error {
	var ee *ExitError
	var ue *runner.UsageError
	if errors.As(err, &ee) || errors.As(err, &ue) {
		return err
	}
	msg := err.Error()
	for _, p := range []string{"unknown command ", "unknown flag: ", "unknown shorthand flag: ", "flag needs an argument: ", "invalid argument ", "accepts ", "requires at least ", "requires at most "} {
		if strings.HasPrefix(msg, p) {
			return &ExitError{Code: ExitUsage, Err: err}
		}
	}
	return err
}
