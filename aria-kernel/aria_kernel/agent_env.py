"""Plan 032 Faz 032b — the environment an ARIA agent process is allowed to see.

WHY: ``claude_runtime.run_claude_exec`` spawned the agent with
``os.environ.copy()``. Everything the runner job held — the GitHub token, the
ARIA lease token the executor must read at submit time, provider keys, the
operator's shell — was visible to a process whose whole purpose is to run
arbitrary repository commands. A Bash allowlist does not close that: a
permitted ``python3 script.py`` reads ``os.environ`` like anything else. The
executor's ``claude_subprocess_env_audit`` row said which sensitive names were
present; nothing removed them.

WHAT: a spawn environment is BUILT, never copied. It starts from a closed
baseline (locale, PATH, TLS/proxy configuration), adds the Claude CLI's own
configuration namespace, adds ONLY the authentication material the CLI needs
(the managed-login directory and, when the operator uses it, the OAuth token),
adds the names the agent's runtime profile explicitly passes through, and
records — by NAME, never by value — what was passed and what was dropped.
Anything secret-shaped that was not explicitly granted is dropped even if it
sits in the CLI's configuration namespace.

HOME is synthetic. The sandbox already mounts an ephemeral tmpfs home
(``implementation_safety.SANDBOX_HOME``); outside the sandbox the same shape is
given here so a read-only spawn cannot read the runner user's real home either.
The managed login lives in ``CLAUDE_CONFIG_DIR``; when the runner did not set
it, it is derived from the REAL home once, here, so the synthetic HOME never
silently loses the credential the spawn needs.
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Mapping, Sequence

# Names every spawn may see: process plumbing, locale, TLS and proxy
# configuration. None of these carries a credential.
BASELINE_ENV_NAMES: tuple[str, ...] = (
    "PATH", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "TERM", "TMPDIR", "TZ",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
)
# The Claude CLI's authentication material. Explicit, so a secret-shaped name
# reaching the agent is a decision this module made out loud.
CLAUDE_AUTH_ENV_NAMES: tuple[str, ...] = ("CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN")
# The CLI's configuration namespace (non-secret members only — see the filter).
CLAUDE_CONFIG_ENV_PREFIX = "CLAUDE_CODE_"
# ARIA runtime facts the spawn is allowed to know (none is a credential).
ARIA_RUNTIME_ENV_NAMES: tuple[str, ...] = (
    "IS_SANDBOX", "ARIA_JOB_DEADLINE_EPOCH", "ARIA_CLAUDE_SANDBOX",
)
# The shape of a credential. A name matching this is dropped unless it is in
# the explicit auth set or the profile's passthrough list.
# Segment-anchored so a configuration knob that merely CONTAINS the word
# (`CLAUDE_CODE_MAX_OUTPUT_TOKENS`) is not mistaken for a credential
# (`GH_TOKEN`, `NPM_AUTH_TOKEN`, `ANTHROPIC_API_KEY`).
SECRET_SHAPED_ENV_NAME = re.compile(
    r"(?:^|_)(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|CREDENTIALS|AUTH|OAUTH|PRIVATE)(?:_|$)",
    re.IGNORECASE,
)
SYNTHETIC_HOME_PREFIX = "aria-agent-home-"
CLAUDE_CONFIG_DIRNAME = ".claude"


@dataclass(frozen=True)
class AgentEnvReport:
    """What the spawn environment carries — names only, never values."""

    passed: tuple[str, ...]
    passthrough: tuple[str, ...]
    dropped_count: int
    dropped_secret_shaped: tuple[str, ...]
    home: str
    claude_config_dir: str | None

    def to_governance(self) -> dict[str, object]:
        return {
            "passed": list(self.passed),
            "profile_passthrough": list(self.passthrough),
            "dropped_count": self.dropped_count,
            "dropped_secret_shaped": list(self.dropped_secret_shaped),
            "synthetic_home": self.home,
            "claude_config_dir_bound": self.claude_config_dir is not None,
        }


@dataclass(frozen=True)
class AgentEnv:
    env: dict[str, str] = field(default_factory=dict)
    report: AgentEnvReport | None = None


def derive_claude_config_dir(base: Mapping[str, str]) -> str | None:
    """Where the managed login lives, made explicit.

    ``CLAUDE_CONFIG_DIR`` wins when the runner set it. Otherwise the CLI's own
    default is ``$HOME/.claude`` of the REAL home — which the synthetic HOME
    would hide — so it is derived here from the real home and handed over by
    name. When neither an OAuth token nor a real home is available there is
    nothing to derive, and the spawn's auth preflight is what says so.
    """
    explicit = str(base.get("CLAUDE_CONFIG_DIR") or "").strip()
    if explicit:
        return explicit
    real_home = str(base.get("HOME") or "").strip()
    if not real_home:
        return None
    candidate = Path(real_home) / CLAUDE_CONFIG_DIRNAME
    return str(candidate) if candidate.is_dir() else None


def synthetic_home(*, tmp_root: str | Path | None = None, tag: str = "") -> Path:
    """A fresh, empty, private home for one spawn (0700)."""
    import tempfile

    root = Path(tmp_root) if tmp_root else Path(tempfile.gettempdir())
    root.mkdir(parents=True, exist_ok=True)
    home = Path(tempfile.mkdtemp(prefix=f"{SYNTHETIC_HOME_PREFIX}{tag}", dir=str(root)))
    for sub in ("xdg/config", "xdg/cache", "xdg/data", "xdg/state"):
        (home / sub).mkdir(parents=True, exist_ok=True)
    return home


def build_agent_env(
    base: Mapping[str, str],
    *,
    profile_passthrough: Sequence[str] = (),
    extra: Mapping[str, str] | None = None,
    home: str | Path | None = None,
    tmp_root: str | Path | None = None,
) -> AgentEnv:
    """Build the spawn environment from ``base`` (normally ``os.environ``).

    ``extra`` carries the per-spawn additions the caller computed (provider
    redirect variables, the IS_SANDBOX acknowledgement) — added AFTER the
    filter, because the caller chose them deliberately. ``home`` lets a
    caller reuse a synthetic home it already made; otherwise one is created.
    """
    allowed_exact = set(BASELINE_ENV_NAMES) | set(CLAUDE_AUTH_ENV_NAMES) | set(ARIA_RUNTIME_ENV_NAMES)
    passthrough = tuple(dict.fromkeys(str(name) for name in profile_passthrough if name))
    allowed_exact |= set(passthrough)

    env: dict[str, str] = {}
    passed: list[str] = []
    dropped_secret: list[str] = []
    dropped = 0
    for name, value in base.items():
        if name in allowed_exact:
            env[name] = value
            passed.append(name)
            continue
        if name.startswith(CLAUDE_CONFIG_ENV_PREFIX) and not SECRET_SHAPED_ENV_NAME.search(name):
            env[name] = value
            passed.append(name)
            continue
        dropped += 1
        if SECRET_SHAPED_ENV_NAME.search(name):
            dropped_secret.append(name)

    config_dir = derive_claude_config_dir(base)
    if config_dir and "CLAUDE_CONFIG_DIR" not in env:
        env["CLAUDE_CONFIG_DIR"] = config_dir
        passed.append("CLAUDE_CONFIG_DIR")

    home_path = Path(home) if home is not None else synthetic_home(tmp_root=tmp_root)
    env["HOME"] = str(home_path)
    env["XDG_CONFIG_HOME"] = str(home_path / "xdg" / "config")
    env["XDG_CACHE_HOME"] = str(home_path / "xdg" / "cache")
    env["XDG_DATA_HOME"] = str(home_path / "xdg" / "data")
    env["XDG_STATE_HOME"] = str(home_path / "xdg" / "state")
    env.setdefault("TMPDIR", str(home_path))
    if extra:
        for name, value in extra.items():
            env[str(name)] = str(value)
            passed.append(str(name))

    report = AgentEnvReport(
        passed=tuple(sorted(set(passed))),
        passthrough=passthrough,
        dropped_count=dropped,
        dropped_secret_shaped=tuple(sorted(set(dropped_secret))),
        home=str(home_path),
        claude_config_dir=env.get("CLAUDE_CONFIG_DIR"),
    )
    return AgentEnv(env=env, report=report)


def cleanup_synthetic_home(home: str | Path) -> None:
    """Remove a synthetic home this module created. Refuses anything else."""
    import shutil

    path = Path(home)
    if path.name.startswith(SYNTHETIC_HOME_PREFIX) and path.is_dir():
        shutil.rmtree(path, ignore_errors=True)


__all__ = [
    "ARIA_RUNTIME_ENV_NAMES",
    "AgentEnv",
    "AgentEnvReport",
    "BASELINE_ENV_NAMES",
    "CLAUDE_AUTH_ENV_NAMES",
    "CLAUDE_CONFIG_ENV_PREFIX",
    "SECRET_SHAPED_ENV_NAME",
    "build_agent_env",
    "cleanup_synthetic_home",
    "derive_claude_config_dir",
    "synthetic_home",
]
