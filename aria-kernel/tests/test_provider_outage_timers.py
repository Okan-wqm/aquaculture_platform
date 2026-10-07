"""ARIA-HIGH-365 — wall-clock timers no longer kill work during a provider outage.

Operator requirement (2026-10-07): the subscription or key may run out and be
bought again later; everything continues where it left off and nothing is
lost. Measured before the fix: plans ABANDONED as
``stalled:provider_quota_unavailable:anthropic`` after 72 h (B1),
implementation requests reaped to IMPLEMENTATION_REJECTED after 24 h (B2),
requests aged into ANCHOR_STALE — 37 of 43 on 2026-08-21..25 had seen only
provider-class releases — each spending one of the step's successors (B3).

Every scenario here records a REAL outage through the production writer
(``record_provider_cooldown``, the one every executor arm calls), lets more
than the bound pass, restores the provider, and asserts the work is still
alive; each has a control without the outage that shows the bound still
bites. Every scenario fails on origin/main 958eed5b7 (no outage fact, wall
clock everywhere).
"""
from __future__ import annotations

import shutil
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from aria_kernel.plan_convergence import fold_plan_state, resume_candidate_plan_id, start_plan
from aria_kernel.provider_cooldown import record_provider_cooldown
from aria_kernel.tool_registry import ensure_tools_dir

from tests._helpers.declared_fixtures import append_declared_fixture

_QUOTA = {"signature": "claude_usage_limit_notice", "reset_hint": None, "source": "cli_usage_limit_message"}


def _iso(moment: datetime) -> str:
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


def _plan_content() -> dict:
    return {
        "schema_version": 1, "title": "outage plan", "summary": "ARIA-HIGH-365 fixture plan.",
        "affected_surfaces": [{"paths": ["apps/farm-service/src/farm/services/water-quality.service.ts"]}],
        "key_changes": ["apply the declared change"],
        # The shape `production_shaped.production_converged_plan` converges
        # with: the canonical suite and a tier claim the contract gate reads.
        "validation_commands": [{"cmd": "nx affected --target=lint", "timeout_ms": 600_000},
                                {"cmd": "nx affected --target=test", "timeout_ms": 1_800_000}],
        "evidence_refs": ["docs/aria/SPEC.md"], "architectural_tier": 1,
    }


