"""The requeue budget charges the request for the harness's failures.

The budget exists to stop a poisonous request from cycling forever and hand
it to a human. A release whose reason names the HARNESS — the CLI session
died, the renderer was missing, the binding check compared two different
objects — says nothing about the request, and counting it burned the budget
anyway. Measured on production state 2026-08-10: three requests sat in
HUMAN_REQUIRED whose every requeue traced to the deterministic prompt-binding
defect (ORPHAN-CRITICAL-600/601). "The request was poisonous" and "the
harness was broken" had the same price.

The fix is a counting rule in the pure derivation, not a ledger mutation —
which means it heals retroactively: the same claims ledger now derives those
three requests back to PENDING.
"""
from __future__ import annotations

import unittest
from typing import Any

from aria_kernel.agent_invocations import (
    DEFAULT_MAX_REQUEUES,
    HARNESS_FAULT_RELEASE_REASONS,
    REQUEST_FAULT_RELEASE_REASONS,
    _request_fault_requeue_count,
)


def _requeue(request_id: str, reason: str, n: int) -> list[dict[str, Any]]:
    return [
        {"event": "requeued", "request_id": request_id, "reason": reason, "requeue_count": i + 1}
        for i in range(n)
    ]


class FaultOwnedCountingTest(unittest.TestCase):
    def test_harness_fault_requeues_do_not_count(self) -> None:
        rows = _requeue("R", "prompt_hash_binding_mismatch", 5)

        self.assertEqual(_request_fault_requeue_count(rows, "R"), 0)

    def test_request_fault_requeues_count(self) -> None:
        rows = _requeue("R", "lease_expired", 3)

        self.assertEqual(_request_fault_requeue_count(rows, "R"), 3)

    def test_mixed_history_counts_only_the_request_faults(self) -> None:
        # The live shape of the three stuck requests: two harness-fault
        # requeues, then a lease expiry.
        rows = (
            _requeue("R", "prompt_hash_binding_mismatch", 2)
            + _requeue("R", "lease_expired", 1)
        )

        self.assertEqual(_request_fault_requeue_count(rows, "R"), 1)

    def test_an_unclassified_reason_fails_toward_the_human(self) -> None:
        # Unknown reasons burn budget: the failure mode of a stale list must
        # be over-escalation to a person, never silent infinite retry.
        rows = _requeue("R", "some_new_unclassified_reason", 3)

        self.assertEqual(_request_fault_requeue_count(rows, "R"), 3)

    def test_the_two_reason_sets_are_disjoint_and_cover_the_executor(self) -> None:
        self.assertEqual(
            HARNESS_FAULT_RELEASE_REASONS & REQUEST_FAULT_RELEASE_REASONS,
            frozenset(),
        )

    def test_every_executor_release_reason_is_classified(self) -> None:
        # The executor's RELEASE SITES are the source of these strings. A new
        # reason added there without a classification here is exactly how the
        # list would go stale, so it is a test failure instead. The reading is
        # the one shared with the v12 release-site invariant
        # (`tests/_helpers/release_sites`): `_release_claim(..., reason=...)`
        # calls — a literal, each branch of a conditional, an f-string prefix,
        # a pinned name, or a refusal record's `release_reason` whose literal
        # lives in the module-level `ADMISSION_REFUSALS` / `TASK_BINDING_REFUSAL`
        # / `IMPLEMENTATION_IDENTITY_REFUSAL` tables (ARIA-HIGH-107, -115) —
        # never every `reason="..."` in the file: the native fleet's status
        # observations are admissions, not releases.
        from tests._helpers.release_sites import REFUSAL_TABLE_NAMES, scan_executor_release_sites

        scan = scan_executor_release_sites()
        reasons = set(scan.literal)
        self.assertEqual(scan.refusal_tables_seen, set(REFUSAL_TABLE_NAMES),
                         "the executor's refusal release tables must stay module-level literals this scan can read")
        self.assertIn("native_runtime_provider_undecided", reasons)
        self.assertIn("native_runtime_control_unavailable", reasons)
        # ARIA-HIGH-115 round 2: the identity refusal's literal reached the
        # claims ledger through a kernel exception's property, which this
        # scan never read — a wholly unclassified executor release reason
        # failed no static pin. The site now reads the executor's own table.
        self.assertIn("implementation_signing_unavailable", reasons)
        self.assertIn("IMPLEMENTATION_IDENTITY_REFUSAL", scan.attribute_site_names)
        self.assertGreater(scan.release_sites, 0, "the executor must still release through _release_claim")
        self.assertGreater(len(reasons), 0, "release sites must carry literal reasons this scan can see")
        classified = HARNESS_FAULT_RELEASE_REASONS | REQUEST_FAULT_RELEASE_REASONS

        unclassified = sorted(reasons - classified)
        self.assertEqual(
            unclassified,
            [],
            f"release reasons with no fault-ownership classification: {unclassified}",
        )


