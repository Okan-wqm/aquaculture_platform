"""ARIA-HIGH-107 — a probe that did not answer is not an auth fact.

Measured on 2026-09-12 (trial eleven, host load ~7, dispatch 03 of chain A):
the managed Anthropic probe `claude auth status --json` stalled to its 20 s
cap — `status_timeout`, `auth_observation: unknown` — and the fleet
admission read the row like a refusal: anthropic not eligible, openai next
in fleet order, and a converging plan's primary planner ran on gpt-6-astra.
Two dispatches earlier the same probe had answered `available`. Operator
decision on record: opus is a leaf for its roles; read-only roles fail over
across vendors for AUTH reasons only (auth unavailable, quota exhausted or
cooled), and a stalled probe is neither.

What this pins, one property per test:

* `StatusDecision` is three-valued and every observation carries it by
  construction; a contradictory row (auth `unavailable` marked undecided,
  auth `unknown` marked available) cannot be built.
* `observe_until_decided` retries ONLY an undecided observation, within
  the attempt count and backoff of `status_probe`, on one admission clock,
  and records the attempts it took; a decided refusal ends the retry.
* The fleet ladder moves past a provider only on a DECIDED unavailable
  observation. The first provider still in contention that stays
  undecided halts it: outcome `provider_undecided`, NO route (a later,
  available vendor is observed and recorded, never admitted). A decided
  `unavailable` and a cooldown fail over exactly as before. A later-ranked
  undecided provider behind an eligible one is skipped, not cooled.
* (verifier, 2026-09-12) A provider the vendor did NOT refuse but whose
  controls this host could not bind (`control_status` "unavailable" on a
  decided-available auth, or on an undecided one whose context could not
  be prepared) halts the ladder the same way, by its own name:
  `provider_control_unavailable`. Controls merely never bound ("unknown",
  the metered policy's bare probe) stay the policy's own ineligibility.
* The admission clock bounds the whole fleet (the arithmetic is pinned).
* The executor's refusal table names, per non-admitted outcome, a
  harness-class release reason registered in both release vocabularies
  AND the summary shape (class, retryability) in one record; the planner
  dispatch hook and daemon treat each halted release as a back-off tick.
"""
from __future__ import annotations

import json
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any

from aria_kernel.agent_runtime_profile import AgentRuntimeProfile
from aria_kernel.genesis_policy import _adaptive_runtime_policy
from aria_kernel.model_fleet import _FLEET, Provider
from aria_kernel.native_admission import (
    HALTING_OUTCOMES,
    AdmissionOutcome,
    _NativeRuntimeAdmission,
    _native_runtime_admission,
    native_admission_budget_seconds,
)
from aria_kernel.provider_cooldown import record_provider_cooldown
from aria_kernel.status_probe import (
    STATUS_PROBE_ATTEMPTS,
    STATUS_PROBE_BACKOFF_SECONDS,
    AdmissionClock,
    ProbeRecord,
    StatusDecision,
    _RuntimeStatusObservation,
    observe_until_decided,
    status_probe_liveness_seconds,
)
from aria_kernel.tool_registry import ensure_tools_dir

_REPO_ROOT = Path(__file__).resolve().parents[2]
_POC_DIR = _REPO_ROOT / "tools" / "aria-poc"
if str(_POC_DIR) not in sys.path:
    sys.path.insert(0, str(_POC_DIR))


def _available(auth_method: str = "subscription") -> _RuntimeStatusObservation:
    return _RuntimeStatusObservation("available", reason="fixture_available", auth_method=auth_method,
                                     control_status="available", control_reason="fixture_prepared",
                                     decision=StatusDecision.AVAILABLE)


def _stalled() -> _RuntimeStatusObservation:
    return _RuntimeStatusObservation("unknown", reason="status_timeout", command=("claude", "auth", "status", "--json"),
                                     decision=StatusDecision.UNDECIDED)


def _logged_out() -> _RuntimeStatusObservation:
    # The real CLI's shape: the document decided it, and the exit was 1.
    return _RuntimeStatusObservation("unavailable", reason="managed_session_logged_out", exit_code=1,
                                     decision=StatusDecision.UNAVAILABLE)


def _uncontained() -> _RuntimeStatusObservation:
    # The Claude arm after a decided-available auth on a host without a
    # usable sandbox: the vendor said yes, the controls could not be bound.
    return _RuntimeStatusObservation("available", reason="managed_session_logged_in", auth_method="subscription",
                                     control_status="unavailable", control_reason="sandbox_unavailable",
                                     decision=StatusDecision.AVAILABLE)


