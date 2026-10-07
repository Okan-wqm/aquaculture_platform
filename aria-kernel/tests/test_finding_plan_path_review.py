"""ARIA-HIGH-369 review corrections (PR #1826): H1, M1, M2, M3, M4.

* H1 — a cited line is mapped through the diff, never matched by text: a
  deleted statement whose trivial text (``});``) appears once elsewhere is
  gone, not "moved".
* M1 — an operator plan never widens past the refs the operator signed, and a
  seed whose moved refs are refused falls back to the signed ones instead of
  getting the request spent.
* M2 — a detector that raises or answers a non-object is ``unverifiable`` for
  its finding; the synthesis (and the operator request in it) goes on.
* M3 — duplicates of a subject are all offered and the loop guards judge the
  subject: a sibling neither re-plans a cooled subject nor starves behind a
  representative refused for a reason of its own.
* M4 — while a plan is in flight the detector is not run at all.
"""
from __future__ import annotations

import shutil
import subprocess
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from unittest import mock

from aria_kernel import finding_grounding as fg
from aria_kernel.finding import fold_findings
from aria_kernel.finding_closure import DriftSubjectDetector
from aria_kernel.finding_grounding import FindingAdmission
from aria_kernel.finding_seed import SUBJECT_UNVERIFIABLE, FindingSeed
from aria_kernel.ledger import load_declared_jsonl
from aria_kernel.operator_feedback_ingestion import INGESTION_SURFACE, ingestion_ledger_path
from aria_kernel.operator_request_spend import REQUEST_REFUSED_ROW_TYPE
from aria_kernel.plan_synthesizer import PlanEvidenceGround, convert_candidate_to_plan_content
from tests._helpers.declared_fixtures import append_declared_fixture
from tests._helpers.operator_requests import GROUNDED_FILE
from tests.test_finding_plan_path import _ENTITY, _PAGE, _ProviderFixture, _drift

_TRIVIAL_FILE = "apps/hr-service/src/leave/leave.filters.ts"
_REPO_ROOT = Path(__file__).resolve().parents[2]


class LineMapTests(_ProviderFixture):
    def test_a_deleted_trivial_line_is_gone_even_when_its_text_appears_once_elsewhere(self) -> None:
        self.fx.commit_files({_TRIVIAL_FILE: "const a = () => {\n  run();\n});\nexport const b = 1;\n"})
        self.fx.seed_finding("F-010", refs=[f"{_TRIVIAL_FILE}:3"])
        # The cited `});` is deleted with its statement; a new, unrelated `});` lands at the end.
        self.fx.commit_files({_TRIVIAL_FILE: "export const b = 1;\nwatch(() => {\n  b;\n});\n"})
        self.assertIsNone(self.synthesize("cyc-trivial"))
        skipped = self.governance("plan_candidate_conversion_skipped")[-1]
        self.assertEqual((skipped["candidate_id"], skipped["reason"]), ("F-010", SUBJECT_UNVERIFIABLE))
        self.assertEqual(skipped["seed"]["cause"], "cited_line_gone")

    def test_an_untouched_line_shifts_by_the_hunks_above_it_only(self) -> None:
        self.fx.seed_finding("F-010", refs=[f"{GROUNDED_FILE}:12"])
        text = (self.fx.repo / GROUNDED_FILE).read_text(encoding="utf-8").splitlines(keepends=True)
        # Two lines deleted above, three inserted above, one changed below: 12 - 2 + 3 = 13.
        edited = ["// a\n", "// b\n", "// c\n"] + text[2:30] + ["export const changed = 0;\n"] + text[31:]
        self.fx.commit_files({GROUNDED_FILE: "".join(edited)})
        envelope = self.synthesize("cyc-shift")
        self.assertEqual(envelope.content["evidence_refs"], [f"{GROUNDED_FILE}:13"])


