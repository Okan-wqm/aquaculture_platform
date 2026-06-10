"""Plan 022 H-5 — SHADOW raw findings sampling CLI + governance event.

Pre-Plan-022 SHADOW tools emitted empty operator-facing
observations/findings (tool_runner.py:139-141). raw_findings landed
in the ledger but operators never saw them; sampling logic to
surface high-volume SHADOW signal didn't exist.

Fix: aria_kernel.agent_eval.sample_shadow_raw_findings reads the
last 24h of runs.jsonl, aggregates per SHADOW tool, emits
shadow_findings_sampled governance events, and escalates via
human_required_recorded when count >= threshold_24h (default 5).

Tests:
1. SHADOW tool with raw_findings >= threshold -> sample event +
   human_required_recorded escalation.
2. SHADOW tool with raw_findings < threshold -> sample event only,
   no escalation.
3. ACTIVE tool runs skipped (don't double-surface).
4. Old runs (>24h) excluded from the 24h window.
"""
from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from aria_kernel.agent_eval import (
    SHADOW_SAMPLE_THRESHOLD_24H,
    add_fixture,
    sample_shadow_raw_findings,
)
from aria_kernel.evidence_trust import recompute_artifact_hash
from aria_kernel.ledger import append_jsonl
from aria_kernel.tool_health import runs_path
from aria_kernel.tool_registry import (
    ensure_tools_dir,
    register_tool,
    utc_now,
)
from tests._helpers.context_binding import sha256_text


def _seed_tools(name: str = "aria-h5-") -> Path:
    tmp = Path(tempfile.mkdtemp(prefix=name))
    tools = tmp / "aria-tools"
    ensure_tools_dir(tools)
    return tools


def _manifest(*, tool_id: str, status: str = "SHADOW") -> dict:
    return {
        "tool_id": tool_id,
        "kind": "adapter",
        "version": "0.1.0",
        "status": status,
        "declared_scope": ["**/*.ts"],
        "output_schema": {"type": "object", "required": ["observations", "findings", "read_paths", "evidence_sources"]},
        "fixture_set": "tools/aria-poc/fixtures/x",
        "health_thresholds": {"precision_min": 0.85, "non_critical_false_positives_30d": 3, "critical_false_positives": 0, "crash_rate_last_10": 0.2},
        "allowed_read_globs": ["**/*.ts"],
        "forbidden_read_globs": [".git/**"],
        "claim_types": ["x"],
        "owner": "platform",
        "schema_version": 2,
        "runner": {"type": "subprocess", "argv": ["python3", "x.py"], "cwd": ".", "timeout_ms": 60000, "stdin_json": True},
    }


def _fixture_id(tool_id: str) -> str:
    return "F999_" + tool_id.replace("-", "_").upper()


def _input_envelope(tool_id: str) -> dict:
    request_id = f"shadow-request-{tool_id}"
    return {
        "claim_summary": f"shadow fixture for {tool_id}",
        "request_id": request_id,
        "context_hash": sha256_text(f"context:{request_id}"),
        "prompt_hash": sha256_text(f"prompt:{request_id}"),
    }


def _artifact_ref(tools: Path, *, name: str, payload: str) -> dict:
    path = tools / "evidence" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(payload, encoding="utf-8")
    return {
        "artifact_id": f"artifact-{name}",
        "source_surface": "runtime_artifact",
        "uri": f"evidence/{name}",
        "sha256": recompute_artifact_hash(path),
        "content_type": "application/json",
        "produced_by_workflow_run_id": "run-shadow-sample",
    }


def _seed_shadow_provenance(tools: Path, *, tool_id: str) -> dict:
    fixture = add_fixture(
        fixture={
            "fixture_id": _fixture_id(tool_id),
            "target_agent": tool_id,
            "role": "shadow_eval",
            "pinned_commit_sha": "cabbfc038",
            "input_envelope": _input_envelope(tool_id),
            "expected_verdict_class": "PASS",
            "expected_evidence_refs": [f"src/{tool_id}.ts:1"],
            "max_rounds": 1,
            "max_tokens": 1000,
        },
        base_dir=tools,
    )
    request_id = fixture["input_envelope"]["request_id"]
    claim_id = f"claim-{request_id}"
    transcript_ref = _artifact_ref(
        tools,
        name=f"{request_id}.transcript.json",
        payload='{"transcript":"shadow"}\n',
    )
    transcript_row = append_jsonl(
        tools / "agent-invocations" / "transcripts.jsonl",
        {
            "schema_version": 1,
            "recorded_at": utc_now(),
            "invocation_id": request_id,
            "request_id": request_id,
            "claim_id": claim_id,
            "agent_id": "shadow-agent",
            "transcript_hash": transcript_ref["sha256"],
            "artifact_ref": transcript_ref,
        },
    )
    operator_row = append_jsonl(
        tools / "governance.jsonl",
        {
            "schema_version": 1,
            "kind": "operator_approval",
            "operator_id": "operator-shadow",
            "approved_action": "shadow_eval",
            "request_id": request_id,
            "claim_id": claim_id,
            "target_agent": tool_id,
            "expires_at": "2999-06-05T00:00:00Z",
        },
    )
    return {
        "operator_approval_ref": {
            "ledger_path": "governance.jsonl",
            "ledger_hash": operator_row["ledger_hash"],
        },
        "fixture_id": fixture["fixture_id"],
        "fixture_hash": fixture["fixture_hash"],
        "context_hash": fixture["input_envelope"]["context_hash"],
        "prompt_hash": fixture["input_envelope"]["prompt_hash"],
        "transcript_hash": transcript_ref["sha256"],
        "transcript_ledger_hash": transcript_row["ledger_hash"],
    }


