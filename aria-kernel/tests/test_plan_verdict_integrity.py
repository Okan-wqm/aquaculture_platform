"""PV — plan verdict integrity (P1 verified risk closure, P3 verdict bound to
the reviewed commit, P5 reviewer dissent gate).

Source: /root/aria-handover/2026-10-21/build/PV/SPEC.md, SEPT-HARVEST.md §0
and adoption rows P1/P3/P5; findings ARIA-HIGH-779 (P1) and ARIA-LOW-785.

The defect these tests pin (SEPT-HARVEST §0): the plan AUTHOR closes the
reviewer's objections itself. ``revision_recorded`` unions the author's
``addresses_review_risk_ids`` unchecked into one plan-wide
``resolved_review_risk_ids``; ``_evaluate_cross_review_state`` drops every
current-round risk whose id is in that set; risk ids restart at ``CR-001``
every round, so an old claim also hides a NEW objection that reuses the id.
On origin/aria/state @ 8e39b2eeb all 18 of 18 CONVERGED evaluations had a
round-N material risk hidden this way.

What the kernel must do instead, one property per test:

* P1 (a) a cross-review risk id is round-scoped at ``cross_review_recorded``
  (``CR-R{N}-<id>``, the law ``COV-R{N}`` / ``IMP-R{N}`` already follow);
* P1 (b) the author's ``addresses_review_risk_ids`` is a stored CLAIM, never a
  resolution;
* P1 (c) the round N+1 reviewer is handed the prior risks and the author's
  claims inside ``<untrusted_prior_risks>`` and answers with
  ``prior_risk_dispositions[]`` (resolved / open / withdrawn + evidence_refs);
  only the reviewer's ``resolved`` clears a prior risk; the prompt stops
  asking for the legacy ``reviews`` list the contract rejects;
* P3 ``evaluate_plan`` records ``reviewed_commit_sha`` and
  ``request_implementation`` refuses ``plan_verdict_stale:<path>`` when a
  later commit touches the plan's surfaces or its plan/risk evidence files;
* P5 a dissenting reviewer verdict with no material risk is the named
  ``reviewer_dissent`` inconsistency, never a silent convergence.

New API these tests pin (the spec introduces it; the names below are the
spec's own words): the cross-review submission field
``prior_risk_dispositions`` (rows ``{risk_id, disposition, evidence_refs}``,
``disposition`` in resolved/open/withdrawn), the ``plan_evaluated`` payload
field ``reviewed_commit_sha``, the refusal ``plan_verdict_stale:<path>``, the
gate name ``reviewer_dissent``. The workspace a store belongs to is the one
``tool_registry.bound_workspace_root`` names: every fixture here binds its
tools store to a real git checkout and keeps it at ``<checkout>/aria-tools``
(gitignored), the production layout, so no new parameter is assumed on
``evaluate_plan`` / ``request_implementation``.
"""
from __future__ import annotations

import base64
import json
import re
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from aria_kernel.plan_convergence import (
    content_hash,
    evaluate_plan,
    fold_plan_state,
    record_revision,
    request_implementation,
    start_plan,
    submit_challenger_plan,
    submit_cross_review_v8,
)
from aria_kernel.tool_registry import GovernanceError, ensure_tools_binding

SURFACE = "apps/farm-service/src/feed/feed.service.ts"
PLAN_EVIDENCE = "docs/aria/SPEC.md"
RISK_EVIDENCE_FILE = "apps/farm-service/src/feed/feed.repository.ts"
UNRELATED = "apps/hr-service/src/leave/leave.service.ts"
MATERIAL = {"blocking", "material", "critical", "high"}


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=repo, check=True, capture_output=True, text=True,
    ).stdout.strip()


def _risk(risk_id: str, severity: str, *, summary: str | None = None,
          evidence_refs: list[str] | None = None) -> dict:
    return {
        "risk_id": risk_id,
        "risk_category": "architecture",
        "severity": severity,
        "summary": summary or f"{risk_id} {severity} summary",
        "recommendation": f"{risk_id} recommendation",
        "affected_files": [SURFACE],
        "evidence_refs": evidence_refs or [f"{SURFACE}:1"],
    }


