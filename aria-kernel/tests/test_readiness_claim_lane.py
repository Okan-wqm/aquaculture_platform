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

    def test_merge_runner_contract_matches_live_yaml(self) -> None:
        verdict = verify_workflow_contract(
            workflow_id="aria-merge-runner",
            workspace_root=_REPO,
        )
        self.assertTrue(verdict.valid, verdict.reasons)


class MergeRunnerLaneTests(unittest.TestCase):
    """ARIA-HIGH-198 — the merge lane runs where it can attest what it is."""

    def setUp(self) -> None:
        import yaml  # type: ignore[import-untyped]

        path = _REPO / ".github" / "workflows" / "aria-merge-runner.yml"
        self.workflow = yaml.safe_load(path.read_text(encoding="utf-8"))
        self.job = self.workflow["jobs"]["merge"]
        self.steps = {step.get("name") or step.get("uses"): step for step in self.job["steps"]}

    def test_the_lane_runs_on_a_github_hosted_runner(self) -> None:
        # A self-hosted host is never attested ephemeral, so a merge lane
        # there is refused by construction.
        self.assertEqual(self.job["runs-on"], "ubuntu-latest")

    def test_the_lane_consumes_a_claim_another_lane_produced(self) -> None:
        # PyYAML reads the bare `on` key as boolean True.
        trigger = self.workflow[True]
        self.assertIn("aria-readiness-claim", trigger["workflow_run"]["workflows"])
        self.assertEqual(trigger["workflow_run"]["types"], ["completed"])
        self.assertIn("workflow_dispatch", trigger)

    # ARIA-HIGH-206 — three of the four required checks come from
    # ci-affected.yml, which routinely finishes AFTER the readiness claim.
    # A merge attempt that saw them missing was never retried: nothing
    # re-ran the lane until an unrelated event did.
    def test_the_lane_reevaluates_when_ci_affected_completes(self) -> None:
        # Tied to the NAME ci-affected.yml declares, read from that file:
        # workflow_run matches on `name:`, so a rename there would silently
        # disconnect this trigger if the literal were copied here.
        import yaml  # type: ignore[import-untyped]

        ci = yaml.safe_load((_REPO / ".github" / "workflows" / "ci-affected.yml").read_text(encoding="utf-8"))
        self.assertEqual(
            sorted(self.workflow[True]["workflow_run"]["workflows"]),
            sorted(["aria-readiness-claim", ci["name"]]),
        )
        condition = " ".join(str(self.job["if"]).split())
        # Only a green CI run of a pull request is a reason to look again;
        # a push to main or a merge-group build carries no PR to merge.
        self.assertIn(f"github.event.workflow_run.name == '{ci['name']}'", condition)
        self.assertIn("github.event.workflow_run.event == 'pull_request'", condition)
        self.assertIn("github.event.workflow_run.conclusion == 'success'", condition)

    def test_the_lane_reevaluates_hourly(self) -> None:
        # The backstop for a check that goes green with no workflow_run to
        # say so (a re-run, an external status): the lane is idempotent —
        # the merge carries --match-head-commit and needs a readiness claim
        # for that head — so a periodic re-evaluation is safe.
        crons = [entry["cron"] for entry in self.workflow[True]["schedule"]]
        self.assertEqual(len(crons), 1)
        minute, hour, *rest = crons[0].split()
        self.assertTrue(minute.isdigit() and 0 <= int(minute) < 60, crons[0])
        self.assertEqual((hour, rest), ("*", ["*", "*", "*"]), crons[0])

    def test_every_trigger_is_admitted_by_the_job_condition(self) -> None:
        condition = " ".join(str(self.job["if"]).split())
        self.assertIn("github.event_name == 'workflow_dispatch'", condition)
        self.assertIn("github.event_name == 'schedule'", condition)
        self.assertIn("github.event.workflow_run.name == 'aria-readiness-claim'", condition)

    def test_the_hourly_lane_is_watched_for_freshness(self) -> None:
        manifest = json.loads(
            (_REPO / ".github" / "manifests" / "scheduled-workflows.json").read_text(encoding="utf-8")
        )
        entry = next(
            (item for item in manifest["workflows"] if item["workflow"] == "aria-merge-runner.yml"), None,
        )
        self.assertIsNotNone(entry)
        # Hourly cron plus GitHub's measured schedule lateness (up to 75
        # minutes here, test_cycle_chain_rhythm) must not read as stale.
        self.assertGreaterEqual(entry["maxAgeHours"], 3)

    def test_the_lane_proves_its_identity_with_the_job_oidc_token(self) -> None:
        # ARIA-HIGH-220 — without id-token: write the job has no OIDC token,
        # so no attestation it recorded was ever platform-verified.
        from aria_kernel.runner_attestation import MERGE_LANE_WORKFLOW_PATH

        self.assertEqual(self.workflow["permissions"].get("id-token"), "write")
        # The identity the kernel accepts names THIS workflow file.
        self.assertTrue((_REPO / MERGE_LANE_WORKFLOW_PATH).is_file())
        self.assertEqual(
            (_REPO / MERGE_LANE_WORKFLOW_PATH).resolve(),
            (_REPO / ".github" / "workflows" / "aria-merge-runner.yml").resolve(),
        )

    def test_no_lane_start_step_attests_for_every_claim(self) -> None:
        # ARIA-HIGH-220 — the lane-start probe recorded a row per claim
        # ever made, keyed by (PR, head, claim) alone; any later run could
        # present it. The merge step attests each candidate, bound to its run.
        uses = [str(step.get("uses") or "") for step in self.job["steps"]]
        self.assertNotIn("./.github/actions/probe-runner-attestation", uses)
        self.assertNotIn("Probe runner attestation", self.steps)

    def test_the_merge_uses_the_app_token_never_github_token(self) -> None:
        # A GITHUB_TOKEN merge triggers no push workflow on main, which
        # blinds post-merge monitoring.
        step = self.steps["Run the merge lane"]
        self.assertEqual(step["env"]["ARIA_REQUIRE_MODE_A"], "true")
        self.assertNotIn("GH_TOKEN", step["env"])
        self.assertNotIn("github.token", step["run"])
        self.assertIn("mint_installation_token", step["run"])
        self.assertIn('GH_TOKEN="$MERGE_TOKEN" python3 -m aria_kernel merge-lane run', step["run"])

    def test_the_merge_token_is_minted_with_the_merge_lane_scope(self) -> None:
        # ARIA-HIGH-208 — the default mint scope has no checks, statuses or
        # issues read, which the merge gates need; the lane names the set
        # the factory defines for it rather than spelling one here.
        run = self.steps["Run the merge lane"]["run"]
        self.assertIn("MERGE_LANE_INSTALLATION_TOKEN_PERMISSIONS", run)
        self.assertIn("permissions=MERGE_LANE_INSTALLATION_TOKEN_PERMISSIONS", run)



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
        # ARIA-HIGH-218 — the published rollback bundle, as the lane's
        # `build-rollback-bundle` and `fetch-artifact` steps record it.
        from aria_kernel.readiness_proofs import fetch_published_artifact
        from tests._helpers.published_artifacts import PublishedArtifacts

        artifacts = PublishedArtifacts(repo="okan/aqua")
        artifact_id = artifacts.publish({"rollback-aaaaaaaaaaaa.bundle": b"bundle"})
        with artifacts.serve():
            record = fetch_published_artifact(
                repo="okan/aqua", artifact_id=artifact_id,
                output_dir=Path(self.tmp.name) / "rollback-artifact",
            )
        rollback_artifact = Path(self.tmp.name) / "rollback-artifact.json"
        rollback_artifact.write_text(json.dumps(record), encoding="utf-8")
        rollback_bundle = Path(self.tmp.name) / "rollback-bundle.json"
        rollback_bundle.write_text(json.dumps({
            "bundle_name": "rollback-aaaaaaaaaaaa.bundle",
            "bundle_sha256": "sha256:" + "c" * 64,
        }), encoding="utf-8")
        self.base_argv += [
            "--rollback-bundle-file", str(rollback_bundle),
            "--rollback-artifact-file", str(rollback_artifact),
        ]

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