def _seed_run(tools: Path, *, tool_id: str, raw_count: int, ts: datetime | None = None) -> None:
    when = (ts or datetime.now(timezone.utc)).isoformat()
    append_jsonl(
        runs_path(tools),
        {
            "schema_version": 1,
            "run_id": f"r-{tool_id}-{when}",
            "tool_id": tool_id,
            "cycle_id": "cyc-h5",
            "status": "ok",
            "recorded_at": when,
            "runner": {"raw_findings_count": raw_count, "raw_observations_count": 0},
            "shadow_provenance": _seed_shadow_provenance(tools, tool_id=tool_id),
        },
    )


class _ShadowSamplingTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tools = _seed_tools()

    def tearDown(self) -> None:
        shutil.rmtree(self.tools.parent, ignore_errors=True)


class ShadowSamplingTests(_ShadowSamplingTestCase):
    def test_shadow_tool_below_threshold_samples_no_escalation(self) -> None:
        register_tool(_manifest(tool_id="shadow-low"), base_dir=self.tools)
        _seed_run(self.tools, tool_id="shadow-low", raw_count=2)
        result = sample_shadow_raw_findings(base_dir=self.tools)
        self.assertEqual(len(result["samples"]), 1)
        self.assertEqual(result["samples"][0]["raw_findings_count_24h"], 2)
        self.assertFalse(result["samples"][0]["escalated"])
        self.assertEqual(result["escalation_count"], 0)

    def test_shadow_tool_at_threshold_escalates(self) -> None:
        register_tool(_manifest(tool_id="shadow-high"), base_dir=self.tools)
        _seed_run(self.tools, tool_id="shadow-high", raw_count=5)
        result = sample_shadow_raw_findings(base_dir=self.tools)
        self.assertTrue(result["samples"][0]["escalated"])
        self.assertEqual(result["escalation_count"], 1)
        # Verify governance event emitted.
        gov = (self.tools / "governance.jsonl").read_text(encoding="utf-8")
        kinds = [json.loads(line)["kind"] for line in gov.splitlines() if line.strip()]
        self.assertIn("shadow_findings_sampled", kinds)
        self.assertIn("human_required_recorded", kinds)

    def test_active_tool_skipped(self) -> None:
        register_tool(_manifest(tool_id="active-tool", status="DRAFT"),
                     base_dir=self.tools)
        # promote DRAFT->SANDBOX then SANDBOX->SHADOW->ACTIVE via internal helper
        from aria_kernel.tool_registry import _update_tool_internal
        _update_tool_internal("active-tool", {"status": "ACTIVE"}, base_dir=self.tools)
        _seed_run(self.tools, tool_id="active-tool", raw_count=10)
        result = sample_shadow_raw_findings(base_dir=self.tools)
        self.assertEqual(result["samples"], [],
            "ACTIVE tools must not be sampled (already emit operator-facing findings)")

    def test_old_runs_excluded_from_24h_window(self) -> None:
        register_tool(_manifest(tool_id="shadow-stale"), base_dir=self.tools)
        old = datetime.now(timezone.utc) - timedelta(hours=48)
        _seed_run(self.tools, tool_id="shadow-stale", raw_count=10, ts=old)
        result = sample_shadow_raw_findings(base_dir=self.tools)
        # Old run -> no sample emitted (no in-window data).
        self.assertEqual(result["samples"], [])

    def test_threshold_locked(self) -> None:
        self.assertEqual(SHADOW_SAMPLE_THRESHOLD_24H, 5)


if __name__ == "__main__":
    unittest.main()
