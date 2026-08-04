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

A second leak, of the same class but a different variable family, cost a
real repository: ``git`` exports an ABSOLUTE ``GIT_DIR`` into its own
environment whenever the git dir is not the default ``.git`` in cwd —
which is always true inside a linked worktree. A ``git push`` from such a
worktree therefore hands ``GIT_DIR=<repo>/.git/worktrees/<name>`` to
``.husky/pre-push``, which hands it to the kernel suite.

``cwd=`` selects the WORK TREE; ``GIT_DIR`` selects the REPOSITORY. So
every fixture that carefully passed ``cwd=<tempdir>`` — and they all do —
was still operating on the HOST repository: ``git init`` re-initialised
it (guessing ``core.bare=true``, because the exported path ends in the
worktree name rather than ``/.git``), ``git config`` wrote the host's
config, and ``git add``/``git commit`` staged temp files onto the host's
real index and HEAD.

  * I-HERM-07 — the repo-LOCATION variables are scrubbed from a supplied
                environment, not merely the two config-layer variables
  * I-HERM-08 — a leaked repo-location variable makes the hermetic
                environment report itself INACTIVE
  * I-HERM-09 — end-to-end: a child process that inherits ``GIT_DIR``
                pointing at a sentinel repo cannot touch that repo by
                building a fixture in a temp directory
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from tests._helpers.hermetic_git import (
    GIT_LOCATION_VARS,
    HERMETIC_GITCONFIG,
    apply_hermetic_git_env,
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


class SuiteGitRepositoryLocationHermeticityTests(unittest.TestCase):
    """The variables that decide WHICH repository a fixture writes to."""

    def test_i_herm_07_location_vars_are_scrubbed(self) -> None:
        leaked = {var: "/somewhere/else/.git" for var in GIT_LOCATION_VARS}
        leaked["PATH"] = os.environ.get("PATH", "")
        apply_hermetic_git_env(leaked)
        still_set = sorted(var for var in GIT_LOCATION_VARS if var in leaked)
        self.assertEqual(
            still_set, [],
            msg=(
                f"{still_set} survived the hermetic environment. cwd= selects the "
                "work tree, not the repository, so any of these left in place "
                "redirects every fixture's writes to whatever repo it names."
            ),
        )
        self.assertEqual(leaked["PATH"], os.environ.get("PATH", ""))

    def test_i_herm_08_a_leaked_location_var_reports_inactive(self) -> None:
        """Absence must be part of the definition, not an unstated assumption.

        The predicate is what other tests and future callers ask. If it can
        answer "active" while GIT_DIR points at the host repository, it is
        answering a narrower question than its name promises.
        """
        for var in GIT_LOCATION_VARS:
            env = {
                "GIT_CONFIG_GLOBAL": str(HERMETIC_GITCONFIG),
                "GIT_CONFIG_SYSTEM": os.devnull,
                var: "/somewhere/else/.git",
            }
            self.assertFalse(
                hermetic_git_env_is_active(env),
                msg=f"{var} is set, yet the environment reports itself hermetic.",
            )

    def test_i_herm_09_inherited_git_dir_cannot_reach_the_host_repo(self) -> None:
        """The real incident, reproduced end to end and then prevented.

        A child process is given ``GIT_DIR`` pointing at a sentinel repo —
        exactly what ``git push`` hands its hooks from a linked worktree —
        and then builds a fixture repo in a temp directory the way ~30 test
        files do. The sentinel must be untouched: same HEAD, no new commits,
        no config written into it.
        """
        with tempfile.TemporaryDirectory() as tmp:
            sentinel = Path(tmp) / "sentinel"
            sentinel.mkdir()
            _seed_repo(sentinel)
            before_head = _git(["rev-parse", "HEAD"], sentinel).stdout.strip()
            before_count = _git(["rev-list", "--count", "HEAD"], sentinel).stdout.strip()

            fixture_dir = Path(tmp) / "fixture"
            fixture_dir.mkdir()
            child = subprocess.run(
                [
                    sys.executable, "-c",
                    # Importing `tests` installs the hermetic environment; the
                    # git calls below then run exactly as a fixture's would.
                    "import subprocess,sys;"
                    "import tests;"
                    "d=sys.argv[1];"
                    "r=lambda *a: subprocess.run(['git',*a],cwd=d,check=True,"
                    "capture_output=True);"
                    "r('init','-q');"
                    "open(d+'/leak.txt','w').write('x');"
                    "r('add','leak.txt');"
                    "r('-c','user.email=t@t.invalid','-c','user.name=t',"
                    "'commit','-q','-m','fixture leak probe')",
                    str(fixture_dir),
                ],
                cwd=Path(__file__).resolve().parents[1],
                env={
                    **os.environ,
                    "GIT_DIR": str(sentinel / ".git"),
                    "PYTHONPATH": str(Path(__file__).resolve().parents[1]),
                },
                text=True, capture_output=True,
            )
            self.assertEqual(child.returncode, 0, msg=child.stderr)

            after_head = _git(["rev-parse", "HEAD"], sentinel).stdout.strip()
            after_count = _git(["rev-list", "--count", "HEAD"], sentinel).stdout.strip()
            self.assertEqual(
                (after_head, after_count), (before_head, before_count),
                msg=(
                    "a fixture built in a temp directory moved the SENTINEL "
                    "repository's HEAD. An inherited GIT_DIR outranks cwd=, so the "
                    "fixture wrote into whatever repository that variable named — "
                    "in the real incident, the developer's own checkout."
                ),
            )
            self.assertTrue(
                (fixture_dir / ".git").exists(),
                msg="the fixture never got its own repository",
            )


if __name__ == "__main__":
    unittest.main()
