"""Configuration helpers."""

import os
import shutil
import sys
from pathlib import Path

# Set by the old otinstaller package, honoured until the next major version
OLD_PREFIX = "OTINSTALLER_"
OLD_HOME_NAME = ".otinstaller"
# Small files worth carrying over from an old home. Tool virtualenvs are not: their scripts hold
# absolute paths, so they only work where they were created
MIGRATED_FILES = (".env", "accepted.json", "crash_reports.json")


def env_value(name: str) -> str | None:
    """Read OTLITE_<name>, or the old OTINSTALLER_<name> when only that is set."""
    value = os.environ.get("OTLITE_" + name)
    if value:
        return value
    return os.environ.get(OLD_PREFIX + name) or None


def get_distro() -> str:
    """Return the distro ID from /etc/os-release (lowercased), or 'unknown'."""
    path = Path("/etc/os-release")
    if not path.exists():
        return "unknown"
    try:
        content = path.read_text()
        for line in content.splitlines():
            if line.startswith("ID="):
                value = line.split("=", 1)[1].strip().strip('"')
                return value.lower()
    except Exception:
        pass
    return "unknown"


SUPPORTED_PLATFORMS = {"linux": "Linux", "darwin": "macOS"}


def platform_name() -> str | None:
    """Return "Linux" or "macOS" on a supported platform, else None."""
    return SUPPORTED_PLATFORMS.get(sys.platform)


def get_distro_family() -> str:
    """Return the family: 'debian', 'arch', 'fedora', 'macos', or 'unknown'."""
    if platform_name() == "macOS":
        return "macos"
    distro = get_distro()
    if distro in ("ubuntu", "debian", "kali", "linuxmint", "pop", "elementary", "zorin"):
        return "debian"
    if distro in ("arch", "manjaro", "endeavouros", "garuda", "artix"):
        return "arch"
    if distro in ("fedora", "rhel", "centos", "rocky", "almalinux", "ol", "amzn"):
        return "fedora"
    # Check ID_LIKE for derivatives
    path = Path("/etc/os-release")
    if path.exists():
        try:
            content = path.read_text()
            for line in content.splitlines():
                if line.startswith("ID_LIKE="):
                    value = line.split("=", 1)[1].strip().strip('"').lower()
                    if "debian" in value or "ubuntu" in value:
                        return "debian"
                    if "arch" in value:
                        return "arch"
                    if "fedora" in value or "rhel" in value:
                        return "fedora"
        except Exception:
            pass
    return "unknown"


def get_home() -> Path:
    """Return the otlite home directory."""
    env_home = env_value("HOME")
    if env_home:
        return Path(env_home).expanduser()
    return Path.home() / ".otlite"


def old_home() -> Path | None:
    """The home left behind by otinstaller, when it exists and no env var points elsewhere."""
    if env_value("HOME"):
        return None
    old = Path.home() / OLD_HOME_NAME
    return old if old.is_dir() else None


def migrate_old_home() -> list[str]:
    """Copy API keys and settings from ~/.otinstaller the first time ~/.otlite is created.

    Returns the names of the files copied, or nothing when there was nothing to do.
    """
    home = get_home()
    old = old_home()
    if old is None or home.exists():
        return []
    copied = []
    home.mkdir(parents=True, exist_ok=True)
    for name in MIGRATED_FILES:
        source = old / name
        if source.is_file():
            shutil.copy2(source, home / name)
            copied.append(name)
    return copied


def get_results_dir() -> Path:
    """Return the results directory."""
    env_results = env_value("RESULTS_DIR")
    if env_results:
        return Path(env_results).expanduser()
    return Path.cwd() / "results"


def get_env_file() -> Path:
    """Return the path to the .env file."""
    return get_home() / ".env"


def ensure_dir(path: Path) -> Path:
    """Create directory and return it."""
    path.mkdir(parents=True, exist_ok=True)
    return path


def get_tools_dir() -> Path:
    """Return the tools directory."""
    return get_home() / "tools"


def get_logs_dir() -> Path:
    """Return the logs directory."""
    return get_home() / "logs"


def get_state_path() -> Path:
    """Return the path to the state database."""
    return get_home() / "state.db"


def get_accept_path() -> Path:
    """Return the path to the acceptance file."""
    return get_home() / "accepted.json"


def tool_dir(name: str) -> Path:
    """Return the directory for a specific tool."""
    return get_tools_dir() / name


# The command that installs each prerequisite, per family. Python is named by version
# because otlite needs 3.10 to 3.14 and the system Python may be older or newer.
_INSTALL_HINTS = {
    "git": {
        "debian": "sudo apt install git",
        "arch": "sudo pacman -S git",
        "fedora": "sudo dnf install git",
        "macos": "xcode-select --install (or: brew install git)",
    },
    "venv": {
        "debian": "sudo apt install python{v}-venv",
        "arch": "venv is part of the python package; reinstall it with: sudo pacman -S python",
        "fedora": "venv is part of python3; reinstall it with: sudo dnf install python3",
        "macos": "brew install python@3.12, then reinstall otlite with that Python",
    },
    "python": {
        "debian": "sudo apt install python3.12 python3.12-venv",
        "arch": "sudo pacman -S python",
        "fedora": "sudo dnf install python3.12",
        "macos": "brew install python@3.12",
    },
    "pipx": {
        "debian": "sudo apt install pipx && pipx ensurepath",
        "arch": "sudo pacman -S python-pipx && pipx ensurepath",
        "fedora": "sudo dnf install pipx && pipx ensurepath",
        "macos": "brew install pipx && pipx ensurepath",
    },
}
_GENERIC_HINTS = {
    "git": "install git with your package manager",
    "venv": "install the venv module for your Python with your package manager",
    "python": "install Python 3.12 with your package manager or from python.org",
    "pipx": "python3 -m pip install --user pipx && python3 -m pipx ensurepath",
}


def installed_with() -> str | None:
    """Return "uv" or "pipx" when otlite runs from an environment one of them made."""
    prefix = Path(sys.prefix)
    if (prefix / "uv-receipt.toml").exists():
        return "uv"
    if (prefix / "pipx_metadata.json").exists():
        return "pipx"
    return None


def install_hint(what: str, python_version: str = "") -> str:
    """Return the command that installs `what` (git, venv, python or pipx) on this machine."""
    hint = _INSTALL_HINTS[what].get(get_distro_family(), _GENERIC_HINTS[what])
    return hint.replace("{v}", python_version)
