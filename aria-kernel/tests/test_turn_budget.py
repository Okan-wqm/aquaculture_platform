"""cycle_and_turn_budget_cap — the seventh pre-merge predicate, built.

Policy §14 named a per-cycle USD reservation cap and a per-implementer-turn
cap of N=10 Edit+Write+Bash turns; the registry bound the predicate to
``_not_implemented``. ORPHAN-HIGH-472 retired the USD dispatch gate for wall
clock and ARIA-HIGH-074/079 made notional dollars telemetry under the
managed-subscription policy, so the cap that binds is (a) the run-scoped job
deadline at every turn boundary and (b) N=10 admitted turns per implementer
request. These tests pin:

* the hook counter: ten budgeted turns are admitted, the eleventh is refused
  with ``implementer_turn_budget_exhausted`` at the boundary (exit 2, the
  CLI's deny JSON), every budgeted verdict carries its observation, a
  policy-denied turn never counts, and an unbudgeted spawn is never refused;
* the cycle cap: a job deadline inside the close-out margin refuses the next
  turn with ``cycle_budget_exhausted`` even with turns to spare, and the
  phase loop (``cycle._job_deadline_reached``) reads the same predicate;
* the spawn settings compile ``--turn-budget 10`` for write-scope profiles
  only, and the CLI verb threads it into the hook;
* the predicate passes on evidence showing both caps respected and fails,
  by name, on a refusal, on more admitted turns than the cap, on absent or
  malformed evidence, and on an unbound implementation.
"""
from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import time
import unittest
from contextlib import redirect_stdout
from dataclasses import replace
from pathlib import Path
from unittest import mock

from aria_kernel import cycle, hooks, turn_budget
from aria_kernel.claude_settings import _PRE_TOOL_MATCHER, build_settings
from aria_kernel.implementation_safety import (
    GATE_PRE_MERGE,
    HardFailContext,
    _PreMergeEvidence,
    run_hard_fail_checks,
)
from aria_kernel.ledger import load_declared_jsonl
from aria_kernel.runtime_profiles import load_runtime_profiles, profile_by_id
from aria_kernel.tool_registry import ensure_tools_dir

_CAP = turn_budget.IMPLEMENTER_TURN_BUDGET
_DEADLINE = turn_budget.JOB_DEADLINE_EPOCH_ENV


def _payload(tool: str, tool_use_id: str = "toolu", **tool_input) -> dict:
    return {
        "session_id": "sess-1", "tool_use_id": tool_use_id, "hook_event_name": "PreToolUse",
        "tool_name": tool, "tool_input": tool_input, "cwd": "/w",
    }


def _rows(tools: Path) -> list[dict]:
    return load_declared_jsonl(
        tools.joinpath(*hooks.HOOK_DECISIONS_RELPATH), expected_surface=hooks.HOOK_DECISIONS_SURFACE,
    )


