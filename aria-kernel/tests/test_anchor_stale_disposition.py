"""ARIA-HIGH-360 — the kernel decides what happens to a request that expired unclaimed.

Measured 2026-10-06 on a copy of the runner store (1,866 requests): every
ANCHOR_STALE request got a HUMAN_REQUIRED record (Y7) and every record opened
a three-judge panel, three new requests on the queue that had just failed to
reach the first one. 693 of the 1,866 requests were these panels; all 3,023
folds were ``still_escalated``; no record was ever resolved.

Pins, each against the production writers (the judge fan-out mints the
requests, ``record_raw_findings_for_run`` reports the finding,
``_record_anchor_stale`` expires them, the lease sweep disposes):

* the rule is one function of the request and its expiry cause;
* an expired judge request whose finding a recent run still reports is
  re-minted ONCE, against the current HEAD, with ``remint_of`` lineage;
* a successor that expires as well is dropped (``remint_budget_spent``),
  unless its expiry was harness-class, which spends nothing;
* a closed subject is dropped with the rule that closed it, a role with no
  liveness rule is dropped by name, a planning step is the drainer's;
* no panel request is ever minted for an expiry, and the kind is refused;
* an open record a panel was opened for is migrated by the same rule, its
  panel is never folded or re-opened again, and its envelopes are moot;
* a judge re-mint waits while the judge backlog is at the fan-out's ceiling;
* the per-sweep bound holds, newest first;
* a historical anchor_stale panel's fold still replays, and acts on nothing.
"""
from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Mapping
from unittest.mock import patch

from aria_kernel import anchor_stale
from aria_kernel import human_required_adjudication as hra
from aria_kernel.agent_invocations import (
    _record_anchor_stale,
    list_agent_invocation_requests,
    next_pending_request,
)
from aria_kernel.feedback_store import finding_fingerprint, record_operator_feedback, record_raw_findings_for_run
from aria_kernel.human_required import (
    RESOLVED_BY_KERNEL,
    list_human_required,
    record_human_required,
    sweep_lease_lifecycle_for_human_required,
)
from aria_kernel.judge_fanout import dispatch_judges_for_sample
from aria_kernel.ledger import append_declared_jsonl
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir

from tests._helpers.adjudication import seed_adjudicator_opinion
from tests._helpers.git_fixtures import make_local_git_repo
from tests._helpers.rule_contracts import register_contracted_tool

EVIDENCE_JUDGE = "aria-evidence-judge"
# A reason the release-reason table classifies harness-class: the provider's
# quota, not the request. The anchor clock is ARIA-HIGH-365's; this pins only
# that a harness-class cause on the claim row spends no re-mint budget.
HARNESS_EXPIRY = "provider_quota_unavailable:anthropic"


def _finding(i: int) -> dict:
    return {"id": f"F{i}", "rule": "rule-a", "severity": "medium", "path": f"src/f{i}.py:1",
            "message": "suspicious", "evidence": [f"src/f{i}.py:1"]}


def _item(i: int) -> dict:
    return {
        "tool_id": "tool-x", "run_id": "r1", "cycle_id": "c1", "finding_id": f"F{i}",
        "rule": "rule-a", "severity": "medium", "path": f"src/f{i}.py:1",
        "message": "suspicious", "evidence": [f"src/f{i}.py:1"],
        "finding_fingerprint": finding_fingerprint("tool-x", _finding(i)),
    }


