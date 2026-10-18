"""Plan 029 §D5 — runtime-signal bridge.

A runtime signal (Sentry/incident/telemetry) enters as an explicitly UNVERIFIED
lead, never as repo evidence, and run_pressure turns each open signal into
pressure that points ARIA at the referenced area — without corrupting the
evidence-trust foundation.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel.pressure import run_pressure
from aria_kernel.runtime_signal_bridge import (
    RUNTIME_TRUST_GRADE,
    ingest_runtime_signal,
    load_open_runtime_signals,
    resolve_runtime_signal,
)
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir


class RuntimeSignalBridgeTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tools = Path(self._tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _ingest(self) -> dict:
        return ingest_runtime_signal(
            source="sentry", service="farm-service",
            summary="NPE in batch harvest on null pond",
            code_refs=["apps/farm-service/src/harvest/harvest.service.ts:88"],
            severity="high", base_dir=self.tools,
        )

    def test_ingest_marks_unverified_lead(self) -> None:
        rec = self._ingest()
        self.assertEqual(rec["trust_grade"], RUNTIME_TRUST_GRADE)
        self.assertEqual(rec["status"], "open")
        self.assertEqual(rec["source"], "sentry")

    def test_ingest_is_idempotent(self) -> None:
        a = self._ingest()
        b = self._ingest()
        self.assertEqual(a["signal_id"], b["signal_id"])
        self.assertEqual(len(load_open_runtime_signals(base_dir=self.tools)), 1)

    def test_bad_source_and_empty_refs_rejected(self) -> None:
        with self.assertRaises(GovernanceError):
            ingest_runtime_signal(source="twitter", service="x", summary="y",
                                  code_refs=["a:1"], base_dir=self.tools)
        with self.assertRaises(GovernanceError):
            ingest_runtime_signal(source="sentry", service="x", summary="y",
                                  code_refs=[], base_dir=self.tools)

    def test_open_signal_becomes_unverified_pressure(self) -> None:
        rec = self._ingest()
        pressure = run_pressure(cycle_id="c1", base_dir=self.tools)
        runtime_pressures = [p for p in pressure["pressures"] if p["source"] == "runtime_signal"]
        self.assertEqual(len(runtime_pressures), 1)
        p = runtime_pressures[0]
        self.assertIn("apps/farm-service/src/harvest/harvest.service.ts:88", p["evidence"])
        self.assertIn("UNVERIFIED", p["recommended_action"])
        self.assertEqual(p["type"], "UNKNOWN")

    def test_resolved_signal_stops_pressure(self) -> None:
        rec = self._ingest()
        resolve_runtime_signal(signal_id=rec["signal_id"], resolution_note="fixed in PR-42",
                               base_dir=self.tools)
        self.assertEqual(load_open_runtime_signals(base_dir=self.tools), [])
        pressure = run_pressure(cycle_id="c1", base_dir=self.tools)
        self.assertEqual([p for p in pressure["pressures"] if p["source"] == "runtime_signal"], [])



class RuntimeSignalsAreAppendOnlyEventsTests(unittest.TestCase):
    """ARIA-MEDIUM-271 — a runtime observation is an append-only event bound to
    the code it concerns; resolving it adds a closing event and never rewrites
    the observation.

    At 606169730 the bridge kept one JSON file per signal and rewrote it on
    resolve: a sighting after the resolve hashed to the same file and was
    returned as the resolved record (lost), the files were no declared state
    surface (no publish carried them), and every open signal became the same
    pressure id ``pressure:runtime_signal:unknown``."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tools = Path(self._tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)

    def _ingest(self, summary: str = "NPE in batch harvest on null pond") -> dict:
        return ingest_runtime_signal(
            source="incident", service="farm-service", summary=summary,
            code_refs=["apps/farm-service/src/harvest/harvest.service.ts:88"],
            severity="high", base_dir=self.tools,
        )

    def _events(self) -> list[dict]:
        from aria_kernel.ledger import load_declared_jsonl

        return load_declared_jsonl(self.tools / "runtime-signals" / "events.jsonl",
                                   expected_surface="runtime_signal_events")

    def test_a_signal_that_recurs_after_it_was_resolved_is_open_again(self) -> None:
        first = self._ingest()
        resolve_runtime_signal(signal_id=first["signal_id"], resolution_note="fixed in PR-42", base_dir=self.tools)
        again = self._ingest()
        self.assertEqual(again["signal_id"], first["signal_id"])
        self.assertEqual(again["status"], "open")
        self.assertEqual(again["episode"], 2)
        self.assertEqual([s["signal_id"] for s in load_open_runtime_signals(base_dir=self.tools)], [first["signal_id"]])

    def test_resolving_appends_a_closing_event_and_keeps_the_observation(self) -> None:
        first = self._ingest()
        observed = self._events()
        resolve_runtime_signal(signal_id=first["signal_id"], resolution_note="fixed in PR-42", base_dir=self.tools)
        events = self._events()
        self.assertEqual(events[: len(observed)], observed, "the observation is never rewritten")
        self.assertEqual([e["event"] for e in events], ["observed", "resolved"])
        self.assertEqual(events[1]["resolution_note"], "fixed in PR-42")

    def test_repeated_sightings_of_an_open_signal_are_counted(self) -> None:
        self._ingest()
        record = self._ingest()
        self.assertEqual((record["status"], record["occurrence_count"], record["episode"]), ("open", 2, 1))
        [pressure] = [p for p in run_pressure(cycle_id="c1", base_dir=self.tools)["pressures"]
                      if p["source"] == "runtime_signal"]
        self.assertEqual(pressure["score_components"]["occurrence_count"], 2)

    def test_each_open_signal_is_its_own_pressure(self) -> None:
        one = self._ingest("NPE in batch harvest on null pond")
        two = self._ingest("timeout in feed schedule export")
        ids = sorted(p["pressure_id"] for p in run_pressure(cycle_id="c1", base_dir=self.tools)["pressures"]
                     if p["source"] == "runtime_signal")
        self.assertEqual(len(set(ids)), 2, ids)
        self.assertEqual(ids, sorted(f"pressure:runtime-signal:{s['signal_id']}" for s in (one, two)))

    def test_the_event_ledger_is_a_declared_state_surface(self) -> None:
        # The publish carries exactly the declared surfaces; the per-signal
        # files were none, so they died at every job's teardown.
        from aria_kernel.state_manifest import surface_for_relative_path

        surface = surface_for_relative_path("runtime-signals/events.jsonl")
        self.assertIsNotNone(surface)
        self.assertEqual(surface.name, "runtime_signal_events")

    def test_a_standing_signal_is_ingested_by_name_only(self) -> None:
        from aria_kernel.runtime_signal_bridge import STANDING_RUNTIME_SIGNALS, ingest_standing_runtime_signal

        record = ingest_standing_runtime_signal(name="dataflow_integrity_critical", base_dir=self.tools)
        spec = STANDING_RUNTIME_SIGNALS["dataflow_integrity_critical"]
        self.assertEqual((record["summary"], record["code_refs"], record["severity"]),
                         (spec["summary"], spec["code_refs"], "critical"))
        with self.assertRaisesRegex(GovernanceError, "runtime_signal_standing_unknown"):
            ingest_standing_runtime_signal(name="anything else", base_dir=self.tools)