def _context_unprepared() -> _RuntimeStatusObservation:
    # The Codex arm when the managed context fails on the host before the
    # probe: nothing asked of the vendor, controls unavailable.
    return _RuntimeStatusObservation("unknown", reason="SandboxUnavailable", control_status="unavailable",
                                     control_reason="bwrap probe failed", decision=StatusDecision.UNDECIDED)


def _metered_bare_probe() -> _RuntimeStatusObservation:
    # A decided-available auth whose controls were never bound (the metered
    # policy's bare status probe): ineligible by policy, not a host fault.
    return _RuntimeStatusObservation("available", reason="cli_reported_managed_login", auth_method="chatgpt",
                                     decision=StatusDecision.AVAILABLE)


class _FakeClock:
    def __init__(self) -> None:
        self.now = 5_000.0
        self.slept: list[float] = []

    def monotonic(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.slept.append(seconds)
        self.now += seconds


def _clock(fake: _FakeClock, *, cap: float = 20.0, liveness: float | None = None) -> AdmissionClock:
    return AdmissionClock(attempt_cap_seconds=cap,
                          liveness_seconds=liveness if liveness is not None else status_probe_liveness_seconds(cap) * 3,
                          monotonic=fake.monotonic, sleep=fake.sleep)


class TheObservationIsThreeValuedByConstruction(unittest.TestCase):
    def test_the_decision_is_a_required_field_not_a_string(self) -> None:
        with self.assertRaises(TypeError):
            _RuntimeStatusObservation("unknown", reason="status_timeout")  # type: ignore[call-arg]
        self.assertEqual({member.value for member in StatusDecision}, {"available", "unavailable", "undecided"})

    def test_a_contradictory_row_cannot_be_built(self) -> None:
        with self.assertRaisesRegex(ValueError, "runtime_status_decision_contradicts_auth"):
            _RuntimeStatusObservation("unknown", reason="status_timeout", decision=StatusDecision.AVAILABLE)
        with self.assertRaisesRegex(ValueError, "runtime_status_auth_unavailable_not_decided"):
            _RuntimeStatusObservation("unavailable", reason="managed_session_logged_out",
                                      decision=StatusDecision.UNDECIDED)
        with self.assertRaisesRegex(ValueError, "runtime_status_auth_available_marked_undecided"):
            _RuntimeStatusObservation("available", reason="chat_completion_ok", decision=StatusDecision.UNDECIDED)
        with self.assertRaisesRegex(ValueError, "runtime_status_auth_observation_unknown_spelling"):
            _RuntimeStatusObservation("maybe", decision=StatusDecision.UNDECIDED)

    def test_a_quota_refusal_is_decided_unavailable_with_auth_still_available(self) -> None:
        # The Z.ai vendor answering 429: the auth row stays honest (the key
        # was accepted) and the DECISION is the vendor's no for this dispatch.
        row = _RuntimeStatusObservation("available", quota_observation="exhausted",
                                        reason="quota_or_rate_limited_http_429", decision=StatusDecision.UNAVAILABLE)
        self.assertIs(row.decision, StatusDecision.UNAVAILABLE)


class TheProbeIsRetriedToADecision(unittest.TestCase):
    def setUp(self) -> None:
        self.fake = _FakeClock()
        self.provider = _FLEET[0]

    def _script(self, answers: list[_RuntimeStatusObservation], spend: float = 20.0):
        offered: list[float] = []

        def observe(provider: Provider, timeout_seconds: float) -> _RuntimeStatusObservation:
            offered.append(timeout_seconds)
            self.fake.now += min(spend, timeout_seconds)
            return answers[len(offered) - 1]

        return observe, offered

    def test_a_probe_that_stalls_once_then_answers_is_decided_on_the_second_attempt(self) -> None:
        observe, offered = self._script([_stalled(), _available()])
        observed, record = observe_until_decided(self.provider, observe, _clock(self.fake))
        self.assertIs(observed.decision, StatusDecision.AVAILABLE)
        self.assertEqual(offered, [20.0, 20.0])
        self.assertEqual(record, ProbeRecord(attempts=2, undecided_reasons=("status_timeout",),
                                             backoff_seconds=STATUS_PROBE_BACKOFF_SECONDS[0]))
        self.assertEqual(self.fake.slept, [STATUS_PROBE_BACKOFF_SECONDS[0]])

    def test_a_probe_that_stalls_throughout_stays_undecided_with_every_attempt_recorded(self) -> None:
        observe, offered = self._script([_stalled()] * STATUS_PROBE_ATTEMPTS)
        started = self.fake.now
        observed, record = observe_until_decided(self.provider, observe, _clock(self.fake))
        self.assertIs(observed.decision, StatusDecision.UNDECIDED)
        self.assertEqual(observed.reason, "status_timeout")
        self.assertEqual(len(offered), STATUS_PROBE_ATTEMPTS)
        self.assertEqual(record.attempts, STATUS_PROBE_ATTEMPTS)
        # Every answer-less attempt, the last one included: the record reads
        # the same whichever bound ended the retry (the clock-elapsed path
        # below lists all of its attempts too).
        self.assertEqual(record.undecided_reasons, ("status_timeout",) * STATUS_PROBE_ATTEMPTS)
        self.assertEqual(len(record.undecided_reasons), record.attempts)
        self.assertEqual(record.backoff_seconds, sum(STATUS_PROBE_BACKOFF_SECONDS))
        self.assertEqual(self.fake.now - started, status_probe_liveness_seconds(20.0))

    def test_a_decided_refusal_is_never_retried(self) -> None:
        observe, offered = self._script([_logged_out(), _available()], spend=0.5)
        observed, record = observe_until_decided(self.provider, observe, _clock(self.fake))
        self.assertIs(observed.decision, StatusDecision.UNAVAILABLE)
        self.assertEqual(offered, [20.0])
        self.assertEqual(record, ProbeRecord(attempts=1, undecided_reasons=(), backoff_seconds=0.0))

    def test_the_clock_caps_an_attempt_and_refuses_one_it_cannot_afford(self) -> None:
        observe, offered = self._script([_stalled()] * STATUS_PROBE_ATTEMPTS)
        # 25 s of clock: one full attempt, a backoff, then five seconds
        # offered — after which nothing is left and the row says so.
        observed, record = observe_until_decided(self.provider, observe, _clock(self.fake, liveness=25.0))
        self.assertEqual(offered, [20.0, 25.0 - 20.0 - STATUS_PROBE_BACKOFF_SECONDS[0]])
        self.assertEqual(observed.reason, "status_deadline_elapsed")
        self.assertIs(observed.decision, StatusDecision.UNDECIDED)
        self.assertEqual(observed.command, ("claude", "auth", "status", "--json"))
        self.assertEqual(record.attempts, 2)
        self.assertEqual(record.undecided_reasons, ("status_timeout", "status_timeout"))
        self.assertEqual(len(record.undecided_reasons), record.attempts)


class _FleetFixture(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="aria-undecided-"))
        self.addCleanup(lambda: __import__("shutil").rmtree(self.root, ignore_errors=True))
        self.tools = ensure_tools_dir(self.root / "aria-tools")
        policy = self.root / "aria-config/genesis_policy.json"
        policy.parent.mkdir()
        policy.write_text(json.dumps({"executor": {"adaptive_runtime": {
            "schema_version": 1, "enabled": True, "policy_id": "aria/adaptive-runtime/v1",
            "provider_cooldown_seconds": 900, "recheck_timeout_seconds": 20,
            "max_attempts_per_dispatch": 2, "scarcity_judgment_mode": "independent_sessions",
            "monetary_admission": "managed_subscription",
        }}}) + "\n", encoding="utf-8")
        self.policy = _adaptive_runtime_policy(self.root)
        binaries = self.root / "bin"
        binaries.mkdir()
        for name in ("claude", "codex"):
            executable = binaries / name
            executable.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            executable.chmod(executable.stat().st_mode | stat.S_IXUSR)
        self.environ = {"PATH": str(binaries), "ARIA_ZAI_API_KEY_FILE": str(self.root / "zai.key")}
        self.read_only = AgentRuntimeProfile(agent_name="planner", model="opus", effort="max", source="frontmatter",
                                             tools=("Read", "Grep", "Glob"))
        self.fake = _FakeClock()
        self.probed: list[str] = []

    def _admit(self, answers: dict[str, list[_RuntimeStatusObservation]], cooled: dict | None = None) -> _NativeRuntimeAdmission:
        """`answers[provider]` is the observation of each successive attempt;
        a missing provider answers `available` at once."""
        seen: dict[str, int] = {}

        def observe(provider: Provider, timeout_seconds: float) -> _RuntimeStatusObservation:
            self.probed.append(provider.key)
            index = seen.get(provider.key, 0)
            seen[provider.key] = index + 1
            script = answers.get(provider.key)
            if script is None:
                return _available({"anthropic": "subscription", "zai": "subscription_api_key",
                                   "openai": "chatgpt"}[provider.key])
            answer = script[min(index, len(script) - 1)]
            if answer.decision is StatusDecision.UNDECIDED:
                self.fake.now += timeout_seconds
            return answer

        return _native_runtime_admission(
            repo_root=self.root, profile=self.read_only, policy=self.policy, environ=self.environ,
            observe_status=observe, cooled_providers=cooled or {}, clock=_clock(self.fake),
        )


