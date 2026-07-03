"""ORPHAN-312 — finding-driven plans must ground evidence in REAL code.

Live-diagnosed 2026-07-03: a leaverequest UI-drift finding (F-101) produced a
challenger envelope whose evidence_refs were `.cargo/audit.toml` etc. — the
challenger cited unverifiable files and every plan was rejected. Two defects:
the F_FINDING/ORPHAN conversions pointed evidence at the finding-doc file, and
the cycle used the git-diff synthesizer (findings ignored). This suite pins
the fix: convert_candidate_to_plan_content derives evidence_refs +
affected_surfaces from the finding's real references.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from aria_kernel.plan_synthesizer import (
    _evidence_refs_from_finding_json,
    convert_candidate_to_plan_content,
    scan_orphan_findings,
)
from aria_kernel.plan_candidate_source import PlanCandidateSource


class FFindingEvidenceTests(unittest.TestCase):
    def _write_finding(self, body: dict) -> str:
        d = tempfile.mkdtemp()
        p = Path(d) / "F-101.json"
        p.write_text(json.dumps(body), encoding="utf-8")
        return str(p)

    def test_evidence_chain_becomes_code_refs(self) -> None:
        path = self._write_finding({
            "id": "F-101",
            "evidence_chain": [
                {"reference": "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:346"},
                {"reference": "web/apps/aquamobil/src/types/index.ts:190"},
            ],
        })
        refs, affected = _evidence_refs_from_finding_json(path)
        self.assertEqual(refs, [
            "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:346",
            "web/apps/aquamobil/src/types/index.ts:190",
        ])
        self.assertEqual(affected, [
            "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx",
            "web/apps/aquamobil/src/types/index.ts",
        ])

    def test_convert_f_finding_grounds_plan_in_code_not_json(self) -> None:
        path = self._write_finding({
            "id": "F-101",
            "evidence_chain": [
                {"reference": "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:346"},
            ],
        })
        env = convert_candidate_to_plan_content({
            "source_type": PlanCandidateSource.F_FINDING.value,
            "candidate_id": "F-101",
            "path": path,
            "title_hint": "leaverequest UI drift",
        })
        self.assertIsNotNone(env)
        self.assertIn(
            "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:346",
            env.content["evidence_refs"],
        )
        self.assertIn(
            "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx",
            env.content["affected_surfaces"],
        )
        # The finding JSON must NOT be the affected surface any more.
        self.assertNotIn("aria-findings/F-101.json", env.content["affected_surfaces"])
        # Coverage gate compatibility (yesterday's work).
        self.assertEqual(env.content["schema_version"], 2)

    def test_empty_evidence_chain_falls_back_to_finding_json(self) -> None:
        path = self._write_finding({"id": "F-101", "evidence_chain": []})
        env = convert_candidate_to_plan_content({
            "source_type": PlanCandidateSource.F_FINDING.value,
            "candidate_id": "F-101", "path": path, "title_hint": "x",
        })
        self.assertEqual(env.content["evidence_refs"], ["aria-findings/F-101.json"])

    def test_missing_path_falls_back(self) -> None:
        env = convert_candidate_to_plan_content({
            "source_type": PlanCandidateSource.F_FINDING.value,
            "candidate_id": "F-101", "path": "/nonexistent/F-101.json", "title_hint": "x",
        })
        self.assertEqual(env.content["evidence_refs"], ["aria-findings/F-101.json"])

    def test_unsafe_reference_is_skipped(self) -> None:
        path = self._write_finding({
            "id": "F-101",
            "evidence_chain": [
                {"reference": "/etc/passwd:1"},
                {"reference": "../secrets.txt:2"},
                {"reference": "web/ok/File.ts:5"},
            ],
        })
        refs, affected = _evidence_refs_from_finding_json(path)
        self.assertEqual(refs, ["web/ok/File.ts:5"])


class OrphanRegistryEvidenceTests(unittest.TestCase):
    def _workspace_with_orphan(self, evidence: list | None) -> str:
        d = tempfile.mkdtemp()
        reviews = Path(d) / "docs" / "reviews"
        (reviews / "_registry").mkdir(parents=True)
        (reviews / "orphan-findings.md").write_text(
            "## ORPHAN-HIGH-501\nStatus: OPEN\nsome body\n", encoding="utf-8",
        )
        row = {"id": "ORPHAN-HIGH-501", "severity": "HIGH", "state": "OPEN"}
        if evidence is not None:
            row["evidence"] = evidence
        (reviews / "_registry" / "findings.jsonl").write_text(
            json.dumps(row) + "\n", encoding="utf-8",
        )
        return d

    def test_scan_attaches_registry_evidence(self) -> None:
        ws = self._workspace_with_orphan(["apps/hr-service/src/leave/leave.entity.ts"])
        candidates = scan_orphan_findings(ws)
        self.assertTrue(candidates)
        self.assertEqual(
            candidates[0].get("evidence"), ["apps/hr-service/src/leave/leave.entity.ts"],
        )

    def test_orphan_plan_uses_registry_evidence(self) -> None:
        env = convert_candidate_to_plan_content({
            "source_type": PlanCandidateSource.ORPHAN_FINDING.value,
            "candidate_id": "ORPHAN-HIGH-501", "severity": "HIGH", "raw_id": "501",
            "title_hint": "Address ORPHAN-HIGH-501",
            "evidence": ["apps/hr-service/src/leave/leave.entity.ts"],
        })
        self.assertEqual(
            env.content["affected_surfaces"], ["apps/hr-service/src/leave/leave.entity.ts"],
        )
        self.assertNotIn("docs/reviews/orphan-findings.md", env.content["affected_surfaces"])

    def test_orphan_without_registry_evidence_falls_back_to_doc(self) -> None:
        env = convert_candidate_to_plan_content({
            "source_type": PlanCandidateSource.ORPHAN_FINDING.value,
            "candidate_id": "ORPHAN-HIGH-501", "severity": "HIGH", "raw_id": "501",
            "title_hint": "Address ORPHAN-HIGH-501",
        })
        self.assertEqual(env.content["affected_surfaces"], ["docs/reviews/orphan-findings.md"])


if __name__ == "__main__":
    unittest.main()
