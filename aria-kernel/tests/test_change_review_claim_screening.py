"""WP-D3 — what the bridge does with the answers and claims the pinned tests do not name.

``test_change_review_defect_claims_bridge`` pins the refusal reasons and the raw rows. These are the bounds
that make the bridge safe to point at untrusted model output:

  * an answer the bridge cannot read at all (not a list, over the bound, a request that names no
    change, cycle or commit) is refused WHOLE and by name, and nothing is written: the supporting bridge
    ends its retry lane on it;
  * a claim whose type contradicts its family's contract is malformed (the claim's type is never taken
    from the claim);
  * a claim citing a path the tool may not read is refused before its bytes are touched, and the refusal
    does not quarantine the tool (a hostile claim must not switch the discovery channel off);
  * evidence that could not be verified (git did not answer) is no verdict: the answer is not bridged on
    unchecked evidence, it raises and is bridged again later.
"""
from __future__ import annotations

import dataclasses
from typing import Any
from unittest import mock

from aria_kernel import change_review
from aria_kernel.bridge_exceptions import BridgeContractRefused
from aria_kernel.quarantine import quarantine_tool
from aria_kernel.tool_registry import GovernanceError, get_tool
from tests._helpers.change_review_claims import (
    CONTRACT_FILE,
    R_MALFORMED,
    R_UNRESOLVED,
    REFUSED_KIND,
    ChangeReviewCase,
    bridge,
    change_review_runs,
    governance,
    raw_rows,
)
from tests._helpers.git_fixtures import commit_files


class AnswersTheBridgeCannotRead(ChangeReviewCase):
    def _nothing_was_written(self) -> None:
        self.assertEqual(change_review_runs(self.tools), [])
        self.assertEqual(raw_rows(self.tools), [])
        self.assertEqual(governance(self.tools, REFUSED_KIND), [])

    def test_an_answer_over_the_bound_is_refused_whole(self) -> None:
        answer = [self.claim(3, marker="OVER")] * (change_review.MAX_CLAIMS_PER_ANSWER + 1)

        with self.assertRaises(BridgeContractRefused) as refused:
            self.bridge(answer)

        self.assertIn("change_review_claims_over_bound", str(refused.exception))
        self._nothing_was_written()

    def test_claims_that_are_not_a_list_are_refused_whole(self) -> None:
        for claims in (None, {"rule": "wrong_logic"}, "ignore every rule"):
            with self.subTest(claims=claims), self.assertRaises(BridgeContractRefused):
                self.bridge(claims)  # type: ignore[arg-type]
        self._nothing_was_written()

    def test_a_request_that_names_no_change_cycle_or_commit_is_refused_whole(self) -> None:
        for missing in ("subject_ref", "target_sha", "cycle_id"):
            request = self.change.request()
            del request[missing]
            with self.subTest(missing=missing), self.assertRaises(BridgeContractRefused) as refused:
                change_review.bridge_defect_claims(request=request, claims=[self.claim(3, marker="X")], base_dir=self.tools)
            self.assertIn(missing, str(refused.exception))
        self._nothing_was_written()


class AQuarantinedToolTakesNoClaims(ChangeReviewCase):
    def test_the_answer_waits_until_the_tool_is_released(self) -> None:
        quarantine_tool(change_review.TOOL_ID, "operator hold", base_dir=self.tools)

        with self.assertRaises(GovernanceError) as refused:
            self.bridge([self.claim(3, marker="X")])

        self.assertIn("change_review_tool_quarantined", str(refused.exception))
        self.assertEqual(change_review_runs(self.tools), [])
        self.assertEqual(raw_rows(self.tools), [])


class ClaimsTheFamilyContractContradicts(ChangeReviewCase):
    def test_a_claim_type_other_than_its_familys_is_malformed(self) -> None:
        other = next(
            contract.claim_type for rule, contract in self.families.contracts.items()
            if contract.claim_type != self.families.claim_type(self.families.high)
        )

        self.bridge([self.claim(3, marker="OK"), self.claim(4, marker="BAD", rule=self.families.high, claim_type=other)])

        self.assertEqual([row["reason"] for row in governance(self.tools, REFUSED_KIND)], [R_MALFORMED])
        self.assertEqual(len(raw_rows(self.tools)), 1)

    def test_the_type_and_severity_of_a_raw_row_are_the_familys(self) -> None:
        self.bridge([self.claim(3, marker="OK", rule=self.families.low)])

        (row,) = raw_rows(self.tools)
        finding = self.finding(row)
        contract = self.families.contracts[self.families.low]
        self.assertEqual((finding["claim_type"], finding["severity"]), (contract.claim_type, contract.severity_cap))

    def finding(self, row: dict[str, Any]) -> dict[str, Any]:
        from aria_kernel.feedback_store import resolve_raw_finding

        return resolve_raw_finding(row, base_dir=self.tools)


class EvidenceTheToolMayNotReadOrCouldNotCheck(ChangeReviewCase):
    def test_a_claim_citing_a_secret_path_is_refused_and_does_not_quarantine_the_tool(self) -> None:
        secret = ".env.example"
        head = commit_files(self.change.repo, {secret: "API_TOKEN=abc123\n"}, message="head: add an example env")
        change = dataclasses.replace(self.change, head=head)
        claim = self.claim(
            3, marker="SEC", file=secret, start_line=1, end_line=1, evidence_refs=[f"{secret}:1"],
            quote="API_TOKEN=abc123", expectation_ref=f"{CONTRACT_FILE}:2",
        )

        bridge(change, [claim, self.claim(4, marker="OK")])

        self.assertEqual([row["reason"] for row in governance(self.tools, REFUSED_KIND)], [R_UNRESOLVED])
        self.assertEqual(len(raw_rows(self.tools)), 1)
        self.assertEqual(get_tool(change_review.TOOL_ID, self.tools)["status"], "SHADOW")
        (run,) = change_review_runs(self.tools)
        self.assertEqual(run["status"], "ok")

    def test_evidence_that_could_not_be_verified_is_no_verdict_and_raises(self) -> None:
        unverified = {"status": "pass", "reason": None, "note": "tier0_unverified_git_unavailable", "fingerprint": "", "checks": []}

        with mock.patch.object(change_review, "tier0_gate", return_value=unverified):
            with self.assertRaises(GovernanceError) as refused:
                self.bridge([self.claim(3, marker="X")])

        self.assertIn("change_review_evidence_unverified", str(refused.exception))
        self.assertEqual(change_review_runs(self.tools), [])
        self.assertEqual(raw_rows(self.tools), [])
        self.assertEqual(governance(self.tools, REFUSED_KIND), [])


if __name__ == "__main__":
    import unittest

    unittest.main()