class _Store(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-360-")
        self.repo = make_local_git_repo(Path(self._tmp.name))
        # The store sits in the workspace it is bound to, as `aria-tools` does
        # in production, so the sweep reads the workspace HEAD.
        self.tools = self.repo / "aria-tools"
        ensure_tools_dir(self.tools)
        register_contracted_tool(self.tools, "tool-x")
        self.first_sha = self._head()

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _head(self) -> str:
        return subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=self.repo, text=True, capture_output=True, check=True,
        ).stdout.strip()

    def _commit(self) -> str:
        subprocess.run(
            ["git", "commit", "-q", "--allow-empty", "-m", "fixture: move HEAD"],
            cwd=self.repo, check=True, capture_output=True,
        )
        return self._head()

    def _requests(self) -> list[dict]:
        return list_agent_invocation_requests(base_dir=self.tools)

    def _row(self, request_id: str) -> dict:
        return next(r for r in self._requests() if r["request_id"] == request_id)

    def _report(self, i: int) -> None:
        """A tool run reports finding ``i`` now (the sampler's raw-findings writer)."""
        record_raw_findings_for_run(
            {"tool_id": "tool-x", "run_id": f"r-report-{i}", "cycle_id": "c1", "status": "ok"},
            [_finding(i)], base_dir=self.tools,
        )

    def _mint_judges(self, i: int, *, reported: bool = True) -> dict[str, str]:
        """The fan-out's two envelopes for finding ``i``, by target agent."""
        if reported:
            self._report(i)
        result = dispatch_judges_for_sample(
            sample={"cycle_id": "c1", "items": [_item(i)]},
            base_dir=self.tools, target_sha=self.first_sha,
        )
        return {m["target_agent"]: m["request_id"] for m in result["minted"]}

    def _expire(self, request_id: str, reason: str = "anchor_expired") -> None:
        """The selection boundary's terminal event (production writer)."""
        _record_anchor_stale(self.tools, self._row(request_id), reason, now=datetime.now(timezone.utc))

    def _seed_row(self, request_id: str, *, role: str, target_agent: str) -> None:
        append_declared_jsonl(
            self.tools / "agent-invocations" / "requests.jsonl",
            {
                "$schema": "aria/agent-invocation-request/v1",
                "schema_version": 1,
                "request_id": request_id,
                "role": role,
                "target_agent": target_agent,
                "suggested_prompt": "expired work",
                "must_satisfy": [{"id": "S1", "description": "satisfy S1"}],
                "evidence_refs": [],
                "allowed_scope": ["aria-kernel/**"],
                "expected_output_path": str(self.tools / f"out-{request_id}.json"),
                "state": "pending",
                "created_at": datetime.now(timezone.utc).isoformat(),
            },
            expected_surface="agent_invocation_requests",
        )
        self._expire(request_id)

    def _record_path(self, request_id: str) -> Path:
        return self.tools / "human-required" / f"{request_id}.json"

    def _record(self, request_id: str) -> dict:
        return json.loads(self._record_path(request_id).read_text(encoding="utf-8"))

    def _successors(self, request_id: str) -> list[dict]:
        return [r for r in self._requests() if r.get("remint_of") == request_id]

    def _adjudication_requests(self) -> list[dict]:
        return [r for r in self._requests() if r.get("role") == hra.ADJUDICATION_ROLE]

    def _sweep(self, **kwargs: object) -> dict:
        return sweep_lease_lifecycle_for_human_required(base_dir=self.tools, **kwargs)["anchor_stale"]


class _Subjects:
    """A liveness answer fixed by the test, for the pure decision rule."""

    def __init__(self, closed: str | None = None) -> None:
        self.closed = closed

    def closure_reason(self, request: Mapping[str, Any]) -> str | None:
        return self.closed


