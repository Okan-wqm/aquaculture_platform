"""PLAN-v2 §2 'Durdurma' / B0 — the operator's ``vars.ARIA_STOP`` stops ARIA; non-empty means stop.

ARIA-HIGH-765: ARIA's stop was a file in its own writable store that the
kernel itself writes, no merge-path module checked it, and the merge runner
wired no operator-owned variable into its preflight kill switch. B0 makes the
operator's repository variable the stop, read twice:

* AT JOB START: every ARIA workflow starts no job while it is set and passes
  it to every step as the ``ARIA_STOP`` environment variable (pinned in
  ``tests/invariants/test_aria_stop_every_workflow.py``); the workflow
  preflight's kill switch reads that copy for ANY non-empty value — the
  operator writes what they like ("halt", a reason, a ticket id), and the
  preflight used to read ``ARIA_STOP`` as a truthy word (1/true/yes/on);
* LIVE, IN PROCESS (B0 corrective R1): GitHub evaluates the job's copy once,
  when the job starts, and every job is gated on it being empty, so a re-check
  of that copy inside the job can never fire. kernel_change admission and the
  merge authority (right before the merge call) read the repository variable
  itself, through ``preflight.repository_operator_stop`` — and fail closed: a
  variable that cannot be read, or no source at all, is a stop.

The merge-moment fixture keeps the process environment's ``ARIA_STOP`` empty
throughout and sets the operator's variable (behind a fake ``gh``) while the
merge intent is being published: the merge call must not happen. Then (B0
corrective R2) the operator merges the same PR at the same head by hand, and
self-revert must not count that merge as ARIA's.

The ``ARIA_STOP`` FILE stays the kernel's own deadline stop; its absence is
never a clearing authority over the operator's variable.
"""
from __future__ import annotations

import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import patch

from aria_kernel.ledger import append_declared_jsonl, load_declared_jsonl
from aria_kernel.merge_authority import merge_pr_if_ready
from aria_kernel.own_pr_ci import merge_outcomes_path
from aria_kernel.preflight import (
    OPERATOR_STOP_REFUSAL,
    OPERATOR_STOP_UNREADABLE,
    OperatorStopUnreadable,
    operator_stop_engaged,
    repository_operator_stop,
    verify_workflow_preflight,
)
from aria_kernel.self_modification import REQUIRED_KERNEL_VALIDATIONS, request_kernel_change
from aria_kernel.self_revert import _aria_merged_prs
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir
from aria_kernel.workflow_contracts import WORKFLOW_CONTRACTS

_HEAD = "a" * 40
_REPOSITORY = "okan/aqua"
# What an operator types into the repository variable: not a truthy word.
_OPERATOR_STOP = "halt: board drill 2026-10-23"


def _stop_env(value: str | None) -> dict[str, str]:
    """The process environment with ARIA_STOP as given (None: unset) and no other kill switch."""
    env = {k: v for k, v in os.environ.items() if k not in ("ARIA_STOP", "ARIA_GLOBAL_KILL_SWITCH")}
    if value is not None:
        env["ARIA_STOP"] = value
    return env


class _FakeRepositoryVariables:
    """A ``gh`` on disk that answers ``gh api repos/<repo>/actions/variables?...`` from a state file.

    The state is the repository's variables (``{name: value}``), or a forced
    failure: ``exit`` (gh's exit status) or ``body`` (a raw stdout). Every
    request path is logged, so a test can see what the reader asked.
    """

    def __init__(self, root: Path) -> None:
        self.state = root / "variables.json"
        self.log = root / "requests.log"
        self.gh = root / "gh"
        self.set(variables={"SOME_OTHER": "x"})
        self.gh.write_text(
            f"#!{sys.executable}\n"
            "import json, pathlib, sys, urllib.parse\n"
            f"state = json.loads(pathlib.Path({str(self.state)!r}).read_text())\n"
            f"pathlib.Path({str(self.log)!r}).open('a').write(sys.argv[2] + '\\n')\n"
            "if state.get('exit'):\n"
            "    sys.stderr.write('gh: HTTP 403: Resource not accessible by integration\\n')\n"
            "    raise SystemExit(state['exit'])\n"
            "if state.get('body') is not None:\n"
            "    sys.stdout.write(state['body'])\n"
            "    raise SystemExit(0)\n"
            "query = urllib.parse.parse_qs(urllib.parse.urlsplit(sys.argv[2]).query)\n"
            "size, page = int(query['per_page'][0]), int(query['page'][0])\n"
            "items = [{'name': k, 'value': v} for k, v in state['variables'].items()]\n"
            "sys.stdout.write(json.dumps({'total_count': len(items),\n"
            "                             'variables': items[(page - 1) * size: page * size]}))\n",
            encoding="utf-8",
        )
        self.gh.chmod(self.gh.stat().st_mode | stat.S_IXUSR)

    def set(self, **state: Any) -> None:
        self.state.write_text(json.dumps(state), encoding="utf-8")

    def requests(self) -> list[str]:
        return self.log.read_text(encoding="utf-8").splitlines() if self.log.exists() else []

    def source(self):  # noqa: ANN201 — preflight.OperatorStopSource
        return repository_operator_stop(repository=_REPOSITORY, gh_cli=str(self.gh))


