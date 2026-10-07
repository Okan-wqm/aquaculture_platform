"""ARIA-HIGH-369 — the F finding → plan path: who gets the one slot, and what an F plan is seeded from.

Measured 2026-10-06/07 on the aria/state store: 20 plans, 0 converged; 21 of
32 candidate selections and every one of the last 12 automated ones went to
failing CI (one of them ARIA's own aria-auto-cycle workflow, parked for a
human by construction); the F plans that did start were template plans; and
F-007's cited ``LeavesPage.tsx:355`` no longer holds the filter, which moved to
:389. These pins drive ``plan_slot_policy.order_for_slot`` directly and the
production provider (``V9PressureSourceProvider``) over the shared
operator-request fixture: mixed failing-CI, self-lane and F candidates; a
moved line re-anchored; a subject that is gone; and the operator request that
always takes the slot.
"""
from __future__ import annotations

import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from unittest import mock

from aria_kernel import finding_grounding as fg
from aria_kernel.cycle_phases.plan_source import V9PressureSourceProvider
from aria_kernel.finding import fold_findings
from aria_kernel.finding_seed import SUBJECT_ABSENT, SUBJECT_UNVERIFIABLE
from aria_kernel.ledger import load_declared_jsonl
from aria_kernel.plan_slot_policy import (
    FAILING_CI_COOL_OFF_REASON,
    FAILING_CI_SELF_LANE,
    order_for_slot,
)
from tests._helpers.operator_requests import GROUNDED_FILE, OperatorRequestFixture

_NOW = datetime(2026, 10, 7, 12, 0, tzinfo=timezone.utc)
_PAGE = "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx"
_ENTITY = "apps/hr-service/src/leave/entities/leave-request.entity.ts"
_CI = ".github/workflows/ci.yml"
_SELF_CI = ".github/workflows/aria-auto-cycle.yml"


def _ci(run: int, path: str) -> dict[str, Any]:
    return {"source_type": "failing_ci", "candidate_id": f"ci-run-{run}", "workflow_name": Path(path).stem,
            "workflow_path": path, "head_sha": "a" * 40, "created_at": "2026-10-06T00:00:00Z",
            "title_hint": f"Fix failing CI workflow '{Path(path).stem}' (run #{run})", "failing_jobs": []}


def _f(finding_id: str) -> dict[str, Any]:
    return {"source_type": "f_finding", "candidate_id": finding_id,
            "title_hint": f"Process aging F-finding {finding_id}"}


def _drift(finding_id: str, line: int, *, severity: str = "HIGH", created: str = "2026-09-19T00:00:00Z",
           status: str = "OPEN") -> dict[str, Any]:
    """A seeder-shaped drift record: the subject is (page, leave-filter-status) x (entity, LeaveRequestStatus)."""
    return {
        "finding_id": finding_id, "status": status, "severity": severity, "created_at": created,
        "originating_skill": "seed:drift-scan", "claim_type": "spine_drift",
        "claim_summary": "ui_option_drift: 'leaverequest' ui_value_not_on_wire across 2 surfaces (cross_service=True)",
        "evidences": [
            {"ref": f"{_PAGE}:{line}", "summary": "leave-filter-status values: ['approved', 'pending']",
             "evidence_envelope": {"canonical_ref": f"{_PAGE}:{line}", "trust_grade": "repo_verified"}},
            {"ref": f"{_ENTITY}:18", "summary": "LeaveRequestStatus values: ['APPROVED', 'PENDING']",
             "evidence_envelope": {"canonical_ref": f"{_ENTITY}:18", "trust_grade": "repo_verified"}},
        ],
    }


def _plan(plan_id: str, *, started_days: float, f_sourced: bool = False, operator: bool = False,
          surfaces: tuple[str, ...] = (), failed_days: float | None = None) -> fg.PlanRecord:
    return fg.PlanRecord(
        plan_id=plan_id, finding_id="F-099" if (f_sourced or operator) else None, operator_sourced=operator,
        started_at=_NOW - timedelta(days=started_days), surfaces=frozenset(surfaces),
        failed_at=None if failed_days is None else _NOW - timedelta(days=failed_days),
    )


def _history(*plans: fg.PlanRecord) -> fg.LoopHistory:
    return fg.LoopHistory(_NOW, tuple(plans), {}, (), 1, timedelta(days=7))


