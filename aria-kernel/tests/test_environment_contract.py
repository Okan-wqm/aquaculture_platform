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
import subprocess
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from aria_kernel.evidence_probe import GitProbeSession
from aria_kernel.ledger import append_declared_jsonl
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir

_REPO_ROOT = Path(__file__).resolve().parents[2]
_POC_DIR = _REPO_ROOT / "tools" / "aria-poc"
if str(_POC_DIR) not in sys.path:
    sys.path.insert(0, str(_POC_DIR))

import ci_executor  # noqa: E402


_HEALTHY_ENV = {
    "RUNNER_NAME": "probe-test-runner",
    # ARIA-HIGH-198: identity is measured from the platform's own report.
    "RUNNER_ENVIRONMENT": "github-hosted",
    "CLAUDE_CODE_OAUTH_TOKEN": "token-present",
    # ARIA-AUDIT-016: identity claims require the Actions OIDC channel as
    # platform evidence; tests simulate the runner-side token channel.
    "ACTIONS_ID_TOKEN_REQUEST_URL": "https://pipelines.actions.githubusercontent.com/xxx",
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN": "test-oidc-token",
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

    def test_identity_claims_without_the_oidc_channel_refuse(self) -> None:
        """ARIA-AUDIT-016: workflow-input defaults are assertions, not evidence."""
        from aria_kernel.tool_registry import GovernanceError

        with TemporaryDirectory() as tmp:
            tools = Path(tmp) / "aria-tools"
            ensure_tools_dir(tools)
            saved = {k: os.environ.pop(k, None) for k in (
                "ACTIONS_ID_TOKEN_REQUEST_URL", "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
            )}
            try:
                with self.assertRaises(GovernanceError) as caught:
                    _probe(tools)
                self.assertIn("platform_unverified", str(caught.exception))
            finally:
                for k, v in saved.items():
                    if v is not None:
                        os.environ[k] = v

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
            with patch.dict(os.environ, _HEALTHY_ENV, clear=False), \
                 patch("aria_kernel.implementation_safety.sandbox_backend",
                       return_value="bwrap"):
                result = probe_runner_attestations_for_claims(
                    base_dir=tools, repo="okan/aqua", target_ref="main",
                )

        self.assertEqual(result["claims_seen"], 2)
        self.assertEqual(len(result["attested"]), 2)
        self.assertEqual(result["refused"], [])


class MeasuredRunnerIdentityTest(unittest.TestCase):
    """ARIA-HIGH-198 — the runner's identity is measured, and the merge lane
    attests what it is: a GitHub-hosted host that runs no model."""

    def _probe_in(self, env: dict, **overrides):
        with TemporaryDirectory() as tmp:
            tools = Path(tmp) / "aria-tools"
            ensure_tools_dir(tools)
            with patch.dict(os.environ, env, clear=False), \
                 patch("aria_kernel.implementation_safety.sandbox_backend", return_value=None):
                os.environ.pop("ANTHROPIC_API_KEY", None)
                return _probe(tools, **overrides)

    def test_a_self_hosted_runner_is_never_attested_ephemeral(self) -> None:
        env = {**_HEALTHY_ENV, "RUNNER_ENVIRONMENT": "self-hosted"}
        with self.assertRaises(GovernanceError) as caught:
            self._probe_in(env, lane="merge")
        self.assertIn("ephemeral_runner_required", str(caught.exception))

    def test_the_merge_lane_on_a_github_hosted_runner_attests_without_model_or_sandbox(self) -> None:
        from aria_kernel.runner_attestation import verify_runner_attestation

        env = {key: value for key, value in _HEALTHY_ENV.items() if key != "CLAUDE_CODE_OAUTH_TOKEN"}
        with TemporaryDirectory() as tmp:
            tools = Path(tmp) / "aria-tools"
            ensure_tools_dir(tools)
            with patch.dict(os.environ, env, clear=False), \
                 patch("aria_kernel.implementation_safety.sandbox_backend", return_value=None):
                os.environ.pop("CLAUDE_CODE_OAUTH_TOKEN", None)
                os.environ.pop("ANTHROPIC_API_KEY", None)
                row = _probe(tools, lane="merge")
            verdict = verify_runner_attestation(
                pr_number=77, head_sha="a" * 40, readiness_claim_id="rc-77", base_dir=tools,
            )
        self.assertEqual(row["runner_group"], "github-hosted")
        self.assertIs(row["ephemeral_runner"], True)
        self.assertEqual(row["claude_auth"], "not_required")
        self.assertEqual(row["probe"]["measured_fields"], ["runner_group", "ephemeral_runner", "approved_runner_group"])
        self.assertTrue(verdict["valid"])

    def test_not_required_auth_outside_the_merge_lane_is_refused(self) -> None:
        from aria_kernel.runner_attestation import record_runner_attestation

        with TemporaryDirectory() as tmp:
            tools = Path(tmp) / "aria-tools"
            ensure_tools_dir(tools)
            with self.assertRaises(GovernanceError) as caught:
                record_runner_attestation({
                    "repo": "okan/aqua", "pr_number": 1, "target_ref": "main", "head_ref": "x",
                    "head_sha": "b" * 40, "readiness_claim_id": "rc-1", "runner_id": "r",
                    "runner_group": "github-hosted", "ephemeral_runner": True,
                    "approved_runner_group": True, "platform_verified": True,
                    "api_key_auth": False, "claude_auth": "not_required",
                    "attestation_lane": "agent",
                }, base_dir=tools)
        self.assertIn("merge_lane_only", str(caught.exception))

    def test_an_unknown_lane_is_refused(self) -> None:
        with self.assertRaises(GovernanceError):
            self._probe_in(_HEALTHY_ENV, lane="deploy")


def _checkout_with_one_commit(workspace: Path) -> None:
    """A healthy executor workspace is a checkout with a readable HEAD."""
    def git(*args: str) -> None:
        subprocess.run(
            ["git", *args], cwd=str(workspace), check=True, capture_output=True, text=True,
        )

    git("init", "-q")
    git("config", "user.email", "t@example.invalid")
    git("config", "user.name", "t")
    (workspace / "README").write_text("seed\n", encoding="utf-8")
    git("add", "README")
    git("commit", "-qm", "seed")


class PreClaimGateTest(unittest.TestCase):
    def _gate(self, tools: Path):
        return ci_executor._pre_claim_environment_gate(tools_dir=tools)

    def _healthy_probes(self):
        """Auth and sandbox answer; only the workspace itself is under test."""
        return (
            patch.object(ci_executor, "_MOCK_MODE_AT_ENTRY", False),
            patch.object(ci_executor, "preflight_claude_auth", return_value={"status": "ok"}),
            patch.object(ci_executor, "_sandbox_backend", return_value="bwrap"),
            # ARIA-HIGH-143 — the egress boundary answers too.
            patch.object(ci_executor, "_egress_boundary_probe", return_value=None),
        )

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

    def test_a_missing_egress_boundary_is_named_before_any_claim(self) -> None:
        # ARIA-HIGH-143 — the spawn shares the host's network; without the
        # allowlist proxy a prompt-injected agent has all of it. The gate
        # names the gap the probe found and the request stays PENDING.
        with TemporaryDirectory() as tmp:
            with patch.object(ci_executor, "_MOCK_MODE_AT_ENTRY", False), \
                 patch.object(ci_executor, "preflight_claude_auth", return_value={"status": "ok"}), \
                 patch.object(ci_executor, "_sandbox_backend", return_value="bwrap"), \
                 patch.object(ci_executor, "_egress_boundary_probe",
                              return_value="HTTPS_PROXY is unset; the spawn would have the host's whole network"), \
                 patch.object(ci_executor, "_append_tools_governance") as gov:
                kind = self._gate(Path(tmp))

        self.assertEqual(kind, "egress_boundary_unavailable")
        self.assertEqual(gov.call_args.args[1], "egress_boundary_unavailable")
        self.assertIn("HTTPS_PROXY is unset", gov.call_args.args[2]["detail"])

    def test_a_healthy_host_passes(self) -> None:
        with TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            _checkout_with_one_commit(workspace)
            (workspace / "node_modules").mkdir()
            cwd = os.getcwd()
            os.chdir(workspace)
            try:
                mock_mode, auth, sandbox, egress = self._healthy_probes()
                with mock_mode, auth, sandbox, egress:
                    kind = self._gate(workspace)
            finally:
                os.chdir(cwd)

        self.assertIsNone(kind)

    def test_a_per_request_worktree_resolves_the_checkouts_node_modules(self) -> None:
        # B8 — the drain child runs in `<checkout>/aria-worktrees/req-x`, which
        # has no node_modules of its own; Node walks up to the checkout's, and
        # so must the gate (a cwd-only check refused every worktree child as
        # env_deps_missing).
        with TemporaryDirectory() as tmp:
            checkout = Path(tmp)
            (checkout / "node_modules").mkdir()
            worktree = checkout / "aria-worktrees" / "req-AIR-1"
            worktree.mkdir(parents=True)
            # The gate also asks git for HEAD in the child's cwd (ARIA-HIGH-109):
            # the per-request worktree is a real checkout, so it is one here.
            subprocess.run(["git", "init", "-q", str(worktree)], check=True)
            subprocess.run(["git", "-C", str(worktree), "-c", "user.name=t", "-c", "user.email=t@x.invalid",
                            "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "seed"], check=True)
            cwd = os.getcwd()
            os.chdir(worktree)
            try:
                with patch.object(ci_executor, "_MOCK_MODE_AT_ENTRY", False), \
                     patch.object(ci_executor, "preflight_claude_auth",
                                  return_value={"status": "ok"}), \
                     patch.object(ci_executor, "_sandbox_backend",
                                  return_value="bwrap"), \
                     patch.object(ci_executor, "_egress_boundary_probe", return_value=None):
                    kind = self._gate(checkout)
            finally:
                os.chdir(cwd)
            self.assertIsNone(kind)
            self.assertTrue(ci_executor._node_modules_resolvable_from(worktree))
        with TemporaryDirectory() as bare:
            self.assertFalse(ci_executor._node_modules_resolvable_from(Path(bare) / "nested" / "deeper"))

    def test_a_workspace_whose_git_cannot_answer_is_never_claimed(self) -> None:
        # The kernel verifies every evidence ref with git probes in this
        # workspace; a git that cannot answer `rev-parse HEAD` here would
        # reject the finished result as verification_unavailable — a harness
        # fault, uncounted — and re-run the same paid work every night. The
        # gate refuses to claim instead. Here: no repository at all.
        with TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            (workspace / "node_modules").mkdir()
            cwd = os.getcwd()
            os.chdir(workspace)
            try:
                mock_mode, auth, sandbox, egress = self._healthy_probes()
                with mock_mode, auth, sandbox, egress, \
                     patch.dict(os.environ, {"GIT_CEILING_DIRECTORIES": str(workspace.parent)}), \
                     patch.object(ci_executor, "_append_tools_governance") as gov:
                    kind = self._gate(workspace)
            finally:
                os.chdir(cwd)

        self.assertEqual(kind, "git_unavailable")
        self.assertEqual(gov.call_args.args[1], "git_unavailable")
        self.assertIn("rev-parse HEAD exited", gov.call_args.args[2]["detail"])

    def test_a_git_that_stalls_past_its_retries_is_named_as_such(self) -> None:
        # The probe is the kernel's own session (attempt bound + retry), so
        # the gate's notion of "git answers" is the validator's. A session
        # whose every attempt stalls reports the stall, not a non-zero exit.
        with TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            _checkout_with_one_commit(workspace)
            (workspace / "node_modules").mkdir()
            cwd = os.getcwd()
            os.chdir(workspace)
            try:
                stalled = GitProbeSession(
                    attempt_timeout_seconds=0.0, attempts=2, backoff_seconds=(0.0,),
                )
                mock_mode, auth, sandbox, egress = self._healthy_probes()
                with mock_mode, auth, sandbox, egress, \
                     patch.object(ci_executor, "_GitProbeSession", return_value=stalled), \
                     patch.object(ci_executor, "_append_tools_governance") as gov:
                    kind = self._gate(workspace)
            finally:
                os.chdir(cwd)

        self.assertEqual(kind, "git_unavailable")
        self.assertIn("did not answer", gov.call_args.args[2]["detail"])
        self.assertEqual(stalled.stalled_attempts, 2)

    def test_the_git_probe_is_the_kernels_own_session(self) -> None:
        # Not a private subprocess with its own bound: the same probe the
        # validator runs, so the two cannot disagree on what "answers" is.
        import inspect

        source = inspect.getsource(ci_executor._pre_claim_environment_gate)
        self.assertIn("_GitProbeSession()", source)
        self.assertIn("_git_availability_gap(", source)

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
        # in the self-claim branch of the entry body — `_main`; `main` is the
        # three-line ExitStack wrapper around it, and pinning the wrapper's
        # source (as this test did) raised ValueError instead of gating.
        import inspect

        source = inspect.getsource(ci_executor._main)
        gate_at = source.index("_pre_claim_environment_gate")
        # Typed-judgment plan Phase 4a — the kernel claim argv lives in
        # `_claim_request_via_cli`; `_main` calls it by name, after the gate.
        claim_at = source.index("_claim_request_via_cli(")

        self.assertLess(gate_at, claim_at)
        helper = inspect.getsource(ci_executor._claim_request_via_cli)
        self.assertIn('"agent", "claim"', helper)


class PreflightStandardSubsetTest(unittest.TestCase):
    def _verdict(self, tmp: str, *, backend, with_node_modules: bool):
        from aria_kernel.preflight import verify_preflight

        workspace = Path(tmp)
        if with_node_modules:
            (workspace / "node_modules").mkdir()
        with patch("aria_kernel.implementation_safety.sandbox_backend",
                   return_value=backend):
            return verify_preflight(
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


class MergeRunVerbTest(unittest.TestCase):
    """ARIA-HIGH-198 — `aria-kernel merge-lane run --pr N` runs the SAME runner and
    authority the cycle uses, for exactly that PR, on the invoking host."""

    def test_the_verb_enumerates_only_the_named_pr(self) -> None:
        from aria_kernel import cli

        seen: dict = {}

        class _Runner:
            def __call__(self, *, base_dir, workspace_root):
                seen["prs"] = seen["enumerator"](object())
                return {"status": "ok", "merges_completed": 0}

        def fake_select(*, profile, adapter_factory, pr_enumerator, readiness_claim_resolver):
            seen["profile"] = profile
            seen["enumerator"] = pr_enumerator
            return _Runner()

        with TemporaryDirectory() as tmp:
            tools = Path(tmp) / "aria-tools"
            ensure_tools_dir(tools)
            with patch("aria_kernel.auto_merge_runners.select_auto_merge_runner", side_effect=fake_select), \
                 patch("aria_kernel.github_adapters.select_github_adapter", return_value=object()):
                rc = cli.main(["--tools-dir", str(tools), "merge-lane", "run", "--pr", "1672"])
        self.assertEqual(rc, 0)
        self.assertEqual(seen["prs"], [1672])
