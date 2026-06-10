"""Plan 026R §G.3 — submit_worker_result lease-bound + active-claim +
lease-expiry + multi-active corruption + provenance.

14 tests:

* lease_token=None is rejected.
* lease_token="" → reject "lease_token_required".
* wrong lease_token → reject "lease_token_mismatch".
* no active claim → reject "no_active_claim".
* multi-active-claim corruption → reject FIRST (before token verify).
* lease expired → reject "lease_expired".
* released-claim token → reject "claim_already_released".
* stale-claim token → reject "claim_already_stale".
* human_required-claim token → reject "claim_already_human_required".
* accepted result row carries claim_id + agent_id provenance.
* accepted result row does NOT carry lease_token or lease_token_hash.
* correct active-claim with non-expired lease + valid token → accept.
* missing lease_expires_at is rejected fail-closed.
* recorded_at field present on the accepted row.
"""
from __future__ import annotations

import hashlib
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from aria_kernel.ledger import append_declared_jsonl, load_jsonl
from aria_kernel.runtime_profile import set_profile
from aria_kernel.tool_registry import utc_now
from aria_kernel.verification_gate import _hash_lease_token, submit_worker_result

_TEST_LEASE_TOKEN = "secret-lease-" + "12345678"


def _git(workdir: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=workdir, check=True, capture_output=True)


def _seed_request(base: Path, *, assignment_id: str, worktree: Path,
                  base_sha: str, head_sha: str) -> None:
    append_declared_jsonl(
        base / "dispatch" / "requests.jsonl",
        {
            "schema_version": 1,
            "assignment_id": assignment_id,
            "pressure_event_id": "PE-G3",
            "target_agent": "agent-test",
            "worktree_path": str(worktree),
            "base_sha": base_sha,
            "required_tests": [],
            "triage_tier": "auto_fix_safe",
        },
        expected_surface="dispatch_requests",
    )


def _seed_claim(base: Path, *, assignment_id: str, claim_id: str,
                lease_token: str, event: str = "claimed",
                lease_expires_at: str | None = None,
                agent_id: str = "agent-test") -> None:
    row = {
        "schema_version": 1,
        "assignment_id": assignment_id,
        "claim_id": claim_id,
        "agent_id": agent_id,
        "event": event,
        "claimed_at": utc_now(),
        "lease_token_hash": _hash_lease_token(lease_token),
    }
    if lease_expires_at is None:
        row["lease_expires_at"] = "2099-12-31T00:00:00+00:00"
    elif lease_expires_at:
        row["lease_expires_at"] = lease_expires_at
    append_declared_jsonl(
        base / "dispatch" / "claims.jsonl",
        row,
        expected_surface="dispatch_claims",
    )


def _setup_git_worktree(tmp: Path) -> tuple[Path, str, str]:
    worktree = tmp / "worktree"
    worktree.mkdir()
    _git(worktree, "init")
    _git(worktree, "config", "user.email", "test@test")
    _git(worktree, "config", "user.name", "test")
    (worktree / "a.md").write_text("base", encoding="utf-8")
    _git(worktree, "add", ".")
    _git(worktree, "commit", "-m", "base")
    base_sha = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=worktree, check=True,
        capture_output=True, text=True,
    ).stdout.strip()
    (worktree / "a.md").write_text("changed", encoding="utf-8")
    _git(worktree, "commit", "-am", "change")
    head_sha = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=worktree, check=True,
        capture_output=True, text=True,
    ).stdout.strip()
    return worktree, base_sha, head_sha


class SubmitWorkerLeaseBoundTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-g3-"))
        self.base = self.tmp / "aria-tools"
        set_profile("standard", operator_approval_ref="t", base_dir=self.base)
        (self.base / "dispatch").mkdir(parents=True)
        self.worktree, self.base_sha, self.head_sha = _setup_git_worktree(self.tmp)

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _seed_request_and_claim(
        self,
        *,
        assignment_id: str = "A-1",
        claim_id: str = "C-1",
        lease_token: str = _TEST_LEASE_TOKEN,
        claim_event: str = "claimed",
        lease_expires_at: str | None = None,
    ) -> None:
        _seed_request(
            self.base, assignment_id=assignment_id, worktree=self.worktree,
            base_sha=self.base_sha, head_sha=self.head_sha,
        )
        _seed_claim(
            self.base, assignment_id=assignment_id, claim_id=claim_id,
            lease_token=lease_token, event=claim_event,
            lease_expires_at=lease_expires_at,
        )

    def test_lease_token_none_rejects(self) -> None:
        self._seed_request_and_claim()
        result = submit_worker_result(
            from_worktree=self.worktree, assignment_id="A-1",
            tools_root=self.base, lease_token=None,
        )
        self.assertEqual(result["state"], "rejected")
        self.assertEqual(result["reason"], "submit_worker_result_lease_token_required")

    def test_empty_lease_token_rejects(self) -> None:
        self._seed_request_and_claim()
        result = submit_worker_result(
            from_worktree=self.worktree, assignment_id="A-1",
            tools_root=self.base, lease_token="",
        )
        self.assertEqual(result["state"], "rejected")
        self.assertEqual(result["reason"], "submit_worker_result_lease_token_required")

    def test_wrong_lease_token_rejects(self) -> None:
        self._seed_request_and_claim(lease_token="real-secret-aaaa")
        result = submit_worker_result(
            from_worktree=self.worktree, assignment_id="A-1",
            tools_root=self.base, lease_token="wrong-token-bbbb",
        )
        self.assertEqual(result["state"], "rejected")
        self.assertEqual(result["reason"], "submit_worker_result_lease_token_mismatch")

    def test_no_active_claim_rejects(self) -> None:
        _seed_request(
            self.base, assignment_id="A-2", worktree=self.worktree,
            base_sha=self.base_sha, head_sha=self.head_sha,
        )
        result = submit_worker_result(
            from_worktree=self.worktree, assignment_id="A-2",
            tools_root=self.base, lease_token="any-token-xxxx",
        )
        self.assertEqual(result["state"], "rejected")
        self.assertEqual(result["reason"], "submit_worker_result_no_active_claim")

    def test_multi_active_claim_corruption_rejects_first(self) -> None:
        self._seed_request_and_claim(claim_id="C-A", lease_token="t-A")
        _seed_claim(
            self.base, assignment_id="A-1", claim_id="C-B",
            lease_token="t-B", event="claimed",
        )
        # Even with the correct token for one of the claims, multi-
        # active raises first.
        result = submit_worker_result(
            from_worktree=self.worktree, assignment_id="A-1",
            tools_root=self.base, lease_token="t-A",
        )
        self.assertEqual(result["state"], "rejected")
        self.assertEqual(
            result["reason"],
            "submit_worker_result_multiple_active_claims_corruption",
        )

    def test_lease_expired_rejects(self) -> None:
        self._seed_request_and_claim(
            lease_expires_at="2020-01-01T00:00:00+00:00",
        )
        result = submit_worker_result(
            from_worktree=self.worktree, assignment_id="A-1",
            tools_root=self.base, lease_token=_TEST_LEASE_TOKEN,
        )
        self.assertEqual(result["state"], "rejected")
        self.assertEqual(result["reason"], "submit_worker_result_lease_expired")

    def test_missing_lease_expiry_rejects_fail_closed(self) -> None:
        self._seed_request_and_claim(lease_expires_at="")
        result = submit_worker_result(
            from_worktree=self.worktree, assignment_id="A-1",
            tools_root=self.base, lease_token=_TEST_LEASE_TOKEN,
        )
        self.assertEqual(result["state"], "rejected")
        self.assertEqual(result["reason"], "submit_worker_result_lease_expired")

    def test_released_claim_token_rejects_specific_reason(self) -> None:
        # Claim was released — the lease_token no longer valid.
        _seed_request(
            self.base, assignment_id="A-R", worktree=self.worktree,
            base_sha=self.base_sha, head_sha=self.head_sha,
        )
        _seed_claim(
            self.base, assignment_id="A-R", claim_id="C-R",
            lease_token="released-token", event="claimed",
        )
        _seed_claim(
            self.base, assignment_id="A-R", claim_id="C-R",
            lease_token="released-token", event="released",
        )
        result = submit_worker_result(
            from_worktree=self.worktree, assignment_id="A-R",
            tools_root=self.base, lease_token="released-token",
        )
        self.assertEqual(result["state"], "rejected")
        self.assertEqual(
            result["reason"],
            "submit_worker_result_claim_already_released",
        )

    def test_stale_claim_token_rejects_specific_reason(self) -> None:
        _seed_request(
            self.base, assignment_id="A-S", worktree=self.worktree,
            base_sha=self.base_sha, head_sha=self.head_sha,
        )
        _seed_claim(
            self.base, assignment_id="A-S", claim_id="C-S",
            lease_token="stale-token", event="claimed",
        )
        _seed_claim(
            self.base, assignment_id="A-S", claim_id="C-S",
            lease_token="stale-token", event="stale",
        )
        result = submit_worker_result(
            from_worktree=self.worktree, assignment_id="A-S",
            tools_root=self.base, lease_token="stale-token",
        )
        self.assertEqual(result["state"], "rejected")
        self.assertEqual(
            result["reason"],
            "submit_worker_result_claim_already_stale",
        )

    def test_human_required_claim_token_rejects_specific_reason(self) -> None:
        _seed_request(
            self.base, assignment_id="A-H", worktree=self.worktree,
            base_sha=self.base_sha, head_sha=self.head_sha,
        )
        _seed_claim(
            self.base, assignment_id="A-H", claim_id="C-H",
            lease_token="hr-token", event="claimed",
        )
        _seed_claim(
            self.base, assignment_id="A-H", claim_id="C-H",
            lease_token="hr-token", event="human_required",
        )
        result = submit_worker_result(
            from_worktree=self.worktree, assignment_id="A-H",
            tools_root=self.base, lease_token="hr-token",
        )
        self.assertEqual(result["state"], "rejected")
        self.assertEqual(
            result["reason"],
            "submit_worker_result_claim_already_human_required",
        )

    def test_accepted_row_carries_claim_id_and_agent_id_provenance(self) -> None:
        self._seed_request_and_claim()
        result = submit_worker_result(
            from_worktree=self.worktree, assignment_id="A-1",
            tools_root=self.base, lease_token=_TEST_LEASE_TOKEN,
        )
        self.assertEqual(result["state"], "accepted")
        self.assertEqual(result["claim_id"], "C-1")
        self.assertEqual(result["agent_id"], "agent-test")

    def test_accepted_row_does_not_carry_lease_token(self) -> None:
        self._seed_request_and_claim()
        result = submit_worker_result(
            from_worktree=self.worktree, assignment_id="A-1",
            tools_root=self.base, lease_token=_TEST_LEASE_TOKEN,
        )
        self.assertNotIn("lease_token", result)
        self.assertNotIn("lease_token_hash", result)

    def test_correct_token_non_expired_lease_accepts(self) -> None:
        future = "2099-12-31T00:00:00+00:00"
        self._seed_request_and_claim(lease_expires_at=future)
        result = submit_worker_result(
            from_worktree=self.worktree, assignment_id="A-1",
            tools_root=self.base, lease_token=_TEST_LEASE_TOKEN,
        )
        self.assertEqual(result["state"], "accepted")

    def test_recorded_at_present_on_accepted_row(self) -> None:
        self._seed_request_and_claim()
        result = submit_worker_result(
            from_worktree=self.worktree, assignment_id="A-1",
            tools_root=self.base, lease_token=_TEST_LEASE_TOKEN,
        )
        self.assertIn("recorded_at", result)


if __name__ == "__main__":
    unittest.main()