def _disposition(risk_id: str, disposition: str, evidence_refs: list[str] | None = None) -> dict:
    row = {"risk_id": risk_id, "disposition": disposition}
    if evidence_refs is not None:
        row["evidence_refs"] = evidence_refs
    return row


def _terminal(result: dict) -> str:
    """The round's outcome: NEXT_ROUND_REQUIRED (no event) or the recorded terminal state."""
    if result.get("status") == "next_round_required":
        return "NEXT_ROUND_REQUIRED"
    return result["event"]["payload"]["terminal_state"]


class _PlanFixture(unittest.TestCase):
    """A real checkout with the tools store bound to it at ``<checkout>/aria-tools``."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name) / "checkout"
        self.repo.mkdir()
        _git(self.repo, "init", "-q", "-b", "main")
        _git(self.repo, "config", "user.email", "fixture@example.invalid")
        _git(self.repo, "config", "user.name", "fixture")
        _git(self.repo, "config", "commit.gpgsign", "false")
        agents = self.repo / ".claude" / "agents"
        agents.mkdir(parents=True)
        (agents / "aria-cross-reviewer.md").write_text(
            "---\nname: aria-cross-reviewer\ndescription: CR.\n---\n\nBody.\n", encoding="utf-8",
        )
        files = {
            ".gitignore": "aria-tools/\n",
            SURFACE: "export const feed = 1;\n",
            PLAN_EVIDENCE: "# spec\n",
            RISK_EVIDENCE_FILE: "export const repo = 1;\n",
            UNRELATED: "export const leave = 1;\n",
        }
        for rel, text in files.items():
            path = self.repo / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8")
        _git(self.repo, "add", "-A")
        _git(self.repo, "commit", "-q", "-m", "fixture: commit A")
        self.commit_a = _git(self.repo, "rev-parse", "HEAD")
        self.tools = ensure_tools_binding(self.repo / "aria-tools", workspace_root=self.repo)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    # -- plan driving -------------------------------------------------

    def plan(self, **overrides) -> dict:
        body = {
            "schema_version": 1,
            "title": "Feed service plan",
            "summary": "Tighten the feed service.",
            "affected_surfaces": [{"paths": [SURFACE]}],
            "key_changes": ["tighten feed service"],
            "validation_commands": [{"cmd": "nx affected --target=test"}],
            "evidence_refs": [PLAN_EVIDENCE],
            "architectural_tier": 2,
        }
        body.update(overrides)
        return body

    def start(self, plan_id: str = "plan-1") -> None:
        start_plan(plan_id=plan_id, initial_revision_id="rev-0", plan_content=self.plan(), base_dir=self.tools)

    def challenger(self, revision_id: str, plan_id: str = "plan-1") -> None:
        state = fold_plan_state(plan_id=plan_id, base_dir=self.tools)
        submit_challenger_plan(
            plan_id=plan_id,
            challenger={
                "challenger_agent": "aria-challenger-planner",
                "challenger_revision_id": revision_id,
                "source_revision_id": state["latest_revision"]["revision_id"],
                "source_plan_content_hash": state["latest_revision"]["content_hash"],
                "plan_content": self.plan(title=f"Challenger {revision_id}"),
            },
            base_dir=self.tools,
        )

    def cross_review(self, risks: list[dict], *, verdict: str, plan_id: str = "plan-1",
                     verdicts: dict | None = None, dispositions: list[dict] | None = None,
                     reviewed_at: str | None = None) -> dict:
        """One V8 cross-review, reviewed at ``reviewed_at`` (default: the checkout's HEAD now,
        the request's ``target_sha`` the drainer would have minted)."""
        review: dict = {"reviewer_agent": "aria-cross-reviewer", "verdict": verdict, "risks": risks}
        if verdicts is not None:
            review["verdicts"] = verdicts
        if dispositions is not None:
            review["prior_risk_dispositions"] = dispositions
        return submit_cross_review_v8(
            plan_id=plan_id, review=review, workspace_root=self.repo, base_dir=self.tools,
            reviewed_commit_sha=reviewed_at or _git(self.repo, "rev-parse", "HEAD"),
        )

    def revise(self, revision_id: str, *, addresses: list[str], plan_id: str = "plan-1") -> None:
        state = fold_plan_state(plan_id=plan_id, base_dir=self.tools)
        body = self.plan(summary=f"revised as {revision_id}")
        record_revision(
            plan_id=plan_id,
            revision={
                "revision_id": revision_id,
                "round": state["current_round"],
                "content_hash": content_hash(body),
                "parent_revision_hash": state["latest_revision"]["content_hash"],
                "content": json.dumps(body, sort_keys=True),
                "addresses_review_risk_ids": addresses,
            },
            base_dir=self.tools,
        )

    def evaluate(self, round_number: int, plan_id: str = "plan-1") -> dict:
        # ARIA-HIGH-375's independence gate is answered: these fixtures carry
        # no dispatch trail, and the subject here is the risk/verdict law.
        with mock.patch("aria_kernel.round_independence.verify_independence", return_value=(True, [])):
            return evaluate_plan(plan_id=plan_id, round_number=round_number, base_dir=self.tools)

    def round_one_blocking_then_claimed(self, *, plan_id: str = "plan-1") -> None:
        """Round 1 raises blocking CR-001; the author's revision claims it."""
        self.start(plan_id)
        self.challenger("challenger-rev-0", plan_id)
        self.cross_review([_risk("CR-001", "blocking")], verdict="material_risks_present", plan_id=plan_id)
        self.assertEqual(_terminal(self.evaluate(1, plan_id)), "NEXT_ROUND_REQUIRED")
        self.revise("rev-1", addresses=["CR-R1-CR-001"], plan_id=plan_id)
        self.challenger("challenger-rev-1", plan_id)

    def commit(self, rel: str, text: str) -> str:
        (self.repo / rel).write_text(text, encoding="utf-8")
        _git(self.repo, "add", rel)
        _git(self.repo, "commit", "-q", "-m", f"fixture: touch {rel}")
        return _git(self.repo, "rev-parse", "HEAD")

    def converged_at_a(self, risks: list[dict] | None = None) -> dict:
        self.start()
        self.challenger("challenger-rev-0")
        self.cross_review(risks or [], verdict="agreed")
        result = self.evaluate(1)
        self.assertEqual(_terminal(result), "CONVERGED")
        return result

    def request_implementation_of_plan(self) -> dict:
        state = fold_plan_state(plan_id="plan-1", base_dir=self.tools)
        return request_implementation(
            plan_id="plan-1",
            implementer_agent="aria-implementer",
            converged_plan_revision_id=state["latest_revision"]["revision_id"],
            converged_plan_content_hash=state["latest_revision"]["content_hash"],
            base_dir=self.tools,
        )


class P1RoundScopedRiskIds(_PlanFixture):
    def test_a_recorded_cross_review_risk_id_is_round_scoped(self) -> None:
        self.round_one_blocking_then_claimed()
        self.cross_review(
            [_risk("CR-001", "material", summary="a new round-two objection")],
            verdict="material_risks_present",
            dispositions=[_disposition("CR-R1-CR-001", "resolved", [f"{SURFACE}:1"])],
        )
        state = fold_plan_state(plan_id="plan-1", base_dir=self.tools)
        by_round = state["cross_review_risks_by_round"]
        self.assertEqual([risk["risk_id"] for risk in by_round[1]], ["CR-R1-CR-001"])
        self.assertEqual([risk["risk_id"] for risk in by_round[2]], ["CR-R2-CR-001"])


class P1AuthorClaimIsNotAResolution(_PlanFixture):
    def test_the_authors_claim_never_enters_the_resolved_set(self) -> None:
        self.round_one_blocking_then_claimed()
        state = fold_plan_state(plan_id="plan-1", base_dir=self.tools)
        self.assertNotIn("CR-R1-CR-001", state.get("resolved_review_risk_ids", []))
        self.assertNotIn("CR-001", state.get("resolved_review_risk_ids", []))

    def test_a_prior_material_risk_the_reviewer_holds_open_blocks_convergence(self) -> None:
        # Round 2 raises nothing new; the independent reviewer says the
        # author's claimed fix did NOT land. Today the claim alone cleared it
        # and the round converged.
        self.round_one_blocking_then_claimed()
        self.cross_review(
            [], verdict="agreed",
            dispositions=[_disposition("CR-R1-CR-001", "open", [f"{SURFACE}:1"])],
        )
        self.assertNotEqual(_terminal(self.evaluate(2)), "CONVERGED")

    def test_a_prior_risk_the_reviewer_resolves_with_evidence_clears(self) -> None:
        # Control: the one door that clears a prior risk still opens.
        self.round_one_blocking_then_claimed()
        self.cross_review(
            [], verdict="agreed",
            dispositions=[_disposition("CR-R1-CR-001", "resolved", [f"{SURFACE}:1"])],
        )
        self.assertEqual(_terminal(self.evaluate(2)), "CONVERGED")

    def test_a_disposition_outside_the_vocabulary_is_refused(self) -> None:
        self.round_one_blocking_then_claimed()
        with self.assertRaisesRegex(GovernanceError, "prior_risk_disposition"):
            self.cross_review(
                [], verdict="agreed",
                dispositions=[_disposition("CR-R1-CR-001", "fixed", [f"{SURFACE}:1"])],
            )

    def test_a_resolved_disposition_without_evidence_is_refused(self) -> None:
        self.round_one_blocking_then_claimed()
        with self.assertRaisesRegex(GovernanceError, "prior_risk_disposition"):
            self.cross_review(
                [], verdict="agreed",
                dispositions=[_disposition("CR-R1-CR-001", "resolved", [])],
            )


class P1NextReviewerSeesPriorRisksAndClaims(_PlanFixture):
    def _round_two_prompt(self, plan_id: str, *, claims: list[str]) -> str:
        from aria_kernel.cross_review_bridge import issue_cross_review_envelope
        from aria_kernel.request_admission import admit_request

        self.start(plan_id)
        self.challenger("challenger-rev-0", plan_id)
        self.cross_review(
            [_risk("CR-001", "blocking", summary="feed writes bypass the scoped repository"),
             _risk("CR-002", "material", summary="no red test pins the feed write")],
            verdict="material_risks_present", plan_id=plan_id,
        )
        self.evaluate(1, plan_id)
        self.revise("rev-1", addresses=claims, plan_id=plan_id)
        self.challenger("challenger-rev-1", plan_id)
        row = issue_cross_review_envelope(
            plan_id=plan_id, round_number=2,
            primary_revision_id="rev-1", primary_plan_text="{}",
            challenger_revision_id="challenger-rev-1", challenger_plan_text="{}",
            must_satisfy=[{"id": "MS-1", "description": "one falsifiable obligation"}],
            evidence_refs=[PLAN_EVIDENCE], allowed_scope=["**"], base_dir=self.tools,
            admission=admit_request("convergence_drainer.plan_step", "cross_review", base_dir=self.tools),
        )
        return row["suggested_prompt"]

    @staticmethod
    def _prior_block(prompt: str) -> str:
        """The block's decoded body (PV R18: base64 through the text_safety owner)."""
        match = re.search(
            r'<untrusted_prior_risks before_round="\d+" encoding="base64">\n([A-Za-z0-9+/=]*)\n</untrusted_prior_risks>',
            prompt,
        )
        if match is None:
            raise AssertionError("the round-2 cross-review prompt carries no <untrusted_prior_risks> block")
        return base64.b64decode(match.group(1)).decode("utf-8")

    def test_the_round_two_reviewer_is_handed_the_prior_risks_as_untrusted_data(self) -> None:
        prompt = self._round_two_prompt("plan-1", claims=["CR-R1-CR-001"])
        block = self._prior_block(prompt)
        for text in ("CR-R1-CR-001", "CR-R1-CR-002",
                     "feed writes bypass the scoped repository", "no red test pins the feed write"):
            self.assertIn(text, block)
        contract = prompt[prompt.index("SECURITY CONTRACT"):prompt.index("<untrusted_primary_plan revision_id")]
        self.assertIn("untrusted_prior_risks", contract)

    def test_the_authors_claims_ride_in_the_prior_risks_block(self) -> None:
        claimed = self._prior_block(self._round_two_prompt("plan-1", claims=["CR-R1-CR-001"]))
        unclaimed = self._prior_block(self._round_two_prompt("plan-2", claims=[]))
        self.assertNotEqual(
            claimed.replace("plan-1", "plan-X"), unclaimed.replace("plan-2", "plan-X"),
            "the author's claim is invisible to the reviewer who must verify it",
        )

    def test_the_prompt_asks_for_dispositions_not_the_legacy_reviews_list(self) -> None:
        prompt = self._round_two_prompt("plan-1", claims=["CR-R1-CR-001"])
        self.assertIn("prior_risk_dispositions", prompt)
        self.assertNotIn("`reviews` list", prompt)


class P1ReviewerContractNamesDispositions(unittest.TestCase):
    def test_the_cross_reviewer_contract_requires_prior_risk_dispositions(self) -> None:
        contract = (Path(__file__).resolve().parents[2] / ".claude" / "agents" / "aria-cross-reviewer.md").read_text(
            encoding="utf-8",
        )
        for required in ("prior_risk_dispositions", "<untrusted_prior_risks>", '"resolved"', '"open"', '"withdrawn"'):
            self.assertTrue(required in contract, f"aria-cross-reviewer.md does not state {required}")


class P3VerdictBoundToReviewedCommit(_PlanFixture):
    def test_evaluate_plan_records_the_reviewed_commit(self) -> None:
        result = self.converged_at_a()
        self.assertEqual(result["event"]["payload"].get("reviewed_commit_sha"), self.commit_a)

    def test_a_later_commit_to_a_covered_surface_makes_the_verdict_stale(self) -> None:
        self.converged_at_a()
        self.commit(SURFACE, "export const feed = 2;\n")
        with self.assertRaisesRegex(GovernanceError, f"plan_verdict_stale:{SURFACE}"):
            self.request_implementation_of_plan()
        self.assertEqual(fold_plan_state(plan_id="plan-1", base_dir=self.tools)["state"], "CONVERGED")

    def test_a_later_commit_to_a_plan_evidence_file_makes_the_verdict_stale(self) -> None:
        self.converged_at_a()
        self.commit(PLAN_EVIDENCE, "# spec, changed after the review\n")
        with self.assertRaisesRegex(GovernanceError, f"plan_verdict_stale:{PLAN_EVIDENCE}"):
            self.request_implementation_of_plan()

    def test_a_later_commit_to_a_risk_evidence_file_makes_the_verdict_stale(self) -> None:
        self.converged_at_a([_risk("CR-001", "nice_to_have", evidence_refs=[f"{RISK_EVIDENCE_FILE}:42"])])
        self.commit(RISK_EVIDENCE_FILE, "export const repo = 2;\n")
        with self.assertRaisesRegex(GovernanceError, f"plan_verdict_stale:{RISK_EVIDENCE_FILE}"):
            self.request_implementation_of_plan()

    def test_a_later_commit_elsewhere_keeps_the_verdict_fresh(self) -> None:
        # Control: staleness is about the reviewed bytes, not any new commit.
        self.converged_at_a()
        self.commit(UNRELATED, "export const leave = 2;\n")
        self.assertTrue(self.request_implementation_of_plan()["event_appended"])
        self.assertEqual(fold_plan_state(plan_id="plan-1", base_dir=self.tools)["state"], "IMPLEMENTATION_REQUESTED")



class Low785ImplementationRequestIdentity(_PlanFixture):
    """ARIA-LOW-785 (with P3) — an implementation request's identity must cover
    every fact it carries: a re-mint with new staged ids (a new branch, a new
    proposal) is a new request, never the old row handed back."""

    def _mint(self, ids: dict) -> dict:
        from aria_kernel.agent_invocations import create_agent_invocation_request
        from aria_kernel.implementation_safety import readonly_paths
        from aria_kernel.plan_origin import commit_contract_for_plan
        from aria_kernel.request_admission import admit_request

        state = fold_plan_state(plan_id="plan-1", base_dir=self.tools)
        cycle_id = "cyc-20261023T000000Z-auto"
        return create_agent_invocation_request(
            target_agent="aria-implementer", role="implementation", suggested_prompt="Implement the converged plan.",
            must_satisfy=[{"id": "MS-1", "description": "one falsifiable obligation"}],
            allowed_scope=[SURFACE], evidence_refs=[PLAN_EVIDENCE], convergence_id="plan-1", round_number=0,
            base_dir=self.tools, plan_revision_hash=state["latest_revision"]["content_hash"],
            implementation_ids=ids, cycle_id=cycle_id, forbidden_scope=list(readonly_paths()),
            commit_contract=commit_contract_for_plan(self.plan(), plan_id="plan-1"), target_sha=self.commit_a,
            admission=admit_request("implementer.converged_plan", "implementation", base_dir=self.tools, cycle_id=cycle_id),
        )

    def test_a_remint_with_new_staged_ids_is_a_new_request(self) -> None:
        self.converged_at_a()
        first = self._mint({"proposal_id": "p-1", "change_id": "c-1", "branch": "aria/one", "base_sha": self.commit_a})
        second = self._mint({"proposal_id": "p-2", "change_id": "c-2", "branch": "aria/two", "base_sha": self.commit_a})
        self.assertNotEqual(second["request_id"], first["request_id"])
        self.assertEqual(second["implementation_ids"]["branch"], "aria/two")

class P5ReviewerDissentGate(_PlanFixture):
    def _dissent_gate(self, result: dict) -> dict | None:
        gates = result.get("gate_decisions") or result.get("event", {}).get("payload", {}).get("gate_decisions") or []
        return next((gate for gate in gates if gate.get("gate") == "reviewer_dissent"), None)

    def _reason_codes(self, result: dict) -> list[str]:
        return list(result.get("reason_codes") or result.get("event", {}).get("payload", {}).get("reason_codes") or [])

    def _assert_named_dissent(self, result: dict) -> None:
        self.assertNotEqual(_terminal(result), "CONVERGED")
        gate = self._dissent_gate(result)
        self.assertIsNotNone(gate, "no reviewer_dissent gate decision was recorded")
        self.assertFalse(gate["passed"])
        self.assertTrue(any(code.startswith("reviewer_dissent") for code in self._reason_codes(result)))

    def test_a_dissenting_verdict_with_only_nice_to_have_risks_does_not_converge(self) -> None:
        self.start()
        self.challenger("challenger-rev-0")
        self.cross_review([_risk("CR-001", "nice_to_have")], verdict="material_risks_present")
        self._assert_named_dissent(self.evaluate(1))

    def test_a_dissenting_verdict_on_one_direction_does_not_converge(self) -> None:
        self.start()
        self.challenger("challenger-rev-0")
        self.cross_review(
            [_risk("CR-001", "nice_to_have")], verdict="agreed",
            verdicts={"primary_to_challenger": "agreed", "challenger_to_primary": "partial_coverage"},
        )
        self._assert_named_dissent(self.evaluate(1))

    def test_an_agreeing_verdict_with_only_nice_to_have_risks_converges(self) -> None:
        # Control: the gate names an inconsistency, it does not ban minor risks.
        self.start()
        self.challenger("challenger-rev-0")
        self.cross_review([_risk("CR-001", "nice_to_have")], verdict="agreed")
        result = self.evaluate(1)
        self.assertEqual(_terminal(result), "CONVERGED")
        gate = self._dissent_gate(result)
        self.assertTrue(gate is None or gate["passed"])


if __name__ == "__main__":
    unittest.main()
