"""ARIA-HIGH-363 — a merged implementation closes its finding; a moved line is not a new finding.

Pre-fix world (measured on the aria/state store, 2026-10-06): F-003, F-005,
F-007, F-008 and F-015 are one LeavesPage status filter
(``leave-filter-status`` against ``LeaveRequestStatus``) cited at lines
346/358/355/353/389, minted five times because the seeder deduped by an
evidence chain that hashes the line. ``implementation_reconciler`` marked a
plan IMPLEMENTATION_MERGED and never touched its finding, so a merged fix
left all five OPEN and plannable.
"""
from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from aria_kernel import finding_grounding as fg
from aria_kernel.finding import fold_findings, record_finding_status_change
from aria_kernel.finding_closure import (
    CLOSURE_ACTOR,
    RECHECK_GOVERNANCE_KIND,
    close_merged_plan_finding,
)
from aria_kernel.finding_subject import (
    finding_subject_key,
    findings_with_subject,
    subject_key_from_evidences,
)
from aria_kernel.implementation_reconciler import reconcile_recorded_implementations
from aria_kernel.ledger import load_jsonl
from aria_kernel.plan_convergence import content_hash, fold_plan_state
from aria_kernel.tool_registry import GovernanceError
from tests._helpers.declared_fixtures import append_declared_fixture
from tests._helpers.operator_requests import OperatorRequestFixture
from tests.test_implementation_lifecycle_continuity import MergedPRReader, converging_plan_content

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools" / "aria-poc"))
import seed_drift_findings as seeder  # noqa: E402

UI_FILE = "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx"
ENTITY_FILE = "apps/hr-service/src/leave/entities/leave-request.entity.ts"
OTHER_UI_FILE = "web/modules/hr-module/src/pages/leaves/LeaveForm.tsx"
MERGE_SHA = "f" * 40


def _leave_drift(ui_line: int, *, ui_values: list[str] | None = None,
                 entity_values: list[str] | None = None, ui_file: str = UI_FILE,
                 classification: str = "ui_value_not_on_wire") -> dict:
    """The F-015 shape: the seeder's ui_option_drift for the LeavesPage filter."""
    return {
        "drift_class": "ui_option_drift", "candidate_tool": "event-contracts-adapter",
        "concept": "leaverequest", "cross_service": False, "severity": "HIGH",
        "classification": classification, "transport": "graphql",
        "value_jaccard_similarity": 0.67, "missing_in_ui": ["draft", "withdrawn"],
        "missing_in_source": [],
        "ui": {"ref": f"{ui_file}:{ui_line}", "name": "leave-filter-status",
               "values": ui_values or ["approved", "cancelled", "pending", "rejected"]},
        "source": {"ref": f"{ENTITY_FILE}:18", "name": "LeaveRequestStatus",
                   "values": entity_values or ["APPROVED", "CANCELLED", "DRAFT", "PENDING", "REJECTED", "WITHDRAWN"]},
    }


class SubjectKeyTests(unittest.TestCase):
    def _key(self, drift: dict) -> str | None:
        return seeder.drift_subject_key(drift, seeder.drift_evidences(drift))

    def test_a_moved_line_or_changed_values_keep_the_subject(self) -> None:
        keys = {self._key(_leave_drift(line)) for line in (346, 358, 355, 353, 389)}
        self.assertEqual(len(keys), 1)
        lowered = _leave_drift(389, entity_values=["approved", "cancelled", "draft", "pending", "rejected", "withdrawn"])
        self.assertEqual(self._key(lowered), keys.pop())

    def test_another_file_or_another_symbol_is_another_subject(self) -> None:
        base = self._key(_leave_drift(346))
        self.assertNotEqual(self._key(_leave_drift(346, ui_file=OTHER_UI_FILE)), base)
        renamed = _leave_drift(346)
        renamed["source"] = {**renamed["source"], "name": "LeaveType"}
        self.assertNotEqual(self._key(renamed), base)
        enum = {**_leave_drift(346), "drift_class": "enum_drift"}
        self.assertNotEqual(self._key(enum), base)

    def test_one_sided_evidence_has_no_subject(self) -> None:
        self.assertIsNone(subject_key_from_evidences(
            drift_class="ui_option_drift",
            evidences=[{"ref": f"{UI_FILE}:1", "summary": "leave-filter-status values: ['a']"}],
        ))

    def test_the_stored_record_derives_the_key_the_seeder_minted_with(self) -> None:
        # The live F-015 record's fields, verbatim apart from the envelope.
        record = {
            "originating_skill": "seed:drift-scan",
            "claim_summary": "ui_option_drift: 'leaverequest' ui_value_not_on_wire across 2 surfaces (cross_service=False)",
            "evidences": [
                {"ref": f"{UI_FILE}:389", "summary": "leave-filter-status values: ['approved', 'cancelled', 'pending', 'rejected']"},
                {"ref": f"{ENTITY_FILE}:18", "summary": "LeaveRequestStatus values: ['approved', 'cancelled', 'draft', 'pending', 'rejected', 'withdrawn']"},
            ],
        }
        self.assertEqual(finding_subject_key(record), self._key(_leave_drift(346)))
        self.assertIsNone(finding_subject_key({**record, "originating_skill": "manual:operator"}))


