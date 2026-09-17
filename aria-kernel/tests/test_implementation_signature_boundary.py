"""ARIA-HIGH-115 — the bridge verifies the implementation commit against the
registered key, in the checkout the submission names, never in the process cwd.

`plan_convergence_bridge.verify_implementation_commit` is the trust boundary
between the implementer's claim and the ledger. Before this finding it ran
`git verify-commit --raw` in whatever directory the kernel happened to be
invoked from, reading that checkout's own `gpg.ssh.allowedSignersFile` —
the mint's wiring while a key was held and nothing once it was revoked —
and trusted whatever fingerprint the agent wrote. These pins hold it to the
new contract, on a real repository with real ed25519 keys and no dry-run:

* a commit signed by a key whose public half is on `kg_signers` verifies
  from a process cwd that is no checkout at all, and from a checkout whose
  own signing config has been revoked (the shared checkout after the request
  worktree is gone);
* a fingerprint the registry does not hold is refused by name before any
  git step, even when the checkout's own config would have verified it, and
  so is one registered under another cycle than the request's;
* a commit signed by another key, or unsigned, is refused against the
  registered key;
* the replay path — no `workspace_root` — verifies in the checkout the store
  is bound to, and a store bound elsewhere refuses;
* `implementation_record` is the one reading of where the outcome lives,
  and `stamp_implementation_signer` writes exactly there, replacing and
  recording a value the agent supplied.
"""
from __future__ import annotations

import os
import subprocess
import tempfile
import unittest
from contextlib import chdir
from pathlib import Path

from aria_kernel.gh_token_factory import mint_signing_key, revoke_signing_key
from aria_kernel.implementation_identity import implementation_record, stamp_implementation_signer
from aria_kernel.knowledge_graph import register_convention_signer
from aria_kernel.ledger import load_declared_jsonl
from aria_kernel.plan_convergence_bridge import verify_implementation_commit
from aria_kernel.tool_registry import GovernanceError, ensure_tools_binding

from tests._helpers.git_fixtures import _git, make_repo_with_initial_commit


def _commit(repo: Path, text: str, *extra_git: str) -> str:
    (repo / "f.txt").write_text(text, encoding="utf-8")
    _git(["add", "f.txt"], cwd=repo)
    _git([*extra_git, "commit", "-q", "-m", f"fixture: {text.strip()}"], cwd=repo)
    return _git(["rev-parse", "HEAD"], cwd=repo).stdout.strip()


