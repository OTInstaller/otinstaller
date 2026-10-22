#!/bin/sh
# Installs otlite on Linux or macOS:
#
#   curl -fsSL https://get.otinstaller.com/otlite | sh
#
# It finds a Python 3.10 to 3.14, installs pipx when it is missing (with the system package manager, or with pip
# for your user when there is none), then installs otlite with pipx so it gets a virtualenv of its own.
#
# Settings: OTLITE_PYTHON picks the Python; OTLITE_PACKAGE installs something other than the PyPI release (a wheel
# path, for testing); OTLITE_NO_SUDO=1 never runs sudo, so a missing pipx is installed with pip instead.
set -eu

say() { printf '%s\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=macos ;;
  *) fail "otlite runs on Linux and macOS; on Windows use ot instead: https://otinstaller.com/docs/quick-start" ;;
esac

supported() {
  "$1" -c 'import sys; sys.exit(0 if (3, 10) <= sys.version_info[:2] <= (3, 14) else 1)' >/dev/null 2>&1
}

python_hint() {
  if [ "$os" = macos ]; then echo "brew install python@3.12"
  elif have apt-get; then echo "sudo apt install python3.12 python3.12-venv"
  elif have dnf; then echo "sudo dnf install python3.12"
  elif have pacman; then echo "sudo pacman -S python"
  else echo "install Python 3.12 with your package manager"
  fi
}

py=""
if [ -n "${OTLITE_PYTHON:-}" ]; then
  supported "$OTLITE_PYTHON" || fail "OTLITE_PYTHON=$OTLITE_PYTHON is not Python 3.10 to 3.14"
  py=$OTLITE_PYTHON
else
  for candidate in python3.13 python3.12 python3.11 python3.10 python3.14 python3; do
    if have "$candidate" && supported "$candidate"; then py=$(command -v "$candidate"); break; fi
  done
fi
[ -n "$py" ] || fail "otlite needs Python 3.10 to 3.14 and none was found; install one with: $(python_hint)"
say "using $("$py" -c 'import sys; print("Python %d.%d" % sys.version_info[:2])') at $py"

sudo_cmd() {
  if [ "$(id -u)" = 0 ]; then "$@"
  elif [ -z "${OTLITE_NO_SUDO:-}" ] && have sudo; then sudo "$@"
  else return 1
  fi
}

install_pipx() {
  say "pipx is missing; installing it"
  if [ "$os" = macos ] && have brew; then brew install pipx && return 0; fi
  if have apt-get; then sudo_cmd apt-get install -y pipx && return 0; fi
  if have dnf; then sudo_cmd dnf install -y pipx && return 0; fi
  if have pacman; then sudo_cmd pacman -S --noconfirm python-pipx && return 0; fi
  # No package manager we can use: pip for this user. Distributions that forbid it (PEP 668) need the
  # package manager instead, so say which command to run.
  "$py" -m pip install --user pipx >/dev/null 2>&1 && return 0
  return 1
}

if have pipx; then
  pipx="pipx"
elif "$py" -m pipx --version >/dev/null 2>&1; then
  pipx="$py -m pipx"
else
  install_pipx || fail "could not install pipx; install it yourself (Debian/Ubuntu: sudo apt install pipx, macOS: brew install pipx), then run this again"
  if have pipx; then pipx="pipx"; else pipx="$py -m pipx"; fi
fi

package="${OTLITE_PACKAGE:-otlite}"
# A reinstall replaces an older otlite in place; tools and keys in ~/.otlite are left alone.
# shellcheck disable=SC2086
$pipx install --force --python "$py" "$package"
# shellcheck disable=SC2086
$pipx ensurepath >/dev/null 2>&1 || true

say ""
say "otlite is installed. Open a new terminal if 'otlite' is not found yet, then run:"
say "  otlite doctor"
say "  otlite install sherlock"
say "  otlite run sherlock -- u:johndoe"
