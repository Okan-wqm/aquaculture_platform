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
  * perf HIGH-006 (F-finding aging stat-only)
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

    def test_scan_uses_stat_only_no_json_parse(self):
        """perf HIGH-006 — JSON body NOT parsed until candidate
        selected. Verify by creating a malformed JSON file; scan
        MUST succeed (only stat is used)."""
        with tempfile.TemporaryDirectory() as tmp:
            findings = Path(tmp) / "aria-findings"
            findings.mkdir()
            bad = findings / "F-999.json"
            bad.write_text("this is not valid json at all >>> }}}")
            results = _ps.scan_f_findings(tmp)
            self.assertEqual(len(results), 1)
            self.assertEqual(results[0]["candidate_id"], "F-999")

    def test_scan_orders_oldest_first(self):
        with tempfile.TemporaryDirectory() as tmp:
            findings = Path(tmp) / "aria-findings"
            findings.mkdir()
            a = findings / "F-001.json"
            a.write_text("{}")
            time.sleep(0.05)
            b = findings / "F-002.json"
            b.write_text("{}")
            os.utime(a, (time.time() - 1000, time.time() - 1000))  # older
            results = _ps.scan_f_findings(tmp)
            self.assertEqual(results[0]["candidate_id"], "F-001")


class TestV9OperatorFeedbackSignature(unittest.TestCase):
    """ai-safety HIGH-010 — operator-feedback signature verification."""

    def _write_feedback(self, tmp: str, rows: list[dict]) -> Path:
        p = Path(tmp) / "aria-tools" / "operator-feedback.jsonl"
        p.parent.mkdir(parents=True)
        with p.open("w") as f:
            for r in rows:
                f.write(json.dumps(r) + "\n")
        return p

    def test_unsigned_row_dropped(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._write_feedback(tmp, [
                {
                    "id": "OP-001",
                    "status": "unaddressed",
                    "authored_at": "2026-05-18T00:00:00Z",
                    "request": "fix something",
                    "priority": "high",
                    # NO signature, NO signature_kid → drop
                },
            ])
            results = _ps.scan_operator_feedback(tmp)
            self.assertEqual(results, [])

    def test_signed_row_accepted(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._write_feedback(tmp, [
                {
                    "id": "OP-002",
                    "status": "unaddressed",
                    "authored_at": "2026-05-18T00:00:00Z",
                    "request": "valid request",
                    "priority": "high",
                    "signature": "sig-stub-for-test",
                    "signature_kid": "operator-key-01",
                },
            ])
            results = _ps.scan_operator_feedback(tmp)
            self.assertEqual(len(results), 1)
            self.assertEqual(results[0]["candidate_id"], "OP-002")

    def test_invented_priority_max_rejected(self):
        """Per arb CRIT-006 — priority MUST be in closed set
        {low, medium, high}; 'max' was a v1 plan invention that
        could override severity ladder."""
        with tempfile.TemporaryDirectory() as tmp:
            self._write_feedback(tmp, [
                {
                    "id": "OP-003",
                    "status": "unaddressed",
                    "authored_at": "2026-05-18T00:00:00Z",
                    "request": "evil max",
                    "priority": "max",  # INVENTED
                    "signature": "sig",
                    "signature_kid": "k",
                },
            ])
            results = _ps.scan_operator_feedback(tmp)
            self.assertEqual(results, [])

    def test_priority_ordering(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._write_feedback(tmp, [
                {
                    "id": "L1", "status": "unaddressed",
                    "authored_at": "2026-05-18T00:00:00Z",
                    "request": "low task", "priority": "low",
                    "signature": "s", "signature_kid": "k",
                },
                {
                    "id": "H1", "status": "unaddressed",
                    "authored_at": "2026-05-18T01:00:00Z",
                    "request": "high task", "priority": "high",
                    "signature": "s", "signature_kid": "k",
                },
                {
                    "id": "M1", "status": "unaddressed",
                    "authored_at": "2026-05-18T02:00:00Z",
                    "request": "medium task", "priority": "medium",
                    "signature": "s", "signature_kid": "k",
                },
            ])
            results = _ps.scan_operator_feedback(tmp)
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