class SlotOrderTests(unittest.TestCase):
    """``order_for_slot`` over mixed failing-CI, self-lane and F candidates."""

    def ids(self, order) -> list[str]:
        return [candidate["candidate_id"] for candidate in order.ordered]

    def test_aria_s_own_red_workflow_never_reaches_the_slot(self) -> None:
        order = order_for_slot([_ci(1, _SELF_CI), _ci(2, _CI)], findings={}, history=_history())
        self.assertEqual(self.ids(order), ["ci-run-2"])
        self.assertEqual([(d["candidate_id"], d["reason"]) for d in order.dropped],
                         [("ci-run-1", FAILING_CI_SELF_LANE)])

    def test_a_workflow_whose_plan_failed_cools_off_then_returns(self) -> None:
        recent = _history(_plan("plan-ci", started_days=3, surfaces=(_CI,), failed_days=1))
        order = order_for_slot([_ci(2, _CI)], findings={}, history=recent)
        self.assertEqual(self.ids(order), [])
        self.assertEqual(order.dropped[0]["reason"], FAILING_CI_COOL_OFF_REASON)
        self.assertEqual(order.dropped[0]["plan_id"], "plan-ci")
        old = _history(_plan("plan-ci", started_days=6, surfaces=(_CI,), failed_days=4))
        self.assertEqual(self.ids(order_for_slot([_ci(2, _CI)], findings={}, history=old)), ["ci-run-2"])

    def test_f_candidates_group_by_subject_and_order_by_severity_then_age(self) -> None:
        findings = {
            "F-003": _drift("F-003", 346, created="2026-09-18T00:00:00Z"),
            "F-007": _drift("F-007", 355, created="2026-09-19T00:00:00Z"),
            "F-015": _drift("F-015", 389, created="2026-10-04T00:00:00Z"),
            "F-012": {"finding_id": "F-012", "status": "OPEN", "severity": "MEDIUM",
                      "created_at": "2026-09-01T00:00:00Z"},
            "F-010": {"finding_id": "F-010", "status": "OPEN", "severity": "HIGH",
                      "created_at": "2026-09-20T00:00:00Z"},
            "F-011": {"finding_id": "F-011", "status": "RESOLVED", "severity": "HIGH"},
        }
        # Youngest first, as the aging scan hands them over.
        candidates = [_f(fid) for fid in ("F-015", "F-012", "F-011", "F-010", "F-007", "F-003", "F-101")]
        order = order_for_slot(candidates, findings=findings, history=_history())
        # Review M3 — a subject's members are all offered, best first, one group after another,
        # so the representative is whichever member admission accepts.
        self.assertEqual(self.ids(order), ["F-003", "F-007", "F-015", "F-010", "F-012"])
        self.assertEqual(sorted((d["candidate_id"], d["reason"]) for d in order.dropped),
                         [("F-011", fg.FINDING_NOT_OPEN), ("F-101", fg.FINDING_UNKNOWN)])
        self.assertEqual(list(order.subjects.values()), [("F-003", "F-007", "F-015")])

    def test_one_slot_alternates_between_f_and_the_other_automated_sources(self) -> None:
        findings = {"F-010": {"finding_id": "F-010", "status": "OPEN", "severity": "HIGH"}}
        candidates = [_ci(2, _CI), _f("F-010")]
        after_ci = _history(_plan("plan-ci", started_days=2, surfaces=(_CI,)))
        after_f = _history(_plan("plan-ci", started_days=4, surfaces=(_CI,)),
                           _plan("plan-f", started_days=2, f_sourced=True))
        self.assertEqual(self.ids(order_for_slot(candidates, findings=findings, history=after_ci)),
                         ["F-010", "ci-run-2"])
        self.assertEqual(self.ids(order_for_slot(candidates, findings=findings, history=after_f)),
                         ["ci-run-2", "F-010"])
        # An operator plan is not an automated turn: the newest AUTOMATED plan decides.
        after_f_then_operator = _history(_plan("plan-f", started_days=2, f_sourced=True),
                                         _plan("plan-op", started_days=1, operator=True))
        self.assertEqual(self.ids(order_for_slot(candidates, findings=findings, history=after_f_then_operator)),
                         ["ci-run-2", "F-010"])

    def test_the_operator_request_is_offered_first_on_every_turn(self) -> None:
        operator = {"source_type": "operator_feedback", "candidate_id": "OP-F015", "finding_id": "F-015"}
        findings = {"F-010": {"finding_id": "F-010", "status": "OPEN", "severity": "HIGH"}}
        for history in (_history(), _history(_plan("plan-f", started_days=1, f_sourced=True))):
            order = order_for_slot([_ci(2, _CI), _f("F-010"), operator], findings=findings, history=history)
            self.assertEqual(self.ids(order)[0], "OP-F015")