class TheWatchdogSignalReachesTheCycleStoreTests(unittest.TestCase):
    """ARIA-MEDIUM-271 — the hourly dataflow watchdog ingested its CRITICAL
    signal into its own checkout's ``aria-tools`` (thrown away with the job)
    and dispatched a cycle that could not see it. The signal now travels by
    name as the dispatch's input, and the cycle ingests it into the store it
    restores and publishes, before it runs."""

    _WORKFLOWS = Path(__file__).resolve().parents[2] / ".github" / "workflows"

    def _workflow(self, name: str) -> dict:
        import yaml  # type: ignore[import-untyped]

        return yaml.safe_load((self._WORKFLOWS / name).read_text(encoding="utf-8"))

    def test_the_watchdog_writes_no_store_and_names_the_signal_in_its_dispatch(self) -> None:
        steps = self._workflow("dataflow-integrity-watchdog.yml")["jobs"]["probe"]["steps"]
        runs = "\n".join(str(step.get("run") or "") for step in steps)
        self.assertNotIn("aria_kernel", runs, "the watchdog's checkout is thrown away with its job")
        self.assertIn("gh workflow run aria-auto-cycle.yml -f runtime_signal=dataflow_integrity_critical", runs)

    def test_the_cycle_ingests_a_named_standing_signal_into_its_store_before_it_runs(self) -> None:
        from aria_kernel.runtime_signal_bridge import STANDING_RUNTIME_SIGNALS

        cycle = self._workflow("aria-auto-cycle.yml")
        triggers = cycle.get("on", cycle.get(True))  # PyYAML reads the `on` key as True
        spec = triggers["workflow_dispatch"]["inputs"]["runtime_signal"]
        self.assertEqual((spec["type"], spec["default"]), ("choice", "none"))
        self.assertEqual(set(spec["options"]) - {"none"}, set(STANDING_RUNTIME_SIGNALS))
        [job] = [job for job in cycle["jobs"].values()
                 if any("Run the nightly cycle" in str(step.get("name")) for step in job.get("steps", []))]
        names = [str(step.get("name")) for step in job["steps"]]
        ingest = next(i for i, step in enumerate(job["steps"]) if "runtime signal ingest-standing" in str(step.get("run")))
        self.assertLess(names.index("Restore ARIA state from the aria/state branch"), ingest)
        self.assertLess(ingest, next(i for i, name in enumerate(names) if name.startswith("Run the nightly cycle")))
        step = job["steps"][ingest]
        self.assertIn('--tools-dir "$ARIA_TOOLS_DIR"', step["run"])
        self.assertEqual(step["env"]["RUNTIME_SIGNAL"], "${{ github.event.inputs.runtime_signal }}")
        self.assertIn("(github.event.inputs.runtime_signal || 'none') != 'none'", step["if"])


