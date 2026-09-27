"""ARIA-MEDIUM-229 — a promotion gate measures the version being promoted.

`tool_health.compute_metrics` counted every judgment on the tool's ledger,
so precision stayed pinned by findings the adapter no longer emits: after
ed848c05 taught doc-staleness to leave creation markers, proposals and
asserted absences alone, its 27 false positives on those shapes still held
its precision at 0.41 against the 0.85 gate, forever — nothing could ever
judge them again, because nothing emits them.

Pinned here, on real ledgers (runs, raw findings, operator feedback):

* the scope is the findings the tool's latest ok run emitted, by
  fingerprint (the registry's version and manifest hash do not move when an
  adapter's source does, so emission is the only identity of the version in
  force);
* a false positive judged on a finding the version no longer emits does not
  count; a true positive on a fingerprint the version still emits does,
  whichever run it was judged on;
* the promotion's sample-size gate counts the scoped set too, and refuses by
  a name that says so when retired judgments are all that would satisfy it.
"""
from __future__ import annotations

import base64
import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from unittest.mock import patch

from aria_kernel import record_run, register_tool
from aria_kernel.feedback_store import (
    ANCHOR_MIN_JUDGE_COUNT,
    ANCHOR_PROMOTION_MIN_JUDGMENTS,
    finding_fingerprint,
    record_operator_feedback,
)
from aria_kernel.readiness import adapter_active_readiness
from aria_kernel.runs_reader import read_runs_rows
from aria_kernel.tool_health import compute_metrics, current_emission_scope, runs_path
from aria_kernel.tool_registry import get_tool

TOOL = "scoped-adapter"
FAKE_RUNNER = Path(__file__).resolve().parent / "_helpers" / "fake_tool_runner.py"


def _tool_definition() -> dict[str, Any]:
    return {
        "tool_id": TOOL,
        "kind": "adapter",
        "version": "1.0.0",
        "status": "SHADOW",
        "declared_scope": ["docs/**/*.md"],
        "output_schema": {"type": "object", "required": ["observations", "findings", "read_paths", "evidence_sources"]},
        "fixture_set": "fixtures/scoped-adapter",
        "health_thresholds": {"max_cost_units": 10, "precision_min": 0.85},
        "allowed_read_globs": ["docs/**/*.md"],
        "forbidden_read_globs": [],
        "claim_types": ["learning"],
        "owner": "platform",
        # Never executed: the runs below are recorded, not run. The argv is
        # the fake runner the registry's command policy admits.
        "runner": {
            "type": "subprocess",
            "argv": ["python3", FAKE_RUNNER.as_posix(), "--output-b64", base64.b64encode(json.dumps(
                {"observations": [], "findings": [], "read_paths": [], "evidence_sources": [], "cost_units": 1},
            ).encode("utf-8")).decode("ascii")],
            "cwd": ".",
            "timeout_ms": 1000,
            "stdin_json": True,
        },
        "schema_version": 1,
    }


def _finding(name: str) -> dict[str, Any]:
    return {
        "id": f"doc-staleness:missing:docs/{name}.md",
        "rule": "doc_references_missing_path",
        "path": f"docs/{name}.md",
        "message": f"docs/{name}.md references a surface that is gone",
        "evidence": [{"path": f"docs/{name}.md", "line": 1}],
    }


def _run(run_id: str, findings: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "run_id": run_id,
        "tool_id": TOOL,
        "cycle_id": f"cycle-{run_id}",
        "status": "ok",
        "input_hash": "sha256:input",
        "output_hash": "sha256:output",
        "read_paths": ["docs/a.md"],
        "emitted_observations": [],
        "emitted_findings": [],
        "evidence_validation": {"valid": True, "evidence_sources": ["docs/a.md"]},
        "operator_feedback_refs": [],
        "duration_ms": 10,
        "cost_units": 1,
        "schema_version": 1,
        "runner": {"raw_findings_count": len(findings)},
        "raw_findings": findings,
        "recorded_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
    }


