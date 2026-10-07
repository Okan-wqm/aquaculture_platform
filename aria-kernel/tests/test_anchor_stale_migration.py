"""ARIA-HIGH-360 — the open backlog, panel envelopes, sweep cost and crash safety.

Pins (production writers, ``tests/_helpers/anchor_stale_store``):

* an open anchor_stale record a panel was opened for goes through the same
  rule; its panel is never folded or re-opened again, and its envelopes are
  moot whether selected by poll or claimed by id;
* a historical anchor_stale panel's fold still replays, and acts on nothing;
* a judge re-mint waits while the judge backlog is full, reading no ledger;
  decisions per sweep are bounded, newest first;
* raw findings and feedback are read once per sweep, and not at all when
  nothing is due (review of PR #1825: the runner has an OOM history);
* a crash mid-batch leaves the started governance row, and the next sweep
  decides what was not written.
"""
from __future__ import annotations

import json
import unittest
from unittest.mock import patch

from aria_kernel import anchor_stale
from aria_kernel import human_required_adjudication as hra
from aria_kernel.agent_invocations import claim_request, next_pending_request
from aria_kernel.anchor_stale_effects import DISPOSITION_OPERATOR, DISPOSITION_PRODUCER_OWNED, DISPOSITION_REMINTED
from aria_kernel.feedback_store import record_operator_feedback
from aria_kernel.human_required import RESOLVED_BY_KERNEL, list_human_required, record_human_required
from aria_kernel.judge_subject_liveness import JudgeSubjectLiveness
from aria_kernel.tool_registry import GovernanceError

from tests._helpers.adjudication import seed_adjudicator_opinion
from tests._helpers.anchor_stale_store import EVIDENCE_JUDGE, AnchorStaleStore, item


class _Panels(AnchorStaleStore):
    def panel_rows(self) -> list[dict]:
        path = self.tools / "human-required" / "adjudications.jsonl"
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]

    def claimable_panel_envelope(self) -> str | None:
        request = next_pending_request(role=hra.ADJUDICATION_ROLE, base_dir=self.tools)
        return None if request is None else str(request["request_id"])


class OpenRecordsAreMigrated(_Panels):
    def test_the_record_closes_and_its_panel_is_never_reopened(self) -> None:
        dead = self.mint_judges(1)[EVIDENCE_JUDGE]
        self.expire(dead)
        panel = self.open_record_with_panel(dead)
        for request_id in panel:
            self.expire(request_id)
        before = hra.sweep_human_required_adjudications(base_dir=self.tools)
        self.assertEqual((before["folded"], before["reopened"], before["opened"]), ([], [], []))

        summary = self.sweep()

        self.assertEqual(summary["disposed"][0]["request_id"], dead)
        self.assertTrue(summary["disposed"][0]["migrated"])
        record = self.record(dead)
        self.assertEqual((record["status"], record["resolved_by"]), ("resolved", RESOLVED_BY_KERNEL))
        self.assertEqual(record["kernel_disposition"]["closed_panel_request_ids"], panel)
        self.assertEqual(record["kernel_disposition"]["disposition"], DISPOSITION_REMINTED)
        # The dead panel envelopes are the panel's own: no record of their own.
        for request_id in panel:
            self.assertFalse(self.record_path(request_id).exists())
        self.assertEqual(list_human_required(base_dir=self.tools), [])
        after = hra.sweep_human_required_adjudications(base_dir=self.tools)
        self.assertEqual((after["folded"], after["reopened"], after["opened"]), ([], [], []))
        self.assertEqual(len(self.panel_rows()), 1)

    def test_an_open_record_with_no_recovering_producer_stays_open_once(self) -> None:
        self.seed_row("AIR-ci-1", role="change_intelligence", target_agent="aria-change-intelligence")
        self.open_record_with_panel("AIR-ci-1")
        self.sweep()
        record = self.record("AIR-ci-1")
        self.assertEqual(record["status"], "open")
        self.assertEqual(record["kernel_disposition"]["disposition"], DISPOSITION_OPERATOR)
        self.assertEqual(self.sweep()["disposed"], [])

    def test_a_planning_record_is_closed_as_the_drainers(self) -> None:
        self.seed_row("AIR-plan-2", role="challenger_plan", target_agent="aria-challenger-planner",
                      convergence_id="plan-2", round_number=1, target_sha=self.first_sha)
        record_human_required(request_id="AIR-plan-2", reason="died ANCHOR_STALE unclaimed",
                              context={"kind": anchor_stale.ANCHOR_STALE_KIND, "request_id": "AIR-plan-2"},
                              base_dir=self.tools)
        self.sweep()
        disposition = self.disposition("AIR-plan-2")
        self.assertEqual((disposition["disposition"], disposition["reason"]),
                         (DISPOSITION_PRODUCER_OWNED, "producer_owned:convergence_drainer"))

    def test_a_record_whose_request_left_the_ledger_goes_to_the_operator(self) -> None:
        record_human_required(request_id="AIR-gone", reason="died ANCHOR_STALE unclaimed",
                              context={"kind": anchor_stale.ANCHOR_STALE_KIND, "request_id": "AIR-gone",
                                       "role": "evidence_judgment"}, base_dir=self.tools)
        self.sweep()
        record = self.record("AIR-gone")
        self.assertEqual((record["status"], record["kernel_disposition"]["reason"]), ("open", "request_not_in_ledger"))


