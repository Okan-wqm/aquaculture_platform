"""A submission the kernel could not verify is released as the harness's fault.

`classify_evidence_ref` now grades a git probe that did not answer
`verification_unavailable`, and the validator names it
`agent_evidence_verification_unavailable`. That is honest inside the kernel;
it is still dishonest at the acceptance seam unless the EXECUTOR stops
charging the request for it. Until this change every non-zero submit exit
released the claim as `submit_rejected` — a request-fault reason that burns
the requeue budget — so a loaded host could walk a blameless request into
HUMAN_REQUIRED one slow `git show` at a time.

Pinned here, end to end:

* the kernel's rejection carries `rejection_codes`, one machine code per
  prose reason, on the response and on the persisted row;
* `evidence_verification_unavailable` is a registered HARNESS release
  reason (fault-ownership table, closed envelope, classifier);
* the executor reads the codes — never the prose — and releases under the
  harness reason only when EVERY code is a verification-unavailable code,
  under `submit_rejected` otherwise (a mixed rejection, an unparseable
  verdict, a kernel exception).
"""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from unittest import mock
from unittest.mock import MagicMock

_REPO_ROOT = Path(__file__).resolve().parents[2]
_POC_DIR = _REPO_ROOT / "tools" / "aria-poc"
_TESTS = Path(__file__).resolve().parent
for _path in (str(_POC_DIR), str(_TESTS)):
    if _path not in sys.path:
        sys.path.insert(0, _path)

import ci_executor  # noqa: E402
from aria_kernel import evidence_trust  # noqa: E402
from aria_kernel.agent_invocations import (  # noqa: E402
    HARNESS_FAULT_RELEASE_REASONS,
    REQUEST_FAULT_RELEASE_REASONS,
    _is_harness_fault_reason,
    classify_release_reason,
    submit_claim_result,
)
from aria_kernel.evidence_validator import EVIDENCE_VERIFICATION_UNAVAILABLE_CODES  # noqa: E402
from aria_kernel.release_reason import RELEASE_REASON_CODES, parse_release_reason  # noqa: E402
from aria_kernel.agent_invocations import derive_request_state, release_claim  # noqa: E402
from aria_kernel.ledger import load_declared_jsonl  # noqa: E402

# The submit fixture (a seeded repo, a strict request, a good envelope) and
# the live-path executor fixture (a claim envelope, a mock CLI, the subprocess
# sequencer) are COMPOSED, not subclassed, and reached through their modules
# rather than bound here: a TestCase class bound in this namespace is
# collected AGAIN under this module's name and its whole suite re-runs. This
# module only needs their setUp/helpers — one description of a submit and of
# an executor run.
import test_agent_submit_result_e2e as _submit_e2e  # noqa: E402
import test_ci_executor_live_path_smoke as _live_path  # noqa: E402


def _rejected_stdout(codes: list[str]) -> str:
    return json.dumps({
        "status": "rejected",
        "reasons": [f"evidence: {{'code': '{code}', 'ref': 'src.txt:1'}}" for code in codes],
        "rejection_codes": codes,
        "row": {"row_id": "result:claim_live_1:rejected"},
    }, indent=2, sort_keys=True)


class TheReasonIsRegistered(unittest.TestCase):
    def test_it_is_a_harness_fault_in_every_table(self) -> None:
        self.assertIn("evidence_verification_unavailable", HARNESS_FAULT_RELEASE_REASONS)
        self.assertNotIn("evidence_verification_unavailable", REQUEST_FAULT_RELEASE_REASONS)
        self.assertEqual(classify_release_reason("evidence_verification_unavailable"), "harness")
        self.assertTrue(_is_harness_fault_reason("evidence_verification_unavailable"))
        parsed = parse_release_reason("evidence_verification_unavailable")
        self.assertEqual(parsed.reason_code, "EVIDENCE_VERIFICATION_UNAVAILABLE")
        self.assertIn(parsed.reason_code, RELEASE_REASON_CODES)
        self.assertEqual(parsed.fault_domain, "harness")

    def test_submit_rejected_stays_the_requests_fault(self) -> None:
        self.assertEqual(classify_release_reason("submit_rejected"), "request")


