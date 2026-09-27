"""ARIA-HIGH-220 — an attestation binds the run that acts, re-measured by that run.

The merge runner had no ``id-token: write``, so the "platform verification"
of its attestation was the mere presence of two environment variables, and
attestation rows were keyed by (PR, head, claim) only: any host's row
satisfied any other host's merge.

Now:
* the platform proof is the Actions OIDC token itself — its signature
  against GitHub's JWKS, issuer, audience and expiry — and its claims must
  name THIS run: run id, attempt, repository and runner environment;
* the merge lane is the job the token says ran
  ``.github/workflows/aria-merge-runner.yml@refs/heads/main``, GitHub-hosted;
* attestation rows carry the run id, attempt and runner name, and at the
  point of merge ``merge_pr_if_ready`` re-measures the identity in-process
  and accepts only a row recorded by the run it is running in;
* the runner executes merges only when the CLI says so AND the measured
  identity is the merge lane.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import yaml  # type: ignore[import-untyped]
from cryptography.hazmat.primitives.asymmetric import rsa

from aria_kernel.auto_merge_runners import RealAutoMergeRunner
from aria_kernel.ledger import append_declared_jsonl, load_declared_jsonl
from aria_kernel.runner_attestation import (
    MERGE_LANE,
    measure_merge_lane_identity,
    probe_runner_attestation,
    verify_runner_attestation,
)
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir
from aria_kernel.workflow_contract_registry import workflow_job_contract
from tests._helpers.actions_oidc import ActionsRun

_HEAD = "a" * 40
_CLAIM = "claim:77:aaaaaaaaaaaa"
_REPO_ROOT = Path(__file__).resolve().parents[2]


class _Store(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.tools = Path(self.tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)

    def _probe(self, **kwargs) -> dict:
        return probe_runner_attestation(
            pr_number=77, head_sha=_HEAD, readiness_claim_id=_CLAIM, repo="okan/aqua",
            target_ref="main", head_ref="feat/x", lane=MERGE_LANE, base_dir=self.tools, **kwargs,
        )

    def _verify(self) -> dict:
        return verify_runner_attestation(
            pr_number=77, head_sha=_HEAD, readiness_claim_id=_CLAIM, base_dir=self.tools,
        )


class OidcIdentityTests(unittest.TestCase):
    def test_the_merge_runner_on_main_is_the_merge_lane(self) -> None:
        run = ActionsRun()
        with run.active():
            identity = measure_merge_lane_identity()
        self.assertTrue(identity["platform_verified"], identity["reasons"])
        self.assertTrue(identity["merge_lane"], identity["reasons"])
        self.assertEqual((identity["run_id"], identity["run_attempt"]), ("4242", "1"))
        self.assertEqual(identity["runner_name"], "GitHub Actions 7")
        self.assertEqual(
            identity["oidc"]["job_workflow_ref"],
            "okan/aqua/.github/workflows/aria-merge-runner.yml@refs/heads/main",
        )

    def test_anything_else_is_not(self) -> None:
        cases = {
            "another workflow": dict(workflow_path=".github/workflows/aria-auto-cycle.yml"),
            "a branch": dict(workflow_ref="refs/heads/feature"),
            "a self-hosted runner": dict(runner_environment="self-hosted"),
        }
        for label, overrides in cases.items():
            with self.subTest(label), ActionsRun(**overrides).active():
                identity = measure_merge_lane_identity()
            self.assertFalse(identity["merge_lane"], label)

    def test_a_token_for_another_run_is_not_this_run(self) -> None:
        for claim, value in (("run_id", "9999"), ("run_attempt", "2"), ("repository", "someone/else")):
            run = ActionsRun()
            run.claim_overrides = {claim: value}
            with self.subTest(claim), run.active():
                identity = measure_merge_lane_identity()
            self.assertFalse(identity["platform_verified"], claim)
            self.assertFalse(identity["merge_lane"], claim)
            self.assertTrue(any(f"oidc_{claim}_mismatch" in reason for reason in identity["reasons"]), identity)

    def test_a_token_github_did_not_sign_is_refused(self) -> None:
        run = ActionsRun()
        forger = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        with run.active(signing_key=forger):
            identity = measure_merge_lane_identity()
        self.assertFalse(identity["platform_verified"])
        self.assertTrue(any("actions_oidc_token_invalid" in reason for reason in identity["reasons"]))

    def test_an_expired_or_misaddressed_token_is_refused(self) -> None:
        for overrides in ({"exp": 1}, {"aud": "someone-else"}, {"iss": "https://example.invalid"}):
            run = ActionsRun()
            run.claim_overrides = overrides
            with self.subTest(overrides), run.active():
                identity = measure_merge_lane_identity()
            self.assertFalse(identity["platform_verified"], overrides)

    def test_a_job_without_the_oidc_channel_is_not_verified(self) -> None:
        with patch.dict("os.environ", {"RUNNER_ENVIRONMENT": "github-hosted", "GITHUB_RUN_ID": "1",
                                       "GITHUB_RUN_ATTEMPT": "1", "RUNNER_NAME": "r", "GITHUB_REPOSITORY": "o/r",
                                       "ACTIONS_ID_TOKEN_REQUEST_URL": "", "ACTIONS_ID_TOKEN_REQUEST_TOKEN": ""}):
            identity = measure_merge_lane_identity()
        self.assertFalse(identity["platform_verified"])
        self.assertIn("actions_oidc_channel_absent", identity["reasons"])


class RunBoundAttestationTests(_Store):
    def test_the_row_names_the_run_that_recorded_it(self) -> None:
        with ActionsRun().active():
            row = self._probe()
        self.assertEqual((row["run_id"], row["run_attempt"], row["runner_id"]), ("4242", "1", "GitHub Actions 7"))
        self.assertTrue(row["platform_verified"])
        self.assertTrue(row["merge_lane_identity"])
        self.assertTrue(row["oidc"]["job_workflow_ref"].endswith("aria-merge-runner.yml@refs/heads/main"))

    def test_the_run_that_recorded_the_row_verifies_it(self) -> None:
        run = ActionsRun()
        with run.active():
            self._probe()
            verdict = self._verify()
        self.assertTrue(verdict["valid"])
        self.assertEqual(verdict["run_id"], "4242")

    def test_another_runs_row_does_not_satisfy_this_run(self) -> None:
        with ActionsRun(run_id="1111", runner_name="GitHub Actions 3").active():
            self._probe()
        for later in (ActionsRun(run_id="2222"), ActionsRun(run_id="1111", run_attempt="2"),
                      ActionsRun(run_id="1111", runner_name="GitHub Actions 9")):
            with self.subTest(run=(later.run_id, later.run_attempt, later.runner_name)), later.active():
                with self.assertRaisesRegex(GovernanceError, "runner_attestation_required_for_merge"):
                    self._verify()

    def test_a_row_written_under_the_old_key_is_not_enough(self) -> None:
        # The (PR, head, claim)-keyed row the lane-start probe used to write
        # carries no run binding; it satisfies no run.
        append_declared_jsonl(
            self.tools / "enterprise" / "runner-attestations.jsonl",
            {"schema_version": 1, "row_type": "enterprise_runner_attestation", "row_id": "legacy",
             "repo": "okan/aqua", "pr_number": 77, "target_ref": "main", "head_ref": "feat/x",
             "head_sha": _HEAD, "readiness_claim_id": _CLAIM, "runner_id": "GitHub Actions 7",
             "runner_group": "github-hosted", "ephemeral_runner": True, "approved_runner_group": True,
             "claude_auth": "not_required", "attestation_lane": "merge", "api_key_auth": False,
             "platform_verified": True},
            expected_surface="enterprise_runner_attestations",
        )
        with ActionsRun().active(), self.assertRaisesRegex(GovernanceError, "runner_attestation_required_for_merge"):
            self._verify()

    def test_the_verifier_refuses_a_host_that_is_not_the_merge_lane(self) -> None:
        with ActionsRun().active():
            self._probe()
        with ActionsRun(workflow_path=".github/workflows/aria-auto-cycle.yml").active():
            with self.assertRaisesRegex(GovernanceError, "runner_attestation_host_not_merge_lane"):
                self._verify()


class LaneStartProbeTests(_Store):
    """The agent lanes' lane-start probe: one run-bound row per claim, once."""

    def setUp(self) -> None:
        super().setUp()
        append_declared_jsonl(
            self.tools / "enterprise" / "readiness-claims.jsonl",
            {"readiness_claim_id": _CLAIM, "row_id": "claim-row", "row_type": "readiness_claim",
             "repo": "okan/aqua", "pr_number": 77, "target_ref": "main", "head_ref": "feat/x",
             "head_sha": _HEAD},
            expected_surface="enterprise_readiness_claims",
            bypass_profile_gate=True,
        )

    def _rows(self) -> list[dict]:
        path = self.tools / "enterprise" / "runner-attestations.jsonl"
        if not path.exists():
            return []
        return load_declared_jsonl(path, expected_surface="enterprise_runner_attestations")

    def test_a_claim_is_attested_once_per_lane_not_once_per_run(self) -> None:
        from aria_kernel.runner_attestation import probe_runner_attestations_for_claims

        agent_env = {"CLAUDE_CODE_OAUTH_TOKEN": "managed", "ANTHROPIC_API_KEY": ""}
        with ActionsRun(run_id="1", workflow_path=".github/workflows/aria-agent-executor.yml").active(), \
                patch.dict("os.environ", agent_env), \
                patch("aria_kernel.implementation_safety.sandbox_backend", return_value="bwrap"):
            first = probe_runner_attestations_for_claims(base_dir=self.tools, repo="okan/aqua", target_ref="main")
        self.assertEqual(first["refused"], [], first)
        self.assertEqual([row["run_id"] for row in self._rows()], ["1"])
        # A later run neither measures (no token request) nor appends: the
        # merge gate does not read these rows, so re-attesting every claim
        # every run would only grow the ledger.
        with patch("aria_kernel.runner_attestation.fetch_actions_oidc_token",
                   side_effect=AssertionError("no measurement when nothing is pending")):
            again = probe_runner_attestations_for_claims(base_dir=self.tools, repo="okan/aqua", target_ref="main")
        self.assertEqual([row["already_attested"] for row in again["attested"]], [True])
        self.assertEqual(len(self._rows()), 1)

    def test_an_agent_lane_row_never_satisfies_the_merge_gate(self) -> None:
        from aria_kernel.runner_attestation import probe_runner_attestations_for_claims

        run = ActionsRun()
        with run.active(), patch.dict("os.environ", {"CLAUDE_CODE_OAUTH_TOKEN": "managed", "ANTHROPIC_API_KEY": ""}), \
                patch("aria_kernel.implementation_safety.sandbox_backend", return_value="bwrap"):
            probe_runner_attestations_for_claims(base_dir=self.tools, repo="okan/aqua", target_ref="main")
            self.assertEqual([row["attestation_lane"] for row in self._rows()], ["agent"])
            with self.assertRaisesRegex(GovernanceError, "runner_attestation_required_for_merge"):
                self._verify()