class TheLadderMovesOnlyOnADecision(_FleetFixture):
    def test_anthropic_stalled_once_is_admitted_with_its_attempts_on_the_row(self) -> None:
        admission = self._admit({"anthropic": [_stalled(), _available()]})
        self.assertIs(admission.outcome, AdmissionOutcome.ADMITTED)
        self.assertEqual([route["provider"] for route in admission.eligible_routes], ["anthropic", "zai", "openai"])
        anthropic = admission.candidate_observations[0]
        self.assertEqual((anthropic["decision"], anthropic["status_reason"]), ("available", "fixture_available"))
        self.assertEqual(anthropic["probe"], {"attempts": 2, "undecided_reasons": ["status_timeout"],
                                              "backoff_seconds": STATUS_PROBE_BACKOFF_SECONDS[0]})

    def test_anthropic_stalled_throughout_halts_the_ladder_and_admits_nobody(self) -> None:
        # The trial-eleven shape: anthropic never answers, openai is up.
        admission = self._admit({"anthropic": [_stalled()] * STATUS_PROBE_ATTEMPTS})
        self.assertIs(admission.outcome, AdmissionOutcome.PROVIDER_UNDECIDED)
        self.assertEqual(admission.halting_provider, "anthropic")
        self.assertEqual(admission.eligible_routes, (), "nothing behind an undecided probe is admitted")
        rows = {row["provider"]: row for row in admission.candidate_observations}
        self.assertEqual((rows["anthropic"]["decision"], rows["anthropic"]["status_reason"]),
                         ("undecided", "status_timeout"))
        self.assertEqual(rows["anthropic"]["probe"]["attempts"], STATUS_PROBE_ATTEMPTS)
        self.assertEqual(rows["anthropic"]["probe"]["backoff_seconds"], sum(STATUS_PROBE_BACKOFF_SECONDS))
        # openai was observed and recorded available — and NOT admitted.
        self.assertEqual(rows["openai"]["decision"], "available")
        self.assertEqual(self.probed.count("anthropic"), STATUS_PROBE_ATTEMPTS)
        self.assertEqual(self.probed.count("openai"), 1)
        self.assertEqual(admission.as_row()["outcome"], "provider_undecided")

    def test_a_decided_unavailable_anthropic_fails_over_as_before(self) -> None:
        admission = self._admit({"anthropic": [_logged_out()]})
        self.assertIs(admission.outcome, AdmissionOutcome.ADMITTED)
        self.assertEqual([route["provider"] for route in admission.eligible_routes], ["zai", "openai"])
        self.assertEqual(admission.candidate_observations[0]["decision"], "unavailable")
        self.assertEqual(self.probed.count("anthropic"), 1)
        self.assertIsNone(admission.halting_provider)

    def test_a_cooled_anthropic_fails_over_as_before(self) -> None:
        from datetime import datetime, timezone

        cooldown = record_provider_cooldown(
            self.tools, provider="anthropic", model="opus", cooldown_seconds=900,
            request_id="AIR-1", claim_id="CL-1", detection={},
            now=datetime(2026, 9, 12, 20, 0, tzinfo=timezone.utc),
        )["details"]
        admission = self._admit({}, cooled={"anthropic": cooldown})
        self.assertIs(admission.outcome, AdmissionOutcome.ADMITTED)
        self.assertEqual([route["provider"] for route in admission.eligible_routes], ["zai", "openai"])
        self.assertNotIn("anthropic", self.probed, "a cooled provider is decided by the ledger, never probed")
        self.assertEqual(admission.candidate_observations[0]["decision"], "unavailable")
        self.assertEqual(admission.candidate_observations[0]["probe"]["attempts"], 0)

    def test_a_later_ranked_undecided_provider_is_skipped_not_cooled(self) -> None:
        admission = self._admit({"zai": [_stalled()] * STATUS_PROBE_ATTEMPTS})
        self.assertIs(admission.outcome, AdmissionOutcome.ADMITTED)
        self.assertEqual([route["provider"] for route in admission.eligible_routes], ["anthropic", "openai"])
        zai = admission.candidate_observations[1]
        self.assertEqual(zai["decision"], "undecided")
        self.assertNotIn("quota_cooldown", zai)
        self.assertIsNone(admission.halting_provider)

    def test_the_first_provider_still_in_contention_is_the_one_that_halts(self) -> None:
        # anthropic decided no (the ladder may pass it); zai never answers:
        # the ladder stops at zai — openai is not reached by failover past
        # a probe that did not answer.
        admission = self._admit({"anthropic": [_logged_out()], "zai": [_stalled()] * STATUS_PROBE_ATTEMPTS})
        self.assertIs(admission.outcome, AdmissionOutcome.PROVIDER_UNDECIDED)
        self.assertEqual(admission.halting_provider, "zai")
        self.assertEqual(admission.eligible_routes, ())
        self.assertEqual(admission.candidate_observations[2]["decision"], "available")

    def test_every_provider_decided_and_none_eligible_is_still_no_eligible_provider(self) -> None:
        admission = self._admit({"anthropic": [_logged_out()], "zai": [_logged_out()], "openai": [_logged_out()]})
        self.assertIs(admission.outcome, AdmissionOutcome.NO_ELIGIBLE_PROVIDER)
        self.assertEqual(admission.eligible_routes, ())
        self.assertIsNone(admission.halting_provider)

    def test_the_admission_type_refuses_a_contradiction(self) -> None:
        with self.assertRaisesRegex(ValueError, "native_admission_outcome_contradicts_routes"):
            _NativeRuntimeAdmission("sha256:x", (), (), AdmissionOutcome.ADMITTED, None)
        for halting in HALTING_OUTCOMES:
            with self.assertRaisesRegex(ValueError, "native_admission_halting_provider_contradicts_outcome"):
                _NativeRuntimeAdmission("sha256:x", (), (), halting, None)
            with self.assertRaisesRegex(ValueError, "native_admission_outcome_contradicts_routes"):
                _NativeRuntimeAdmission("sha256:x", (), ({"provider": "openai"},), halting, "anthropic")
        with self.assertRaisesRegex(ValueError, "native_admission_halting_provider_contradicts_outcome"):
            _NativeRuntimeAdmission("sha256:x", (), (), AdmissionOutcome.NO_ELIGIBLE_PROVIDER, "anthropic")
        self.assertEqual(HALTING_OUTCOMES, {AdmissionOutcome.PROVIDER_UNDECIDED, AdmissionOutcome.PROVIDER_CONTROL_UNAVAILABLE})


