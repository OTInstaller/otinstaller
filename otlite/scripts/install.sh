#!/bin/sh
# Installs otlite on Linux or macOS:
#
#   curl -fsSL https://get.otinstaller.com/otlite | sh
#
# With a Python 3.10 to 3.14 and pipx already on the machine, it installs otlite with pipx. Otherwise it fetches uv
# (a pinned release, checked against its SHA-256) into ~/.local/bin and installs otlite with uv on a Python 3.12 that
# uv downloads into your home directory, so a new machine needs nothing but curl and tar, and never sudo.
#
# Settings: OTLITE_PYTHON picks the Python; OTLITE_USE_UV=1 uses uv even when pipx is there; OTLITE_PACKAGE installs
# something other than the PyPI release (a wheel or a source folder, for testing).
set -eu

UV_VERSION=0.12.24
PYTHON_VERSION=3.12

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

py=""
if [ -n "${OTLITE_PYTHON:-}" ]; then
  supported "$OTLITE_PYTHON" || fail "OTLITE_PYTHON=$OTLITE_PYTHON is not Python 3.10 to 3.14"
  py=$OTLITE_PYTHON
else
  for candidate in python3.13 python3.12 python3.11 python3.10 python3.14 python3; do
    if have "$candidate" && supported "$candidate"; then py=$(command -v "$candidate"); break; fi
  done
fi

pipx=""
if [ -n "$py" ] && [ -z "${OTLITE_USE_UV:-}" ]; then
  if have pipx; then pipx="pipx"
  elif "$py" -m pipx --version >/dev/null 2>&1; then pipx="$py -m pipx"
  fi
fi

package="${OTLITE_PACKAGE:-otlite}"

if [ -n "$pipx" ]; then
  say "using $("$py" -c 'import sys; print("Python %d.%d" % sys.version_info[:2])') at $py and pipx"
  # A reinstall replaces an older otlite in place; tools and keys in ~/.otlite are left alone.
  # shellcheck disable=SC2086
  $pipx install --force --python "$py" "$package"
  # shellcheck disable=SC2086
  $pipx ensurepath >/dev/null 2>&1 || true
  upgrade="pipx upgrade otlite"
else
  bin_dir="$HOME/.local/bin"

  fetch() {
    if have curl; then curl -fsSL -o "$2" "$1"
    elif have wget; then wget -q -O "$2" "$1"
    else fail "neither curl nor wget is installed"
    fi
  }

  sha256() {
    if have sha256sum; then sha256sum "$1" | cut -d ' ' -f 1
    else shasum -a 256 "$1" | cut -d ' ' -f 1
    fi
  }

  install_uv() {
    case "$(uname -m)" in
      x86_64 | amd64) arch=x86_64 ;;
      aarch64 | arm64) arch=aarch64 ;;
      *) fail "no uv build for $(uname -m); install Python 3.12 and pipx, then run this again" ;;
    esac
    # The Linux builds are static (musl), so they run on any distribution.
    if [ "$os" = macos ]; then target="$arch-apple-darwin"; else target="$arch-unknown-linux-musl"; fi
    case "$target" in
      x86_64-unknown-linux-musl) want=48170bd200a5430298c18f3b264485a1f3a8605f01088277daf6e37633edf0f5 ;;
      aarch64-unknown-linux-musl) want=7f9ab4726d743b6a92e310477a7840c8a8a7b3938cb3c4657d541342fca75011 ;;
      x86_64-apple-darwin) want=4fa82e37cb94767661f532b001e470b67a186c7260e305bd84ddb78fd545c0b6 ;;
      aarch64-apple-darwin) want=0c4346de7abdb49495b393b9ec809fe387aa43e586be20fecb972216c1e71732 ;;
    esac
    tmp=$(mktemp -d)
    trap 'rm -rf "$tmp"' EXIT
    say "downloading uv $UV_VERSION"
    fetch "https://github.com/astral-sh/uv/releases/download/$UV_VERSION/uv-$target.tar.gz" "$tmp/uv.tar.gz"
    [ "$(sha256 "$tmp/uv.tar.gz")" = "$want" ] || fail "the uv download does not match its expected SHA-256"
    tar -xzf "$tmp/uv.tar.gz" -C "$tmp"
    mkdir -p "$bin_dir"
    cp "$tmp/uv-$target/uv" "$tmp/uv-$target/uvx" "$bin_dir/"
    chmod 755 "$bin_dir/uv" "$bin_dir/uvx"
  }

  if have uv; then
    uv=$(command -v uv)
  elif [ -x "$bin_dir/uv" ]; then
    uv="$bin_dir/uv"
  else
    install_uv
    uv="$bin_dir/uv"
  fi

  # Without OTLITE_PYTHON, uv's own Python is used even when the system has one: a system Python can lack the venv
  # module (Debian's python3-venv), and otlite builds a venv for every tool it installs.
  if [ -n "${OTLITE_PYTHON:-}" ]; then
    say "using $py with uv"
    "$uv" tool install --force --python "$py" "$package"
  else
    say "installing otlite with uv on its own Python $PYTHON_VERSION (in ~/.local/share/uv)"
    "$uv" tool install --force --managed-python --python "$PYTHON_VERSION" "$package"
  fi
  "$uv" tool update-shell >/dev/null 2>&1 || true
  upgrade="uv tool upgrade otlite"
fi

say ""
say "otlite is installed. Open a new terminal if 'otlite' is not found yet, then run:"
say "  otlite doctor"
say "  otlite install sherlock"
say "  otlite run sherlock -- u:johndoe"
say "Upgrade it later with: $upgrade"