class PanelEnvelopesAreMoot(_Panels):
    def test_an_envelope_of_a_kind_no_panel_decides_is_moot_before_migration(self) -> None:
        dead = self.mint_judges(1)[EVIDENCE_JUDGE]
        self.expire(dead)
        panel = self.open_record_with_panel(dead)
        self.assertIsNone(self.claimable_panel_envelope())
        with self.assertRaisesRegex(GovernanceError, "adjudication_envelope_moot"):
            claim_request(request_id=panel[0], agent_id="judge-a", lease_seconds=600, base_dir=self.tools)

    def test_mootness_follows_the_record(self) -> None:
        self.seed_row("AIR-lease-1", role="maintenance_utility", target_agent="aria-autonomy-planner")
        panel = self.open_record_with_panel("AIR-lease-1", kind="lease_lifecycle")
        self.assertIn(self.claimable_panel_envelope(), panel)
        path = self.record_path("AIR-lease-1")
        open_record = self.record("AIR-lease-1")
        for closed in ({"status": "resolved"}, {"panel_disposition": hra.DISPOSITION_ESCALATE_OPERATOR}):
            with self.subTest(closed=closed):
                path.write_text(json.dumps({**open_record, **closed}), encoding="utf-8")
                self.assertIsNone(self.claimable_panel_envelope())
        path.write_text(json.dumps(open_record), encoding="utf-8")
        self.assertIn(self.claimable_panel_envelope(), panel)


class HistoricalFoldsReplay(_Panels):
    def test_the_fold_replays_and_acts_on_nothing(self) -> None:
        dead = self.mint_judges(1)[EVIDENCE_JUDGE]
        self.expire(dead)
        panel = self.open_record_with_panel(dead)
        for request_id, agent in zip(panel, ("judge-a", "judge-b", "judge-c")):
            seed_adjudicator_opinion(self.tools, request_id, agent_id=agent, verdict=hra.RESOLVE_VERDICT,
                                     disposition=hra.DISPOSITION_RE_MINT)
        before = hra.fold_adjudication(escalation_request_id=dead, base_dir=self.tools)
        self.assertEqual(before.outcome, hra.OUTCOME_RESOLVED)
        record_operator_feedback(
            tool_id="tool-x", run_id="r1", finding_id="F1", verdict="false_positive", severity="medium",
            note="answered", source_type="ai_judge", judge_id=EVIDENCE_JUDGE,
            finding_fingerprint=item(1)["finding_fingerprint"], base_dir=self.tools,
        )
        self.sweep()
        decided = self.record(dead)
        self.assertEqual(decided["kernel_disposition"]["reason"], "subject_closed:already_judged")
        after = hra.fold_adjudication(escalation_request_id=dead, base_dir=self.tools)
        self.assertEqual((after.outcome, after.reason, after.disposition, after.resolve_votes),
                         (before.outcome, before.reason, before.disposition, before.resolve_votes))
        hra.adjudicate_human_required(escalation_request_id=dead, base_dir=self.tools)
        self.assertEqual(self.successors(dead), [])
        self.assertEqual(self.record(dead), decided)