class TheKernelCarriesTheCodes(unittest.TestCase):
    """Uses the submit fixture; only the git probe's answer differs."""

    def setUp(self) -> None:
        self.e2e = _submit_e2e.SubmitResultE2ETests()
        self.e2e.setUp()
        self.repo = self.e2e.repo

    def tearDown(self) -> None:
        self.e2e.tearDown()

    def _claim(self, *, nonce: str):
        return self.e2e._claim(nonce=nonce)

    def _result_rows(self, claim_id: str) -> list[dict]:
        return self.e2e._result_rows(claim_id)

    def _submit(self, request, claim):
        out = self.e2e._good_envelope(request=request, claim=claim)
        transcript = self.e2e._transcript_artifact(request, claim)
        return submit_claim_result(
            claim_id=claim["claim_id"],
            agent_id="judge-worker-001",
            lease_token=claim["lease_token"],
            output_path=out,
            workspace_root=self.e2e.repo,
            base_dir=self.e2e.tools,
            **self.e2e._binding_kwargs(request, transcript),
        )

    def test_a_probe_that_could_not_run_rejects_with_only_unavailable_codes(self) -> None:
        request, claim = self._claim(nonce="-unavailable")
        with mock.patch.object(evidence_trust, "_git_blob_matches", return_value=None):
            result = self._submit(request, claim)

        self.assertEqual(result["status"], "rejected")
        self.assertEqual(len(result["rejection_codes"]), len(result["reasons"]))
        self.assertTrue(result["rejection_codes"])
        self.assertEqual(
            set(result["rejection_codes"]), {"agent_evidence_verification_unavailable"},
        )
        self.assertTrue(set(result["rejection_codes"]) <= EVIDENCE_VERIFICATION_UNAVAILABLE_CODES)
        # A verdict nobody reached is not a verdict: no result row is
        # appended, the claim stays live, and the executor's harness-class
        # release can put the request back (a rejected RESULT row would have
        # made the claim terminal and the release refuse with `result already
        # terminal`, ARIA-HIGH-078 — the request dying for the host's load).
        self.assertTrue(result["undecided"])
        self.assertIsNone(result["row"])
        self.assertEqual(self._result_rows(claim["claim_id"]), [])
        self.assertEqual(
            derive_request_state(request_id=request["request_id"], base_dir=self.e2e.tools), "CLAIMED",
        )
        released = release_claim(
            claim_id=claim["claim_id"], agent_id="judge-worker-001", lease_token=claim["lease_token"],
            reason="evidence_verification_unavailable", base_dir=self.e2e.tools,
        )
        self.assertEqual(released["event"], "released", released)
        # Back in the queue under a harness-class reason: requeued, and the
        # request-fault requeue budget untouched.
        self.assertEqual(
            derive_request_state(request_id=request["request_id"], base_dir=self.e2e.tools), "REQUEUED",
        )
        governance = load_declared_jsonl(self.e2e.tools / "governance.jsonl", expected_surface="tools_governance")
        undecided_rows = [row for row in governance if row["kind"] == "agent_result_verification_undecided"]
        self.assertEqual(len(undecided_rows), 1)
        self.assertEqual(undecided_rows[0]["details"]["rejection_codes"], result["rejection_codes"])

    def test_a_decided_rejection_still_appends_its_terminal_row(self) -> None:
        # The other branch of the same seam: a probe that RAN and disagreed is
        # the work's fault, the row is appended and the claim is terminal.
        request, claim = self._claim(nonce="-decided-row")
        (self.repo / "src.txt").write_text("alpha\nCHANGED\ngamma\n", encoding="utf-8")
        result = self._submit(request, claim)
        self.assertEqual(result["status"], "rejected")
        self.assertNotIn("undecided", result)
        self.assertEqual(result["row"]["rejection_codes"], result["rejection_codes"])
        rows = self._result_rows(claim["claim_id"])
        self.assertEqual(rows[-1]["rejection_codes"], result["rejection_codes"])
        self.assertEqual(
            derive_request_state(request_id=request["request_id"], base_dir=self.e2e.tools), "REJECTED",
        )

    def test_a_probe_that_ran_and_disagreed_carries_the_agent_fault_code(self) -> None:
        request, claim = self._claim(nonce="-disagrees")
        (self.repo / "src.txt").write_text("alpha\nCHANGED\ngamma\n", encoding="utf-8")
        result = self._submit(request, claim)

        self.assertEqual(result["status"], "rejected")
        self.assertEqual(len(result["rejection_codes"]), len(result["reasons"]))
        self.assertEqual(set(result["rejection_codes"]), {"agent_evidence_not_repo_verified"})
        self.assertFalse(set(result["rejection_codes"]) & EVIDENCE_VERIFICATION_UNAVAILABLE_CODES)

    def test_the_same_envelope_is_accepted_once_git_answers(self) -> None:
        # The release is a retry, and the retry must have somewhere to go.
        request, claim = self._claim(nonce="-answers")
        self.assertEqual(self._submit(request, claim)["status"], "accepted")


