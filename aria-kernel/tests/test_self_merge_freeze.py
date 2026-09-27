"""ARIA-HIGH-200 — ARIA's own self-merge freeze, lifted only by an operator.

Pins the state machine (freeze → registered revert → operator unfreeze), the
single thing a frozen merge authority admits, and that the freeze is read by
the one real-merge authority.
"""

from __future__ import annotations

import inspect
import io
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from aria_kernel import cli, merge_authority
from aria_kernel.runtime_profile import set_profile
from aria_kernel.self_merge_freeze import (
    FROZEN_EVENT,
    active_freeze,
    assert_self_merge_not_frozen,
    freeze_id_for,
    freeze_ledger_path,
    freeze_self_merge,
    register_revert,
    unfreeze_self_merge,
)
from aria_kernel.tool_registry import GovernanceError, append_tools_governance, ensure_tools_dir

MERGE_SHA = "a" * 40
PURE = {"pure": True, "patch_id": "p" * 40}


class SelfMergeFreezeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.tools = Path(self.tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)

    def _freeze(self) -> dict:
        return freeze_self_merge(
            merge_sha=MERGE_SHA,
            pr_number=41,
            trigger="merge_outcome_red",
            evidence={"red_jobs": ["build-status"]},
            base_dir=self.tools,
        )

    def _register(self, freeze_id: str, *, pr_number: int = 42, head_sha: str = "b" * 40) -> None:
        register_revert(
            freeze_id=freeze_id, pr_number=pr_number, head_sha=head_sha,
            purity=PURE, base_dir=self.tools,
        )

    def _operator_ref(self) -> str:
        event = append_tools_governance(self.tools, "operator_unfreeze_decision", {"by": "operator"})
        return f"gov:{event['event_id']}"

    def test_no_freeze_admits_every_pr(self) -> None:
        self.assertIsNone(active_freeze(base_dir=self.tools))
        self.assertIsNone(assert_self_merge_not_frozen(pr_number=7, head_sha="c" * 40, base_dir=self.tools))

    def test_a_freeze_refuses_an_ordinary_pr(self) -> None:
        self._freeze()
        with self.assertRaisesRegex(GovernanceError, "self_merge_frozen"):
            assert_self_merge_not_frozen(pr_number=7, head_sha="c" * 40, base_dir=self.tools)

    def test_the_same_merge_freezes_once(self) -> None:
        first = self._freeze()
        second = self._freeze()
        self.assertEqual(first["freeze_id"], second["freeze_id"])
        self.assertEqual(first["freeze_id"], freeze_id_for(MERGE_SHA))
        text = freeze_ledger_path(self.tools).read_text(encoding="utf-8")
        self.assertEqual(text.count(FROZEN_EVENT), 1)

    def test_only_the_registered_revert_at_its_head_is_admitted(self) -> None:
        freeze_id = self._freeze()["freeze_id"]
        self._register(freeze_id)
        admitted = assert_self_merge_not_frozen(pr_number=42, head_sha="b" * 40, base_dir=self.tools)
        self.assertEqual(admitted["freeze_id"], freeze_id)
        # A new push to the revert branch is not the proven revert.
        with self.assertRaisesRegex(GovernanceError, "self_merge_frozen"):
            assert_self_merge_not_frozen(pr_number=42, head_sha="d" * 40, base_dir=self.tools)
        with self.assertRaisesRegex(GovernanceError, "self_merge_frozen"):
            assert_self_merge_not_frozen(pr_number=43, head_sha="b" * 40, base_dir=self.tools)

    def test_an_impure_revert_is_never_registered(self) -> None:
        freeze_id = self._freeze()["freeze_id"]
        with self.assertRaisesRegex(GovernanceError, "self_merge_revert_not_pure"):
            register_revert(
                freeze_id=freeze_id, pr_number=42, head_sha="b" * 40,
                purity={"pure": False}, base_dir=self.tools,
            )

    def test_a_revert_for_an_unknown_freeze_is_refused(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "self_merge_revert_unknown_freeze"):
            self._register("freeze-unknown")

    def test_an_environment_acknowledgment_cannot_unfreeze(self) -> None:
        freeze_id = self._freeze()["freeze_id"]
        with mock.patch.dict("os.environ", {"ARIA_UNFREEZE_ACK": "yes"}):
            with self.assertRaisesRegex(GovernanceError, "requires_recorded_operator_act:ack-env"):
                unfreeze_self_merge(
                    freeze_id=freeze_id, operator_approval_ref="ack-env:ARIA_UNFREEZE_ACK",
                    base_dir=self.tools,
                )
        self.assertIsNotNone(active_freeze(base_dir=self.tools))

    def test_an_unrecorded_governance_ref_cannot_unfreeze(self) -> None:
        freeze_id = self._freeze()["freeze_id"]
        with self.assertRaisesRegex(GovernanceError, "self_merge_unfreeze_approval_unrecorded"):
            unfreeze_self_merge(
                freeze_id=freeze_id, operator_approval_ref="gov:evt-never-recorded",
                base_dir=self.tools,
            )
        self.assertIsNotNone(active_freeze(base_dir=self.tools))

    def test_a_recorded_operator_act_lifts_the_freeze(self) -> None:
        freeze_id = self._freeze()["freeze_id"]
        row = unfreeze_self_merge(
            freeze_id=freeze_id, operator_approval_ref=self._operator_ref(), base_dir=self.tools,
        )
        self.assertEqual(row["approval"]["kind"], "gov")
        self.assertIsNone(active_freeze(base_dir=self.tools))
        self.assertIsNone(assert_self_merge_not_frozen(pr_number=7, head_sha="c" * 40, base_dir=self.tools))

    def test_the_revert_merging_does_not_lift_the_freeze(self) -> None:
        freeze_id = self._freeze()["freeze_id"]
        self._register(freeze_id)
        assert_self_merge_not_frozen(pr_number=42, head_sha="b" * 40, base_dir=self.tools)
        with self.assertRaisesRegex(GovernanceError, "self_merge_frozen"):
            assert_self_merge_not_frozen(pr_number=44, head_sha="e" * 40, base_dir=self.tools)

    def test_unfreezing_an_inactive_freeze_is_refused(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "self_merge_unfreeze_unknown_or_inactive"):
            unfreeze_self_merge(
                freeze_id="freeze-none", operator_approval_ref=self._operator_ref(), base_dir=self.tools,
            )


    def test_a_freeze_lands_under_any_profile_but_a_revert_needs_pr_merge(self) -> None:
        # A restriction must never be blocked by the profile; admitting a
        # merge must be.
        set_profile("frozen", operator_approval_ref="op:freeze", base_dir=self.tools)
        freeze_id = self._freeze()["freeze_id"]
        self.assertIsNotNone(active_freeze(base_dir=self.tools))
        with self.assertRaisesRegex(GovernanceError, "profile_violation: surface 'pr_merge'"):
            self._register(freeze_id)


    def test_the_operator_cli_lifts_a_freeze_and_refuses_ack_env(self) -> None:
        freeze_id = self._freeze()["freeze_id"]
        base = ["--tools-dir", str(self.tools), "merge-lane", "unfreeze", "--freeze-id", freeze_id]
        with mock.patch.dict("os.environ", {"ARIA_UNFREEZE_ACK": "yes"}):
            with self.assertRaisesRegex(GovernanceError, "requires_recorded_operator_act"):
                cli.main(base + ["--operator-approval-ref", "ack-env:ARIA_UNFREEZE_ACK"])
        with mock.patch("sys.stdout", new_callable=io.StringIO):
            self.assertEqual(cli.main(base + ["--operator-approval-ref", self._operator_ref()]), 0)
        self.assertIsNone(active_freeze(base_dir=self.tools))


class MergeAuthorityReadsTheFreezeTests(unittest.TestCase):
    def test_the_freeze_is_read_at_the_single_real_merge_authority_before_any_evidence(self) -> None:
        source = inspect.getsource(merge_authority.merge_pr_if_ready)
        freeze_at = source.index("assert_self_merge_not_frozen(")
        self.assertLess(source.index("head_sha = _head_sha(live_pr)"), freeze_at)
        self.assertLess(freeze_at, source.index("record_risk_decision_for_pr("))


if __name__ == "__main__":
    unittest.main()
