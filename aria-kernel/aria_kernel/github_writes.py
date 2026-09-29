"""ARIA-CRITICAL-246 — the one door every kernel write to GitHub goes through.

WHY: an operator approval is an act on GitHub by an account listed in
``docs/aria/policy/operators.json``. ``operator_approval.verify_operator_approval``
accepts a comment or review whose author is one of those logins and whose type
is ``User``. A write the kernel makes with a user's credential is authored by
that user. The lanes exported the operator's PAT as the ambient ``GH_TOKEN``, and
the operator's own terminal holds the operator's ``gh`` login, so every kernel
write (a notice comment, an issue body, a PR) could be authored as the operator.
A comment that carried an ``ARIA-APPROVE`` line would then be the approval the
kernel went on to verify.

WHAT: a kernel write runs only on a GitHub App installation token: the job
token, or an App token the kernel minted for a delivery. GitHub authors those
writes as a Bot, and the verifier refuses a Bot by construction. The class of a
credential is read from its own prefix. In GitHub's token format ``ghs_`` is a
server-to-server installation token, and ``ghp_``, ``github_pat_``, ``gho_`` and
``ghu_`` act as a user. The check makes no network call. It refuses by name
anything it cannot classify, including an environment with no token, where
``gh`` would fall back to its stored login.

``tests/test_github_write_paths.py`` fails any ``gh`` write argv in the kernel
that is not handed to :func:`run_gh_write`.
"""
from __future__ import annotations

import os
import subprocess
from pathlib import Path
from typing import Callable, Mapping, Sequence

from .tool_registry import GovernanceError

INSTALLATION_TOKEN_CLASS = "installation"

# GitHub's token format (2021). Every prefix but ``ghs_`` names a credential
# that acts as a user account.
_TOKEN_CLASSES: tuple[tuple[str, str], ...] = (
    ("ghs_", INSTALLATION_TOKEN_CLASS),
    ("ghp_", "personal_access_token"),
    ("github_pat_", "fine_grained_personal_access_token"),
    ("gho_", "oauth_user_token"),
    ("ghu_", "user_to_server_token"),
)

Runner = Callable[..., "subprocess.CompletedProcess[str]"]


class GitHubWriteRefused(GovernanceError):
    """A kernel write to GitHub would not run on an installation token."""


def credential_class(environ: Mapping[str, str]) -> str:
    """The class of the credential ``gh`` would use in ``environ``.

    ``gh`` reads ``GH_TOKEN`` first and then ``GITHUB_TOKEN``. With neither set
    it uses its stored login, whose account this module cannot see, so that
    case is ``absent``.
    """
    token = (environ.get("GH_TOKEN") or environ.get("GITHUB_TOKEN") or "").strip()
    if not token:
        return "absent"
    for prefix, name in _TOKEN_CLASSES:
        if token.startswith(prefix):
            return name
    return "unrecognised"


def require_installation_credential(environ: Mapping[str, str]) -> None:
    """Refuse by name unless ``environ`` makes ``gh`` write as an installation."""
    found = credential_class(environ)
    if found != INSTALLATION_TOKEN_CLASS:
        raise GitHubWriteRefused(f"github_write_requires_installation_token:{found}")


def run_gh_write(
    args: Sequence[str],
    *,
    env: Mapping[str, str] | None = None,
    cwd: str | Path | None = None,
    timeout: float | None = None,
    runner: Runner | None = None,
) -> "subprocess.CompletedProcess[str]":
    """Run ``gh <args>`` as a write, on an installation token or not at all.

    ``env`` is the complete environment of the child, as with
    ``subprocess.run``. ``None`` means this process's environment. The check
    reads that same mapping, so the credential it classifies is the one
    ``gh`` will use.
    """
    environ = dict(os.environ) if env is None else dict(env)
    require_installation_credential(environ)
    run = runner or subprocess.run
    return run(
        ["gh", *args], cwd=cwd, env=environ, capture_output=True, text=True, check=False, timeout=timeout,
    )


__all__ = (
    "INSTALLATION_TOKEN_CLASS",
    "GitHubWriteRefused",
    "credential_class",
    "require_installation_credential",
    "run_gh_write",
)
