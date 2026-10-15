"""Ten days with no provider lose no work; the first provider back resumes it (2026-10-11).

Operator decision (2026-10-11): "If Z.ai's quota also runs out and we have no quota at all,
jobs must not be lost." Review: docs/reviews/claude/2026-10-11-aria-total-outage-continuity.md
(ARIA-HIGH-435, ARIA-MEDIUM-436/437/438, ARIA-LOW-439).

ONE scenario, on a store minted through the production writers, with every kernel clock frozen
at the scenario's moment (``_Frozen``: the module ``datetime`` of each loaded kernel and executor
module):

* T0: a plan waits on its challenger (Z.ai heads ``challenger_plan``), an evidence judge
  (Anthropic heads it), a CONVERGED plan's implementation request (Anthropic), a next-cycle
  queue item, and a worker assignment.
* T0+1h: Anthropic's weekly window is spent (the CLI's ``rate_limit_event``, reset at T0+7d).
  T0+2h: Z.ai answers its admission probe 429, and Codex is logged out. Nothing can run.
* Days 0..9: two drains and one cycle a day. A drain is the real ``ci_executor_drain`` over the
  kernel's own selection; its child does what ``ci_executor`` does on this host: the native
  admission (cooled providers refused unprobed, the others probed), then the claim, the spawn
  and its exhaustion arm. The cycle runs the sweep, both reapers, the plan adoption, the
  in-flight reader, the orphan reaper's decision, the prolonged-outage bound, and the
  reflection's enqueue, which re-plans other pressures and never ``pressure:a`` again.
* Day 7: Anthropic's reset arrives, but the subscription is gone: every re-probe is a credential
  failure. Day 8: a worker claimed in a lapsed back-off is killed with its runner.
* Day 10: the subscription is renewed. The re-probe's spawn is served, and Anthropic is
  restored. Z.ai and Codex stay out.

The outage must have charged nothing: no request expired, released for its own fault,
escalated or re-minted; no plan was abandoned or rejected; no queue item aged out; no lease
budget was spent; no delivery attempt was counted; the failure breaker that gates every
strict/autonomous cycle stayed ``ok``; the only operator items are the outages' own. After the
restore, every piece of work is where it was, and the executor's next step for each one
succeeds.
"""
from __future__ import annotations

import json
import shutil
import sys
import tempfile
import unittest
from contextlib import ExitStack, contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator
from unittest.mock import patch

from aria_kernel import (  # noqa: F401 — loaded before the clock is frozen (module `datetime`s)
    agent_invocations, circuit_breaker, human_required, ledger, next_cycle_queue, plan_convergence,
    provider_clock, provider_cooldown, provider_outage, provider_outage_ledger, provider_outage_seams,
    request_admission, request_drain_capacity, step_request, tool_registry, worker_dispatch,
)
from aria_kernel.agent_invocations import (
    _request_fault_requeue_count, claim_request, create_agent_invocation_request, derive_request_state,
    list_agent_invocation_requests, next_pending_request, reap_stale_claims, release_claim,
    sweep_expired_anchors,
)
from aria_kernel.ledger import load_jsonl
from aria_kernel.next_cycle_queue import EXPIRED, append_pending, read_pending
from aria_kernel.outage_causality import newest_request_id, request_awaits_provider
from aria_kernel.plan_convergence import (
    ORPHAN_DECISION_SPARE_RECENT, counted_delivery_attempts, decide_orphan_reap, fold_plan_state,
    in_flight_plan_id, resume_candidate_plan_id, scan_orphan_implementation_requests, start_plan,
)
from aria_kernel.provider_clock import provider_available_age
from aria_kernel.provider_cooldown import active_provider_cooldowns, record_provider_cooldown
from aria_kernel.provider_outage import cooled_providers, provider_outage
from aria_kernel.provider_outage_ledger import escalate_prolonged_outages, open_outages, record_provider_restored
from aria_kernel.provider_outage_seams import observe_native_admission
from aria_kernel.request_admission import admit_request
from aria_kernel.runtime_profiles import load_provider_routing
from aria_kernel.step_request import step_request_disposition
from aria_kernel.worker_dispatch import _lease_expiry_count, claim_assignment, reap_expired_assignment_claims