class TheRuleIsOneFunctionOfTheCause(unittest.TestCase):
    JUDGE = {"request_id": "AIR-j", "role": "evidence_judgment"}

    def _decide(self, request: Mapping[str, Any], cause: anchor_stale.ExpiryCause, **kwargs: Any):
        facts: dict[str, Any] = {"successor_request_id": None, "budget_spent": 0,
                                 "subjects": _Subjects(), "backlog_full": lambda role: False}
        facts.update(kwargs)
        return anchor_stale.decide_expiry_disposition(request, cause, **facts)

    def test_the_cause_is_classified_by_the_release_reason_table(self) -> None:
        self.assertTrue(anchor_stale.ExpiryCause.from_reason("anchor_expired").spends_remint_budget)
        harness = anchor_stale.ExpiryCause.from_reason(HARNESS_EXPIRY)
        self.assertEqual(harness.fault_class, "harness")
        self.assertFalse(harness.spends_remint_budget)

    def test_each_outcome(self) -> None:
        expired = anchor_stale.ExpiryCause.from_reason("anchor_expired")
        harness = anchor_stale.ExpiryCause.from_reason(HARNESS_EXPIRY)
        cases = [
            ({"role": "challenger_plan"}, expired, {}, ("producer_owned", "producer_owned:convergence_drainer")),
            ({"role": hra.ADJUDICATION_ROLE}, expired, {}, ("producer_owned", "producer_owned:adjudication_panel")),
            (self.JUDGE, expired, {"successor_request_id": "AIR-s"}, ("recovered", "successor_exists")),
            ({"role": "maintenance_utility"}, expired, {}, ("drop", "role_not_remintable")),
            (self.JUDGE, expired, {"budget_spent": 1}, ("drop", "remint_budget_spent")),
            (self.JUDGE, harness, {"budget_spent": 1}, ("remint", "subject_live")),
            (self.JUDGE, expired, {"subjects": _Subjects("already_judged")}, ("drop", "subject_closed:already_judged")),
            (self.JUDGE, expired, {"backlog_full": lambda role: True}, ("wait", "judge_backlog_full")),
            (self.JUDGE, expired, {}, ("remint", "subject_live")),
        ]
        for request, cause, facts, expected in cases:
            with self.subTest(request=request, cause=cause.reason, facts=sorted(facts)):
                decision = self._decide(request, cause, **facts)
                self.assertEqual((decision.action, decision.reason), expected)


class LiveJudgeSubjectIsReMintedOnce(_Store):
    def test_reminted_once_against_head_with_lineage(self) -> None:
        dead = self._mint_judges(1)[EVIDENCE_JUDGE]
        head = self._commit()
        self._expire(dead)

        summary = self._sweep()

        successors = self._successors(dead)
        self.assertEqual(len(successors), 1)
        successor = successors[0]
        self.assertEqual(successor["target_sha"], head)
        self.assertNotEqual(successor["target_sha"], self.first_sha)
        original = self._row(dead)
        for field in ("role", "target_agent", "finding_id", "finding_fingerprint", "tool_id",
                      "run_id", "judgment_group_id", "suggested_prompt", "forbidden_scope"):
            self.assertEqual(successor.get(field), original.get(field), field)
        record = self._record(dead)
        self.assertEqual(record["status"], "resolved")
        self.assertEqual(record["resolved_by"], RESOLVED_BY_KERNEL)
        disposition = record["kernel_disposition"]
        self.assertEqual(disposition["disposition"], anchor_stale.DISPOSITION_REMINTED)
        self.assertEqual(disposition["successor_request_id"], successor["request_id"])
        self.assertEqual((disposition["expiry_reason"], disposition["expiry_fault_class"]),
                         ("anchor_expired", "unclassified"))
        self.assertEqual([d["request_id"] for d in summary["disposed"]], [dead])
        self.assertEqual(self._adjudication_requests(), [])
        # Idempotent: the record is resolved, nothing more is minted.
        self.assertEqual(self._sweep()["disposed"], [])
        self.assertEqual(len(self._successors(dead)), 1)

    def test_a_successor_that_expires_too_is_dropped(self) -> None:
        dead = self._mint_judges(1)[EVIDENCE_JUDGE]
        self._expire(dead)
        self._sweep()
        successor = self._successors(dead)[0]["request_id"]
        self._expire(successor)

        self._sweep()

        disposition = self._record(successor)["kernel_disposition"]
        self.assertEqual(disposition["disposition"], anchor_stale.DISPOSITION_DROPPED)
        self.assertEqual(disposition["reason"], "remint_budget_spent")
        self.assertEqual(self._successors(successor), [])
        self.assertEqual(self._adjudication_requests(), [])

    def test_a_harness_class_expiry_spends_no_budget(self) -> None:
        dead = self._mint_judges(1)[EVIDENCE_JUDGE]
        self._expire(dead, HARNESS_EXPIRY)
        self._sweep()
        second = self._successors(dead)[0]["request_id"]
        self._expire(second)
        self._sweep()
        # The first expiry was the provider's: the second still had its chance.
        third = self._successors(second)[0]["request_id"]
        self._expire(third)
        self._sweep()
        self.assertEqual(self._record(dead)["kernel_disposition"]["expiry_fault_class"], "harness")
        self.assertEqual(self._record(third)["kernel_disposition"]["reason"], "remint_budget_spent")
        self.assertEqual(self._successors(third), [])


