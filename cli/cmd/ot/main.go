package main

import (
	"os"

	"github.com/otinstaller/otinstaller/cli/internal/cli"
)

func main() {
	os.Exit(cli.Main(os.Args[1:]))
}
