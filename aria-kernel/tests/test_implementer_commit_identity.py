"""ARIA-HIGH-387 — the implementation commit carries the kernel's named identity.

The first plan ARIA converged on its own (F-013) reached its implementer, was
applied and validated green, and then never became a commit: `git commit`
exited 128 "Author identity unknown". The mint wired SIGNING into the request
worktree (`gh_token_factory._SIGNING_CONFIG_KEYS`) and nothing wired
AUTHORSHIP; the runner host has no global identity, the sandbox's HOME is an
empty tmpfs, and the agent is refused every route to choose one
(`command_policy`: `git config`, `--author`, `-S`). The suite never saw it:
`tests/_helpers/hermetic.gitconfig` hands every test process a global
`user.name`.

These pins run with NO ambient identity — a global config that only says
`user.useConfigOnly = true` (git must not guess one from the host name, the
way it does on a host whose name has a domain), HOME an empty directory, and
no `GIT_AUTHOR_*` / `GIT_COMMITTER_*` / `EMAIL` — and hold:

* the reproduction: a commit in the held worktree fails rc=128 on main and
  lands, authored AND committed by `aria-implementer`, after the fix;
* the identity rides the signing transaction: a pre-existing `user.name` /
  `user.email` in the transaction's scope comes back exactly on revoke and
  on the crash path's startup prune, a section the mint created is removed
  again, and a mint that names no identity (the knowledge signer) never
  touches the operator's;
* the hold refuses by name, before any agent, registry row or turn, when the
  tree does not resolve the kernel's identity — and unwinds the mint.
"""
from __future__ import annotations

import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aria_kernel import gh_token_factory
from aria_kernel.implementation_identity import ImplementationIdentityRefusal, hold_implementation_identity
from aria_kernel.tool_registry import ensure_tools_binding

from tests._helpers.git_fixtures import _git, make_git_worktree, make_repo_with_initial_commit

CYCLE_ID = "cyc-identity-387"
# Spelled out rather than imported, so the reproduction runs unchanged
# against a kernel that predates the constants.
KERNEL_IDENTITY = "aria-implementer <aria-implementer@users.noreply.github.com>"
_AMBIENT_IDENTITY_NAMES = (
    "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "EMAIL",
)