class ClosedOrUnownedSubjectsAreDropped(_Store):
    def _reason(self, request_id: str) -> str:
        return self._record(request_id)["kernel_disposition"]["reason"]

    def test_a_finding_this_judge_already_answered(self) -> None:
        dead = self._mint_judges(1)[EVIDENCE_JUDGE]
        record_operator_feedback(
            tool_id="tool-x", run_id="r0", finding_id="F1", verdict="true_positive",
            severity="medium", note="answered through another request", source_type="ai_judge",
            judge_id=EVIDENCE_JUDGE, finding_fingerprint=_item(1)["finding_fingerprint"], base_dir=self.tools,
        )
        self._expire(dead)
        self._sweep()
        self.assertEqual(self._reason(dead), "subject_closed:already_judged")
        self.assertEqual(self._successors(dead), [])

    def test_a_finding_no_run_reported_inside_the_sampling_window(self) -> None:
        dead = self._mint_judges(1)[EVIDENCE_JUDGE]
        self._expire(dead)
        self._sweep(now=datetime.now(timezone.utc) + timedelta(days=8))
        self.assertEqual(self._reason(dead), "subject_closed:finding_not_reported_recently")
        self.assertEqual(self._successors(dead), [])

    def test_a_finding_no_run_ever_reported(self) -> None:
        dead = self._mint_judges(2, reported=False)[EVIDENCE_JUDGE]
        self._expire(dead)
        self._sweep()
        self.assertEqual(self._reason(dead), "subject_closed:finding_not_reported_recently")

    def test_a_role_with_no_liveness_rule(self) -> None:
        self._seed_row("AIR-maint-1", role="maintenance_utility", target_agent="aria-autonomy-planner")
        self._sweep()
        self.assertEqual(self._reason("AIR-maint-1"), "role_not_remintable")
        self.assertEqual(self._successors("AIR-maint-1"), [])

    def test_a_planning_step_is_left_to_the_convergence_drainer(self) -> None:
        self._seed_row("AIR-plan-1", role="challenger_plan", target_agent="aria-challenger-planner")
        summary = self._sweep()
        self.assertEqual(summary["disposed"], [])
        self.assertFalse(self._record_path("AIR-plan-1").exists())
        self.assertEqual(self._successors("AIR-plan-1"), [])


class NoPanelForAnExpiry(_Store):
    def test_the_kind_is_refused_and_no_panel_is_minted(self) -> None:
        verdict = hra.escalation_adjudicability({"context": {"kind": anchor_stale.ANCHOR_STALE_KIND}})
        self.assertFalse(verdict.adjudicable)
        self.assertEqual(verdict.reason, "context_kind_not_admitted:anchor_stale")
        with self.assertRaises(GovernanceError):
            hra.open_adjudication(
                escalation_request_id="AIR-x",
                record={"context": {"kind": anchor_stale.ANCHOR_STALE_KIND}},
                base_dir=self.tools,
            )
        for request_id in self._mint_judges(1).values():
            self._expire(request_id)
        for _ in range(3):
            self._sweep()
            hra.sweep_human_required_adjudications(base_dir=self.tools)
        self.assertEqual(self._adjudication_requests(), [])


class _HistoricalPanel(_Store):
    """A record and panel exactly as the pre-ARIA-HIGH-360 sweep wrote them."""

    def _open_record_with_panel(self, request_id: str, kind: str = anchor_stale.ANCHOR_STALE_KIND) -> list[str]:
        row = self._row(request_id)
        context = {"kind": kind, "request_id": request_id,
                   "role": row["role"], "target_agent": row["target_agent"]}
        record_human_required(
            request_id=request_id,
            reason=f"request {request_id!r} died ANCHOR_STALE unclaimed; panel disposition required",
            context=context, base_dir=self.tools,
        )
        with patch.object(hra, "ADJUDICABLE_CONTEXT_KINDS", hra.ADJUDICABLE_CONTEXT_KINDS | {kind}):
            panel = hra.open_adjudication(
                escalation_request_id=request_id, record={"context": context}, base_dir=self.tools,
            )
        return [str(r) for r in panel["request_ids"]]

    def _panel_rows(self) -> list[dict]:
        path = self.tools / "human-required" / "adjudications.jsonl"
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]

    def _claimable_panel_envelope(self) -> str | None:
        request = next_pending_request(role=hra.ADJUDICATION_ROLE, base_dir=self.tools)
        return None if request is None else str(request["request_id"])


