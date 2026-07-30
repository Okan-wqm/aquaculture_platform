"""Stage S0 — the test suite's verdict must not depend on machine state.

Programme: docs/plans/2026-07-26-aria-software-team-program/PLAN.md

Every stage gate in that programme exits on "suite green". A suite that
can redden for reasons unrelated to the change under test is therefore
not a gate at all — it is the same defect class as a dashboard that
reports 21 blocked cycles as ``ok``.

The concrete leak these invariants close: the CI agent container sets
``commit.gpgsign = true`` with ``gpg.ssh.program = /tmp/code-sign`` in
its GLOBAL git configuration, so every fixture ``git commit`` invoked an
external harness-managed binary. Under concurrent load that returned
non-zero and three fixtures failed with exit 128, in tests about
evidence trust and executor lanes — nothing to do with signing.

  * I-HERM-01 — the hermetic config layers are active in this process
  * I-HERM-02 — the checked-in hermetic config disables commit signing
  * I-HERM-03 — a fixture repo resolves ``commit.gpgsign`` to false
  * I-HERM-04 — no external signing program is reachable from a fixture
  * I-HERM-05 — an inline ``git init`` + commit produces an UNSIGNED
                commit, i.e. the property holds for the ~30 test files
                that build repos without the fixture factory
  * I-HERM-06 — repo-LOCAL config still wins, so production code that
                enables signing on repos it owns stays observable
"""

from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path

from tests._helpers.hermetic_git import (
    HERMETIC_GITCONFIG,
    hermetic_git_env_is_active,
)


def _git(args: list[str], cwd: Path, *, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", *args], cwd=cwd, text=True, capture_output=True, check=check
    )


def _seed_repo(root: Path) -> None:
    """Build a repo the way the inline fixtures do — no factory, no config."""
    _git(["init", "-q"], root)
    (root / "seed.txt").write_text("seed\n", encoding="utf-8")
    _git(["add", "seed.txt"], root)
    _git(["commit", "-q", "-m", "seed"], root)


class SuiteGitHermeticityTests(unittest.TestCase):
    def test_i_herm_01_hermetic_config_layers_active(self) -> None:
        self.assertTrue(
            hermetic_git_env_is_active(),
            msg=(
                "GIT_CONFIG_GLOBAL/GIT_CONFIG_SYSTEM are not pointed at hermetic "
                "sources, so fixture repos inherit ambient global git config and "
                "the suite's verdict depends on machine state."
            ),
        )

    def test_i_herm_02_checked_in_config_disables_signing(self) -> None:
        """Read the file as git reads it — not as a substring search.

        The prose in that file names the ambient setting it exists to
        neutralize, so text matching would match the explanation rather
        than the configuration.
        """
        for key in ("commit.gpgsign", "tag.gpgsign"):
            resolved = subprocess.run(
                ["git", "config", "--file", str(HERMETIC_GITCONFIG), "--get", key],
                text=True, capture_output=True, check=False,
            )
            self.assertEqual(
                resolved.stdout.strip(), "false",
                msg=(
                    f"{key} is {resolved.stdout.strip()!r} in the checked-in hermetic "
                    "config; fixture commits would depend on a signing helper."
                ),
            )

    def test_i_herm_03_fixture_repo_resolves_gpgsign_false(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _git(["init", "-q"], root)
            resolved = _git(["config", "--get", "commit.gpgsign"], root, check=False)
            self.assertEqual(
                resolved.stdout.strip(), "false",
                msg=(
                    "a fixture repo resolves commit.gpgsign to "
                    f"{resolved.stdout.strip()!r}; ambient global config is leaking in."
                ),
            )

    def test_i_herm_04_no_external_signing_program_reachable(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _git(["init", "-q"], root)
            for key in ("gpg.ssh.program", "gpg.program", "user.signingkey"):
                probe = _git(["config", "--get", key], root, check=False)
                self.assertEqual(
                    probe.stdout.strip(), "",
                    msg=(
                        f"{key} resolves to {probe.stdout.strip()!r} inside a fixture "
                        "repo — a fixture commit would depend on an external binary "
                        "being present and responsive."
                    ),
                )

    def test_i_herm_05_inline_fixture_commit_is_unsigned(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _seed_repo(root)
            obj = _git(["cat-file", "commit", "HEAD"], root).stdout
            self.assertNotIn(
                "gpgsig", obj,
                msg=(
                    "an inline fixture commit carries a signature, so it invoked an "
                    "external signing helper. That helper's availability then decides "
                    "whether unrelated tests pass."
                ),
            )

    def test_i_herm_06_repo_local_signing_config_still_wins(self) -> None:
        """The hermetic layers must not mask repo-local intent.

        ``gh_token_factory.mint_signing_key`` sets ``--local commit.gpgsign
        true`` on repos ARIA owns. Overriding via GIT_CONFIG_KEY_* env
        vars would have outranked that and made the production behaviour
        untestable; redirecting the global layer does not.
        """
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _git(["init", "-q"], root)
            _git(["config", "--local", "commit.gpgsign", "true"], root)
            resolved = _git(["config", "--get", "commit.gpgsign"], root)
            self.assertEqual(resolved.stdout.strip(), "true")


if __name__ == "__main__":
    unittest.main()
