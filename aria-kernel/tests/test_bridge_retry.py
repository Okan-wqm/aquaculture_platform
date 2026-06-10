"""Plan 026R §C.5 — bridge retry append-only ledger + crash recovery.

14 tests across 4 test classes:

Constants + transition enum (3):
* BRIDGE_REQUIRED_ROLES shape — 9 roles, frozenset, exported SSoT.
* BRIDGE_TRANSITIONS shape — 4 values, ``pending`` NOT a transition.
* bridge_status_for_role: pending vs not_required predicate.

Ledger primitive contract (4):
* append_bridge_status writes a hash-chained row.
* append_bridge_status rejects unknown transition values.
* append_bridge_status rejects negative attempt_number.
* latest_bridge_status_for returns most-recent row by
  (result_row_ledger_hash, envelope_evidence_hash) pair.

derive_bridge_state crash-recovery + lookup (4):
* Result row with ``bridge_status: "pending"`` + no ledger row →
  ``state="pending"``, ``crash_recovery_triggered=True``.
* Result row with bridge ledger ``ok`` → ``state="ok"``.
* Result row with bridge ledger ``pending_retry`` → ``state="pending_retry"``.
* Result row legacy (no ledger_hash / no envelope_evidence_hash) →
  ``state="not_required"`` (legacy compat).

derive_request_state integration (3):
* Accepted row + bridge ``ok`` → derive_request_state returns ``ACCEPTED``.
* Accepted row + bridge ``pending_retry`` → ``ACCEPTED_PENDING_BRIDGE``.
* Accepted row + bridge ``permanent_fail`` →
  ``ACCEPTED_PENDING_BRIDGE_PERMANENT_FAIL``.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel.bridge_status_ledger import (
    BRIDGE_LEDGER_FILENAME,
    BRIDGE_REQUIRED_ROLES,
    BRIDGE_TRANSITIONS,
    append_bridge_status,
    bridge_status_for_role,
    derive_bridge_state,
    latest_bridge_status_for,
)
from aria_kernel.ledger import load_jsonl
from aria_kernel.runtime_profile import set_profile
from aria_kernel.tool_registry import GovernanceError
from tests._helpers.declared_fixtures import append_declared_fixture


class BridgeConstantsTests(unittest.TestCase):
    def test_bridge_required_roles_shape(self) -> None:
        self.assertEqual(
            BRIDGE_REQUIRED_ROLES,
            frozenset({
                "evidence_judgment",
                "adversarial_judgment",
                "consensus_arbitration",
                "primary_plan",
                "challenger_plan",
                "cross_review",
                "change_intelligence",
                "goldset_curation",
                "implementation",
            }),
        )
        self.assertEqual(len(BRIDGE_REQUIRED_ROLES), 9)

    def test_bridge_transitions_closed_enum(self) -> None:
        self.assertEqual(
            BRIDGE_TRANSITIONS,
            frozenset({"ok", "pending_retry", "not_required", "permanent_fail"}),
        )
        # Plan 026R §C.5 — pending is NOT a transition (lives on result row).
        self.assertNotIn("pending", BRIDGE_TRANSITIONS)

    def test_bridge_status_for_role_predicate(self) -> None:
        for role in BRIDGE_REQUIRED_ROLES:
            self.assertEqual(bridge_status_for_role(role), "pending")
        for non_required in ("unknown", "", None):
            self.assertEqual(bridge_status_for_role(non_required), "not_required")


class BridgeLedgerAppendTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-c5-"))
        self.base = self.tmp / "aria-tools"
        set_profile("standard", operator_approval_ref="t", base_dir=self.base)

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_append_bridge_status_writes_hash_chained_row(self) -> None:
        row = append_bridge_status(
            base_dir=self.base,
            result_row_ledger_hash="sha256:" + "a" * 64,
            envelope_evidence_hash="sha256:" + "b" * 64,
            role="evidence_judgment",
            transition="ok",
            attempt_number=1,
        )
        self.assertEqual(row["transition"], "ok")
        self.assertEqual(row["attempt_number"], 1)
        self.assertTrue(row["ledger_hash"].startswith("sha256:"))

    def test_append_bridge_status_rejects_unknown_transition(self) -> None:
        with self.assertRaises(GovernanceError) as ctx:
            append_bridge_status(
                base_dir=self.base,
                result_row_ledger_hash="sha256:x",
                envelope_evidence_hash="sha256:y",
                role="evidence_judgment",
                transition="pending",  # not a valid transition
                attempt_number=1,
            )
        self.assertIn("bridge_transition_unknown", str(ctx.exception))

    def test_append_bridge_status_rejects_negative_attempt(self) -> None:
        with self.assertRaises(GovernanceError) as ctx:
            append_bridge_status(
                base_dir=self.base,
                result_row_ledger_hash="sha256:x",
                envelope_evidence_hash="sha256:y",
                role="evidence_judgment",
                transition="ok",
                attempt_number=-1,
            )
        self.assertIn("bridge_attempt_number_negative", str(ctx.exception))

    def test_latest_bridge_status_for_returns_most_recent(self) -> None:
        rrh = "sha256:" + "a" * 64
        ee = "sha256:" + "b" * 64
        append_bridge_status(
            base_dir=self.base, result_row_ledger_hash=rrh,
            envelope_evidence_hash=ee, role="evidence_judgment",
            transition="pending_retry", attempt_number=1,
        )
        append_bridge_status(
            base_dir=self.base, result_row_ledger_hash=rrh,
            envelope_evidence_hash=ee, role="evidence_judgment",
            transition="pending_retry", attempt_number=2,
        )
        append_bridge_status(
            base_dir=self.base, result_row_ledger_hash=rrh,
            envelope_evidence_hash=ee, role="evidence_judgment",
            transition="ok", attempt_number=3,
        )
        latest = latest_bridge_status_for(
            base_dir=self.base, result_row_ledger_hash=rrh,
            envelope_evidence_hash=ee,
        )
        self.assertEqual(latest["transition"], "ok")
        self.assertEqual(latest["attempt_number"], 3)
        # Append-only invariant: ledger contains 3 rows, none patched.
        rows = load_jsonl(
            self.base / "agent-invocations" / BRIDGE_LEDGER_FILENAME,
        )
        self.assertEqual(len(rows), 3)


class DeriveBridgeStateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-c5-derive-"))
        self.base = self.tmp / "aria-tools"
        set_profile("standard", operator_approval_ref="t", base_dir=self.base)

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _result_row(
        self, *, bridge_status: str, ledger_hash: str = "sha256:rrh",
        envelope_evidence_hash: str = "sha256:ee",
    ) -> dict:
        return {
            "claim_id": "claim-x", "request_id": "req-x", "agent_id": "a",
            "role": "evidence_judgment", "status": "accepted",
            "bridge_status": bridge_status, "ledger_hash": ledger_hash,
            "envelope_evidence_hash": envelope_evidence_hash,
        }

    def test_crash_recovery_pending_with_no_ledger_row(self) -> None:
        # Plan 026R §C.5 — pending result row + missing bridge-ledger
        # row triggers crash-recovery rule (pending attempt 0).
        row = self._result_row(bridge_status="pending")
        state = derive_bridge_state(base_dir=self.base, result_row=row)
        self.assertEqual(state["state"], "pending")
        self.assertEqual(state["attempt_number"], 0)
        self.assertTrue(state["crash_recovery_triggered"])

    def test_bridge_ledger_ok_resolves_to_ok(self) -> None:
        row = self._result_row(bridge_status="pending")
        append_bridge_status(
            base_dir=self.base,
            result_row_ledger_hash=row["ledger_hash"],
            envelope_evidence_hash=row["envelope_evidence_hash"],
            role="evidence_judgment",
            transition="ok", attempt_number=1,
        )
        state = derive_bridge_state(base_dir=self.base, result_row=row)
        self.assertEqual(state["state"], "ok")
        self.assertFalse(state["crash_recovery_triggered"])

    def test_bridge_ledger_pending_retry_resolves_to_pending_retry(self) -> None:
        row = self._result_row(bridge_status="pending")
        append_bridge_status(
            base_dir=self.base,
            result_row_ledger_hash=row["ledger_hash"],
            envelope_evidence_hash=row["envelope_evidence_hash"],
            role="evidence_judgment",
            transition="pending_retry", attempt_number=2,
        )
        state = derive_bridge_state(base_dir=self.base, result_row=row)
        self.assertEqual(state["state"], "pending_retry")
        self.assertEqual(state["attempt_number"], 2)

    def test_legacy_row_without_ledger_hash_resolves_to_not_required(self) -> None:
        # Pre-§C.5 result rows that lack ledger_hash or envelope_evidence_hash
        # are treated as not_required so derive_request_state preserves
        # the pre-§C.5 ACCEPTED state.
        legacy_row = {
            "claim_id": "claim-old", "request_id": "req-old",
            "role": "evidence_judgment", "status": "accepted",
        }
        state = derive_bridge_state(base_dir=self.base, result_row=legacy_row)
        self.assertEqual(state["state"], "not_required")


class DeriveRequestStateBridgeAwareTests(unittest.TestCase):
    """derive_request_state integration — accepted rows lift to
    ACCEPTED / ACCEPTED_PENDING_BRIDGE / ACCEPTED_PENDING_BRIDGE_PERMANENT_FAIL
    based on the bridge-status ledger."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-c5-int-"))
        self.base = self.tmp / "aria-tools"
        set_profile("standard", operator_approval_ref="t", base_dir=self.base)
        # Stage a minimal request row + an accepted result row directly
        # (skip the full submit_claim_result pipeline for state-derivation
        # focus).
        self.request_id = "req-c5"
        append_declared_fixture(
            self.base / "agent-invocations" / "requests.jsonl",
            {
                "$schema": "aria/agent-invocation-request/v1",
                "schema_version": 1,
                "request_id": self.request_id,
                "target_agent": "agent",
                "role": "evidence_judgment",
                "state": "pending",
            },
            expected_surface="agent_invocation_requests",
        )
        self.envelope_evidence_hash = "sha256:" + "e" * 64
        self.persisted_result = append_declared_fixture(
            self.base / "agent-invocations" / "results.jsonl",
            {
                "$schema": "aria/agent-claim-result/v1",
                "schema_version": 1,
                "claim_id": "claim-c5",
                "request_id": self.request_id,
                "agent_id": "agent",
                "role": "evidence_judgment",
                "status": "accepted",
                "output_path": "/tmp/x.json",
                "content_hash": "sha256:c",
                "envelope_evidence_hash": self.envelope_evidence_hash,
                "bridge_status": "pending",
            },
            expected_surface="agent_invocation_results",
        )

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_bridge_ok_lifts_to_accepted(self) -> None:
        from aria_kernel.agent_invocations import derive_request_state
        append_bridge_status(
            base_dir=self.base,
            result_row_ledger_hash=str(self.persisted_result["ledger_hash"]),
            envelope_evidence_hash=self.envelope_evidence_hash,
            role="evidence_judgment",
            transition="ok", attempt_number=1,
        )
        self.assertEqual(
            derive_request_state(request_id=self.request_id, base_dir=self.base),
            "ACCEPTED",
        )

    def test_bridge_pending_retry_lifts_to_accepted_pending_bridge(self) -> None:
        from aria_kernel.agent_invocations import derive_request_state
        append_bridge_status(
            base_dir=self.base,
            result_row_ledger_hash=str(self.persisted_result["ledger_hash"]),
            envelope_evidence_hash=self.envelope_evidence_hash,
            role="evidence_judgment",
            transition="pending_retry", attempt_number=1,
        )
        self.assertEqual(
            derive_request_state(request_id=self.request_id, base_dir=self.base),
            "ACCEPTED_PENDING_BRIDGE",
        )

    def test_bridge_permanent_fail_lifts_to_terminal_permanent_fail(self) -> None:
        from aria_kernel.agent_invocations import derive_request_state
        append_bridge_status(
            base_dir=self.base,
            result_row_ledger_hash=str(self.persisted_result["ledger_hash"]),
            envelope_evidence_hash=self.envelope_evidence_hash,
            role="evidence_judgment",
            transition="permanent_fail", attempt_number=3,
        )
        self.assertEqual(
            derive_request_state(request_id=self.request_id, base_dir=self.base),
            "ACCEPTED_PENDING_BRIDGE_PERMANENT_FAIL",
        )


if __name__ == "__main__":
    unittest.main()