from tests._helpers.declared_fixtures import append_declared_fixture
from tests._helpers.production_shaped import cycle_workspace, production_implementation_request
from tests.test_executor_drain_breaker import _REPO_ROOT, _summary, ci_executor_drain

_REAL = datetime
_PLAN = "plan-o"
_IMPL_PLAN = "plan-i"
_WORKER = "W-1"
_IMPL_PATH = "apps/farm-service/src/farm/services/water-quality.service.ts"


class _Frozen(_REAL):
    """``datetime`` as every patched module sees it: ``now`` is the scenario's moment."""

    moment: datetime | None = None

    @classmethod
    def now(cls, tz=None):  # noqa: ANN001, ANN206 — the datetime signature
        if cls.moment is None:
            return _REAL.now(tz)
        return cls.moment.astimezone(tz) if tz is not None else cls.moment.astimezone(timezone.utc).replace(tzinfo=None)


@contextmanager
def _at(moment: datetime) -> Iterator[None]:
    """Freeze every loaded kernel and executor module's clock at ``moment``."""
    _Frozen.moment = moment
    with ExitStack() as stack:
        for name, module in list(sys.modules.items()):
            if (name.startswith("aria_kernel") or name in ("ci_executor", "ci_executor_drain")) \
                    and getattr(module, "datetime", None) is _REAL:
                stack.enter_context(patch.object(module, "datetime", _Frozen))
        try:
            yield
        finally:
            _Frozen.moment = None


def _iso(moment: datetime) -> str:
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


