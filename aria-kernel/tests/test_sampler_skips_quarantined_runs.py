"""Plan 023 v3 §C-6 — mutation-quarantined raw findings sampler exclusion.

Pre-Plan-023 record_raw_findings_for_run (feedback_store.py:54) flagged
runs with status='evidence_error' or 'scope_violation' as
'invalid_evidence' but did NOT flag runs whose runner.scope_out_mutations
list was non-empty. Plan 022 §C-5 added scope_out_mutations to the
runner envelope and fired immediate quarantine via
immediate_quarantine_reason; the raw findings the run produced still
landed in raw-findings.jsonl with status='raw' because the mapping at
line 54 didn't see the scope-out signal.

Plus sample_shadow_raw_findings (agent_eval.py:500-502) reads the
aggregate runner.raw_findings_count per run without filtering by
status. The result: an adapter that escapes its sandbox once still has
its raw findings re-enter the operator queue via the SHADOW sampler,
defeating the quarantine.

Plan 023 v3 §C-6 fix:
1. record_raw_findings_for_run extends the status mapping: a run whose
   runner.scope_out_mutations is non-empty marks every raw finding as
   invalid_evidence (alongside the existing evidence_error /
   scope_violation cases).
2. sample_shadow_raw_findings skips runs whose runner.scope_out_mutations
   is non-empty when aggregating the SHADOW raw-findings count, and
   reports the skipped count separately for operator visibility.

Tests:
1. Clean SHADOW run with raw findings → status='raw', sampler counts.
2. Scope-out-mutation SHADOW run with raw findings → status=
   'invalid_evidence', sampler does NOT count.
3. Mixed history → only clean runs counted; suspect_run_count
   reflected in sampler output.
"""
from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from pathlib import Path

from aria_kernel.agent_eval import sample_shadow_raw_findings
from aria_kernel.feedback_store import record_raw_findings_for_run, raw_findings_path
from aria_kernel.tool_health import runs_path
from aria_kernel.tool_registry import register_tool


def _make_run(
    *,
    run_id: str,
    tool_id: str = "fake",
    status: str = "ok",
    raw_findings_count: int = 1,
    scope_out_mutations: list[str] | None = None,
    recorded_at: str = "2026-05-09T00:00:00+00:00",
) -> dict:
    return {
        "schema_version": 1,
        "recorded_at": recorded_at,
        "run_id": run_id,
        "tool_id": tool_id,
        "cycle_id": f"cycle-{run_id}",
        "status": status,
        "input_hash": "sha256:in",
        "output_hash": "sha256:out",
        "read_paths": [],
        "emitted_observations": [],
        "emitted_findings": [],
        "evidence_validation": {"valid": True},
        "operator_feedback_refs": [],
        "duration_ms": 1,
        "cost_units": 0,
        "runner": {
            "raw_findings_count": raw_findings_count,
            "scope_out_mutations": scope_out_mutations or [],
            "scoped_mutations": [],
        },
    }


def _shadow_tool() -> dict:
    return {
        "tool_id": "fake",
        "kind": "adapter",
        "version": "0.1.0",
        "status": "SHADOW",
        "owner": "platform",
        "schema_version": 2,
        "claim_types": ["fake"],
        "declared_scope": ["apps/**"],
        "allowed_read_globs": ["apps/**"],
        "forbidden_read_globs": [".git/**"],
        "fixture_set": "tools/aria-poc/fixtures/fake",
        "health_thresholds": {
            "precision_min": 0.85,
            "non_critical_false_positives_30d": 3,
            "critical_false_positives": 0,
            "crash_rate_last_10": 0.2,
        },
        "output_schema": {
            "type": "object",
            "required": ["observations", "findings", "read_paths", "evidence_sources"],
        },
        "runner": {
            "type": "subprocess",
            "argv": ["python3", "fake.py"],
            "cwd": "tools/aria-poc",
            "timeout_ms": 1000,
            "stdin_json": True,
        },
    }


class RecordRawFindingsScopeOutTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-c6-"))
        self.base = self.tmp / "aria-tools"
        self.base.mkdir()

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _raw_finding_rows(self) -> list[dict]:
        path = raw_findings_path(self.base)
        if not path.exists():
            return []
        return [json.loads(line) for line in path.read_text().strip().splitlines() if line]

    def test_clean_run_records_raw_status(self) -> None:
        run = _make_run(run_id="r1", scope_out_mutations=[])
        record_raw_findings_for_run(
            run, [{"id": "finding-1"}], base_dir=self.base,
        )
        rows = self._raw_finding_rows()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["status"], "raw")

    def test_scope_out_mutation_run_records_invalid_evidence(self) -> None:
        """Pre-Plan-023 this slipped through: the run's status field was
        'ok' (subprocess returned cleanly), so the existing
        evidence_error/scope_violation check at line 54 didn't fire.
        Plan 023 §C-6: runner.scope_out_mutations non-empty also maps
        to invalid_evidence."""
        run = _make_run(
            run_id="r2",
            scope_out_mutations=[" M aria-tools/registry.json"],
        )
        record_raw_findings_for_run(
            run, [{"id": "finding-1"}], base_dir=self.base,
        )
        rows = self._raw_finding_rows()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["status"], "invalid_evidence")

    def test_evidence_error_status_still_invalid_evidence(self) -> None:
        """Regression: the existing status='evidence_error' path still
        produces invalid_evidence (Plan 022 baseline behavior)."""
        run = _make_run(run_id="r3", status="evidence_error")
        record_raw_findings_for_run(
            run, [{"id": "finding-1"}], base_dir=self.base,
        )
        rows = self._raw_finding_rows()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["status"], "invalid_evidence")


class ShadowSamplerSkipsScopeOutTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-c6-samp-"))
        self.base = self.tmp / "aria-tools"
        self.base.mkdir()
        register_tool(_shadow_tool(), base_dir=self.base)
        # Use a recent timestamp so all runs land in the 24h window.
        from datetime import datetime, timezone
        self.now_iso = datetime.now(timezone.utc).isoformat()

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _append_run(self, **kwargs) -> None:
        from tests._helpers.declared_fixtures import append_declared_fixture
        run = _make_run(recorded_at=self.now_iso, **kwargs)
        append_declared_fixture(runs_path(self.base), run, expected_surface="runs")

    def test_clean_run_counted(self) -> None:
        self._append_run(run_id="r1", raw_findings_count=3, scope_out_mutations=[])
        result = sample_shadow_raw_findings(base_dir=self.base)
        sample = next(s for s in result["samples"] if s["tool_id"] == "fake")
        self.assertEqual(sample["raw_findings_count_24h"], 3)
        self.assertEqual(sample.get("suspect_run_count_24h", 0), 0)

    def test_scope_out_run_skipped_from_count(self) -> None:
        """Plan 023 §C-6: a SHADOW run whose runner.scope_out_mutations
        is non-empty must NOT contribute its raw_findings_count to the
        operator-surfaced sample. The aggregate is operator-actionable;
        a sandbox-escape adapter's findings are a security signal, not
        a sampling source."""
        self._append_run(
            run_id="r2", raw_findings_count=5,
            scope_out_mutations=[" M aria-tools/registry.json"],
        )
        result = sample_shadow_raw_findings(base_dir=self.base)
        # No fake-tool entry should appear (raw_findings excluded) OR
        # if present, its count is 0 and suspect_run_count_24h reflects
        # the skip.
        sample = next((s for s in result["samples"] if s["tool_id"] == "fake"), None)
        if sample is not None:
            self.assertEqual(sample["raw_findings_count_24h"], 0)
            self.assertEqual(sample["suspect_run_count_24h"], 1)

    def test_mixed_history_only_clean_counted(self) -> None:
        """3 clean runs + 2 scope-out runs → count = sum(clean), suspect
        = 2."""
        self._append_run(run_id="r1", raw_findings_count=2, scope_out_mutations=[])
        self._append_run(run_id="r2", raw_findings_count=3, scope_out_mutations=[])
        self._append_run(
            run_id="r3", raw_findings_count=99,
            scope_out_mutations=[" M aria-tools/governance.jsonl"],
        )
        self._append_run(run_id="r4", raw_findings_count=1, scope_out_mutations=[])
        self._append_run(
            run_id="r5", raw_findings_count=42,
            scope_out_mutations=[" M aria-tools/registry.json"],
        )
        result = sample_shadow_raw_findings(base_dir=self.base)
        sample = next(s for s in result["samples"] if s["tool_id"] == "fake")
        self.assertEqual(sample["raw_findings_count_24h"], 2 + 3 + 1)
        self.assertEqual(sample["suspect_run_count_24h"], 2)


if __name__ == "__main__":
    unittest.main()