class RuntimeSignalRefLawTests(unittest.TestCase):
    """ARIA-MEDIUM-394 review — the bridge is the one door (CLI, MCP, SARIF,
    packs, gateway and the importer all call it), so the ref, text and
    severity law holds HERE; outside-authored text cannot reach the record
    or the matchers that read it without passing it."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tools = Path(self._tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)

    def _ingest(self, **overrides) -> dict:
        kwargs = dict(source="operator", service="farm-service", summary="lead",
                      code_refs=["apps/farm-service/src/feed.ts"], severity="high", base_dir=self.tools)
        kwargs.update(overrides)
        return ingest_runtime_signal(**kwargs)

    def test_escaping_glob_control_and_prose_refs_are_refused(self) -> None:
        cases = {
            "../../../../etc/passwd": "agent_evidence_path_escapes_workspace",
            "apps/../../../root/.ssh/id_rsa": "agent_evidence_path_escapes_workspace",
            "apps/x/../feed.ts": "agent_evidence_path_escapes_workspace",
            "/etc/passwd": "agent_evidence_path_escapes_workspace",
            "alert:../../x": "agent_evidence_path_escapes_workspace",
            "alert:/etc/passwd": "agent_evidence_path_escapes_workspace",
            "sarif:~/x": "agent_evidence_path_escapes_workspace",
            "apps/fee\u202ed.ts": "agent_evidence_path_unresolvable",
            "apps/fee\u2066d.ts": "agent_evidence_path_unresolvable",
            "*/*": "runtime_signal_ref_glob",
            "apps/[ab].ts": "runtime_signal_ref_glob",
            "apps/a?.ts": "runtime_signal_ref_glob",
            "apps/a.ts\x00": "agent_evidence_path_unresolvable",
            "apps/a.ts\x1b[31m": "agent_evidence_path_unresolvable",
            "a prose sentence": "runtime_signal_ref_whitespace",
            "human-required:HR-1": "runtime_signal_ref_ledger_pointer",
            "aria-tools/runs.jsonl": "agent_evidence_self_output",
        }
        for ref, code in cases.items():
            with self.subTest(ref=ref):
                with self.assertRaises(GovernanceError) as caught:
                    self._ingest(code_refs=[ref])
                self.assertTrue(str(caught.exception).startswith(code), str(caught.exception))
        self.assertEqual(load_open_runtime_signals(base_dir=self.tools), [])

    def test_path_refs_are_stored_canonical_with_their_line(self) -> None:
        record = self._ingest(code_refs=["./apps//farm-service/src/feed.ts:42", "apps/farm-service/src/feed.ts:42"])
        self.assertEqual(record["code_refs"], ["apps/farm-service/src/feed.ts:42"])

    def test_non_path_tokens_are_kept_verbatim(self) -> None:
        record = self._ingest(code_refs=["alert:AriaBreakerTripped", "sarif:semgrep"])
        self.assertEqual(record["code_refs"], ["alert:AriaBreakerTripped", "sarif:semgrep"])

    def test_untrusted_content_severity_is_capped_and_the_claim_kept(self) -> None:
        for source in ("sentry", "prod_log"):
            with self.subTest(source=source):
                record = self._ingest(source=source, severity="critical", summary=f"forged {source}")
                self.assertEqual(record["severity"], "high")
                self.assertEqual(record["reported_severity"], "critical")
        trusted = self._ingest(source="incident", severity="critical", summary="postmortem")
        self.assertEqual(trusted["severity"], "critical")
        self.assertNotIn("reported_severity", trusted)

    def test_text_and_ref_count_are_bounded(self) -> None:
        from aria_kernel.runtime_signal_bridge import MAX_CODE_REFS, MAX_SERVICE_CHARS, MAX_SUMMARY_CHARS

        with self.assertRaisesRegex(GovernanceError, "runtime_signal_service_too_long"):
            self._ingest(service="s" * (MAX_SERVICE_CHARS + 1))
        with self.assertRaisesRegex(GovernanceError, "runtime_signal_summary_too_long"):
            self._ingest(summary="m" * (MAX_SUMMARY_CHARS + 1))
        with self.assertRaisesRegex(GovernanceError, "runtime_signal_service_control_character"):
            self._ingest(service="farm\nservice")
        with self.assertRaisesRegex(GovernanceError, "runtime_signal_summary_control_character"):
            self._ingest(summary="beep\x07")
        for bidi in ("\u202a", "\u202e", "\u2066", "\u2069"):
            with self.assertRaisesRegex(GovernanceError, "runtime_signal_service_control_character"):
                self._ingest(service=f"farm{bidi}service")
            with self.assertRaisesRegex(GovernanceError, "runtime_signal_summary_control_character"):
                self._ingest(summary=f"looks fine{bidi} but is not")
        with self.assertRaisesRegex(GovernanceError, "runtime_signal_too_many_refs"):
            self._ingest(code_refs=[f"apps/f{i}.ts" for i in range(MAX_CODE_REFS + 1)])
        # A multi-line summary (a scanner message) is text, not an attack.
        self.assertEqual(self._ingest(summary="line one\nline two")["summary"], "line one\nline two")


if __name__ == "__main__":
    unittest.main()