class OwnerVocabulary(unittest.TestCase):
    def test_the_budgeted_set_is_the_policed_set_is_edit_write_bash(self) -> None:
        self.assertEqual(_CAP, 10)
        self.assertEqual(set(_PRE_TOOL_MATCHER.split("|")), set(turn_budget.BUDGETED_TOOL_NAMES))
        self.assertEqual(set(turn_budget.BUDGETED_TOOL_NAMES), hooks.WRITE_TOOL_NAMES | {"Bash"})
        self.assertEqual(
            turn_budget.BUDGET_REFUSAL_REASONS,
            {"cycle_budget_exhausted", "implementer_turn_budget_exhausted"},
        )

    def test_only_write_scope_profiles_are_budgeted(self) -> None:
        budgeted = {name for name, profile in load_runtime_profiles().items()
                    if turn_budget.turn_budget_for(profile) is not None}
        with_scope = {name for name, profile in load_runtime_profiles().items() if profile.write_scope}
        self.assertEqual(budgeted, with_scope)
        self.assertIn("implementer", budgeted)
        self.assertNotIn("validator", budgeted)
        self.assertNotIn("judge_opus", budgeted)
        self.assertEqual(turn_budget.turn_budget_for(profile_by_id("implementer")), _CAP)

    def test_deadline_parsing_and_margin(self) -> None:
        self.assertIsNone(turn_budget.parse_deadline_epoch(None))
        self.assertIsNone(turn_budget.parse_deadline_epoch(""))
        self.assertIsNone(turn_budget.parse_deadline_epoch("garbage"))
        self.assertEqual(turn_budget.parse_deadline_epoch("1000.5"), 1000.5)
        margin = turn_budget.JOB_DEADLINE_CLOSE_OUT_MARGIN_SECONDS
        self.assertFalse(turn_budget.job_deadline_reached(now=0.0, deadline_epoch=None))
        self.assertFalse(turn_budget.job_deadline_reached(now=1000 - margin - 1, deadline_epoch=1000))
        self.assertTrue(turn_budget.job_deadline_reached(now=1000 - margin, deadline_epoch=1000))
        self.assertTrue(turn_budget.job_deadline_reached(now=5000, deadline_epoch=1000))

    def test_time_refuses_before_turns_and_the_reason_class_is_the_prefix(self) -> None:
        both = turn_budget.TurnBudgetObservation(
            cap=_CAP, used_before=_CAP, deadline_epoch=1000.0, remaining_seconds=10.0, margin_seconds=120,
        )
        reason = turn_budget.turn_budget_refusal(both, now=990.0)
        self.assertEqual(turn_budget.refusal_class(reason), "cycle_budget_exhausted")
        turns_only = replace(both, deadline_epoch=None, remaining_seconds=None)
        reason = turn_budget.turn_budget_refusal(turns_only, now=990.0)
        self.assertEqual(reason, f"implementer_turn_budget_exhausted:used={_CAP}:cap={_CAP}")
        self.assertIsNone(turn_budget.turn_budget_refusal(replace(turns_only, used_before=_CAP - 1), now=0.0))
        self.assertIsNone(turn_budget.refusal_class(None))

    def test_evidence_reduction_names_absence_and_malformation(self) -> None:
        self.assertEqual(
            turn_budget.turn_budget_evidence([], request_id="AIR-1"),
            {"turn_budget_unavailable_reason": "native_turn_budget_evidence_unavailable"},
        )
        bare = [{"request_id": "AIR-1", "tool_name": "Bash", "decision": "allow", "reason": "x", "ledger_hash": "h1"}]
        self.assertEqual(
            turn_budget.turn_budget_evidence(bare, request_id="AIR-1")["turn_budget_unavailable_reason"],
            "native_turn_budget_observation_unavailable",
        )
        other_cap = [dict(bare[0], turn_budget={"cap": 3, "used_before": 0})]
        self.assertEqual(
            turn_budget.turn_budget_evidence(other_cap, request_id="AIR-1")["turn_budget_unavailable_reason"],
            "native_turn_budget_cap_mismatch",
        )
        rows = [
            dict(bare[0], turn_budget={"cap": _CAP, "used_before": 0}),
            {"request_id": "AIR-1", "tool_name": "Edit", "decision": "deny", "reason": "readonly_path:x",
             "ledger_hash": "h2", "turn_budget": {"cap": _CAP, "used_before": 1}},
            {"request_id": "AIR-1", "tool_name": "checkpoint", "decision": "allow",
             "reason": "checkpoint_skipped:OSError", "ledger_hash": "h3"},
            {"request_id": "AIR-2", "tool_name": "Bash", "decision": "allow", "reason": "x", "ledger_hash": "h4"},
            {"request_id": "AIR-1", "tool_name": "Write", "decision": "allow", "reason": "write_inside_workspace",
             "ledger_hash": "h5", "turn_budget": {"cap": _CAP, "used_before": 1}},
        ]
        self.assertEqual(turn_budget.turn_budget_evidence(rows, request_id="AIR-1"), {
            "turn_budget_cap": _CAP, "turn_budget_used": 2,
            "turn_budget_refusal_reason": None, "turn_budget_ledger_tip": "h5",
        })
        refused = rows + [{"request_id": "AIR-1", "tool_name": "Bash", "decision": "deny",
                           "reason": f"implementer_turn_budget_exhausted:used={_CAP}:cap={_CAP}",
                           "ledger_hash": "h6", "turn_budget": {"cap": _CAP, "used_before": _CAP}}]
        evidence = turn_budget.turn_budget_evidence(refused, request_id="AIR-1")
        self.assertEqual(turn_budget.refusal_class(evidence["turn_budget_refusal_reason"]),
                         "implementer_turn_budget_exhausted")
        self.assertEqual(evidence["turn_budget_ledger_tip"], "h6")