class _Store(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="aria-outage-timers-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        self.tools = ensure_tools_dir(self.root / "aria-tools")
        self.t0 = datetime.now(timezone.utc).replace(microsecond=0)

    def outage(self, start: datetime, end: datetime | None, *, provider: str = "anthropic") -> None:
        """An exhaustion detected at ``start`` (the executor's arm), restored at ``end`` by a served spawn."""
        record_provider_cooldown(self.tools, provider=provider, model="opus", cooldown_seconds=900,
                                 request_id="AIR-out", claim_id="CL-out", detection=dict(_QUOTA), now=start)
        if end is not None:
            from aria_kernel.provider_outage_ledger import record_provider_restored

            record_provider_restored(self.tools, provider=provider, seam="spawn", request_id="AIR-ok", now=end)

    def request(self, request_id: str, *, role: str, plan_id: str = "plan-o", created: datetime) -> dict:
        row = {"schema_version": 1, "request_id": request_id, "role": role, "convergence_id": plan_id,
               "target_agent": "aria-primary-planner", "state": "pending", "created_at": _iso(created)}
        append_declared_fixture(self.tools / "agent-invocations" / "requests.jsonl", row,
                                expected_surface="agent_invocation_requests")
        return row

    def _escalate(self, request_id: str) -> None:
        """The request was claimed, ANSWERED and refused on its merits: escalated for its own reason."""
        for event, extra in (("claimed", {"claimed_at": _iso(self.t0 + timedelta(minutes=2))}),
                             ("human_required", {"at": _iso(self.t0 + timedelta(minutes=3)),
                                                 "reason": "agent_refused:evidence", "requeue_count": 1})):
            append_declared_fixture(self.tools / "agent-invocations" / "claims.jsonl", {
                "schema_version": 1, "event": event, "claim_id": f"CL-{request_id}", "request_id": request_id,
                **extra,
            }, expected_surface="agent_invocation_claims")

    def release(self, request_id: str, reason: str, at: datetime) -> None:
        for event in ("claimed", "released"):
            append_declared_fixture(self.tools / "agent-invocations" / "claims.jsonl", {
                "schema_version": 1, "event": event, "claim_id": f"CL-{request_id}", "request_id": request_id,
                "reason": reason if event == "released" else None,
                ("claimed_at" if event == "claimed" else "released_at"): _iso(at),
            }, expected_surface="agent_invocation_claims")


class _Clock:
    """``datetime`` as plan_convergence sees it, moved to ``moment``."""

    def __init__(self, moment: datetime) -> None:
        real = datetime

        class Shifted(datetime):
            @classmethod
            def now(cls, tz=None):  # noqa: ANN001 - the datetime signature
                return moment if tz is not None else moment.replace(tzinfo=None)

        self.patch = patch("aria_kernel.plan_convergence.datetime", Shifted)
        self.real = real

    def __enter__(self) -> None:
        self.patch.start()

    def __exit__(self, *exc: object) -> None:
        self.patch.stop()


class B1APlanWaitingThroughAnOutageIsAdoptedNotAbandoned(_Store):
    def _started(self) -> None:
        start_plan(plan_id="plan-o", initial_revision_id="rev-0", plan_content=_plan_content(), base_dir=self.tools)
        self.request("AIR-1", role="primary_plan", created=self.t0)
        self.release("AIR-1", "provider_quota_unavailable:anthropic", self.t0 + timedelta(minutes=1))

    def test_a_three_day_outage_mid_convergence_then_recovery_converges(self) -> None:
        self._started()
        self.outage(self.t0 + timedelta(minutes=1), self.t0 + timedelta(days=3, minutes=1))
        with _Clock(self.t0 + timedelta(days=3, hours=2)):
            adopted = resume_candidate_plan_id(base_dir=self.tools)
        self.assertEqual(adopted, "plan-o")
        self.assertNotEqual(fold_plan_state(plan_id="plan-o", base_dir=self.tools)["state"], "ABANDONED")
        # Recovery: the plan continues from where it stopped to CONVERGED.
        from aria_kernel.plan_convergence import evaluate_plan, plan_status, record_critique, request_critics
        from aria_kernel.plan_convergence import content_hash

        (self.root / ".claude" / "agents").mkdir(parents=True)
        (self.root / ".claude" / "agents" / "farm-expert.md").write_text(
            "---\nname: farm-expert\ndescription: Fixture reviewer.\n---\n\nOwns `apps/farm-service/**`.\n",
            encoding="utf-8")
        latest = plan_status(plan_id="plan-o", base_dir=self.tools)["latest_revision"]
        request_critics(plan_id="plan-o", base_dir=self.tools, request={
            "round_number": 1, "target_revision_id": latest["revision_id"],
            "target_plan_content_hash": latest["content_hash"],
            "tasks": [{"task_id": "task-1", "task_packet_hash": content_hash({"task_id": "task-1"}),
                       "target_agent": "farm-expert", "target_revision_id": latest["revision_id"],
                       "target_plan_content_hash": latest["content_hash"],
                       "sla_deadline": (datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat()}],
        })
        state = plan_status(plan_id="plan-o", base_dir=self.tools)
        task = next(iter(state["rounds"][state["current_round"]]["tasks"].values()))
        record_critique(plan_id="plan-o", workspace_root=self.root, base_dir=self.tools, critique={
            "task_packet_hash": task["task_packet_hash"], "target_revision_id": task["target_revision_id"],
            "target_plan_content_hash": task["target_plan_content_hash"], "reviewer": "farm-expert",
            "risks": [], "critique_content_hash": content_hash({"reviewer": "farm-expert", "risks": []}),
        })
        evaluated = evaluate_plan(plan_id="plan-o", round_number=1, base_dir=self.tools)
        self.assertEqual(evaluated.get("event", {}).get("payload", {}).get("terminal_state"), "CONVERGED", evaluated)
        self.assertEqual(fold_plan_state(plan_id="plan-o", base_dir=self.tools)["state"], "CONVERGED")

    def test_the_human_required_outage_item_is_the_only_escalation(self) -> None:
        self._started()
        self.outage(self.t0 + timedelta(minutes=1), None)
        with _Clock(self.t0 + timedelta(days=3, hours=2)):
            self.assertEqual(resume_candidate_plan_id(base_dir=self.tools), "plan-o")
        from aria_kernel.human_required import list_human_required

        reasons = [row["reason"] for row in list_human_required(base_dir=self.tools)]
        self.assertEqual(len(reasons), 1, reasons)
        self.assertTrue(reasons[0].startswith("provider_unavailable:anthropic:quota"))

    def test_a_fallback_served_refused_request_is_abandoned_though_the_head_is_out(self) -> None:
        """Review HIGH-1: Anthropic lapsed, Z.ai served rung 2, the answer was refused on its merits."""
        start_plan(plan_id="plan-o", initial_revision_id="rev-0", plan_content=_plan_content(), base_dir=self.tools)
        self.request("AIR-1", role="primary_plan", created=self.t0)
        self._escalate("AIR-1")
        self.outage(self.t0 + timedelta(minutes=1), None)
        with _Clock(self.t0 + timedelta(days=3, hours=2)):
            self.assertIsNone(resume_candidate_plan_id(base_dir=self.tools))
        self.assertEqual(fold_plan_state(plan_id="plan-o", base_dir=self.tools)["state"], "ABANDONED")

    def test_without_an_outage_the_stall_bound_still_abandons(self) -> None:
        self._started()
        with _Clock(self.t0 + timedelta(days=3, hours=2)):
            self.assertIsNone(resume_candidate_plan_id(base_dir=self.tools))
        self.assertEqual(fold_plan_state(plan_id="plan-o", base_dir=self.tools)["state"], "ABANDONED")

    def test_time_after_the_restore_counts_again(self) -> None:
        self._started()
        self.outage(self.t0 + timedelta(minutes=1), self.t0 + timedelta(hours=2))
        with _Clock(self.t0 + timedelta(days=3, hours=3)):
            self.assertIsNone(resume_candidate_plan_id(base_dir=self.tools))
        abandonment = fold_plan_state(plan_id="plan-o", base_dir=self.tools)["abandonment"]
        self.assertGreater(abandonment["stall"]["provider_available_hours"], 72)


class B3ARequestWaitingThroughAnOutageKeepsItsAnchor(_Store):
    def _bound(self) -> int:
        from aria_kernel.agent_invocations import _anchor_max_age_seconds

        return _anchor_max_age_seconds(self.tools)

    def test_the_sweep_spares_it_and_the_step_spends_no_successor(self) -> None:
        from aria_kernel.agent_invocations import derive_request_state, sweep_expired_anchors
        from aria_kernel.step_request import step_request_disposition

        bound = timedelta(seconds=self._bound())
        row = self.request("AIR-1", role="primary_plan", created=self.t0)
        self.release("AIR-1", "provider_quota_unavailable:anthropic", self.t0 + timedelta(minutes=1))
        self.outage(self.t0 + timedelta(minutes=1), self.t0 + bound + timedelta(hours=1))
        swept = sweep_expired_anchors(base_dir=self.tools, now=self.t0 + bound + timedelta(hours=2))
        self.assertEqual(swept["swept"], 0)
        self.assertEqual(derive_request_state(request_id="AIR-1", base_dir=self.tools), "PENDING")
        disposition = step_request_disposition([row], role="primary_plan", base_dir=self.tools)
        self.assertEqual((disposition.kind, disposition.remints_so_far), ("live", 0))

    def test_without_an_outage_the_anchor_window_still_expires(self) -> None:
        from aria_kernel.agent_invocations import derive_request_state, sweep_expired_anchors

        self.request("AIR-1", role="primary_plan", created=self.t0)
        swept = sweep_expired_anchors(base_dir=self.tools,
                                      now=self.t0 + timedelta(seconds=self._bound()) + timedelta(hours=2))
        self.assertEqual(swept["swept"], 1)
        self.assertEqual(derive_request_state(request_id="AIR-1", base_dir=self.tools), "ANCHOR_STALE")

    def test_the_claim_time_gate_reads_the_same_clock(self) -> None:
        from aria_kernel.agent_invocations import _anchor_refusal_reason
        from aria_kernel.evidence_probe import GitProbeSession
        from aria_kernel.provider_clock import ProviderClock, provider_clock

        bound = timedelta(seconds=self._bound())
        row = self.request("AIR-1", role="primary_plan", created=self.t0)
        self.outage(self.t0, self.t0 + bound)
        later = self.t0 + bound + timedelta(hours=1)
        verdict = _anchor_refusal_reason(row, self.root, probes=GitProbeSession(), clock=provider_clock(self.tools),
                                         now=later, max_age_seconds=int(bound.total_seconds()))
        self.assertIsNone(verdict.refusal)
        wall = _anchor_refusal_reason(row, self.root, probes=GitProbeSession(), clock=ProviderClock(()),
                                      now=later, max_age_seconds=int(bound.total_seconds()))
        self.assertEqual(wall.refusal, "anchor_expired")

    def test_an_expiry_an_outage_overlapped_is_written_harness_class(self) -> None:
        """The contract ARIA-HIGH-360's expiry disposition pins: no re-mint budget spent."""
        from aria_kernel.agent_invocations import HARNESS_FAULT_RELEASE_REASON_PREFIXES
        from aria_kernel.agent_invocations import classify_release_reason, sweep_expired_anchors
        from aria_kernel.anchor_expiry_cause import (
            ANCHOR_EXPIRED_IN_OUTAGE_PREFIX, ExpiryCause, anchor_expiry_reason_in_outage,
        )
        from aria_kernel.ledger import load_jsonl
        from aria_kernel.release_reason import parse_release_reason

        bound = timedelta(seconds=self._bound())
        self.request("AIR-1", role="primary_plan", created=self.t0)
        self.outage(self.t0 + timedelta(hours=1), self.t0 + timedelta(hours=3))
        swept = sweep_expired_anchors(base_dir=self.tools, now=self.t0 + bound + timedelta(hours=5))
        self.assertEqual(swept["swept"], 1)
        row = next(r for r in load_jsonl(self.tools / "agent-invocations" / "claims.jsonl")
                   if r.get("event") == "anchor_stale")
        # The round trip with ARIA-HIGH-360: the writer spells the reason
        # through that lane's one function, the release table reads it as the
        # harness's, and the expiry disposition spends no re-mint budget.
        self.assertEqual(row["reason"], anchor_expiry_reason_in_outage(["anthropic"]))
        self.assertEqual(classify_release_reason(row["reason"]), "harness")
        self.assertEqual(parse_release_reason(row["reason"]).fault_domain, "harness")
        self.assertFalse(ExpiryCause.from_reason(row["reason"]).spends_remint_budget)
        self.assertIn(ANCHOR_EXPIRED_IN_OUTAGE_PREFIX, HARNESS_FAULT_RELEASE_REASON_PREFIXES)

    def test_an_outage_of_another_vendor_does_not_pause_this_role(self) -> None:
        from aria_kernel.agent_invocations import sweep_expired_anchors

        bound = timedelta(seconds=self._bound())
        self.request("AIR-1", role="primary_plan", created=self.t0)
        record_provider_cooldown(self.tools, provider="zai", model="glm", cooldown_seconds=900, request_id="AIR-z",
                                 claim_id="CL-z", detection={"signature": "zai_quota_refusal"}, now=self.t0)
        swept = sweep_expired_anchors(base_dir=self.tools, now=self.t0 + bound + timedelta(hours=2))
        self.assertEqual(swept["swept"], 1)
        from aria_kernel.ledger import load_jsonl

        row = next(r for r in load_jsonl(self.tools / "agent-invocations" / "claims.jsonl")
                   if r.get("event") == "anchor_stale")
        self.assertEqual(row["reason"], "anchor_expired", "an outage of another vendor names nothing")


class B2AnImplementationWaitingThroughAnOutageIsNotReaped(_Store):
    def _decide(self, now: datetime):
        from aria_kernel.outage_causality import request_awaits_provider
        from aria_kernel.plan_convergence import decide_orphan_reap
        from aria_kernel.provider_clock import provider_clock

        orphan = {"plan_id": "plan-i", "state": "IMPLEMENTATION_REQUESTED", "last_event_at": _iso(self.t0)}
        return decide_orphan_reap(orphan, clock=provider_clock(self.tools), now=now,
                                  awaits_provider=request_awaits_provider("AIR-impl", base_dir=self.tools))

    def test_the_reaper_spares_it_through_the_outage_and_counts_after(self) -> None:
        from aria_kernel.plan_convergence import ORPHAN_DECISION_REAP, ORPHAN_DECISION_SPARE_RECENT

        self.request("AIR-impl", role="implementation", plan_id="plan-i", created=self.t0)
        self.outage(self.t0 + timedelta(minutes=5), self.t0 + timedelta(days=3))
        during = self._decide(self.t0 + timedelta(days=3))
        self.assertEqual(during.decision, ORPHAN_DECISION_SPARE_RECENT)
        self.assertLess(during.age_hours, 1)
        self.assertEqual(self._decide(self.t0 + timedelta(days=4, hours=1)).decision, ORPHAN_DECISION_REAP)

    def test_an_answered_request_is_reaped_on_wall_time_whatever_the_outage(self) -> None:
        """Review HIGH-1: the outage did not cause a request that was answered and refused."""
        from aria_kernel.plan_convergence import ORPHAN_DECISION_REAP

        self.request("AIR-impl", role="implementation", plan_id="plan-i", created=self.t0)
        self._escalate("AIR-impl")
        self.outage(self.t0 + timedelta(minutes=5), None)
        self.assertEqual(self._decide(self.t0 + timedelta(days=3)).decision, ORPHAN_DECISION_REAP)

    # The orchestrator's own reap path (fixture-driven, the real plan and
    # ledger clock) is pinned in test_autonomy_orchestrator.py,
    # TheStartupReaperCollectsAbandonmentNotLateness.


class OperatorRequestExpiryIsPutBackNotSpentInSilence(_Store):
    def _row(self) -> dict:
        return {"id": "OPR-1", "finding_id": "ARIA-HIGH-365", "priority": "high", "request": "fix the timers",
                "authored_at": _iso(self.t0), "expires_at": _iso(self.t0 + timedelta(hours=168))}

    def test_an_expiry_inside_an_outage_raises_one_resign_item_with_the_request(self) -> None:
        from aria_kernel.human_required import list_human_required
        from aria_kernel.operator_request_outage import surface_outage_expired_request

        self.outage(self.t0 + timedelta(days=4), None)
        signal = surface_outage_expired_request(self.tools, self._row(), now=self.t0 + timedelta(days=8))
        items = {row["request_id"]: row for row in list_human_required(base_dir=self.tools)}
        self.assertIn(signal, items)
        self.assertEqual(items[signal]["context"]["request"], "fix the timers")
        self.assertEqual(items[signal]["context"]["finding_id"], "ARIA-HIGH-365")

    def test_an_expiry_with_no_outage_is_unchanged(self) -> None:
        from aria_kernel.operator_request_outage import surface_outage_expired_request

        self.assertIsNone(surface_outage_expired_request(self.tools, self._row(), now=self.t0 + timedelta(days=8)))


class TheClockIsBoundedByAnEscalationNeverByKillingWork(_Store):
    def test_an_outage_open_thirty_days_raises_one_prolonged_item(self) -> None:
        from aria_kernel.provider_outage_ledger import escalate_prolonged_outages

        self.outage(self.t0, None)
        self.assertEqual(escalate_prolonged_outages(self.tools, now=self.t0 + timedelta(days=29)), [])
        raised = escalate_prolonged_outages(self.tools, now=self.t0 + timedelta(days=31))
        self.assertEqual(len(raised), 1)
        self.assertTrue(raised[0].endswith("-prolonged"))

    def test_the_clock_subtracts_only_time_every_head_provider_was_down(self) -> None:
        from aria_kernel.provider_clock import provider_available_age, provider_clock

        self.outage(self.t0, self.t0 + timedelta(hours=10))
        later = self.t0 + timedelta(hours=12)
        self.assertEqual(provider_available_age(self.t0, later, roles=["implementation"], base_dir=self.tools),
                         timedelta(hours=2))
        self.assertEqual(provider_available_age(self.t0, later, providers=["zai"], base_dir=self.tools),
                         timedelta(hours=12))
        clock = provider_clock(self.tools)
        self.assertTrue(clock.outage_active(frozenset({"anthropic"}), self.t0 + timedelta(hours=1)))
        self.assertFalse(clock.outage_active(frozenset({"anthropic"}), later))


if __name__ == "__main__":
    unittest.main()
