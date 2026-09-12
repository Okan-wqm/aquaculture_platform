"""F13/E8 — the cost-budget gate finally guards the spawn.

`cost_budget.assert_within_budget` documented itself as "call BEFORE
spawning claude" and its only repo reference was a comment: every cap and
the breaker trip existed with no caller — no spawn could ever be stopped by
budget. These pin the wiring at the single choke point every live claude
spawn passes through (`claude_runtime.run_claude_exec`).
"""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

_POC = Path(__file__).resolve().parents[2] / "tools" / "aria-poc"
if str(_POC) not in sys.path:
    sys.path.insert(0, str(_POC))

from claude_runtime import _assert_budget_before_spawn  # noqa: E402

from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir  # noqa: E402


class SpawnBudgetGateTests(unittest.TestCase):
    def setUp(self) -> None:
        self._prior = {
            k: os.environ.pop(k, None)
            for k in ("ARIA_TOOLS_DIR", "ARIA_ESTIMATED_RUN_USD")
        }
        self.addCleanup(self._restore)

    def _restore(self) -> None:
        for key, value in self._prior.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def test_no_store_binding_is_ungated(self) -> None:
        # Without ARIA_TOOLS_DIR there is no spend ledger to project
        # against — local dev/tests run ungated, honestly.
        _assert_budget_before_spawn()  # no raise

    def test_over_cap_estimate_refuses_the_spawn(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
            os.environ["ARIA_TOOLS_DIR"] = str(root)
            # Estimate above the per-run cap → the breaker trips and the
            # spawn is refused BEFORE any money is spent.
            os.environ["ARIA_ESTIMATED_RUN_USD"] = "999999"
            with self.assertRaisesRegex(
                GovernanceError, "cost_budget_per_run_cap_exceeded"
            ):
                _assert_budget_before_spawn()

    def test_default_estimate_derives_from_policy_and_passes(self) -> None:
        """Executor smoke 31704817330 — the original hardcoded default
        ($1.50) sat above the policy per_run cap ($0.50): 30/30 spawns
        refused, breaker tripped on configuration. The default now derives
        from the policy (80% of per_run), so an untouched environment can
        never refuse on constant-disagreement."""
        with tempfile.TemporaryDirectory() as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
            os.environ["ARIA_TOOLS_DIR"] = str(root)
            _assert_budget_before_spawn()  # no raise, no env estimate

    def test_within_cap_estimate_passes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
            os.environ["ARIA_TOOLS_DIR"] = str(root)
            os.environ["ARIA_ESTIMATED_RUN_USD"] = "0.01"
            _assert_budget_before_spawn()  # no raise

    def test_managed_subscription_makes_the_dollar_gate_telemetry(self) -> None:
        """ARIA-HIGH-079 — trial eight's cross-review was refused with the
        shipped $5 daily cap after one accepted challenger, on a workspace
        whose policy said managed_subscription: notional dollars are
        telemetry under that policy (ORPHAN-HIGH-472, ARIA-HIGH-074), and
        the gate read the DEFAULT policy because it took the store's parent
        for the workspace while the store was bound elsewhere."""
        import json

        from aria_kernel.cost_budget import assert_within_budget, _load_caps
        from aria_kernel.tool_registry import bound_workspace_root, ensure_tools_binding

        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp) / "workspace"
            (workspace / "aria-config").mkdir(parents=True)
            (workspace / "aria-config/genesis_policy.json").write_text(json.dumps({
                "cost_caps_usd": {"daily": 5.0, "monthly": 50.0, "per_run": 4.0},
                "executor": {"adaptive_runtime": {
                    "schema_version": 1, "enabled": True, "policy_id": "aria/adaptive-runtime/v1",
                    "provider_cooldown_seconds": 900, "recheck_timeout_seconds": 20,
                    "max_attempts_per_dispatch": 2, "scarcity_judgment_mode": "independent_sessions",
                    "monetary_admission": "managed_subscription",
                }},
            }) + "\n", encoding="utf-8")
            import subprocess
            subprocess.run(["git", "init", "-q", str(workspace)], check=True)
            # The store lives OUTSIDE the workspace, bound to it — the
            # trial layout, and any operator who keeps state off the tree.
            store = ensure_tools_binding(Path(tmp) / "store" / "tools", workspace_root=workspace)
            self.assertEqual(bound_workspace_root(store), workspace.resolve())
            self.assertEqual(_load_caps(store)["per_run"], 4.0, "the caps come from the BOUND workspace's policy")
            snapshot = assert_within_budget(store, estimated_run_usd=3.6)
            self.assertEqual(snapshot["status"], "telemetry_only")
            self.assertEqual(snapshot["monetary_admission"], "managed_subscription")
            self.assertAlmostEqual(snapshot["projected_daily_usd"], 3.6)
            # Way over every cap: still telemetry, never a refusal or a trip.
            assert_within_budget(store, estimated_run_usd=3.9)
            self.assertFalse((store / "circuit-breaker.json").exists() and "tripped" in (store / "circuit-breaker.json").read_text())
            os.environ["ARIA_TOOLS_DIR"] = str(store)
            os.environ["ARIA_ESTIMATED_RUN_USD"] = "3.9"
            _assert_budget_before_spawn()  # no raise

    def test_a_legacy_store_still_reads_its_parent_workspace(self) -> None:
        from aria_kernel.tool_registry import bound_workspace_root

        with tempfile.TemporaryDirectory() as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
            self.assertEqual(bound_workspace_root(root), Path(tmp).resolve())

    def test_gate_sits_on_the_spawn_path(self) -> None:
        """Deliberate-break pin: run_claude_exec must call the gate. A
        refactor that drops the call reopens F13 silently — this fails it
        at test time instead."""
        import inspect

        import claude_runtime

        source = inspect.getsource(claude_runtime.run_claude_exec)
        self.assertIn("_assert_budget_before_spawn()", source)