class OperatorSeedTests(_ProviderFixture):
    def _operator(self, seed: FindingSeed) -> Any:
        admission = FindingAdmission("F-007", None, evidence_refs=(f"{GROUNDED_FILE}:12",),
                                     affected_surfaces=(GROUNDED_FILE,))
        candidate = {"source_type": "operator_feedback", "candidate_id": "OP-1", "finding_id": "F-007",
                     "priority": "high", "request": "Fix the leave filter"}
        return convert_candidate_to_plan_content(candidate, admission=admission, seed=seed,
                                                 ground=PlanEvidenceGround.of(self.fx.repo))

    def test_a_seed_never_widens_the_signed_grounding(self) -> None:
        seed = FindingSeed("F-007", None, evidence_refs=(f"{GROUNDED_FILE}:17", f"{_ENTITY}:18"),
                           affected_surfaces=(GROUNDED_FILE, _ENTITY),
                           moved=((f"{GROUNDED_FILE}:12", f"{GROUNDED_FILE}:17"),))
        content = self._operator(seed).envelope.content
        self.assertEqual(content["evidence_refs"], [f"{GROUNDED_FILE}:17"])
        self.assertEqual(content["affected_surfaces"], [GROUNDED_FILE])

    def test_refused_moved_refs_fall_back_to_the_signed_ones(self) -> None:
        seed = FindingSeed("F-007", None, evidence_refs=(f"{GROUNDED_FILE}:99999",),
                           affected_surfaces=(GROUNDED_FILE,),
                           moved=((f"{GROUNDED_FILE}:12", f"{GROUNDED_FILE}:99999"),))
        conversion = self._operator(seed)
        self.assertIsNotNone(conversion.envelope, conversion)
        self.assertEqual(conversion.envelope.content["evidence_refs"], [f"{GROUNDED_FILE}:12"])
        self.assertIn(f"{GROUNDED_FILE}:99999", [entry["ref"] for entry in conversion.refused_evidence_refs])

    def _request_refusals(self) -> list[dict[str, Any]]:
        return [row for row in load_declared_jsonl(ingestion_ledger_path(self.fx.tools),
                                                   expected_surface=INGESTION_SURFACE)
                if row.get("row_type") == REQUEST_REFUSED_ROW_TYPE]

    def test_an_operator_request_is_planned_on_its_signed_refs_when_the_detector_says_absent(self) -> None:
        self.seed_drift("F-007", 355)
        self.fx.record(finding_id="F-007", request_id="OP-absent")
        self.verdict = {"verdict": "absent", "reason": "subject_not_in_scan", "matches": [], "wire": "ok"}
        envelope = self.synthesize("cyc-op-absent")
        self.assertEqual(envelope.metadata["_pressure_source_type"], "operator_feedback")
        self.assertEqual(envelope.content["evidence_refs"], [f"{_PAGE}:355", f"{_ENTITY}:18"])
        self.assertEqual(self._request_refusals(), [])

    def test_an_operator_request_survives_a_detector_that_raises(self) -> None:
        self.seed_drift("F-007", 355)
        self.fx.record(finding_id="F-007", request_id="OP-oserror")
        self.verdict = OSError("no interpreter")
        envelope = self.synthesize("cyc-op-oserror")
        self.assertEqual(envelope.metadata["_pressure_source_type"], "operator_feedback")
        selected = self.governance("plan_candidate_source_selected")[-1]
        self.assertEqual(selected["seed"]["detector_reason"], "detector_error:OSError")
        self.assertEqual(self._request_refusals(), [])