class TheLadderHaltsOnAnUnbindableHost(_FleetFixture):
    """Verifier, 2026-09-12: a decided-available auth whose controls this host
    could not bind was neither eligible nor undecided, so the ladder moved
    past it and ran the next vendor on a fact that is not an auth reason."""

    def test_anthropic_available_but_uncontained_halts_the_ladder_by_name(self) -> None:
        admission = self._admit({"anthropic": [_uncontained()]})
        # The defect, first: pre-fix this admitted zai/openai past anthropic.
        self.assertEqual(admission.eligible_routes, (), "a missing sandbox never admits another vendor")
        self.assertIs(admission.outcome, AdmissionOutcome.PROVIDER_CONTROL_UNAVAILABLE)
        self.assertEqual(admission.halting_provider, "anthropic")
        rows = {row["provider"]: row for row in admission.candidate_observations}
        self.assertEqual((rows["anthropic"]["decision"], rows["anthropic"]["controls"]),
                         ("available", {"status": "unavailable", "reason": "sandbox_unavailable"}))
        self.assertEqual(rows["anthropic"]["probe"]["attempts"], 1, "a decided auth is not retried")
        self.assertEqual(rows["openai"]["decision"], "available", "observed for the record, not admitted")
        self.assertEqual(admission.as_row()["outcome"], "provider_control_unavailable")

    def test_a_codex_context_that_cannot_be_prepared_halts_the_same_way(self) -> None:
        # anthropic decided no; openai's managed context fails on the host
        # (undecided, controls unavailable) throughout its bound: the same
        # host fault, the same name — never `provider_undecided`.
        admission = self._admit({"anthropic": [_logged_out()], "zai": [_logged_out()],
                                 "openai": [_context_unprepared()] * STATUS_PROBE_ATTEMPTS})
        self.assertIs(admission.outcome, AdmissionOutcome.PROVIDER_CONTROL_UNAVAILABLE)
        self.assertEqual(admission.halting_provider, "openai")
        self.assertEqual(admission.eligible_routes, ())
        self.assertEqual(self.probed.count("openai"), STATUS_PROBE_ATTEMPTS, "retried within the bound first")

    def test_controls_never_bound_is_the_policys_ineligibility_not_a_halt(self) -> None:
        # The metered policy's bare probe: decided available, controls
        # "unknown" (never attempted). Passed by name, so the fleet still
        # reaches `no_eligible_provider` exactly as before.
        admission = self._admit({"anthropic": [_logged_out()], "zai": [_logged_out()],
                                 "openai": [_metered_bare_probe()]})
        self.assertIs(admission.outcome, AdmissionOutcome.NO_ELIGIBLE_PROVIDER)
        self.assertIsNone(admission.halting_provider)

    def test_an_uncontained_provider_behind_an_eligible_one_is_skipped(self) -> None:
        admission = self._admit({"zai": [_uncontained()]})
        self.assertIs(admission.outcome, AdmissionOutcome.ADMITTED)
        self.assertEqual([route["provider"] for route in admission.eligible_routes], ["anthropic", "openai"])
        self.assertIsNone(admission.halting_provider)


