"""ORPHAN-HIGH-763 — the readiness-claim producer lane, tested at its seams.

The claim chain was closed by PR #1247 with a producer nothing called. These
tests pin the seams the fix added:

* both lane contracts (aria-merge-authority promoted from exclusion,
  aria-readiness-claim new) MATCH the live YAMLs — a contract that drifts
  from the YAML proves nothing about the run that just happened;
* the CLI surface exists: `readiness produce-claim` refuses, before any
  probe is touched, when the claiming run has no proven ci_workflow_run
  row — the guard that makes merge-runner self-assembly impossible by
  design;
* `readiness record-ci-report` turns a completed run payload into exactly
  the evidence row the guard demands, keyed by run id;
* the merge-runner resolver finds exactly one claim per
  (repo, target_ref, head_ref, head_sha) and refuses zero/many matches.
"""
from __future__ import annotations

import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path

from aria_kernel.cli import main as cli_main
from aria_kernel.feedback_store import append_jsonl
from aria_kernel.ledger import append_declared_jsonl
from aria_kernel.readiness_proofs import CI_WORKFLOW_RUNS_LEDGER_PATH
from aria_kernel.auto_merge_runners import resolve_readiness_claim_id_from_claims
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir
from aria_kernel.workflow_contract_registry import (
    AUDITED_WORKFLOW_EXCLUSIONS,
    WORKFLOW_CONTRACTS,
)
from aria_kernel.workflow_contracts import verify_workflow_contract

_REPO = Path(__file__).resolve().parents[2]


def _run_cli(argv: list[str]) -> int:
    """Run cli_main(argv), swallowing argparse/JSON stdout noise."""
    with contextlib.redirect_stderr(io.StringIO()), contextlib.redirect_stdout(io.StringIO()):
        return cli_main(argv) or 0


class LaneContractTests(unittest.TestCase):
    def test_merge_authority_is_contracted_not_excluded(self) -> None:
        self.assertIn("aria-merge-authority", WORKFLOW_CONTRACTS)
        self.assertNotIn("aria-merge-authority", AUDITED_WORKFLOW_EXCLUSIONS)

    def test_merge_authority_contract_matches_live_yaml(self) -> None:
        verdict = verify_workflow_contract(
            workflow_id="aria-merge-authority",
            workspace_root=_REPO,
        )
        self.assertTrue(verdict.valid, verdict.reasons)

    def test_readiness_claim_contract_matches_live_yaml(self) -> None:
        verdict = verify_workflow_contract(
            workflow_id="aria-readiness-claim",
            workspace_root=_REPO,
        )
        self.assertTrue(verdict.valid, verdict.reasons)


class ProduceClaimCliTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.tools = Path(self.tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)
        self.base_argv = [
            "readiness", "produce-claim",
            "--pr-number", "77",
            "--repo", "okan/aqua",
            "--target-ref", "main",
            "--head-ref", "feat/x",
            "--head-sha", "a" * 40,
            "--workflow-id", "aria-merge-authority",
            "--job-id", "aria-merge-authority",
            "--workflow-run-id", "123456",
            "--cycle-id", "readiness-claim-123456",
            "--workspace-root", str(self.tmp.name),
            "--tools-dir", str(self.tools),
        ]
        self.artifact = Path(self.tmp.name) / "artifact.json"
        self.artifact.write_text(json.dumps({
            "artifact_id": "artifact-1",
            "uri": "https://api.github.com/artifacts/1",
            "sha256": "sha256:" + "b" * 64,
            "content_type": "application/zip",
        }), encoding="utf-8")
        self.surfaces = Path(self.tmp.name) / "surfaces.json"
        self.surfaces.write_text(json.dumps({
            "diff": [str(Path(self.tmp.name) / "compare.patch")],
            "prompt": [str(Path(self.tmp.name) / "preflight.json")],
            "transcript": [str(Path(self.tmp.name) / "run.json")],
            "logs": [str(Path(self.tmp.name) / "pr-flat.json")],
            "artifacts": [str(Path(self.tmp.name) / "artifact.zip")],
        }), encoding="utf-8")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_refuses_when_no_ci_run_is_proven(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "readiness_claim_current_run_unproven"):
            _run_cli(self.base_argv + [
                "--artifact-file", str(self.artifact),
                "--surfaces-file", str(self.surfaces),
            ])

    def test_refuses_when_a_different_run_is_proven(self) -> None:
        """A proven row for run 999 must not authorize a claim for run 123456.

        The guard keys on the run id, not on the mere existence of evidence —
        otherwise any recorded success would vouch for any assembler.
        """
        _seed_completed_run(self.tools, workflow_run_id=999999, pr_number=77, head_sha="a" * 40)
        with self.assertRaisesRegex(GovernanceError, "readiness_claim_current_run_unproven"):
            _run_cli(self.base_argv + [
                "--artifact-file", str(self.artifact),
                "--surfaces-file", str(self.surfaces),
            ])


class RecordCiReportCliTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.tools = Path(self.tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_completed_run_payload_becomes_the_evidence_row(self) -> None:
        github = Path(self.tmp.name) / "github-payload.json"
        github.write_text(json.dumps({"workflow_runs": [{
            "id": 123456,
            "name": "aria-merge-authority",
            "head_sha": "a" * 40,
            "status": "completed",
            "conclusion": "success",
            "html_url": "https://github.com/okan/aqua/actions/runs/123456",
        }]}), encoding="utf-8")
        pr = Path(self.tmp.name) / "pr-flat.json"
        pr.write_text(json.dumps({
            "number": 77,
            "repository": "okan/aqua",
            "target_ref": "main",
            "head_ref": "feat/x",
            "head_sha": "a" * 40,
            "head": "a" * 40,
        }), encoding="utf-8")

        rc = _run_cli([
            "readiness", "record-ci-report",
            "--github-file", str(github),
            "--pr-file", str(pr),
            "--cycle-id", "readiness-claim-123456",
            "--tools-dir", str(self.tools),
        ])
        self.assertEqual(rc, 0)
        rows = [
            json.loads(line)
            for line in (self.tools / CI_WORKFLOW_RUNS_LEDGER_PATH).read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["workflow_run_id"], 123456)
        self.assertEqual(rows[0]["conclusion"], "success")
        self.assertEqual(rows[0]["row_id"], "ci-workflow-run:123456")
        self.assertEqual(rows[0]["row_type"], "ci_workflow_run")


class ResolverExactMatchTests(unittest.TestCase):
    """The consumer seam auto_merge_runners depends on (auto_merge_runners.py:217)."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.tools = Path(self.tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)
        self.claims_path = self.tools / "enterprise" / "readiness-claims.jsonl"

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _seed_claim(self, *, head_sha: str, claim_id: str) -> None:
        append_declared_jsonl(
            self.claims_path,
            {
                "recorded_at": "2026-08-20T00:00:00Z",
                "row_id": f"claim-row:{claim_id}",
                "row_type": "readiness_claim",
                "readiness_claim_id": claim_id,
                "pr_number": 77,
                "repo": "okan/aqua",
                "target_ref": "main",
                "head_ref": "feat/x",
                "head_sha": head_sha,
            },
            expected_surface="enterprise_readiness_claims",
            bypass_profile_gate=True,
        )

    def _adapter(self, head_sha: str):
        class _Adapter:
            def get_pr(self, number):
                return {
                    "number": number,
                    "repository": "okan/aqua",
                    "base_branch": "main",
                    "head_ref": "feat/x",
                    "head_sha": head_sha,
                }
        return _Adapter()

    def test_single_exact_match_resolves(self) -> None:
        self._seed_claim(head_sha="a" * 40, claim_id="claim:77:aaaaaaaaaaaa")
        self._seed_claim(head_sha="c" * 40, claim_id="claim:77:cccccccccccc")
        claim_id = resolve_readiness_claim_id_from_claims(
            self._adapter("a" * 40), pr_number=77, base_dir=self.tools,
        )
        self.assertEqual(claim_id, "claim:77:aaaaaaaaaaaa")

    def test_zero_matches_refuse(self) -> None:
        self._seed_claim(head_sha="c" * 40, claim_id="claim:77:cccccccccccc")
        with self.assertRaisesRegex(GovernanceError, "readiness_claim_exact_match_required: pr=77 matches=0"):
            resolve_readiness_claim_id_from_claims(
                self._adapter("a" * 40), pr_number=77, base_dir=self.tools,
            )

    def test_duplicate_matches_refuse(self) -> None:
        self._seed_claim(head_sha="a" * 40, claim_id="claim:77:aaaaaaaaaaaa")
        self._seed_claim(head_sha="a" * 40, claim_id="claim:77:aaaaaaaaaaaab")
        with self.assertRaisesRegex(GovernanceError, "readiness_claim_exact_match_required: pr=77 matches=2"):
            resolve_readiness_claim_id_from_claims(
                self._adapter("a" * 40), pr_number=77, base_dir=self.tools,
            )


def _seed_completed_run(
    tools: Path, *, workflow_run_id: int, pr_number: int, head_sha: str,
) -> None:
    append_declared_jsonl(
        tools / CI_WORKFLOW_RUNS_LEDGER_PATH,
        {
            "schema_version": 1,
            "recorded_at": "2026-08-20T00:00:00Z",
            "cycle_id": None,
            "pr_number": pr_number,
            "head_sha": head_sha,
            "workflow_run_id": workflow_run_id,
            "name": "aria-merge-authority",
            "status": "completed",
            "conclusion": "success",
            "row_id": f"ci-workflow-run:{workflow_run_id}",
            "row_type": "ci_workflow_run",
        },
        expected_surface="ci_workflow_runs",
        bypass_profile_gate=True,
    )


if __name__ == "__main__":
    unittest.main()
