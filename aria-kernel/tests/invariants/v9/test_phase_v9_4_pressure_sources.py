"""Plan ARIA-V9.4 — plan_synthesizer 5 pressure sources + pattern_signature
invariants.

Closes:
  * arb CRIT-006 (PlanCandidateSource imported, not ad-hoc strings)
  * arb CRIT-007 (pattern_signature stable normalization +
    cardinality guard)
  * arb MED-003 (gh run list 10-min TTL cache)
  * arb MED-004 (explicit source priority order)
  * ai HIGH-010 (operator-feedback signature verification)
  * perf HIGH-005 (per-source slow-source detection)
  * perf HIGH-006 (F-finding aging stat-only; superseded by ARIA-MEDIUM-330:
    the scan reads the finding-event fold, the one authority for which
    findings exist)
  * perf HIGH-008 (pattern_signature cardinality guard)
"""
from __future__ import annotations

import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from . import _helpers  # noqa: F401

from aria_kernel import plan_synthesizer as _ps
from aria_kernel.plan_candidate_source import PlanCandidateSource


class TestV9KeyChangeCategories(unittest.TestCase):

    def test_categories_closed_set(self):
        self.assertIsInstance(_ps.KEY_CHANGE_CATEGORIES, frozenset)
        # Closed enum — adding a category requires ADR + arbiter approval
        # + invariant amendment.
        self.assertEqual(
            _ps.KEY_CHANGE_CATEGORIES,
            frozenset({
                "ADD_ENTITY", "ADD_MIGRATION", "ADD_HANDLER",
                "ADD_EVENT_CONTRACT", "ADD_DTO", "FIX_BUG",
                "REFACTOR_SAFE", "TEST_ONLY", "DOC_ONLY",
            }),
        )

    def test_min_evidence_ref_cardinality_canonical(self):
        self.assertEqual(_ps.MIN_EVIDENCE_REF_CARDINALITY, 5)