class _WithFakeVariables(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory(prefix="aria-stop-variables-")
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.variables = _FakeRepositoryVariables(self.root)
        # The job-start copy stays empty for the whole test: only the live
        # variable can carry the stop.
        env = patch.dict(os.environ, _stop_env(""), clear=True)
        env.start()
        self.addCleanup(env.stop)

    def tearDown(self) -> None:
        self.assertEqual(os.environ.get("ARIA_STOP"), "", "the process environment never carried the stop")


class PreflightReadsAnyNonEmptyStopTests(unittest.TestCase):
    """The job-start copy: the preflight kill switch reads any non-empty value."""

    def _preflight(self, value: str | None):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, _stop_env(value), clear=True):
            contract = WORKFLOW_CONTRACTS["aria-merge-runner"]
            workflow = Path(tmp) / contract.workflow_file
            workflow.parent.mkdir(parents=True, exist_ok=True)
            workflow.write_text("name: unit\njobs: {}\n", encoding="utf-8")
            return verify_workflow_preflight(
                workflow_id="aria-merge-runner", job_id="merge", profile="standard", workspace_root=tmp,
                allowed_write_roots=[".aria-state-store"], path_allowlist=[".aria-state-store"],
                network_policy=["github_api"], network_enforcement_evidence="unit test",
                token_provenance="github_app:installation", audit_reason="unit test",
            )

    def test_an_operator_stop_in_any_words_engages_the_kill_switch(self) -> None:
        verdict = self._preflight(_OPERATOR_STOP)
        self.assertTrue(verdict.kill_switch_active, "a non-empty ARIA_STOP is a stop, whatever it says")
        self.assertIn("global_kill_switch", verdict.failure_classes)

    def test_an_empty_variable_is_no_stop(self) -> None:
        # An unset repository variable reaches the job as the empty string.
        for value in ("", None):
            with self.subTest(value=value):
                self.assertFalse(self._preflight(value).kill_switch_active)


class LiveReaderTests(_WithFakeVariables):
    """``repository_operator_stop`` reads the repository variable itself and fails closed."""

    def test_an_unset_variable_reads_empty_and_is_no_stop(self) -> None:
        self.assertEqual(self.variables.source()(), "")
        self.assertEqual(self.variables.requests(),
                         [f"repos/{_REPOSITORY}/actions/variables?per_page=30&page=1"])
        self.assertFalse(operator_stop_engaged(self.variables.source()))

    def test_a_set_variable_reads_its_value_and_is_a_stop(self) -> None:
        self.variables.set(variables={"SOME_OTHER": "x", "ARIA_STOP": _OPERATOR_STOP})
        self.assertEqual(self.variables.source()(), _OPERATOR_STOP)
        self.assertTrue(operator_stop_engaged(self.variables.source()))

    def test_an_empty_value_is_no_stop(self) -> None:
        self.variables.set(variables={"ARIA_STOP": ""})
        self.assertFalse(operator_stop_engaged(self.variables.source()))

    def test_the_variable_is_found_on_any_page(self) -> None:
        names = {f"V{index:03d}": "x" for index in range(65)}
        self.variables.set(variables={**names, "ARIA_STOP": _OPERATOR_STOP})
        self.assertEqual(self.variables.source()(), _OPERATOR_STOP)
        self.assertEqual(len(self.variables.requests()), 3)
        self.variables.set(variables=names)
        self.assertEqual(self.variables.source()(), "", "absent from every page: unset")

    def test_an_unreadable_variable_is_a_stop_and_never_echoes_a_value(self) -> None:
        failures = {
            "gh_refused": {"exit": 1},
            "not_json": {"body": "<html>rate limited</html>"},
            "not_a_listing": {"body": json.dumps({"message": "Not Found"})},
            "a_value_that_is_not_text": {"body": json.dumps(
                {"total_count": 1, "variables": [{"name": "ARIA_STOP", "value": None}]})},
        }
        for name, state in failures.items():
            with self.subTest(failure=name):
                self.variables.set(**state)
                with self.assertRaises(OperatorStopUnreadable) as raised:
                    self.variables.source()()
                self.assertIn(OPERATOR_STOP_UNREADABLE, str(raised.exception))
                self.assertTrue(operator_stop_engaged(self.variables.source()))
        missing = repository_operator_stop(repository=_REPOSITORY, gh_cli=str(self.root / "no-such-gh"))
        self.assertTrue(operator_stop_engaged(missing), "no gh at all is unreadable, so a stop")
        self.assertTrue(operator_stop_engaged(None), "no source is a stop")


