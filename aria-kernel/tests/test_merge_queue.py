"""ARIA-HIGH-221 — main merges through a required merge queue, not strict up-to-date.

Under strict branch protection an ARIA PR could merge only while main had
not moved: every piece of merge evidence is bound to the implementation
head and base, and updating the branch moves the head. Operator decision
2026-09-26: main requires a squash MERGE QUEUE, which tests the change on
top of current main in a merge group and leaves the PR head unchanged.

* The preflight and the readiness proof require the queue (a ruleset
  ``merge_queue`` rule, squash) and no longer require ``strict``.
* A merge call on a queue branch usually ENQUEUES. The adapter measures
  what happened, and the merge authority records ``merged``, ``enqueued``
  or ``failed`` (``merge_result_unconfirmed``) — never a merge it did not see.
* The merge lane settles each enqueued PR on a later run (``merged`` /
  ``dequeued``), and a PR still in the queue is not a candidate.
* Self-revert counts an enqueued PR the queue merged at that head.
* The pre-merge capture joins the implementation base (where the head
  forked from main), not main's moving tip.
"""
from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from aria_kernel.auto_merge import GhCliGitHubAdapter, merge_outcome
from aria_kernel.ledger import append_declared_jsonl, load_declared_jsonl
from aria_kernel.merge_authority import (
    merge_pr_if_ready,
    pending_enqueued_heads,
    reconcile_enqueued_merges,
)
from aria_kernel.tool_registry import ensure_tools_dir

_HEAD = "a" * 40
_OTHER = "b" * 40
_CLAIM = "claim:7:aaaaaaaaaaaa"


def _queue_rule(method: str = "SQUASH", ruleset_id: int = 101) -> dict:
    return {"type": "merge_queue", "ruleset_id": ruleset_id, "parameters": {"merge_method": method}}


class _GhFake:
    """``subprocess.run`` for the gh commands the kernel makes, by argv."""

    def __init__(self, *, protection: dict | None = None, rules: list | None = None,
                 merge_state: dict | None = None, merge_exit: int = 0) -> None:
        self.protection = protection
        self.rules = rules if rules is not None else []
        self.merge_state = merge_state
        self.merge_exit = merge_exit
        self.calls: list[list[str]] = []

    def __call__(self, argv, **kwargs):  # noqa: ANN001 — subprocess.run's shape
        argv = list(argv)
        self.calls.append(argv)
        joined = " ".join(argv)

        def done(body, code: int = 0) -> subprocess.CompletedProcess:
            return subprocess.CompletedProcess(argv, code, json.dumps(body) if body is not None else "", "")

        if argv[1:3] == ["repo", "view"]:
            return done({"owner": {"login": "okan"}, "name": "aqua"})
        if argv[1:3] == ["pr", "merge"]:
            return subprocess.CompletedProcess(argv, self.merge_exit, "", "" if self.merge_exit == 0 else "boom")
        if argv[1:3] == ["api", "graphql"]:
            return done({"data": {"repository": {"pullRequest": self.merge_state}}})
        if joined.endswith("/protection"):
            return done(self.protection)
        if "/rules/branches/" in joined:
            return done(self.rules)
        if "/rulesets/" in joined:
            return done({"id": int(argv[-1].rsplit("/", 1)[1]), "bypass_actors": []})
        return subprocess.CompletedProcess(argv, 1, "", f"unexpected {joined}")


def _protection(*, strict: bool | None = None) -> dict:
    checks: dict = {"contexts": ["merge-gate"]}
    if strict is not None:
        checks["strict"] = strict
    return {
        "required_status_checks": checks,
        "required_signatures": {"enabled": True},
        "enforce_admins": {"enabled": True},
    }