class _ProviderFixture(unittest.TestCase):
    """The production provider over a checkout whose page and entity hold the F-007 subject."""

    def setUp(self) -> None:
        env = {k: v for k, v in os.environ.items() if k != "ARIA_REPO_STATE_ROOT"}
        patcher = mock.patch.dict(os.environ, env, clear=True)
        patcher.start()
        self.addCleanup(patcher.stop)
        tmp = tempfile.TemporaryDirectory(prefix="aria-369-")
        self.addCleanup(tmp.cleanup)
        self.fx = OperatorRequestFixture(Path(tmp.name))
        self.fx.commit_files({
            _PAGE: "".join(f"<option value='status-{n}' />\n" for n in range(1, 401)),
            _ENTITY: "".join(f"  STATUS_{n} = 'status_{n}',\n" for n in range(1, 31)),
            _SELF_CI: "name: aria-auto-cycle\non:\n  push: {}\njobs:\n  cycle:\n    runs-on: self-hosted\n",
        })
        self.failing: list[dict[str, Any]] = []
        self.verdict: Any = None
        # Hermetic: no network source, and no git-diff fallback plan standing in for a refusal.
        for name, value in (("scan_orphan_findings", []), ("scan_github_issue_missions", []),
                            ("synthesize_plan_content_from_cycle", None)):
            stub = mock.patch(f"aria_kernel.plan_synthesizer.{name}", return_value=value)
            stub.start()
            self.addCleanup(stub.stop)
        ci = mock.patch("aria_kernel.plan_synthesizer.scan_failing_ci",
                        side_effect=lambda *_a, **_k: list(self.failing))
        ci.start()
        self.addCleanup(ci.stop)
        detectors = mock.patch("aria_kernel.finding_closure.default_detectors",
                               return_value={"seed:drift-scan": self})
        detectors.start()
        self.addCleanup(detectors.stop)
        self.rechecks: list[str] = []

    # The drift subject's own detector, as finding_closure registers it.
    def recheck(self, record: dict[str, Any], *, merge_sha: str, workspace_root: Path) -> dict[str, Any]:
        self.rechecks.append(merge_sha)
        assert self.verdict is not None, "a drift finding was rechecked without a verdict"
        if isinstance(self.verdict, BaseException):
            raise self.verdict
        return self.verdict

    def seed_drift(self, finding_id: str, line: int) -> None:
        record = _drift(finding_id, line)
        self.fx.seed_finding(finding_id, refs=[], body={k: v for k, v in record.items() if k != "finding_id"})

    def synthesize(self, cycle_id: str):
        return V9PressureSourceProvider().synthesize(
            cycle_id=cycle_id, workspace_root=self.fx.repo, base_dir=self.fx.tools, profile="standard")

    def governance(self, kind: str) -> list[dict[str, Any]]:
        return [row["details"] for row in load_declared_jsonl(self.fx.tools / "governance.jsonl",
                                                              expected_surface="tools_governance")
                if row["kind"] == kind]


class ProviderSlotTests(_ProviderFixture):
    def test_mixed_candidates_give_the_starved_f_lane_the_slot(self) -> None:
        # Pre-fix: failing CI ranked first and converted, so the F finding never got the slot.
        self.failing = [_ci(1, _SELF_CI), _ci(2, _CI)]
        self.fx.seed_finding("F-010", refs=[f"{GROUNDED_FILE}:12"])
        envelope = self.synthesize("cyc-mixed")
        self.assertEqual(envelope.metadata["_pressure_source_type"], "f_finding")
        self.assertEqual(envelope.content["finding_id"], "F-010")
        applied = self.governance("plan_slot_policy_applied")[-1]
        self.assertTrue(applied["f_first"])
        self.assertEqual(applied["offered"], ["F-010", "ci-run-2"])
        self.assertEqual([(d["candidate_id"], d["reason"]) for d in applied["dropped"]],
                         [("ci-run-1", FAILING_CI_SELF_LANE)])

    def test_the_operator_request_keeps_the_slot_on_the_f_lane_s_turn(self) -> None:
        self.failing = [_ci(2, _CI)]
        self.fx.seed_finding("F-010", refs=[f"{GROUNDED_FILE}:12"])
        self.fx.seed_finding("F-015", refs=[f"{GROUNDED_FILE}:20"])
        self.fx.record(finding_id="F-015", request_id="OP-F015-live")
        envelope = self.synthesize("cyc-op")
        self.assertEqual(envelope.metadata["_pressure_source_type"], "operator_feedback")
        self.assertEqual(envelope.content["finding_id"], "F-015")
        applied = self.governance("plan_slot_policy_applied")[-1]
        self.assertTrue(applied["f_first"])
        self.assertEqual(applied["offered"][0], "OP-F015-live")


