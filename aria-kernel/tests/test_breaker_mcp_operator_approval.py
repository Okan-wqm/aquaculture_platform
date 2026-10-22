"""ARIA-HIGH-238 slices 1-2 — clearing a stop is an authority grant.

Resetting the failure breaker, resetting the cost breaker, quarantining
damaged breaker evidence and releasing a quarantined MCP server each widen
what ARIA may do again. Before this, each took ``operator_approval_ref`` (or
``operator_ref``) as a free string that nothing verified, so any non-empty
text cleared the stop: ARIA could write it for itself.

Each is now proven like every other raising surface: by an operator's GitHub
act, verified through the API (``operator_approval.verify_operator_approval``)
and consumed once. ``verify_operator_approval`` has no lower freshness bound,
so the scope binds to the INSTANCE being undone — the trip (``tripped_at``)
or the quarantine (``quarantined_at``) — and an act posted for one trip
cannot clear a later one. These tests run the real functions against a fake
GitHub (never the network).
"""
from __future__ import annotations

import io
import json
import os
import shutil
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

from aria_kernel import circuit_breaker as cb
from aria_kernel import cli
from aria_kernel import control
from aria_kernel import cost_budget
from aria_kernel import mcp_client as mc
from aria_kernel.operator_approval import (
    APPROVAL_CONSUMED_EVENT,
    GITHUB_REF_GRAMMAR,
    NO_RECORDED_INSTANCE,
    approval_line,
    recorded_instance,
)
from aria_kernel.tool_registry import GovernanceError, append_tools_governance, ensure_tools_dir
from tests._helpers.operator_acts import REPOSITORY, github_operator_acts

_TRUNCATED = '{"ts":"2020-01'
_EARLIER_TRIP = "2026-01-01T00:00:00Z"


def _stamps(moment: datetime) -> tuple[str, str]:
    """(the kernel's stamp with its microseconds, the canonical scope spelling)."""
    return moment.strftime("%Y-%m-%dT%H:%M:%S.%fZ"), moment.strftime("%Y-%m-%dT%H:%M:%SZ")


# The failure breaker counts only rows inside its sliding window measured from
# the REAL clock (circuit_breaker._count_failures_in_window), and the trip stamp
# patched in below is also every failure row's `ts`. So the trip happens minutes
# ago, never on a calendar date: a literal date stops tripping the breaker once
# the window has passed it. A fixed microsecond part keeps the canonicalization
# assertions meaningful (the scope spelling drops it).
_TRIP_MOMENT = (datetime.now(timezone.utc) - timedelta(minutes=5)).replace(microsecond=123456)
_TRIP_STAMP, _TRIP_CANONICAL = _stamps(_TRIP_MOMENT)
_LATER_STAMP = _stamps(_TRIP_MOMENT + timedelta(minutes=1))[0]
# MCP quarantine is decided by call counts, not by the clock, so its stamps can
# stay literal.
_MCP_AT = "2026-10-16T08:00:00+00:00"