class _Scenario:
    """The store, the vendors' answers, and the two lanes that act on them."""

    def __init__(self, tmp: Path, t0: datetime) -> None:
        self.t0 = t0
        self.tmp = tmp
        fixture = cycle_workspace(tmp)
        self.workspace, self.tools = fixture.workspace_root, fixture.tools_dir
        # What each vendor answers right now: serves | quota | auth | logged_out.
        self.vendor = {"anthropic": "serves", "zai": "serves", "openai": "serves"}
        self.drain_exits: list[tuple[str, int]] = []
        self.served: dict[str, str] = {}  # request id -> the provider whose spawn served it
        self.ids: dict[str, str] = {}

    # --- the drain: the real loop, the kernel's selection, ci_executor's moves on this host --

    def _child(self, request: dict[str, Any]) -> dict[str, Any]:
        """ci_executor on one request: native admission, then claim, spawn and the exhaustion arm."""
        rid, role, target = request["request_id"], request["role"], request["target_agent"]
        cooled = active_provider_cooldowns(self.tools)
        rows: list[dict[str, Any]] = []
        chosen = None
        for provider in load_provider_routing().ladder_for(role, target):
            answer = self.vendor[provider]
            # (status_reason, auth_observation, decision) as `native_admission` writes the row.
            if provider in cooled:  # refused unprobed; the cooldown says which fact cooled it
                credential = cooled[provider]["reason"] in ("auth_unavailable", "logged_out")
                reason, decided = "provider_quota_cooldown", "unavailable"
                auth = "unavailable" if credential else "unknown"
            elif provider == "zai":  # a real one-token completion (zai_runtime.probe_zai_status)
                reason, auth, decided = {"serves": ("chat_completion_ok", "available", "available"),
                                         "quota": ("quota_or_rate_limited_http_429", "available", "unavailable"),
                                         "auth": ("auth_rejected_http_401", "unavailable", "unavailable")}[answer]
            elif provider == "openai":  # `codex login status`
                reason, auth, decided = (
                    ("cli_reported_not_logged_in", "unavailable", "unavailable") if answer == "logged_out"
                    else ("cli_reported_logged_in", "available", "available"))
            else:  # `claude auth status` sees the login, never a quota or a lapsed subscription
                reason, auth, decided = "managed_session_logged_in", "available", "available"
            rows.append({"provider": provider, "model": f"{provider}-model", "status_reason": reason,
                         "auth_observation": auth, "decision": decided})
            if decided == "available" and chosen is None:
                chosen = provider
        observe_native_admission(self.tools, observations=rows, request_id=rid, cooldown_seconds=900)
        if chosen is None:
            return _summary(request_id=rid, outcome="refused", detail_code="no_eligible_provider",
                            role=role, target_agent=target, provider="none", model="none")
        claim = claim_request(request_id=rid, agent_id="aria-executor", base_dir=self.tools)
        if self.vendor[chosen] == "serves":
            # The spawn ran to completion: positive evidence the provider is back.
            record_provider_restored(self.tools, provider=chosen, seam="spawn", request_id=rid)
            self.served[rid] = chosen
            return _summary(request_id=rid, outcome="succeeded", role=role, target_agent=target,
                            provider=chosen, model="claude-opus")
        signature, failure_class, release = {
            "quota": ("claude_credit_error", "credit_exhausted", f"provider_quota_unavailable:{chosen}"),
            "auth": ("claude_auth_failure", "auth_failed", "native_runtime_execution_unavailable"),
        }[self.vendor[chosen]]
        record_provider_cooldown(self.tools, provider=chosen, model="claude-opus", cooldown_seconds=900,
                                 request_id=rid, claim_id=claim["claim_id"], detection={"signature": signature})
        release_claim(claim_id=claim["claim_id"], agent_id="aria-executor", lease_token=claim["lease_token"],
                      reason=release, base_dir=self.tools)
        return _summary(request_id=rid, outcome="failed", failure_class=failure_class, role=role,
                        target_agent=target, provider=chosen, model="claude-opus")

    def _fake_run(self, argv: list[str], **kwargs: Any) -> Any:
        class _Proc:
            def __init__(self, returncode: int = 0, stdout: str = "") -> None:
                self.returncode, self.stdout, self.stderr = returncode, stdout, ""

        if "next-pending" in argv:
            def flag(name: str) -> str | None:
                return argv[argv.index(name) + 1] if name in argv else None

            excluded = {argv[i + 1] for i, arg in enumerate(argv) if arg == "--exclude"}
            row = next_pending_request(role=flag("--role"), target_agent=flag("--target-agent"),
                                       base_dir=self.tools, exclude_request_ids=excluded)
            return _Proc(stdout=json.dumps(row))
        request_id = argv[2]
        request = next(r for r in list_agent_invocation_requests(base_dir=self.tools)
                       if r["request_id"] == request_id)
        summary = self._child(request)
        path = self.tmp / f"summary-{request_id}-{len(self.drain_exits)}.json"
        path.write_text(json.dumps(summary), encoding="utf-8")
        Path(kwargs["env"]["GITHUB_OUTPUT"]).write_text(f"dispatch_summary_path={path}\n", encoding="utf-8")
        return _Proc(returncode=0 if summary["outcome"] in ("succeeded", "refused") else 1)

    def drain(self, moment: datetime) -> int:
        with _at(moment), patch.object(ci_executor_drain.subprocess, "run", side_effect=self._fake_run), \
                patch.object(ci_executor_drain, "_executor_policy", return_value={
                    "max_concurrent": 1, "worktree_per_request": False, "surplus_after_planning_turn": 0}), \
                patch.dict("os.environ", {"RUNNER_TEMP": str(self.tmp)}):
            code = ci_executor_drain.drain_pending(tools_dir=self.tools, repo_root=_REPO_ROOT)
        self.drain_exits.append((_iso(moment), code))
        return code

    # --- the cycle: the kernel-only phases, in the orchestrator's order --------------------

    def cycle(self, moment: datetime, *, day: int) -> dict[str, Any]:
        with _at(moment):
            sweep = sweep_expired_anchors(base_dir=self.tools, now=moment)
            reaped = reap_stale_claims(base_dir=self.tools, now=moment)
            worker_reaped = reap_expired_assignment_claims(base_dir=self.tools, now=moment)
            adopted = resume_candidate_plan_id(base_dir=self.tools)
            in_flight = in_flight_plan_id(base_dir=self.tools)
            from aria_kernel.provider_clock import provider_clock

            requests = list_agent_invocation_requests(base_dir=self.tools)
            orphans = {
                orphan["plan_id"]: decide_orphan_reap(
                    orphan, clock=provider_clock(self.tools), now=moment,
                    awaits_provider=request_awaits_provider(
                        newest_request_id(requests, plan_id=orphan["plan_id"], role="implementation"),
                        base_dir=self.tools))
                for orphan in scan_orphan_implementation_requests(base_dir=self.tools)
            }
            prolonged = escalate_prolonged_outages(self.tools, now=moment)
            live = [row["queue_item_id"] for row in read_pending(self.tools)]
            # The reflection plans this night's pressures; `pressure:a` is never planned again.
            append_pending(self.tools, source_cycle_id=f"cyc-{day}", pressure_id=f"pressure:night-{day}")
        return {"sweep": sweep, "reaped": reaped, "worker_reaped": worker_reaped, "adopted": adopted,
                "in_flight": in_flight, "orphans": orphans, "prolonged": prolonged, "queue_live": live}

    # --- the store at T0 ------------------------------------------------------------------

    def mint(self) -> None:
        from tests._helpers.operator_acts import operator_set_profile

        with _at(self.t0):
            operator_set_profile("standard", base_dir=self.tools)
            start_plan(plan_id=_PLAN, initial_revision_id="rev-0", plan_content=_plan_content(),
                       base_dir=self.tools)
            self.ids["challenger"] = create_agent_invocation_request(
                target_agent="aria-challenger-planner", role="challenger_plan", suggested_prompt="{}",
                must_satisfy=[{"id": "MS-1", "description": "challenge the primary plan"}],
                allowed_scope=[_IMPL_PATH], evidence_refs=["docs/aria/SPEC.md"],
                convergence_id=_PLAN, round_number=1, base_dir=self.tools,
                admission=admit_request("convergence_drainer.plan_step", "challenger_plan", base_dir=self.tools),
            )["request_id"]
            self.ids["judge"] = create_agent_invocation_request(
                target_agent="aria-evidence-judge", role="evidence_judgment", suggested_prompt="{}",
                must_satisfy=[{"id": "MS-1", "description": "judge the sampled finding"}],
                allowed_scope=["aria-kernel/aria_kernel/"], evidence_refs=["docs/aria/SPEC.md"],
                base_dir=self.tools,
                admission=admit_request("operator_cli.request", "evidence_judgment", base_dir=self.tools),
            )["request_id"]
            self.ids["implementation"] = production_implementation_request(
                tools_dir=self.tools, workspace_root=self.workspace, plan_id=_IMPL_PLAN, allowed_path=_IMPL_PATH,
            )["request_id"]
            self.ids["queue_item"] = append_pending(self.tools, source_cycle_id="cyc-0",
                                                    pressure_id="pressure:a")["queue_item_id"]
            append_declared_fixture(self.tools / "dispatch" / "requests.jsonl", {
                "$schema": "aria/dispatch-request/v2", "schema_version": 2, "assignment_id": _WORKER,
                "pressure_event_id": f"pe-{_WORKER}", "target_agent": "aria-worker", "state": "pending",
                "created_at": _iso(self.t0), "plan_id": _IMPL_PLAN,
            }, expected_surface="dispatch_requests")