class SweepBoundsAndCost(AnchorStaleStore):
    def test_a_waiting_judge_reads_no_ledger(self) -> None:
        dead = self.mint_judges(1)[EVIDENCE_JUDGE]
        self.mint_judges(2)  # one live evidence-judge envelope: the ceiling below
        self.expire(dead)
        with patch("aria_kernel.genesis_policy.judgment_pipeline_policy", return_value={"max_pending_per_role": 1}), \
                patch.object(JudgeSubjectLiveness, "_raw_rows", side_effect=AssertionError("raw findings read")), \
                patch.object(JudgeSubjectLiveness, "_feedback_rows", side_effect=AssertionError("feedback read")):
            summary = self.sweep()
        self.assertEqual((summary["waiting_judge_backlog_full"], summary["disposed"]), (1, []))
        self.assertFalse(self.record_path(dead).exists())
        self.sweep()  # the shipped ceiling (32) has room
        self.assertEqual(len(self.successors(dead)), 1)

    def test_each_judge_ledger_is_read_once_per_sweep(self) -> None:
        for i in range(1, 4):
            for request_id in self.mint_judges(i).values():
                self.expire(request_id)
        from aria_kernel import feedback_store

        reads: list[str] = []
        real = feedback_store.load_chained_jsonl

        def counting(path, *args, **kwargs):  # type: ignore[no-untyped-def]
            reads.append(path.name)
            return real(path, *args, **kwargs)

        with patch.object(feedback_store, "load_chained_jsonl", side_effect=counting):
            summary = self.sweep()
        self.assertEqual(len(summary["disposed"]), 6)
        self.assertEqual(reads.count("raw-findings.jsonl"), 1)
        self.assertEqual(reads.count("operator-feedback.jsonl"), 1)

    def test_dispositions_per_sweep_are_bounded_newest_first(self) -> None:
        for n in range(3):
            self.seed_row(f"AIR-verify-{n}", role="verification", target_agent="aria-adversarial-judge")
        with patch.object(anchor_stale, "ANCHOR_STALE_DISPOSITIONS_PER_SWEEP", 2):
            first, second, third = self.sweep(), self.sweep(), self.sweep()
        self.assertEqual([d["request_id"] for d in first["disposed"]], ["AIR-verify-2", "AIR-verify-1"])
        self.assertEqual([d["request_id"] for d in second["disposed"]], ["AIR-verify-0"])
        self.assertEqual(third["disposed"], [])


class ACrashMidBatchLosesNothing(AnchorStaleStore):
    def test_the_started_row_survives_and_the_next_sweep_finishes(self) -> None:
        for n in range(3):
            self.seed_row(f"AIR-verify-{n}", role="verification", target_agent="aria-adversarial-judge")
        from aria_kernel import human_required

        real = human_required.write_kernel_disposition
        calls = {"n": 0}

        def crash_on_second(**kwargs):  # type: ignore[no-untyped-def]
            calls["n"] += 1
            if calls["n"] == 2:
                raise RuntimeError("runner killed mid-batch")
            return real(**kwargs)

        with patch.object(anchor_stale, "write_kernel_disposition", side_effect=crash_on_second):
            with self.assertRaises(RuntimeError):
                self.sweep()
        started = self.governance(anchor_stale.STARTED_GOVERNANCE_KIND)
        self.assertEqual([p["request_id"] for p in started[-1]["details"]["planned"]],
                         ["AIR-verify-2", "AIR-verify-1", "AIR-verify-0"])
        self.assertEqual(self.governance(anchor_stale.DISPOSED_GOVERNANCE_KIND), [])
        self.sweep()
        for n in range(3):
            self.assertEqual(self.record(f"AIR-verify-{n}")["status"], "open")
        disposed = self.governance(anchor_stale.DISPOSED_GOVERNANCE_KIND)[-1]["details"]["dispositions"]
        self.assertEqual(sorted(d["request_id"] for d in disposed), ["AIR-verify-0", "AIR-verify-1"])


if __name__ == "__main__":
    unittest.main()
