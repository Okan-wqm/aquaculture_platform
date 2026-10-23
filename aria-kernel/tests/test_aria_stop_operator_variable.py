"""PLAN-v2 §2 'Durdurma' / B0 — the operator's ``vars.ARIA_STOP`` stops ARIA; non-empty means stop.

ARIA-HIGH-765: ARIA's stop was a file in its own writable store that the
kernel itself writes, no merge-path module checked it, and the merge runner
wired no operator-owned variable into its preflight kill switch. B0 makes the
operator's repository variable the stop: every ARIA workflow passes it to the
kernel as the ``ARIA_STOP`` environment variable (pinned in
``tests/invariants/test_aria_stop_every_workflow.py``), and the kernel
refuses

* at the workflow preflight, for ANY non-empty value — the operator writes
  what they like into the variable ("halt", a reason, a ticket id); the
  preflight read ``ARIA_STOP`` as a truthy word (1/true/yes/on), so a stop
  spelled any other way did not stop;
* at kernel_change admission (``self_modification.request_kernel_change``),
  before the operator approval is read and before any row is written;
* in ``merge_authority.merge_pr_if_ready``: at entry, and again right before
  the merge call — the merge-moment fixture sets the stop after every gate
  passed and the merge intent was published, and the merge call must not
  happen.

The ``ARIA_STOP`` FILE stays the kernel's own deadline stop; its absence is
never a clearing authority over the operator's variable.

All red at the branch base by assertion: the preflight ignores "halt", the
admission and the merge authority never read the variable.
"""
from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from aria_kernel.ledger import load_declared_jsonl
from aria_kernel.merge_authority import merge_pr_if_ready
from aria_kernel.preflight import verify_workflow_preflight
from aria_kernel.self_modification import REQUIRED_KERNEL_VALIDATIONS, request_kernel_change
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir
from aria_kernel.workflow_contracts import WORKFLOW_CONTRACTS

_HEAD = "a" * 40
# What an operator types into the repository variable: not a truthy word.
_OPERATOR_STOP = "halt: board drill 2026-10-23"


def _stop_env(value: str | None) -> dict[str, str]:
    """The process environment with ARIA_STOP as given (None: unset) and no other kill switch."""
    env = {k: v for k, v in os.environ.items() if k not in ("ARIA_STOP", "ARIA_GLOBAL_KILL_SWITCH")}
    if value is not None:
        env["ARIA_STOP"] = value
    return env


class PreflightReadsAnyNonEmptyStopTests(unittest.TestCase):
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


