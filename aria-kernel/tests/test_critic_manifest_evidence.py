"""ARIA-HIGH-354 — the kernel hands an agent only evidence its law admits.

Measured live 2026-10-05: the F-007 plan's round-1 completeness critic was
minted with ``tools/coverage/plan-cyc-20261004T073028Z-auto-r1.json`` as its
first evidence ref. That path is the closure manifest in the state store, not
a repository file. The critic cited it, the submit law refused the result
(``agent_evidence_not_repo_verified``), and the next cycle closed the plan
HUMAN_REQUIRED (``convergence_envelope_dead:completeness_critique``).

These tests pin both halves: the mint refuses a state-store record for every
non-arbitration role, and the envelope the critic builder mints is one whose
every ref the submit law admits — the manifest by its pointer, bound to the
envelope that carries it.
"""
from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path

from aria_kernel.agent_invocations import create_agent_invocation_request
from aria_kernel.cross_review_bridge import issue_completeness_critic_envelope
from aria_kernel.evidence_validator import (
    coverage_manifest_pointer,
    state_store_record_refs,
    validate_agent_response_evidence,
)
from aria_kernel.plan_convergence import _validate_cross_review_risk
from aria_kernel.plan_coverage import build_synthetic_risk
from aria_kernel.tool_registry import GovernanceError
from aria_kernel.request_admission import admit_request
from tests._helpers.git_fixtures import make_local_git_repo

PLAN_ID = "plan-cyc-20261004T073028Z-auto"
LIVE_MANIFEST = f"tools/coverage/{PLAN_ID}-r1.json"
PAGE = "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx"
HASH = "sha256:" + "1" * 64
WAIVERS = [{"node_id": "migration:hr-service", "reason": "no schema delta"}]


class _Workspace:
    """A committed repo and, beside it, a state store whose root is named
    ``tools`` — the runner's layout (``.aria-state-store/tools``), where a
    store path and a repository path share their first segment."""

    def __init__(self, tmp: Path) -> None:
        self.repo = make_local_git_repo(tmp, name="ws")
        page = self.repo / PAGE
        page.parent.mkdir(parents=True)
        page.write_text("\n".join(f"line {i}" for i in range(1, 400)), encoding="utf-8")
        subprocess.run(["git", "add", "-A"], cwd=self.repo, check=True, capture_output=True)
        subprocess.run(["git", "commit", "-q", "-m", "page"], cwd=self.repo, check=True, capture_output=True)
        self.head = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=self.repo, text=True, capture_output=True, check=True,
        ).stdout.strip()
        self.tools = tmp / ".aria-state-store" / "tools"
        manifest = self.tools / LIVE_MANIFEST.split("/", 1)[1]
        manifest.parent.mkdir(parents=True)
        manifest.write_text("{}\n", encoding="utf-8")

    def critic_envelope(self) -> dict:
        return issue_completeness_critic_envelope(
            plan_id=PLAN_ID, round_number=1, closure_manifest_text="{}",
            closure_manifest_path=LIVE_MANIFEST, closure_manifest_hash=HASH,
            waivers=WAIVERS, evidence_refs=[f"{PAGE}:355"], allowed_scope=["web/modules/hr-module/**"],
            base_dir=self.tools, target_sha=self.head,
            admission=admit_request("convergence_drainer.plan_step", "completeness_critique", base_dir=self.tools),
        )


def _answer(refs: list[str]) -> dict:
    return {
        "evidence_refs": refs,
        "satisfaction_matrix": [{"id": "adjudicate:migration:hr-service", "evidence_refs": refs}],
    }


class MintRefusesStateStoreRecords(unittest.TestCase):
    def test_the_live_manifest_ref_is_named_a_store_record(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            ws = _Workspace(Path(tmp))
            self.assertEqual(
                state_store_record_refs([LIVE_MANIFEST, f"{PAGE}:355", "tools/aria-poc/poc.py"], store_root=ws.tools),
                [LIVE_MANIFEST],
            )

    def test_a_round_envelope_citing_the_store_is_refused_at_mint(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            ws = _Workspace(Path(tmp))
            with self.assertRaisesRegex(GovernanceError, "request_evidence_state_store_record"):
                create_agent_invocation_request(
                    target_agent="aria-completeness-critic", role="completeness_critique",
                    suggested_prompt="adjudicate", convergence_id=PLAN_ID, round_number=1,
                    must_satisfy=[{"id": "x", "description": "adjudicate", "required": True}],
                    allowed_scope=["web/modules/hr-module/**"],
                    evidence_refs=[LIVE_MANIFEST, f"{PAGE}:355"],
                    base_dir=ws.tools,
                    admission=admit_request("operator_cli.request", "completeness_critique", base_dir=ws.tools),
                )


class CriticEnvelopeIsAnswerable(unittest.TestCase):
    def test_the_manifest_rides_as_the_first_ref_by_its_pointer(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            row = _Workspace(Path(tmp)).critic_envelope()
            self.assertEqual(
                row["evidence_refs"], [f"coverage-manifest:{PLAN_ID}-r1.json", f"{PAGE}:355"],
            )

    def test_an_answer_citing_every_envelope_ref_passes_the_submit_law(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            ws = _Workspace(Path(tmp))
            row = ws.critic_envelope()
            verdict = validate_agent_response_evidence(
                response=_answer(list(row["evidence_refs"])), workspace_root=ws.repo, request=row,
            )
            self.assertEqual(verdict["errors"], [])
            self.assertTrue(verdict["valid"])

    def test_a_pointer_the_envelope_does_not_carry_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            ws = _Workspace(Path(tmp))
            row = ws.critic_envelope()
            foreign = coverage_manifest_pointer("tools/coverage/plan-other-r1.json")
            verdict = validate_agent_response_evidence(
                response=_answer([foreign, f"{PAGE}:355"]), workspace_root=ws.repo, request=row,
            )
            self.assertIn("agent_evidence_pointer_unbound", [e["code"] for e in verdict["errors"]])

    def test_the_store_path_itself_is_still_refused_by_the_submit_law(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            ws = _Workspace(Path(tmp))
            row = ws.critic_envelope()
            verdict = validate_agent_response_evidence(
                response=_answer([LIVE_MANIFEST]), workspace_root=ws.repo, request=row,
            )
            self.assertFalse(verdict["valid"])


class SyntheticRisksCiteThePointer(unittest.TestCase):
    def test_a_coverage_gap_risk_names_the_manifest_the_law_admits(self) -> None:
        risk = build_synthetic_risk(
            {"node_id": "migration:hr-service", "kind": "migration", "why": "entity changed"},
            round_number=2, closure_manifest_path=LIVE_MANIFEST,
        )
        self.assertEqual(risk["evidence_refs"], [f"coverage-manifest:{PLAN_ID}-r1.json"])
        _validate_cross_review_risk(risk)

    def test_a_malformed_manifest_name_has_no_pointer(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "coverage_manifest_name_invalid"):
            coverage_manifest_pointer("tools/coverage/../../etc/passwd")


if __name__ == "__main__":
    unittest.main()