class SignatureBoundaryTests(unittest.TestCase):
    def setUp(self) -> None:
        scratch = tempfile.TemporaryDirectory(prefix="aria-115-boundary-")
        self.addCleanup(scratch.cleanup)
        self.root = Path(scratch.name).resolve()
        self.repo = make_repo_with_initial_commit(self.root, {"f.txt": "one\n"}, name="checkout")
        self.tools = ensure_tools_binding(self.repo / "aria-tools", workspace_root=self.repo)
        # Elsewhere: a directory that is no checkout, for the process cwd.
        self.elsewhere = self.root / "elsewhere"
        self.elsewhere.mkdir()
        # The executor's shape: mint in the checkout, register the public
        # half, let a plain commit sign, revoke — the config is gone by the
        # time the bridge verifies on replay.
        self.key = mint_signing_key(cycle_id="cyc-boundary", workspace_root=self.repo)
        register_convention_signer(
            cycle_id="cyc-boundary", signer_key_fp=self.key.fingerprint,
            public_key=self.key.public_key_path.read_text(encoding="utf-8"), base_dir=self.tools,
        )
        self.signed = _commit(self.repo, "two\n")
        self.assertIn("gpgsig ", _git(["cat-file", "commit", self.signed], cwd=self.repo).stdout)

    def _verify(self, sha: str, fingerprint: str, *, workspace_root: Path | None,
                cycle_id: str = "cyc-boundary") -> None:
        verify_implementation_commit(
            branch_tip_sha=sha, signer_key_fp=fingerprint, cycle_id=cycle_id, plan_id="plan-boundary",
            base_dir=self.tools, workspace_root=workspace_root,
        )

    def test_a_registered_signature_verifies_from_any_cwd_and_after_revocation(self) -> None:
        with chdir(self.elsewhere):
            self._verify(self.signed, self.key.fingerprint, workspace_root=self.repo)
        revoke_signing_key(cycle_id="cyc-boundary", workspace_root=self.repo)
        self.assertNotEqual(_git(["config", "--get", "gpg.ssh.allowedSignersFile"], cwd=self.repo, check=False).returncode, 0)
        with chdir(self.elsewhere):
            self._verify(self.signed, self.key.fingerprint, workspace_root=self.repo)
            # The replay path: no workspace_root, the store's bound checkout.
            self._verify(self.signed, self.key.fingerprint, workspace_root=None)

    def test_an_unregistered_fingerprint_is_refused_before_any_git_step(self) -> None:
        # A second key the checkout's own config would verify (the mint
        # rewires the config to it), never registered.
        revoke_signing_key(cycle_id="cyc-boundary", workspace_root=self.repo)
        other = mint_signing_key(cycle_id="cyc-unregistered", workspace_root=self.repo)
        self.addCleanup(revoke_signing_key, cycle_id="cyc-unregistered", workspace_root=self.repo)
        sha = _commit(self.repo, "three\n")
        self.assertEqual(_git(["verify-commit", "--raw", sha], cwd=self.repo, check=False).returncode, 0,
                         "the checkout's own config vouches for this key; the registry must not")
        with self.assertRaisesRegex(GovernanceError, r"commit_signature_unverified.*not a registered cycle key"):
            self._verify(sha, other.fingerprint, workspace_root=self.repo)
        with self.assertRaisesRegex(GovernanceError, r"commit_signature_unverified.*carries no signer_key_fp"):
            self._verify(sha, "", workspace_root=self.repo)

    def test_a_key_registered_under_another_cycle_is_refused_by_name(self) -> None:
        # A real, registered key — of ANOTHER cycle. The executor mints and
        # registers for the request's own cycle, so however this commit
        # verifies, the key is one the executor never held for this request.
        revoke_signing_key(cycle_id="cyc-boundary", workspace_root=self.repo)
        other = mint_signing_key(cycle_id="cyc-other", workspace_root=self.repo)
        self.addCleanup(revoke_signing_key, cycle_id="cyc-other", workspace_root=self.repo)
        register_convention_signer(
            cycle_id="cyc-other", signer_key_fp=other.fingerprint,
            public_key=other.public_key_path.read_text(encoding="utf-8"), base_dir=self.tools,
        )
        sha = _commit(self.repo, "six\n")
        self._verify(sha, other.fingerprint, workspace_root=self.repo, cycle_id="cyc-other")
        with self.assertRaisesRegex(GovernanceError, r"commit_signature_unverified.*registered under cycle 'cyc-other', not this request's cycle 'cyc-boundary'"):
            self._verify(sha, other.fingerprint, workspace_root=self.repo)
        with self.assertRaisesRegex(GovernanceError, r"commit_signature_unverified.*not this request's cycle ''"):
            self._verify(sha, other.fingerprint, workspace_root=self.repo, cycle_id="")

    def test_another_key_or_no_signature_is_refused_against_the_registered_key(self) -> None:
        other_private = self.root / "other-key"
        subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(other_private)], check=True)
        foreign = _commit(self.repo, "four\n", "-c", f"user.signingkey={other_private}")
        with self.assertRaisesRegex(GovernanceError, "commit_signature_unverified.*does not verify against the registered key"):
            self._verify(foreign, self.key.fingerprint, workspace_root=self.repo)
        unsigned = _commit(self.repo, "five\n", "-c", "commit.gpgsign=false")
        with self.assertRaisesRegex(GovernanceError, "commit_signature_unverified.*does not verify"):
            self._verify(unsigned, self.key.fingerprint, workspace_root=self.repo)

    def test_the_replay_path_verifies_in_the_bound_checkout_not_the_cwd(self) -> None:
        # A store bound to a checkout that does not carry the commit: the
        # replay refuses there even when the process cwd is the checkout that
        # does — the cwd is not consulted.
        stranger = make_repo_with_initial_commit(self.root, {"g.txt": "x\n"}, name="stranger")
        stranger_tools = ensure_tools_binding(stranger / "aria-tools", workspace_root=stranger)
        register_convention_signer(
            cycle_id="cyc-boundary", signer_key_fp=self.key.fingerprint,
            public_key=self.key.public_key_path.read_text(encoding="utf-8"), base_dir=stranger_tools,
        )
        with chdir(self.repo), self.assertRaisesRegex(GovernanceError, "commit_signature_unverified"):
            verify_implementation_commit(
                branch_tip_sha=self.signed, signer_key_fp=self.key.fingerprint, cycle_id="cyc-boundary",
                plan_id="plan-boundary", base_dir=stranger_tools, workspace_root=None,
            )

    def test_the_stamp_writes_where_the_bridge_reads(self) -> None:
        nested = {"details": {"implementation": {"branch_tip_sha": "a" * 40, "signer_key_fp": "SHA256:agent-claim"}}}
        self.assertTrue(stamp_implementation_signer(
            nested, fingerprint=self.key.fingerprint, request_id="AIR-1", claim_id="claim-1", base_dir=self.tools,
        ))
        self.assertEqual(implementation_record(nested["details"])["signer_key_fp"], self.key.fingerprint)
        self.assertEqual(nested["details"]["implementation"]["signer_key_fp"], self.key.fingerprint)
        overridden = [row for row in load_declared_jsonl(self.tools / "governance.jsonl", expected_surface="tools_governance")
                      if row.get("kind") == "implementation_signer_fp_overridden"]
        self.assertEqual([(row["details"]["agent_supplied"], row["details"]["signer_key_fp"]) for row in overridden],
                         [("SHA256:agent-claim", self.key.fingerprint)])
        # Flat legacy shape: stamped flat, read flat; already-correct value: no change, no row.
        flat = {"details": {"branch_tip_sha": "b" * 40}}
        self.assertTrue(stamp_implementation_signer(
            flat, fingerprint=self.key.fingerprint, request_id="AIR-2", claim_id="claim-2", base_dir=self.tools,
        ))
        self.assertIs(implementation_record(flat["details"]), flat["details"])
        self.assertEqual(flat["details"]["signer_key_fp"], self.key.fingerprint)
        self.assertNotIn("implementation", flat["details"])
        self.assertFalse(stamp_implementation_signer(
            flat, fingerprint=self.key.fingerprint, request_id="AIR-2", claim_id="claim-2", base_dir=self.tools,
        ))
        self.assertEqual(len([row for row in load_declared_jsonl(self.tools / "governance.jsonl", expected_surface="tools_governance")
                              if row.get("kind") == "implementation_signer_fp_overridden"]), 1)


if __name__ == "__main__":
    unittest.main()
