"""ARIA-HIGH-234 — the git configuration a host step injects through the environment.

A CI publish step carries an ``AUTHORIZATION: basic`` header in
``GIT_CONFIG_VALUE_0``; a ``url.*.insteadOf`` rewrite rides the same triple;
git exports its own ``-c`` options to children as ``GIT_CONFIG_PARAMETERS``;
and ``GIT_CONFIG`` names the file ``git config`` reads and writes. Every seam
that builds a git or ``gh`` child's environment from the ambient one is tested
with all of it set, and must pass none of it on
(``git_containment.without_ambient_git_config``).
"""
from __future__ import annotations

from collections.abc import Mapping

AMBIENT_GIT_CONFIG: dict[str, str] = {
    "GIT_CONFIG_COUNT": "2",
    "GIT_CONFIG_KEY_0": "http.https://github.com/.extraheader",
    "GIT_CONFIG_VALUE_0": "AUTHORIZATION: basic eDphbWJpZW50",
    "GIT_CONFIG_KEY_1": "url.https://mirror.invalid/.insteadOf",
    "GIT_CONFIG_VALUE_1": "https://github.com/",
    "GIT_CONFIG_PARAMETERS": "'http.https://github.com/.extraheader'='AUTHORIZATION: basic eDpwYXJhbXM='",
    "GIT_CONFIG": "/nonexistent/ambient.gitconfig",
}

# git's redirects of its config FILES. The hermetic suite sets them on
# purpose (``hermetic_git.py``); they inject no configuration of their own.
_CONFIG_FILE_REDIRECTS: frozenset[str] = frozenset({"GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM"})


def injected_git_config(env: Mapping[str, str]) -> dict[str, str]:
    """Every variable in ``env`` that injects git configuration, with its value."""
    return {name: value for name, value in env.items()
            if name.startswith("GIT_CONFIG") and name not in _CONFIG_FILE_REDIRECTS}