def _plan_content() -> dict[str, Any]:
    return {
        "schema_version": 1, "title": "total outage plan", "summary": "A plan the outage holds mid-round.",
        "affected_surfaces": [{"paths": [_IMPL_PATH]}], "key_changes": ["apply the declared change"],
        "validation_commands": [{"cmd": "nx affected --target=lint", "timeout_ms": 600_000}],
        "evidence_refs": ["docs/aria/SPEC.md"], "architectural_tier": 1,
    }


class TenDaysWithoutAProviderLoseNothing(unittest.TestCase):
    """The scenario runs once; each test reads one claim off it."""

    @classmethod
    def setUpClass(cls) -> None:
        cls._tmp = Path(tempfile.mkdtemp(prefix="aria-total-outage-"))
        # Every scenario moment lies in the real past, so nothing the frozen clock does not
        # reach (a function-local `datetime` import) can stamp a row earlier than one it did.
        t0 = (_REAL.now(timezone.utc) - timedelta(days=12)).replace(minute=0, second=0, microsecond=0)
        cls.t0 = t0
        s = cls.s = _Scenario(cls._tmp, t0)
        s.mint()
        cls.before = {"attempts": len(counted_delivery_attempts(
            fold_plan_state(plan_id=_IMPL_PLAN, base_dir=s.tools)))}

        # T0+1h: a running judge spends Anthropic's weekly window (the CLI's rate_limit_event).
        with _at(t0 + timedelta(minutes=50)):
            claim = claim_request(request_id=s.ids["judge"], agent_id="aria-executor", base_dir=s.tools)
        with _at(t0 + timedelta(hours=1)):
            record_provider_cooldown(s.tools, provider="anthropic", model="claude-opus", cooldown_seconds=900,
                                     request_id=s.ids["judge"], claim_id=claim["claim_id"], detection={
                                         "source": "rate_limit_event", "signature": "claude_rate_limit_event",
                                         "trigger": "rejected", "status": "rejected",
                                         "resets_at": _iso(t0 + timedelta(days=7))})
            release_claim(claim_id=claim["claim_id"], agent_id="aria-executor", lease_token=claim["lease_token"],
                          reason="provider_quota_unavailable:anthropic", base_dir=s.tools)
        s.vendor.update(anthropic="quota", zai="quota", openai="logged_out")
        s.drain(t0 + timedelta(hours=2))  # Z.ai and Codex are met at the admission.

        cls.cycles: list[dict[str, Any]] = []
        for day in range(10):
            midnight = t0 + timedelta(days=day)
            if day == 7:
                s.vendor["anthropic"] = "auth"  # the reset came; the subscription did not
            if day == 8:
                # A worker claims in a lapsed back-off; its runner is killed with the claim held.
                with _at(midnight + timedelta(hours=2, minutes=20)):
                    # The route `worker_route` takes: the head, its back-off lapsed.
                    claim_assignment(assignment_id=_WORKER, agent_id="aria-worker", provider="anthropic",
                                     lease_seconds=1800, base_dir=s.tools)
            s.drain(midnight + timedelta(hours=2, minutes=30))
            cls.cycles.append(s.cycle(midnight + timedelta(hours=17, minutes=15), day=day))
            s.drain(midnight + timedelta(hours=17, minutes=45))

        # The end of the outage, read before anything is restored.
        end = t0 + timedelta(days=10)
        with _at(end):
            cls.outage_end = {
                "states": {key: derive_request_state(request_id=rid, base_dir=s.tools)
                           for key, rid in s.ids.items() if key != "queue_item"},
                "breaker": circuit_breaker.current_state(s.tools),
                "items": human_required.list_human_required(base_dir=s.tools),
                "queue_live": [row["queue_item_id"] for row in read_pending(s.tools)],
            }
        cls.claims = load_jsonl(s.tools / "agent-invocations" / "claims.jsonl")
        cls.requests = list_agent_invocation_requests(base_dir=s.tools)
        cls.queue_rows = load_jsonl(s.tools / "queues" / "next_cycle_queue.jsonl")

        # Day 10, 02:30: the subscription is renewed; the drain's re-probe is served.
        s.vendor["anthropic"] = "serves"
        cls.restore_exit = s.drain(end + timedelta(hours=2, minutes=30))
        cls.resumed: dict[str, Any] = {}
        after = end + timedelta(hours=3)
        with _at(after):
            r = cls.resumed
            r["outages"] = sorted((i.provider, i.kind) for i in open_outages(s.tools))
            r["states"] = {key: derive_request_state(request_id=s.ids[key], base_dir=s.tools)
                           for key in ("judge", "challenger", "implementation")}
            r["challenger_route"] = provider_outage("challenger_plan", cooled_providers(s.tools, now=after), now=after)
            r["adopted"] = resume_candidate_plan_id(base_dir=s.tools)
            r["step"] = step_request_disposition(
                [row for row in list_agent_invocation_requests(base_dir=s.tools)
                 if row.get("convergence_id") == _PLAN], role="challenger_plan", base_dir=s.tools)
            r["queue_live"] = [row["queue_item_id"] for row in read_pending(s.tools)]
            r["projection"] = admit_request("next_cycle_queue.projection", "maintenance_utility", base_dir=s.tools)
            r["worker_claim"] = claim_assignment(assignment_id=_WORKER, agent_id="aria-worker", provider="anthropic",
                                                 lease_seconds=1800, base_dir=s.tools)["claim_id"]
            r["worker_expiries"] = _lease_expiry_count(s.tools, _WORKER)
            r["breaker"] = circuit_breaker.current_state(s.tools)
            r["ages"] = {role: provider_available_age(t0, after, roles=[role], base_dir=s.tools)
                         for role in ("challenger_plan", "evidence_judgment")}

    @classmethod
    def tearDownClass(cls) -> None:
        shutil.rmtree(cls._tmp, ignore_errors=True)

    # --- through the outage -------------------------------------------------------------------

    def test_the_outage_was_total_and_longer_than_every_window(self) -> None:
        from aria_kernel.agent_invocations import _anchor_max_age_seconds

        window = timedelta(seconds=_anchor_max_age_seconds(self.s.tools))
        self.assertGreater(timedelta(days=10), window)
        self.assertGreater(timedelta(days=10), timedelta(hours=plan_convergence.STALE_PLAN_MAX_AGE_HOURS))
        opened = {(row["details"]["provider"], row["details"]["outage_kind"])
                  for row in load_jsonl(self.s.tools / "governance.jsonl")
                  if row.get("kind") == "provider_outage_opened"}
        self.assertEqual(opened, {("anthropic", "quota"), ("anthropic", "auth"), ("zai", "quota"),
                                  ("openai", "logged_out")})

    def test_no_request_expired_was_escalated_or_charged(self) -> None:
        self.assertEqual({key: state in ("PENDING", "REQUEUED") for key, state in self.outage_end["states"].items()},
                         {"challenger": True, "judge": True, "implementation": True})
        self.assertEqual([row for row in self.claims
                          if row.get("event") in ("anchor_stale", "stale", "human_required")], [])
        for rid in (self.s.ids["challenger"], self.s.ids["judge"], self.s.ids["implementation"]):
            self.assertEqual(_request_fault_requeue_count(self.claims, rid), 0, rid)
        self.assertEqual([row["request_id"] for row in self.requests if row.get("remint_of")], [])
        self.assertTrue(all(c["sweep"]["swept"] == 0 for c in self.cycles))

    def test_no_plan_was_abandoned_or_reaped(self) -> None:
        self.assertEqual({c["adopted"] for c in self.cycles}, {_PLAN})
        self.assertEqual({c["in_flight"] for c in self.cycles}, {_PLAN})
        self.assertTrue(all(c["orphans"][_IMPL_PLAN].decision == ORPHAN_DECISION_SPARE_RECENT for c in self.cycles))
        self.assertEqual(fold_plan_state(plan_id=_IMPL_PLAN, base_dir=self.s.tools)["state"],
                         "IMPLEMENTATION_REQUESTED")
        self.assertEqual(len(counted_delivery_attempts(fold_plan_state(plan_id=_IMPL_PLAN, base_dir=self.s.tools))),
                         self.before["attempts"])

    def test_the_queued_item_outlived_the_window(self) -> None:
        qid = self.s.ids["queue_item"]
        self.assertIn(qid, self.outage_end["queue_live"])
        self.assertEqual([row for row in self.queue_rows
                          if row.get("queue_item_id") == qid and row.get("state") == EXPIRED], [])

    def test_a_killed_workers_lease_spent_no_budget(self) -> None:
        released = [row for c in self.cycles for row in c["worker_reaped"]["expired"]]
        self.assertEqual(len(released), 1)
        self.assertTrue(released[0]["reason"].startswith("lease_expired_during_provider_outage:"), released[0])
        self.assertEqual(_lease_expiry_count(self.s.tools, _WORKER), 0)

    def test_only_the_outages_transitions_were_failures(self) -> None:
        red = [moment for moment, code in self.s.drain_exits if code != 0]
        # The one red drain is the one whose child met the subscription's lapse first (day 7).
        self.assertEqual(red, [_iso(self.t0 + timedelta(days=7, hours=2, minutes=30))])
        self.assertEqual(self.outage_end["breaker"], "ok")

    def test_the_only_operator_items_are_the_outages(self) -> None:
        kinds = sorted((item.get("context") or {}).get("kind") for item in self.outage_end["items"])
        self.assertEqual(kinds, ["provider_outage"] * 4)
        self.assertTrue(all(c["prolonged"] == [] for c in self.cycles))

    # --- after the first provider returns ------------------------------------------------------

    def test_the_restore_closes_only_the_returning_providers_outage(self) -> None:
        self.assertEqual(self.restore_exit, 0)
        self.assertEqual(self.resumed["outages"], [("openai", "logged_out"), ("zai", "quota")])

    def test_the_first_drain_after_the_restore_serves_the_waiting_requests(self) -> None:
        ids, r = self.s.ids, self.resumed
        # Both reads were taken up by Anthropic's spawn: the judge on its head, the
        # challenger past its cooled Z.ai head (the seat's rung 2).
        self.assertEqual({key: self.s.served.get(ids[key]) for key in ("judge", "challenger")},
                         {"judge": "anthropic", "challenger": "anthropic"})
        self.assertEqual((r["states"]["judge"], r["states"]["challenger"]), ("CLAIMED", "CLAIMED"))
        self.assertIsNone(r["challenger_route"])

    def test_the_waiting_plan_continues_from_its_own_step(self) -> None:
        r = self.resumed
        self.assertEqual(r["adopted"], _PLAN)
        self.assertEqual((r["step"].kind, r["step"].request_id, r["step"].remints_so_far),
                         ("live", self.s.ids["challenger"], 0))

    def test_the_rest_of_the_work_is_where_it_was(self) -> None:
        r = self.resumed
        self.assertIn(r["states"]["implementation"], ("PENDING", "REQUEUED"))
        self.assertIn(self.s.ids["queue_item"], r["queue_live"])
        self.assertTrue(r["projection"].admitted, r["projection"])
        self.assertTrue(r["worker_claim"])
        self.assertEqual(r["worker_expiries"], 0)
        self.assertEqual(r["breaker"], "ok")

    def test_the_clocks_count_again_only_for_the_returned_providers_roles(self) -> None:
        ages = self.resumed["ages"]
        # Z.ai still heads the challenger's role: its 10 days stay paused.
        self.assertLess(ages["challenger_plan"], timedelta(hours=3))
        # Anthropic's: the hour before the outage and the time since the restore.
        self.assertGreater(ages["evidence_judgment"], timedelta(hours=1))
        self.assertLess(ages["evidence_judgment"], timedelta(hours=2))


if __name__ == "__main__":
    unittest.main()
