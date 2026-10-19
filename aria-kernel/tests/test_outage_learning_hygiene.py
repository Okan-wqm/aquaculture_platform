"""ARIA-HIGH-367 — outage-killed work teaches nothing, and a closed plan's queue closes.

Measured before the fix (origin/main 958eed5b7):

* (the drafter-scoring half of H3 is ARIA-HIGH-370's ``failure_attribution``,
  whose evidence allowlist leaves every harness-class outage release
  unattributed; not re-tested here)
* ``finding_grounding`` put every failed plan's finding on the 7-day
  re-planning cool-off, outage or not (H3);
* an ABANDONED plan's PENDING requests stayed claimable, so the recovered
  provider's first quota went to answers no plan could take (H4);
* ``derive_request_state`` returned HUMAN_REQUIRED for any ``human_required``
  row before the fault-domain re-derivation could run, so a request
  escalated on harness-class releases was stuck forever (M2:
  AIR-aria-autonomy-planner-eb17609b38b1, three ``claude_cli_exit_1``);
* a lease that ran out inside an outage was charged to the request (M1).
"""
from __future__ import annotations

import shutil
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from aria_kernel.agent_invocations import derive_request_state
from aria_kernel.plan_convergence import abandon_plan, start_plan
from aria_kernel.provider_cooldown import record_provider_cooldown
from aria_kernel.tool_registry import ensure_tools_dir

from tests._helpers.declared_fixtures import append_declared_fixture

_T0 = datetime(2026, 10, 1, 3, 0, 0, tzinfo=timezone.utc)


def _iso(moment: datetime) -> str:
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