class RunnerExecutesOnlyAsTheMergeLaneTests(_Store):
    def _runner(self, calls: list) -> RealAutoMergeRunner:
        def authority(**kwargs):
            calls.append(("authority", kwargs["pr_number"]))
            return {"decision": "blocked", "eligible": False, "pr_number": kwargs["pr_number"], "reasons": []}

        self._authority = patch("aria_kernel.merge_authority.merge_pr_if_ready", side_effect=authority)
        self._authority.start()
        self.addCleanup(self._authority.stop)
        self._evaluation = patch(
            "aria_kernel.auto_merge.merge_if_green",
            side_effect=lambda **kwargs: calls.append(("dry", kwargs["pr_number"])) or {"decision": "blocked"},
        )
        self._evaluation.start()
        self.addCleanup(self._evaluation.stop)
        for target, value in (
            ("aria_kernel.runtime_profile.merge_authority_available", True),
            ("aria_kernel.watchdog_freeze.open_watchdog_incidents", {"readable": True, "incidents": [], "reason": "clear"}),
        ):
            item = patch(target, return_value=value)
            item.start()
            self.addCleanup(item.stop)
        append_declared_jsonl(
            self.tools / "enterprise" / "readiness-claims.jsonl",
            {"readiness_claim_id": _CLAIM, "row_id": "claim-row", "row_type": "readiness_claim",
             "repo": "okan/aqua", "pr_number": 77, "target_ref": "main", "head_ref": "feat/x",
             "head_sha": _HEAD},
            expected_surface="enterprise_readiness_claims",
            bypass_profile_gate=True,
        )
        return RealAutoMergeRunner(
            profile="strict", executes_merges=True, adapter_factory=lambda: object(),
            pr_enumerator=lambda adapter: [77],
            readiness_claim_resolver=lambda adapter, number, root: _CLAIM,
        )

    def test_the_merge_lane_attests_each_candidate_then_merges(self) -> None:
        calls: list = []
        runner = self._runner(calls)
        with ActionsRun().active():
            result = runner(base_dir=self.tools, workspace_root=None)
        self.assertFalse(result["dry_run"])
        self.assertTrue(result["merge_lane_identity"]["verified"])
        self.assertEqual(calls, [("authority", 77)])
        rows = load_declared_jsonl(
            self.tools / "enterprise" / "runner-attestations.jsonl",
            expected_surface="enterprise_runner_attestations",
        )
        self.assertEqual([(row["pr_number"], row["run_id"]) for row in rows], [(77, "4242")])

    def test_a_host_that_is_not_the_merge_lane_only_evaluates(self) -> None:
        calls: list = []
        runner = self._runner(calls)
        with ActionsRun(runner_environment="self-hosted").active():
            result = runner(base_dir=self.tools, workspace_root=None)
        self.assertTrue(result["dry_run"])
        self.assertFalse(result["merge_lane_identity"]["verified"])
        self.assertEqual(calls, [("dry", 77)])
        self.assertFalse((self.tools / "enterprise" / "runner-attestations.jsonl").exists())


class LaneWiringTests(unittest.TestCase):
    def test_the_merge_runner_can_request_its_oidc_token(self) -> None:
        workflow = yaml.safe_load(
            (_REPO_ROOT / ".github" / "workflows" / "aria-merge-runner.yml").read_text(encoding="utf-8"),
        )
        self.assertEqual(workflow["permissions"]["id-token"], "write")
        job = workflow_job_contract("aria-merge-runner", "merge")
        self.assertIn(("id-token", "write"), job.required_permissions)

    def test_the_merge_lane_no_longer_attests_every_claim_at_lane_start(self) -> None:
        workflow = yaml.safe_load(
            (_REPO_ROOT / ".github" / "workflows" / "aria-merge-runner.yml").read_text(encoding="utf-8"),
        )
        names = [step.get("name") for step in workflow["jobs"]["merge"]["steps"]]
        self.assertNotIn("Probe runner attestation", names)


if __name__ == "__main__":
    unittest.main()
