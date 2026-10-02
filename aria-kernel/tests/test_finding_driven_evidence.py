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

from aria_kernel.finding_grounding import refs_from_finding_record
from aria_kernel.plan_synthesizer import (
    convert_candidate_to_plan_content,
    scan_orphan_findings,
)
from aria_kernel.plan_candidate_source import PlanCandidateSource


class FFindingEvidenceTests(unittest.TestCase):
    def test_evidence_chain_becomes_code_refs(self) -> None:
        # ADR-0018 D5 (review round 2) — refs are read from the fold RECORD,
        # both shapes through one trust filter; the JSON file is not read.
        refs = refs_from_finding_record({
            "id": "F-101",
            "evidence_chain": [
                {"reference": "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:346"},
                {"reference": "web/apps/aquamobil/src/types/index.ts:190"},
                {"reference": "apps/x/self.ts:1", "trust_grade": "self_output"},
            ],
        })
        self.assertEqual(refs, [
            "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:346",
            "web/apps/aquamobil/src/types/index.ts:190",
        ])

    # ADR-0018 D5 — an F_FINDING candidate converts only on the shared
    # admission (OPEN in the fold, refs tracked in the checkout, a writable
    # surface), so the conversion pins below run against a real checkout.
    def _checkout(self) -> "OperatorRequestFixture":
        import os
        from unittest import mock

        from tests._helpers.operator_requests import OperatorRequestFixture

        tmp = tempfile.TemporaryDirectory(prefix="aria-fde-")
        self.addCleanup(tmp.cleanup)
        env = {k: v for k, v in os.environ.items() if k != "ARIA_REPO_STATE_ROOT"}
        patcher = mock.patch.dict(os.environ, env, clear=True)
        patcher.start()
        self.addCleanup(patcher.stop)
        fixture = OperatorRequestFixture(Path(tmp.name))
        fixture.commit_files({
            "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx": "x\n",
            "apps/admin-api-service/src/settings/services/tenant-configuration.service.ts": "x\n",
            "docs/reviews/claude/2026-07-20-admin-panel-e2e-audit/findings/tenant-config.md": "x\n",
        })
        return fixture

    def _convert(self, fixture, finding_id: str):
        from aria_kernel.finding_grounding import admit_candidate, load_grounding_context

        candidate = {"source_type": PlanCandidateSource.F_FINDING.value, "candidate_id": finding_id,
                     "title_hint": "leaverequest UI drift"}
        return convert_candidate_to_plan_content(
            candidate, admission=admit_candidate(candidate, load_grounding_context(fixture.repo)),
        )

    def test_convert_f_finding_grounds_plan_in_code_not_json(self) -> None:
        fixture = self._checkout()
        fixture.seed_finding("F-101", refs=[], body={"evidence_chain": [
            {"reference": "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:346"},
        ], "evidences": []})
        env = self._convert(fixture, "F-101")
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

    def test_empty_evidence_chain_is_not_converted(self) -> None:
        # ARIA-HIGH-181 — no code reference, no plan: the finding JSON is
        # self-output (evidence_trust.SELF_OUTPUT_PREFIXES) and gitignored,
        # so a plan minted on it could never be answered.
        from aria_kernel.finding_grounding import (
            FINDING_EVIDENCE_UNAVAILABLE, admit_finding, load_grounding_context,
        )

        fixture = self._checkout()
        fixture.seed_finding("F-101", refs=[], body={"evidence_chain": [], "evidences": []})
        self.assertEqual(admit_finding(load_grounding_context(fixture.repo), "F-101").reason,
                         FINDING_EVIDENCE_UNAVAILABLE)
        self.assertIsNone(self._convert(fixture, "F-101"))

    def test_missing_path_is_not_converted(self) -> None:
        env = convert_candidate_to_plan_content({
            "source_type": PlanCandidateSource.F_FINDING.value,
            "candidate_id": "F-101", "path": "/nonexistent/F-101.json", "title_hint": "x",
        })
        self.assertIsNone(env)

    def test_a_consensus_promoted_finding_converts_on_its_evidences(self) -> None:
        # ARIA-HIGH-183 — the aria/finding/v1 shape the consensus promotion
        # emits carries its code references in `evidences[].evidence_envelope`
        # (canonical_ref + line, trust_grade), not `evidence_chain`: the first
        # five findings the live ring promoted converted to nothing.
        fixture = self._checkout()
        fixture.seed_finding("F-013", refs=[], body={"evidences": [
            {"ref": "docs/reviews/claude/2026-07-20-admin-panel-e2e-audit/findings/tenant-config.md",
             "evidence_envelope": {"canonical_ref": "docs/reviews/claude/2026-07-20-admin-panel-e2e-audit/findings/tenant-config.md",
                                   "line": 150, "trust_grade": "repo_verified", "self_output_class": None}},
            {"ref": "aria-findings/F-001.json",
             "evidence_envelope": {"canonical_ref": "aria-findings/F-001.json", "line": 1,
                                   "trust_grade": "self_output", "self_output_class": "finding"}},
            {"ref": "apps/admin-api-service/src/settings/services/tenant-configuration.service.ts:42",
             "evidence_envelope": {"canonical_ref": "apps/admin-api-service/src/settings/services/tenant-configuration.service.ts:42",
                                   "line": 42, "trust_grade": "repo_verified"}},
        ]})
        env = self._convert(fixture, "F-013")
        self.assertIsNotNone(env)
        self.assertEqual(env.content["evidence_refs"], [
            "docs/reviews/claude/2026-07-20-admin-panel-e2e-audit/findings/tenant-config.md:150",
            "apps/admin-api-service/src/settings/services/tenant-configuration.service.ts:42",
        ])
        self.assertNotIn("aria-findings/F-001.json", env.content["evidence_refs"], "self-output is never a ground")
        self.assertIn("apps/admin-api-service/src/settings/services/tenant-configuration.service.ts", env.content["affected_surfaces"])

    def test_no_converted_plan_cites_self_output(self) -> None:
        from aria_kernel.evidence_trust import SELF_OUTPUT_PREFIXES

        fixture = self._checkout()
        fixture.seed_finding("F-101", refs=[], body={"evidence_chain": [
            {"reference": "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:346"},
            {"reference": "aria-tools/plans/events.jsonl:3"},
        ], "evidences": []})
        env = self._convert(fixture, "F-101")
        self.assertIsNotNone(env)
        for ref in env.content["evidence_refs"] + env.content["affected_surfaces"]:
            self.assertFalse(any(ref.startswith(prefix) for prefix in SELF_OUTPUT_PREFIXES), ref)

    def test_unsafe_reference_is_refused_per_ref(self) -> None:
        # Review round 2 (GSEC-LOW-008) — a ref outside the safe charset is a
        # per-ref refusal named by hash; the admission still grounds on the
        # safe one.
        from aria_kernel.finding_grounding import REF_UNSAFE, admit_finding, load_grounding_context

        fixture = self._checkout()
        fixture.seed_finding("F-101", refs=[], body={"evidences": [], "evidence_chain": [
            {"reference": "/etc/passwd:1"},
            {"reference": "../secrets.txt:2"},
            {"reference": "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:5"},
        ]})
        admission = admit_finding(load_grounding_context(fixture.repo), "F-101")
        self.assertTrue(admission.admitted, admission.reason)
        self.assertEqual(admission.evidence_refs, ("web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:5",))
        self.assertEqual([why for _ref, why in admission.refused_refs], [REF_UNSAFE, REF_UNSAFE])
        self.assertTrue(all(ref.startswith("sha256:") for ref, _why in admission.refused_refs))


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
