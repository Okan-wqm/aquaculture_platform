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
        with self.assertRaisesRegex(GovernanceError, "runtime_signal_too_many_refs"):
            self._ingest(code_refs=[f"apps/f{i}.ts" for i in range(MAX_CODE_REFS + 1)])
        # A multi-line summary (a scanner message) is text, not an attack.
        self.assertEqual(self._ingest(summary="line one\nline two")["summary"], "line one\nline two")


if __name__ == "__main__":
    unittest.main()