class _Ledgers(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-m229-")
        self.tools = Path(self._tmp.name) / "aria-tools"
        register_tool(_tool_definition(), base_dir=self.tools)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _runs(self) -> list[dict[str, Any]]:
        return list(read_runs_rows(runs_path(self.tools), tool_id=TOOL, base_dir=self.tools))

    def _metrics(self) -> dict[str, Any]:
        return compute_metrics(get_tool(TOOL, self.tools), self._runs(), base_dir=self.tools)

    def _judge(self, run_id: str, finding: dict[str, Any], verdict: str, *, index: int = 0,
               source_type: str = "human", judges: int | None = None, fingerprint: bool = True) -> None:
        extra: dict[str, Any] = {}
        if source_type == "ai_consensus":
            extra = {
                "judge_id": "aria-consensus-arbiter", "confidence": 0.9,
                "judge_count": judges, "judges_voted": judges,
                "observers": [
                    {"judge_id": "aria-evidence-judge", "model": "claude-opus-5"},
                    {"judge_id": "aria-adversarial-judge", "model": "glm-5.3"},
                    {"judge_id": "aria-consensus-arbiter", "model": "claude-opus-5"},
                ][: judges or 0],
            }
        record_operator_feedback(
            tool_id=TOOL, run_id=run_id, finding_id=str(finding["id"]), verdict=verdict,
            severity="medium", note=f"judgment {index}", source_type=source_type,
            judgment_group_id=f"judge:{TOOL}:{finding['id']}:{index}",
            finding_fingerprint=finding_fingerprint(TOOL, finding) if fingerprint else None,
            base_dir=self.tools, **extra,
        )


class PrecisionIsScopedToTheVersionInForce(_Ledgers):
    def test_a_false_positive_on_a_finding_the_version_no_longer_emits_does_not_count(self) -> None:
        kept, retired = _finding("kept"), _finding("retired")
        record_run(_run("run-old", [kept, retired]), base_dir=self.tools)
        self._judge("run-old", kept, "true_positive")
        self._judge("run-old", retired, "false_positive", index=1)
        before = self._metrics()
        self.assertEqual(before["judged_samples"], 2)
        self.assertEqual(before["precision"], 0.5)

        # The fixed adapter no longer emits the shape it was wrong about.
        record_run(_run("run-new", [kept]), base_dir=self.tools)
        after = self._metrics()
        self.assertEqual(after["judged_samples"], 1)
        self.assertEqual(after["precision"], 1.0)
        scope = after["precision_scope"]
        self.assertEqual(scope["run_id"], "run-new")
        self.assertEqual(scope["emitted_fingerprints"], 1)
        self.assertEqual(scope["judged_retired"], 1)

    def test_a_true_positive_carried_over_on_an_unchanged_fingerprint_counts(self) -> None:
        kept = _finding("kept")
        record_run(_run("run-old", [kept]), base_dir=self.tools)
        self._judge("run-old", kept, "true_positive")
        record_run(_run("run-new", [kept, _finding("new")]), base_dir=self.tools)
        metrics = self._metrics()
        self.assertEqual(metrics["judged_samples"], 1)
        self.assertEqual(metrics["precision"], 1.0)
        self.assertEqual(metrics["precision_scope"]["judged_retired"], 0)

    def test_a_judgment_without_a_fingerprint_is_keyed_through_the_versions_own_finding_id(self) -> None:
        kept, retired = _finding("kept"), _finding("retired")
        record_run(_run("run-old", [kept, retired]), base_dir=self.tools)
        self._judge("run-old", kept, "true_positive", fingerprint=False)
        self._judge("run-old", retired, "false_positive", index=1, fingerprint=False)
        record_run(_run("run-new", [kept]), base_dir=self.tools)
        metrics = self._metrics()
        self.assertEqual((metrics["judged_samples"], metrics["precision"]), (1, 1.0))
        self.assertEqual(metrics["precision_scope"]["judged_retired"], 1)

    def test_the_scope_is_the_latest_ok_run(self) -> None:
        kept = _finding("kept")
        record_run(_run("run-old", [kept, _finding("retired")]), base_dir=self.tools)
        record_run(_run("run-new", [kept]), base_dir=self.tools)
        failed = _run("run-crashed", [])
        failed["status"] = "crash"
        record_run(failed, base_dir=self.tools)
        scope = current_emission_scope(TOOL, self._runs(), base_dir=self.tools)
        self.assertEqual(scope.run_id, "run-new")
        self.assertEqual(scope.fingerprints, frozenset({finding_fingerprint(TOOL, kept)}))


class TheSampleSizeGateCountsTheScopedSet(_Ledgers):
    """The anchor floor applies to judgments of what the version emits."""

    def _readiness(self) -> dict[str, Any]:
        green = {"current_tool_passed": True, "fixture_baseline_passed": True, "semantic_fixture_passed": True}
        with patch("aria_kernel.readiness.latest_fixture_status", return_value=green):
            return adapter_active_readiness(TOOL, base_dir=self.tools)

    def _anchor(self, run_id: str, findings: list[dict[str, Any]], *, start: int = 0) -> None:
        for offset, finding in enumerate(findings):
            self._judge(run_id, finding, "true_positive", index=start + offset,
                        source_type="ai_consensus", judges=ANCHOR_MIN_JUDGE_COUNT)

    def test_too_few_scoped_judgments_block_by_a_name_that_says_so(self) -> None:
        current = [_finding(f"kept-{i}") for i in range(2)]
        retired = [_finding(f"retired-{i}") for i in range(ANCHOR_PROMOTION_MIN_JUDGMENTS)]
        record_run(_run("run-old", current + retired), base_dir=self.tools)
        self._anchor("run-old", current + retired)
        for index in range(5):
            record_run(_run(f"run-new-{index}", current), base_dir=self.tools)

        result = self._readiness()
        self.assertEqual(result["anchor_judged_count"], len(current))
        self.assertFalse(result["precision_anchored"])
        self.assertIn("precision_not_anchor_judged_on_current_emissions", result["blocked_by"])
        self.assertNotIn("precision_not_anchor_judged", result["blocked_by"])
        self.assertEqual(result["precision_scope"]["anchor_judged_retired"], len(retired))

    def test_enough_scoped_judgments_satisfy_the_floor(self) -> None:
        current = [_finding(f"kept-{i}") for i in range(ANCHOR_PROMOTION_MIN_JUDGMENTS)]
        record_run(_run("run-old", current), base_dir=self.tools)
        self._anchor("run-old", current)
        for index in range(5):
            record_run(_run(f"run-new-{index}", current), base_dir=self.tools)

        result = self._readiness()
        self.assertEqual(result["anchor_judged_count"], ANCHOR_PROMOTION_MIN_JUDGMENTS)
        self.assertTrue(result["precision_anchored"], result["blocked_by"])
        self.assertNotIn("precision_not_anchor_judged_on_current_emissions", result["blocked_by"])
        self.assertNotIn("precision_not_anchor_judged", result["blocked_by"])

    def test_no_judgment_at_all_keeps_the_plain_name(self) -> None:
        record_run(_run("run-old", [_finding("kept")]), base_dir=self.tools)
        result = self._readiness()
        self.assertIn("precision_not_anchor_judged", result["blocked_by"])
        self.assertNotIn("precision_not_anchor_judged_on_current_emissions", result["blocked_by"])


if __name__ == "__main__":
    unittest.main()
