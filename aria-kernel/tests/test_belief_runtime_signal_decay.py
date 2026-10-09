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


    def _write_pre_law_signal(self, signal_id: str, code_refs: list[str]) -> Path:
        """A record as the bridge wrote it before it enforced the ref law."""
        import json

        path = self.tools / "runtime-signals" / f"{signal_id}.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({
            "$schema": "aria/runtime-signal/v1", "schema_version": 1, "signal_id": signal_id,
            "source": "sentry", "service": "farm-service", "summary": "forged frame",
            "code_refs": code_refs, "severity": "high", "trust_grade": "runtime_unverified",
            "status": "open", "recorded_at": "2026-10-08T00:00:00Z",
        }), encoding="utf-8")
        return path

    def test_a_pre_law_glob_record_is_withheld_by_a_pure_read(self) -> None:
        # ARIA-MEDIUM-393 review — one `*/*` frame stored before the bridge
        # refused globs would have marked every belief stale. The reader
        # withholds it and WRITES NOTHING: decay, pressure and the list verb
        # stay readers under every profile.
        from aria_kernel.runtime_signal_bridge import load_open_runtime_signals

        for belief_id in ("b-1", "b-2", "b-3"):
            self._seed(belief_id, [f"src/{belief_id}.ts:1"])
        path = self._write_pre_law_signal("runtime-00000000000000aa", ["*/*"])
        before = path.read_bytes()
        result = decay_beliefs_by_runtime_signals(cycle_id="c1", base_dir=self.tools)
        self.assertEqual(result["decayed_count"], 0)
        self.assertEqual(result["withheld_signals"], ["runtime-00000000000000aa"])
        for belief_id in ("b-1", "b-2", "b-3"):
            self.assertEqual(self._row(belief_id).get("status"), "supported")
        self.assertEqual(load_open_runtime_signals(base_dir=self.tools), [])
        self.assertEqual(path.read_bytes(), before)
        governance = self.tools / "governance.jsonl"
        self.assertNotIn("runtime_signal_quarantined", governance.read_text(encoding="utf-8") if governance.exists() else "")

    def test_the_reader_never_writes_under_a_frozen_profile(self) -> None:
        from aria_kernel.runtime_profile import set_profile
        from aria_kernel.runtime_signal_bridge import load_open_runtime_signals

        self._write_pre_law_signal("runtime-00000000000000a1", ["*/*"])
        set_profile("frozen", operator_approval_ref="op:freeze", base_dir=self.tools)
        self.assertEqual(load_open_runtime_signals(base_dir=self.tools), [])
        self.assertEqual(decay_beliefs_by_runtime_signals(cycle_id="c1", base_dir=self.tools)["decayed_count"], 0)

    def test_quarantine_moves_a_refused_record_once_governance_first(self) -> None:
        import json

        from aria_kernel.runtime_signal_bridge import quarantine_refused_runtime_signals

        path = self._write_pre_law_signal("runtime-00000000000000bb", ["../../../../etc/passwd"])
        first = quarantine_refused_runtime_signals(base_dir=self.tools)
        self.assertEqual([q["signal_id"] for q in first["quarantined"]], ["runtime-00000000000000bb"])
        record = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(record["status"], "quarantined")
        self.assertTrue(record["quarantine_reason"].startswith("agent_evidence_path_escapes_workspace"))
        second = quarantine_refused_runtime_signals(base_dir=self.tools)
        self.assertEqual(second["quarantined"], [])
        governance = (self.tools / "governance.jsonl").read_text(encoding="utf-8")
        self.assertEqual(governance.count("runtime_signal_quarantined"), 1)

    def test_quarantine_is_withheld_whole_under_a_frozen_profile(self) -> None:
        from aria_kernel.runtime_profile import set_profile
        from aria_kernel.runtime_signal_bridge import quarantine_refused_runtime_signals

        path = self._write_pre_law_signal("runtime-00000000000000cc", ["*/*"])
        before = path.read_bytes()
        set_profile("frozen", operator_approval_ref="op:freeze", base_dir=self.tools)
        result = quarantine_refused_runtime_signals(base_dir=self.tools)
        self.assertEqual(result["status"], "withheld_by_profile")
        self.assertEqual([r["signal_id"] for r in result["refused"]], ["runtime-00000000000000cc"])
        self.assertEqual(path.read_bytes(), before)

    def test_quarantine_with_nothing_refused_passes_a_frozen_profile(self) -> None:
        # Review: the gate ran unconditionally, so the decay phase raised on
        # every frozen cycle even with nothing to quarantine.
        from aria_kernel.runtime_profile import set_profile
        from aria_kernel.runtime_signal_bridge import quarantine_refused_runtime_signals

        ingest_runtime_signal(source="incident", service="s", summary="fine",
                              code_refs=["src/a.ts"], base_dir=self.tools)
        set_profile("frozen", operator_approval_ref="op:freeze", base_dir=self.tools)
        self.assertEqual(quarantine_refused_runtime_signals(base_dir=self.tools)["status"], "nothing_refused")

    def test_a_resolved_record_is_never_quarantined(self) -> None:
        import json

        from aria_kernel.runtime_signal_bridge import quarantine_refused_runtime_signals, resolve_runtime_signal

        path = self._write_pre_law_signal("runtime-00000000000000dd", ["*/*"])
        resolve_runtime_signal(signal_id="runtime-00000000000000dd", resolution_note="handled", base_dir=self.tools)
        self.assertEqual(quarantine_refused_runtime_signals(base_dir=self.tools)["quarantined"], [])
        self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["status"], "resolved")

    def test_resolve_refuses_a_signal_id_that_is_not_a_minted_id(self) -> None:
        from aria_kernel.runtime_signal_bridge import resolve_runtime_signal
        from aria_kernel.tool_registry import GovernanceError

        with self.assertRaisesRegex(GovernanceError, "runtime_signal_id_invalid"):
            resolve_runtime_signal(signal_id="../../governance", resolution_note="x", base_dir=self.tools)

    def test_a_torn_record_is_reported_not_silently_skipped(self) -> None:
        from aria_kernel.runtime_signal_bridge import scan_open_runtime_signals

        path = self.tools / "runtime-signals" / "runtime-00000000000000ee.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('{"status": "op', encoding="utf-8")
        refused = scan_open_runtime_signals(base_dir=self.tools)["refused"]
        self.assertEqual(refused[0]["signal_id"], "runtime-00000000000000ee")
        self.assertTrue(refused[0]["reason"].startswith("runtime_signal_unreadable"))

    def test_a_valid_pre_law_record_is_returned_canonical(self) -> None:
        from aria_kernel.runtime_signal_bridge import load_open_runtime_signals

        self._write_pre_law_signal("runtime-00000000000000ef", ["./src//a.ts:3"])
        [signal] = load_open_runtime_signals(base_dir=self.tools)
        self.assertEqual(signal["code_refs"], ["src/a.ts:3"])

    def test_the_matcher_never_treats_a_signal_ref_as_a_pattern(self) -> None:
        from aria_kernel.memory import _refs_touch

        self.assertFalse(_refs_touch("*/*", "src/a.ts"))
        self.assertFalse(_refs_touch("src/[ab].ts", "src/a.ts"))
        self.assertFalse(_refs_touch("src/?.ts", "src/a.ts"))
        # The adapter-emitted belief side may name a class of files, only
        # under a literal directory.
        self.assertTrue(_refs_touch("src/adapters/pdf.ts", "src/adapters/*.ts"))
        self.assertFalse(_refs_touch("src/a.ts", "*"))
        self.assertFalse(_refs_touch("src/a.ts", "*/a.ts"))
        self.assertTrue(_refs_touch("src/a.ts", "src/a.ts"))

    def test_a_glob_needs_two_literal_leading_segments(self) -> None:
        from aria_kernel.memory import _bounded_glob, _refs_touch

        self.assertFalse(_bounded_glob("apps/**"))
        self.assertFalse(_bounded_glob("apps/*/src/x.ts"))
        self.assertTrue(_bounded_glob("apps/hr-service/**"))
        self.assertTrue(_bounded_glob("src/adapters/*.ts"))
        self.assertFalse(_refs_touch("apps/hr-service/src/main.ts", "apps/**"))

    def test_double_star_is_special_only_as_a_whole_segment(self) -> None:
        from aria_kernel.memory import _refs_touch

        self.assertFalse(_refs_touch("apps/svc/bc", "apps/svc/b**/c"))
        self.assertTrue(_refs_touch("apps/svc/bX/c", "apps/svc/b**/c"))
        # `*` and `?` never cross a directory boundary.
        self.assertFalse(_refs_touch("src/adapters/x/pdf.ts", "src/adapters/*.ts"))
        self.assertFalse(_refs_touch("src/adapters/a/c", "src/adapters/a?c"))

    def test_many_double_stars_stay_fast_and_bounded(self) -> None:
        # Review: 2^k variants per pair — k=22 took 3.3 s and 664 MB.
        import time
        import tracemalloc

        from aria_kernel.memory import MAX_GLOB_SEGMENTS, _bounded_glob, _refs_touch

        over_cap = "apps/svc/" + "**/" * 30 + "x.ts"
        within_cap = "apps/svc/" + "**/x/" * ((MAX_GLOB_SEGMENTS - 3) // 2) + "y"
        long_path = "apps/svc/" + "x/" * 400 + "z"
        tracemalloc.start()
        try:
            started = time.monotonic()
            self.assertFalse(_bounded_glob(over_cap))
            self.assertFalse(_refs_touch("apps/svc/x.ts", over_cap))
            self.assertFalse(_refs_touch(long_path, within_cap))
            self.assertFalse(_refs_touch("apps/svc/" + "a" * 600, "apps/svc/" + "*a" * 60 + "b"))
            elapsed = time.monotonic() - started
            _, peak = tracemalloc.get_traced_memory()
        finally:
            tracemalloc.stop()
        self.assertLess(elapsed, 2.0)
        self.assertLess(peak, 16 * 1024 * 1024)

    def test_an_over_cap_glob_is_reported_unbounded(self) -> None:
        self._seed("b-deep", ["apps/svc/" + "**/" * 30 + "x.ts"])
        ingest_runtime_signal(source="incident", service="s", summary="x",
                              code_refs=["apps/svc/x.ts"], base_dir=self.tools, now=self.now)
        result = decay_beliefs_by_runtime_signals(cycle_id="c1", base_dir=self.tools, now=self.now)
        self.assertEqual(result["decayed_count"], 0)
        self.assertEqual(len(result["unbounded_belief_globs"]), 1)

    def test_double_star_also_matches_zero_directories(self) -> None:
        from aria_kernel.memory import _refs_touch

        pattern = "apps/hr-service/src/**/*.ts"
        self.assertTrue(_refs_touch("apps/hr-service/src/main.ts", pattern))
        self.assertTrue(_refs_touch("apps/hr-service/src/leave/leave.service.ts", pattern))
        self.assertTrue(_refs_touch("apps/hr-service/src/a/b/c.ts", pattern))
        self.assertFalse(_refs_touch("apps/farm-service/src/main.ts", pattern))

    def test_non_path_tokens_never_match_and_are_reported(self) -> None:
        # `alert:X` used to normalize to `alert`, so every alert was equal and
        # a `*` belief decayed on any of them.
        self._seed("b-star", ["*"])
        self._seed("b-alert", ["alert"])
        ingest_runtime_signal(source="incident", service="platform", summary="cpu",
                              code_refs=["alert:HighCpu"], base_dir=self.tools)
        result = decay_beliefs_by_runtime_signals(cycle_id="c1", base_dir=self.tools)
        self.assertEqual(result["decayed_count"], 0)
        self.assertEqual(result["non_path_refs"], ["alert:HighCpu"])
        self.assertEqual(result["unbounded_belief_globs"], ["*"])
        self.assertEqual(self._row("b-star").get("status"), "supported")

    def test_an_unbounded_belief_glob_is_reported_and_never_matched(self) -> None:
        self._seed("b-wild", ["*/*.ts"])
        ingest_runtime_signal(source="incident", service="s", summary="x",
                              code_refs=["src/a.ts"], base_dir=self.tools)
        result = decay_beliefs_by_runtime_signals(cycle_id="c1", base_dir=self.tools)
        self.assertEqual(result["decayed_count"], 0)
        self.assertEqual(result["unbounded_belief_globs"], ["*/*.ts"])

    def test_the_matched_pair_is_recorded_on_the_belief(self) -> None:
        self._seed("b-pair", ["src/adapters/*.ts"])
        ingest_runtime_signal(source="incident", service="s", summary="x",
                              code_refs=["src/adapters/pdf.ts:9"], base_dir=self.tools)
        decay_beliefs_by_runtime_signals(cycle_id="c1", base_dir=self.tools)
        reason = str(self._row("b-pair").get("stale_reason"))
        self.assertIn("signal_ref=src/adapters/pdf.ts", reason)
        self.assertIn("evidence_ref=src/adapters/*.ts", reason)

    def test_a_signal_past_the_ttl_decays_nothing(self) -> None:
        from datetime import timedelta

        from aria_kernel import memory

        self._seed("b-old", ["src/a.ts"])
        record = ingest_runtime_signal(source="incident", service="s", summary="old",
                                       code_refs=["src/a.ts"], base_dir=self.tools,
                                       now=self.now - timedelta(days=memory.RUNTIME_SIGNAL_DECAY_TTL_DAYS + 1))
        result = decay_beliefs_by_runtime_signals(cycle_id="c1", base_dir=self.tools, now=self.now)
        self.assertEqual(result["decayed_count"], 0)
        self.assertEqual(result["aged_out_signals"], [record["signal_id"]])

    def test_a_future_stamped_signal_is_invalid_and_decays_nothing(self) -> None:
        from datetime import timedelta

        self._seed("b-future", ["src/a.ts"])
        record = ingest_runtime_signal(source="incident", service="s", summary="from the future",
                                       code_refs=["src/a.ts"], base_dir=self.tools,
                                       now=self.now + timedelta(hours=2))
        result = decay_beliefs_by_runtime_signals(cycle_id="c1", base_dir=self.tools, now=self.now)
        self.assertEqual(result["decayed_count"], 0)
        self.assertEqual(result["invalid_stamp_signals"], [record["signal_id"]])
        # Inside the skew allowance it is a normal, fresh signal.
        ingest_runtime_signal(source="incident", service="s", summary="slight skew",
                              code_refs=["src/a.ts"], base_dir=self.tools,
                              now=self.now + timedelta(minutes=30))
        self.assertEqual(decay_beliefs_by_runtime_signals(cycle_id="c2", base_dir=self.tools,
                                                          now=self.now)["decayed_count"], 1)

    def _resupport(self, belief_id: str, evidence_refs: list[str]) -> None:
        """What an adapter does every cycle: a fresh supported row, no decay stamp."""
        self._seed(belief_id, evidence_refs)

    def test_the_caps_rotate_through_every_belief_instead_of_starving_the_tail(self) -> None:
        from unittest import mock

        from aria_kernel import memory

        ids = [f"b{index:02d}" for index in range(5)]
        for belief_id in ids:
            self._seed(belief_id, ["src/shared.ts"])
        ingest_runtime_signal(source="incident", service="s", summary="shared",
                              code_refs=["src/shared.ts"], base_dir=self.tools, now=self.now)
        seen: set[str] = set()
        with mock.patch.object(memory, "MAX_DECAYS_PER_SIGNAL", 2):
            for cycle in range(3):
                result = decay_beliefs_by_runtime_signals(
                    cycle_id=f"c{cycle}", base_dir=self.tools,
                    now=self.now + memory.timedelta(minutes=cycle),
                )
                seen.update(row["belief_id"] for row in result["decayed"])
                for belief_id in ids:
                    self._resupport(belief_id, ["src/shared.ts"])
        self.assertEqual(seen, set(ids))

    def test_a_capped_signal_does_not_hold_a_belief_another_signal_has_room_for(self) -> None:
        from unittest import mock

        from aria_kernel import memory

        self._seed("b-a", ["src/a.ts"])
        self._seed("b-b", ["src/a.ts", "src/b.ts"])
        ingest_runtime_signal(source="incident", service="s", summary="first",
                              code_refs=["src/a.ts"], base_dir=self.tools, now=self.now)
        ingest_runtime_signal(source="incident", service="s", summary="second",
                              code_refs=["src/b.ts"], base_dir=self.tools, now=self.now)
        with mock.patch.object(memory, "MAX_DECAYS_PER_SIGNAL", 1):
            result = decay_beliefs_by_runtime_signals(cycle_id="c1", base_dir=self.tools, now=self.now)
        self.assertEqual(sorted(row["belief_id"] for row in result["decayed"]), ["b-a", "b-b"])
        self.assertEqual(result["held_by_signal_cap"], {})

    def test_per_signal_and_per_cycle_caps_hold_back_and_report(self) -> None:
        from unittest import mock

        from aria_kernel import memory

        for index in range(5):
            self._seed(f"b-{index}", [f"src/mod{index}/a.ts"])
        wide = ingest_runtime_signal(source="incident", service="s", summary="wide",
                                     code_refs=[f"src/mod{index}/a.ts" for index in range(5)],
                                     base_dir=self.tools, now=self.now)
        with mock.patch.object(memory, "MAX_DECAYS_PER_SIGNAL", 2):
            result = decay_beliefs_by_runtime_signals(cycle_id="c1", base_dir=self.tools, now=self.now)
        self.assertEqual(result["decayed_count"], 2)
        self.assertEqual(result["held_by_signal_cap"], {wide["signal_id"]: 3})
        with mock.patch.object(memory, "MAX_RUNTIME_SIGNAL_DECAYS_PER_CYCLE", 1):
            result = decay_beliefs_by_runtime_signals(cycle_id="c2", base_dir=self.tools, now=self.now)
        self.assertEqual(result["decayed_count"], 1)
        self.assertEqual(result["held_by_cycle_cap"], 2)

if __name__ == "__main__":  # pragma: no cover
    unittest.main()