class TheClockBoundsTheWholeFleet(_FleetFixture):
    def test_the_arithmetic(self) -> None:
        per_provider = STATUS_PROBE_ATTEMPTS * 20.0 + sum(STATUS_PROBE_BACKOFF_SECONDS)
        self.assertEqual(status_probe_liveness_seconds(20.0), per_provider)
        self.assertEqual(native_admission_budget_seconds(self.policy), per_provider * len(_FLEET))
        self.assertEqual(native_admission_budget_seconds(self.policy), (3 * 20.0 + 2.0 + 5.0) * 3)

    def test_a_fleet_that_never_answers_spends_exactly_the_bound_and_no_more(self) -> None:
        started = self.fake.now
        admission = self._admit({key: [_stalled()] * STATUS_PROBE_ATTEMPTS for key in ("anthropic", "zai", "openai")})
        self.assertEqual(self.fake.now - started, native_admission_budget_seconds(self.policy))
        self.assertIs(admission.outcome, AdmissionOutcome.PROVIDER_UNDECIDED)
        self.assertEqual(admission.halting_provider, "anthropic")
        self.assertEqual({row["provider"]: row["status_reason"] for row in admission.candidate_observations},
                         {"anthropic": "status_timeout", "zai": "status_timeout", "openai": "status_timeout"})


