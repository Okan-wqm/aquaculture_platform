"""ARIA-MEDIUM-422 — an expiry that followed only harness releases spends no re-mint budget.

Measured on the bound runner store (aria/state f5c5c86a1, 2026-10-10): 46 of
the 1,202 ANCHOR_STALE requests had been claimed and handed back only for the
harness's reasons (``native_runtime_execution_unavailable``,
``claude_cli_exit_1``, ...) before their window ran out. Their terminal row
says ``anchor_expired``, which the release-reason table leaves
``unclassified``, so each one spent its lineage's single re-mint
(``ANCHOR_STALE_REMINT_BUDGET``) on the host's failure. Five consensus
arbiters with four contract violations each are the counter-case: past the
free allowance a violation is the request's own, and they keep spending.

Pins, against the production writers (the executor's claim and release, the
age sweep that writes the expiry, the lease sweep that disposes):

* a judge whose dead ancestor was released only for harness reasons is
  re-minted again when its successor expires (before the fix the successor
  went to the operator as ``remint_budget_spent``);
* the age sweep writes the one spelling the cause reads (``ANCHOR_EXPIRED``);
* an ancestor released once for the request's own reason still spends;
* contract violations past ``FREE_CONTRACT_VIOLATIONS`` still spend;
* an ancestor nobody ever claimed still spends: the queue never reached it.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from aria_kernel.agent_invocations import (
    FREE_CONTRACT_VIOLATIONS,
    _claims_path,
    claim_request,
    release_claim,
    sweep_expired_anchors,
)
from aria_kernel.anchor_expiry_cause import ANCHOR_EXPIRED, HARNESS_FAULT_CLASS
from aria_kernel.anchor_stale_effects import DISPOSITION_OPERATOR, DISPOSITION_REMINTED
from aria_kernel.ledger import load_declared_jsonl

from tests._helpers.anchor_stale_store import EVIDENCE_JUDGE, AnchorStaleStore

# Past any anchor window the genesis policy declares (the code default is
# three days, the operator's policy seven), so the age sweep expires by age.
PAST_THE_WINDOW = timedelta(days=8)
EXECUTOR = "ci-executor:gha-422"


class ExpiryAfterReleases(AnchorStaleStore):
    def release(self, request_id: str, reasons: tuple[str, ...]) -> None:
        """The executor's claim and release, once per reason."""
        for reason in reasons:
            claim = claim_request(request_id=request_id, agent_id=EXECUTOR, base_dir=self.tools)
            release_claim(claim_id=claim["claim_id"], agent_id=EXECUTOR, lease_token=claim["lease_token"],
                          reason=reason, base_dir=self.tools)

    def expire_by_age(self) -> None:
        sweep_expired_anchors(base_dir=self.tools, now=datetime.now(timezone.utc) + PAST_THE_WINDOW)

    def successor_expires(self, reasons: tuple[str, ...]) -> tuple[str, str]:
        """A judge released for ``reasons`` expires and is re-minted; its successor expires unclaimed."""
        dead = self.mint_judges(1)[EVIDENCE_JUDGE]
        self.release(dead, reasons)
        self.expire_by_age()
        self.sweep()
        successors = self.successors(dead)
        self.assertEqual(len(successors), 1, "the first expiry of a live judge is re-minted whatever its cause")
        successor = successors[0]["request_id"]
        self.expire_by_age()
        self.sweep()
        return dead, successor

    def outcome(self, request_id: str) -> tuple[str, str]:
        disposition = self.disposition(request_id)
        return disposition["disposition"], disposition["reason"]

    def test_an_expiry_after_only_harness_releases_spends_no_budget(self) -> None:
        dead, successor = self.successor_expires(("native_runtime_execution_unavailable", "claude_cli_exit_1"))

        self.assertEqual(self.outcome(successor), (DISPOSITION_REMINTED, "subject_live"))
        self.assertEqual(len(self.successors(successor)), 1)
        expiry = self.disposition(dead)
        self.assertEqual((expiry["expiry_reason"], expiry["expiry_fault_class"]), (ANCHOR_EXPIRED, HARNESS_FAULT_CLASS))

    def test_the_age_sweep_writes_the_spelling_the_cause_reads(self) -> None:
        dead = self.mint_judges(1)[EVIDENCE_JUDGE]
        self.expire_by_age()
        rows = load_declared_jsonl(_claims_path(self.tools), expected_surface="agent_invocation_claims")
        self.assertEqual([row["reason"] for row in rows if row.get("request_id") == dead
                          and row.get("event") == "anchor_stale"], [ANCHOR_EXPIRED])

    def test_a_release_for_the_requests_own_reason_spends(self) -> None:
        dead, successor = self.successor_expires(("native_runtime_execution_unavailable", "submit_rejected"))

        self.assertEqual(self.disposition(dead)["expiry_fault_class"], "unclassified")
        self.assertEqual(self.outcome(successor), (DISPOSITION_OPERATOR, "remint_budget_spent"))
        self.assertEqual(self.successors(successor), [])

    def test_contract_violations_past_the_free_allowance_spend(self) -> None:
        # The measured shape of the five consensus arbiters: harness releases,
        # then more contract violations than the free allowance.
        violations = ("judge_verdict_contract_violation",) * (FREE_CONTRACT_VIOLATIONS + 1)
        dead, successor = self.successor_expires(("native_runtime_execution_unavailable", *violations))

        self.assertEqual(self.disposition(dead)["expiry_fault_class"], "unclassified")
        self.assertEqual(self.outcome(successor), (DISPOSITION_OPERATOR, "remint_budget_spent"))

    def test_an_ancestor_nobody_claimed_spends(self) -> None:
        dead, successor = self.successor_expires(())

        self.assertEqual(self.disposition(dead)["expiry_fault_class"], "unclassified")
        self.assertEqual(self.outcome(successor), (DISPOSITION_OPERATOR, "remint_budget_spent"))
