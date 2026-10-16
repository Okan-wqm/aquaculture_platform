"""ARIA-HIGH-234 / ARIA-LOW-447 — what a host step can inject into git through the environment.

A CI publish step carries an ``AUTHORIZATION: basic`` header in
``GIT_CONFIG_VALUE_0``; a ``url.*.insteadOf`` rewrite rides the same triple;
git exports its own ``-c`` options to children as ``GIT_CONFIG_PARAMETERS``;
and ``GIT_CONFIG`` names the file ``git config`` reads and writes. Beside the
configuration, git reads variables that change which program it runs
(``GIT_EXEC_PATH``, ``GIT_SSH*``, ``GIT_PROXY_COMMAND``), where it asks for a
credential (``GIT_ASKPASS``, ``SSH_ASKPASS``), whom the transport trusts
(``GIT_SSL_*``, ``GIT_PROXY_SSL_*``), what a new repository starts with
(``GIT_TEMPLATE_DIR``) and whether a trace prints the credential
(``GIT_TRACE_REDACT``). Every seam that builds a git or ``gh`` child's
environment from the ambient one is tested with all of it set, and must pass
none of it on (``git_containment.without_ambient_git_config``).

The redirect values here are inert for the local transports the tests use
(the real exec path, programs a local push never runs), so a kernel call
outside the seams that inherits them still works; the seams are judged by
the NAMES their children receive.
"""
from __future__ import annotations

import subprocess
from collections.abc import Mapping

_EXEC_PATH = subprocess.run(["git", "--exec-path"], capture_output=True, text=True, check=True).stdout.strip()

AMBIENT_GIT_CONFIG: dict[str, str] = {
    "GIT_CONFIG_COUNT": "2",
    "GIT_CONFIG_KEY_0": "http.https://github.com/.extraheader",
    "GIT_CONFIG_VALUE_0": "AUTHORIZATION: basic eDphbWJpZW50",
    "GIT_CONFIG_KEY_1": "url.https://mirror.invalid/.insteadOf",
    "GIT_CONFIG_VALUE_1": "https://github.com/",
    "GIT_CONFIG_PARAMETERS": "'http.https://github.com/.extraheader'='AUTHORIZATION: basic eDpwYXJhbXM='",
    "GIT_CONFIG": "/nonexistent/ambient.gitconfig",
    # ARIA-LOW-447 — the redirects.
    "GIT_EXEC_PATH": _EXEC_PATH,
    "GIT_SSH": "/bin/false",
    "GIT_SSH_COMMAND": "false",
    "GIT_PROXY_COMMAND": "/bin/false",
    "GIT_ASKPASS": "/bin/false",
    "SSH_ASKPASS": "/bin/false",
    "GIT_SSL_NO_VERIFY": "1",
    "GIT_SSL_CAINFO": "/nonexistent/ambient-ca.pem",
    "GIT_PROXY_SSL_CAINFO": "/nonexistent/ambient-proxy-ca.pem",
    "GIT_TEMPLATE_DIR": "/nonexistent/ambient-templates",
    "GIT_TRACE_REDACT": "0",
}

# git's redirects of its config FILES. The hermetic suite sets them on
# purpose (``hermetic_git.py``); they reach no further than HOME does.
_CONFIG_FILE_REDIRECTS: frozenset[str] = frozenset({"GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM"})
_REDIRECT_NAMES: frozenset[str] = frozenset({
    "GIT_EXEC_PATH", "GIT_SSH", "GIT_SSH_COMMAND", "GIT_PROXY_COMMAND", "GIT_EXTERNAL_DIFF",
    "GIT_ASKPASS", "SSH_ASKPASS", "GIT_TEMPLATE_DIR", "GIT_TRACE_REDACT",
})
_REDIRECT_PREFIXES: tuple[str, ...] = ("GIT_SSL_", "GIT_PROXY_SSL_")


def injected_git_redirects(env: Mapping[str, str]) -> dict[str, str]:
    """Every variable in ``env`` that redirects git's program lookup, transport,
    credential prompt, new-repository template or trace redaction."""
    return {name: value for name, value in env.items()
            if name in _REDIRECT_NAMES or name.startswith(_REDIRECT_PREFIXES)}


def injected_git_config(env: Mapping[str, str]) -> dict[str, str]:
    """Every variable in ``env`` that injects git configuration or redirects git, with its value."""
    return {**{name: value for name, value in env.items()
               if name.startswith("GIT_CONFIG") and name not in _CONFIG_FILE_REDIRECTS},
            **injected_git_redirects(env)}