class HookCounterRefusesTheEleventhTurn(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name).resolve()
        (self.root / "apps").mkdir()
        self.tools = self.root / "aria-tools"
        ensure_tools_dir(self.tools)
        self._env = mock.patch.dict(os.environ, {}, clear=False)
        self._env.start()
        os.environ.pop(_DEADLINE, None)

    def tearDown(self) -> None:
        self._env.stop()
        self._tmp.cleanup()

    def _pre_tool(self, payload: dict, *, request_id: str = "AIR-1", turn_budget: int | None = _CAP) -> tuple[int, str]:
        return hooks.run_hook("pre-tool", payload, base_dir=self.tools, workspace_root=self.root,
                              request_id=request_id, turn_budget=turn_budget)

    def test_ten_admitted_the_eleventh_refused_by_name_at_the_boundary(self) -> None:
        for turn in range(_CAP):
            tool = ("Bash", {"command": "git status --porcelain"}) if turn % 2 else \
                   ("Edit", {"file_path": str(self.root / "apps" / f"f{turn}.ts")})
            code, out = self._pre_tool(_payload(tool[0], f"toolu_{turn}", **tool[1]))
            self.assertEqual(code, hooks.EXIT_ALLOW, (turn, out))
        code, out = self._pre_tool(_payload("Write", "toolu_11", file_path=str(self.root / "apps" / "late.ts")))
        self.assertEqual(code, hooks.EXIT_BLOCK)
        decision = json.loads(out)["hookSpecificOutput"]
        self.assertEqual(decision["permissionDecision"], "deny")
        self.assertEqual(decision["permissionDecisionReason"],
                         f"implementer_turn_budget_exhausted:used={_CAP}:cap={_CAP}")
        # A twelfth attempt is refused too: nothing was consumed by the refusal.
        code, out = self._pre_tool(_payload("Bash", "toolu_12", command="git status"))
        self.assertEqual(code, hooks.EXIT_BLOCK)
        self.assertIn("implementer_turn_budget_exhausted", out)
        rows = _rows(self.tools)
        # The pre-write checkpoint notes (tool_name "checkpoint", Faz 032c) sit
        # between the verdicts; they are neither budgeted nor counted.
        notes = [row for row in rows if row["tool_name"] == "checkpoint"]
        self.assertTrue(notes and all("turn_budget" not in row for row in notes))
        budgeted = [row for row in rows if row["tool_name"] in turn_budget.BUDGETED_TOOL_NAMES]
        self.assertEqual([row["decision"] for row in budgeted], ["allow"] * _CAP + ["deny", "deny"])
        self.assertEqual([row["turn_budget"]["used_before"] for row in budgeted], list(range(_CAP)) + [_CAP, _CAP])
        self.assertTrue(all(row["turn_budget"]["cap"] == _CAP for row in budgeted))
        self.assertTrue(all(row["turn_budget"]["deadline_epoch"] is None for row in budgeted))
        self.assertEqual(turn_budget.budgeted_turns_used(rows, request_id="AIR-1"), _CAP)
        evidence = turn_budget.turn_budget_evidence(rows, request_id="AIR-1")
        self.assertEqual(evidence["turn_budget_used"], _CAP)
        self.assertEqual(turn_budget.refusal_class(evidence["turn_budget_refusal_reason"]),
                         "implementer_turn_budget_exhausted")

    def test_a_policy_denied_turn_never_consumes_and_carries_its_observation(self) -> None:
        code, _ = self._pre_tool(_payload("Bash", "t1", command="curl https://x"))
        self.assertEqual(code, hooks.EXIT_BLOCK)
        code, _ = self._pre_tool(_payload("Edit", "t2", file_path="/etc/passwd"))
        self.assertEqual(code, hooks.EXIT_BLOCK)
        code, _ = self._pre_tool(_payload("Bash", "t3", command="git status"))
        self.assertEqual(code, hooks.EXIT_ALLOW)
        rows = _rows(self.tools)
        self.assertEqual([row["decision"] for row in rows], ["deny", "deny", "allow"])
        self.assertTrue(rows[0]["reason"].startswith("command_policy_deny:"))
        self.assertTrue(rows[1]["reason"].startswith("path_escape:"))
        self.assertEqual([row["turn_budget"]["used_before"] for row in rows], [0, 0, 0])
        self.assertEqual(turn_budget.budgeted_turns_used(rows, request_id="AIR-1"), 1)

    def test_the_count_is_per_request_and_an_unbudgeted_spawn_is_never_refused(self) -> None:
        for turn in range(_CAP):
            self._pre_tool(_payload("Bash", f"a{turn}", command="git status"))
        code, _ = self._pre_tool(_payload("Bash", "b0", command="git status"), request_id="AIR-2")
        self.assertEqual(code, hooks.EXIT_ALLOW)
        code, _ = self._pre_tool(_payload("Bash", "a10", command="git status"))
        self.assertEqual(code, hooks.EXIT_BLOCK)
        for turn in range(_CAP + 1):
            code, _ = self._pre_tool(_payload("Bash", f"u{turn}", command="git status"),
                                     request_id="AIR-unbudgeted", turn_budget=None)
            self.assertEqual(code, hooks.EXIT_ALLOW)
        unbudgeted = [row for row in _rows(self.tools) if row["request_id"] == "AIR-unbudgeted"]
        self.assertEqual(len(unbudgeted), _CAP + 1)
        self.assertTrue(all("turn_budget" not in row for row in unbudgeted))
        self.assertEqual(
            turn_budget.turn_budget_evidence(_rows(self.tools), request_id="AIR-unbudgeted")
            ["turn_budget_unavailable_reason"],
            "native_turn_budget_observation_unavailable",
        )

    def test_a_job_deadline_inside_the_margin_refuses_the_next_turn_for_time(self) -> None:
        os.environ[_DEADLINE] = str(time.time() + 1000)
        code, _ = self._pre_tool(_payload("Bash", "t1", command="git status"))
        self.assertEqual(code, hooks.EXIT_ALLOW)
        row = _rows(self.tools)[-1]
        self.assertAlmostEqual(row["turn_budget"]["deadline_epoch"], float(os.environ[_DEADLINE]))
        self.assertGreater(row["turn_budget"]["remaining_seconds"], 800)
        self.assertEqual(row["turn_budget"]["margin_seconds"], turn_budget.JOB_DEADLINE_CLOSE_OUT_MARGIN_SECONDS)
        os.environ[_DEADLINE] = str(time.time() + 30)
        code, out = self._pre_tool(_payload("Edit", "t2", file_path=str(self.root / "apps" / "x.ts")))
        self.assertEqual(code, hooks.EXIT_BLOCK)
        reason = json.loads(out)["hookSpecificOutput"]["permissionDecisionReason"]
        self.assertEqual(turn_budget.refusal_class(reason), "cycle_budget_exhausted")
        self.assertIn(":margin=120s", reason)
        evidence = turn_budget.turn_budget_evidence(_rows(self.tools), request_id="AIR-1")
        self.assertEqual(turn_budget.refusal_class(evidence["turn_budget_refusal_reason"]), "cycle_budget_exhausted")
        self.assertEqual(evidence["turn_budget_used"], 1)
        # The phase loop reads the same predicate: it now skips remaining phases.
        self.assertTrue(cycle._job_deadline_reached())
        os.environ[_DEADLINE] = str(time.time() + 1000)
        self.assertFalse(cycle._job_deadline_reached())
        os.environ[_DEADLINE] = "garbage"
        self.assertFalse(cycle._job_deadline_reached())
        code, _ = self._pre_tool(_payload("Bash", "t3", command="git status"))
        self.assertEqual(code, hooks.EXIT_ALLOW, "a malformed deadline is not a deadline for the hook either")

    def test_an_uncountable_ledger_is_a_deny(self) -> None:
        self._pre_tool(_payload("Bash", "t1", command="git status"))
        path = self.tools.joinpath(*hooks.HOOK_DECISIONS_RELPATH)
        path.write_text(path.read_text().replace('"allow"', '"ALLOW"', 1))
        code, out = self._pre_tool(_payload("Bash", "t2", command="git status"))
        self.assertEqual(code, hooks.EXIT_BLOCK)
        self.assertIn("decision_unrecordable:", out)

    def test_the_cli_threads_the_budget_into_the_hook(self) -> None:
        from aria_kernel.cli import main

        argv = ["hook", "pre-tool", "--tools-dir", str(self.tools), "--workspace-root", str(self.root),
                "--request-id", "AIR-cli", "--turn-budget", str(_CAP)]
        for turn in range(_CAP + 1):
            payload = json.dumps(_payload("Bash", f"c{turn}", command="git status"))
            buf = io.StringIO()
            with mock.patch.object(sys, "stdin", io.StringIO(payload)), redirect_stdout(buf):
                code = main(argv)
            self.assertEqual(code, hooks.EXIT_ALLOW if turn < _CAP else hooks.EXIT_BLOCK, turn)
        self.assertEqual(json.loads(buf.getvalue())["hookSpecificOutput"]["permissionDecisionReason"],
                         f"implementer_turn_budget_exhausted:used={_CAP}:cap={_CAP}")
        rows = [row for row in _rows(self.tools) if row["request_id"] == "AIR-cli"]
        self.assertEqual(len(rows), _CAP + 1)
        self.assertTrue(all(row["turn_budget"]["cap"] == _CAP for row in rows))


