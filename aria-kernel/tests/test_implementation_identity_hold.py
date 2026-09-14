"""ARIA-HIGH-115 — the executor's identity hold, at the seam, in process.

`implementation_identity.hold_implementation_identity` is what the executor
child enters for a claimed implementation request: it mints the cycle key in
the tree the agent commits in, wires that tree's git config, registers the
public half and revokes on exit. These pins hold the seam to its refusal
contract on real repositories with real keys, with the factory's ONE git
config primitive (`gh_token_factory._git_config_at`) recorded:

* a MAIN checkout — whose `--local` config is the config every worktree of
  the repository shares — is refused `shared_checkout_scope:--local` with
  ZERO git config calls, no key file, no snapshot: the scope is decided from
  the checkout's shape before the mint (round 1 wrote the operator's
  `user.signingkey` over, in the shared config, and only then refused);
* a directory that is no checkout is refused `not_a_checkout` the same way;
* a linked worktree holds the identity — key wired in `--worktree` scope,
  public half on `kg_signers` — and the body's exit revokes it and restores
  the worktree's config, however the body exits;
* the executor's refusal record (`IMPLEMENTATION_IDENTITY_REFUSAL`) spells
  the kernel's release reason, harness-classified, and summarises as a
  retryable `harness_unavailable` — the same fact in every vocabulary;
* ARIA-HIGH-123 — the held identity carries its sandbox shape: a
  commit-capable containment for the worktree whose signing exposure names
  the keys dir to mask, the public key to show and the socket of an
  ssh-agent THIS process holds, which lists exactly the cycle key and dies
  with the window; an agent that cannot be held, or a containment that
  cannot be derived, is refused by name BEFORE the registry write (no
  `kg_signers` row for a key that never signed) and unwinds the mint.
"""
from __future__ import annotations

import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aria_kernel import gh_token_factory
from aria_kernel.implementation_identity import (
    ImplementationIdentityRefusal,
    hold_implementation_identity,
)
from aria_kernel.knowledge_graph import lookup_convention_signer
from aria_kernel.tool_registry import ensure_tools_binding

from tests._helpers.git_fixtures import _git, make_git_worktree, make_repo_with_initial_commit

CYCLE_ID = "cyc-hold-115"


