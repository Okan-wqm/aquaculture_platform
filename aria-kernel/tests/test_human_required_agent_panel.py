"""ORPHAN-HIGH-426 — independent-agent adjudication of HUMAN_REQUIRED.

Operator direction: escalations should be adjudicated by independent
agents rather than waiting on a human. The safety of that rests entirely
on the panel being provably composed of distinct principals, so these
cases pin the fail-closed edges rather than the happy path alone.

Locked cases:
  * I-PANEL-01 — an escalation with no classifiable context is NOT
    agent-adjudicable (fail-closed default)
  * I-PANEL-02 — the irreducible classes are never agent-adjudicable
  * I-PANEL-03 — an unadmitted context kind is irreducible by omission
  * I-PANEL-04 — an L3 / blocked work scope is never agent-adjudicable
  * I-PANEL-05 — opening a panel on an irreducible escalation is refused
  * I-PANEL-06 — the registered panel targets are three DISTINCT agents
  * I-PANEL-07 — a folded verdict with no adjudication opened stays escalated
  * I-PANEL-08 — an incomplete panel stays escalated
  * I-PANEL-09 — one "insufficient_evidence" blocks resolution even with a quorum
  * I-PANEL-10 — a panel whose members share an agent_id stays escalated
  * I-PANEL-11 — a quorum of independent resolve votes clears the escalation
    and records resolved_by=agent_panel
  * I-PANEL-12 — an agent panel may NEVER write a ground-truth verdict
  * I-PANEL-13 — an agent panel may NEVER close a record without stating
    WHICH decision it reached (pinned end-to-end in
    test_jj2_humanless_promotion.PanelDecisionIsRecordedNotInferredTests)
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
_KERNEL_ROOT = _REPO_ROOT / "aria-kernel"
if str(_KERNEL_ROOT) not in sys.path:
    sys.path.insert(0, str(_KERNEL_ROOT))

from aria_kernel import human_required_adjudication as hra  # noqa: E402
from aria_kernel.agent_surface import allowed_targets_for_role  # noqa: E402
from aria_kernel.human_required import (  # noqa: E402
    RESOLVED_BY_AGENT_PANEL,
    record_human_required,
    resolve_human_required,
)
from aria_kernel.ledger import append_declared_jsonl  # noqa: E402
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir  # noqa: E402


class AdjudicabilityGate(unittest.TestCase):
    """The gate that decides whether agents may touch an escalation."""

    # I-PANEL-01
    def test_i_panel_01_no_context_is_not_adjudicable(self) -> None:
        for record in ({}, {"context": {}}, {"context": {"kind": "  "}}):
            with self.subTest(record=record):
                verdict = hra.escalation_adjudicability(record)
                self.assertFalse(verdict.adjudicable, verdict.reason)

    # I-PANEL-02
    def test_i_panel_02_irreducible_kinds_are_never_adjudicable(self) -> None:
        self.assertIn("profile_transition", hra.IRREDUCIBLE_CONTEXT_KINDS)
        self.assertIn("credential_mint", hra.IRREDUCIBLE_CONTEXT_KINDS)
        for kind in sorted(hra.IRREDUCIBLE_CONTEXT_KINDS):
            with self.subTest(kind=kind):
                verdict = hra.escalation_adjudicability({"context": {"kind": kind}})
                self.assertFalse(verdict.adjudicable)
                self.assertIn("irreducible_context_kind", verdict.reason)
        # An irreducible kind can never also be admitted.
        self.assertEqual(
            hra.IRREDUCIBLE_CONTEXT_KINDS & hra.ADJUDICABLE_CONTEXT_KINDS, frozenset(),
        )

    # I-PANEL-03
    def test_i_panel_03_unadmitted_kind_is_irreducible_by_omission(self) -> None:
        verdict = hra.escalation_adjudicability(
            {"context": {"kind": "a_brand_new_escalation_source"}},
        )
        self.assertFalse(verdict.adjudicable)
        self.assertIn("not_admitted", verdict.reason)

    # I-PANEL-04
    def test_i_panel_04_control_plane_scope_is_not_adjudicable(self) -> None:
        # aria-kernel/** classifies L3 in the repo's own risk policy.
        verdict = hra.escalation_adjudicability({
            "context": {
                "kind": "lease_lifecycle",
                "changed_files": ["aria-kernel/aria_kernel/cli.py"],
            },
        })
        self.assertFalse(verdict.adjudicable)
        self.assertIn("irreducible_risk_lane:L3", verdict.reason)
        # An unclassifiable changed_files list is also refused.
        self.assertFalse(
            hra.escalation_adjudicability({
                "context": {"kind": "lease_lifecycle", "changed_files": []},
            }).adjudicable,
        )

    def test_admitted_kind_without_files_is_adjudicable(self) -> None:
        # Y8 (ORPHAN-709) — genesis_candidate is admitted WITH fail-closed
        # identity requirements: the lifecycle proof resolver needs the gap
        # key, the resolver decision ref, and the gap's evidence, so a bare
        # context is deliberately NOT adjudicable for that kind alone.
        genesis_identity = {
            "capability_gap_key": "shadow_run:tool-x",
            "capability_resolution_ref": "res-1",
            "evidence_refs": ["apps/svc/src/a.ts"],
        }
        for kind in sorted(hra.ADJUDICABLE_CONTEXT_KINDS):
            with self.subTest(kind=kind):
                context: dict = {"kind": kind}
                if kind == "genesis_candidate":
                    context.update(genesis_identity)
                # JJ-2b (ORPHAN-HIGH-732) — tool_promotion is admitted with
                # its own fail-closed identity: the executor resolves the
                # adapter from context.tool_id, so a promotion question that
                # cannot name its subject must never clear.
                if kind == "tool_promotion":
                    context.update({
                        "tool_id": "x-adapter",
                        "evidence_refs": ["aria-tools/runs.jsonl#x-adapter"],
                    })
                # JJ-3 (ORPHAN-HIGH-755) — belief_escalation is admitted with
                # its own fail-closed identity: the panel authorises a
                # correction against ONE belief, so an escalation that cannot
                # name it is not adjudicable.
                if kind == "belief_escalation":
                    context.update({"belief_id": "B-contradicted"})
                self.assertTrue(
                    hra.escalation_adjudicability({"context": context}).adjudicable,
                )


class PanelComposition(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-panel-")
        self.tools = Path(self._tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    # I-PANEL-05
    def test_i_panel_05_open_refuses_irreducible_escalation(self) -> None:
        with self.assertRaises(GovernanceError) as ctx:
            hra.open_adjudication(
                escalation_request_id="AIR-irreducible",
                record={"context": {"kind": "profile_transition"}},
                base_dir=self.tools,
            )
        self.assertIn("not_agent_adjudicable", str(ctx.exception))

    # I-PANEL-06
    def test_i_panel_06_registered_targets_are_three_distinct_agents(self) -> None:
        targets = allowed_targets_for_role(hra.ADJUDICATION_ROLE) or ()
        self.assertGreaterEqual(len(set(targets)), hra.DEFAULT_PANEL_SIZE)
        self.assertEqual(
            len(set(targets)), len(targets),
            msg="panel targets must be distinct so a panel cannot be one agent",
        )

    def test_open_mints_one_request_per_distinct_target(self) -> None:
        row = hra.open_adjudication(
            escalation_request_id="AIR-open-ok",
            record={"context": {"kind": "lease_lifecycle"}},
            base_dir=self.tools,
        )
        self.assertEqual(len(row["panel"]), hra.DEFAULT_PANEL_SIZE)
        self.assertEqual(len(set(row["panel"])), hra.DEFAULT_PANEL_SIZE)
        self.assertEqual(len(set(row["request_ids"])), hra.DEFAULT_PANEL_SIZE)


class PanelFold(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-panel-fold-")
        self.tools = Path(self._tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)
        self.escalation_id = "AIR-escalated-1"
        record_human_required(
            request_id=self.escalation_id,
            reason="three claims released without delivering",
            context={"kind": "lease_lifecycle"},
            base_dir=self.tools,
        )

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _open(self) -> list[str]:
        row = hra.open_adjudication(
            escalation_request_id=self.escalation_id,
            record={"context": {"kind": "lease_lifecycle"}},
            base_dir=self.tools,
        )
        return [str(r) for r in row["request_ids"]]

    def _seed_opinion(
        self, request_id: str, *, agent_id: str, verdict: str,
        disposition: str | None = None,
    ) -> None:
        """Write a claim row + an accepted result + its output payload.

        Goes through ``append_declared_jsonl`` rather than writing lines
        directly: both ledgers are hash-chained declared surfaces, and a
        hand-written row fails strict verification — which is itself the
        integrity discipline these gates depend on.
        """
        invocations = self.tools / "agent-invocations"
        invocations.mkdir(parents=True, exist_ok=True)
        output = invocations / f"{request_id}.opinion.json"
        payload = {"verdict": verdict, "rationale": f"{agent_id} says {verdict}"}
        if disposition is not None:
            payload["disposition"] = disposition
        output.write_text(json.dumps(payload), encoding="utf-8")
        append_declared_jsonl(
            invocations / "claims.jsonl",
            {
                "request_id": request_id,
                "claim_id": f"claim-{request_id}",
                "agent_id": agent_id,
            },
            expected_surface="agent_invocation_claims",
        )
        append_declared_jsonl(
            invocations / "results.jsonl",
            {
                "request_id": request_id,
                "role": hra.ADJUDICATION_ROLE,
                "status": "accepted",
                "agent_id": agent_id,
                "output_path": output.as_posix(),
                "output_hash": "sha256:" + "0" * 64,
            },
            expected_surface="agent_invocation_results",
        )

    # I-PANEL-07
    def test_i_panel_07_no_adjudication_opened_stays_escalated(self) -> None:
        verdict = hra.fold_adjudication(
            escalation_request_id="AIR-never-opened", base_dir=self.tools,
        )
        self.assertEqual(verdict.outcome, hra.OUTCOME_STILL_ESCALATED)
        self.assertEqual(verdict.reason, "no_adjudication_opened")
        self.assertFalse(verdict.clears_escalation)

    # I-PANEL-08
    def test_i_panel_08_incomplete_panel_stays_escalated(self) -> None:
        request_ids = self._open()
        # Only two of three answer.
        self._seed_opinion(request_ids[0], agent_id="judge-a", verdict=hra.RESOLVE_VERDICT)
        self._seed_opinion(request_ids[1], agent_id="judge-b", verdict=hra.RESOLVE_VERDICT)
        verdict = hra.fold_adjudication(
            escalation_request_id=self.escalation_id, base_dir=self.tools,
        )
        self.assertEqual(verdict.outcome, hra.OUTCOME_STILL_ESCALATED)
        self.assertIn("panel_incomplete", verdict.reason)

    # I-PANEL-09
    def test_i_panel_09_insufficient_evidence_blocks_even_with_quorum(self) -> None:
        request_ids = self._open()
        self._seed_opinion(request_ids[0], agent_id="judge-a", verdict=hra.RESOLVE_VERDICT)
        self._seed_opinion(request_ids[1], agent_id="judge-b", verdict=hra.RESOLVE_VERDICT)
        self._seed_opinion(
            request_ids[2], agent_id="judge-c", verdict=hra.INSUFFICIENT_VERDICT,
        )
        verdict = hra.fold_adjudication(
            escalation_request_id=self.escalation_id, base_dir=self.tools,
        )
        self.assertEqual(verdict.resolve_votes, 2)
        self.assertGreaterEqual(verdict.resolve_votes, verdict.quorum_required)
        self.assertEqual(verdict.outcome, hra.OUTCOME_STILL_ESCALATED)
        self.assertIn("insufficient_evidence_votes", verdict.reason)

    # I-PANEL-10
    def test_i_panel_10_shared_principal_stays_escalated(self) -> None:
        request_ids = self._open()
        for request_id in request_ids:
            self._seed_opinion(
                request_id, agent_id="one-agent", verdict=hra.RESOLVE_VERDICT,
            )
        verdict = hra.fold_adjudication(
            escalation_request_id=self.escalation_id, base_dir=self.tools,
        )
        self.assertEqual(verdict.outcome, hra.OUTCOME_STILL_ESCALATED)
        self.assertIn("panel_not_independent", verdict.reason)
        self.assertFalse(verdict.independence_ok)
        self.assertTrue(
            any("same_agent_id" in r for r in verdict.independence_reasons),
            verdict.independence_reasons,
        )

    # I-PANEL-11
    def test_i_panel_11_independent_quorum_clears_escalation(self) -> None:
        request_ids = self._open()
        # Y7 (ORPHAN-708) — DELIBERATE REWRITE: on an OPERATIONAL kind a
        # resolve vote must carry a disposition; a dispositionless quorum
        # now stamps escalate_operator instead of closing the record
        # (pinned in test_y7_self_adjudication). drop_with_reason keeps
        # this pin about what it always tested: independence + quorum.
        self._seed_opinion(request_ids[0], agent_id="judge-a", verdict=hra.RESOLVE_VERDICT,
                           disposition=hra.DISPOSITION_DROP)
        self._seed_opinion(request_ids[1], agent_id="judge-b", verdict=hra.RESOLVE_VERDICT,
                           disposition=hra.DISPOSITION_DROP)
        self._seed_opinion(request_ids[2], agent_id="judge-c", verdict=hra.REFUSE_VERDICT)
        verdict = hra.adjudicate_human_required(
            escalation_request_id=self.escalation_id, base_dir=self.tools,
        )
        self.assertEqual(verdict.outcome, hra.OUTCOME_RESOLVED)
        self.assertTrue(verdict.independence_ok)
        record = json.loads(
            (self.tools / "human-required" / f"{self.escalation_id}.json").read_text(
                encoding="utf-8",
            ),
        )
        self.assertEqual(record["status"], "resolved")
        self.assertEqual(record["resolved_by"], RESOLVED_BY_AGENT_PANEL)
        self.assertIn("independent agent panel", record["resolution_note"])
        # The DECISION, not just the fact one was taken: a refusal closes the
        # record with the same status/resolved_by pair, so those two fields
        # never distinguished "the panel said yes" from "the panel said no".
        self.assertEqual(record["panel_outcome"], hra.OUTCOME_RESOLVED)

    def test_refuse_quorum_does_not_resolve_the_record(self) -> None:
        request_ids = self._open()
        for request_id, agent in zip(request_ids, ("judge-a", "judge-b", "judge-c")):
            self._seed_opinion(request_id, agent_id=agent, verdict=hra.REFUSE_VERDICT)
        verdict = hra.adjudicate_human_required(
            escalation_request_id=self.escalation_id, base_dir=self.tools,
        )
        self.assertEqual(verdict.outcome, hra.OUTCOME_REFUSED)
        record = json.loads(
            (self.tools / "human-required" / f"{self.escalation_id}.json").read_text(
                encoding="utf-8",
            ),
        )
        self.assertEqual(record["status"], "open")

    # I-PANEL-12
    def test_i_panel_12_panel_cannot_write_ground_truth_verdict(self) -> None:
        """Agent judgment must never enter the human ground-truth ledger.

        `verdict` feeds record_operator_feedback with source_type="human",
        which judge calibration scores against — so a panel supplying it
        would have the judges grading themselves.
        """
        with self.assertRaises(GovernanceError) as ctx:
            resolve_human_required(
                request_id=self.escalation_id,
                resolution_note="panel tried to supply ground truth",
                verdict="true_positive",
                resolved_by=RESOLVED_BY_AGENT_PANEL,
                # An otherwise VALID panel resolution, so the ground-truth
                # clause is the only reason this can refuse.
                panel_outcome=hra.OUTCOME_RESOLVED,
                base_dir=self.tools,
            )
        self.assertIn("cannot_supply_ground_truth_verdict", str(ctx.exception))

    def test_unknown_resolved_by_is_refused(self) -> None:
        with self.assertRaises(GovernanceError):
            resolve_human_required(
                request_id=self.escalation_id,
                resolution_note="who resolved this?",
                resolved_by="some_other_actor",
                base_dir=self.tools,
            )


class AdjudicationPublicApiPin(unittest.TestCase):
    """The module's five siblings pin __all__ exactly; this one did not.

    An exact-set assertion is the only thing that makes an accidental export a
    build failure rather than a new public surface nobody chose. Without it a
    helper renamed from `_fold` to `fold` silently becomes API, and callers grow
    against it before anyone decides that was intended.
    """

    CANONICAL: frozenset[str] = frozenset({
        # policy constants
        "ADJUDICABLE_CONTEXT_KINDS",
        "ADJUDICATION_ROLE",
        "ADJUDICATOR_VERDICTS",
        "DEFAULT_PANEL_SIZE",
        "DEFAULT_QUORUM",
        "INSUFFICIENT_VERDICT",
        "IRREDUCIBLE_CONTEXT_KINDS",
        "IRREDUCIBLE_RISK_LANES",
        "OUTCOME_REFUSED",
        "OUTCOME_RESOLVED",
        "OUTCOME_STILL_ESCALATED",
        "REFUSE_VERDICT",
        "RESOLVE_VERDICT",
        # value types
        "AdjudicabilityVerdict",
        "AdjudicatorOpinion",
        "PanelVerdict",
        # behaviour
        "adjudicate_human_required",
        # Y7 (ORPHAN-708) — panel dispositions: the closed effect vocabulary
        # and the budgets that bound it.
        "DISPOSITION_DROP",
        "DISPOSITION_ESCALATE_OPERATOR",
        "DISPOSITION_RE_MINT",
        "MAX_REQUEST_REMINTS",
        "OPERATIONAL_DISPOSITION_KINDS",
        "PANEL_DISPOSITIONS",
        # JJ-3 (ORPHAN-HIGH-755) — the kinds whose quorum-refuse HANDS the
        # item to a human instead of closing it. Exported because it is a
        # policy line: widening it silently would let a refusal close work
        # that nobody did.
        "REFUSE_HANDS_TO_OPERATOR_KINDS",
        "escalation_adjudicability",
        "fold_adjudication",
        "open_adjudication",
        # ORPHAN-HIGH-450 — the production caller. Pinned here because the
        # panel having no caller is what made ORPHAN-HIGH-426's fix inert,
        # so dropping this export is a regression, not a cleanup.
        "sweep_human_required_adjudications",
    })

    def test_all_matches_the_canonical_set_exactly(self) -> None:
        from aria_kernel import human_required_adjudication as _hra

        actual = set(_hra.__all__)
        self.assertEqual(
            actual, set(self.CANONICAL),
            f"__all__ drifted; missing={set(self.CANONICAL) - actual} "
            f"extra={actual - set(self.CANONICAL)}",
        )

    def test_every_exported_name_resolves(self) -> None:
        """A name in __all__ that does not exist breaks `from … import *`."""
        from aria_kernel import human_required_adjudication as _hra

        for name in _hra.__all__:
            with self.subTest(name=name):
                self.assertTrue(hasattr(_hra, name), f"{name} is exported but absent")

    def test_irreducible_lanes_are_not_adjudicable_by_agents(self) -> None:
        """The one policy line that must not quietly widen.

        An agent panel may resolve an escalation; it may not grant itself the
        L3/blocked lanes, which are the lanes that carry real merge authority.
        Pinned here because widening this set is a one-word edit.
        """
        from aria_kernel import human_required_adjudication as _hra

        self.assertEqual(set(_hra.IRREDUCIBLE_RISK_LANES), {"L3", "blocked"})


if __name__ == "__main__":
    unittest.main()