class PreflightRequiresTheQueueNotStrictTests(unittest.TestCase):
    def _verify(self, fake: _GhFake) -> tuple[bool, tuple[str, ...]]:
        from aria_kernel.preflight import verify_branch_protection

        with patch.object(subprocess, "run", fake), \
                patch("aria_kernel.preflight._gh_available", return_value=True), \
                patch("aria_kernel.preflight._read_gh_token", return_value="t0k"):
            return verify_branch_protection(branch="main", repo="okan/aqua")

    def test_a_squash_queue_without_strict_passes(self) -> None:
        ok, reasons = self._verify(_GhFake(protection=_protection(), rules=[_queue_rule()]))
        self.assertTrue(ok, reasons)
        self.assertEqual(reasons, ())

    def test_strict_is_neither_required_nor_refused(self) -> None:
        for strict in (True, False):
            with self.subTest(strict=strict):
                ok, reasons = self._verify(_GhFake(protection=_protection(strict=strict), rules=[_queue_rule()]))
                self.assertTrue(ok, reasons)

    def test_no_queue_is_refused_by_name(self) -> None:
        ok, reasons = self._verify(_GhFake(protection=_protection(strict=True), rules=[
            {"type": "pull_request", "ruleset_id": 101},
        ]))
        self.assertFalse(ok)
        self.assertIn("merge_queue_required", reasons)

    def test_a_queue_that_does_not_squash_is_refused(self) -> None:
        ok, reasons = self._verify(_GhFake(protection=_protection(), rules=[_queue_rule("MERGE")]))
        self.assertFalse(ok)
        self.assertTrue(any(reason.startswith("merge_queue_merge_method=") for reason in reasons), reasons)

    def test_two_queue_rules_that_disagree_are_refused(self) -> None:
        ok, reasons = self._verify(_GhFake(
            protection=_protection(), rules=[_queue_rule("SQUASH", 101), _queue_rule("REBASE", 102)],
        ))
        self.assertFalse(ok)
        self.assertTrue(any(reason.startswith("merge_queue_merge_method=") for reason in reasons), reasons)


class ReadinessProofRequiresTheQueueTests(unittest.TestCase):
    def _reasons(self, **fields) -> list[str]:
        from aria_kernel.enterprise_readiness import branch_protection_policy_reasons

        return branch_protection_policy_reasons(fields)

    def test_the_claim_gate_names_a_missing_or_non_squash_queue(self) -> None:
        self.assertIn("branch_protection_merge_queue_required", self._reasons())
        self.assertIn(
            "branch_protection_merge_queue_required",
            self._reasons(merge_queue_required=False, merge_queue_merge_method="SQUASH"),
        )
        self.assertIn(
            "branch_protection_merge_queue_method_must_be_squash",
            self._reasons(merge_queue_required=True, merge_queue_merge_method="MERGE"),
        )
        reasons = self._reasons(merge_queue_required=True, merge_queue_merge_method="SQUASH")
        self.assertNotIn("branch_protection_merge_queue_required", reasons)
        self.assertNotIn("branch_protection_merge_queue_method_must_be_squash", reasons)

    def test_the_proof_records_the_queue_and_strict(self) -> None:
        from aria_kernel.readiness_proofs import probe_branch_protection_on_demand
        from tests.test_branch_protection_proof import _strong_payload

        with tempfile.TemporaryDirectory() as tmp:
            tools = Path(tmp) / "aria-tools"
            ensure_tools_dir(tools)
            payload = _strong_payload()
            payload["required_status_checks"] = dict(payload["required_status_checks"], strict=True)
            row = probe_branch_protection_on_demand(
                repo="okan/aqua", branch="main", base_dir=tools,
                probe=lambda *, branch, repo: (True, (), payload),
                rules_probe=lambda *, repo, branch: (
                    [101], [], {"merge_method": "SQUASH", "ruleset_id": 101, "merge_methods": ["SQUASH"]},
                ),
            )
            without_queue = probe_branch_protection_on_demand(
                repo="okan/aqua", branch="main", base_dir=tools,
                probe=lambda *, branch, repo: (True, (), payload),
                rules_probe=lambda *, repo, branch: ([101], [], None),
            )
        self.assertIs(row["valid"], True, row["reasons"])
        self.assertIs(row["proof"]["merge_queue_required"], True)
        self.assertEqual(row["proof"]["merge_queue_merge_method"], "SQUASH")
        self.assertEqual(row["proof"]["merge_queue_ruleset_id"], 101)
        self.assertIs(row["proof"]["strict_up_to_date_required"], True)
        self.assertIs(without_queue["valid"], False)
        self.assertIs(without_queue["proof"]["valid"], False)
        self.assertIn("merge_queue_required", without_queue["reasons"])
        self.assertIn("branch_protection_merge_queue_required", without_queue["reasons"])