class _Store(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="aria-outage-hygiene-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        self.tools = ensure_tools_dir(self.root / "aria-tools")

    def outage(self, start: datetime, end: datetime | None) -> None:
        record_provider_cooldown(self.tools, provider="anthropic", model="opus", cooldown_seconds=900,
                                 request_id="AIR-out", claim_id="CL-out",
                                 detection={"signature": "claude_credit_error"}, now=start)
        if end is not None:
            from aria_kernel.provider_outage_ledger import record_provider_restored

            record_provider_restored(self.tools, provider="anthropic", seam="spawn", request_id="AIR-ok", now=end)

    def request(self, request_id: str, *, plan_id: str = "plan-h", role: str = "primary_plan") -> None:
        append_declared_fixture(self.tools / "agent-invocations" / "requests.jsonl", {
            "schema_version": 1, "request_id": request_id, "role": role, "convergence_id": plan_id,
            "target_agent": "aria-primary-planner", "state": "pending", "created_at": _iso(_T0),
        }, expected_surface="agent_invocation_requests")

    def claim_row(self, **row: object) -> None:
        append_declared_fixture(self.tools / "agent-invocations" / "claims.jsonl", {"schema_version": 1, **row},
                                expected_surface="agent_invocation_claims")


class H3TheFindingIsNotCooledOffForAnOutage(_Store):
    def test_an_unanswered_wait_an_outage_overlapped_is_the_lanes(self) -> None:
        from aria_kernel.outage_attribution import failure_is_lane_fault
        from aria_kernel.provider_clock import provider_clock

        event = {"event_type": "plan_evaluated",
                 "payload": {"terminal_state": "HUMAN_REQUIRED", "reason_codes": ["pending_tasks_present"]}}
        wait = {"waited_since": _T0, "at": _T0 + timedelta(days=3)}
        self.assertFalse(failure_is_lane_fault(event, clock=provider_clock(self.tools), **wait))
        self.outage(_T0 + timedelta(hours=1), _T0 + timedelta(days=2))
        self.assertTrue(failure_is_lane_fault(event, clock=provider_clock(self.tools), **wait))
        answered = {"event_type": "plan_evaluated", "payload": {
            "terminal_state": "HUMAN_REQUIRED", "reason_codes": ["material_cross_review_risks_present"]}}
        self.assertFalse(failure_is_lane_fault(answered, clock=provider_clock(self.tools), **wait))

    def _failed_at(self, *, stall_cause: str) -> datetime | None:
        from aria_kernel.finding_grounding import _fold_plans

        start_plan(plan_id="plan-h", initial_revision_id="rev-0", base_dir=self.tools, plan_content={
            "schema_version": 1, "title": "t", "summary": "s", "key_changes": ["c"],
            "affected_surfaces": [{"paths": ["aria-kernel/aria_kernel/plan_convergence.py"]}],
            "validation_commands": [{"cmd": "true"}], "evidence_refs": ["docs/aria/SPEC.md"],
        })
        from aria_kernel.release_reason import parse_release_reason

        abandon_plan(plan_id="plan-h", reason=f"stalled:{stall_cause}", base_dir=self.tools,
                     stall={"cause": stall_cause, **parse_release_reason(stall_cause).to_row_fields()})
        plan = next(p for p in _fold_plans(self.tools, datetime.now(timezone.utc)) if p.plan_id == "plan-h")
        return plan.failed_at

    def test_a_harness_class_stall_leaves_the_finding_plannable(self) -> None:
        self.assertIsNone(self._failed_at(stall_cause="provider_quota_unavailable:anthropic"))

    def test_a_request_class_stall_still_cools_the_finding(self) -> None:
        self.assertIsNotNone(self._failed_at(stall_cause="submit_rejected"))


class H4AnAbandonedPlansQueueClosesWithIt(_Store):
    def test_unclaimed_requests_cancel_and_a_held_claim_is_left_to_its_lease(self) -> None:
        from aria_kernel.agent_invocations import next_pending_request

        start_plan(plan_id="plan-h", initial_revision_id="rev-0", base_dir=self.tools, plan_content={
            "schema_version": 1, "title": "t", "summary": "s", "key_changes": ["c"],
            "affected_surfaces": [{"paths": ["aria-kernel/aria_kernel/plan_convergence.py"]}],
            "validation_commands": [{"cmd": "true"}], "evidence_refs": ["docs/aria/SPEC.md"],
        })
        self.request("AIR-queued")
        self.request("AIR-held")
        now = datetime.now(timezone.utc)
        self.claim_row(event="claimed", claim_id="CL-held", request_id="AIR-held", agent_id="a",
                       claimed_at=_iso(now), lease_expires_at=_iso(now + timedelta(hours=1)))
        abandon_plan(plan_id="plan-h", reason="stalled:no_consumer", base_dir=self.tools)
        self.assertEqual(derive_request_state(request_id="AIR-queued", base_dir=self.tools), "CANCELLED")
        self.assertEqual(derive_request_state(request_id="AIR-held", base_dir=self.tools), "CLAIMED")
        self.assertIsNone(next_pending_request(base_dir=self.tools))

    def test_the_sweep_closes_a_plan_abandoned_before_the_closure_existed(self) -> None:
        from aria_kernel.agent_invocations import sweep_expired_anchors
        from aria_kernel.plan_convergence import _append_event, _idempotency_key, _plan_lock

        start_plan(plan_id="plan-h", initial_revision_id="rev-0", base_dir=self.tools, plan_content={
            "schema_version": 1, "title": "t", "summary": "s", "key_changes": ["c"],
            "affected_surfaces": [{"paths": ["aria-kernel/aria_kernel/plan_convergence.py"]}],
            "validation_commands": [{"cmd": "true"}], "evidence_refs": ["docs/aria/SPEC.md"],
        })
        self.request("AIR-legacy")
        payload = {"reason": "stalled:no_consumer", "abandoned_from_state": "STARTED"}
        with _plan_lock(self.tools):  # the abandonment as origin/main wrote it: no closure
            _append_event(root=self.tools, plan_id="plan-h", event_type="plan_abandoned", payload=payload,
                          idempotency_key=_idempotency_key("plan-h", "abandon", payload))
        self.assertEqual(derive_request_state(request_id="AIR-legacy", base_dir=self.tools), "PENDING")
        sweep_expired_anchors(base_dir=self.tools, now=datetime.now(timezone.utc))
        self.assertEqual(derive_request_state(request_id="AIR-legacy", base_dir=self.tools), "CANCELLED")


class H4AHealedEscalationInAnAbandonedPlanCloses(_Store):
    def test_review_medium_4(self) -> None:
        start_plan(plan_id="plan-h", initial_revision_id="rev-0", base_dir=self.tools, plan_content={
            "schema_version": 1, "title": "t", "summary": "s", "key_changes": ["c"],
            "affected_surfaces": [{"paths": ["aria-kernel/aria_kernel/plan_convergence.py"]}],
            "validation_commands": [{"cmd": "true"}], "evidence_refs": ["docs/aria/SPEC.md"],
        })
        self.request("AIR-healed")
        for index in (1, 2, 3):
            at = _iso(_T0 + timedelta(days=index))
            self.claim_row(event="claimed", claim_id=f"CL-{index}", request_id="AIR-healed", agent_id="a",
                           claimed_at=at, lease_expires_at=_iso(_T0 + timedelta(days=index, hours=1)))
            self.claim_row(event="released", claim_id=f"CL-{index}", request_id="AIR-healed", agent_id="a",
                           reason="claude_cli_exit_1", released_at=at)
            self.claim_row(event="requeued" if index < 3 else "human_required", claim_id=f"CL-{index}",
                           request_id="AIR-healed", reason="claude_cli_exit_1", requeue_count=index, at=at)
        self.assertEqual(derive_request_state(request_id="AIR-healed", base_dir=self.tools), "PENDING")
        abandon_plan(plan_id="plan-h", reason="stalled:no_consumer", base_dir=self.tools)
        self.assertEqual(derive_request_state(request_id="AIR-healed", base_dir=self.tools), "CANCELLED")


class M2AHarnessOnlyEscalationIsReDerived(_Store):
    def _released(self, request_id: str, reason: str, last_event: str) -> None:
        for index, event in enumerate(("requeued", "requeued", last_event), start=1):
            at = _iso(_T0 + timedelta(days=index))
            self.claim_row(event="claimed", claim_id=f"CL-{index}", request_id=request_id, agent_id="a",
                           claimed_at=at, lease_expires_at=_iso(_T0 + timedelta(days=index, hours=1)))
            self.claim_row(event="released", claim_id=f"CL-{index}", request_id=request_id, agent_id="a",
                           reason=reason, released_at=at)
            self.claim_row(event=event, claim_id=f"CL-{index}", request_id=request_id, reason=reason,
                           requeue_count=index, at=at)

    def test_three_provider_class_releases_no_longer_pin_human_required(self) -> None:
        self.request("AIR-stuck")
        self._released("AIR-stuck", "claude_cli_exit_1", "human_required")
        self.assertEqual(derive_request_state(request_id="AIR-stuck", base_dir=self.tools), "PENDING")

    def test_a_deliberate_escalation_stands(self) -> None:
        self.request("AIR-refused")
        self.claim_row(event="claimed", claim_id="CL-1", request_id="AIR-refused", agent_id="a",
                       claimed_at=_iso(_T0), lease_expires_at=_iso(_T0 + timedelta(hours=1)))
        self.claim_row(event="human_required", claim_id="CL-1", request_id="AIR-refused",
                       reason="agent_refused:evidence", requeue_count=1, at=_iso(_T0))
        self.assertEqual(derive_request_state(request_id="AIR-refused", base_dir=self.tools), "HUMAN_REQUIRED")

    def test_three_charged_releases_still_escalate(self) -> None:
        self.request("AIR-poison")
        self._released("AIR-poison", "submit_rejected", "human_required")
        self.assertEqual(derive_request_state(request_id="AIR-poison", base_dir=self.tools), "HUMAN_REQUIRED")


class M1ALeaseAnOutageAteIsNotCharged(_Store):
    def _reap(self) -> dict:
        from aria_kernel.agent_invocations import reap_stale_claims

        self.request("AIR-1")
        self.claim_row(event="claimed", claim_id="CL-1", request_id="AIR-1", agent_id="a",
                       claimed_at=_iso(_T0), lease_expires_at=_iso(_T0 + timedelta(hours=1)))
        return reap_stale_claims(base_dir=self.tools, now=_T0 + timedelta(hours=2))

    def test_the_expiry_names_the_outage_and_charges_nothing(self) -> None:
        self.outage(_T0 + timedelta(minutes=10), None)
        followup = self._reap()["requeued"][0]
        self.assertEqual((followup["reason"], followup["requeue_count"]),
                         ("lease_expired_during_provider_outage:anthropic", 0))
        self.assertEqual(derive_request_state(request_id="AIR-1", base_dir=self.tools), "REQUEUED")

    def test_a_blip_that_ended_inside_the_lease_does_not_waive_the_charge(self) -> None:
        """Review MEDIUM-3: a 2-minute outage, over before the lease ran out, is not the provider's."""
        self.outage(_T0 + timedelta(minutes=10), _T0 + timedelta(minutes=12))
        followup = self._reap()["requeued"][0]
        self.assertEqual((followup["reason"], followup["requeue_count"]), ("lease_expired", 1))

    def test_an_outage_covering_most_of_the_lease_owns_it_even_if_over(self) -> None:
        self.outage(_T0 + timedelta(minutes=5), _T0 + timedelta(minutes=50))
        followup = self._reap()["requeued"][0]
        self.assertEqual(followup["requeue_count"], 0)

    def test_with_no_outage_the_lease_is_still_the_requests(self) -> None:
        followup = self._reap()["requeued"][0]
        self.assertEqual((followup["reason"], followup["requeue_count"]), ("lease_expired", 1))


class M444TheLeaseIsJudgedByTheProviderTheClaimRanOn(M1ALeaseAnOutageAteIsNotCharged):
    """ARIA-MEDIUM-444 — since ARIA-HIGH-434 a Claude-headed seat runs on Z.ai while Claude is
    cooled. The head's outage waived a Z.ai run that hung, so it was re-run uncharged for as long
    as Claude stayed out. The route is the claim's newest native attempt row, as
    `budget._reserve_native_runtime_attempt` writes it."""

    def attempt(self, provider: str, *, attempt_id: str = "ATT-1") -> None:
        from aria_kernel.independence_check import RUNTIME_ATTEMPT_STARTED_KIND
        from aria_kernel.tool_registry import append_tools_governance

        append_tools_governance(self.tools, RUNTIME_ATTEMPT_STARTED_KIND, {
            "schema_version": 1, "attempt_id": attempt_id, "request_id": "AIR-1", "claim_id": "CL-1",
            "provider": provider, "runtime": provider, "model": f"{provider}-model"})

    def test_a_zai_run_that_hung_while_claude_was_out_is_charged(self) -> None:
        self.outage(_T0 + timedelta(minutes=10), None)
        self.attempt("zai")
        followup = self._reap()["requeued"][0]
        self.assertEqual((followup["reason"], followup["requeue_count"]), ("lease_expired", 1))

    def test_a_run_the_outage_did_hit_is_still_waived(self) -> None:
        self.outage(_T0 + timedelta(minutes=10), None)
        self.attempt("zai")
        self.attempt("anthropic", attempt_id="ATT-2")  # the newest attempt is the route the lease held
        followup = self._reap()["requeued"][0]
        self.assertEqual((followup["reason"], followup["requeue_count"]),
                         ("lease_expired_during_provider_outage:anthropic", 0))

    def test_the_fixture_row_is_the_writers_shape(self) -> None:
        import inspect

        from aria_kernel import budget

        source = inspect.getsource(budget._reserve_native_runtime_attempt)
        for field in ('"claim_id": claim_id', '"provider": provider', 'kind="runtime_attempt_started"'):
            self.assertIn(field, source)


class _SpawnRungHung(Exception):
    """The spawn lane's Z.ai rung never returned: its lease will run out."""


class L445TheSpawnLaneRecordsTheRouteItsClaimRanOn(_Store):
    """ARIA-LOW-445 — the native and worker lanes record the provider a claim ran on
    (ARIA-MEDIUM-444); the spawn lane (adaptive runtime off) recorded nothing, so
    `attempt_providers_by_claim` fell back to the ladder head. A spawn-lane run on the Z.ai
    rung that hung while Claude was cooled was waived as Claude's outage and re-run
    uncharged for as long as Claude stayed out. Driven through the real `invoke_claude_cli`
    with only the rung's transport replaced."""

    def setUp(self) -> None:
        import os
        import sys
        from unittest.mock import patch

        super().setUp()
        poc = Path(__file__).resolve().parents[2] / "tools" / "aria-poc"
        if str(poc) not in sys.path:
            sys.path.insert(0, str(poc))
        import ci_executor

        self.repo = self.root / "workspace"
        (self.repo / "aria-config").mkdir(parents=True)
        (self.repo / "aria-config" / "genesis_policy.json").write_text(
            '{"cost_caps_usd": {"daily": 1000.0, "monthly": 10000.0, "per_run": 1000.0}}\n', encoding="utf-8")
        self.tools = ensure_tools_dir(self.repo / "aria-tools")
        self.prompt = self.root / "prompt.md"
        self.prompt.write_text("# request\n", encoding="utf-8")
        runner_temp = self.root / "runner-temp"
        runner_temp.mkdir()
        environment = patch.dict(os.environ, {"RUNNER_TEMP": str(runner_temp)})
        environment.start()
        self.addCleanup(environment.stop)
        os.environ.pop("GITHUB_OUTPUT", None)
        for name, value in (("_REPO_ROOT", self.repo), ("_MOCK_MODE_AT_ENTRY", False)):
            patcher = patch.object(ci_executor, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.ci_executor = ci_executor

    def _spawn_on_the_zai_rung(self) -> None:
        from unittest.mock import patch

        def ladder(*, run, model, failover, effort, write_capable, on_credit):  # noqa: ANN001, ANN202, ARG001
            return run("glm-5.3", effort)  # Claude is cooled: the Z.ai rung runs first

        def hung(**_kwargs):  # noqa: ANN003, ANN202
            raise _SpawnRungHung()

        with patch.object(self.ci_executor, "run_with_model_fallback", side_effect=ladder), \
                patch.object(self.ci_executor, "_run_zai_as_claude_result", side_effect=hung), \
                self.assertRaises(_SpawnRungHung):
            self.ci_executor.invoke_claude_cli(
                request_id="AIR-1", subagent_type="aria-evidence-judge", prompt_file=self.prompt,
                output_path=self.tools / "agent-invocations" / "outputs" / "AIR-1.json", timeout_seconds=60,
                claim_id="CL-1", agent_id="ci-executor:gha-test", role="evidence_judgment", must_satisfy=[],
                request_envelope={"role": "evidence_judgment", "target_agent": "aria-evidence-judge"},
                tools_dir=self.tools,
            )

    def test_a_zai_spawn_run_that_hung_while_claude_was_out_is_charged(self) -> None:
        from aria_kernel.agent_invocations import reap_stale_claims

        self.outage(_T0 + timedelta(minutes=10), None)
        self.request("AIR-1", role="evidence_judgment")
        self.claim_row(event="claimed", claim_id="CL-1", request_id="AIR-1", agent_id="ci-executor:gha-test",
                       claimed_at=_iso(_T0), lease_expires_at=_iso(_T0 + timedelta(hours=1)))
        self._spawn_on_the_zai_rung()
        followup = reap_stale_claims(base_dir=self.tools, now=_T0 + timedelta(hours=2))["requeued"][0]
        self.assertEqual((followup["reason"], followup["requeue_count"]), ("lease_expired", 1))

    def test_the_rung_writes_its_route_before_it_runs(self) -> None:
        from aria_kernel.independence_check import CLAIM_ROUTE_STARTED_KIND
        from aria_kernel.ledger import load_declared_jsonl

        self._spawn_on_the_zai_rung()
        rows = load_declared_jsonl(self.tools / "governance.jsonl", expected_surface="tools_governance")
        self.assertEqual([(row["details"]["claim_id"], row["details"]["provider"], row["details"]["model"],
                           row["details"]["lane"]) for row in rows if row["kind"] == CLAIM_ROUTE_STARTED_KIND],
                         [("CL-1", "zai", "glm-5.3", "spawn")])

    def test_the_dispatch_summary_names_the_rung_whose_provider_failed(self) -> None:
        # ARIA-LOW-567 — the child's summary is what the drain reads to tell a
        # re-probe of a standing outage from a new one (`_standing_outage`, by
        # the summary's provider). It named the ladder HEAD (anthropic) while
        # the Z.ai rung ran and failed, so a new Z.ai outage of the same class
        # as a standing Anthropic one was excused as Anthropic's re-probe.
        import json
        import os
        from unittest.mock import patch

        def ladder(*, run, model, failover, effort, write_capable, on_credit):  # noqa: ANN001, ANN202, ARG001
            return run("glm-5.3", effort)  # Claude is cooled: the Z.ai rung runs first

        def exhausted(**_kwargs):  # noqa: ANN003, ANN202
            raise self.ci_executor.ClaudeCreditExhausted(
                "Z.ai subscription capacity unavailable", provider="zai", model="glm-5.3", detail={})

        with patch.object(self.ci_executor, "run_with_model_fallback", side_effect=ladder), \
                patch.object(self.ci_executor, "_run_zai_as_claude_result", side_effect=exhausted), \
                self.assertRaises(self.ci_executor.ClaudeCreditExhausted):
            self.ci_executor.invoke_claude_cli(
                request_id="AIR-1", subagent_type="aria-evidence-judge", prompt_file=self.prompt,
                output_path=self.tools / "agent-invocations" / "outputs" / "AIR-1.json", timeout_seconds=60,
                claim_id="CL-1", agent_id="ci-executor:gha-test", role="evidence_judgment", must_satisfy=[],
                request_envelope={"role": "evidence_judgment", "target_agent": "aria-evidence-judge"},
                tools_dir=self.tools,
            )
        summary = json.loads((Path(os.environ["RUNNER_TEMP"]) / "dispatch-result-AIR-1.json").read_text())
        self.assertEqual((summary["provider"], summary["model"], summary["failure_class"]),
                         ("zai", "glm-5.3", "credit_exhausted"))

    def test_no_rung_runs_without_its_route_on_the_ledger(self) -> None:
        from unittest.mock import patch

        from aria_kernel import independence_check
        from aria_kernel.tool_registry import GovernanceError

        refused = patch.object(independence_check, "record_claim_route",
                               side_effect=GovernanceError("tool_governance_write_refused"))
        with refused, self.assertRaisesRegex(self.ci_executor.ClaudeCliUnavailable, "claim_route_record_unavailable"):
            self._spawn_on_the_zai_rung()


class L562OneSweepParsesTheGovernanceLedgerOnce(M1ALeaseAnOutageAteIsNotCharged):
    """ARIA-LOW-562 — the sweep's lease rule needs two things from governance.jsonl: each
    claim's attempt route and the providers' outage intervals. It parsed and verified the
    whole ledger (25.8 MB on aria/state) for the first, and the provider clock parsed it
    again for the second. One parse serves both; every M1/M444 answer above still holds."""

    def _reap(self) -> dict:
        from unittest.mock import patch

        from aria_kernel import agent_invocations, provider_outage_ledger

        self.parses: list[str] = []
        declared, raw = agent_invocations.load_declared_jsonl, provider_outage_ledger.load_jsonl

        def counted(loader):  # noqa: ANN001, ANN202 — wraps either loader's signature
            def load(path, *args, **kwargs):  # noqa: ANN001, ANN002, ANN003, ANN202
                if Path(path).name == "governance.jsonl":
                    self.parses.append(loader.__name__)
                return loader(path, *args, **kwargs)
            return load

        with patch.object(agent_invocations, "load_declared_jsonl", counted(declared)), \
                patch.object(provider_outage_ledger, "load_jsonl", counted(raw)):
            return super()._reap()

    def test_an_expired_claim_under_an_outage_parses_the_ledger_once(self) -> None:
        self.outage(_T0 + timedelta(minutes=10), None)
        followup = self._reap()["requeued"][0]
        self.assertEqual(followup["reason"], "lease_expired_during_provider_outage:anthropic")
        self.assertEqual(len(self.parses), 1, self.parses)


class L568TheSweepParsesGovernanceOutsideTheClaimsLock(M1ALeaseAnOutageAteIsNotCharged):
    """ARIA-LOW-568 — the lease rule's context (each claim's route and the outage
    intervals, one parse of governance.jsonl; the request roles) does not need the claims
    and results lock, and the sweep parsed it on the first expired claim INSIDE that lock,
    holding every claim, heartbeat and submit behind a 25.9 MB parse. It is read before the
    lock when a lease looks expired on the unlocked read, and each claim is re-checked under
    the lock as before; every M1 answer above still holds with the reads instrumented."""

    def _instrumented(self, reap):  # noqa: ANN001, ANN202
        from contextlib import contextmanager
        from unittest.mock import patch

        from aria_kernel import agent_invocations

        self.locked = False
        self.context_reads_locked: list[bool] = []
        real_transaction, real_context = agent_invocations.state_transaction, agent_invocations._lease_routes_and_clock

        @contextmanager
        def transaction(paths, *args, **kwargs):  # noqa: ANN001, ANN002, ANN003, ANN202
            with real_transaction(paths, *args, **kwargs) as held:
                self.locked = True
                try:
                    yield held
                finally:
                    self.locked = False

        def context(root):  # noqa: ANN001, ANN202
            self.context_reads_locked.append(self.locked)
            return real_context(root)

        with patch.object(agent_invocations, "state_transaction", transaction), \
                patch.object(agent_invocations, "_lease_routes_and_clock", context):
            return reap()

    def _reap(self) -> dict:
        return self._instrumented(super()._reap)

    def _held_claim(self) -> None:
        self.request("AIR-1")
        self.claim_row(event="claimed", claim_id="CL-1", request_id="AIR-1", agent_id="a",
                       claimed_at=_iso(_T0), lease_expires_at=_iso(_T0 + timedelta(hours=1)))

    def test_the_lease_context_is_read_once_and_before_the_lock(self) -> None:
        self.outage(_T0 + timedelta(minutes=10), None)
        followup = self._reap()["requeued"][0]
        self.assertEqual(followup["reason"], "lease_expired_during_provider_outage:anthropic")
        self.assertEqual(self.context_reads_locked, [False])

    def test_a_held_claim_whose_lease_is_live_reads_no_context(self) -> None:
        from aria_kernel.agent_invocations import reap_stale_claims

        self._held_claim()
        reaped = self._instrumented(lambda: reap_stale_claims(base_dir=self.tools, now=_T0 + timedelta(minutes=30)))
        self.assertEqual(reaped["stale"], [])
        self.assertEqual(self.context_reads_locked, [])

    def test_a_lease_that_ran_out_between_the_look_and_the_lock_is_decided_with_its_context_read_unlocked(
        self,
    ) -> None:
        # The unlocked look and the locked check read the clock separately
        # (no injected `now`): a lease that expired in between leaves the
        # lock unwritten, reads its context outside it and is decided again.
        from unittest.mock import patch

        from aria_kernel import agent_invocations

        self.outage(_T0 + timedelta(minutes=10), None)
        self._held_claim()
        clock = iter([_T0 + timedelta(minutes=59), _T0 + timedelta(hours=2), _T0 + timedelta(hours=2)])
        with patch.object(agent_invocations, "_utc_now_dt", side_effect=lambda: next(clock)):
            reaped = self._instrumented(lambda: agent_invocations.reap_stale_claims(base_dir=self.tools))
        self.assertEqual([row["reason"] for row in reaped["requeued"]],
                         ["lease_expired_during_provider_outage:anthropic"])
        self.assertEqual(len(reaped["stale"]), 1)
        self.assertEqual(self.context_reads_locked, [False])


class L566OneSweepAppendsItsGovernanceRowsOnce(_Store):
    """ARIA-LOW-566 — every governance append verifies the whole chain and reads it again for
    the tail hash (ARIA-HIGH-237 pays that once per BATCH, ``append_declared_jsonl_rows``). The
    sweep appended one ``agent_claim_<kind>`` row per expired claim, each its own append, so N
    expired claims cost 2N full parses of governance.jsonl (25.9 MB on aria/state) on top of
    the lookup. The sweep's rows are one batch now: one append pass, whatever N is, and every
    row is still written (since ARIA-LOW-611 that pass reads the file once: the verification
    yields the tail hash)."""

    def _expired(self, n: int) -> None:
        for index in range(1, n + 1):
            self.request(f"AIR-{index}")
            self.claim_row(event="claimed", claim_id=f"CL-{index}", request_id=f"AIR-{index}", agent_id="a",
                           claimed_at=_iso(_T0), lease_expires_at=_iso(_T0 + timedelta(hours=1)))

    def _sweep_counting_append_parses(self) -> tuple[dict, dict[str, int]]:
        from unittest.mock import patch

        from aria_kernel import ledger
        from aria_kernel.agent_invocations import reap_stale_claims

        # ARIA-LOW-611 — the append body's one read-verify-tail pass; it was a
        # verify_jsonl read plus a _read_jsonl_stored re-parse per append.
        parses = {"_tail_hash_for_append": 0}
        real = {name: getattr(ledger, name) for name in parses}

        def counted(name):  # noqa: ANN001, ANN202
            def call(path, *args, **kwargs):  # noqa: ANN001, ANN002, ANN003, ANN202
                if Path(path).name == "governance.jsonl":
                    parses[name] += 1
                return real[name](path, *args, **kwargs)
            return call

        with patch.object(ledger, "_tail_hash_for_append", counted("_tail_hash_for_append")):
            reaped = reap_stale_claims(base_dir=self.tools, now=_T0 + timedelta(hours=2))
        return reaped, parses

    def _governance_rows(self, kind: str) -> list[dict]:
        from aria_kernel.ledger import load_declared_jsonl

        return [row for row in load_declared_jsonl(self.tools / "governance.jsonl", expected_surface="tools_governance")
                if row.get("kind") == kind]

    def test_three_expired_claims_append_their_rows_as_one_batch(self) -> None:
        self._expired(3)
        reaped, parses = self._sweep_counting_append_parses()
        self.assertEqual(len(reaped["requeued"]), 3)
        self.assertEqual(parses, {"_tail_hash_for_append": 1})
        rows = self._governance_rows("agent_claim_requeued")
        self.assertEqual([row["details"]["claim_id"] for row in rows], ["CL-1", "CL-2", "CL-3"])
        self.assertEqual({row["details"]["reason"] for row in rows}, {"lease_expired"})

    def test_a_sweep_that_reaps_nothing_appends_nothing(self) -> None:
        reaped, parses = self._sweep_counting_append_parses()
        self.assertEqual(reaped["stale"], [])
        self.assertEqual(parses, {"_tail_hash_for_append": 0})

    def test_a_claim_reaped_before_a_later_claim_fails_keeps_its_governance_row(self) -> None:
        # The rows used to be appended per claim, right after its claims
        # transaction; a later claim's failure could not take an earlier
        # claim's row with it. The batch keeps that: the sweep's rows are
        # appended on every exit, then the failure propagates.
        from unittest.mock import patch

        from aria_kernel import agent_invocations

        self._expired(2)
        real = agent_invocations._expired_live_lease

        def second_fails(claims, results, claim_id, *, at):  # noqa: ANN001, ANN202
            if claim_id == "CL-2" and any(row.get("event") == "stale" for row in claims):
                raise OSError("the store went away under the second claim")
            return real(claims, results, claim_id, at=at)

        with patch.object(agent_invocations, "_expired_live_lease", side_effect=second_fails), \
                self.assertRaises(OSError):
            agent_invocations.reap_stale_claims(base_dir=self.tools, now=_T0 + timedelta(hours=2))
        self.assertEqual([row["details"]["claim_id"] for row in self._governance_rows("agent_claim_requeued")],
                         ["CL-1"])


if __name__ == "__main__":
    unittest.main()
