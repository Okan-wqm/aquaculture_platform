"""The environment contract becomes enforceable (FAZ 5).

Four organs, one theme — the environment's obligations were written down and
never measured, so every environment fault was priced on the work:

1. `verify_runner_attestation` was MANDATORY at merge and NOTHING produced a
   row — the gate could only ever raise `runner_attestation_required_for_merge`.
2. The correct pre-claim shape (`preflight_claude_auth` before touching the
   queue) lived only in the dead `--consume` loop; the CI path claimed first
   and discovered the broken host after, burning a claim + requeue per
   request per broken night.
3. The daily anchor said nothing when the night could not run — a blocked
   night and an idle night rendered identically.
4. The nightly producer runs `standard`, and preflight skipped `standard`
   entirely; worse, the documented strict soft-warn sat under
   `not verdict.valid`, which is always True for non-autonomous profiles —
   the warn branch was structurally unreachable and never once fired.
"""
from __future__ import annotations

import json
import os
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from aria_kernel.ledger import append_declared_jsonl
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir

_REPO_ROOT = Path(__file__).resolve().parents[2]
_POC_DIR = _REPO_ROOT / "tools" / "aria-poc"
if str(_POC_DIR) not in sys.path:
    sys.path.insert(0, str(_POC_DIR))

import ci_executor  # noqa: E402


_HEALTHY_ENV = {
    "RUNNER_NAME": "probe-test-runner",
    "CLAUDE_CODE_OAUTH_TOKEN": "token-present",
}


def _probe(tools: Path, **overrides):
    from aria_kernel.runner_attestation import probe_runner_attestation

    kwargs = {
        "pr_number": 77,
        "head_sha": "a" * 40,
        "readiness_claim_id": "rc-77",
        "repo": "okan/aqua",
        "target_ref": "main",
        "head_ref": "feat/x",
        "runner_group": "aria-approved",
        "ephemeral_runner": True,
        "approved_runner_group": True,
        "base_dir": tools,
    }
    kwargs.update(overrides)
    return probe_runner_attestation(**kwargs)


class AttestationProducerTest(unittest.TestCase):
    def test_a_probed_row_satisfies_the_merge_gate(self) -> None:
        # The whole point: the mandatory gate finally finds a produced row.
        from aria_kernel.runner_attestation import verify_runner_attestation

        with TemporaryDirectory() as tmp:
            tools = Path(tmp) / "aria-tools"
            ensure_tools_dir(tools)
            with patch.dict(os.environ, _HEALTHY_ENV, clear=False), \
                 patch.dict(os.environ, {}, clear=False) as env, \
                 patch("aria_kernel.implementation_safety.sandbox_backend",
                       return_value="bwrap"):
                env.pop("ANTHROPIC_API_KEY", None)
                row = _probe(tools)

            verdict = verify_runner_attestation(
                pr_number=77, head_sha="a" * 40,
                readiness_claim_id="rc-77", base_dir=tools,
            )

        self.assertEqual(row["attestation_method"], "probed")
        self.assertEqual(row["probe"]["sandbox_backend"], "bwrap")
        self.assertTrue(verdict["valid"])

    def test_reprobe_is_idempotent_per_claim_triple(self) -> None:
        with TemporaryDirectory() as tmp:
            tools = Path(tmp) / "aria-tools"
            ensure_tools_dir(tools)
            with patch.dict(os.environ, _HEALTHY_ENV, clear=False), \
                 patch("aria_kernel.implementation_safety.sandbox_backend",
                       return_value="bwrap"):
                first = _probe(tools)
                second = _probe(tools)

        self.assertEqual(first["row_id"], second["row_id"])

    def test_a_host_without_a_sandbox_cannot_attest(self) -> None:
        # Refusal is the contract working: recording a lying row would
        # defeat the gate's purpose.
        with TemporaryDirectory() as tmp:
            tools = Path(tmp) / "aria-tools"
            ensure_tools_dir(tools)
            with patch.dict(os.environ, _HEALTHY_ENV, clear=False), \
                 patch("aria_kernel.implementation_safety.sandbox_backend",
                       return_value=None):
                with self.assertRaises(GovernanceError) as caught:
                    _probe(tools)

        self.assertIn("sandbox_required", str(caught.exception))

    def test_lane_start_sweep_attests_every_readiness_claim(self) -> None:
        from aria_kernel.runner_attestation import (
            probe_runner_attestations_for_claims,
        )

        with TemporaryDirectory() as tmp:
            tools = Path(tmp) / "aria-tools"
            ensure_tools_dir(tools)
            claims_path = tools / "enterprise" / "readiness-claims.jsonl"
            for pr, sha in ((1, "b" * 40), (2, "c" * 40)):
                append_declared_jsonl(
                    claims_path,
                    {
                        "pr_number": pr,
                        "head_sha": sha,
                        "readiness_claim_id": f"rc-{pr}",
                        "head_ref": f"feat/pr-{pr}",
                    },
                    expected_surface="enterprise_readiness_claims",
                )
            with patch.dict(os.environ, {
                **_HEALTHY_ENV,
                "ARIA_RUNNER_EPHEMERAL": "true",
                "ARIA_RUNNER_GROUP_APPROVED": "true",
            }, clear=False), \
                 patch("aria_kernel.implementation_safety.sandbox_backend",
                       return_value="bwrap"):
                result = probe_runner_attestations_for_claims(
                    base_dir=tools, repo="okan/aqua", target_ref="main",
                )

        self.assertEqual(result["claims_seen"], 2)
        self.assertEqual(len(result["attested"]), 2)
        self.assertEqual(result["refused"], [])