class TheAdapterMeasuresWhatTheMergeCallDidTests(unittest.TestCase):
    def _merge(self, merge_state: dict | None, *, merge_exit: int = 0) -> tuple[dict, _GhFake]:
        fake = _GhFake(merge_state=merge_state, merge_exit=merge_exit)
        with patch.object(subprocess, "run", fake):
            adapter = GhCliGitHubAdapter(cwd=".")
            adapter.arm_merge_authority("token")
            result = adapter.merge_pr(7, method="squash", expected_head_sha=_HEAD, authority_token="token")
        return result, fake

    def test_a_queued_pr_is_enqueued_not_merged(self) -> None:
        result, fake = self._merge({"state": "OPEN", "headRefOid": _HEAD, "isInMergeQueue": True,
                                    "autoMergeRequest": None, "mergeCommit": None})
        self.assertEqual((result["merged"], result["enqueued"]), (False, True))
        merge = next(argv for argv in fake.calls if argv[1:3] == ["pr", "merge"])
        self.assertIn("--squash", merge)
        self.assertEqual(merge[merge.index("--match-head-commit") + 1], _HEAD)

    def test_an_armed_auto_merge_is_enqueued(self) -> None:
        result, _ = self._merge({"state": "OPEN", "headRefOid": _HEAD, "isInMergeQueue": False,
                                 "autoMergeRequest": {"enabledAt": "2026-09-26T00:00:00Z"}, "mergeCommit": None})
        self.assertEqual((result["merged"], result["enqueued"]), (False, True))

    def test_a_merged_pr_at_the_head_is_merged(self) -> None:
        result, _ = self._merge({"state": "MERGED", "headRefOid": _HEAD, "isInMergeQueue": False,
                                 "autoMergeRequest": None, "mergeCommit": {"oid": "c" * 40}})
        self.assertEqual((result["merged"], result["enqueued"]), (True, False))
        self.assertEqual(result["observed"]["merge_commit_sha"], "c" * 40)

    def test_anything_else_is_neither(self) -> None:
        for state in (
            {"state": "OPEN", "headRefOid": _HEAD, "isInMergeQueue": False, "autoMergeRequest": None},
            {"state": "OPEN", "headRefOid": _OTHER, "isInMergeQueue": True, "autoMergeRequest": None},
            {"state": "MERGED", "headRefOid": _OTHER, "isInMergeQueue": False, "autoMergeRequest": None},
            {"state": "CLOSED", "headRefOid": _HEAD, "isInMergeQueue": False, "autoMergeRequest": None},
        ):
            with self.subTest(state=state):
                result, _ = self._merge(state)
                self.assertEqual((result["merged"], result["enqueued"]), (False, False))

    def test_an_unreadable_merge_state_is_refused_by_name(self) -> None:
        from aria_kernel.tool_registry import GovernanceError

        with self.assertRaisesRegex(GovernanceError, "merge_state_unreadable"):
            self._merge(None)

    def test_nothing_observed_is_neither(self) -> None:
        result = merge_outcome(None, expected_head_sha=_HEAD, method="squash")
        self.assertEqual((result["merged"], result["enqueued"], result["observed"]), (False, False, None))


class _Adapter:
    def __init__(self, merge_result: dict, *, merge_state: dict | None = None) -> None:
        self.merge_result = merge_result
        self.merge_state = merge_state
        self.calls: list[str] = []

    def get_open_issues(self, *, labels):
        return {"readable": True, "issues": []}

    def get_pr(self, pr_number: int) -> dict:
        state = self.merge_state or {}
        return {
            "number": pr_number, "state": state.get("state", "OPEN"), "repository": "okan/aqua",
            "base_branch": "main", "head_ref": "feat/x", "head_sha": state.get("head_sha", _HEAD),
            "merge_commit_sha": state.get("merge_commit_sha"),
        }

    def get_merge_state(self, number: int) -> dict | None:
        return self.merge_state

    def merge_pr(self, pr_number: int, **kwargs) -> dict:
        self.calls.append("merge")
        return dict(self.merge_result)


def _gates() -> list:
    from tests.test_merge_lane_publication import _gates as publication_gates

    return publication_gates()


