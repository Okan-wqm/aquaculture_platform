"""ARIA-MEDIUM-393 — runtime-signal event decay for beliefs (Plan 028
§D's third trigger family).

Age decay and head-distance decay cover time and other people's
commits. Neither covers the world moving WITHOUT a local diff: an open
runtime signal (a Sentry error, an incident lead) referencing a
belief's evidence is evidence against the belief and must re-open it.
These tests pin the transition, the normalization of free-form
code_refs, and the never-silent unmatched_refs report.
"""
from __future__ import annotations

import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from aria_kernel.memory import (
    append_jsonl,
    decay_beliefs_by_runtime_signals,
    latest_beliefs,
    load_jsonl,
)
from aria_kernel.runtime_signal_bridge import ingest_runtime_signal
from aria_kernel.tool_registry import ensure_tools_dir


def _iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


class BeliefRuntimeSignalDecayTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tools = Path(self._tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)
        self.now = datetime(2026, 10, 8, tzinfo=timezone.utc)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _seed(self, belief_id: str, evidence_refs: list[str]) -> None:
        append_jsonl(
            self.tools / "memory" / "beliefs.jsonl",
            {
                "schema_version": 2, "belief_id": belief_id,
                "claim": f"{belief_id} holds", "confidence": 0.9,
                "status": "supported", "evidence_refs": evidence_refs,
                "needs_revalidation_cycles": 0, "verified_at": _iso(self.now),
                "recorded_at": _iso(self.now), "updated_at": _iso(self.now),
                "first_seen_cycle": "c0", "support_count": 1,
            },
        )

    def _row(self, belief_id: str) -> dict:
        for b in latest_beliefs(load_jsonl(self.tools / "memory" / "beliefs.jsonl")):
            if b.get("belief_id") == belief_id:
                return b
        return {}

    def test_open_signal_referencing_evidence_reopens_the_belief(self) -> None:
        self._seed("b-hit", ["src/a.ts:1"])
        self._seed("b-miss", ["src/b.ts:1"])
        ingest_runtime_signal(
            source="sentry", service="farm-service",
            summary="500 spike in feed allocation",
            code_refs=["src/a.ts"], base_dir=self.tools,
        )
        result = decay_beliefs_by_runtime_signals(
            cycle_id="c1", base_dir=self.tools,
        )
        self.assertEqual(result["decayed_count"], 1)
        row = self._row("b-hit")
        self.assertEqual(row.get("status"), "needs_revalidation")
        self.assertIn("runtime-signal decay", str(row.get("stale_reason")))
        self.assertEqual(self._row("b-miss").get("status"), "supported")
        self.assertEqual(result["decayed"][0]["belief_id"], "b-hit")

    def test_matching_normalizes_line_suffixes_and_dot_slash(self) -> None:
        self._seed("b-norm", ["./src/deep/mod.ts:42"])
        ingest_runtime_signal(
            source="prod_log", service="sensor-service",
            summary="decode loop stalls",
            code_refs=["src/deep/mod.ts"], base_dir=self.tools,
        )
        result = decay_beliefs_by_runtime_signals(cycle_id="c1", base_dir=self.tools)
        self.assertEqual(result["decayed_count"], 1)

    def test_glob_evidence_ref_matches_concrete_signal_ref(self) -> None:
        self._seed("b-glob", ["src/adapters/*.ts"])
        ingest_runtime_signal(
            source="incident", service="billing-service",
            summary="invoice export timeouts",
            code_refs=["src/adapters/pdf.ts"], base_dir=self.tools,
        )
        result = decay_beliefs_by_runtime_signals(cycle_id="c1", base_dir=self.tools)
        self.assertEqual(result["decayed_count"], 1)

    def test_resolved_signals_do_not_decay_and_refcounts_report(self) -> None:
        from aria_kernel.runtime_signal_bridge import resolve_runtime_signal

        self._seed("b-quiet", ["src/a.ts:1"])
        ingest_runtime_signal(
            source="sentry", service="farm-service", summary="transient",
            code_refs=["src/a.ts"], base_dir=self.tools,
        )
        rows = load_jsonl(self.tools / "runtime-signals-index.jsonl") \
            if (self.tools / "runtime-signals-index.jsonl").exists() else []
        # resolve every open signal by discovering its id from the store
        for path in sorted((self.tools / "runtime-signals").glob("*.json")):
            import json as _json
            signal_id = _json.loads(path.read_text(encoding="utf-8")).get("signal_id")
            if signal_id:
                resolve_runtime_signal(
                    signal_id=signal_id, resolution_note="test resolve",
                    base_dir=self.tools,
                )
        result = decay_beliefs_by_runtime_signals(cycle_id="c1", base_dir=self.tools)
        self.assertEqual(result["decayed_count"], 0)
        self.assertEqual(self._row("b-quiet").get("status"), "supported")

    def test_unmatched_signal_refs_are_reported_never_silent(self) -> None:
        self._seed("b-unrelated", ["src/b.ts:1"])
        ingest_runtime_signal(
            source="telemetry", service="hr-service", summary="latency",
            code_refs=["src/nowhere.ts", "src/b.ts"], base_dir=self.tools,
        )
        result = decay_beliefs_by_runtime_signals(cycle_id="c1", base_dir=self.tools)
        self.assertEqual(result["decayed_count"], 1)
        self.assertIn("src/nowhere.ts", result["unmatched_refs"])

    def test_already_needs_revalidation_belief_is_left_alone(self) -> None:
        self._seed("b-open", ["src/a.ts:1"])
        # first pass decays it
        ingest_runtime_signal(
            source="sentry", service="farm-service", summary="spike",
            code_refs=["src/a.ts"], base_dir=self.tools,
        )
        decay_beliefs_by_runtime_signals(cycle_id="c1", base_dir=self.tools)
        # second pass (new signal, same evidence) must not double-decay
        ingest_runtime_signal(
            source="incident", service="farm-service", summary="again",
            code_refs=["src/a.ts"], base_dir=self.tools,
        )
        second = decay_beliefs_by_runtime_signals(cycle_id="c2", base_dir=self.tools)
        self.assertEqual(second["decayed_count"], 0)
        self.assertEqual(self._row("b-open").get("needs_revalidation_cycles"), 1)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
