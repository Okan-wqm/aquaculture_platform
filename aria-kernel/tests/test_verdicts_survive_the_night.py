"""ORPHAN-668 — the learning wheel's verdicts survive the night.

The operator-feedback, judgment-sample, calibration, reflection,
capability-gap, proactive-priority, problem-cluster, task-candidate and
genesis request-status ledgers were written with the hash-chained §A.1
primitive but were invisible to ``iter_surfaces()`` — the aria/state
publish never carried them, so every night's verdicts and calibration
died at job teardown: auto-promotion (C7) could never accumulate
precision_history, and yesterday's false-positive verdicts could not
stop tomorrow's repeat findings. These tests pin the roster, the
declared-write discipline of every migrated writer, and the snapshot
carry policy.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel.feedback_store import append_jsonl as feedback_append_jsonl
from aria_kernel.ledger import LedgerIntegrityError, append_jsonl as ledger_append_jsonl
from aria_kernel.state_manifest import (
    surface_for_path,
    surface_for_relative_path,
)
from aria_kernel.state_snapshot import STORAGE_POLICY
from aria_kernel.tool_registry import ensure_tools_dir

# relative publish path → declared surface name (the ORPHAN-668 roster).
_LEDGER_ROSTER: dict[str, str] = {
    "operator-feedback.jsonl": "operator_feedback",
    "judgment-samples.jsonl": "judgment_samples",
    "feedback-consensus-uncertainties.jsonl": "feedback_consensus_uncertainties",
    "operator-feedback-seeding/some-tool/raw-findings.jsonl": "operator_feedback_seeding",
    "operator-feedback-seeding/some-tool/labels.jsonl": "operator_feedback_seeding",
    "calibration/judge-calibration.jsonl": "calibration_judge",
    "calibration/adapter-calibration-reports.jsonl": "calibration_adapter_reports",
    "calibration/recommendations.jsonl": "calibration_recommendations",
    "capability-gaps/gaps.jsonl": "capability_gaps",
    "proactive/priorities.jsonl": "proactive_priorities",
    "problem_clusters.jsonl": "problem_clusters",
    "reflections.jsonl": "reflections",
    "skill-genesis/request-status.jsonl": "skill_genesis_request_status",
    "tasks/task-candidates.jsonl": "task_candidates",
}


class RosterTests(unittest.TestCase):
    def test_every_verdict_ledger_is_declared_and_carried(self) -> None:
        for rel, expected in _LEDGER_ROSTER.items():
            surface = surface_for_relative_path(rel)
            self.assertIsNotNone(surface, rel)
            self.assertEqual(surface.name, expected, rel)
            # ledger class → "carried" by the state snapshot: this is the
            # exact property whose absence killed the verdicts nightly.
            self.assertEqual(STORAGE_POLICY[surface.state_class], "carried", rel)
            self.assertEqual(surface.root_kind, "tools", rel)

    def test_identity_bound_tools_root_resolves(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
            for rel, expected in _LEDGER_ROSTER.items():
                path = root / rel
                path.parent.mkdir(parents=True, exist_ok=True)
                match = surface_for_path(path)
                self.assertIsNotNone(match, rel)
                self.assertEqual(match[0].name, expected, rel)

    def test_seeding_file_is_not_shadowed_by_raw_findings_surface(self) -> None:
        # The seeding corpus reuses the basename "raw-findings.jsonl"; the
        # exact-pattern raw_findings surface must not capture it (its base
        # candidate is the per-tool subdirectory, which carries no tools
        # identity, so the root-kind defence rejects the match).
        with tempfile.TemporaryDirectory() as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
            path = root / "operator-feedback-seeding" / "t1" / "raw-findings.jsonl"
            path.parent.mkdir(parents=True, exist_ok=True)
            match = surface_for_path(path)
        self.assertIsNotNone(match)
        self.assertEqual(match[0].name, "operator_feedback_seeding")


class DeclaredWriteDisciplineTests(unittest.TestCase):
    def test_raw_append_to_operator_feedback_is_rejected(self) -> None:
        # Deliberate-break: the ledger that carries the operator's verdicts
        # is enterprise-governed now; the legacy raw append must refuse.
        with tempfile.TemporaryDirectory() as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
            with self.assertRaises(LedgerIntegrityError) as ctx:
                ledger_append_jsonl(
                    root / "operator-feedback.jsonl",
                    {"schema_version": 1, "verdict": "false_positive"},
                )
        self.assertIn("raw_jsonl_declared_surface_rejected", str(ctx.exception))

    def test_feedback_store_routes_every_known_filename_declared(self) -> None:
        # The store-level primitive is the single write path for the
        # feedback family; a routed append must land with the declared
        # envelope (ledger_hash) rather than raising or writing raw.
        with tempfile.TemporaryDirectory() as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
            path = root / "operator-feedback.jsonl"
            feedback_append_jsonl(path, {"schema_version": 1, "verdict": "confirmed"})
            row = path.read_text(encoding="utf-8").strip().splitlines()[-1]
        self.assertIn("ledger_hash", row)

    def test_migrated_direct_writer_produces_declared_row(self) -> None:
        # Representative direct-migration writer (genesis request status):
        # the append must pass the declared-surface assert and leave a
        # hash-chained row behind — proof the migration did not break the
        # writer while making its ledger publishable.
        from aria_kernel.skill_genesis_drainer import _persist_status

        with tempfile.TemporaryDirectory() as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
            _persist_status("req-668", "drained", root, "test")
            status_path = root / "skill-genesis" / "request-status.jsonl"
            self.assertIn("ledger_hash", status_path.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