class TheReleaseReasonIsRegisteredEverywhere(unittest.TestCase):
    def test_the_executor_names_a_harness_release_per_non_admitted_outcome(self) -> None:
        import ci_executor
        from aria_kernel.agent_invocations import HARNESS_FAULT_RELEASE_REASONS, classify_release_reason
        from aria_kernel.release_reason import (
            NATIVE_RUNTIME_CONTROL_UNAVAILABLE, NATIVE_RUNTIME_PROVIDER_UNDECIDED, RELEASE_REASON_CODES,
            parse_release_reason,
        )

        table = ci_executor.ADMISSION_REFUSALS
        self.assertEqual(set(table), {outcome.value for outcome in AdmissionOutcome} - {"admitted"})
        self.assertEqual(table["provider_undecided"].release_reason, NATIVE_RUNTIME_PROVIDER_UNDECIDED)
        self.assertEqual(table["provider_control_unavailable"].release_reason, NATIVE_RUNTIME_CONTROL_UNAVAILABLE)
        for kind in (*table.values(), ci_executor.TASK_BINDING_REFUSAL):
            reason = kind.release_reason
            self.assertIn(reason, HARNESS_FAULT_RELEASE_REASONS, reason)
            self.assertEqual(classify_release_reason(reason), "harness")
            parsed = parse_release_reason(reason)
            self.assertIn(parsed.reason_code, RELEASE_REASON_CODES)
            self.assertEqual(parsed.fault_domain, "harness")
        self.assertEqual(parse_release_reason(NATIVE_RUNTIME_PROVIDER_UNDECIDED).reason_code,
                         "NATIVE_RUNTIME_PROVIDER_UNDECIDED")
        self.assertEqual(parse_release_reason(NATIVE_RUNTIME_CONTROL_UNAVAILABLE).reason_code,
                         "NATIVE_RUNTIME_CONTROL_UNAVAILABLE")

    def test_each_halted_outcome_summarises_as_a_retryable_harness_refusal(self) -> None:
        # Verifier, 2026-09-12: a stalled host was released as a harness
        # fault but summarised `policy_violation` / not retryable. The kind
        # record carries both, so the two vocabularies cannot drift apart.
        import ci_executor
        from dispatch_failure import DISPATCH_FAILURE_CLASSES

        table = ci_executor.ADMISSION_REFUSALS
        for outcome in HALTING_OUTCOMES:
            kind = table[outcome.value]
            self.assertEqual((kind.failure_class, kind.retryable), ("harness_unavailable", True), outcome)
        self.assertEqual((table["no_eligible_provider"].failure_class, table["no_eligible_provider"].retryable),
                         ("policy_violation", False))
        self.assertEqual((ci_executor.TASK_BINDING_REFUSAL.failure_class, ci_executor.TASK_BINDING_REFUSAL.retryable),
                         ("policy_violation", False))
        for kind in (*table.values(), ci_executor.TASK_BINDING_REFUSAL):
            self.assertIn(kind.failure_class, DISPATCH_FAILURE_CLASSES)

    def test_a_refusal_carries_its_kind_by_construction(self) -> None:
        import ci_executor
        import inspect

        parameters = inspect.signature(ci_executor._refuse_native_admission).parameters
        self.assertIn("kind", parameters)
        self.assertIs(parameters["kind"].default, inspect.Parameter.empty)
        self.assertIn("release_reason", ci_executor._NativeAdmissionRefusal.__dataclass_fields__)
        self.assertEqual(set(ci_executor._AdmissionRefusalKind.__dataclass_fields__),
                         {"release_reason", "failure_class", "retryable"})