class OpenRecordsAreMigrated(_HistoricalPanel):
    def test_the_record_closes_and_its_panel_is_never_reopened(self) -> None:
        dead = self._mint_judges(1)[EVIDENCE_JUDGE]
        self._expire(dead)
        panel = self._open_record_with_panel(dead)
        # Before the migration the open record's kind is not admitted, so it
        # is neither folded nor re-opened, even with every envelope dead.
        for request_id in panel:
            self._expire(request_id)
        before = hra.sweep_human_required_adjudications(base_dir=self.tools)
        self.assertEqual((before["folded"], before["reopened"], before["opened"]), ([], [], []))
        self.assertIn(
            {"request_id": dead, "reason": "context_kind_not_admitted:anchor_stale"}, before["skipped"],
        )

        summary = self._sweep()

        self.assertEqual(summary["disposed"][0]["request_id"], dead)
        self.assertTrue(summary["disposed"][0]["migrated"])
        record = self._record(dead)
        self.assertEqual(record["status"], "resolved")
        self.assertEqual(record["resolved_by"], RESOLVED_BY_KERNEL)
        self.assertEqual(record["kernel_disposition"]["closed_panel_request_ids"], panel)
        # The same rule as a fresh expiry: the finding still needs the judge.
        self.assertEqual(record["kernel_disposition"]["disposition"], anchor_stale.DISPOSITION_REMINTED)
        self.assertEqual(list_human_required(base_dir=self.tools), [])
        after = hra.sweep_human_required_adjudications(base_dir=self.tools)
        self.assertEqual((after["folded"], after["reopened"], after["opened"]), ([], [], []))
        self.assertEqual(len(self._panel_rows()), 1)
        self.assertEqual(len(self._adjudication_requests()), len(panel))

    def test_an_envelope_of_a_kind_no_panel_decides_is_moot_before_migration(self) -> None:
        dead = self._mint_judges(1)[EVIDENCE_JUDGE]
        self._expire(dead)
        self._open_record_with_panel(dead)
        self.assertIsNone(self._claimable_panel_envelope())

    def test_mootness_follows_the_record(self) -> None:
        self._seed_row("AIR-lease-1", role="maintenance_utility", target_agent="aria-autonomy-planner")
        panel = self._open_record_with_panel("AIR-lease-1", kind="lease_lifecycle")
        self.assertIn(self._claimable_panel_envelope(), panel)
        path = self._record_path("AIR-lease-1")
        open_record = self._record("AIR-lease-1")
        for closed in ({"status": "resolved"}, {"panel_disposition": hra.DISPOSITION_ESCALATE_OPERATOR}):
            with self.subTest(closed=closed):
                path.write_text(json.dumps({**open_record, **closed}), encoding="utf-8")
                self.assertIsNone(self._claimable_panel_envelope())
        # Read, not stored: the record open again makes its envelopes claimable.
        path.write_text(json.dumps(open_record), encoding="utf-8")
        self.assertIn(self._claimable_panel_envelope(), panel)

    def test_a_planning_record_is_closed_as_the_drainers(self) -> None:
        self._seed_row("AIR-plan-2", role="challenger_plan", target_agent="aria-challenger-planner")
        record_human_required(
            request_id="AIR-plan-2", reason="died ANCHOR_STALE unclaimed",
            context={"kind": anchor_stale.ANCHOR_STALE_KIND, "request_id": "AIR-plan-2"},
            base_dir=self.tools,
        )
        self._sweep()
        disposition = self._record("AIR-plan-2")["kernel_disposition"]
        self.assertEqual(disposition["disposition"], anchor_stale.DISPOSITION_PRODUCER_OWNED)
        self.assertEqual(disposition["reason"], "producer_owned:convergence_drainer")
        self.assertEqual(self._successors("AIR-plan-2"), [])

    def test_a_record_whose_request_left_the_ledger_is_dropped_by_name(self) -> None:
        record_human_required(
            request_id="AIR-gone", reason="died ANCHOR_STALE unclaimed",
            context={"kind": anchor_stale.ANCHOR_STALE_KIND, "request_id": "AIR-gone",
                     "role": "evidence_judgment"},
            base_dir=self.tools,
        )
        self._sweep()
        record = self._record("AIR-gone")
        self.assertEqual(record["status"], "resolved")
        self.assertEqual(record["kernel_disposition"]["reason"], "request_not_in_ledger")