class _SpawnAdmitted(Exception):
    """Raised by the fake model runner: the gate let the dispatch through."""


class TheExecutorReservationPricesLikeTheLedger(unittest.TestCase):
    """ARIA-AUDIT-021 gate, measured 2026-09-04: 82 requests, 0 results.

    The gate in `invoke_claude_cli` priced the profile's raw alias (`opus`)
    against tables keyed by resolved id and family, found nothing, and
    refused every dispatch as `cost_reservation_refused_pricing_unknown`
    before any CLI ran. These drive the REAL gate (non-mock, a metered
    workspace policy, the real summary writer) and pin that `opus` is now
    the claude-opus row: refused by the CAP when the cap is below the
    ceiling, admitted when it is not, and an unknown model still denied.
    """

    def setUp(self) -> None:
        import shutil

        import ci_executor

        scratch = tempfile.TemporaryDirectory(prefix="aria-spawn-reservation-")
        self.addCleanup(scratch.cleanup)
        root = Path(scratch.name)
        self.repo = root / "workspace"
        agent = _POC.parents[1] / ".claude" / "agents" / "aria-evidence-judge.md"
        (self.repo / ".claude" / "agents").mkdir(parents=True)
        shutil.copy2(agent, self.repo / ".claude" / "agents" / agent.name)
        (self.repo / "aria-config").mkdir()
        self.tools = ensure_tools_dir(self.repo / "aria-tools")
        self.runner_temp = root / "runner-temp"
        self.runner_temp.mkdir()
        self.prompt = root / "prompt.md"
        self.prompt.write_text("# request\n", encoding="utf-8")
        self.output = self.tools / "agent-invocations" / "outputs" / "REQ-reservation-1.json"
        environment = patch.dict(os.environ, {"RUNNER_TEMP": str(self.runner_temp)})
        environment.start()
        self.addCleanup(environment.stop)
        for name in ("GITHUB_OUTPUT", "ARIA_COST_UNKNOWN_ACK"):
            os.environ.pop(name, None)
        # The gate reads the workspace policy through the module's root and
        # the frozen mock sentinel; both are set the way `_main` sets them.
        for name, value in (("_REPO_ROOT", self.repo), ("_MOCK_MODE_AT_ENTRY", False)):
            patcher = patch.object(ci_executor, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        # Past the gate, the model runner is the next call; a sentinel there
        # is the proof of admission — nothing is spawned.
        runner = patch.object(ci_executor, "run_with_model_fallback", side_effect=_SpawnAdmitted())
        runner.start()
        self.addCleanup(runner.stop)
        self.executor = ci_executor

    def _metered_policy(self, *, per_run: float) -> None:
        import json

        (self.repo / "aria-config" / "genesis_policy.json").write_text(json.dumps({
            "cost_caps_usd": {"daily": 100.0, "monthly": 1000.0, "per_run": per_run},
        }) + "\n", encoding="utf-8")

    def _invoke(self) -> int:
        return self.executor.invoke_claude_cli(
            request_id="REQ-reservation-1", subagent_type="aria-evidence-judge",
            prompt_file=self.prompt, output_path=self.output, timeout_seconds=60,
            claim_id="claim_reservation_1", agent_id="ci-executor:gha-test",
            role="evidence_judgment", must_satisfy=[],
            request_envelope={"role": "evidence_judgment", "target_agent": "aria-evidence-judge"},
            tools_dir=self.tools,
        )

    def _summary(self) -> dict:
        import json

        return json.loads((self.runner_temp / "dispatch-result-REQ-reservation-1.json").read_text(encoding="utf-8"))

    def test_opus_is_refused_by_the_cap_not_as_an_unknown_price(self) -> None:
        import json

        from aria_kernel.budget import price_spawn_reservation

        self._metered_policy(per_run=0.5)  # the live cap
        self.assertEqual(self._invoke(), 1)
        summary = self._summary()
        self.assertEqual(summary["failure_class"], "policy_violation")
        self.assertEqual(summary["failure_detail_code"], "cost_reservation_refused")
        breaker = json.loads((self.tools / "budget" / "breaker_state.json").read_text(encoding="utf-8"))
        self.assertEqual(breaker["cap_name"], "per_run")
        self.assertAlmostEqual(breaker["amount"], price_spawn_reservation(model="opus").usd)
        self.assertAlmostEqual(breaker["amount"], 3.6)

    def test_a_cap_at_the_ceiling_admits_opus_to_the_spawn(self) -> None:
        from aria_kernel.budget import price_spawn_reservation

        self._metered_policy(per_run=price_spawn_reservation(model="opus").usd)
        with self.assertRaises(_SpawnAdmitted):
            self._invoke()
        self.assertFalse((self.runner_temp / "dispatch-result-REQ-reservation-1.json").exists())
        self.assertFalse((self.tools / "budget" / "breaker_state.json").exists())

    def test_an_unknown_model_is_still_denied_by_name(self) -> None:
        from aria_kernel import agent_runtime_profile as profiles

        unknown = profiles.AgentRuntimeProfile("aria-evidence-judge", "gpt-9-nebula", "high", "frontmatter")
        self._metered_policy(per_run=1000.0)
        with patch.object(profiles, "read_agent_runtime_profile", return_value=unknown):
            self.assertEqual(self._invoke(), 1)
        self.assertEqual(self._summary()["failure_detail_code"], "cost_reservation_refused_pricing_unknown")


class TheLivePolicyCanAdmitADispatch(unittest.TestCase):
    """A metered configuration that admits no model is a red test, not a
    silent nightly refusal.

    The live override declared `per_run: 0.5` and no `executor.adaptive_runtime`
    block, so the executor read the metered default and every profile model
    priced above the cap at the reservation ceiling (opus 3.6, fable 7.2,
    glm-5.3 0.8416). Under `managed_subscription` the estimates are telemetry
    and the cap is not the admission; under `metered` at least one
    dispatchable profile model must fit under it, or nothing can ever run.
    """

    _REPO_ROOT = _POC.parents[1]

    def test_the_repository_policy_validates_and_names_its_admission_mode(self) -> None:
        # The mode is the operator's to choose (managed_subscription since
        # 2026-09-12); what may not happen is silence — an absent block is
        # the metered default nobody chose, and it refused every dispatch.
        from aria_kernel.genesis_policy import _adaptive_runtime_policy

        policy = _adaptive_runtime_policy(self._REPO_ROOT)
        self.assertIsNotNone(policy, "the live override declares no executor.adaptive_runtime block: "
                                     "the executor falls back to the metered default")
        self.assertIn(policy.monetary_admission, ("metered", "managed_subscription"))

    def test_a_metered_policy_admits_at_least_one_dispatchable_profile_model(self) -> None:
        from aria_kernel.budget import price_spawn_reservation
        from aria_kernel.cost_budget import _load_caps
        from aria_kernel.genesis_policy import _adaptive_runtime_policy
        from aria_kernel.runtime_profiles import load_runtime_profiles

        policy = _adaptive_runtime_policy(self._REPO_ROOT)
        if policy is not None and policy.monetary_admission == "managed_subscription":
            return  # the dollar cap is telemetry; nothing to admit against
        # `_load_caps` resolves the workspace from a store; a legacy store at
        # <workspace>/aria-tools reads the workspace's own override.
        caps = _load_caps(self._REPO_ROOT / "aria-tools")
        models = sorted({profile.model for profile in load_runtime_profiles().values()})
        self.assertTrue(models)
        reservations = {model: price_spawn_reservation(model=model).usd for model in models}
        admissible = [model for model, usd in reservations.items() if usd <= caps["per_run"]]
        self.assertTrue(
            admissible,
            f"metered admission with per_run={caps['per_run']} admits no profile model; "
            f"reservation ceilings: {reservations}. Raise the cap or declare "
            "executor.adaptive_runtime.monetary_admission=managed_subscription.",
        )


if __name__ == "__main__":
    unittest.main()