class _ConfigRecorder:
    """Every `git config` call the factory makes, in order, delegating to the real one."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, ...]] = []
        self._real = gh_token_factory._git_config_at

    def __call__(self, workspace_root: Path, scope: str, *args: str):
        self.calls.append((str(workspace_root), scope, *args))
        return self._real(workspace_root, scope, *args)


class IdentityHoldTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-115-hold-")).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.main = make_repo_with_initial_commit(self.tmp, {"f.txt": "x\n"}, name="main")
        self.tools = ensure_tools_binding(self.main / "aria-tools", workspace_root=self.main)
        # The operator's own signing key, in the config every worktree shares.
        _git(["config", "--local", "user.signingkey", "/operator/key"], cwd=self.main)
        self.recorder = _ConfigRecorder()
        patcher = patch.object(gh_token_factory, "_git_config_at", new=self.recorder)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _config(self, checkout: Path, key: str, scope: str = "--local") -> str | None:
        """The key in ONE scope of the checkout — the suite's hermetic global
        config sets `commit.gpgsign = false`, so an unscoped read would
        answer for every checkout whether or not the hold wrote there."""
        done = _git(["config", scope, "--get", key], cwd=checkout, check=False)
        return done.stdout.strip() if done.returncode == 0 else None

    def _hold(self, workspace: Path):
        return hold_implementation_identity(cycle_id=CYCLE_ID, workspace_root=workspace, base_dir=self.tools)

    def test_a_main_checkout_is_refused_before_any_write(self) -> None:
        with self.assertRaises(ImplementationIdentityRefusal) as refused:
            with self._hold(self.main):
                self.fail("the shared checkout must never hold the implementer's identity")
        self.assertEqual(refused.exception.reason, "shared_checkout_scope:--local")
        self.assertEqual(self.recorder.calls, [], "zero git config calls on the refused path")
        self.assertFalse((self.main / "aria-debts").exists(), "no key file was ever created")
        self.assertFalse((self.main / ".git" / "aria-signing-config-snapshots").exists())
        self.assertFalse((self.main / ".git" / "aria-allowed-signers").exists())
        self.assertEqual(self._config(self.main, "user.signingkey"), "/operator/key")
        self.assertIsNone(self._config(self.main, "commit.gpgsign"))
        self.assertFalse((self.tools / "knowledge-graph" / "signers.jsonl").exists(), "nothing registered")

    def test_a_directory_that_is_no_checkout_is_refused_before_any_write(self) -> None:
        plain = self.tmp / "not-a-checkout"
        plain.mkdir()
        with self.assertRaises(ImplementationIdentityRefusal) as refused:
            with self._hold(plain):
                self.fail("a directory that is no checkout cannot hold the identity")
        self.assertEqual(refused.exception.reason, "not_a_checkout")
        self.assertEqual(self.recorder.calls, [])
        self.assertEqual(sorted(path.name for path in plain.iterdir()), [])

    def test_a_linked_worktree_holds_the_identity_and_the_exit_revokes_it(self) -> None:
        worktree = make_git_worktree(self.main, self.tmp / "worktrees" / "req-1", branch="req-1")
        sibling = make_git_worktree(self.main, self.tmp / "worktrees" / "req-2", branch="req-2")
        with self._hold(worktree) as identity:
            self.assertEqual(identity.scope, "--worktree")
            self.assertEqual(identity.workspace_root, worktree)
            self.assertTrue(identity.fingerprint.startswith("SHA256:"))
            self.assertTrue((worktree / "aria-debts" / "keys" / CYCLE_ID).is_file())
            self.assertEqual(self._config(worktree, "commit.gpgsign", "--worktree"), "true")
            self.assertEqual(Path(self._config(worktree, "user.signingkey", "--worktree")),
                             worktree / "aria-debts" / "keys" / CYCLE_ID)
            registered = lookup_convention_signer(identity.fingerprint, base_dir=self.tools)
            self.assertIsNotNone(registered)
            self.assertEqual(registered["cycle_id"], CYCLE_ID)
            # The shared config and the sibling never see the key.
            self.assertEqual(self._config(self.main, "user.signingkey"), "/operator/key")
            self.assertIsNone(self._config(self.main, "commit.gpgsign"))
            self.assertIsNone(self._config(sibling, "user.signingkey", "--worktree"))
            self.assertIsNone(self._config(sibling, "commit.gpgsign", "--worktree"))
        self.assertFalse((worktree / "aria-debts" / "keys" / CYCLE_ID).exists())
        self.assertIsNone(self._config(worktree, "commit.gpgsign", "--worktree"))
        self.assertIsNone(self._config(worktree, "user.signingkey", "--worktree"))
        self.assertEqual(_git(["config", "--get", "user.signingkey"], cwd=worktree).stdout.strip(), "/operator/key",
                         "the worktree inherits the shared value again")
        # Every config WRITE the hold made was in the worktree's own scope;
        # the one write to the shared config is git's own rule for that
        # scope, the repository-format declaration `extensions.worktreeConfig`.
        writes = [call for call in self.recorder.calls if len(call) == 4 and not call[2].startswith("--")]
        self.assertTrue(writes)
        for _root, scope, key, _value in writes:
            self.assertEqual(scope, "--local" if key == "extensions.worktreeConfig" else "--worktree", key)

    def test_the_held_identity_carries_its_sandbox_shape(self) -> None:
        import os
        import subprocess

        from aria_kernel.git_containment import GitContainment

        worktree = make_git_worktree(self.main, self.tmp / "worktrees" / "req-1", branch="req-1")
        with self._hold(worktree) as identity:
            containment = identity.containment
            self.assertIsInstance(containment, GitContainment)
            self.assertTrue(containment.commit_capable)
            self.assertEqual(containment.workspace_root, worktree)
            signing = containment.signing
            assert signing is not None
            self.assertEqual(signing.keys_dir, worktree / "aria-debts" / "keys")
            self.assertEqual(signing.public_key_path, worktree / "aria-debts" / "keys" / f"{CYCLE_ID}.pub")
            self.assertTrue(signing.agent_socket.is_socket())
            socket_path = signing.agent_socket
            listed = subprocess.run(["ssh-add", "-l"], capture_output=True, text=True,
                                    env={**os.environ, "SSH_AUTH_SOCK": str(socket_path)})
            self.assertEqual(listed.returncode, 0, listed.stderr)
            self.assertEqual([line.split()[1] for line in listed.stdout.splitlines()], [identity.fingerprint])
            # The private key path is not carried by the shape the sandbox is
            # built from; the flags name the public key and the socket only.
            flags = containment.bwrap_flags()
            self.assertNotIn(str(worktree / "aria-debts" / "keys" / CYCLE_ID), flags)
            self.assertIn(str(signing.public_key_path), flags)
            self.assertIn(str(socket_path), flags)
        self.assertFalse(socket_path.exists(), "the agent dies with the window")

    def test_an_agent_that_cannot_be_held_is_refused_before_the_registry_write(self) -> None:
        from aria_kernel import implementation_identity as seam
        from aria_kernel.signing_agent import SigningAgentUnavailable

        worktree = make_git_worktree(self.main, self.tmp / "worktrees" / "req-1", branch="req-1")

        def refusing(*_args, **_kwargs):
            raise SigningAgentUnavailable("ssh_agent_missing")

        with patch.object(seam, "hold_signing_agent", refusing):
            with self.assertRaises(ImplementationIdentityRefusal) as refused:
                with self._hold(worktree):
                    self.fail("no identity without its agent")
        self.assertEqual(refused.exception.reason, "signing_agent_unavailable:ssh_agent_missing")
        self.assertFalse((self.tools / "knowledge-graph" / "signers.jsonl").exists(), "nothing registered")
        self.assertFalse((worktree / "aria-debts" / "keys" / CYCLE_ID).exists(), "the mint is unwound")
        self.assertIsNone(self._config(worktree, "user.signingkey", "--worktree"))

    def test_a_containment_that_cannot_be_derived_is_refused_before_the_registry_write(self) -> None:
        from aria_kernel import implementation_identity as seam
        from aria_kernel.git_containment import GitContainmentRefusal

        worktree = make_git_worktree(self.main, self.tmp / "worktrees" / "req-1", branch="req-1")

        def refusing(*_args, **_kwargs):
            raise GitContainmentRefusal("hooks_dir_unresolvable:rc=128")

        with patch.object(seam, "derive_git_containment", refusing):
            with self.assertRaises(ImplementationIdentityRefusal) as refused:
                with self._hold(worktree):
                    self.fail("no identity without its sandbox shape")
        self.assertEqual(refused.exception.reason, "git_containment_refused:hooks_dir_unresolvable:rc=128")
        self.assertFalse((self.tools / "knowledge-graph" / "signers.jsonl").exists(), "nothing registered")
        self.assertFalse((worktree / "aria-debts" / "keys" / CYCLE_ID).exists(), "the mint is unwound")

    def test_an_exception_in_the_body_still_revokes(self) -> None:
        worktree = make_git_worktree(self.main, self.tmp / "worktrees" / "req-1", branch="req-1")
        with self.assertRaisesRegex(RuntimeError, "fixture body failure"):
            with self._hold(worktree):
                raise RuntimeError("fixture body failure")
        self.assertFalse((worktree / "aria-debts" / "keys" / CYCLE_ID).exists())
        self.assertIsNone(self._config(worktree, "commit.gpgsign", "--worktree"))
        self.assertIsNone(self._config(worktree, "user.signingkey", "--worktree"))


class TheExecutorRefusalRecordTests(unittest.TestCase):
    def test_the_record_spells_the_kernels_release_reason_in_every_vocabulary(self) -> None:
        from aria_kernel.agent_invocations import HARNESS_FAULT_RELEASE_REASONS, classify_release_reason
        from aria_kernel.release_reason import (
            IMPLEMENTATION_SIGNING_UNAVAILABLE,
            RELEASE_REASON_CODES,
            parse_release_reason,
        )
        from tests._helpers.executor_module import load_ci_executor

        executor = load_ci_executor("ci_executor_identity_refusal")
        record = executor.IMPLEMENTATION_IDENTITY_REFUSAL
        self.assertEqual(record.release_reason, IMPLEMENTATION_SIGNING_UNAVAILABLE)
        self.assertEqual(record.release_reason, ImplementationIdentityRefusal("any").release_reason)
        self.assertIn(record.release_reason, HARNESS_FAULT_RELEASE_REASONS)
        self.assertEqual(classify_release_reason(record.release_reason), "harness")
        parsed = parse_release_reason(record.release_reason)
        self.assertEqual((parsed.reason_code, parsed.fault_domain), ("IMPLEMENTATION_SIGNING_UNAVAILABLE", "harness"))
        self.assertIn(parsed.reason_code, RELEASE_REASON_CODES)
        # A harness fault the daemon retries after a back-off, in the
        # summary too — never a policy the dispatch violated.
        self.assertEqual((record.failure_class, record.retryable), ("harness_unavailable", True))


if __name__ == "__main__":
    unittest.main()