class SettingsCompileTheCap(unittest.TestCase):
    def test_write_scope_profiles_get_turn_budget_on_pre_tool_only(self) -> None:
        ctx = {"python": "python3", "kernel_root": "/w/aria-kernel", "tools_dir": "/t",
               "workspace_root": "/w", "request_id": "AIR-1"}
        for budgeted in ("implementer", "worker"):
            settings = build_settings(profile_by_id(budgeted), hook_context=ctx)
            self.assertEqual(settings["_aria"]["turn_budget"], _CAP, budgeted)
            pre = settings["hooks"]["PreToolUse"][0]["hooks"][0]["command"]
            self.assertTrue(pre.endswith(f"--request-id AIR-1 --turn-budget {_CAP}"), pre)
            self.assertEqual(settings["hooks"]["PreToolUse"][0]["matcher"], "|".join(turn_budget.BUDGETED_TOOL_NAMES))
            for event in ("PostToolUse", "SessionStart", "SessionEnd", "PreCompact"):
                self.assertNotIn("--turn-budget", settings["hooks"][event][0]["hooks"][0]["command"], event)
        for unbudgeted in ("validator", "judge_opus", "planner"):
            settings = build_settings(profile_by_id(unbudgeted), hook_context=ctx)
            self.assertIsNone(settings["_aria"]["turn_budget"], unbudgeted)
            self.assertNotIn("--turn-budget", settings["hooks"]["PreToolUse"][0]["hooks"][0]["command"])