class KernelChangeAdmissionStopsTests(_WithFakeVariables):
    def setUp(self) -> None:
        super().setUp()
        self.tools = ensure_tools_dir(self.root / "aria-tools")
        self.approvals: list[str] = []

        def approved(ref, *, surface, scope, base_dir):  # noqa: ANN001 — require_operator_act's shape
            self.approvals.append(surface)
            return {"approved": True, "ref": ref}

        approval = patch("aria_kernel.operator_approval.require_operator_act", side_effect=approved)
        approval.start()
        self.addCleanup(approval.stop)

    def _request(self, source) -> dict:  # noqa: ANN001 — an OperatorStopSource or None
        return request_kernel_change(
            changed_files=["aria-kernel/aria_kernel/self_revert.py"],
            operator_approval_ref="https://github.com/o/r/issues/1#issuecomment-1",
            validation_refs=[f"ref:{name}" for name in REQUIRED_KERNEL_VALIDATIONS],
            full_shadow_cycle_ref="shadow:1", rollback_plan="revert the merge commit", base_dir=self.tools,
            operator_stop=source,
        )

    def _rows(self) -> list[dict]:
        path = self.tools / "kernel-change" / "requests.jsonl"
        return load_declared_jsonl(path, expected_surface="kernel_change_requests") if path.exists() else []

    def test_a_stopped_aria_admits_no_kernel_change(self) -> None:
        self.variables.set(variables={"ARIA_STOP": _OPERATOR_STOP})
        with self.assertRaises(GovernanceError) as raised:
            self._request(self.variables.source())
        self.assertIn(OPERATOR_STOP_REFUSAL, str(raised.exception))
        self.assertNotIn(_OPERATOR_STOP, str(raised.exception), "the operator's text is never echoed")
        self.assertEqual(self.approvals, [], "the stop is read before the operator approval")
        self.assertEqual(self._rows(), [], "a refused admission writes nothing")

    def test_an_unreadable_stop_or_no_source_admits_nothing(self) -> None:
        self.variables.set(exit=1)
        for name, source in (("unreadable", self.variables.source()), ("no_source", None)):
            with self.subTest(source=name):
                with self.assertRaises(GovernanceError) as raised:
                    self._request(source)
                self.assertIn(OPERATOR_STOP_UNREADABLE, str(raised.exception))
        self.assertEqual(self.approvals, [])
        self.assertEqual(self._rows(), [])

    def test_without_a_stop_the_admission_proceeds(self) -> None:
        row = self._request(self.variables.source())
        self.assertEqual(row["decision"], "authorized_for_pr_only")
        self.assertEqual(self.approvals, ["kernel_change_request"])


class _Adapter:
    def __init__(self) -> None:
        self.calls: list[str] = []
        # What the provider answers the merge call: merged, or queued for the
        # merge queue (``{"enqueued": True}``).
        self.merge_answer: dict = {"merged": True}

    def get_open_issues(self, *, labels):  # noqa: ANN001 — the adapter Protocol's shape
        return {"readable": True, "issues": []}

    def get_pr(self, pr_number: int) -> dict:
        return {
            "number": pr_number, "state": "OPEN", "repository": _REPOSITORY,
            "base_branch": "main", "head_ref": "feat/x", "head_sha": _HEAD,
        }

    def merge_pr(self, pr_number: int, **kwargs) -> dict:  # noqa: ANN003 — merge options
        self.calls.append("merge")
        return dict(self.merge_answer)

    def get_pr_diff(self, pr_number: int) -> tuple[str | None, str | None]:
        return None, "fixture_pr_diff_absent"