class PreClaimGateTest(unittest.TestCase):
    def _gate(self, tools: Path):
        return ci_executor._pre_claim_environment_gate(tools_dir=tools)

    def test_broken_auth_is_named_and_the_request_is_never_claimed(self) -> None:
        with TemporaryDirectory() as tmp:
            tools = Path(tmp)
            with patch.object(ci_executor, "_MOCK_MODE_AT_ENTRY", False), \
                 patch.object(ci_executor, "preflight_claude_auth",
                              side_effect=ci_executor.ClaudeAuthUnavailable("no session")), \
                 patch.object(ci_executor, "_append_tools_governance") as gov:
                kind = self._gate(tools)

        self.assertEqual(kind, "claude_auth_unavailable")
        gov.assert_called_once()
        self.assertEqual(gov.call_args.args[1], "claude_auth_unavailable")

    def test_missing_sandbox_is_the_second_named_fault(self) -> None:
        with TemporaryDirectory() as tmp:
            with patch.object(ci_executor, "_MOCK_MODE_AT_ENTRY", False), \
                 patch.object(ci_executor, "preflight_claude_auth",
                              return_value={"status": "ok"}), \
                 patch.object(ci_executor, "_sandbox_backend", return_value=None), \
                 patch.object(ci_executor, "_append_tools_governance") as gov:
                kind = self._gate(Path(tmp))

        self.assertEqual(kind, "sandbox_unavailable")
        self.assertEqual(gov.call_args.args[1], "sandbox_unavailable")

    def test_a_healthy_host_passes(self) -> None:
        with TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            (workspace / "node_modules").mkdir()
            cwd = os.getcwd()
            os.chdir(workspace)
            try:
                with patch.object(ci_executor, "_MOCK_MODE_AT_ENTRY", False), \
                     patch.object(ci_executor, "preflight_claude_auth",
                                  return_value={"status": "ok"}), \
                     patch.object(ci_executor, "_sandbox_backend",
                                  return_value="bwrap"):
                    kind = self._gate(workspace)
            finally:
                os.chdir(cwd)

        self.assertIsNone(kind)

    def test_mock_mode_skips_the_gate(self) -> None:
        with TemporaryDirectory() as tmp:
            with patch.object(ci_executor, "_MOCK_MODE_AT_ENTRY", True), \
                 patch.object(ci_executor, "preflight_claude_auth") as pf:
                kind = self._gate(Path(tmp))

        self.assertIsNone(kind)
        pf.assert_not_called()

    def test_the_gate_runs_before_the_claim_in_main(self) -> None:
        # Position pin: the whole defect was ordering (claim first, discover
        # the broken host after). The gate must precede the kernel claim call
        # in the self-claim branch of main().
        import inspect

        source = inspect.getsource(ci_executor.main)
        gate_at = source.index("_pre_claim_environment_gate")
        claim_at = source.index('"agent", "claim"')

        self.assertLess(gate_at, claim_at)