class _NoAmbientIdentity(unittest.TestCase):
    """Fixture repos are built under the suite's hermetic config; the code
    under test then runs with no identity anywhere but the checkout."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-387-")).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.main = self._repo_without_identity(self.tmp, "main")
        self.tools = ensure_tools_binding(self.main / "aria-tools", workspace_root=self.main)
        home = self.tmp / "empty-home"
        home.mkdir()
        no_identity = self.tmp / "no-identity.gitconfig"
        no_identity.write_text(
            "[user]\n\tuseConfigOnly = true\n[commit]\n\tgpgsign = false\n[gc]\n\tauto = 0\n", encoding="utf-8",
        )
        self._no_identity_env = {"HOME": str(home), "GIT_CONFIG_GLOBAL": str(no_identity)}

    @staticmethod
    def _repo_without_identity(parent: Path, name: str) -> Path:
        """A fixture repo whose own config names no identity either: the
        factory writes a `--local` one, which every worktree inherits and
        which would mask the defect exactly as the hermetic global does."""
        repo = make_repo_with_initial_commit(parent, {f"{name}.txt": "x\n"}, name=name)
        _git(["config", "--local", "--remove-section", "user"], cwd=repo)
        return repo

    def _enter_no_identity(self) -> None:
        env = patch.dict(os.environ, self._no_identity_env)
        env.start()
        self.addCleanup(env.stop)
        for name in _AMBIENT_IDENTITY_NAMES:
            if name in os.environ:
                popped = os.environ.pop(name)
                self.addCleanup(os.environ.__setitem__, name, popped)

    def _worktree(self, name: str = "req-1") -> Path:
        return make_git_worktree(self.main, self.tmp / "worktrees" / name, branch=name)

    def _scoped(self, checkout: Path, scope: str) -> list[str]:
        """Every entry of ONE config scope, in file order."""
        done = _git(["config", scope, "--list"], cwd=checkout, check=False)
        return done.stdout.splitlines() if done.returncode == 0 else []

    def _commit(self, worktree: Path, message: str):
        (worktree / f"{message}.txt").write_text(message + "\n", encoding="utf-8")
        _git(["add", "-A"], cwd=worktree)
        return _git(["commit", "-q", "-m", message], cwd=worktree, check=False)


class TheHeldWorktreeCanCommitTests(_NoAmbientIdentity):
    def test_a_plain_commit_in_the_held_worktree_is_by_the_kernels_identity(self) -> None:
        worktree = self._worktree()
        self._enter_no_identity()
        unconfigured = _git(["var", "GIT_AUTHOR_IDENT"], cwd=worktree, check=False)
        self.assertEqual(unconfigured.returncode, 128, "the fixture must have no identity to find")
        with hold_implementation_identity(
            cycle_id=CYCLE_ID, workspace_root=worktree, base_dir=self.tools,
        ) as identity:
            done = self._commit(worktree, "applied")
            self.assertEqual(done.returncode, 0, f"git commit refused: {done.stderr.strip()[:300]}")
            idents = _git(["log", "-1", "--format=%an <%ae>%n%cn <%ce>"], cwd=worktree).stdout.splitlines()
            self.assertEqual(idents, [KERNEL_IDENTITY, KERNEL_IDENTITY])
            verified = _git(["verify-commit", "--raw", "HEAD"], cwd=worktree, check=False)
            self.assertEqual(verified.returncode, 0, verified.stderr)
            self.assertIn(identity.fingerprint, verified.stderr + verified.stdout, "still signed by the cycle key")
        self.assertEqual(_git(["var", "GIT_AUTHOR_IDENT"], cwd=worktree, check=False).returncode, 128,
                         "the revoke takes the identity back out of the worktree")
        self.assertEqual(self._scoped(worktree, "--worktree"), [])

    def test_a_mint_that_names_no_identity_cannot_produce_a_commit_object(self) -> None:
        """The defect, at the factory: signing wired, authorship not."""
        worktree = self._worktree()
        self._enter_no_identity()
        gh_token_factory.mint_signing_key(cycle_id=CYCLE_ID, workspace_root=worktree)
        try:
            refused = self._commit(worktree, "unauthored")
            self.assertEqual(refused.returncode, 128)
            self.assertIn("Author identity unknown", refused.stderr)
        finally:
            gh_token_factory.revoke_signing_key(cycle_id=CYCLE_ID, workspace_root=worktree)


class TheIdentityRidesTheSigningTransactionTests(_NoAmbientIdentity):
    def setUp(self) -> None:
        super().setUp()
        self.IDENTITY = gh_token_factory.GitCommitIdentity(
            name="aria-implementer", email="aria-implementer@users.noreply.github.com",
        )

    def test_a_pre_existing_worktree_identity_comes_back_exactly(self) -> None:
        worktree = self._worktree()
        _git(["config", "--local", "extensions.worktreeConfig", "true"], cwd=self.main)
        _git(["config", "--worktree", "user.name", "Operator Name"], cwd=worktree)
        _git(["config", "--worktree", "user.email", "operator@example.com"], cwd=worktree)
        before = self._scoped(worktree, "--worktree")
        self._enter_no_identity()
        key = gh_token_factory.mint_signing_key(
            cycle_id=CYCLE_ID, workspace_root=worktree, commit_identity=self.IDENTITY,
        )
        self.assertTrue(key.git_signing.configured, key.git_signing)
        held = dict(line.split("=", 1) for line in self._scoped(worktree, "--worktree"))
        self.assertEqual((held["user.name"], held["user.email"]), (self.IDENTITY.name, self.IDENTITY.email))
        receipt = gh_token_factory.revoke_signing_key(cycle_id=CYCLE_ID, workspace_root=worktree)
        self.assertEqual(receipt["git_signing_config_restore"], "restored")
        self.assertEqual(self._scoped(worktree, "--worktree"), before)

    def test_a_main_checkout_is_refused_an_identity_before_any_write(self) -> None:
        """N3 — the shared `--local` config every worktree inherits never
        receives a commit identity: refused before the key, the snapshot or
        a config write exists."""
        _git(["config", "--local", "user.name", "Operator Name"], cwd=self.main)
        before = self._scoped(self.main, "--local")
        self._enter_no_identity()
        with self.assertRaises(gh_token_factory.CommitIdentityScopeRefused) as refused:
            gh_token_factory.mint_signing_key(
                cycle_id=CYCLE_ID, workspace_root=self.main, commit_identity=self.IDENTITY,
            )
        self.assertEqual(str(refused.exception), "commit_identity_requires_linked_worktree:--local")
        self.assertIsInstance(refused.exception, ValueError, "the holders' mint-failure class")
        self.assertFalse((self.main / "aria-debts").exists(), "no key file")
        self.assertFalse((self.main / ".git" / "aria-signing-config-snapshots").exists(), "no snapshot")
        self.assertEqual(self._scoped(self.main, "--local"), before)
        plain = self.tmp / "plain"
        plain.mkdir()
        with self.assertRaises(gh_token_factory.CommitIdentityScopeRefused) as not_a_checkout:
            gh_token_factory.mint_signing_key(cycle_id=CYCLE_ID, workspace_root=plain, commit_identity=self.IDENTITY)
        self.assertEqual(str(not_a_checkout.exception), "commit_identity_requires_linked_worktree:not_a_checkout")

    def test_a_section_the_mint_created_is_removed_header_and_all(self) -> None:
        worktree = self._worktree()
        self._enter_no_identity()
        gh_token_factory.mint_signing_key(cycle_id=CYCLE_ID, workspace_root=worktree, commit_identity=self.IDENTITY)
        config_worktree = gh_token_factory.signing_checkout(worktree).git_dir / "config.worktree"
        self.assertIn("[user]", config_worktree.read_text(encoding="utf-8"))
        gh_token_factory.revoke_signing_key(cycle_id=CYCLE_ID, workspace_root=worktree)
        self.assertEqual(self._scoped(worktree, "--worktree"), [])
        self.assertNotIn("[user]", config_worktree.read_text(encoding="utf-8"))

    def test_a_mint_without_an_identity_never_touches_the_operators(self) -> None:
        """The knowledge signer's mint: the operator renames themselves
        mid-window, and the revoke must not put the old name back."""
        _git(["config", "--local", "user.name", "Before"], cwd=self.main)
        self._enter_no_identity()
        gh_token_factory.mint_signing_key(cycle_id=CYCLE_ID, workspace_root=self.main)
        snapshot = gh_token_factory._signing_config_snapshot_path(self.main / ".git", CYCLE_ID)
        self.assertNotIn("user.name", snapshot.read_text(encoding="utf-8"))
        _git(["config", "--local", "user.name", "Renamed"], cwd=self.main)
        gh_token_factory.revoke_signing_key(cycle_id=CYCLE_ID, workspace_root=self.main)
        self.assertEqual(_git(["config", "--local", "--get", "user.name"], cwd=self.main).stdout.strip(), "Renamed")

    def test_the_startup_prune_restores_the_identity_a_crashed_holder_left(self) -> None:
        worktree = self._worktree()
        _git(["config", "--local", "extensions.worktreeConfig", "true"], cwd=self.main)
        _git(["config", "--worktree", "user.name", "Operator Name"], cwd=worktree)
        before = self._scoped(worktree, "--worktree")
        self._enter_no_identity()
        gh_token_factory.mint_signing_key(cycle_id=CYCLE_ID, workspace_root=worktree, commit_identity=self.IDENTITY)
        # The lane's pre-clean wipes the gitignored keys dir; the snapshot
        # in the private git dir survives it.
        shutil.rmtree(worktree / "aria-debts" / "keys")
        summary = gh_token_factory.prune_stale_signing_keys(workspace_root=worktree)
        self.assertEqual(summary["git_signing_config_restored"], [CYCLE_ID])
        self.assertEqual(self._scoped(worktree, "--worktree"), before)

    def test_a_re_mint_inside_an_open_transaction_records_the_identity_it_adds(self) -> None:
        worktree = self._worktree()
        _git(["config", "--local", "extensions.worktreeConfig", "true"], cwd=self.main)
        _git(["config", "--worktree", "user.name", "Operator Name"], cwd=worktree)
        before = self._scoped(worktree, "--worktree")
        self._enter_no_identity()
        gh_token_factory.mint_signing_key(cycle_id=CYCLE_ID, workspace_root=worktree)
        gh_token_factory.mint_signing_key(
            cycle_id=CYCLE_ID, workspace_root=worktree, overwrite=True, commit_identity=self.IDENTITY,
        )
        self.assertIn(f"user.name={self.IDENTITY.name}", self._scoped(worktree, "--worktree"))
        gh_token_factory.revoke_signing_key(cycle_id=CYCLE_ID, workspace_root=worktree)
        self.assertEqual(self._scoped(worktree, "--worktree"), before)


class TheHoldRefusesAnUnresolvableIdentityTests(_NoAmbientIdentity):
    def _mint_without_identity(self):
        real = gh_token_factory.mint_signing_key

        def regressed(**kwargs):
            kwargs.pop("commit_identity", None)
            return real(**kwargs)

        return patch.object(gh_token_factory, "mint_signing_key", new=regressed)

    def _assert_refused_and_unwound(self, worktree: Path, reason: str) -> None:
        with self._mint_without_identity():
            with self.assertRaises(ImplementationIdentityRefusal) as refused:
                with hold_implementation_identity(cycle_id=CYCLE_ID, workspace_root=worktree, base_dir=self.tools):
                    self.fail("an implementer that cannot commit must never be spawned")
        self.assertEqual(refused.exception.reason, reason)
        self.assertFalse((worktree / "aria-debts" / "keys" / CYCLE_ID).exists(), "the mint is unwound")
        self.assertEqual(self._scoped(worktree, "--worktree"), [])
        self.assertFalse((self.tools / "knowledge-graph" / "signers.jsonl").exists(), "nothing registered")

    def test_a_tree_with_no_identity_is_refused_before_any_turn(self) -> None:
        worktree = self._worktree()
        self._enter_no_identity()
        self._assert_refused_and_unwound(worktree, "commit_identity_unresolved:author:rc=128")

    def test_an_identity_that_is_not_the_kernels_is_refused_by_name(self) -> None:
        worktree = self._worktree()
        _git(["config", "--local", "user.name", "Someone Else"], cwd=self.main)
        _git(["config", "--local", "user.email", "someone@example.com"], cwd=self.main)
        self._enter_no_identity()
        self._assert_refused_and_unwound(worktree, "commit_identity_unresolved:author:not_the_kernel_identity")


class TheContainmentProbeMintsTheImplementersIdentityTests(_NoAmbientIdentity):
    def test_a_probe_whose_mint_wires_no_identity_refuses_the_runner_by_name(self) -> None:
        """Preflight's sandbox gate runs this probe: the regression is caught
        before a night starts, not at an implementer's last step."""
        from aria_kernel.containment_probe import probe_git_containment

        real = gh_token_factory.mint_signing_key

        def regressed(**kwargs):
            kwargs.pop("commit_identity", None)
            return real(**kwargs)

        def never_built(*_args):
            raise AssertionError("the sandbox must not be entered")

        self._enter_no_identity()
        with patch.object(gh_token_factory, "mint_signing_key", new=regressed):
            reason = probe_git_containment(never_built)
        self.assertIsNotNone(reason)
        self.assertTrue(str(reason).startswith("probe_commit_identity_unresolved:author:"), reason)


