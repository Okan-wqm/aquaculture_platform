"""ARIA-HIGH-234 / ARIA-LOW-447 — what the environment injects into git has one owner.

git reads configuration from the environment: the ``GIT_CONFIG_COUNT`` /
``GIT_CONFIG_KEY_n`` / ``GIT_CONFIG_VALUE_n`` triple, the ``-c`` export
``GIT_CONFIG_PARAMETERS``, and ``GIT_CONFIG``, the file ``git config`` reads
and writes. A CI step carries an ``AUTHORIZATION: basic`` header in that
triple. Four modules each kept their own list of these names to strip, and
the seams that kept none (``pr_manager``'s ``gh pr create``, ``self_revert``'s
push) handed the ambient set to the child.

``git_containment`` now owns both directions: ``without_ambient_git_config``
strips the ambient set, and ``git_config_environment`` spells the kernel's own
env-only configuration (the delivery's credential helper). This pin fails any
other production module that names one of these variables, so a second list,
and a seam that builds its own, cannot come back unnoticed.

ARIA-LOW-447 — the same owner strips the variables that redirect git rather
than configure it: the program it runs (``GIT_EXEC_PATH``, ``GIT_SSH*``,
``GIT_PROXY_COMMAND``, ``GIT_EXTERNAL_DIFF``), where it asks for a credential
(``GIT_ASKPASS``, ``SSH_ASKPASS``), whom the transport trusts (``GIT_SSL_*``,
``GIT_PROXY_SSL_*``), what a new repository starts with (``GIT_TEMPLATE_DIR``)
and whether a trace prints the credential (``GIT_TRACE_REDACT``). The state
store's git keeps its step's ``GIT_CONFIG_*`` credential and drops only these
(``without_ambient_git_redirects``).
"""
from __future__ import annotations

import ast
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from tests._helpers.ambient_git_config import AMBIENT_GIT_CONFIG, injected_git_config, injected_git_redirects

_REPO_ROOT = Path(__file__).resolve().parents[3]
_SCANNED = ("aria-kernel/aria_kernel", "tools/aria-poc", "tools/aria")
_OWNER = "aria-kernel/aria_kernel/git_containment.py"
_NAMES = frozenset({
    "GIT_CONFIG", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS",
    "GIT_EXEC_PATH", "GIT_SSH", "GIT_SSH_COMMAND", "GIT_PROXY_COMMAND", "GIT_EXTERNAL_DIFF",
    "GIT_ASKPASS", "SSH_ASKPASS", "GIT_TEMPLATE_DIR", "GIT_TRACE_REDACT",
})
_PREFIXES = ("GIT_CONFIG_KEY_", "GIT_CONFIG_VALUE_", "GIT_SSL_", "GIT_PROXY_SSL_")
# Spellings the ambient set in tests/_helpers leaves out because a kernel call
# outside the seams would run them (`self_revert`'s `git diff`), or that it
# covers by one member of a prefix.
_MORE_REDIRECTS = {"GIT_EXTERNAL_DIFF": "/bin/false", "GIT_SSL_KEY": "/k.pem", "GIT_SSL_CERT": "/c.pem",
                   "GIT_SSL_CAPATH": "/ca", "GIT_PROXY_SSL_CERT": "/p.pem"}
# What the owner keeps: none of it can point git at another program, endpoint,
# credential source or configuration (ARIA-LOW-447, measured on git 2.43).
_KEPT = {
    "PATH": "/usr/bin", "HOME": "/home/op", "GIT_CONFIG_GLOBAL": "/home/op/.gitconfig",
    "GIT_CEILING_DIRECTORIES": "/home",  # only stops discovery
    "GIT_TRACE": "/tmp/trace", "GIT_TRACE_CURL": "/tmp/curl",  # redacted while GIT_TRACE_REDACT is absent
    "GIT_TERMINAL_PROMPT": "0",  # only disables prompts
    "GIT_EDITOR": "vi", "GIT_PAGER": "less",  # never run by a call with a message and no tty
    "https_proxy": "http://proxy:3128",  # host network plumbing, as for every child
}


def _sources() -> list[tuple[str, ast.AST]]:
    out = []
    for root in _SCANNED:
        for path in sorted((_REPO_ROOT / root).rglob("*.py")):
            relative = path.relative_to(_REPO_ROOT).as_posix()
            if "/tests/" not in relative:
                out.append((relative, ast.parse(path.read_text(encoding="utf-8"))))
    return out