def _passing_gates() -> list:
    """Every merge gate passes, so the only thing between the PR and the merge call is the stop."""
    return [
        patch("aria_kernel.merge_authority.assert_merge_authority_available", return_value="autonomous"),
        patch("aria_kernel.merge_authority.assert_merge_authorized", return_value="autonomous"),
        patch("aria_kernel.merge_authority.assert_self_merge_not_frozen", return_value=None),
        patch("aria_kernel.merge_authority.record_risk_decision_for_pr",
              return_value={"valid": True, "lane": "L1", "policy_hash": "ph"}),
        patch("aria_kernel.merge_authority.assert_autonomy_unlocked", return_value=SimpleNamespace(counts={})),
        patch("aria_kernel.merge_authority.verify_enterprise_readiness",
              return_value=SimpleNamespace(valid=True, failure_classes=(), reasons=())),
        patch("aria_kernel.merge_authority.verify_runner_attestation", return_value={}),
        patch("aria_kernel.merge_authority.verify_rollback_bundle", return_value={}),
        patch("aria_kernel.merge_authority.ensure_pre_merge_incident_row", return_value={"ledger_hash": "x"}),
        patch("aria_kernel.merge_authority._merge_if_green_with_executor",
              return_value={"decision": "proceed", "eligible": True, "head_sha": _HEAD, "pr_number": 7}),
        patch("aria_kernel.merge_authority._evaluate_triple_gate", return_value={"passed": True, "change_id": "c"}),
        patch("aria_kernel.merge_authority.collect_github_snapshot", return_value={}),
        patch("aria_kernel.merge_authority.evaluate_auto_merge", return_value={"eligible": True, "head_sha": _HEAD}),
        patch("aria_kernel.merge_authority.run_hard_fail_checks",
              return_value=SimpleNamespace(passed=True, failures=(), results=())),
    ]


