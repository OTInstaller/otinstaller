"""Configuration helpers."""

import os
import shutil
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


def get_distro_family() -> str:
    """Return the distro family: 'debian', 'arch', or 'unknown'."""
    distro = get_distro()
    if distro in ("ubuntu", "debian", "kali", "linuxmint", "pop", "elementary", "zorin"):
        return "debian"
    if distro in ("arch", "manjaro", "endeavouros", "garuda", "artix"):
        return "arch"
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