class SeedTests(_ProviderFixture):
    def test_a_moved_cited_line_re_anchors_to_where_it_is_now(self) -> None:
        self.fx.seed_finding("F-010", refs=[f"{GROUNDED_FILE}:12"])
        # Five lines land above the cited one after the finding was minted.
        text = (self.fx.repo / GROUNDED_FILE).read_text(encoding="utf-8")
        self.fx.commit_files({GROUNDED_FILE: "// header\n" * 5 + text})
        envelope = self.synthesize("cyc-moved")
        self.assertEqual(envelope.content["evidence_refs"], [f"{GROUNDED_FILE}:17"])
        self.assertIn(f"{GROUNDED_FILE}:12 moved to {GROUNDED_FILE}:17", envelope.content["summary"])
        self.assertNotIn("Process aging", envelope.content["title"])
        selected = self.governance("plan_candidate_source_selected")[-1]
        self.assertEqual(selected["seed"]["state"], "reanchored")
        self.assertEqual(selected["seed"]["moved"], [{"recorded": f"{GROUNDED_FILE}:12",
                                                      "current": f"{GROUNDED_FILE}:17"}])

    def test_a_drift_subject_that_still_reproduces_is_planned_from_the_detector_s_refs(self) -> None:
        self.seed_drift("F-007", 355)
        self.verdict = {"verdict": "reproduces", "reason": "subject_in_scan", "wire": "ok",
                        "matches": [f"{_PAGE}:389", f"{_ENTITY}:18"]}
        envelope = self.synthesize("cyc-drift")
        content = envelope.content
        self.assertEqual(content["evidence_refs"], [f"{_PAGE}:389", f"{_ENTITY}:18"])
        self.assertEqual(content["affected_surfaces"], [_PAGE, _ENTITY])
        self.assertIn("`leave-filter-status`", content["summary"])
        self.assertIn("`LeaveRequestStatus`", content["summary"])
        self.assertIn(f"{_PAGE}:355 moved to {_PAGE}:389", content["summary"])
        self.assertEqual([change["paths"] for change in content["key_changes"]], [[_PAGE], [_ENTITY]])
        self.assertEqual(len(self.rechecks), 1)

    def test_a_subject_that_no_longer_reproduces_is_not_planned_and_stays_open(self) -> None:
        self.seed_drift("F-007", 355)
        self.verdict = {"verdict": "absent", "reason": "subject_not_in_scan", "matches": [], "wire": "ok"}
        self.assertIsNone(self.synthesize("cyc-gone"))
        skipped = [d for d in self.governance("plan_candidate_conversion_skipped") if d["candidate_id"] == "F-007"]
        self.assertEqual(skipped[-1]["reason"], SUBJECT_ABSENT)
        self.assertEqual(skipped[-1]["seed"]["reason"], SUBJECT_ABSENT)
        # Never closed here: closing a finding is ARIA-HIGH-363's merge path.
        self.assertEqual(fold_findings(self.fx.repo)["F-007"]["status"], "OPEN")

    def test_a_cited_line_that_is_gone_makes_the_finding_unverifiable(self) -> None:
        self.fx.seed_finding("F-010", refs=[f"{GROUNDED_FILE}:12"])
        text = (self.fx.repo / GROUNDED_FILE).read_text(encoding="utf-8")
        self.fx.commit_files({GROUNDED_FILE: text.replace("export const leave12 = 12;\n", "")})
        self.assertIsNone(self.synthesize("cyc-line-gone"))
        skipped = self.governance("plan_candidate_conversion_skipped")[-1]
        self.assertEqual((skipped["candidate_id"], skipped["reason"]), ("F-010", SUBJECT_UNVERIFIABLE))
        self.assertEqual(skipped["seed"]["cause"], "cited_line_gone")

    def test_an_operator_request_on_a_moved_line_is_planned_at_the_new_line_and_not_spent(self) -> None:
        # The F-007 case PR #1759's stale-ref refusal would have spent.
        self.fx.seed_finding("F-007", refs=[f"{GROUNDED_FILE}:12"])
        self.fx.record(finding_id="F-007", request_id="OP-F007-live")
        text = (self.fx.repo / GROUNDED_FILE).read_text(encoding="utf-8")
        self.fx.commit_files({GROUNDED_FILE: "// header\n" * 5 + text})
        envelope = self.synthesize("cyc-op-moved")
        self.assertEqual(envelope.metadata["_pressure_source_type"], "operator_feedback")
        self.assertEqual(envelope.content["evidence_refs"], [f"{GROUNDED_FILE}:17"])


if __name__ == "__main__":
    unittest.main()