class PreflightStandardSubsetTest(unittest.TestCase):
    def _verdict(
        self,
        tmp: str,
        *,
        backend,
        with_node_modules: bool,
        free_disk_gb: float = 50.0,
    ):
        from aria_kernel import preflight

        workspace = Path(tmp)
        if with_node_modules:
            (workspace / "node_modules").mkdir()
        # Every measured member of the environment contract is explicit.
        # A unit test that names a host "healthy" must not silently inherit
        # the runner's current capacity and turn CI pressure into product
        # behaviour.
        with patch(
            "aria_kernel.implementation_safety.sandbox_backend",
            return_value=backend,
        ), patch.object(preflight, "_free_disk_gb", return_value=free_disk_gb):
            return preflight.verify_preflight(
                profile="standard", workspace_root=workspace, skip_remote=True,
            )

    def test_standard_measures_the_environment(self) -> None:
        with TemporaryDirectory() as tmp:
            verdict = self._verdict(tmp, backend=None, with_node_modules=False)

        self.assertIn("sandbox_backend_absent", verdict.reasons)
        self.assertIn("node_modules_absent", verdict.reasons)
        self.assertIn("environment_preconditions_not_met", verdict.failure_classes)
        # Soft-warn semantics: standard stays valid; the governance row is
        # the signal, and read-only phases may still be worth running.
        self.assertTrue(verdict.valid)

    def test_a_healthy_standard_host_has_no_environment_reasons(self) -> None:
        with TemporaryDirectory() as tmp:
            verdict = self._verdict(tmp, backend="bwrap", with_node_modules=True)

        self.assertTrue(verdict.sandbox_backend_present)
        self.assertTrue(verdict.node_modules_present)
        self.assertEqual(verdict.reasons, ())


class PreflightWarnReachabilityTest(unittest.TestCase):
    class _Verdict:
        valid = True
        reasons = ("sandbox_backend_absent",)
        failure_classes = ("environment_preconditions_not_met",)

    def test_standard_reasons_reach_the_governance_ledger(self) -> None:
        # The deliberate break this phase found: the old guard nested the
        # soft-warn under `not verdict.valid`, which non-autonomous verdicts
        # never satisfy — the documented strict warn had never fired.
        from aria_kernel import autonomy_orchestrator as orch

        with TemporaryDirectory() as tmp, \
             patch("aria_kernel.tool_registry.append_tools_governance") as gov:
            orch._apply_preflight_verdict(Path(tmp), "standard", self._Verdict())

        gov.assert_called_once()
        self.assertEqual(gov.call_args.args[1], "preflight_standard_warnings")

    def test_autonomous_invalid_still_refuses(self) -> None:
        from aria_kernel import autonomy_orchestrator as orch

        verdict = self._Verdict()
        verdict.valid = False
        with TemporaryDirectory() as tmp, \
             patch("aria_kernel.tool_registry.append_tools_governance"):
            with self.assertRaises(GovernanceError):
                orch._apply_preflight_verdict(Path(tmp), "autonomous", verdict)


class AnchorBlockedReasonTest(unittest.TestCase):
    def test_the_anchor_carries_the_nights_refusals(self) -> None:
        from aria_kernel.report import _blocked_reasons

        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "governance.jsonl"
            rows = [
                {"kind": "claude_auth_unavailable", "ts": "2026-08-10T02:00:00+00:00",
                 "details": {"detail": "no session"}},
                {"kind": "preflight_standard_warnings", "ts": "2026-08-10T02:01:00+00:00",
                 "details": {"reasons": ["sandbox_backend_absent"]}},
                {"kind": "cycle_completed", "ts": "2026-08-10T03:00:00+00:00",
                 "details": {}},
                {"kind": "sandbox_unavailable", "ts": "2026-08-09T02:00:00+00:00",
                 "details": {"detail": "yesterday"}},
            ]
            path.write_text(
                "".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8"
            )

            reasons = _blocked_reasons(path, "2026-08-10")

        self.assertEqual(
            [r["kind"] for r in reasons],
            ["claude_auth_unavailable", "preflight_standard_warnings"],
        )
        self.assertEqual(reasons[1]["detail"], "sandbox_backend_absent")

    def test_a_healthy_night_renders_an_empty_list(self) -> None:
        from aria_kernel.report import build_daily_anchor

        with TemporaryDirectory() as tmp:
            anchor = build_daily_anchor(
                date="2026-08-10",
                workspace_root=Path(tmp),
                tools_root=Path(tmp) / "aria-tools",
            )

        self.assertEqual(anchor["blocked_reason"], [])


if __name__ == "__main__":
    unittest.main()