class HistoricalFoldsReplay(_HistoricalPanel):
    def test_the_fold_replays_and_acts_on_nothing(self) -> None:
        dead = self._mint_judges(1)[EVIDENCE_JUDGE]
        self._expire(dead)
        panel = self._open_record_with_panel(dead)
        for request_id, agent in zip(panel, ("judge-a", "judge-b", "judge-c")):
            seed_adjudicator_opinion(
                self.tools, request_id, agent_id=agent, verdict=hra.RESOLVE_VERDICT,
                disposition=hra.DISPOSITION_RE_MINT,
            )
        before = hra.fold_adjudication(escalation_request_id=dead, base_dir=self.tools)
        self.assertEqual(before.outcome, hra.OUTCOME_RESOLVED)
        # The kernel decides first: this judge has answered since.
        record_operator_feedback(
            tool_id="tool-x", run_id="r1", finding_id="F1", verdict="false_positive",
            severity="medium", note="answered", source_type="ai_judge",
            judge_id=EVIDENCE_JUDGE, finding_fingerprint=_item(1)["finding_fingerprint"], base_dir=self.tools,
        )
        self._sweep()
        decided = self._record(dead)
        self.assertEqual(decided["kernel_disposition"]["reason"], "subject_closed:already_judged")

        after = hra.fold_adjudication(escalation_request_id=dead, base_dir=self.tools)
        self.assertEqual(
            (after.outcome, after.reason, after.disposition, after.resolve_votes),
            (before.outcome, before.reason, before.disposition, before.resolve_votes),
        )
        # Replaying the panel's effect changes nothing the kernel decided.
        hra.adjudicate_human_required(escalation_request_id=dead, base_dir=self.tools)
        self.assertEqual(self._successors(dead), [])
        self.assertEqual(self._record(dead), decided)


class SweepBounds(_Store):
    def test_a_judge_remint_waits_while_the_backlog_is_full(self) -> None:
        dead = self._mint_judges(1)[EVIDENCE_JUDGE]
        self._mint_judges(2)  # one live evidence-judge envelope: the ceiling below
        self._expire(dead)
        with patch("aria_kernel.genesis_policy.judgment_pipeline_policy",
                   return_value={"max_pending_per_role": 1}):
            summary = self._sweep()
        self.assertEqual(summary["waiting_judge_backlog_full"], 1)
        self.assertFalse(self._record_path(dead).exists())
        self.assertEqual(self._successors(dead), [])
        self._sweep()  # the shipped ceiling (32) has room
        self.assertEqual(len(self._successors(dead)), 1)

    def test_dispositions_per_sweep_are_bounded_newest_first(self) -> None:
        for n in range(3):
            self._seed_row(f"AIR-maint-{n}", role="maintenance_utility", target_agent="aria-autonomy-planner")
        with patch.object(anchor_stale, "ANCHOR_STALE_DISPOSITIONS_PER_SWEEP", 2):
            first = self._sweep()
            second = self._sweep()
            third = self._sweep()
        self.assertEqual([d["request_id"] for d in first["disposed"]], ["AIR-maint-2", "AIR-maint-1"])
        self.assertEqual([d["request_id"] for d in second["disposed"]], ["AIR-maint-0"])
        self.assertEqual(third["disposed"], [])


if __name__ == "__main__":
    unittest.main()