class KernelChangeAdmissionStopsTests(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory(prefix="aria-stop-kernel-change-")
        self.addCleanup(tmp.cleanup)
        self.tools = ensure_tools_dir(Path(tmp.name) / "aria-tools")
        self.approvals: list[str] = []

        def approved(ref, *, surface, scope, base_dir):  # noqa: ANN001 — require_operator_act's shape
            self.approvals.append(surface)
            return {"approved": True, "ref": ref}

        approval = patch("aria_kernel.operator_approval.require_operator_act", side_effect=approved)
        approval.start()
        self.addCleanup(approval.stop)

    def _request(self) -> dict:
        return request_kernel_change(
            changed_files=["aria-kernel/aria_kernel/self_revert.py"],
            operator_approval_ref="https://github.com/o/r/issues/1#issuecomment-1",
            validation_refs=[f"ref:{name}" for name in REQUIRED_KERNEL_VALIDATIONS],
            full_shadow_cycle_ref="shadow:1", rollback_plan="revert the merge commit", base_dir=self.tools,
        )

    def _rows(self) -> list[dict]:
        path = self.tools / "kernel-change" / "requests.jsonl"
        return load_declared_jsonl(path, expected_surface="kernel_change_requests") if path.exists() else []

    def test_a_stopped_aria_admits_no_kernel_change(self) -> None:
        with patch.dict(os.environ, _stop_env(_OPERATOR_STOP), clear=True):
            with self.assertRaises(GovernanceError) as raised:
                self._request()
        self.assertIn("aria_stop", str(raised.exception))
        self.assertEqual(self.approvals, [], "the stop is read before the operator approval")
        self.assertEqual(self._rows(), [], "a refused admission writes nothing")

    def test_without_a_stop_the_admission_proceeds(self) -> None:
        with patch.dict(os.environ, _stop_env(""), clear=True):
            row = self._request()
        self.assertEqual(row["decision"], "authorized_for_pr_only")
        self.assertEqual(self.approvals, ["kernel_change_request"])


class _Adapter:
    def __init__(self) -> None:
        self.calls: list[str] = []

    def get_open_issues(self, *, labels):  # noqa: ANN001 — the adapter Protocol's shape
        return {"readable": True, "issues": []}

    def get_pr(self, pr_number: int) -> dict:
        return {
            "number": pr_number, "state": "OPEN", "repository": "okan/aqua",
            "base_branch": "main", "head_ref": "feat/x", "head_sha": _HEAD,
        }

    def merge_pr(self, pr_number: int, **kwargs) -> dict:  # noqa: ANN003 — merge options
        self.calls.append("merge")
        return {"merged": True}

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


class MergeAuthorityStopsTests(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory(prefix="aria-stop-merge-")
        self.addCleanup(tmp.cleanup)
        self.tools = ensure_tools_dir(Path(tmp.name) / "aria-tools")
        for item in _passing_gates():
            item.start()
            self.addCleanup(item.stop)
        env = patch.dict(os.environ, _stop_env(""), clear=True)
        env.start()
        self.addCleanup(env.stop)

    def _merge(self, adapter: _Adapter, publisher) -> dict | None:  # noqa: ANN001 — intent publisher
        try:
            return merge_pr_if_ready(adapter=adapter, pr_number=7, base_dir=self.tools,
                                     readiness_claim_id="claim:7:aaaaaaaaaaaa", intent_publisher=publisher)
        except GovernanceError as exc:
            self.assertIn("aria_stop", str(exc))
            return None

    def _assert_stopped_by_name(self, result: dict | None) -> None:
        # Refused by name either way: a GovernanceError naming aria_stop
        # (checked in _merge), or a blocked decision whose reasons name it.
        if result is not None:
            self.assertEqual(result.get("decision"), "blocked", result)
            self.assertFalse(result.get("eligible"))
            self.assertTrue(any("aria_stop" in str(reason) for reason in result.get("reasons") or []), result)

    def test_the_control_merges_when_no_stop_is_set(self) -> None:
        adapter = _Adapter()
        result = self._merge(adapter, lambda intent: (adapter.calls.append("publish"), {"published": True})[1])
        self.assertEqual(adapter.calls, ["publish", "merge"])
        self.assertEqual(result["decision"], "merged")

    def test_a_stop_set_before_the_lane_runs_merges_nothing(self) -> None:
        adapter = _Adapter()
        os.environ["ARIA_STOP"] = _OPERATOR_STOP
        result = self._merge(adapter, lambda intent: (adapter.calls.append("publish"), {"published": True})[1])
        self.assertNotIn("merge", adapter.calls, "a stopped ARIA makes no merge call")
        self._assert_stopped_by_name(result)

    def test_a_stop_set_at_the_merge_moment_stops_the_merge_call(self) -> None:
        # The merge-moment fixture: every gate has passed, the lease is held
        # and the merge intent is being published — the last act before the
        # merge call — when the operator's stop arrives.
        adapter = _Adapter()

        def publisher(intent: dict) -> dict:
            adapter.calls.append("publish")
            os.environ["ARIA_STOP"] = _OPERATOR_STOP
            return {"published": True}

        result = self._merge(adapter, publisher)
        self.assertEqual(adapter.calls, ["publish"], "the stop is read right before the merge call")
        self._assert_stopped_by_name(result)


if __name__ == "__main__":
    unittest.main()