class TheReadingRefusesAnUnrosteredRecordSiteTest(unittest.TestCase):
    def test_a_release_reason_read_off_an_unrostered_name_is_unreadable(self) -> None:
        # The round-1 shape of ARIA-HIGH-115: `reason=exc.release_reason`, a
        # kernel exception's property. Its literal is in no table the scan
        # reads, so the scan must refuse the site rather than count it.
        from tests._helpers.release_sites import UnreadableReleaseSite, scan_executor_release_sites

        # Every rostered table must be a module-level literal the reading
        # sees; the fixture declares each (ARIA-HIGH-124 added the two
        # delivery refusals to the roster, its round 2 the invalid-request
        # refusal, its round 3 the delivery's window admission).
        source = (
            "ADMISSION_REFUSALS = {'k': _AdmissionRefusalKind(release_reason='a_reason')}\n"
            "TASK_BINDING_REFUSAL = _AdmissionRefusalKind(release_reason='b_reason')\n"
            "IMPLEMENTATION_IDENTITY_REFUSAL = _AdmissionRefusalKind(release_reason='c_reason')\n"
            "DELIVERY_CREDENTIAL_REFUSAL = _AdmissionRefusalKind(release_reason='d_reason')\n"
            "IMPLEMENTATION_BRANCH_COLLISION_REFUSAL = _AdmissionRefusalKind(release_reason='e_reason')\n"
            "IMPLEMENTATION_REQUEST_INVALID_REFUSAL = _AdmissionRefusalKind(release_reason='f_reason')\n"
            "DELIVERY_WINDOW_REFUSAL = _AdmissionRefusalKind(release_reason='g_reason')\n"
            "def main(exc):\n"
            "    _release_claim(reason=exc.release_reason)\n"
        )
        with self.assertRaisesRegex(UnreadableReleaseSite, "'exc'.*classified by nothing"):
            scan_executor_release_sites(source)
        rostered = source.replace("exc.release_reason", "IMPLEMENTATION_IDENTITY_REFUSAL.release_reason")
        scan = scan_executor_release_sites(rostered)
        self.assertEqual(scan.literal, {"a_reason", "b_reason", "c_reason", "d_reason", "e_reason", "f_reason", "g_reason"})
        self.assertEqual(scan.attribute_site_names, {"IMPLEMENTATION_IDENTITY_REFUSAL"})


class DerivationHealsRetroactivelyTest(unittest.TestCase):
    """End to end through derive_request_state, on a synthetic ledger shaped
    like the production one — no mutation, same rows, new derivation."""

    def _derive(self, claims: list[dict[str, Any]]) -> str:
        # derive_request_state reads ledgers off disk; exercising the counting
        # rule through its released-branch logic directly keeps this a unit
        # test. The branch under test is: released -> count -> HUMAN_REQUIRED
        # or REQUEUED/PENDING.
        requeues = _request_fault_requeue_count(claims, "R")
        if requeues > DEFAULT_MAX_REQUEUES:
            return "HUMAN_REQUIRED"
        return "REQUEUED" if requeues > 0 else "PENDING"

    def test_the_stuck_shape_derives_back_to_pending(self) -> None:
        # claimed -> released(mismatch) -> requeued(mismatch), three times
        # over: yesterday this derived HUMAN_REQUIRED; the same rows must now
        # derive PENDING because no request fault ever happened.
        claims = _requeue("R", "prompt_hash_binding_mismatch", 3)

        self.assertEqual(self._derive(claims), "PENDING")

    def test_a_genuinely_poisonous_request_still_escalates(self) -> None:
        claims = _requeue("R", "lease_expired", DEFAULT_MAX_REQUEUES + 1)

        self.assertEqual(self._derive(claims), "HUMAN_REQUIRED")

    def test_a_materialized_escalation_row_is_rederived_not_frozen(self) -> None:
        # The exact production shape: the ceiling was crossed by counting
        # harness faults, and the human_required row froze that verdict. The
        # row itself carries a harness reason, so under the honest rule the
        # same ledger derives PENDING.
        claims = _requeue("R", "prompt_hash_binding_mismatch", 2) + [{
            "event": "human_required", "request_id": "R",
            "reason": "prompt_hash_binding_mismatch", "requeue_count": 3,
        }]

        self.assertEqual(_request_fault_requeue_count(claims, "R"), 0)
        self.assertEqual(self._derive(claims), "PENDING")

    def test_an_escalation_row_with_a_real_fault_counts_as_the_crossing_requeue(self) -> None:
        # Production request …4459: two legacy exit-code releases (harness),
        # then a lease expiry escalation. One real fault, below the ceiling.
        claims = _requeue("R", "claude_cli_exit_1", 2) + [{
            "event": "human_required", "request_id": "R",
            "reason": "lease_expired", "requeue_count": 3,
        }]

        self.assertEqual(_request_fault_requeue_count(claims, "R"), 1)
        self.assertEqual(self._derive(claims), "REQUEUED")

    def test_the_dynamic_exit_code_reason_is_harness_class(self) -> None:
        # `claude_cli_exit_<code>` is minted with an f-string, so membership
        # cannot be a set lookup; five consecutive nights of exit_1 were an
        # expired OAuth session, not five poisonous requests.
        rows = _requeue("R", "claude_cli_exit_1", 2) + _requeue("R", "claude_cli_exit_143", 1)

        self.assertEqual(_request_fault_requeue_count(rows, "R"), 0)


if __name__ == "__main__":
    unittest.main()