class MergeAuthorityStopsTests(_WithFakeVariables):
    def setUp(self) -> None:
        super().setUp()
        self.tools = ensure_tools_dir(self.root / "aria-tools")
        for item in _passing_gates():
            item.start()
            self.addCleanup(item.stop)
        self.adapter = _Adapter()

    def _publisher(self, *, stop_on_publish: bool = False, published: bool = True):  # noqa: ANN202
        def publish(intent: dict) -> dict:
            self.adapter.calls.append("publish")
            if stop_on_publish:
                # The operator sets the repository variable while the intent
                # is being published — the last act before the merge call.
                self.variables.set(variables={"SOME_OTHER": "x", "ARIA_STOP": _OPERATOR_STOP})
            return {"published": published, "reason": None if published else "fixture_publish_lost"}
        return publish

    def _merge(self, publisher, source) -> dict:  # noqa: ANN001 — intent publisher, stop source
        return merge_pr_if_ready(adapter=self.adapter, pr_number=7, base_dir=self.tools,
                                 readiness_claim_id="claim:7:aaaaaaaaaaaa", intent_publisher=publisher,
                                 operator_stop=source)

    def _assert_blocked(self, result: dict, reason: str) -> None:
        self.assertEqual(result.get("decision"), "blocked", result)
        self.assertFalse(result.get("eligible"))
        self.assertEqual(result.get("reasons"), [reason], result)
        self.assertNotIn(_OPERATOR_STOP, json.dumps(result), "the operator's text is never echoed")

    def _merged_by_hand(self) -> None:
        """The operator merges PR 7 at the same head; the post-merge reconciler records it."""
        append_declared_jsonl(merge_outcomes_path(self.tools), {
            "schema_version": 1, "recorded_at": "2026-10-23T12:00:00Z", "cycle_id": "c", "pr_number": 7,
            "head_ref": "feat/x", "head_sha": _HEAD, "merge_sha": "f" * 40, "red_jobs": ["ci"],
            "pending_jobs": [], "status": "red"}, expected_surface="merge_outcomes")

    def test_the_control_merges_when_no_stop_is_set(self) -> None:
        result = self._merge(self._publisher(), self.variables.source())
        self.assertEqual(self.adapter.calls, ["publish", "merge"])
        self.assertEqual(result["decision"], "merged")
        self._merged_by_hand()
        self.assertIn(7, _aria_merged_prs(self.tools), "a merge ARIA's lane made is ARIA's")

    def test_a_stop_set_at_the_merge_moment_stops_the_merge_call(self) -> None:
        # The merge-moment fixture: every gate has passed, the lease is held
        # and the merge intent is being published when the operator sets
        # vars.ARIA_STOP. The job-start copy (os.environ) stays empty.
        result = self._merge(self._publisher(stop_on_publish=True), self.variables.source())
        self.assertEqual(self.adapter.calls, ["publish"], "the live stop is read right before the merge call")
        self._assert_blocked(result, OPERATOR_STOP_REFUSAL)
        self.assertEqual(result["stage"], "operator_stop")

    def test_a_stop_already_set_when_the_lane_runs_merges_nothing(self) -> None:
        self.variables.set(variables={"ARIA_STOP": _OPERATOR_STOP})
        result = self._merge(self._publisher(), self.variables.source())
        self.assertNotIn("merge", self.adapter.calls, "a stopped ARIA makes no merge call")
        self._assert_blocked(result, OPERATOR_STOP_REFUSAL)

    def test_an_unreadable_stop_or_no_source_makes_no_merge_call(self) -> None:
        self.variables.set(exit=1)
        for name, source in (("unreadable", self.variables.source()), ("no_source", None)):
            with self.subTest(source=name):
                self.adapter.calls.clear()
                result = self._merge(self._publisher(), source)
                self.assertEqual(self.adapter.calls, ["publish"])
                self._assert_blocked(result, OPERATOR_STOP_UNREADABLE)

    def test_a_human_merge_after_the_merge_moment_stop_is_not_arias(self) -> None:
        # B0 corrective R2: the intent row is on the published record, but the
        # operator_stop row states no merge call was made for (7, head).
        self._merge(self._publisher(stop_on_publish=True), self.variables.source())
        self._merged_by_hand()
        self.assertNotIn(7, _aria_merged_prs(self.tools), "a human merge is never attributed to ARIA")

    def test_a_human_merge_after_an_unpublished_intent_is_not_arias(self) -> None:
        result = self._merge(self._publisher(published=False), self.variables.source())
        self.assertEqual(self.adapter.calls, ["publish"])
        self.assertEqual(result["stage"], "merge_intent")
        self._merged_by_hand()
        self.assertNotIn(7, _aria_merged_prs(self.tools))

    def test_arias_own_retry_after_a_cleared_stop_stays_arias(self) -> None:
        # The no-call statement withdraws the intent it follows, not a later
        # one: the operator clears the stop, ARIA's lane retries the same
        # head, the queue takes it and merges it — that merge is ARIA's.
        self._merge(self._publisher(stop_on_publish=True), self.variables.source())
        self.variables.set(variables={"SOME_OTHER": "x"})
        self.adapter.calls.clear()
        self.adapter.merge_answer = {"merged": False, "enqueued": True}
        result = self._merge(self._publisher(), self.variables.source())
        self.assertEqual(self.adapter.calls, ["publish", "merge"])
        self.assertEqual(result["decision"], "enqueued")
        self._merged_by_hand()
        self.assertIn(7, _aria_merged_prs(self.tools), "ARIA's later merge call at that head is ARIA's")

    def test_an_earlier_enqueue_stays_arias_when_a_later_attempt_is_stopped(self) -> None:
        # 'enqueued' keeps its meaning: the queue may still merge what ARIA's
        # earlier call enqueued, whatever a later stopped attempt says.
        self.adapter.merge_answer = {"merged": False, "enqueued": True}
        self.assertEqual(self._merge(self._publisher(), self.variables.source())["decision"], "enqueued")
        self.adapter.calls.clear()
        self._merge(self._publisher(stop_on_publish=True), self.variables.source())
        self.assertEqual(self.adapter.calls, ["publish"])
        self._merged_by_hand()
        self.assertIn(7, _aria_merged_prs(self.tools), "the queue merged ARIA's earlier enqueue")


if __name__ == "__main__":
    unittest.main()