class TestV9OrphanScanner(unittest.TestCase):

    def test_scan_missing_file_returns_empty(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(_ps.scan_orphan_findings(tmp), [])

    def test_scan_picks_only_open_findings(self):
        with tempfile.TemporaryDirectory() as tmp:
            md = Path(tmp) / "docs" / "reviews" / "orphan-findings.md"
            md.parent.mkdir(parents=True)
            md.write_text(
                "## ORPHAN-CRITICAL-001\nStatus: OPEN\nDesc one\n\n"
                "## ORPHAN-HIGH-002\nStatus: RESOLVED\nDesc two\n\n"
                "## ORPHAN-LOW-003\nStatus: OPEN\nDesc three\n",
            )
            results = _ps.scan_orphan_findings(tmp)
            ids = [c["candidate_id"] for c in results]
            self.assertIn("ORPHAN-CRITICAL-001", ids)
            self.assertNotIn("ORPHAN-HIGH-002", ids)  # not OPEN
            self.assertIn("ORPHAN-LOW-003", ids)

    def test_scan_severity_ordering(self):
        with tempfile.TemporaryDirectory() as tmp:
            md = Path(tmp) / "docs" / "reviews" / "orphan-findings.md"
            md.parent.mkdir(parents=True)
            md.write_text(
                "## ORPHAN-LOW-001\nStatus: OPEN\n\n"
                "## ORPHAN-CRITICAL-002\nStatus: OPEN\n\n"
                "## ORPHAN-HIGH-003\nStatus: OPEN\n",
            )
            results = _ps.scan_orphan_findings(tmp)
            self.assertEqual(results[0]["severity"], "CRITICAL")
            self.assertEqual(results[1]["severity"], "HIGH")
            self.assertEqual(results[2]["severity"], "LOW")


class TestV9FFindingScanner(unittest.TestCase):

    def test_scan_missing_dir_returns_empty(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(_ps.scan_f_findings(tmp), [])

    def test_scan_orders_oldest_first(self):
        """Age is the folded record's created_at (ARIA-MEDIUM-330), not a file mtime."""
        from tests._helpers.declared_fixtures import append_declared_fixture

        with tempfile.TemporaryDirectory() as tmp:
            findings = Path(tmp) / "aria-findings"
            findings.mkdir()
            for finding_id, created_at in (("F-002", "2026-09-02T00:00:00Z"),
                                           ("F-001", "2026-09-01T00:00:00Z")):
                append_declared_fixture(findings / "finding-events.jsonl", {
                    "schema_version": 1, "event": "finding_emitted",
                    "event_id": f"finding:{finding_id}:emitted", "finding_id": finding_id,
                    "record": {"finding_id": finding_id, "status": "OPEN", "created_at": created_at},
                }, expected_surface="repo_finding_events")
            results = _ps.scan_f_findings(tmp)
            self.assertEqual([c["candidate_id"] for c in results], ["F-001", "F-002"])
            self.assertGreater(results[0]["age_seconds"], results[1]["age_seconds"])

    def test_scan_ignores_a_finding_file_the_ledger_never_emitted(self):
        """ARIA-MEDIUM-330 — the fold, not the directory, says which findings exist."""
        from tests._helpers.declared_fixtures import append_declared_fixture

        with tempfile.TemporaryDirectory() as tmp:
            findings = Path(tmp) / "aria-findings"
            findings.mkdir()
            record = {"finding_id": "F-001", "status": "OPEN", "created_at": "2026-09-01T00:00:00Z"}
            append_declared_fixture(findings / "finding-events.jsonl", {
                "schema_version": 1, "event": "finding_emitted", "event_id": "finding:F-001:emitted",
                "finding_id": "F-001", "record": record,
            }, expected_surface="repo_finding_events")
            (findings / "F-001.json").write_text(json.dumps(record))
            (findings / "F-101.json").write_text(json.dumps({"id": "F-101", "status": "OPEN"}))
            results = _ps.scan_f_findings(tmp)
            self.assertEqual([c["candidate_id"] for c in results], ["F-001"])


class TestV9OperatorFeedbackSignature(unittest.TestCase):
    """ai-safety HIGH-010 / V9.5 check 12 — operator-feedback signature verification.

    The pre-fix scanner accepted any row whose ``signature`` and
    ``signature_kid`` were non-empty strings, so these cases used to pass
    stub signatures through. A request row now reaches the synthesizer only
    when the OPERATOR signed it with a key the committed allowed-signers file
    enrols (ADR-0020, ``operator_request_signature``) and it names an F
    finding (ADR-0018); a stub is dropped with an
    ``unsigned_operator_feedback`` governance event.
    """

    def _fixture(self, tmp: str):
        import os
        from unittest import mock

        from tests._helpers.operator_requests import GROUNDED_FILE, OperatorRequestFixture

        env = {k: v for k, v in os.environ.items() if k != "ARIA_REPO_STATE_ROOT"}
        patcher = mock.patch.dict(os.environ, env, clear=True)
        patcher.start()
        self.addCleanup(patcher.stop)
        fixture = OperatorRequestFixture(Path(tmp))
        # A request names an OPEN, repo-grounded F finding (ADR-0018).
        fixture.seed_finding("F-007", refs=[f"{GROUNDED_FILE}:12"])
        return fixture

    def _tools(self, tmp: str) -> Path:
        from aria_kernel.tool_registry import ensure_tools_dir
        return ensure_tools_dir(Path(tmp) / "aria-tools")

    def _write_unsigned(self, tools: Path, rows: list[dict]) -> None:
        from tests._helpers.declared_fixtures import append_declared_fixture
        for row in rows:
            append_declared_fixture(
                tools / "operator-feedback.jsonl", row, expected_surface="operator_feedback",
            )

    def _drops(self, tools: Path) -> list[dict]:
        from aria_kernel.ledger import load_declared_jsonl
        return [row["details"] for row in load_declared_jsonl(
            tools / "governance.jsonl", expected_surface="tools_governance",
        ) if row["kind"] == "unsigned_operator_feedback"]

    def test_unsigned_row_dropped(self):
        with tempfile.TemporaryDirectory() as tmp:
            tools = self._tools(tmp)
            self._write_unsigned(tools, [
                {
                    "id": "OP-001",
                    "status": "unaddressed",
                    "authored_at": "2026-05-18T00:00:00Z",
                    "request": "fix something",
                    "priority": "high",
                    # NO signature, NO signer_kid → drop + governance event
                },
            ])
            results = _ps.scan_operator_feedback(tmp)
            self.assertEqual(results, [])
            self.assertEqual([d["id"] for d in self._drops(tools)], ["OP-001"])

    def test_stub_signature_is_not_a_signature(self):
        """The pre-fix acceptance case, inverted: presence is not proof."""
        with tempfile.TemporaryDirectory() as tmp:
            tools = self._tools(tmp)
            self._write_unsigned(tools, [
                {
                    "id": "OP-002",
                    "status": "unaddressed",
                    "authored_at": "2026-05-18T00:00:00Z",
                    "request": "valid request",
                    "priority": "high",
                    "signature": "sig-stub-for-test",
                    "signer_kid": "operator-key-01",
                },
            ])
            self.assertEqual(_ps.scan_operator_feedback(tmp), [])
            self.assertEqual([d["reason"] for d in self._drops(tools)], ["signature_malformed"])

    def test_signed_row_accepted(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = self._fixture(tmp)
            stored = fixture.record(request="valid request", priority="high", request_id="OP-002")
            results = _ps.scan_operator_feedback(fixture.repo)
            self.assertEqual(len(results), 1)
            self.assertEqual(results[0]["candidate_id"], "OP-002")
            self.assertEqual(results[0]["signer"], fixture.principal)
            self.assertEqual(results[0]["finding_id"], "F-007")
            self.assertEqual(results[0]["row_ledger_hash"], stored["ledger_hash"])
            self.assertEqual(self._drops(fixture.tools), [])

    def test_invented_priority_max_rejected(self):
        """Per arb CRIT-006 — priority MUST be in closed set
        {low, medium, high}; 'max' was a v1 plan invention that
        could override severity ladder. The recorder refuses it, and a
        row the operator's key signed with that priority is still
        dropped at ingestion."""
        from aria_kernel.tool_registry import GovernanceError
        with tempfile.TemporaryDirectory() as tmp:
            fixture = self._fixture(tmp)
            with self.assertRaises(GovernanceError):
                fixture.record(request="evil max", priority="max")
            fixture.append_raw(fixture.sign(fixture.request_row(
                id="OP-003",
                request="evil max",
                priority="max",  # INVENTED
            )))
            results = _ps.scan_operator_feedback(fixture.repo)
            self.assertEqual(results, [])
            self.assertEqual([d["reason"] for d in self._drops(fixture.tools)], ["schema_invalid"])

    def test_priority_ordering(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = self._fixture(tmp)
            for identifier, priority, text in (
                ("L1", "low", "low task"), ("H1", "high", "high task"), ("M1", "medium", "medium task"),
            ):
                fixture.record(request=text, priority=priority, request_id=identifier)
            results = _ps.scan_operator_feedback(fixture.repo)
            self.assertEqual([r["candidate_id"] for r in results], ["H1", "M1", "L1"])


class TestV9SourcePriority(unittest.TestCase):

    def test_priority_ranking_canonical(self):
        """Source priority order: OPERATOR_FEEDBACK > FAILING_CI >
        ORPHAN > F_FINDING > GIT_DIFF (arb MED-004)."""
        self.assertEqual(
            _ps._SOURCE_PRIORITY[PlanCandidateSource.OPERATOR_FEEDBACK.value], 0,
        )
        self.assertEqual(
            _ps._SOURCE_PRIORITY[PlanCandidateSource.FAILING_CI.value], 1,
        )
        self.assertEqual(
            _ps._SOURCE_PRIORITY[PlanCandidateSource.ORPHAN_FINDING.value], 2,
        )
        self.assertEqual(
            _ps._SOURCE_PRIORITY[PlanCandidateSource.F_FINDING.value], 3,
        )
        self.assertEqual(
            _ps._SOURCE_PRIORITY[PlanCandidateSource.GIT_DIFF.value], 4,
        )


class TestV9PatternSignature(unittest.TestCase):
    """arb CRIT-007 — stable normalization + cardinality guard."""

    def _plan(self, **overrides) -> dict:
        base = {
            "schema_version": 1,
            "affected_surfaces": ["b/x.py", "a/y.py", "a/y.py"],  # unsorted + dup
            "key_changes": [
                {"file": "a/y.py", "description": "Fix bug in handler"},
                {"file": "b/x.py", "description": "Test only refactor"},
            ],
            "validation_commands": [
                {"cmd": "nx affected --target=test", "timeout_ms": 100, "expected_exit": 0},
                {"cmd": "nx affected --target=lint", "timeout_ms": 100, "expected_exit": 0},
            ],
            "evidence_refs": [
                "a/y.py:1", "a/y.py:2", "a/y.py:3",
                "b/x.py:1", "b/x.py:2",
            ],
        }
        base.update(overrides)
        return base

    def test_stable_under_reordering(self):
        """Reorder affected_surfaces + validation_commands → same
        signature."""
        a = self._plan()
        b = self._plan(
            affected_surfaces=["a/y.py", "b/x.py"],
            validation_commands=[
                {"cmd": "nx affected --target=lint", "timeout_ms": 100, "expected_exit": 0},
                {"cmd": "nx affected --target=test", "timeout_ms": 100, "expected_exit": 0},
            ],
        )
        sa = _ps.compute_pattern_signature(a)
        sb = _ps.compute_pattern_signature(b)
        self.assertIsNotNone(sa)
        self.assertEqual(sa, sb)

    def test_low_cardinality_returns_none(self):
        """< MIN_EVIDENCE_REF_CARDINALITY distinct refs → None."""
        plan = self._plan(evidence_refs=["a.py:1", "a.py:2"])  # 2 distinct
        self.assertIsNone(_ps.compute_pattern_signature(plan))

    def test_different_categories_different_signatures(self):
        """ADD_ENTITY plan vs FIX_BUG plan → different signatures."""
        a = self._plan(
            key_changes=[{"description": "Add new @Entity for foo"}],
            evidence_refs=["a:1", "a:2", "a:3", "a:4", "a:5"],
        )
        b = self._plan(
            key_changes=[{"description": "Fix bug in bar"}],
            evidence_refs=["a:1", "a:2", "a:3", "a:4", "a:5"],
        )
        sa = _ps.compute_pattern_signature(a)
        sb = _ps.compute_pattern_signature(b)
        self.assertNotEqual(sa, sb)

    def test_validation_command_shell_variants_normalized(self):
        """nx affected --target=test --base=main and nx affected
        --target=test should normalize to same nx:test token."""
        a = self._plan()
        b = self._plan(
            validation_commands=[
                {"cmd": "nx affected --target=test --base=main", "timeout_ms": 100, "expected_exit": 0},
                {"cmd": "nx affected --target=lint --base=main", "timeout_ms": 100, "expected_exit": 0},
            ],
        )
        sa = _ps.compute_pattern_signature(a)
        sb = _ps.compute_pattern_signature(b)
        self.assertEqual(sa, sb)


class TestV9KeyChangeClassifier(unittest.TestCase):

    def test_classifier_recognises_known_categories(self):
        cases = [
            ("Add new @Entity for sensor", "ADD_ENTITY"),
            ("Add migration for users table", "ADD_MIGRATION"),
            ("Add handler for ProcessOrder", "ADD_HANDLER"),
            ("Add new event contract", "ADD_EVENT_CONTRACT"),
            ("Add new DTO for response", "ADD_DTO"),
            ("Fix bug in retry logic", "FIX_BUG"),
            ("Test only refactor of helper", "TEST_ONLY"),
            ("Doc only change in README", "DOC_ONLY"),
        ]
        for description, expected in cases:
            self.assertEqual(
                _ps._classify_key_change(description), expected,
                f"{description!r} should classify as {expected}",
            )

    def test_classifier_unknown_falls_to_refactor_safe(self):
        self.assertEqual(
            _ps._classify_key_change("random text with no keywords"),
            "REFACTOR_SAFE",
        )

    def test_classifier_handles_non_string(self):
        # None / int input → REFACTOR_SAFE (no crash)
        self.assertEqual(_ps._classify_key_change(None), "REFACTOR_SAFE")  # type: ignore
        self.assertEqual(_ps._classify_key_change(42), "REFACTOR_SAFE")  # type: ignore


class TestV9GhRunListCache(unittest.TestCase):

    def test_cache_ttl_canonical(self):
        self.assertEqual(_ps._GH_RUN_LIST_CACHE_TTL_SECONDS, 600)

    def test_cache_read_returns_none_when_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            cache = Path(tmp) / "gh-cache.json"
            self.assertIsNone(_ps._read_gh_run_list_cache(cache))

    def test_cache_read_returns_payload_when_fresh(self):
        with tempfile.TemporaryDirectory() as tmp:
            cache = Path(tmp) / "gh-cache.json"
            payload = [{"candidate_id": "ci-run-42"}]
            _ps._write_gh_run_list_cache(cache, payload)
            self.assertEqual(_ps._read_gh_run_list_cache(cache), payload)

    def test_cache_read_returns_none_when_expired(self):
        with tempfile.TemporaryDirectory() as tmp:
            cache = Path(tmp) / "gh-cache.json"
            cache.write_text(json.dumps({
                "cached_at_epoch": time.time() - 700,  # > 600s TTL
                "payload": [{"x": 1}],
            }))
            self.assertIsNone(_ps._read_gh_run_list_cache(cache))


class TestV9FailingCiIsCurrentlyRed(unittest.TestCase):
    """ARIA-HIGH-250 — a failing_ci candidate is a workflow that is red NOW.

    The source used to be the five newest failed runs on main. A failed run
    stays failed forever, so a workflow that went green kept supplying
    candidates, and because failing_ci outranks f_finding every cycle from
    2026-09-29 on selected a CI run and never reached an F finding.
    """

    @staticmethod
    def _run(run_id, workflow_id, workflow, conclusion, created_at):
        return {
            "databaseId": run_id,
            "workflowDatabaseId": workflow_id,
            "workflowName": workflow,
            "headSha": f"sha{run_id}",
            "conclusion": conclusion,
            "createdAt": created_at,
            "event": "schedule",
        }

    def _scan(self, rows):
        calls = []
        # ORPHAN-HIGH-519 — after the run list, the scanner asks for the
        # workflow paths and each red run's jobs; this suite pins the verdict,
        # so those answer nothing.
        answers = {("run", "list"): rows, ("workflow", "list"): [], ("run", "view"): {"jobs": []}}

        def fake_run(argv, **kwargs):
            calls.append(argv)

            class _Result:
                returncode = 0
                stdout = json.dumps(answers[(argv[1], argv[2])])
                stderr = ""
            return _Result()

        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(_ps.subprocess, "run", side_effect=fake_run):
                with mock.patch("shutil.which", return_value="/usr/bin/gh"):
                    with mock.patch.dict(os.environ, {"ARIA_DRY_RUN": ""}):
                        result = _ps.scan_failing_ci(tmp, cache_dir=tmp)
        self.assertEqual([argv[1:3] for argv in calls].count(["run", "list"]), 1)
        return result, calls[0]

    def test_workflow_that_went_green_supplies_no_candidate(self):
        rows = [
            self._run(3, 11, "Database WAL Archive Freshness", "success", "2026-10-03T02:27:00Z"),
            self._run(2, 11, "Database WAL Archive Freshness", "failure", "2026-10-02T02:27:00Z"),
            self._run(1, 11, "Database WAL Archive Freshness", "failure", "2026-10-01T23:27:00Z"),
        ]
        result, _ = self._scan(rows)
        self.assertEqual(result, [])

    def test_red_workflow_supplies_its_newest_failure_once(self):
        rows = [
            self._run(5, 22, "Nightly Fuzz", "failure", "2026-10-02T07:25:00Z"),
            self._run(4, 33, "dataflow-integrity-watchdog", "success", "2026-10-02T06:06:00Z"),
            self._run(3, 22, "Nightly Fuzz", "failure", "2026-10-01T07:38:00Z"),
            self._run(2, 22, "Nightly Fuzz", "failure", "2026-09-30T07:14:00Z"),
        ]
        result, _ = self._scan(rows)
        self.assertEqual([c["candidate_id"] for c in result], ["ci-run-5"])
        self.assertEqual(result[0]["workflow_name"], "Nightly Fuzz")

    def test_runs_that_neither_passed_nor_failed_do_not_decide(self):
        rows = [
            self._run(6, 44, "Red then cancelled", "cancelled", "2026-10-02T09:00:00Z"),
            self._run(5, 44, "Red then cancelled", "failure", "2026-10-02T08:00:00Z"),
            self._run(4, 55, "Green then skipped", "skipped", "2026-10-02T09:00:00Z"),
            self._run(3, 55, "Green then skipped", "success", "2026-10-02T08:00:00Z"),
            self._run(2, 55, "Green then skipped", "failure", "2026-10-02T07:00:00Z"),
        ]
        result, _ = self._scan(rows)
        self.assertEqual([c["candidate_id"] for c in result], ["ci-run-5"])

    def test_newest_run_decides_whatever_order_gh_returns(self):
        rows = [
            self._run(1, 66, "Capacity", "failure", "2026-10-02T05:20:00Z"),
            self._run(2, 66, "Capacity", "success", "2026-10-02T13:20:00Z"),
            self._run(3, 77, "Watchdog", "success", "2026-10-02T02:16:00Z"),
            self._run(4, 77, "Watchdog", "failure", "2026-10-02T14:16:00Z"),
        ]
        result, _ = self._scan(rows)
        self.assertEqual([c["candidate_id"] for c in result], ["ci-run-4"])

    def test_workflow_identity_is_the_workflow_id_not_its_name(self):
        rows = [
            self._run(2, 88, "CI", "success", "2026-10-02T09:00:00Z"),
            self._run(1, 99, "CI", "failure", "2026-10-02T08:00:00Z"),
        ]
        result, _ = self._scan(rows)
        self.assertEqual([c["candidate_id"] for c in result], ["ci-run-1"])

    def test_reads_completed_runs_across_the_window_not_the_last_five_failures(self):
        _, argv = self._scan([])
        self.assertEqual(argv[argv.index("--status") + 1], "completed")
        self.assertEqual(argv[argv.index("--limit") + 1], str(_ps._FAILING_CI_RUN_WINDOW))
        self.assertIn("workflowDatabaseId", argv[argv.index("--json") + 1].split(","))


class TestV9PublicApi(unittest.TestCase):

    def test_v94_exports_in_all(self):
        canonical_additions = {
            "scan_orphan_findings", "scan_f_findings",
            "scan_failing_ci", "scan_operator_feedback",
            "rank_candidate_sources", "compute_pattern_signature",
            "KEY_CHANGE_CATEGORIES", "MIN_EVIDENCE_REF_CARDINALITY",
        }
        for name in canonical_additions:
            self.assertIn(name, _ps.__all__, f"{name} MUST be in __all__")


if __name__ == "__main__":
    unittest.main()
