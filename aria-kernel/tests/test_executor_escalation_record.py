"""ARIA-HIGH-124 (round 3) — the executor's HUMAN_REQUIRED record is the kernel's, in-process.

The executor escalates a request it holds — a branch collision, an invalid
request row, a delivery refusal, the agent's own refusal envelope, a model
refusal — by writing the HUMAN_REQUIRED record BEFORE it releases the claim;
``agent_invocations.release_claim`` then derives ``human_required`` for a
request-class release of a request with an open record. Round 2 wrote that
record through a ``human-required record`` CHILD whose ``--reason`` went
through the operator CLI's free-text validator (``cli._validate_reason``):
its phone-number shape matches ANY ten consecutive digits, every
kernel-minted id embeds hex, and 8% of ``aria-impl-*`` names (11% of shas)
carry such a run — so one escalation in ten was refused at argparse, the
record never written, the release ``requeued`` instead of ``human_required``,
and the drain re-claimed the request into the same refusal until the requeue
threshold caught it. The child's stderr was truncated to 200 characters, so
the cause never reached a log.

These pins hold the round-3 shape (the end-to-end chain, with a branch that
carries such a run, is ``tests/test_executor_implementation_identity.py``):

* the ONE recorder writes in-process through
  ``human_required.record_human_required`` with the machine ids in the
  record's structured ``context`` under the unadmitted
  ``EXECUTOR_ESCALATION_KIND`` — a reason and ids that the operator CLI's
  validator refuses land unchanged;
* a recorder that does not answer is an ERROR at the release site
  (``_release_unescalated``): the claim is released harness-class under
  ``human_required_record_unavailable:<escalation reason>`` — a closed
  vocabulary code, classified — with the whole cause on governance and the
  child's summary a FAILED harness dispatch, never a ``refused`` exit that
  reads as if the escalation happened;
* every call of the recorder in the executor is wrapped in that handler
  (read from the executor's AST), so no site can swallow the failure.
"""
from __future__ import annotations

import argparse
import ast
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

_REPO_ROOT = Path(__file__).resolve().parents[2]
_POC_DIR = _REPO_ROOT / "tools" / "aria-poc"
if str(_POC_DIR) not in sys.path:
    sys.path.insert(0, str(_POC_DIR))

import ci_executor  # noqa: E402

from aria_kernel.agent_invocations import classify_release_reason  # noqa: E402
from aria_kernel.cli import _validate_reason  # noqa: E402
from aria_kernel.human_required import EXECUTOR_ESCALATION_KIND, open_human_required_record  # noqa: E402
from aria_kernel.human_required_adjudication import escalation_adjudicability  # noqa: E402
from aria_kernel.ledger import load_declared_jsonl  # noqa: E402
from aria_kernel.release_reason import HUMAN_REQUIRED_RECORD_UNAVAILABLE_PREFIX, parse_release_reason  # noqa: E402
from aria_kernel.runtime_profile import set_profile  # noqa: E402
from aria_kernel.tool_registry import ensure_tools_dir  # noqa: E402

# A branch production's producer mints (`aria-impl-` + sha256(plan_id)[:16])
# whose hex carries ten consecutive digits, and a sha with the same run.
BRANCH_WITH_A_TEN_DIGIT_RUN = "aria-impl-2136769466149bcd"
SHA_WITH_A_TEN_DIGIT_RUN = "0123456789" + "a" * 30
REQUEST = {"role": "implementation", "target_agent": "aria-implementer", "request_id": "AIR-124-3"}


class TheRecorderIsInProcessTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="aria-124-record-")
        self.addCleanup(self.tmp.cleanup)
        self.tools = ensure_tools_dir(Path(self.tmp.name) / "aria-tools")

    def _governance(self, kind: str) -> list[dict]:
        return [row for row in load_declared_jsonl(self.tools / "governance.jsonl", expected_surface="tools_governance")
                if row.get("kind") == kind]

    def test_ids_with_ten_digit_runs_land_in_the_records_context(self) -> None:
        # The operator CLI's free-text validator refuses such ids as PII —
        # the round-2 child's failure, documented here as the class.
        for text in (
            f"implementation_branch_collision: refs/heads/{BRANCH_WITH_A_TEN_DIGIT_RUN} already exists",
            f"implementation_request_invalid: base_sha={SHA_WITH_A_TEN_DIGIT_RUN!r} cannot stand a sandbox",
        ):
            with self.assertRaisesRegex(argparse.ArgumentTypeError, "must not contain PII tokens"):
                _validate_reason(text)
        # The executor's recorder never meets it: the ids ride the record's
        # context, the reason is the code and its sentence, and the record
        # is what the release reads.
        record = ci_executor._record_human_required(
            tools_dir=self.tools, request_id=REQUEST["request_id"], severity="HIGH",
            reason="implementation_branch_collision: the shared repository already holds this request's "
                   "implementation branch (an earlier attempt published it); deliver or delete it, then requeue",
            context={"code": "implementation_branch_collision", "stage": "branch_preparation",
                     "branch": BRANCH_WITH_A_TEN_DIGIT_RUN, "base_sha": SHA_WITH_A_TEN_DIGIT_RUN, "claim_id": "claim-1"},
        )
        on_disk = open_human_required_record(REQUEST["request_id"], base_dir=self.tools)
        self.assertEqual(on_disk, record)
        self.assertEqual(on_disk["status"], "open")
        self.assertEqual(on_disk["context"]["kind"], EXECUTOR_ESCALATION_KIND)
        self.assertEqual(on_disk["context"]["branch"], BRANCH_WITH_A_TEN_DIGIT_RUN)
        self.assertEqual(on_disk["context"]["base_sha"], SHA_WITH_A_TEN_DIGIT_RUN)
        self.assertEqual(on_disk["context"]["request_id"], REQUEST["request_id"])
        self.assertTrue(on_disk["reason"].startswith("implementation_branch_collision: "))
        self.assertNotIn(BRANCH_WITH_A_TEN_DIGIT_RUN, on_disk["reason"])
        self.assertEqual([row["details"]["request_id"] for row in self._governance("human_required_recorded")],
                         [REQUEST["request_id"]])
        # The kind is deliberately unadmitted: the record stays with the
        # operator (deliver or delete a branch is a person's decision).
        verdict = escalation_adjudicability(on_disk)
        self.assertFalse(verdict.adjudicable)
        self.assertEqual(verdict.reason, f"context_kind_not_admitted:{EXECUTOR_ESCALATION_KIND}")
        # Idempotent, like every kernel producer's record.
        again = ci_executor._record_human_required(
            tools_dir=self.tools, request_id=REQUEST["request_id"], severity="HIGH", reason="second attempt, ignored",
            context={"code": "implementation_branch_collision"},
        )
        self.assertEqual(again, record)

    def test_a_recorder_that_does_not_answer_is_an_error_at_the_release_site(self) -> None:
        # A frozen store refuses the record's write: the round-2 executor
        # wrote a 200-character stderr line and released `requeued`, as if
        # nothing had happened. Now the failure is named as such.
        set_profile("frozen", operator_approval_ref="op:freeze", base_dir=self.tools)
        with self.assertRaises(ci_executor.HumanRequiredRecordUnavailable) as failed:
            ci_executor._record_human_required(
                tools_dir=self.tools, request_id=REQUEST["request_id"], severity="HIGH",
                reason="implementation_branch_collision: the shared repository already holds this branch",
                context={"code": "implementation_branch_collision", "branch": BRANCH_WITH_A_TEN_DIGIT_RUN},
            )
        self.assertIn("GovernanceError", str(failed.exception))
        self.assertIn("profile_violation", str(failed.exception))
        self.assertIsNone(open_human_required_record(REQUEST["request_id"], base_dir=self.tools))
        # A dying disk under the record file is the same class, with the
        # store's governance still answering: the release site's error
        # writes its row there. (The frozen store above refuses that row
        # too; the error then names it on stderr.)
        set_profile("standard", operator_approval_ref="op:thaw", base_dir=self.tools)
        with mock.patch("aria_kernel.human_required.record_human_required",
                        side_effect=OSError(28, "No space left on device")):
            with self.assertRaises(ci_executor.HumanRequiredRecordUnavailable) as failed:
                ci_executor._record_human_required(
                    tools_dir=self.tools, request_id=REQUEST["request_id"], severity="HIGH",
                    reason="implementation_branch_collision: the shared repository already holds this branch",
                    context={"code": "implementation_branch_collision", "branch": BRANCH_WITH_A_TEN_DIGIT_RUN},
                )
        self.assertIn("OSError", str(failed.exception))
        self.assertIn("No space left on device", str(failed.exception))
        releases: list[dict] = []
        summaries: list[dict] = []
        with mock.patch.object(ci_executor, "_release_claim", side_effect=lambda **kw: releases.append(kw) or True), \
                mock.patch.object(ci_executor, "_write_dispatch_summary", side_effect=lambda **kw: summaries.append(kw)), \
                mock.patch.object(ci_executor, "_dispatch_route_for", return_value="route"), \
                mock.patch.object(sys, "stderr") as stderr:
            exit_code = ci_executor._release_unescalated(
                tools_dir=self.tools, repo=Path(self.tmp.name), request=REQUEST, request_id=REQUEST["request_id"],
                target_agent="aria-implementer", claim_id="claim-1", agent_id="agent-1", lease_token="lease",
                escalation_reason="implementation_branch_collision", phase="preflight", error=failed.exception,
            )
        self.assertEqual(exit_code, 1)
        # The claim IS released — under a reason that names the recorder's
        # failure with the escalation as its detail, harness-class: the
        # request keeps its budget and the retry escalates again.
        self.assertEqual(len(releases), 1)
        release_reason = releases[0]["reason"]
        self.assertEqual(release_reason, f"{HUMAN_REQUIRED_RECORD_UNAVAILABLE_PREFIX}implementation_branch_collision")
        self.assertEqual(classify_release_reason(release_reason), "harness")
        parsed = parse_release_reason(release_reason)
        self.assertEqual((parsed.reason_code, parsed.reason_detail, parsed.fault_domain),
                         ("HUMAN_REQUIRED_RECORD_UNAVAILABLE", "implementation_branch_collision", "harness"))
        self.assertEqual((releases[0]["claim_id"], releases[0]["lease_token"]), ("claim-1", "lease"))
        # The summary is a FAILED harness dispatch, never `refused`.
        self.assertEqual(len(summaries), 1)
        self.assertEqual(summaries[0]["outcome"], "failed")
        failure = summaries[0]["failure"]
        self.assertEqual((failure.failure_class, failure.retryable, failure.detail_code, failure.phase, failure.exit_code),
                         ("harness_unavailable", True, "human_required_record_unavailable", "preflight", 1))
        # The whole cause is on governance and on stderr as a job error.
        rows = self._governance("human_required_record_unavailable")
        self.assertEqual(len(rows), 1, rows)
        self.assertEqual(rows[0]["details"]["escalation_reason"], "implementation_branch_collision")
        self.assertIn("No space left on device", rows[0]["details"]["error"])
        written = "".join(str(call.args[0]) for call in stderr.write.call_args_list)
        self.assertIn("::error::aria executor could not record HUMAN_REQUIRED", written)
        self.assertIn("No space left on device", written)

    def test_every_recorder_call_in_the_executor_is_guarded_by_the_release_sites_error(self) -> None:
        # Read from the executor's AST: each `_record_human_required(...)`
        # call sits inside a `try` whose handler names the recorder's
        # exception, and the executor spawns no `human-required` child.
        tree = ast.parse(Path(ci_executor.__file__).read_text(encoding="utf-8"))
        guarded = 0
        unguarded: list[int] = []

        def handlers_of(node: ast.Try) -> set[str]:
            names: set[str] = set()
            for handler in node.handlers:
                kind = handler.type
                if isinstance(kind, ast.Name):
                    names.add(kind.id)
                elif isinstance(kind, ast.Tuple):
                    names.update(elt.id for elt in kind.elts if isinstance(elt, ast.Name))
            return names

        def walk(node: ast.AST, enclosing: tuple[ast.Try, ...]) -> None:
            nonlocal guarded
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "_record_human_required":
                if any("HumanRequiredRecordUnavailable" in handlers_of(t) for t in enclosing):
                    guarded += 1
                else:
                    unguarded.append(node.lineno)
            for child in ast.iter_child_nodes(node):
                if isinstance(node, ast.Try) and child in node.body:
                    walk(child, (*enclosing, node))
                else:
                    walk(child, enclosing)

        walk(tree, ())
        self.assertEqual(unguarded, [], f"recorder calls outside the release site's error handler at lines {unguarded}")
        # The five escalation sites: the branch collision / invalid row
        # (one site), the agent refusal, the delivery refusal, the model
        # refusal.
        self.assertEqual(guarded, 4)
        source = Path(ci_executor.__file__).read_text(encoding="utf-8")
        self.assertNotIn('"human-required", "record"', source)
        self.assertIn("HUMAN_REQUIRED_RECORD_WORST_CASE_SECONDS", source)
        self.assertNotIn("HUMAN_REQUIRED_RECORD_TIMEOUT_SECONDS", source)

    def test_the_recorder_failure_release_is_in_the_closed_vocabulary(self) -> None:
        from aria_kernel.agent_invocations import HARNESS_FAULT_RELEASE_REASON_PREFIXES
        from aria_kernel.release_reason import RELEASE_REASON_CODES

        self.assertIn(HUMAN_REQUIRED_RECORD_UNAVAILABLE_PREFIX, HARNESS_FAULT_RELEASE_REASON_PREFIXES)
        self.assertIn("HUMAN_REQUIRED_RECORD_UNAVAILABLE", RELEASE_REASON_CODES)
        self.assertEqual(HUMAN_REQUIRED_RECORD_UNAVAILABLE_PREFIX, "human_required_record_unavailable:")
        # The executor spells the prefix the way the kernel owns it.
        source = Path(ci_executor.__file__).read_text(encoding="utf-8")
        self.assertIn('reason=f"human_required_record_unavailable:{escalation_reason}"', source)


if __name__ == "__main__":
    unittest.main()