def _bound_evidence(**budget) -> _PreMergeEvidence:
    """Every native binding field the predicates require, plus the budget view."""
    sha = "b" * 40
    return _PreMergeEvidence(
        unavailable_reasons=(), repo_identity="repo", snapshot_hash="sha256:snap",
        pr_row_hash="sha256:pr", planned_row_hash="sha256:planned", committed_row_hash="sha256:committed",
        request_id="AIR-1", claim_id="claim-1", request_row_hash="sha256:req", claim_row_hash="sha256:claim",
        result_row_hash="sha256:res", implementation_event_hash="sha256:evt",
        implementation_base_sha="a" * 40, implementation_head_sha=sha, base_sha="a" * 40, head_sha=sha,
        **budget,
    )


class PredicateReadsCapturedEvidence(unittest.TestCase):
    def _verdict(self, evidence: _PreMergeEvidence | None):
        report = run_hard_fail_checks(HardFailContext(pre_merge_evidence=evidence), gate=GATE_PRE_MERGE)
        return next(result for result in report.results if result.name == "cycle_and_turn_budget_cap")

    def test_passes_when_both_caps_were_respected(self) -> None:
        verdict = self._verdict(_bound_evidence(
            turn_budget_cap=_CAP, turn_budget_used=_CAP, turn_budget_refusal_reason=None,
            turn_budget_ledger_tip="sha256:tip",
        ))
        self.assertTrue(verdict.passed, verdict.reason)
        self.assertEqual(verdict.reason, "native_cycle_and_turn_budget_respected")

    def test_fails_by_name_on_either_refusal(self) -> None:
        for reason in (f"implementer_turn_budget_exhausted:used={_CAP}:cap={_CAP}",
                       "cycle_budget_exhausted:remaining=90s:margin=120s"):
            verdict = self._verdict(_bound_evidence(
                turn_budget_cap=_CAP, turn_budget_used=3, turn_budget_refusal_reason=reason,
                turn_budget_ledger_tip="sha256:tip",
            ))
            self.assertFalse(verdict.passed)
            self.assertEqual(verdict.reason, reason.split(":", 1)[0])

    def test_fails_when_more_turns_were_admitted_than_the_cap(self) -> None:
        verdict = self._verdict(_bound_evidence(
            turn_budget_cap=_CAP, turn_budget_used=_CAP + 1, turn_budget_ledger_tip="sha256:tip",
        ))
        self.assertEqual((verdict.passed, verdict.reason), (False, "implementer_turn_budget_exceeded_unrefused"))

    def test_fails_on_absent_malformed_or_unbound_evidence(self) -> None:
        for budget, expected in (
            ({"turn_budget_unavailable_reason": "native_turn_budget_evidence_unavailable"},
             "native_turn_budget_evidence_unavailable"),
            ({"turn_budget_unavailable_reason": "native_turn_budget_cap_mismatch"}, "native_turn_budget_cap_mismatch"),
            ({}, "native_turn_budget_binding_unavailable"),
            ({"turn_budget_cap": 3, "turn_budget_used": 1, "turn_budget_ledger_tip": "sha256:tip"},
             "native_turn_budget_binding_unavailable"),
            ({"turn_budget_cap": _CAP, "turn_budget_used": 1}, "native_turn_budget_binding_unavailable"),
        ):
            verdict = self._verdict(_bound_evidence(**budget))
            self.assertEqual((verdict.passed, verdict.reason), (False, expected), budget)
        unbound = replace(_bound_evidence(turn_budget_cap=_CAP, turn_budget_used=0,
                                          turn_budget_ledger_tip="sha256:tip"), result_row_hash=None)
        self.assertEqual(self._verdict(unbound).reason, "native_implementation_binding_unavailable")
        self.assertEqual(self._verdict(None).reason, "native_implementation_binding_unavailable")


if __name__ == "__main__":
    unittest.main()