class DetectorFaultTests(_ProviderFixture):
    def test_a_raising_detector_makes_the_f_finding_unverifiable_not_the_cycle_crash(self) -> None:
        self.seed_drift("F-007", 355)
        self.verdict = subprocess.TimeoutExpired("scan", 900)
        self.assertIsNone(self.synthesize("cyc-raise"))
        skipped = self.governance("plan_candidate_conversion_skipped")[-1]
        self.assertEqual((skipped["reason"], skipped["seed"]["detector_reason"]),
                         (SUBJECT_UNVERIFIABLE, "detector_error:TimeoutExpired"))

    def test_a_ui_drift_without_the_wire_is_disclosed_never_planned_never_closed(self) -> None:
        # Outside the cycle step ARIA_SUPERGRAPH is unset: the scan judges no UI pair.
        self.seed_drift("F-007", 355)
        self.verdict = {"verdict": "unverifiable", "reason": "wire_unavailable:no_wire_section",
                        "matches": [], "wire": None}
        self.assertIsNone(self.synthesize("cyc-no-wire"))
        skipped = self.governance("plan_candidate_conversion_skipped")[-1]
        self.assertEqual((skipped["reason"], skipped["seed"]["detector_reason"]),
                         (SUBJECT_UNVERIFIABLE, "wire_unavailable:no_wire_section"))
        self.assertEqual(fold_findings(self.fx.repo)["F-007"]["status"], "OPEN")

    def test_the_drift_detector_answers_unverifiable_for_a_non_object_verdict(self) -> None:
        done = subprocess.CompletedProcess([], 0, stdout="[1]\n", stderr="")
        with mock.patch("aria_kernel.finding_closure.subprocess.run", return_value=done):
            verdict = DriftSubjectDetector().recheck(_drift("F-007", 355), merge_sha="a" * 40,
                                                     workspace_root=_REPO_ROOT)
        self.assertEqual(verdict, {"verdict": "unverifiable", "reason": "detector_output_not_an_object"})

    def test_the_drift_detector_answers_unverifiable_when_it_cannot_run(self) -> None:
        with mock.patch("aria_kernel.finding_closure.subprocess.run", side_effect=FileNotFoundError("python3")):
            verdict = DriftSubjectDetector().recheck(_drift("F-007", 355), merge_sha="a" * 40,
                                                     workspace_root=_REPO_ROOT)
        self.assertEqual(verdict["verdict"], "unverifiable")
        self.assertEqual(verdict["reason"], "detector_unrunnable:FileNotFoundError")


class SubjectLoopGuardTests(_ProviderFixture):
    def _failed_plan(self, plan_id: str, finding_id: str) -> None:
        content = {"schema_version": 2, "title": plan_id, "summary": plan_id, "finding_id": finding_id,
                   "affected_surfaces": [_PAGE], "key_changes": [], "validation_commands": [],
                   "evidence_refs": []}
        for event_type, days, payload in (("plan_started", 3, {"plan_content": content}),
                                          ("plan_abandoned", 2, {"reason": "x", "abandoned_from_state": "OPEN"})):
            append_declared_fixture(self.fx.tools / "plans" / "events.jsonl", {
                "schema_version": 1, "event_id": f"{plan_id}:{event_type}", "event_type": event_type,
                "plan_id": plan_id,
                "recorded_at": (datetime.now(timezone.utc) - timedelta(days=days)).replace(microsecond=0).isoformat(),
                "idempotency_key": f"{plan_id}:{event_type}", "payload": payload,
            }, expected_surface="plan_convergence_events")

    def test_a_sibling_cannot_re_plan_a_subject_another_sibling_s_failed_plan_cooled(self) -> None:
        self.seed_drift("F-003", 346)
        self.seed_drift("F-015", 389)
        self._failed_plan("plan-f015", "F-015")
        self.verdict = {"verdict": "reproduces", "reason": "subject_in_scan", "wire": "ok",
                        "matches": [f"{_PAGE}:389", f"{_ENTITY}:18"]}
        self.assertIsNone(self.synthesize("cyc-cooled"))
        reasons = {d["candidate_id"]: d["reason"] for d in self.governance("plan_candidate_conversion_skipped")}
        self.assertEqual(reasons, {"F-003": fg.SUBJECT_COOL_OFF, "F-015": fg.SUBJECT_COOL_OFF})

    def test_a_subject_is_planned_through_a_sibling_when_its_first_member_is_refused(self) -> None:
        record = _drift("F-003", 346)
        for evidence in record["evidences"]:
            evidence["evidence_envelope"]["trust_grade"] = "llm_claimed"
        self.fx.seed_finding("F-003", refs=[], body={k: v for k, v in record.items() if k != "finding_id"})
        self.seed_drift("F-007", 355)
        self.verdict = {"verdict": "reproduces", "reason": "subject_in_scan", "wire": "ok",
                        "matches": [f"{_PAGE}:389", f"{_ENTITY}:18"]}
        envelope = self.synthesize("cyc-sibling")
        self.assertEqual(envelope.content["finding_id"], "F-007")
        skipped = self.governance("plan_candidate_conversion_skipped")
        self.assertEqual([(d["candidate_id"], d["reason"]) for d in skipped],
                         [("F-003", fg.FINDING_EVIDENCE_UNAVAILABLE)])
        self.assertEqual(fold_findings(self.fx.repo)["F-003"]["status"], "OPEN")


