// Package cli implements the ot commands.
package cli

import (
	"errors"
	"fmt"
	"io"
	"os"

	"github.com/spf13/cobra"

	"github.com/osintverse/otinstaller/cli/internal/api"
	"github.com/osintverse/otinstaller/cli/internal/keys"
	"github.com/osintverse/otinstaller/cli/internal/runner"
	"github.com/osintverse/otinstaller/cli/internal/state"
)

// Version is set at build time with -ldflags "-X .../cli.Version=1.0.0".
var Version = "dev"

// Exit codes, as documented in the plan.
const (
	ExitOK             = 0
	ExitToolError      = 1
	ExitUsage          = 2
	ExitMissingKey     = 3
	ExitTrust          = 4
	ExitRuntimeMissing = 5
	ExitTimeout        = 124
)

// ExitError carries an exit code up to main.
type ExitError struct {
	Code int
	Err  error
}

func (e *ExitError) Error() string {
	if e.Err == nil {
		return ""
	}
	return e.Err.Error()
}
func (e *ExitError) Unwrap() error { return e.Err }

func exitErr(code int, format string, a ...any) error {
	return &ExitError{Code: code, Err: fmt.Errorf(format, a...)}
}

// App holds what commands share; tests construct it with fakes.
type App struct {
	Out, Err io.Writer
	In       io.Reader
	Config   *state.Config
	API      *api.Client
	Runner   *runner.Runner
}

func NewApp() *App {
	cfg := state.LoadConfig()
	client := api.New(cfg.APIURL, Version)
	if tok, err := keys.Get(TokenKey); err == nil {
		client.Token = tok
	}
	return &App{
		Out:    os.Stdout,
		Err:    os.Stderr,
		In:     os.Stdin,
		Config: cfg,
		API:    client,
		Runner: runner.New(os.Stderr),
	}
}

func (a *App) Root() *cobra.Command {
	root := &cobra.Command{
		Use:           "ot",
		Short:         "Install and run OSINT tools from the OTInstaller Registry",
		Long:          "ot installs and runs OSINT tools and guides from the OTInstaller Registry (https://otinstaller.com).",
		SilenceUsage:  true,
		SilenceErrors: true,
		Version:       Version,
	}
	root.SetOut(a.Out)
	root.SetErr(a.Err)
	root.AddCommand(
		a.initCmd(),
		a.validateCmd(),
		a.searchCmd(),
		a.infoCmd(),
		a.installCmd(),
		a.runCmd(),
		a.listCmd(),
		a.uninstallCmd(),
		a.keysCmd(),
		a.doctorCmd(),
		a.loginCmd(),
		a.logoutCmd(),
		a.whoamiCmd(),
		a.importCmd(),
		a.syncCmd(),
	)
	return root
}

// Main runs ot and returns the process exit code.
func Main(args []string) int {
	a := NewApp()
	root := a.Root()
	root.SetArgs(args)
	err := root.Execute()
	if err == nil {
		return ExitOK
	}
	code := ExitCodeFor(err)
	if msg := err.Error(); msg != "" {
		fmt.Fprintln(a.Err, "error:", msg)
	}
	return code
}

// ExitCodeFor maps errors from any layer to the documented exit codes.
func ExitCodeFor(err error) int {
	var ee *ExitError
	var ue *runner.UsageError
	var te *runner.TrustError
	var rm *runner.RuntimeMissingError
	var to *runner.TimeoutError
	switch {
	case errors.As(err, &ee):
		return ee.Code
	case errors.As(err, &ue):
		return ExitUsage
	case errors.As(err, &te):
		return ExitTrust
	case errors.As(err, &rm):
		return ExitRuntimeMissing
	case errors.As(err, &to):
		return ExitTimeout
	}
	return ExitToolError
}