def offenders(sources: list[tuple[str, ast.AST]]) -> list[str]:
    """Every string literal outside the owner that names an env-borne git config variable.

    An f-string's literal parts are constants too, so ``f"GIT_CONFIG_KEY_{n}"``
    is caught; a docstring or comment that merely mentions a name is not a
    literal equal to it.
    """
    return [
        f"{relative}:{node.lineno}:{node.value}"
        for relative, tree in sources if relative != _OWNER
        for node in ast.walk(tree)
        if isinstance(node, ast.Constant) and isinstance(node.value, str)
        and (node.value in _NAMES or node.value.startswith(_PREFIXES))
    ]


class GitConfigEnvironmentHasOneOwner(unittest.TestCase):
    def test_no_module_but_the_owner_names_an_env_borne_git_config_variable(self) -> None:
        self.assertEqual(offenders(_sources()), [])

    def test_every_spelling_of_a_second_list_is_caught(self) -> None:
        forged = ast.parse(
            "DENY = frozenset({'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG'})\n"
            "PREFIXES = ('GIT_CONFIG_KEY_', 'GIT_CONFIG_VALUE_')\n"
            "env[f'GIT_CONFIG_KEY_{n}'] = key\n"
            "REDIRECTS = ('GIT_EXEC_PATH', 'GIT_SSH_COMMAND', 'SSH_ASKPASS', 'GIT_TRACE_REDACT')\n"
            "env.pop(f'GIT_SSL_{x}')\n"
        )
        self.assertEqual(len(offenders([("aria-kernel/aria_kernel/forged.py", forged)])), 11)
        self.assertEqual(offenders([(_OWNER, forged)]), [])

    def test_the_owner_strips_every_ambient_spelling_and_keeps_the_rest(self) -> None:
        from aria_kernel.git_containment import without_ambient_git_config

        env = without_ambient_git_config({**AMBIENT_GIT_CONFIG, **_MORE_REDIRECTS, **_KEPT})
        self.assertEqual(env, _KEPT)

    def test_the_owner_spells_the_kernel_s_own_configuration(self) -> None:
        from aria_kernel.delivery_credentials import GIT_CREDENTIAL_HELPER_ENV
        from aria_kernel.git_containment import git_config_environment

        self.assertEqual(git_config_environment({"credential.helper": "!gh auth git-credential", "a.b": "c"}), {
            "GIT_CONFIG_COUNT": "2",
            "GIT_CONFIG_KEY_0": "credential.helper", "GIT_CONFIG_VALUE_0": "!gh auth git-credential",
            "GIT_CONFIG_KEY_1": "a.b", "GIT_CONFIG_VALUE_1": "c",
        })
        # The delivery's credential helper is spelled through the owner, unchanged.
        self.assertEqual(GIT_CREDENTIAL_HELPER_ENV, {
            "GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "credential.helper",
            "GIT_CONFIG_VALUE_0": "!gh auth git-credential",
        })


class TheStoreKeepsItsStepCredentialAndNoRedirect(unittest.TestCase):
    """ARIA-LOW-447 — the state store's git (one spawn, `_run_git_bytes_bounded`)
    publishes with the `GIT_CONFIG_*` credential its workflow step sets on
    purpose (aria-auto-cycle.yml, aria-agent-executor.yml), so it keeps that,
    and drops every redirect: a planted helper would otherwise run with the
    step's credential in its environment."""

    def test_the_store_child_keeps_the_config_credential_and_no_redirect(self) -> None:
        from aria_kernel import state_store

        seen: list[dict[str, str]] = []
        real_popen = subprocess.Popen

        def recording_popen(*args, **kwargs):
            seen.append(dict(kwargs.get("env") or {}))
            return real_popen(*args, **kwargs)

        with tempfile.TemporaryDirectory() as tmp:
            subprocess.run(["git", "init", "-q", tmp], check=True)
            with mock.patch.dict(os.environ, {**AMBIENT_GIT_CONFIG, **_MORE_REDIRECTS}), \
                    mock.patch.object(state_store.subprocess, "Popen", side_effect=recording_popen):
                done = state_store._run_git(Path(tmp), ("rev-parse", "--git-dir"))
        self.assertEqual(done.returncode, 0, done.stderr)
        [env] = seen
        self.assertEqual(injected_git_redirects(env), {})
        self.assertEqual({name: env[name] for name in injected_git_config(env)},
                         {name: value for name, value in AMBIENT_GIT_CONFIG.items() if name.startswith("GIT_CONFIG")})


if __name__ == "__main__":
    unittest.main()
