"""ARIA-HIGH-075 — a stalled first probe does not starve the fleet behind it.

Measured on 2026-09-11 (trial four, `AIR-aria-challenger-planner-1809efa4dcb9`,
second dispatch): with the host at 96 % swap the managed Anthropic probe hit
its 20 s limit — `status_timeout`, honest — and Codex, third in fleet order,
was recorded `status_deadline_elapsed` with an empty status command: it was
never asked. The executor had handed the whole fleet ONE
`recheck_timeout_seconds` as its deadline. The budget is per probe; the fleet
owns the arithmetic now.

What this pins, one property per test:

* Every fleet member is offered the full recheck budget even when the member
  before it consumed all of its own.
* The admission as a whole is bounded by recheck × fleet size, and a probe
  that overruns its budget still leaves the members behind it their share —
  only what is genuinely gone is gone.
* The executor no longer computes a deadline of its own.
"""
from __future__ import annotations

import inspect
import json
import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aria_kernel import model_fleet
from aria_kernel.agent_runtime_profile import AgentRuntimeProfile
from aria_kernel.genesis_policy import _adaptive_runtime_policy
from aria_kernel.model_fleet import (
    _FLEET,
    Provider,
    _RuntimeStatusObservation,
    _native_runtime_admission,
    native_admission_budget_seconds,
)

_REPO_ROOT = Path(__file__).resolve().parents[2]


class _FakeClock:
    """A monotonic clock the fake probes advance by hand."""

    def __init__(self) -> None:
        self.now = 1_000.0

    def monotonic(self) -> float:
        return self.now


class _Fixture(unittest.TestCase):
    def setUp(self) -> None:
        self.repo = Path(tempfile.mkdtemp(prefix="aria-admission-budget-"))
        self.addCleanup(lambda: __import__("shutil").rmtree(self.repo, ignore_errors=True))
        policy = self.repo / "aria-config/genesis_policy.json"
        policy.parent.mkdir()
        policy.write_text(json.dumps({"executor": {"adaptive_runtime": {
            "schema_version": 1, "enabled": True, "policy_id": "aria/adaptive-runtime/v1",
            "provider_cooldown_seconds": 900, "recheck_timeout_seconds": 20,
            "max_attempts_per_dispatch": 2, "scarcity_judgment_mode": "independent_sessions",
            "monetary_admission": "managed_subscription",
        }}}) + "\n", encoding="utf-8")
        self.policy = _adaptive_runtime_policy(self.repo)
        # Every CLI-backed member must be discoverable, else it is refused
        # before any probe (`cli_unavailable`) and never reaches the budget.
        binaries = self.repo / "bin"
        binaries.mkdir()
        for name in ("claude", "codex"):
            executable = binaries / name
            executable.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            executable.chmod(executable.stat().st_mode | stat.S_IXUSR)
        self.environ = {"PATH": str(binaries), "ARIA_ZAI_API_KEY_FILE": str(self.repo / "zai.key")}
        self.profile = AgentRuntimeProfile(agent_name="fixture", model="opus", effort="max", source="frontmatter")
        self.clock = _FakeClock()
        self.offered: list[tuple[str, float]] = []

    def _admit(self, spend: dict[str, float]) -> model_fleet._NativeRuntimeAdmission:
        def observe(provider: Provider, timeout_seconds: float) -> _RuntimeStatusObservation:
            self.offered.append((provider.key, timeout_seconds))
            self.clock.now += spend.get(provider.key, 0.0)
            return _RuntimeStatusObservation("unknown", reason="status_timeout")

        with patch.object(model_fleet._time, "monotonic", self.clock.monotonic):
            return _native_runtime_admission(
                repo_root=self.repo, profile=self.profile, policy=self.policy,
                environ=self.environ, observe_status=observe,
            )


class EveryMemberIsOfferedItsOwnBudget(_Fixture):
    def test_a_first_probe_that_spends_its_whole_budget_starves_nobody(self) -> None:
        recheck = float(self.policy.recheck_timeout_seconds)
        admission = self._admit(spend={"anthropic": recheck})
        self.assertEqual(self.offered, [(provider.key, recheck) for provider in _FLEET])
        reasons = {row["provider"]: row["status_reason"] for row in admission.candidate_observations}
        self.assertEqual(reasons, {provider.key: "status_timeout" for provider in _FLEET})
        self.assertNotIn("status_deadline_elapsed", reasons.values())

    def test_the_budget_is_one_recheck_per_fleet_member(self) -> None:
        self.assertEqual(native_admission_budget_seconds(self.policy),
                         float(self.policy.recheck_timeout_seconds) * len(_FLEET))

    def test_an_overrun_takes_only_from_the_members_behind_it(self) -> None:
        # A probe that ignores its limit and runs two budgets long leaves the
        # next member one full budget and the last member nothing: what is
        # genuinely gone is gone, and it is named as such — never invented.
        recheck = float(self.policy.recheck_timeout_seconds)
        admission = self._admit(spend={"anthropic": recheck * 2, "zai": recheck})
        self.assertEqual(self.offered, [("anthropic", recheck), ("zai", recheck)])
        reasons = {row["provider"]: row["status_reason"] for row in admission.candidate_observations}
        self.assertEqual(reasons["openai"], "status_deadline_elapsed")
        self.assertEqual(reasons["zai"], "status_timeout")


class TheExecutorDoesNotComputeADeadline(unittest.TestCase):
    def test_the_admission_owns_its_deadline(self) -> None:
        self.assertNotIn("deadline_monotonic", inspect.signature(_native_runtime_admission).parameters)
        executor = (_REPO_ROOT / "tools/aria-poc/ci_executor.py").read_text(encoding="utf-8")
        call = executor[executor.index("_native_runtime_admission(") + len("_native_runtime_admission("):]
        self.assertNotIn("recheck_timeout_seconds", call[:call.index(")")])


if __name__ == "__main__":
    unittest.main()
