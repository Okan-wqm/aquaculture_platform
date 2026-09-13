"""ARIA-HIGH-114 — the signing transaction in a LINKED worktree.

Every production workspace is a linked worktree: the executor drain adds
one per request, a trial's task-source is one, the nightly lane's
checkout carries them. There ``<workspace>/.git`` is a FILE
(``gitdir: <common>/.git/worktrees/<name>``), and the factory's
``is_dir()`` test skipped the whole wiring without a word — every
implementer commit went unsigned and ``verify_commit_signature`` refused
the run at its end. The factory now reads the checkout the way every
kernel walker does (``checkout_root`` → ``SigningCheckout``) and writes
``--worktree`` config there, because
``--local`` in a linked worktree is the config every worktree of the
repository shares.
"""

from __future__ import annotations

import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from tests._helpers.git_fixtures import _git, make_git_worktree, make_repo_with_initial_commit


def _commit(repo: Path, content: str, message: str) -> str:
    (repo / "f.txt").write_text(content, encoding="utf-8")
    _git(["add", "f.txt"], cwd=repo)
    _git(["commit", "-q", "-m", message], cwd=repo)
    return _git(["rev-parse", "HEAD"], cwd=repo).stdout.strip()


def _signature_fingerprint(repo: Path, sha: str) -> str | None:
    """The SHA256 fingerprint git verified the commit against, or None —
    read with the config the checkout itself carries, the way the merge
    gate's ``verify_commit_signature`` reads it."""
    proc = _git(["verify-commit", "--raw", sha], cwd=repo, check=False)
    if proc.returncode != 0:
        return None
    match = re.search(r"SHA256:[A-Za-z0-9+/]+=*", proc.stdout + proc.stderr)
    return match.group(0) if match else None


def _has_signature(repo: Path, sha: str) -> bool:
    return "gpgsig " in _git(["cat-file", "commit", sha], cwd=repo).stdout


class LinkedWorktreeSigningTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="v31p-linked-")).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.main = make_repo_with_initial_commit(self.tmp, name="main", files={"f.txt": "x\n"})
        self.worktree = make_git_worktree(self.main, self.tmp / "worktrees" / "request-1", branch="req-1")
        self.sibling = make_git_worktree(self.main, self.tmp / "worktrees" / "request-2", branch="req-2")
        self.common_config = self.main / ".git" / "config"

    def _worktree_git_dir(self, worktree: Path) -> Path:
        return Path(_git(["rev-parse", "--absolute-git-dir"], cwd=worktree).stdout.strip())

    def test_i_high_114_01_the_checkout_is_what_git_says_it_is(self) -> None:
        from aria_kernel.gh_token_factory import _resolve_signing_checkout

        self.assertTrue((self.worktree / ".git").is_file(), "a linked worktree's .git is a file")
        linked = _resolve_signing_checkout(self.worktree)
        self.assertIsNotNone(linked)
        self.assertTrue(linked.linked)
        self.assertEqual(linked.config_scope, "--worktree")
        self.assertEqual(linked.git_dir, self._worktree_git_dir(self.worktree))
        self.assertTrue(linked.git_dir.is_dir())
        main = _resolve_signing_checkout(self.main)
        self.assertFalse(main.linked)
        self.assertEqual(main.config_scope, "--local")
        self.assertEqual(main.git_dir, self.main / ".git")
        plain = self.tmp / "not-a-checkout"
        plain.mkdir()
        self.assertIsNone(_resolve_signing_checkout(plain))

    def test_i_high_114_02_a_mint_in_a_linked_worktree_signs_that_worktrees_commits_only(self) -> None:
        """The whole finding: the commit made inside the worktree is signed
        by the cycle key and verifiable with the config the worktree
        carries; the common config and the sibling worktree see nothing."""
        from aria_kernel.gh_token_factory import mint_signing_key, revoke_signing_key

        common_before = self.common_config.read_bytes()
        git_dir = self._worktree_git_dir(self.worktree)
        key = mint_signing_key(cycle_id="cyc-linked", workspace_root=self.worktree)
        self.assertIsNotNone(key.git_signing)
        self.assertTrue(key.git_signing.configured, key.git_signing)
        self.assertEqual(key.git_signing.scope, "--worktree")
        self.assertEqual(_git(["config", "--local", "--get", "extensions.worktreeConfig"],
                              cwd=self.main).stdout.strip(), "true")
        # Everything the transaction wrote lives in the worktree's private git dir.
        self.assertTrue((git_dir / "config.worktree").is_file())
        self.assertTrue((git_dir / "aria-allowed-signers").is_file())
        self.assertTrue((git_dir / "aria-signing-config-snapshots" / "cyc-linked.json").is_file())
        self.assertFalse((self.main / ".git" / "aria-allowed-signers").exists())
        self.assertFalse((self.main / ".git" / "aria-signing-config-snapshots").exists())
        # The common config is untouched but for the one-time extension flag.
        common_after = self.common_config.read_bytes()
        self.assertNotIn(b"signingkey", common_after)
        self.assertNotIn(b"gpgsign", common_after)
        self.assertEqual(
            _git(["config", "--worktree", "--get", "user.signingkey"], cwd=self.worktree).stdout.strip(),
            str(key.private_key_path),
        )

        inside = _commit(self.worktree, "y\n", "inside the cycle, in the worktree")
        self.assertEqual(_signature_fingerprint(self.worktree, inside), key.fingerprint,
                         "the commit made in the worktree is signed by the cycle key")
        beside = _commit(self.sibling, "z\n", "beside it, in the sibling worktree")
        self.assertFalse(_has_signature(self.sibling, beside),
                         "the sibling worktree of the same repository signs with nothing")
        self.assertEqual(_git(["config", "--worktree", "--get", "user.signingkey"], cwd=self.sibling,
                              check=False).returncode, 1)

        result = revoke_signing_key(cycle_id="cyc-linked", workspace_root=self.worktree)
        self.assertTrue(result["git_signing_config_restored"])
        self.assertFalse((git_dir / "aria-allowed-signers").exists())
        self.assertFalse((git_dir / "aria-signing-config-snapshots" / "cyc-linked.json").exists())
        self.assertEqual(_git(["config", "--worktree", "--get-regexp", r"^(commit|gpg|user)\."],
                              cwd=self.worktree, check=False).returncode, 1,
                         "the worktree carries no signing config after the cycle")
        after = _commit(self.worktree, "w\n", "after the cycle")
        self.assertFalse(_has_signature(self.worktree, after))
        self.assertEqual(self.common_config.read_bytes(), common_after,
                         "the revoke does not touch the common config either")
        self.assertNotEqual(common_before, common_after,
                            "the extension flag is the one deliberate, one-time common-config write")

    def test_i_high_114_03_the_prune_finds_a_crashed_worktree_cycles_snapshot(self) -> None:
        """The pre-clean wipes the key; the snapshot in the worktree's git
        dir survives and the startup prune restores the worktree config."""
        from aria_kernel.gh_token_factory import mint_signing_key, prune_stale_signing_keys

        git_dir = self._worktree_git_dir(self.worktree)
        key = mint_signing_key(cycle_id="cyc-crashed", workspace_root=self.worktree)
        shutil.rmtree(key.private_key_path.parent)
        pruned = prune_stale_signing_keys(workspace_root=self.worktree)
        self.assertEqual(pruned["snapshots_unwound"], ["cyc-crashed"])
        self.assertEqual(pruned["git_signing_config_restored"], ["cyc-crashed"])
        self.assertEqual(pruned["errors"], [])
        self.assertFalse((git_dir / "aria-signing-config-snapshots" / "cyc-crashed.json").exists())
        self.assertEqual(_git(["config", "--worktree", "--get", "user.signingkey"], cwd=self.worktree,
                              check=False).returncode, 1)

    def test_i_high_114_04_a_workspace_that_is_not_a_checkout_says_so(self) -> None:
        from aria_kernel.gh_token_factory import mint_signing_key

        plain = self.tmp / "archive"
        plain.mkdir()
        key = mint_signing_key(cycle_id="cyc-archive", workspace_root=plain)
        self.assertEqual(key.git_signing.configured, False)
        self.assertEqual(key.git_signing.reason, "not_a_checkout")
        self.assertIsNone(key.git_signing.scope)

    def test_i_high_114_05_a_repository_that_cannot_carry_worktree_config_is_refused_by_name(self) -> None:
        """Git's own rule: ``core.worktree`` must move before the extension
        is enabled. The factory does not re-shape the repository; it names
        the refusal and the receipt is not ``configured``."""
        from aria_kernel.gh_token_factory import mint_signing_key

        _git(["config", "--local", "core.worktree", str(self.main)], cwd=self.main)
        common_before = self.common_config.read_bytes()
        key = mint_signing_key(cycle_id="cyc-refused", workspace_root=self.worktree)
        self.assertFalse(key.git_signing.configured)
        self.assertEqual(key.git_signing.reason,
                         "worktree_scope_unavailable:core.worktree is set in the common config")
        self.assertEqual(self.common_config.read_bytes(), common_before, "nothing written")
        self.assertFalse((self._worktree_git_dir(self.worktree) / "aria-allowed-signers").exists())

    def test_i_high_114_06_a_git_that_does_not_answer_is_undecided_not_absent(self) -> None:
        """The checkout is read structurally (``checkout_root``), so the only
        git the restore spawns is ``git config`` in the worktree scope; one
        that does not answer keeps the snapshot for the next attempt."""
        from unittest.mock import patch

        from aria_kernel import gh_token_factory
        from aria_kernel.gh_token_factory import (
            SigningConfigRestore, _restore_git_commit_signing, mint_signing_key, prune_stale_signing_keys,
        )

        key = mint_signing_key(cycle_id="cyc-stall", workspace_root=self.worktree)
        shutil.rmtree(key.private_key_path.parent)

        def stalled(workspace_root: Path, scope: str, *args: str) -> None:
            self.assertEqual(scope, "--worktree")
            raise subprocess.TimeoutExpired(cmd=["git", "config", scope, *args], timeout=10)

        with patch.object(gh_token_factory, "_git_config_at", stalled):
            receipt = _restore_git_commit_signing(
                workspace_root=self.worktree, cycle_id="cyc-stall", private_path=key.private_key_path,
            )
            self.assertIs(receipt.outcome, SigningConfigRestore.UNDECIDED)
            self.assertEqual(receipt.error, "TimeoutExpired")
            pruned = prune_stale_signing_keys(workspace_root=self.worktree)
        self.assertEqual(pruned["snapshots_unwound"], [])
        self.assertEqual(pruned["errors"], [{
            "name": "cyc-stall.json",
            "error": "git_signing_config_restore_undecided:TimeoutExpired",
        }])
        # The next startup, with git answering, finishes the restore.
        again = prune_stale_signing_keys(workspace_root=self.worktree)
        self.assertEqual(again["snapshots_unwound"], ["cyc-stall"])
        self.assertEqual(again["git_signing_config_restored"], ["cyc-stall"])


if __name__ == "__main__":
    unittest.main()
