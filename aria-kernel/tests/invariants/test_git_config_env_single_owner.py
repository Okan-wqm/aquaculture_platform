"""ARIA-HIGH-234 — git configuration carried in the environment has one owner.

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
"""
from __future__ import annotations

import ast
import unittest
from pathlib import Path

from tests._helpers.ambient_git_config import AMBIENT_GIT_CONFIG

_REPO_ROOT = Path(__file__).resolve().parents[3]
_SCANNED = ("aria-kernel/aria_kernel", "tools/aria-poc", "tools/aria")
_OWNER = "aria-kernel/aria_kernel/git_containment.py"
_NAMES = frozenset({"GIT_CONFIG", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS"})
_PREFIXES = ("GIT_CONFIG_KEY_", "GIT_CONFIG_VALUE_")


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
        )
        self.assertEqual(len(offenders([("aria-kernel/aria_kernel/forged.py", forged)])), 6)
        self.assertEqual(offenders([(_OWNER, forged)]), [])

    def test_the_owner_strips_every_ambient_spelling_and_keeps_the_rest(self) -> None:
        from aria_kernel.git_containment import without_ambient_git_config

        env = without_ambient_git_config({**AMBIENT_GIT_CONFIG, "PATH": "/usr/bin",
                                          "GIT_CONFIG_GLOBAL": "/home/op/.gitconfig"})
        self.assertEqual(env, {"PATH": "/usr/bin", "GIT_CONFIG_GLOBAL": "/home/op/.gitconfig"})

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


if __name__ == "__main__":
    unittest.main()