class _Store(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.tools = Path(self.tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)

    def _rows(self, relpath: str, surface: str) -> list[dict]:
        path = self.tools / relpath
        return load_declared_jsonl(path, expected_surface=surface) if path.exists() else []

    def _decisions(self) -> list[dict]:
        return self._rows("auto-merge-decisions.jsonl", "auto_merge_decisions")

    def _lifecycle(self) -> list[dict]:
        return self._rows("pr-lifecycle.jsonl", "pr_lifecycle")

    def _incidents(self) -> list[dict]:
        return self._rows("enterprise/incidents.jsonl", "enterprise_incidents")


class TheAuthorityRecordsWhatHappenedTests(_Store):
    def setUp(self) -> None:
        super().setUp()
        for item in _gates():
            item.start()
            self.addCleanup(item.stop)

    def _merge(self, merge_result: dict) -> dict:
        return merge_pr_if_ready(
            adapter=_Adapter(merge_result), pr_number=7, base_dir=self.tools,
            readiness_claim_id=_CLAIM, intent_publisher=lambda intent: {"published": True},
        )

    def test_an_enqueued_pr_is_recorded_enqueued_not_merged(self) -> None:
        result = self._merge({"merged": False, "enqueued": True})
        self.assertEqual(result["decision"], "enqueued")
        self.assertTrue(result["eligible"])
        self.assertEqual([row["decision"] for row in self._decisions()][-1], "enqueued")
        self.assertNotIn("merged", [row["event"] for row in self._lifecycle()])
        self.assertNotIn("merge_finalized_no_incident", [row["incident_event"] for row in self._incidents()])
        self.assertEqual(pending_enqueued_heads(self.tools), {(7, _HEAD)})

    def test_a_merged_result_is_recorded_merged(self) -> None:
        result = self._merge({"merged": True, "enqueued": False})
        self.assertEqual(result["decision"], "merged")
        self.assertIn("merged", [row["event"] for row in self._lifecycle()])
        self.assertIn("merge_finalized_no_incident", [row["incident_event"] for row in self._incidents()])

    def test_an_unconfirmed_result_is_a_failure_never_a_merge(self) -> None:
        # A zero exit used to be recorded as `merged` whatever GitHub did.
        for merge_result in ({"merged": False, "enqueued": False}, {}, {"merged": "yes"}):
            with self.subTest(merge_result=merge_result):
                result = self._merge(merge_result)
                self.assertEqual(result["decision"], "failed")
                self.assertEqual(result["reasons"], ["merge_result_unconfirmed"])
        self.assertNotIn("merged", [row["event"] for row in self._lifecycle()])
        self.assertIn("merge_failed", [row["incident_event"] for row in self._incidents()])


class TheLaneSettlesTheQueueTests(_Store):
    def _enqueue(self, pr_number: int = 7, head_sha: str = _HEAD) -> None:
        append_declared_jsonl(
            self.tools / "auto-merge-decisions.jsonl",
            {"schema_version": 1, "pr_number": pr_number, "head_sha": head_sha, "decision": "enqueued",
             "eligible": True, "readiness_claim_id": _CLAIM},
            expected_surface="auto_merge_decisions",
        )

    def _settle(self, merge_state: dict | None) -> list[dict]:
        return reconcile_enqueued_merges(adapter=_Adapter({}, merge_state=merge_state), base_dir=self.tools)

    def test_a_pr_the_queue_merged_at_that_head_is_recorded_merged(self) -> None:
        self._enqueue()
        settled = self._settle({"state": "MERGED", "head_sha": _HEAD, "in_merge_queue": False,
                                "auto_merge_enabled": False, "merge_commit_sha": "c" * 40})
        self.assertEqual([row["decision"] for row in settled], ["merged"])
        self.assertEqual(settled[0]["merge_result"]["via"], "merge_queue")
        self.assertEqual(settled[0]["readiness_claim_id"], _CLAIM)
        self.assertIn("merged", [row["event"] for row in self._lifecycle()])
        self.assertIn("merge_finalized_no_incident", [row["incident_event"] for row in self._incidents()])
        self.assertEqual(pending_enqueued_heads(self.tools), set())
        # Settled once: a later run finds nothing to settle.
        self.assertEqual(self._settle({"state": "MERGED", "head_sha": _HEAD}), [])

    def test_a_pr_still_in_the_queue_is_left_pending(self) -> None:
        self._enqueue()
        for state in (
            {"state": "OPEN", "head_sha": _HEAD, "in_merge_queue": True, "auto_merge_enabled": False},
            {"state": "OPEN", "head_sha": _HEAD, "in_merge_queue": False, "auto_merge_enabled": True},
        ):
            with self.subTest(state=state):
                self.assertEqual(self._settle(state), [])
        self.assertEqual(pending_enqueued_heads(self.tools), {(7, _HEAD)})

    def test_a_pr_the_queue_let_go_is_dequeued_by_name(self) -> None:
        for state, reason in (
            ({"state": "OPEN", "head_sha": _HEAD, "in_merge_queue": False, "auto_merge_enabled": False},
             "dequeued_removed_from_merge_queue"),
            ({"state": "OPEN", "head_sha": _OTHER, "in_merge_queue": True, "auto_merge_enabled": False},
             f"dequeued_head_changed:{_OTHER}"),
            ({"state": "CLOSED", "head_sha": _HEAD, "in_merge_queue": False, "auto_merge_enabled": False},
             "dequeued_pr_closed"),
        ):
            with self.subTest(reason=reason):
                self._enqueue()
                settled = self._settle(state)
                self.assertEqual([(row["decision"], row["reasons"]) for row in settled], [("dequeued", [reason])])
                self.assertEqual(pending_enqueued_heads(self.tools), set())
        self.assertNotIn("merged", [row["event"] for row in self._lifecycle()])

    def test_an_adapter_that_observes_nothing_settles_nothing(self) -> None:
        self._enqueue()
        self.assertEqual(self._settle(None), [])
        self.assertEqual(pending_enqueued_heads(self.tools), {(7, _HEAD)})

    def test_a_pr_pending_in_the_queue_is_not_a_candidate(self) -> None:
        from aria_kernel.auto_merge_runners import enumerate_prs_with_readiness_claims

        append_declared_jsonl(
            self.tools / "enterprise" / "readiness-claims.jsonl",
            {"readiness_claim_id": _CLAIM, "row_id": "claim-7", "row_type": "readiness_claim",
             "pr_number": 7, "head_sha": _HEAD},
            expected_surface="enterprise_readiness_claims", bypass_profile_gate=True,
        )
        adapter = SimpleNamespace(list_open_pull_request_heads=lambda: {7: _HEAD})
        self.assertEqual(enumerate_prs_with_readiness_claims(adapter, base_dir=self.tools), [7])
        self._enqueue()
        self.assertEqual(enumerate_prs_with_readiness_claims(adapter, base_dir=self.tools), [])

    def test_the_merge_lane_settles_the_queue_before_it_evaluates(self) -> None:
        from aria_kernel.auto_merge_runners import RealAutoMergeRunner
        from tests._helpers.actions_oidc import merge_lane_job

        self._enqueue()
        adapter = _Adapter({}, merge_state={"state": "MERGED", "head_sha": _HEAD, "in_merge_queue": False,
                                            "auto_merge_enabled": False, "merge_commit_sha": "c" * 40})
        seen: list[set] = []
        runner = RealAutoMergeRunner(
            profile="autonomous", executes_merges=True, adapter_factory=lambda: adapter,
            pr_enumerator=lambda _adapter: seen.append(pending_enqueued_heads(self.tools)) or [],
            readiness_claim_resolver=lambda *_: _CLAIM,
        )
        with merge_lane_job(), \
                patch("aria_kernel.runtime_profile.merge_authority_available", return_value=True), \
                patch("aria_kernel.watchdog_freeze.open_watchdog_incidents",
                      return_value={"readable": True, "incidents": [], "reason": "clear"}):
            result = runner(base_dir=self.tools, workspace_root=None)
        self.assertEqual(seen, [set()])
        self.assertEqual([row["decision"] for row in result["queue_settled"]], ["merged"])
        self.assertEqual(result["merges_completed"], 1)
        self.assertEqual(result["candidates_evaluated"], 0)

    def test_an_evaluating_run_settles_nothing(self) -> None:
        from aria_kernel.auto_merge_runners import RealAutoMergeRunner

        self._enqueue()

        class _Refuses(_Adapter):
            def get_merge_state(self, number: int) -> dict | None:
                raise AssertionError("a dry run must not settle the queue")

        runner = RealAutoMergeRunner(
            profile="strict", executes_merges=False, adapter_factory=lambda: _Refuses({}),
            pr_enumerator=lambda _adapter: [], readiness_claim_resolver=lambda *_: _CLAIM,
        )
        result = runner(base_dir=self.tools, workspace_root=None)
        self.assertTrue(result["dry_run"])
        self.assertEqual(result["queue_settled"], [])


class SelfRevertCountsAQueuedMergeTests(_Store):
    def test_an_enqueued_pr_the_queue_merged_at_that_head_is_an_aria_merge(self) -> None:
        from aria_kernel.self_revert import _aria_merged_prs

        append_declared_jsonl(
            self.tools / "auto-merge-decisions.jsonl",
            {"schema_version": 1, "pr_number": 9, "head_sha": _HEAD, "decision": "enqueued"},
            expected_surface="auto_merge_decisions",
        )
        self.assertEqual(_aria_merged_prs(self.tools), set())
        append_declared_jsonl(
            self.tools / "ci" / "merge-outcomes.jsonl",
            {"schema_version": 1, "pr_number": 9, "head_ref": "aria-impl-0123456789abcdef",
             "head_sha": _HEAD, "merge_sha": "f" * 40, "red_jobs": [], "pending_jobs": [], "status": "green"},
            expected_surface="merge_outcomes",
        )
        self.assertEqual(_aria_merged_prs(self.tools), {9})


if __name__ == "__main__":
    unittest.main()