class _Store(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = Path(tempfile.mkdtemp(prefix="aria-238-"))
        self.addCleanup(shutil.rmtree, self._tmp, True)
        self.root = ensure_tools_dir(self._tmp / "aria-tools")
        acts = github_operator_acts()
        self.github = acts.__enter__()
        self.addCleanup(acts.__exit__, None, None, None)

    def authored_refs(self) -> tuple[str, ...]:
        """References ARIA can author itself: none of them is an approval."""
        event = append_tools_governance(self.root, "operator_action", {"action": "approve"})
        doc = self._tmp / "review.md"
        doc.write_text("## OP-1\n", encoding="utf-8")
        os.environ["ARIA_TEST_ACK_238"] = "yes"
        self.addCleanup(os.environ.pop, "ARIA_TEST_ACK_238", None)
        return ("OPS-4711", "", f"gov:{event['event_id']}", f"review:{doc}#OP-1", "ack-env:ARIA_TEST_ACK_238")

    def governance(self, kind: str) -> list[dict]:
        path = self.root / "governance.jsonl"
        if not path.exists():
            return []
        rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
        return [row for row in rows if row.get("kind") == kind]

    def trip_autonomous(self) -> None:
        for index in range(3):
            self.record_failure_at(_TRIP_STAMP, f"EV-{index}")
        self.assertEqual(cb.current_state(self.root), cb.BREAKER_STATE_TRIPPED)

    def record_failure_at(self, stamp: str, event_id: str) -> None:
        with mock.patch("aria_kernel.circuit_breaker.utc_now_stamp", return_value=stamp):
            cb.record_failure(base_dir=self.root, kind="ci_red", materialize_event_id=event_id)

    def trip_cost(self, at: str = _TRIP_STAMP) -> None:
        with mock.patch("aria_kernel.cost_budget.utc_now_stamp", return_value=at):
            cost_budget._trip_breaker(self.root, cap_name="daily", amount=6.0, cap=5.0)
        self.assertEqual(cost_budget.current_state(self.root), "tripped")

    def freeze(self) -> None:
        from aria_kernel.runtime_profile import set_profile

        set_profile("frozen", operator_approval_ref="incident: stop", base_dir=self.root)

    def assert_frozen_refusal(self, action) -> None:
        """Refused by the frozen-profile gate, with no operator act spent."""
        with self.assertRaisesRegex(GovernanceError, "profile_violation"):
            action()
        self.assertEqual(self.governance(APPROVAL_CONSUMED_EVENT), [])

    def quarantine_mcp(self, server: str = "aria", *, at: str = _MCP_AT) -> None:
        # Only the kernel's own side=server outcomes quarantine (ARIA-MEDIUM-609),
        # and a fault the caller caused never counts, so the witnessed faults are
        # server-side and of a class outside QUARANTINE_CALLER_ERROR_CLASSES.
        with mock.patch("aria_kernel.mcp_client.utc_now", return_value=at):
            for _ in range(mc.QUARANTINE_MIN_CALLS):
                mc.record_mcp_call(tool_name=f"{server}/search", ok=False, side="server",
                                   error_class="RuntimeError", base_dir=self.root)
        self.assertIn(server, mc.quarantined_servers(self.root))


class RecordedInstance(unittest.TestCase):
    """``recorded_instance`` is the one owner of "the recorded stamp, else none"."""

    def test_only_one_timezone_aware_stamp_is_an_instance(self) -> None:
        for stamp in (_TRIP_STAMP, _TRIP_CANONICAL, _MCP_AT):
            with self.subTest(stamp=stamp):
                self.assertEqual(recorded_instance(stamp), stamp)
                # The instance it names is a scope field the verifier accepts.
                approval_line("breaker_reset", {"breaker": "cost", "tripped_at": recorded_instance(stamp)})

    def test_anything_else_records_no_instance(self) -> None:
        """Every value here made ``canonical_scope`` raise, or named no instant at all."""
        for value in (None, "", 7, "2026-10-20 10:00:00Z", " 2026-10-20T10:00:00Z", "2026-10-20T10:00:00Z\n",
                      "2026-10-20T10:00:00", "yesterday", "a=b"):
            with self.subTest(value=value):
                self.assertEqual(recorded_instance(value), NO_RECORDED_INSTANCE)


class FailureBreakerReset(_Store):
    def test_a_reference_aria_can_author_does_not_clear_the_breaker(self) -> None:
        self.trip_autonomous()
        for ref in self.authored_refs():
            with self.subTest(ref=ref), self.assertRaisesRegex(GovernanceError, "breaker_reset_approval_unrecorded"):
                cb.reset_breaker(base_dir=self.root, operator_approval_ref=ref, reason="investigated")
        self.assertEqual(cb.current_state(self.root), cb.BREAKER_STATE_TRIPPED)
        self.assertEqual(self.governance(cb.BREAKER_RESET_EVENT), [])

    def test_the_act_for_this_trip_clears_it_once(self) -> None:
        self.trip_autonomous()
        scope = cb.trip_scope(self.root)
        self.assertEqual(scope, {"breaker": "autonomous", "tripped_at": _TRIP_STAMP})
        ref = self.github.approve("breaker_reset", scope)
        self.assertEqual(cb.reset_breaker(base_dir=self.root, operator_approval_ref=ref, reason="investigated"),
                         {"status": "ok"})
        self.assertEqual(cb.current_state(self.root), cb.BREAKER_STATE_OK)
        (row,) = self.governance(cb.BREAKER_RESET_EVENT)
        self.assertEqual(row["details"]["operator_approval"]["ref"], ref)
        self.assertEqual(row["details"]["operator_approval"]["scope"]["tripped_at"], _TRIP_CANONICAL)
        self.assertEqual(len(self.governance(APPROVAL_CONSUMED_EVENT)), 1)
        # The same trip instance again: the act is spent.
        self.trip_autonomous()
        with self.assertRaisesRegex(GovernanceError, "already consumed"):
            cb.reset_breaker(base_dir=self.root, operator_approval_ref=ref, reason="again")
        self.assertEqual(cb.current_state(self.root), cb.BREAKER_STATE_TRIPPED)

    def test_an_act_for_another_breaker_or_an_earlier_trip_is_refused(self) -> None:
        self.trip_autonomous()
        for scope in ({"breaker": "cost", "tripped_at": _TRIP_STAMP},
                      {"breaker": "autonomous", "tripped_at": _EARLIER_TRIP}):
            with self.subTest(scope=scope), self.assertRaisesRegex(GovernanceError, "breaker_reset_approval_unrecorded"):
                cb.reset_breaker(base_dir=self.root, operator_approval_ref=self.github.approve("breaker_reset", scope),
                                 reason="investigated")
        self.assertEqual(cb.current_state(self.root), cb.BREAKER_STATE_TRIPPED)

    def test_an_act_for_this_trip_is_stale_once_a_later_failure_restamps_it(self) -> None:
        """The real stale-act path: evidence that arrives after the act asks for a new one."""
        self.trip_autonomous()
        ref = self.github.approve("breaker_reset", cb.trip_scope(self.root))
        self.record_failure_at(_LATER_STAMP, "EV-later")
        self.assertEqual(cb.trip_scope(self.root)["tripped_at"], _LATER_STAMP)
        ledger_before = cb._failures_path(self.root).read_text(encoding="utf-8")
        with self.assertRaisesRegex(GovernanceError, "breaker_reset_approval_unrecorded"):
            cb.reset_breaker(base_dir=self.root, operator_approval_ref=ref, reason="investigated")
        self.assertEqual(cb.current_state(self.root), cb.BREAKER_STATE_TRIPPED)
        self.assertEqual(cb._failures_path(self.root).read_text(encoding="utf-8"), ledger_before)
        self.assertEqual(self.governance(APPROVAL_CONSUMED_EVENT), [])

    def test_a_breaker_with_no_recorded_trip_binds_to_none(self) -> None:
        ledger = cb._failures_path(self.root)
        ledger.parent.mkdir(parents=True, exist_ok=True)
        ledger.write_text(json.dumps({"ts": _TRIP_STAMP, "kind": "ci_red"}) + "\n", encoding="utf-8")
        self.assertEqual(cb.trip_scope(self.root), {"breaker": "autonomous", "tripped_at": NO_RECORDED_INSTANCE})
        ref = self.github.approve("breaker_reset", cb.trip_scope(self.root))
        cb.reset_breaker(base_dir=self.root, operator_approval_ref=ref, reason="clean slate")
        self.assertEqual(ledger.read_text(encoding="utf-8"), "")

    def test_a_frozen_kernel_refuses_before_the_act_is_spent_or_the_ledger_cut(self) -> None:
        self.trip_autonomous()
        ref = self.github.approve("breaker_reset", cb.trip_scope(self.root))
        self.freeze()
        ledger_before = cb._failures_path(self.root).read_text(encoding="utf-8")
        self.assert_frozen_refusal(
            lambda: cb.reset_breaker(base_dir=self.root, operator_approval_ref=ref, reason="investigated"))
        self.assertEqual(cb._failures_path(self.root).read_text(encoding="utf-8"), ledger_before)
        self.assertEqual(cb.current_state(self.root), cb.BREAKER_STATE_TRIPPED)


class BreakerEvidenceQuarantine(_Store):
    def _damage(self) -> None:
        ledger = cb._failures_path(self.root)
        ledger.parent.mkdir(parents=True, exist_ok=True)
        with ledger.open("a", encoding="utf-8") as handle:
            handle.write(_TRUNCATED + "\n")

    def test_a_reference_aria_can_author_moves_nothing(self) -> None:
        self.trip_autonomous()
        self._damage()
        for ref in self.authored_refs():
            with self.subTest(ref=ref), self.assertRaisesRegex(
                GovernanceError, "breaker_evidence_quarantine_approval_unrecorded",
            ):
                cb.quarantine_breaker_evidence(base_dir=self.root, operator_approval_ref=ref, reason="truncated row")
        self.assertFalse(cb._quarantine_path(self.root).exists())

    def test_the_act_for_this_trip_quarantines_once_and_is_recorded(self) -> None:
        self.trip_autonomous()
        self._damage()
        scope = cb.trip_scope(self.root)
        ref = self.github.approve("breaker_evidence_quarantine", scope)
        result = cb.quarantine_breaker_evidence(base_dir=self.root, operator_approval_ref=ref, reason="truncated row")
        self.assertEqual(result["quarantined"], 1)
        header = json.loads(cb._quarantine_path(self.root).read_text(encoding="utf-8").splitlines()[0])
        self.assertEqual(header["operator_approval"]["ref"], ref)
        (row,) = self.governance(cb.BREAKER_EVIDENCE_QUARANTINED_EVENT)
        self.assertEqual(row["details"]["operator_approval"]["surface"], "breaker_evidence_quarantine")
        self._damage()
        with self.assertRaisesRegex(GovernanceError, "already consumed"):
            cb.quarantine_breaker_evidence(base_dir=self.root, operator_approval_ref=ref, reason="truncated again")

    def test_an_act_for_another_breaker_an_earlier_trip_or_a_reset_is_refused(self) -> None:
        self.trip_autonomous()
        self._damage()
        scope = cb.trip_scope(self.root)
        for surface, wrong in (
            ("breaker_evidence_quarantine", {**scope, "breaker": "cost"}),
            ("breaker_evidence_quarantine", {**scope, "tripped_at": _EARLIER_TRIP}),
            ("breaker_reset", scope),
        ):
            with self.subTest(surface=surface, scope=wrong), self.assertRaisesRegex(
                GovernanceError, "breaker_evidence_quarantine_approval_unrecorded",
            ):
                cb.quarantine_breaker_evidence(
                    base_dir=self.root, operator_approval_ref=self.github.approve(surface, wrong), reason="truncated",
                )
        self.assertFalse(cb._quarantine_path(self.root).exists())

    def test_an_act_for_this_trip_is_stale_once_a_later_failure_restamps_it(self) -> None:
        # A damaged ledger refuses appends, so the later failure lands before
        # the damage: the act was posted for the trip as it stood then.
        self.trip_autonomous()
        ref = self.github.approve("breaker_evidence_quarantine", cb.trip_scope(self.root))
        self.record_failure_at(_LATER_STAMP, "EV-later")
        self._damage()
        ledger_before = cb._failures_path(self.root).read_bytes()
        with self.assertRaisesRegex(GovernanceError, "breaker_evidence_quarantine_approval_unrecorded"):
            cb.quarantine_breaker_evidence(base_dir=self.root, operator_approval_ref=ref, reason="truncated row")
        self.assertFalse(cb._quarantine_path(self.root).exists())
        self.assertEqual(cb._failures_path(self.root).read_bytes(), ledger_before)
        self.assertEqual(self.governance(APPROVAL_CONSUMED_EVENT), [])

    def test_a_frozen_kernel_refuses_before_the_act_is_spent_or_a_row_moved(self) -> None:
        self.trip_autonomous()
        self._damage()
        ref = self.github.approve("breaker_evidence_quarantine", cb.trip_scope(self.root))
        self.freeze()
        ledger_before = cb._failures_path(self.root).read_bytes()
        self.assert_frozen_refusal(lambda: cb.quarantine_breaker_evidence(
            base_dir=self.root, operator_approval_ref=ref, reason="truncated row"))
        self.assertFalse(cb._quarantine_path(self.root).exists())
        self.assertEqual(cb._failures_path(self.root).read_bytes(), ledger_before)

    def test_an_undecodable_trip_record_binds_to_none_and_the_repair_proceeds(self) -> None:
        """A state file that is not UTF-8 records no trip; it must not crash the one in-band repair."""
        self._damage()
        cb._state_path(self.root).write_bytes(b'{"state":"tripped","tripped_at":"\xff"}')
        self.assertEqual(cb.current_state(self.root), cb.BREAKER_STATE_TRIPPED)
        scope = cb.trip_scope(self.root)
        self.assertEqual(scope, {"breaker": "autonomous", "tripped_at": NO_RECORDED_INSTANCE})
        ref = self.github.approve("breaker_evidence_quarantine", scope)
        result = cb.quarantine_breaker_evidence(base_dir=self.root, operator_approval_ref=ref, reason="truncated row")
        self.assertEqual(result["quarantined"], 1)

    def test_a_malformed_trip_stamp_binds_to_none_and_the_repair_proceeds(self) -> None:
        """A ``tripped_at`` that decodes but is not one UTC stamp records no trip either.

        ``canonical_scope`` refuses a field that is not one token, so a scope bound
        to such a stamp made the printed line and every verify raise: the stop could
        not be cleared through its verb, and the executor's recovery step died at the
        print under ``set -e``.
        """
        self._damage()
        cb._state_path(self.root).write_text(
            json.dumps({"state": "tripped", "tripped_at": "2026-10-20 10:00:00Z"}), encoding="utf-8",
        )
        self.assertEqual(cb.current_state(self.root), cb.BREAKER_STATE_TRIPPED)
        scope = cb.trip_scope(self.root)
        self.assertEqual(scope, {"breaker": "autonomous", "tripped_at": NO_RECORDED_INSTANCE})
        out = io.StringIO()
        with redirect_stdout(out):
            code = cli.main(["breaker", "quarantine", "--print-approval-line", "--tools-dir", str(self.root)])
        self.assertEqual((code, out.getvalue().strip()), (0, approval_line("breaker_evidence_quarantine", scope)))
        ref = self.github.approve("breaker_evidence_quarantine", scope)
        result = cb.quarantine_breaker_evidence(base_dir=self.root, operator_approval_ref=ref, reason="truncated row")
        self.assertEqual(result["quarantined"], 1)

    def test_a_no_op_needs_no_act(self) -> None:
        result = cb.quarantine_breaker_evidence(base_dir=self.root, operator_approval_ref="", reason="nothing to do")
        self.assertEqual(result["status"], "no_op")
        self.assertEqual(self.github.reads, [])


class CostBreakerReset(_Store):
    def test_a_breaker_that_is_not_tripped_is_a_no_op_without_a_row(self) -> None:
        self.assertEqual(
            cost_budget.reset_breaker(base_dir=self.root, reason="nothing tripped", operator_approval_ref=""),
            {"status": "ok", "already_ok": True},
        )
        self.assertEqual(self.governance(cost_budget.COST_BREAKER_RESET_EVENT), [])
        self.assertEqual(self.github.reads, [])

    def test_a_reference_aria_can_author_does_not_clear_the_cost_stop(self) -> None:
        self.trip_cost()
        for ref in self.authored_refs():
            with self.subTest(ref=ref), self.assertRaisesRegex(GovernanceError, "breaker_reset_approval_unrecorded"):
                cost_budget.reset_breaker(base_dir=self.root, reason="caps adjusted", operator_approval_ref=ref)
        self.assertEqual(cost_budget.current_state(self.root), "tripped")

    def test_the_act_for_this_trip_clears_it_once(self) -> None:
        self.trip_cost()
        scope = cost_budget.trip_scope(self.root)
        self.assertEqual(scope, {"breaker": "cost", "tripped_at": _TRIP_STAMP})
        ref = self.github.approve("breaker_reset", scope)
        cost_budget.reset_breaker(base_dir=self.root, reason="caps adjusted", operator_approval_ref=ref)
        self.assertEqual(cost_budget.current_state(self.root), "ok")
        (row,) = self.governance(cost_budget.COST_BREAKER_RESET_EVENT)
        self.assertEqual(row["details"]["operator_approval"]["scope"], {"breaker": "cost", "tripped_at": _TRIP_CANONICAL})
        self.trip_cost()
        with self.assertRaisesRegex(GovernanceError, "already consumed"):
            cost_budget.reset_breaker(base_dir=self.root, reason="again", operator_approval_ref=ref)

    def test_an_act_for_the_failure_breaker_or_an_earlier_trip_is_refused(self) -> None:
        self.trip_cost()
        for scope in ({"breaker": "autonomous", "tripped_at": _TRIP_STAMP},
                      {"breaker": "cost", "tripped_at": _EARLIER_TRIP}):
            with self.subTest(scope=scope), self.assertRaisesRegex(GovernanceError, "breaker_reset_approval_unrecorded"):
                cost_budget.reset_breaker(base_dir=self.root, reason="caps adjusted",
                                          operator_approval_ref=self.github.approve("breaker_reset", scope))
        self.assertEqual(cost_budget.current_state(self.root), "tripped")

    def test_an_unspent_act_for_an_earlier_trip_does_not_clear_the_next(self) -> None:
        self.trip_cost()
        scope = cost_budget.trip_scope(self.root)
        stale = self.github.approve("breaker_reset", scope)
        cost_budget.reset_breaker(base_dir=self.root, reason="caps adjusted",
                                  operator_approval_ref=self.github.approve("breaker_reset", scope))
        self.trip_cost(at=_LATER_STAMP)
        with self.assertRaisesRegex(GovernanceError, "breaker_reset_approval_unrecorded"):
            cost_budget.reset_breaker(base_dir=self.root, reason="caps adjusted", operator_approval_ref=stale)
        self.assertEqual(cost_budget.current_state(self.root), "tripped")
        self.assertEqual(len(self.governance(APPROVAL_CONSUMED_EVENT)), 1)

    def test_a_frozen_kernel_refuses_before_the_act_is_spent_or_the_stop_cleared(self) -> None:
        self.trip_cost()
        ref = self.github.approve("breaker_reset", cost_budget.trip_scope(self.root))
        self.freeze()
        self.assert_frozen_refusal(lambda: cost_budget.reset_breaker(
            base_dir=self.root, reason="caps adjusted", operator_approval_ref=ref))
        self.assertEqual(cost_budget.current_state(self.root), "tripped")


class McpUnquarantine(_Store):
    def test_a_reference_aria_can_author_releases_nothing(self) -> None:
        self.quarantine_mcp()
        for ref in self.authored_refs():
            with self.subTest(ref=ref), self.assertRaisesRegex(GovernanceError, "mcp_unquarantine_approval_unrecorded"):
                mc.release_quarantine("aria", base_dir=self.root, operator_ref=ref)
        self.assertIn("aria", mc.quarantined_servers(self.root))

    def test_the_act_for_this_quarantine_releases_once(self) -> None:
        self.quarantine_mcp()
        scope = mc.unquarantine_scope("aria", base_dir=self.root)
        self.assertEqual(scope, {"server": "aria", "quarantined_at": _MCP_AT})
        ref = self.github.approve("mcp_unquarantine", scope)
        row = mc.release_quarantine("aria", base_dir=self.root, operator_ref=ref)
        self.assertEqual(row["operator_approval"]["ref"], ref)
        self.assertNotIn("aria", mc.quarantined_servers(self.root))
        (event,) = self.governance(mc.MCP_RELEASED_EVENT)
        self.assertEqual(event["details"]["operator_approval"]["scope"]["quarantined_at"], "2026-10-16T08:00:00Z")
        self.quarantine_mcp()
        with self.assertRaisesRegex(GovernanceError, "already consumed"):
            mc.release_quarantine("aria", base_dir=self.root, operator_ref=ref)

    def test_an_act_for_another_server_or_an_earlier_quarantine_is_refused(self) -> None:
        self.quarantine_mcp()
        for scope in ({"server": "other", "quarantined_at": "2026-10-16T08:00:00Z"},
                      {"server": "aria", "quarantined_at": "2026-10-15T08:00:00Z"}):
            with self.subTest(scope=scope), self.assertRaisesRegex(GovernanceError, "mcp_unquarantine_approval_unrecorded"):
                mc.release_quarantine("aria", base_dir=self.root,
                                      operator_ref=self.github.approve("mcp_unquarantine", scope))
        self.assertIn("aria", mc.quarantined_servers(self.root))

    def test_an_unspent_act_for_an_earlier_quarantine_does_not_release_the_next(self) -> None:
        self.quarantine_mcp()
        scope = mc.unquarantine_scope("aria", base_dir=self.root)
        stale = self.github.approve("mcp_unquarantine", scope)
        mc.release_quarantine("aria", base_dir=self.root, operator_ref=self.github.approve("mcp_unquarantine", scope))
        self.quarantine_mcp(at="2026-10-16T09:00:00+00:00")
        with self.assertRaisesRegex(GovernanceError, "mcp_unquarantine_approval_unrecorded"):
            mc.release_quarantine("aria", base_dir=self.root, operator_ref=stale)
        self.assertIn("aria", mc.quarantined_servers(self.root))
        self.assertEqual(len(self.governance(APPROVAL_CONSUMED_EVENT)), 1)

    def test_a_frozen_kernel_refuses_before_the_act_is_spent_or_the_server_released(self) -> None:
        self.quarantine_mcp()
        ref = self.github.approve("mcp_unquarantine", mc.unquarantine_scope("aria", base_dir=self.root))
        self.freeze()
        self.assert_frozen_refusal(lambda: mc.release_quarantine("aria", base_dir=self.root, operator_ref=ref))
        self.assertIn("aria", mc.quarantined_servers(self.root))

    def test_a_server_that_is_not_quarantined_is_refused_before_github_is_asked(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "not quarantined"):
            mc.release_quarantine("aria", base_dir=self.root, operator_ref="gh:Okan-wqm/aquaculture_platform#1/comment/9")
        self.assertEqual(self.github.reads, [])


class ControlResume(_Store):
    """ARIA-HIGH-238 — lifting an operator's pause, beyond the caller pin's cases."""

    def test_a_frozen_kernel_refuses_before_the_act_is_spent_or_the_pause_lifted(self) -> None:
        control.record_control("pause", base_dir=self.root, reason="deploy window")
        ref = self.github.approve("control_resume", control.resume_scope(base_dir=self.root))
        self.freeze()
        self.assert_frozen_refusal(lambda: control.record_control("resume", base_dir=self.root, operator_ref=ref))
        self.assertTrue(control.effective_control(self.root).paused_all)

    def test_nothing_paused_is_refused_before_github_is_asked(self) -> None:
        ref = f"gh:{REPOSITORY}#1/comment/9"
        with self.assertRaisesRegex(GovernanceError, "control_resume_not_paused"):
            control.record_control("resume", base_dir=self.root, operator_ref=ref)
        control.record_control("pause", base_dir=self.root, request_id="AIR-7")
        with self.assertRaisesRegex(GovernanceError, "control_resume_not_paused"):
            control.record_control("resume", base_dir=self.root, request_id="AIR-8", operator_ref=ref)
        self.assertEqual(self.github.reads, [])

    def test_a_pause_recorded_while_the_act_is_verified_stays_in_force(self) -> None:
        """The resume row names the pause it was approved for; the fold lifts
        nothing when a newer pause stands by the time the row lands."""
        first = control.record_control("pause", base_dir=self.root, reason="deploy window")
        ref = self.github.approve("control_resume", control.resume_scope(base_dir=self.root))
        verify = control.require_operator_act

        def verify_while_paused_again(*args, **kwargs):
            proof = verify(*args, **kwargs)
            control.record_control("pause", base_dir=self.root, reason="incident while the act was read")
            return proof

        with mock.patch("aria_kernel.control.require_operator_act", side_effect=verify_while_paused_again):
            row = control.record_control("resume", base_dir=self.root, operator_ref=ref)
        self.assertEqual(row["pause_id"], first["command_id"])
        self.assertTrue(control.effective_control(self.root).paused_all)
        self.assertNotEqual(control.resume_scope(base_dir=self.root)["pause_id"], first["command_id"])


class OperatorCommandLine(_Store):
    def run_cli(self, *argv: str) -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = cli.main(list(argv))
        return code, out.getvalue(), err.getvalue()

    def test_check_ref_is_the_one_grammar_check_a_workflow_runs(self) -> None:
        good = [f"gh:{REPOSITORY}#1/comment/11", f"gh:{REPOSITORY}#2/review/12"]
        self.assertEqual(self.run_cli("operator", "check-ref", "--ref", good[0])[:2], (0, good[0] + "\n"))
        code, out, _ = self.run_cli("operator", "check-ref", "--list", "--ref", ",".join(good))
        self.assertEqual((code, out.split()), (0, good))
        for argv in (
            # One ref is the default: an input that names one act refuses a list.
            ("--ref", ",".join(good)),
            *(("--list", "--ref", bad) for bad in
              ("OPS-4711", f"{good[0]},", f"{good[0]},gov:GE-x", f"gh:{REPOSITORY}#1/issue/3")),
        ):
            with self.subTest(argv=argv):
                code, out, err = self.run_cli("operator", "check-ref", *argv)
                self.assertEqual((code, out), (2, ""))
                self.assertIn(GITHUB_REF_GRAMMAR, err)

    def test_check_ref_checks_the_bytes_the_workflow_uses(self) -> None:
        """A ref that parses only once stripped is refused: the shell uses the raw value.

        ``IFS=, read -ra`` reads one line, so ``a,\\nb`` passed the check as two
        refs while the workflow split it into one.
        """
        good = [f"gh:{REPOSITORY}#1/comment/11", f"gh:{REPOSITORY}#2/review/12"]
        for argv in (
            ("--ref", f" {good[0]}"),
            ("--ref", f"{good[0]}\n"),
            ("--list", "--ref", f"{good[0]},\n{good[1]}"),
            ("--list", "--ref", f"{good[0]}, {good[1]}"),
            ("--list", "--ref", f"{good[0]},{good[1]}\t"),
        ):
            with self.subTest(argv=argv):
                code, out, err = self.run_cli("operator", "check-ref", *argv)
                self.assertEqual((code, out), (2, ""))
                self.assertIn("canonical", err)

    def test_each_raising_verb_prints_the_line_for_the_instance_it_would_undo(self) -> None:
        self.trip_autonomous()
        self.trip_cost()
        self.quarantine_mcp()
        control.record_control("pause", base_dir=self.root, reason="deploy window")
        control.record_control("pause", base_dir=self.root, request_id="AIR-7", reason="wrong plan")
        tools = ["--tools-dir", str(self.root)]
        for argv, line in (
            (["breaker", "reset", "--print-approval-line"], approval_line("breaker_reset", cb.trip_scope(self.root))),
            (["breaker", "quarantine", "--print-approval-line"],
             approval_line("breaker_evidence_quarantine", cb.trip_scope(self.root))),
            (["cost-breaker", "reset", "--print-approval-line"],
             approval_line("breaker_reset", cost_budget.trip_scope(self.root))),
            (["mcp", "release", "--server", "aria", "--print-approval-line"],
             approval_line("mcp_unquarantine", mc.unquarantine_scope("aria", base_dir=self.root))),
            (["control", "resume", "--print-approval-line"],
             approval_line("control_resume", control.resume_scope(base_dir=self.root))),
            (["control", "resume", "--request-id", "AIR-7", "--print-approval-line"],
             approval_line("control_resume", control.resume_scope("AIR-7", base_dir=self.root))),
        ):
            with self.subTest(argv=argv):
                code, out, _ = self.run_cli(*argv, *tools)
                self.assertEqual((code, out.strip()), (0, line))
        # Printing the line changes nothing and spends nothing.
        self.assertEqual(cb.current_state(self.root), cb.BREAKER_STATE_TRIPPED)
        self.assertEqual(cost_budget.current_state(self.root), "tripped")
        self.assertIn("aria", mc.quarantined_servers(self.root))
        self.assertTrue(control.effective_control(self.root).paused_all)
        self.assertEqual(self.github.reads, [])

    def test_the_verbs_act_on_a_verified_act(self) -> None:
        self.trip_autonomous()
        ref = self.github.approve("breaker_reset", cb.trip_scope(self.root))
        code, _, _ = self.run_cli("breaker", "reset", "--acknowledge", "--reason", "investigated and fixed",
                                  "--operator-approval-ref", ref, "--tools-dir", str(self.root))
        self.assertEqual(code, 0)
        self.assertEqual(cb.current_state(self.root), cb.BREAKER_STATE_OK)
        self.quarantine_mcp()
        ref = self.github.approve("mcp_unquarantine", mc.unquarantine_scope("aria", base_dir=self.root))
        code, _, _ = self.run_cli("mcp", "release", "--server", "aria", "--operator-ref", ref, "--tools-dir", str(self.root))
        self.assertEqual(code, 0)
        self.assertNotIn("aria", mc.quarantined_servers(self.root))
        control.record_control("pause", base_dir=self.root, reason="deploy window")
        ref = self.github.approve("control_resume", control.resume_scope(base_dir=self.root))
        code, _, _ = self.run_cli("control", "resume", "--operator-ref", ref, "--tools-dir", str(self.root))
        self.assertEqual(code, 0)
        self.assertFalse(control.effective_control(self.root).is_paused())

    def test_acting_needs_a_reference_and_a_reason(self) -> None:
        """Guard: --print-approval-line made the reference optional for printing only."""
        self.trip_autonomous()
        with redirect_stderr(io.StringIO()) as err, self.assertRaises(SystemExit) as caught:
            cli.main(["breaker", "reset", "--acknowledge", "--reason", "investigated and fixed",
                      "--tools-dir", str(self.root)])
        self.assertEqual(caught.exception.code, 2)
        self.assertIn("--operator-approval-ref", err.getvalue())
        ref = self.github.approve("breaker_reset", cb.trip_scope(self.root))
        code, _, err_text = self.run_cli("breaker", "reset", "--acknowledge", "--operator-approval-ref", ref,
                                         "--tools-dir", str(self.root))
        self.assertEqual(code, 2)
        self.assertIn("--reason", err_text)
        self.assertEqual(cb.current_state(self.root), cb.BREAKER_STATE_TRIPPED)
        self.assertEqual(self.github.reads, [])


if __name__ == "__main__":
    unittest.main()
