// The install commands, in one place for the install block and the docs.
export const INSTALLS = [
  { id: "unix", label: "macOS / Linux", command: "curl -fsSL https://get.otinstaller.com/ot | sh", where: "/usr/local/bin or ~/.local/bin" },
  { id: "windows", label: "Windows", command: "irm https://get.otinstaller.com/ot.ps1 | iex", where: "%LOCALAPPDATA%\\Programs\\ot, and adds it to your PATH" },
] as const;

// The no-Docker edition: a Python CLI for Linux and macOS that installs tools into per-tool virtualenvs. Its installer
// (otlite/scripts/install.sh, served by ops/get) installs pipx first when it is missing.
export const NO_DOCKER = { command: "curl -fsSL https://get.otinstaller.com/otlite | sh", label: "No Docker? otlite on Linux and macOS", docs: "/otlite" } as const;

export const RELEASES_URL = "https://github.com/OTInstaller/ot/releases";
export const INSTALL_SCRIPT_URL = "https://github.com/OTInstaller/otinstaller/tree/main/scripts/install";