class _Store(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory(prefix="aria-closure-")
        self.addCleanup(tmp.cleanup)
        self.fx = OperatorRequestFixture(Path(tmp.name))
        self.fx.commit_files({
            UI_FILE: "".join(f"export const row{n} = {n};\n" for n in range(1, 401)),
            ENTITY_FILE: "".join(f"export const status{n} = {n};\n" for n in range(1, 41)),
            OTHER_UI_FILE: "".join(f"export const form{n} = {n};\n" for n in range(1, 41)),
        })
        self.repo, self.tools = self.fx.repo, self.fx.tools

    def mint(self, drift: dict) -> str:
        minted, already, unmintable = seeder.mint_candidates(self.repo, [drift], base_dir=self.tools)
        self.assertEqual((already, unmintable), ([], []))
        return minted[0]["finding_id"]

    def status(self, finding_id: str) -> str:
        return fold_findings(self.repo)[finding_id]["status"]

    def merged_plan(self, finding_id: str, plan_id: str = "plan-363") -> dict:
        """A plan planned from ``finding_id`` that reached IMPLEMENTATION_RECORDED."""
        content = converging_plan_content(
            "ARIA-HIGH-363 plan", finding_id=finding_id,
            affected_surfaces=[{"paths": [UI_FILE]}],
        )
        digest = content_hash(content)
        chain = [
            ("plan_started", {"plan_content": content, "content_hash": digest, "initial_revision_id": "rev-0"}),
            ("plan_evaluated", {"round_number": 1, "terminal_state": "CONVERGED", "risks_rollup_summary": {},
                                "gate_decisions": [], "reason_codes": []}),
            ("implementation_requested", {"implementer_agent": "aria-implementer",
                                          "converged_plan_revision_id": "rev-0",
                                          "converged_plan_content_hash": digest}),
            ("implementation_started", {"claim_id": "claim-1", "implementer_agent": "aria-implementer"}),
            ("implementation_outcome_recorded", {
                "claim_id": "claim-1", "pr_url": "https://github.com/o/r/pull/4242",
                "diff_hash": "sha256:" + "c" * 64, "branch_tip_sha": "d" * 40, "validation_results": [],
                "signer_key_fp": "fp-1", "base_branch_sha": "e" * 40}),
        ]
        for event_type, payload in chain:
            append_declared_fixture(self.tools / "plans" / "events.jsonl", {
                "schema_version": 1, "event_id": f"{plan_id}:{event_type}", "event_type": event_type,
                "plan_id": plan_id, "recorded_at": "2026-10-06T10:00:00Z",
                "idempotency_key": "sha256:" + hashlib.sha256(f"{plan_id}|{event_type}".encode()).hexdigest(),
                "payload": payload,
            }, expected_surface="plan_convergence_events")
        self.assertEqual(fold_plan_state(plan_id=plan_id, base_dir=self.tools)["state"], "IMPLEMENTATION_RECORDED")
        return {"plan_id": plan_id}

    def reconcile(self, detector) -> dict:
        return reconcile_recorded_implementations(
            base_dir=self.tools, reader=MergedPRReader(), workspace_root=self.repo,
            detectors={"seed:drift-scan": detector},
        )

    def recheck_rows(self) -> list[dict]:
        return [row["details"] for row in load_jsonl(self.tools / "governance.jsonl")
                if row.get("kind") == RECHECK_GOVERNANCE_KIND]


class _Detector:
    def __init__(self, *verdicts: str) -> None:
        self.verdicts = list(verdicts)
        self.calls: list[str] = []

    def recheck(self, record, *, merge_sha, workspace_root):
        self.calls.append(merge_sha)
        verdict = self.verdicts.pop(0) if len(self.verdicts) > 1 else self.verdicts[0]
        return {"verdict": verdict, "reason": f"fixture_{verdict}", "at": merge_sha,
                "matches": [f"{UI_FILE}:389"] if verdict == "reproduces" else []}


class SeederDedupeTests(_Store):
    def test_a_moved_line_does_not_mint_a_new_finding(self) -> None:
        first = self.mint(_leave_drift(346))
        for line in (358, 355, 353, 389):
            minted, already, _ = seeder.mint_candidates(self.repo, [_leave_drift(line)], base_dir=self.tools)
            self.assertEqual((minted, already), ([], ["leaverequest"]))
        self.assertEqual(list(fold_findings(self.repo)), [first])

    def test_one_scan_with_the_subject_twice_mints_once(self) -> None:
        minted, already, _ = seeder.mint_candidates(
            self.repo, [_leave_drift(346), _leave_drift(389)], base_dir=self.tools,
        )
        self.assertEqual((len(minted), already), (1, ["leaverequest"]))

    def test_a_resolved_subject_seen_again_is_a_regression_finding(self) -> None:
        first = self.mint(_leave_drift(346))
        record_finding_status_change(self.repo, finding_id=first, to_status="IN_PROGRESS",
                                     reason="fixture", actor="test", base_dir=self.tools)
        record_finding_status_change(self.repo, finding_id=first, to_status="RESOLVED",
                                     reason="fixture", actor="test", base_dir=self.tools)
        second = self.mint(_leave_drift(389))
        self.assertNotEqual(first, second)

    def test_a_suppressed_subject_is_still_held(self) -> None:
        first = self.mint(_leave_drift(346))
        record_finding_status_change(self.repo, finding_id=first, to_status="SUPPRESSED",
                                     reason="fixture", actor="test", base_dir=self.tools)
        minted, already, _ = seeder.mint_candidates(self.repo, [_leave_drift(389)], base_dir=self.tools)
        self.assertEqual((minted, already), ([], ["leaverequest"]))


class ClosureOnMergeTests(_Store):
    def setUp(self) -> None:
        super().setUp()
        # The pre-fix store: one subject minted at two lines (the old chain
        # dedupe), plus an unrelated finding that must stay open.
        self.primary = self.mint(_leave_drift(346))
        self.duplicate = self._legacy_duplicate(389)
        self.unrelated = self.mint(_leave_drift(12, ui_file=OTHER_UI_FILE))
        self.merged_plan(self.primary)

    def _legacy_duplicate(self, line: int) -> str:
        from aria_kernel.finding import emit_finding

        drift = _leave_drift(line)
        evidences = seeder.drift_evidences(drift)
        return emit_finding(
            repo_root=self.repo, base_dir=self.tools, claim_type="spine_drift",
            claim_summary="ui_option_drift: 'leaverequest' ui_value_not_on_wire across 2 surfaces (cross_service=False)",
            severity="HIGH", evidences=evidences, facts=["fixture"],
            scope_files=sorted({e["ref"].split(":")[0] for e in evidences}),
            originating_skill="seed:drift-scan",
        )["finding_id"]

    def test_merge_closes_the_finding_and_every_open_duplicate_with_the_merge_evidence(self) -> None:
        self.assertEqual(
            findings_with_subject(fold_findings(self.repo), finding_subject_key(fold_findings(self.repo)[self.primary])),
            sorted([self.primary, self.duplicate]),
        )
        detector = _Detector("absent")
        result = self.reconcile(detector)
        self.assertEqual(result["merged"][0]["merge_sha"], MERGE_SHA)
        closure = result["finding_closures"][0]
        self.assertEqual(closure["status"], "closed")
        self.assertEqual(closure["closed"], sorted([self.primary, self.duplicate]))
        self.assertEqual(detector.calls, [MERGE_SHA])
        findings = fold_findings(self.repo)
        for finding_id in (self.primary, self.duplicate):
            record = findings[finding_id]
            self.assertEqual(record["status"], "RESOLVED")
            self.assertEqual(record["closes_in_commit"], MERGE_SHA)
            self.assertEqual(record["status_actor"], CLOSURE_ACTOR)
            self.assertEqual(record["resolution_evidence"]["plan_id"], "plan-363")
            self.assertEqual(record["resolution_evidence"]["primary_finding_id"], self.primary)
            self.assertEqual(record["resolution_evidence"]["recheck"]["verdict"], "absent")
        self.assertEqual(findings[self.unrelated]["status"], "OPEN")
        # Replay is idempotent: nothing left to close, the detector is not asked again.
        again = self.reconcile(detector)
        self.assertEqual(again["finding_closures"][0]["status"], "already_closed")
        self.assertEqual(detector.calls, [MERGE_SHA])

    def test_a_subject_that_still_reproduces_stays_open_and_is_recorded_once(self) -> None:
        detector = _Detector("reproduces")
        result = self.reconcile(detector)
        self.assertEqual(result["finding_closures"][0]["status"], "reproduces")
        self.assertEqual(self.status(self.primary), "OPEN")
        self.assertEqual(self.status(self.duplicate), "OPEN")
        self.assertEqual([row["verdict"] for row in self.recheck_rows()], ["reproduces"])
        # The merged revision cannot change, so the verdict is final.
        again = self.reconcile(detector)
        self.assertEqual(again["finding_closures"][0], {**again["finding_closures"][0], "status": "reproduces", "recorded": True})
        self.assertEqual(detector.calls, [MERGE_SHA])
        self.assertEqual(len(self.recheck_rows()), 1)

    def test_an_unverifiable_recheck_is_retried_and_closes_once_it_can_judge(self) -> None:
        detector = _Detector("unverifiable", "unverifiable", "absent")
        self.assertEqual(self.reconcile(detector)["finding_closures"][0]["status"], "unverifiable")
        self.assertEqual(self.reconcile(detector)["finding_closures"][0]["status"], "unverifiable")
        self.assertEqual(len(self.recheck_rows()), 1, "the same unverifiable reason is disclosed once")
        self.assertEqual(self.status(self.primary), "OPEN")
        self.assertEqual(self.reconcile(detector)["finding_closures"][0]["status"], "closed")
        self.assertEqual(len(detector.calls), 3)

    def test_an_origin_without_a_detector_is_never_closed_unverified(self) -> None:
        result = reconcile_recorded_implementations(
            base_dir=self.tools, reader=MergedPRReader(), workspace_root=self.repo, detectors={},
        )
        self.assertEqual(result["finding_closures"][0]["status"], "detector_unregistered")
        self.assertEqual(self.status(self.primary), "OPEN")

    def test_fixed_duplicates_are_not_re_planned(self) -> None:
        before = fg.load_grounding_context(self.repo, tools_root=self.tools)
        self.assertNotEqual(fg.admit_finding(before, self.duplicate).reason, fg.FINDING_NOT_OPEN)
        self.reconcile(_Detector("absent"))
        after = fg.load_grounding_context(self.repo, tools_root=self.tools)
        for finding_id in (self.primary, self.duplicate):
            admission = fg.admit_candidate({"source_type": "f_finding", "candidate_id": finding_id}, after)
            self.assertEqual(admission.reason, fg.FINDING_NOT_OPEN)
        # The next night's seeder sees no reproduction at HEAD and mints
        # nothing; were the subject seen again it would be a regression.
        self.assertEqual(fold_findings(self.repo)[self.unrelated]["status"], "OPEN")

    def test_a_crash_between_the_two_transitions_resumes_at_in_progress(self) -> None:
        real = record_finding_status_change
        calls: list[str] = []

        def die_on_first_resolve(repo_root, *, to_status, **kwargs):
            calls.append(to_status)
            if to_status == "RESOLVED" and calls.count("RESOLVED") == 1:
                raise OSError("process died")
            return real(repo_root, to_status=to_status, **kwargs)

        with mock.patch("aria_kernel.finding_closure.record_finding_status_change", side_effect=die_on_first_resolve):
            with self.assertRaises(OSError):
                close_merged_plan_finding(
                    plan_id="plan-363", state=self._merged_state(), repo_root=self.repo,
                    base_dir=self.tools, detectors={"seed:drift-scan": _Detector("absent")},
                )
        self.assertEqual(self.status(self.primary), "IN_PROGRESS")
        result = close_merged_plan_finding(
            plan_id="plan-363", state=self._merged_state(), repo_root=self.repo,
            base_dir=self.tools, detectors={"seed:drift-scan": _Detector("absent")},
        )
        self.assertEqual(result["status"], "closed")
        self.assertEqual(self.status(self.primary), "RESOLVED")

    def _merged_state(self) -> dict:
        state = fold_plan_state(plan_id="plan-363", base_dir=self.tools)
        state["implementation"]["merge_sha"] = MERGE_SHA
        return state

    def test_closes_in_commit_is_refused_on_any_transition_but_resolved(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "finding_status_change_resolution_fields"):
            record_finding_status_change(
                self.repo, finding_id=self.unrelated, to_status="IN_PROGRESS", reason="fixture",
                actor="test", closes_in_commit=MERGE_SHA, base_dir=self.tools,
            )


class JudgeSubjectTests(unittest.TestCase):
    def setUp(self) -> None:
        drift = _leave_drift(389)
        self.subject = seeder.drift_subject_key(drift, seeder.drift_evidences(drift))

    def _doc(self, drifts: list[dict], wire: str = "ok") -> dict:
        return {"drifts_above_threshold": [], "wire": {"status": wire, "reason": "fixture"},
                "frontend_dropdown_drifts": [{k: v for k, v in d.items() if k not in {"drift_class", "candidate_tool"}}
                                             for d in drifts]}

    def test_the_subject_in_the_scan_reproduces(self) -> None:
        verdict = seeder.judge_subject(self._doc([_leave_drift(401)]), subject_key=self.subject,
                                       drift_class="ui_option_drift")
        self.assertEqual(verdict["verdict"], "reproduces")
        self.assertIn(f"{UI_FILE}:401", verdict["matches"])

    def test_absent_only_when_the_wire_judged_the_ui_pairs(self) -> None:
        judged = seeder.judge_subject(self._doc([]), subject_key=self.subject, drift_class="ui_option_drift")
        self.assertEqual(judged["verdict"], "absent")
        blind = seeder.judge_subject(self._doc([], wire="unavailable"), subject_key=self.subject,
                                     drift_class="ui_option_drift")
        self.assertEqual((blind["verdict"], blind["reason"]), ("unverifiable", "wire_unavailable:fixture"))

    def test_an_unmintable_drift_does_not_reproduce(self) -> None:
        unclassified = {**_leave_drift(389), "classification": None}
        verdict = seeder.judge_subject(self._doc([unclassified]), subject_key=self.subject,
                                       drift_class="ui_option_drift")
        self.assertEqual(verdict["verdict"], "absent")


class RecheckAtRevisionTests(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory(prefix="aria-recheck-test-")
        self.addCleanup(tmp.cleanup)
        self.repo = Path(tmp.name) / "repo"
        self.repo.mkdir()
        for args in (["init", "-q"], ["config", "user.email", "t@example.invalid"], ["config", "user.name", "T"]):
            subprocess.run(["git", *args], cwd=self.repo, check=True)
        (self.repo / "marker.txt").write_text("merged\n", encoding="utf-8")
        subprocess.run(["git", "add", "marker.txt"], cwd=self.repo, check=True)
        subprocess.run(["git", "commit", "-q", "-m", "merge"], cwd=self.repo, check=True)
        self.merge = subprocess.run(["git", "rev-parse", "HEAD"], cwd=self.repo, check=True,
                                    capture_output=True, text=True).stdout.strip()
        (self.repo / "marker.txt").write_text("later\n", encoding="utf-8")
        subprocess.run(["git", "commit", "-q", "-am", "later"], cwd=self.repo, check=True)

    def test_the_scan_runs_on_the_merge_commit_and_the_worktree_is_removed(self) -> None:
        seen: list[str] = []

        def scan(tree: Path, supergraph):
            seen.append((tree / "marker.txt").read_text(encoding="utf-8"))
            self.assertIsNone(supergraph, "no supergraph is exact for a tree without the workflow")
            return {"drifts_above_threshold": [], "frontend_dropdown_drifts": [], "wire": {"status": "unavailable"}}

        with mock.patch.object(seeder, "run_fresh_scan", side_effect=scan):
            verdict = seeder.recheck_subject(self.repo, subject_key="subject_x", drift_class="enum_drift",
                                             at_sha=self.merge, supergraph="/nonexistent/supergraph.graphql")
        self.assertEqual(seen, ["merged\n"])
        self.assertEqual((verdict["verdict"], verdict["at"]), ("absent", self.merge))
        listed = subprocess.run(["git", "worktree", "list"], cwd=self.repo, check=True,
                                capture_output=True, text=True).stdout
        self.assertEqual(len(listed.strip().splitlines()), 1)

    def _commit(self, files: dict[str, str], message: str) -> str:
        for relative, text in files.items():
            path = self.repo / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8")
            subprocess.run(["git", "add", relative], cwd=self.repo, check=True)
        subprocess.run(["git", "commit", "-q", "-m", message], cwd=self.repo, check=True)
        return subprocess.run(["git", "rev-parse", "HEAD"], cwd=self.repo, check=True,
                              capture_output=True, text=True).stdout.strip()

    def _supergraph_seen(self, at_sha: str) -> list:
        seen: list = []

        def scan(tree: Path, supergraph):
            seen.append(supergraph)
            return {"drifts_above_threshold": [], "frontend_dropdown_drifts": [], "wire": {"status": "ok"}}

        with mock.patch.object(seeder, "run_fresh_scan", side_effect=scan):
            seeder.recheck_subject(self.repo, subject_key="subject_x", drift_class="ui_option_drift",
                                   at_sha=at_sha, supergraph="/lane/supergraph.graphql")
        return seen

    def test_the_lane_supergraph_is_used_only_when_no_schema_commit_separates_head_from_the_merge(self) -> None:
        workflow = ".github/workflows/apollo-supergraph-validate.yml"
        self._commit({workflow: "on:\n  push:\n    paths:\n      - 'schema/**'\n",
                      "schema/a.graphql": "type A { a: Int }\n"}, "schema")
        merge = self._commit({"marker.txt": "merged again\n"}, "merge")
        self._commit({"marker.txt": "after\n"}, "unrelated")
        self.assertEqual(self._supergraph_seen(merge), ["/lane/supergraph.graphql"])
        self._commit({"schema/a.graphql": "type A { a: Int, b: Int }\n"}, "schema change after the merge")
        self.assertEqual(self._supergraph_seen(merge), [None])

    def test_an_unknown_revision_is_unverifiable(self) -> None:
        verdict = seeder.recheck_subject(self.repo, subject_key="subject_x", drift_class="enum_drift",
                                         at_sha="0" * 40, supergraph=None)
        self.assertEqual((verdict["verdict"], verdict["reason"]), ("unverifiable", "revision_unavailable"))

    def test_the_cli_prints_one_json_verdict_line(self) -> None:
        with mock.patch.object(seeder, "run_fresh_scan", return_value={
            "drifts_above_threshold": [], "frontend_dropdown_drifts": [], "wire": {"status": "ok"}}), \
                mock.patch("builtins.print") as printed:
            self.assertEqual(seeder.main(["--repo-root", str(self.repo), "--recheck-subject", "subject_x",
                                          "--drift-class", "ui_option_drift", "--at", self.merge]), 0)
        self.assertEqual(json.loads(printed.call_args.args[0])["verdict"], "absent")


if __name__ == "__main__":
    unittest.main()