class PlanInFlightTests(_ProviderFixture):
    def test_no_detector_runs_while_a_plan_is_in_flight(self) -> None:
        self.seed_drift("F-007", 355)
        self.verdict = {"verdict": "reproduces", "reason": "subject_in_scan", "wire": "ok",
                        "matches": [f"{_PAGE}:389", f"{_ENTITY}:18"]}
        with mock.patch("aria_kernel.plan_convergence.in_flight_plan_id", return_value="plan-adopted"):
            self.synthesize("cyc-in-flight")
        self.assertEqual(self.rechecks, [])
        applied = self.governance("plan_slot_policy_applied")[-1]
        self.assertEqual((applied["plan_in_flight"], applied["seed_detectors"]),
                         ("plan-adopted", "skipped_plan_in_flight"))


class LineMapOriginTests(unittest.TestCase):
    """Second review of #1826: a line must exist at the origin before the
    hunk walk says where it went (``finding_line_map.LINE_ABSENT_AT_ORIGIN``)."""

    def setUp(self) -> None:
        from tests._helpers.git_fixtures import _git, make_repo_with_initial_commit

        self._git = _git
        self.root = Path(tempfile.mkdtemp(prefix="aria-369-linemap-")).resolve()
        self.addCleanup(shutil.rmtree, self.root, True)
        self.repo = make_repo_with_initial_commit(self.root, {"f.txt": "1\n2\n3\n4\n5\n"}, name="repo")
        self.origin = self._head()
        (self.repo / "g.txt").write_text("a\nb\nc\nd\ne\nf\n", encoding="utf-8")
        (self.repo / "f.txt").write_text("0\n1\n2\n3\n4\n5\n", encoding="utf-8")
        self._git(["add", "-A"], cwd=self.repo)
        self._git(["commit", "-q", "-m", "add g, shift f"], cwd=self.repo)
        self.anchor = self._head()

    def _head(self) -> str:
        return self._git(["rev-parse", "HEAD"], cwd=self.repo).stdout.strip()

    def _map(self, path: str, line: int) -> tuple[int | None, str | None]:
        from aria_kernel.finding_line_map import map_cited_line

        return map_cited_line(self.repo, origin=self.origin, anchor=self.anchor, path=path, line=line)

    def test_a_path_absent_at_the_origin_is_never_mapped_into_the_anchor(self) -> None:
        from aria_kernel.finding_line_map import LINE_ABSENT_AT_ORIGIN

        self.assertEqual(self._map("g.txt", 1), (None, LINE_ABSENT_AT_ORIGIN))

    def test_a_line_past_the_origins_end_is_absent(self) -> None:
        from aria_kernel.finding_line_map import LINE_ABSENT_AT_ORIGIN

        self.assertEqual(self._map("f.txt", 6), (None, LINE_ABSENT_AT_ORIGIN))
        self.assertEqual(self._map("f.txt", 0), (None, LINE_ABSENT_AT_ORIGIN))

    def test_a_path_absent_at_both_commits_is_absent(self) -> None:
        from aria_kernel.finding_line_map import LINE_ABSENT_AT_ORIGIN

        self.assertEqual(self._map("nowhere.txt", 1), (None, LINE_ABSENT_AT_ORIGIN))

    def test_an_existing_line_still_shifts(self) -> None:
        self.assertEqual(self._map("f.txt", 5), (6, None))
