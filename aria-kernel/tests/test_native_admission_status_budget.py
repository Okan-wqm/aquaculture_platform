"""ARIA-HIGH-075 — a stalled first probe does not starve the fleet behind it.

Measured on 2026-09-11 (trial four, `AIR-aria-challenger-planner-1809efa4dcb9`,
second dispatch): with the host at 96 % swap the managed Anthropic probe hit
its 20 s limit — `status_timeout`, honest — and Codex, third in fleet order,
was recorded `status_deadline_elapsed` with an empty status command: it was
never asked. The executor had handed the whole fleet ONE
`recheck_timeout_seconds` as its deadline. The budget is per probe; the fleet
owns the arithmetic now — and since ARIA-HIGH-107 a probe is retried within
its own liveness bound (`status_probe.STATUS_PROBE_ATTEMPTS` attempts, each
capped by `recheck_timeout_seconds`, backoff between), so the admission's
whole clock is that bound times the fleet's size.

What this pins, one property per test:

* Every fleet member is offered the full per-attempt cap on every attempt,
  even when the member before it consumed its whole liveness bound.
* The admission as a whole is bounded by (attempts × cap + backoffs) × fleet
  size, and a probe that overruns its bound still leaves the members behind
  it whatever remains — only what is genuinely gone is gone, and it is
  named `status_deadline_elapsed` with zero attempts, never invented.
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

from aria_kernel.agent_runtime_profile import AgentRuntimeProfile
from aria_kernel.genesis_policy import _adaptive_runtime_policy
from aria_kernel.model_fleet import _FLEET, Provider
from aria_kernel.native_admission import (
    _NativeRuntimeAdmission,
    _native_runtime_admission,
    native_admission_budget_seconds,
)
from aria_kernel.status_probe import (
    STATUS_PROBE_ATTEMPTS,
    STATUS_PROBE_BACKOFF_SECONDS,
    AdmissionClock,
    StatusDecision,
    _RuntimeStatusObservation,
    status_probe_liveness_seconds,
)

_REPO_ROOT = Path(__file__).resolve().parents[2]


class _FakeClock:
    """A monotonic clock the fake probes (and the backoff sleeps) advance by hand."""

    def __init__(self) -> None:
        self.now = 1_000.0

    def monotonic(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.now += seconds


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
        self.recheck = float(self.policy.recheck_timeout_seconds)
        self.liveness = status_probe_liveness_seconds(self.recheck)

    def _admit(self, spend: dict[str, float]) -> _NativeRuntimeAdmission:
        """Every probe stalls (`status_timeout`); `spend` is what each attempt
        of a provider costs the clock (default: exactly what it was offered)."""

        def observe(provider: Provider, timeout_seconds: float) -> _RuntimeStatusObservation:
            self.offered.append((provider.key, timeout_seconds))
            self.clock.now += spend.get(provider.key, timeout_seconds)
            return _RuntimeStatusObservation("unknown", reason="status_timeout",
                                             decision=StatusDecision.UNDECIDED)

        clock = AdmissionClock(
            attempt_cap_seconds=self.recheck, liveness_seconds=native_admission_budget_seconds(self.policy),
            monotonic=self.clock.monotonic, sleep=self.clock.sleep,
        )
        return _native_runtime_admission(
            repo_root=self.repo, profile=self.profile, policy=self.policy,
            environ=self.environ, observe_status=observe,
            # No provider is cooled here: every member must be PROBED for
            # the budget arithmetic to be measured at all.
            cooled_providers={}, clock=clock,
        )


class EveryMemberIsOfferedItsOwnBudget(_Fixture):
    def test_a_first_probe_that_spends_its_whole_bound_starves_nobody(self) -> None:
        started = self.clock.now
        admission = self._admit(spend={})
        # Three attempts per member, each offered the full per-attempt cap.
        self.assertEqual(self.offered, [(provider.key, self.recheck)
                                        for provider in _FLEET for _ in range(STATUS_PROBE_ATTEMPTS)])
        reasons = {row["provider"]: row["status_reason"] for row in admission.candidate_observations}
        self.assertEqual(reasons, {provider.key: "status_timeout" for provider in _FLEET})
        self.assertNotIn("status_deadline_elapsed", reasons.values())
        probes = {row["provider"]: row["probe"] for row in admission.candidate_observations}
        for provider in _FLEET:
            self.assertEqual(probes[provider.key]["attempts"], STATUS_PROBE_ATTEMPTS)
            self.assertEqual(probes[provider.key]["backoff_seconds"], sum(STATUS_PROBE_BACKOFF_SECONDS))
        # The whole fleet stalling costs exactly the admission's bound.
        self.assertEqual(self.clock.now - started, native_admission_budget_seconds(self.policy))

    def test_the_budget_is_one_probe_liveness_bound_per_fleet_member(self) -> None:
        self.assertEqual(native_admission_budget_seconds(self.policy), self.liveness * len(_FLEET))
        self.assertEqual(self.liveness,
                         STATUS_PROBE_ATTEMPTS * self.recheck + sum(STATUS_PROBE_BACKOFF_SECONDS))

    def test_an_overrun_takes_only_from_the_members_behind_it(self) -> None:
        # A probe that ignores its cap and runs the WHOLE admission bound
        # long on its first attempt leaves nothing for its own retries nor
        # for the members behind it: what is genuinely gone is gone, and it
        # is named as such — zero attempts, never invented.
        admission = self._admit(spend={"anthropic": native_admission_budget_seconds(self.policy)})
        self.assertEqual(self.offered, [("anthropic", self.recheck)])
        rows = {row["provider"]: row for row in admission.candidate_observations}
        self.assertEqual(rows["anthropic"]["status_reason"], "status_deadline_elapsed")
        self.assertEqual(rows["anthropic"]["probe"],
                         {"attempts": 1, "undecided_reasons": ["status_timeout"], "backoff_seconds": 0.0})
        for later in ("zai", "openai"):
            self.assertEqual(rows[later]["status_reason"], "status_deadline_elapsed")
            self.assertEqual(rows[later]["probe"]["attempts"], 0)
            self.assertEqual(rows[later]["decision"], "undecided")


class TheExecutorDoesNotComputeADeadline(unittest.TestCase):
    def test_the_admission_owns_its_deadline(self) -> None:
        self.assertNotIn("deadline_monotonic", inspect.signature(_native_runtime_admission).parameters)
        executor = (_REPO_ROOT / "tools/aria-poc/ci_executor.py").read_text(encoding="utf-8")
        call = executor[executor.index("_native_runtime_admission(") + len("_native_runtime_admission("):]
        self.assertNotIn("recheck_timeout_seconds", call[:call.index(")")])
        self.assertNotIn("AdmissionClock", executor, "the fleet builds its own clock from the policy")


if __name__ == "__main__":
    unittest.main()