class TheHookAndTheDaemonBackOff(unittest.TestCase):
    def setUp(self) -> None:
        import os
        from unittest.mock import patch

        self.tmp = Path(tempfile.mkdtemp(prefix="aria-undecided-hook-"))
        self.addCleanup(lambda: __import__("shutil").rmtree(self.tmp, ignore_errors=True))
        self.tools = ensure_tools_dir(self.tmp / "aria-tools")
        env = patch.dict(os.environ, {"ARIA_WORKSPACE_BASE": str(self.tmp / "workspaces")})
        env.start()
        self.addCleanup(env.stop)
        self._cwd = os.getcwd()
        os.chdir(self.tmp)
        self.addCleanup(os.chdir, self._cwd)

    def _seed_request(self, request_id: str) -> None:
        from tests._helpers.declared_fixtures import append_declared_fixture

        requests_path = self.tools / "agent-invocations" / "requests.jsonl"
        requests_path.parent.mkdir(parents=True, exist_ok=True)
        append_declared_fixture(requests_path, {
            "$schema": "aria/agent-invocation-request/v1", "schema_version": 1,
            "request_id": request_id, "role": "primary_plan", "target_agent": "aria-primary-planner",
            "suggested_prompt": "plan", "must_satisfy": [{"id": "S1"}], "evidence_refs": [],
            "allowed_scope": ["aria-kernel/**"], "expected_output_path": str(self.tmp / "out.json"),
            "state": "pending", "created_at": "2026-09-12T20:42:00Z",
        }, expected_surface="agent_invocation_requests")

    def test_the_hook_reports_provider_undecided_when_the_child_released_under_it(self) -> None:
        import subprocess
        from unittest.mock import patch
        from aria_kernel import planner_dispatch_hook as hook
        from aria_kernel.agent_invocations import derive_request_state, release_claim
        from aria_kernel.release_reason import NATIVE_RUNTIME_PROVIDER_UNDECIDED

        self._seed_request("REQ-UNDECIDED")

        def child(argv: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
            # The executor child: admission `provider_undecided`, the claim
            # handed back by name, exit 0 (a refusal is not a build failure).
            metadata = json.loads(Path(kwargs["env"][hook.CLAIM_METADATA_FILE_ENV_VAR]).read_text(encoding="utf-8"))
            release_claim(claim_id=metadata["claim_id"], agent_id=metadata["agent_id"],
                          lease_token=kwargs["env"][hook.LEASE_TOKEN_ENV_VAR],
                          reason=NATIVE_RUNTIME_PROVIDER_UNDECIDED, base_dir=self.tools)
            return subprocess.CompletedProcess(argv, 0, stdout="", stderr="")

        with patch.object(hook.subprocess, "run", child):
            result = hook.dispatch_one_pending_planner_request(base_dir=self.tools, agent_id="daemon:test:107")
        self.assertEqual(result["status"], hook.PROVIDER_UNDECIDED_STATUS)
        self.assertEqual(result["exit_code"], 0)
        self.assertEqual(derive_request_state(request_id="REQ-UNDECIDED", base_dir=self.tools), "REQUEUED")
        governance = [json.loads(line) for line in (self.tools / "governance.jsonl").read_text().splitlines() if line.strip()]
        kinds = [row["kind"] for row in governance]
        self.assertIn("planner_dispatch_provider_undecided", kinds)
        self.assertNotIn("planner_dispatch_release_refused", kinds)
        claims = [json.loads(line) for line in (self.tools / "agent-invocations/claims.jsonl").read_text().splitlines() if line.strip()]
        released = [row for row in claims if row.get("event") == "released"]
        self.assertEqual([row["reason"] for row in released], [NATIVE_RUNTIME_PROVIDER_UNDECIDED])
        self.assertEqual(released[0]["fault_domain"], "harness")

    def test_the_hook_reports_provider_control_unavailable_when_the_child_released_under_it(self) -> None:
        import subprocess
        from unittest.mock import patch
        from aria_kernel import planner_dispatch_hook as hook
        from aria_kernel.agent_invocations import derive_request_state, release_claim
        from aria_kernel.release_reason import NATIVE_RUNTIME_CONTROL_UNAVAILABLE

        self._seed_request("REQ-UNCONTAINED")

        def child(argv: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
            metadata = json.loads(Path(kwargs["env"][hook.CLAIM_METADATA_FILE_ENV_VAR]).read_text(encoding="utf-8"))
            release_claim(claim_id=metadata["claim_id"], agent_id=metadata["agent_id"],
                          lease_token=kwargs["env"][hook.LEASE_TOKEN_ENV_VAR],
                          reason=NATIVE_RUNTIME_CONTROL_UNAVAILABLE, base_dir=self.tools)
            return subprocess.CompletedProcess(argv, 0, stdout="", stderr="")

        with patch.object(hook.subprocess, "run", child):
            result = hook.dispatch_one_pending_planner_request(base_dir=self.tools, agent_id="daemon:test:107c")
        self.assertEqual(result["status"], hook.PROVIDER_CONTROL_UNAVAILABLE_STATUS)
        self.assertIn(result["status"], hook.ADMISSION_BACKOFF_STATUSES)
        self.assertEqual(derive_request_state(request_id="REQ-UNCONTAINED", base_dir=self.tools), "REQUEUED")
        governance = [json.loads(line) for line in (self.tools / "governance.jsonl").read_text().splitlines() if line.strip()]
        self.assertIn("planner_dispatch_provider_control_unavailable", [row["kind"] for row in governance])
        self.assertEqual(hook.ADMISSION_BACKOFF_STATUSES, frozenset(hook.ADMISSION_HALT_STATUSES.values()))

    def test_the_daemon_sleeps_the_poll_interval_and_counts_no_dispatch(self) -> None:
        from aria_kernel.autonomous_planner_dispatcher import run_planner_dispatch_daemon
        from aria_kernel.planner_dispatch_hook import PROVIDER_CONTROL_UNAVAILABLE_STATUS, PROVIDER_UNDECIDED_STATUS

        (self.tools / "repo_identity.json").write_text(json.dumps({
            "aria_tools_contract_version": 2, "bound_repo_hash": None, "bound_repo_root": None, "schema_version": 2,
        }, indent=2, sort_keys=True), encoding="utf-8")
        responses = iter([
            {"status": PROVIDER_UNDECIDED_STATUS, "request_id": "REQ-U", "claim_id": "CL-U", "exit_code": 0,
             "governance_event_count": 3, "stderr_redacted": ""},
            {"status": PROVIDER_CONTROL_UNAVAILABLE_STATUS, "request_id": "REQ-C", "claim_id": "CL-C", "exit_code": 0,
             "governance_event_count": 3, "stderr_redacted": ""},
            {"status": "dispatched", "request_id": "REQ-D", "claim_id": "CL-D", "exit_code": 0,
             "governance_event_count": 3, "stderr_redacted": ""},
        ])
        slept: list[float] = []
        result = run_planner_dispatch_daemon(
            base_dir=self.tools, max_iterations=3, poll_interval_seconds=7.5,
            invoke_planner=lambda **_: next(responses), sleep=slept.append, daemon_id="undecided-test",
        )
        self.assertEqual(result["iterations"], 3)
        self.assertEqual(result["claims_dispatched"], 1, "a halted tick is not a dispatch")
        self.assertEqual(slept, [7.5, 7.5], "the daemon backs off one poll interval on each halted admission")
        governance = [json.loads(line) for line in (self.tools / "governance.jsonl").read_text().splitlines() if line.strip()]
        completed = [row["details"]["status"] for row in governance if row["kind"] == "planner_dispatch_iteration_completed"]
        self.assertEqual(completed, [PROVIDER_UNDECIDED_STATUS, PROVIDER_CONTROL_UNAVAILABLE_STATUS, "dispatched"])


if __name__ == "__main__":
    unittest.main()