class ThePredicateReadsCodesNotProse(unittest.TestCase):
    def test_all_unavailable_codes_is_true(self) -> None:
        stdout = _rejected_stdout(sorted(EVIDENCE_VERIFICATION_UNAVAILABLE_CODES))
        self.assertTrue(ci_executor._rejected_only_for_verification_unavailable(stdout))

    def test_one_request_fault_code_is_false(self) -> None:
        stdout = _rejected_stdout([
            "agent_evidence_verification_unavailable",
            "agent_evidence_not_repo_verified",
        ])
        self.assertFalse(ci_executor._rejected_only_for_verification_unavailable(stdout))

    def test_no_codes_unparseable_or_not_rejected_is_false(self) -> None:
        self.assertFalse(ci_executor._rejected_only_for_verification_unavailable(""))
        self.assertFalse(ci_executor._rejected_only_for_verification_unavailable("Traceback…"))
        self.assertFalse(ci_executor._rejected_only_for_verification_unavailable(
            json.dumps({"status": "rejected", "reasons": ["x"], "rejection_codes": []}),
        ))
        self.assertFalse(ci_executor._rejected_only_for_verification_unavailable(
            json.dumps({"status": "rejected", "reasons": ["x"]}),
        ))
        self.assertFalse(ci_executor._rejected_only_for_verification_unavailable(
            json.dumps({"status": "idempotent", "rejection_codes": ["agent_evidence_verification_unavailable"]}),
        ))

    def test_the_prose_never_decides(self) -> None:
        # A reason line that SAYS unavailable with a code that says otherwise
        # is the request's fault: prose is for people.
        stdout = json.dumps({
            "status": "rejected",
            "reasons": ["evidence: verification_unavailable"],
            "rejection_codes": ["agent_evidence_not_repo_verified"],
        })
        self.assertFalse(ci_executor._rejected_only_for_verification_unavailable(stdout))


class TheExecutorReleasesUnderTheHarnessReason(unittest.TestCase):
    """Uses the live-path fixture; only the submit verdict differs."""

    def setUp(self) -> None:
        self.live = _live_path.LivePathFetchTests()
        self.live.setUp()

    def tearDown(self) -> None:
        self.live.tearDown()

    def _release_reason_after_submit(self, submit_stdout: str) -> str:
        submit_rejected = MagicMock(returncode=1, stdout=submit_stdout, stderr="")
        fake_run = _live_path._make_fake_run_sequence(
            self.live.claim_response,
            submit_rejected,
            self.live.release_response_ok,
        )
        exit_code = self.live._run_main(fake_run)
        self.assertEqual(exit_code, 1)
        self.assertEqual(
            len(fake_run.captured), 3,
            f"claim + submit + release expected; argvs: {[list(c) for c in fake_run.captured]}",
        )
        release_argv = fake_run.captured[-1]
        self.assertIn("release", release_argv)
        return release_argv[release_argv.index("--reason") + 1]

    def test_only_unavailable_codes_release_as_evidence_verification_unavailable(self) -> None:
        reason = self._release_reason_after_submit(
            _rejected_stdout(["agent_evidence_verification_unavailable"] * 3),
        )
        self.assertEqual(reason, "evidence_verification_unavailable")

    def test_a_mixed_rejection_releases_as_submit_rejected(self) -> None:
        reason = self._release_reason_after_submit(
            _rejected_stdout([
                "agent_evidence_verification_unavailable",
                "agent_evidence_not_repo_verified",
            ]),
        )
        self.assertEqual(reason, "submit_rejected")

    def test_a_kernel_crash_releases_as_submit_rejected(self) -> None:
        reason = self._release_reason_after_submit("Traceback (most recent call last): …")
        self.assertEqual(reason, "submit_rejected")


if __name__ == "__main__":
    unittest.main()
