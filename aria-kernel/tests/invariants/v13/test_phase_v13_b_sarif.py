"""Plan 033 Faz 033b — SARIF ingest treats scanner output as untrusted.

Invariants:
  I-V13-SARIF-01  SARIF 2.1.0 parses to normalized leads; a non-2.1 version, a
                  non-list runs/results, or an oversized result set is quarantined
                  (SarifError), never silently dropped.
  I-V13-SARIF-02  untrusted locations are sanitized: path traversal and absolute/
                  scheme URIs are dropped to None (a finding must point inside the repo).
  I-V13-SARIF-03  source status is closed: Trivy=code-scanning, Gitleaks=artifact,
                  Snyk/CodeQL/Semgrep=not_configured; a not_configured tool is not
                  counted as a live source (no phantom clean).
  I-V13-SARIF-04  ingest emits external_scanner leads (unverified) and a malformed
                  document is quarantined via governance, returning status=quarantined.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from tests.invariants.v13 import _helpers  # noqa: F401 — sys.path

from aria_kernel.security import scanner_ingest as si
from aria_kernel.tool_registry import ensure_tools_dir


def _doc(results):
    return {"version": "2.1.0", "runs": [{"tool": {"driver": {"name": "Trivy", "rules": []}}, "results": results}]}


class SarifIngest(unittest.TestCase):
    def test_I_V13_SARIF_01_parse_and_quarantine(self) -> None:
        leads = si.parse_sarif(_doc([{"ruleId": "R1", "level": "error", "message": {"text": "m"}}]))
        self.assertEqual((leads[0].tool, leads[0].rule_id, leads[0].severity), ("trivy", "R1", "high"))
        for bad in ({"runs": []}, {"version": "1.0", "runs": []}, {"version": "2.1.0", "runs": {}},
                    {"version": "2.1.0", "runs": [{"results": "x"}]}):
            with self.assertRaises(si.SarifError):
                si.parse_sarif(bad)
        big = _doc([{"ruleId": "R", "message": {"text": "x"}}] * (si.MAX_RESULTS + 1))
        with self.assertRaises(si.SarifError):
            si.parse_sarif(big)
        # a valid empty result set is accepted (no findings is a real answer)
        self.assertEqual(si.parse_sarif(_doc([])), [])

    def test_I_V13_SARIF_02_untrusted_locations(self) -> None:
        doc = _doc([
            {"ruleId": "A", "message": {"text": "m"}, "locations": [{"physicalLocation": {"artifactLocation": {"uri": "apps/x.ts"}}}]},
            {"ruleId": "B", "message": {"text": "m"}, "locations": [{"physicalLocation": {"artifactLocation": {"uri": "../../etc/passwd"}}}]},
            {"ruleId": "C", "message": {"text": "m"}, "locations": [{"physicalLocation": {"artifactLocation": {"uri": "file:///etc/passwd"}}}]},
        ])
        leads = {lead.rule_id: lead.location for lead in si.parse_sarif(doc)}
        self.assertEqual(leads["A"], "apps/x.ts")
        self.assertIsNone(leads["B"], "path traversal dropped")
        self.assertIsNone(leads["C"], "scheme/absolute dropped")

    def test_I_V13_SARIF_03_closed_source_status(self) -> None:
        self.assertEqual(si.source_status("trivy"), "github_code_scanning")
        self.assertEqual(si.source_status("gitleaks"), "github_actions_artifact")
        for nc in ("snyk", "codeql", "semgrep", "totally-unknown"):
            self.assertEqual(si.source_status(nc), "not_configured")

    def test_I_V13_SARIF_04_ingest_and_quarantine(self) -> None:
        with tempfile.TemporaryDirectory() as t:
            tools = ensure_tools_dir(Path(t) / "tools")
            out = si.ingest_sarif(_doc([{"ruleId": "R1", "level": "error", "message": {"text": "m"}}]),
                                  service="farm-service", base_dir=tools)
            self.assertEqual((out["status"], out["ingested"]), ("ingested", 1))
            q = si.ingest_sarif({"nope": 1}, service="s", base_dir=tools)
            self.assertEqual(q["status"], "quarantined")
            gov = (tools / "governance.jsonl").read_text(encoding="utf-8")
            self.assertIn("security_sarif_quarantined", gov)


if __name__ == "__main__":
    unittest.main()