class ThePerimeterJudgesEveryCommitsIdentityTests(_NoAmbientIdentity):
    """N1 — the mint makes the kernel's identity the default; the pre-PR-open
    perimeter makes any other one a refusal. git's `author.*` outranks the
    minted `user.*` in every scope, and the sandbox's HOME is writable."""

    def _perimeter(self, worktree: Path, base: str):
        from aria_kernel import implementation_safety as safety
        from aria_kernel.implementation_identity import IMPLEMENTER_COMMIT_IDENTITY
        from aria_kernel.pr_manager import _branch_commits_for_action

        head = _git(["rev-parse", "HEAD"], cwd=worktree).stdout.strip()
        commits = _branch_commits_for_action(workspace_path=worktree, base_sha=base, head_sha=head)
        return safety._check_commit_identity_is_the_kernels(safety.HardFailContext(
            branch_commits=commits, commit_identity=IMPLEMENTER_COMMIT_IDENTITY,
        ))

    def test_kernel_commits_pass_and_a_planted_author_is_refused_by_name(self) -> None:
        worktree = self._worktree()
        base = _git(["rev-parse", "HEAD"], cwd=worktree).stdout.strip()
        self._enter_no_identity()
        with hold_implementation_identity(cycle_id=CYCLE_ID, workspace_root=worktree, base_dir=self.tools):
            self.assertEqual(self._commit(worktree, "kernel").returncode, 0)
            clean = self._perimeter(worktree, base)
            self.assertTrue(clean.passed, clean.reason)
            # What code the agent wrote can do inside the sandbox: write the
            # HOME config git reads, where `author.*` outranks `user.*`.
            global_config = Path(os.environ["GIT_CONFIG_GLOBAL"])
            global_config.write_text(
                global_config.read_text(encoding="utf-8") + "[author]\n\tname = Evil\n\temail = evil@example.com\n",
                encoding="utf-8",
            )
            self.assertEqual(self._commit(worktree, "planted").returncode, 0)
            idents = _git(["log", "-1", "--format=%an|%cn"], cwd=worktree).stdout.strip()
            self.assertEqual(idents, "Evil|aria-implementer", "the plant really does outrank the mint")
            refused = self._perimeter(worktree, base)
        self.assertFalse(refused.passed)
        self.assertTrue(refused.reason.startswith("commit_identity_foreign:"), refused.reason)
        self.assertIn(":author=Evil <evil@example.com>", refused.reason)
        self.assertNotIn(":committer=", refused.reason)

    def test_a_foreign_committer_from_the_environment_is_refused(self) -> None:
        worktree = self._worktree()
        base = _git(["rev-parse", "HEAD"], cwd=worktree).stdout.strip()
        self._enter_no_identity()
        with hold_implementation_identity(cycle_id=CYCLE_ID, workspace_root=worktree, base_dir=self.tools):
            with patch.dict(os.environ, {"GIT_COMMITTER_NAME": "Someone", "GIT_COMMITTER_EMAIL": "s@example.com"}):
                self.assertEqual(self._commit(worktree, "env-committer").returncode, 0)
            refused = self._perimeter(worktree, base)
        self.assertFalse(refused.passed)
        self.assertIn(":committer=Someone <s@example.com>", refused.reason)
        self.assertNotIn(":author=", refused.reason)

    def test_a_lane_that_commits_as_a_person_declares_no_identity(self) -> None:
        from aria_kernel import implementation_safety as safety

        result = safety._check_commit_identity_is_the_kernels(safety.HardFailContext(branch_commits=()))
        self.assertTrue(result.passed)
        absent = safety._check_commit_identity_is_the_kernels(safety.HardFailContext(
            commit_identity=gh_token_factory.GitCommitIdentity(name="a", email="b"),
        ))
        self.assertEqual((absent.passed, absent.reason), (False, "branch_commits_absent"))


class TheCheckIgnoresAmbientIdentityTests(unittest.TestCase):
    def test_every_ambient_identity_source_is_removed(self) -> None:
        from aria_kernel.implementation_identity import commit_identity_environment

        env = commit_identity_environment({
            "PATH": "/usr/bin", "GIT_AUTHOR_NAME": "a", "GIT_COMMITTER_EMAIL": "c", "EMAIL": "e",
            "GIT_DIR": "/elsewhere", "GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "user.name",
            "GIT_CONFIG_VALUE_0": "x", "GIT_CONFIG_GLOBAL": "/home/op/.gitconfig",
        })
        self.assertEqual(env, {"PATH": "/usr/bin", "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_SYSTEM": os.devnull})


if __name__ == "__main__":
    unittest.main()
