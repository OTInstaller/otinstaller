package main

import (
	"os"

	"github.com/osintverse/otinstaller/cli/internal/cli"
)

func main() {
	os.Exit(cli.Main(os.Args[1:]))
}
