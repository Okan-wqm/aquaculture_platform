"""ORPHAN-HIGH-737 — a refused envelope is the executor working, not failing.

Measured: drain 32221242315 processed 11 requests, 10 succeeded, one judge
returned an envelope with no verdict block. The Y5 contract caught it and
released the claim — exactly its design — and the run was still marked
FAILED, because the refusal arm returned 1 and the drain maps any non-zero
child to a red workflow. A 10-of-11 night reading RED is the honest-partial-
red class ORPHAN-716 closed for the meta-watchdog; this closes it for the
executor. The infrastructure arms stay red on purpose.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

_POC = Path(__file__).resolve().parents[2] / "tools" / "aria-poc"
_TESTS = Path(__file__).resolve().parent
for _path in (str(_POC), str(_TESTS)):
    if _path not in sys.path:
        sys.path.insert(0, _path)

import ci_executor  # noqa: E402
import ci_executor_drain  # noqa: E402

# The live-path fixture already builds a claim envelope, a mock CLI and the
# subprocess sequencer this defect needs; reusing it keeps ONE description of
# what an executor run looks like (a second copy would drift on the next
# envelope-shape change).
from test_ci_executor_live_path_smoke import (  # noqa: E402
    LivePathFetchTests,
    _make_fake_run_sequence,
)


class RefusalIsNotABuildFailure(LivePathFetchTests):
    """Reuses the live-path fixture; only the validation verdict differs."""

    def test_contract_refusal_releases_and_reports_success(self) -> None:
        fake_run = _make_fake_run_sequence(
            self.claim_response,
            self.release_response_ok,
        )
        with patch.object(
            ci_executor, "_pre_submit_validate_envelope",
            return_value=["judge_verdict:absent"],
        ):
            exit_code = self._run_main(fake_run)
        self.assertEqual(
            exit_code, 0,
            "a contract refusal is a legitimate terminal — the claim is "
            "released and the request keeps its retry budget",
        )
        release_argv = fake_run.captured[-1]
        self.assertIn("release", release_argv)
        self.assertEqual(
            release_argv[release_argv.index("--reason") + 1],
            "judge_verdict_contract_violation",
        )

    def test_the_refusal_still_never_submits(self) -> None:
        # Green exit must not mean "sealed anyway": the submit call is the
        # thing the refusal exists to prevent.
        fake_run = _make_fake_run_sequence(
            self.claim_response,
            self.release_response_ok,
        )
        with patch.object(
            ci_executor, "_pre_submit_validate_envelope",
            return_value=["judge_verdict:absent"],
        ):
            self._run_main(fake_run)
        self.assertFalse(
            any("submit" in argv for argv in fake_run.captured),
            f"refusal must not submit; argvs: {[list(c) for c in fake_run.captured]}",
        )

    def test_a_real_child_failure_still_reds_the_drain(self) -> None:
        # The counterweight: infrastructure failure keeps its red. Pinned
        # here so a later "make it green" cannot quietly cover both.
        # ARIA-MEDIUM-177 — the exit code is one rule over the two halves of
        # `failed`; the harness's half keeps its red unconditionally.
        source = (Path(ci_executor_drain.__file__)).read_text(encoding="utf-8")
        self.assertIn("return drain_exit_code(", source)
        self.assertIn("if harness_failed > 0:\n        return 1", source)
        self.assertIn("stop_reason = selection_error", source)
        self.assertEqual(ci_executor_drain.drain_exit_code(attempted=1, succeeded=0, harness_failed=1, request_failed=0), 1)


class ByDesignExitsNameThemselves(LivePathFetchTests):
    """B8 (2026-09-12) — every by-design exit 0 of `_main` before the spawn
    writes a `refused` summary naming why. The drain now counts nothing but
    a `succeeded` summary as drained and names a summary-less child as a
    failure, so a by-design exit that stayed silent would turn red — and
    before B8 it read as a drained success. Same mock-mode fixture; only
    the terminal differs."""

    def _run_with_summary_channel(self, fake_run) -> tuple[int, dict]:
        runner_temp = self.tmp / "runner-temp"
        runner_temp.mkdir()
        github_output = runner_temp / "github-output.txt"
        with patch.dict(os.environ, {"RUNNER_TEMP": str(runner_temp), "GITHUB_OUTPUT": str(github_output)}):
            exit_code = self._run_main(fake_run)
        summary_path = runner_temp / f"dispatch-result-{self.request_id}.json"
        self.assertTrue(summary_path.is_file(), "the by-design exit must write its summary")
        self.assertIn(f"dispatch_summary_path={summary_path.resolve().as_posix()}",
                      github_output.read_text(encoding="utf-8"))
        return exit_code, json.loads(summary_path.read_text(encoding="utf-8"))

    def _assert_refused(self, summary: dict, detail_code: str) -> None:
        self.assertEqual(summary["outcome"], "refused")
        self.assertEqual(summary["failure_class"], "policy_violation")
        self.assertEqual(summary["failure_detail_code"], detail_code)
        self.assertEqual(summary["exit_code"], 0)
        self.assertEqual((summary["target_agent"], summary["role"]), ("aria-evidence-judge", "evidence_judgment"))

    def _release_reason(self, fake_run) -> str:
        release_argv = next(argv for argv in fake_run.captured if "release" in argv)
        return release_argv[release_argv.index("--reason") + 1]

    def test_the_budget_signal_is_a_named_refusal(self) -> None:
        fake_run = _make_fake_run_sequence(self.claim_response, self.release_response_ok)
        with patch.object(ci_executor, "_validate_dispatch_budget",
                          side_effect=ci_executor.CostCapExceeded("evidence_refs over the turn cap")):
            exit_code, summary = self._run_with_summary_channel(fake_run)
        self.assertEqual(exit_code, 0, "a budget signal is not a build failure")
        self._assert_refused(summary, "dispatch_budget_refused:cost_cap")
        self.assertEqual(self._release_reason(fake_run), "dispatch_budget_refused")

    def test_the_wall_clock_refusal_names_the_clock(self) -> None:
        from aria_kernel.budget import WallClockExhausted

        fake_run = _make_fake_run_sequence(self.claim_response, self.release_response_ok)
        with patch.object(ci_executor, "_validate_dispatch_budget",
                          side_effect=WallClockExhausted("no room before the job deadline")):
            exit_code, summary = self._run_with_summary_channel(fake_run)
        self.assertEqual(exit_code, 0)
        self._assert_refused(summary, "dispatch_budget_refused:wall_clock")

    def test_the_recovery_escalation_is_a_named_refusal(self) -> None:
        fake_run = _make_fake_run_sequence(self.claim_response, self.release_response_ok)
        with patch.object(ci_executor, "_decide_session_and_recovery", return_value=(None, False)):
            exit_code, summary = self._run_with_summary_channel(fake_run)
        self.assertEqual(exit_code, 0)
        self._assert_refused(summary, "recovery_unresolved_external_effect")

    def test_the_operator_cancel_is_a_named_refusal(self) -> None:
        from aria_kernel.control import OPERATOR_CANCELLED_RELEASE_REASON

        fake_run = _make_fake_run_sequence(self.claim_response, self.release_response_ok)
        with patch("aria_kernel.control.is_cancelled", return_value=True):
            exit_code, summary = self._run_with_summary_channel(fake_run)
        self.assertEqual(exit_code, 0)
        self._assert_refused(summary, OPERATOR_CANCELLED_RELEASE_REASON)
        self.assertEqual(self._release_reason(fake_run), OPERATOR_CANCELLED_RELEASE_REASON)

    def test_the_contract_refusal_supersedes_the_clis_succeeded_summary(self) -> None:
        # After the spawn, invoke_claude_cli's summary says "succeeded" (the
        # CLI ran to completion); the pre-submit contract refusal is a later
        # terminal and must be what the drain reads.
        fake_run = _make_fake_run_sequence(self.claim_response, self.release_response_ok)
        with patch.object(ci_executor, "_pre_submit_validate_envelope", return_value=["judge_verdict:absent"]):
            exit_code, summary = self._run_with_summary_channel(fake_run)
        self.assertEqual(exit_code, 0)
        self._assert_refused(summary, "judge_verdict_contract_violation")
        self.assertEqual(self._release_reason(fake_run), "judge_verdict_contract_violation")

    def test_the_agent_refusal_supersedes_the_clis_succeeded_summary(self) -> None:
        # The agent's own refusal envelope: HUMAN_REQUIRED is recorded, the
        # claim is released with the agent's class, and the summary says
        # refused WITHOUT the agent-supplied class (sanitized by construction).
        fake_run = _make_fake_run_sequence(
            self.claim_response,
            MagicMock(returncode=0, stdout="{}", stderr=""),  # human-required record
            self.release_response_ok,
        )
        # ARIA-HIGH-194 — the detector reads the builder's refusal record
        # (details.agent_refusal) through the one refusal predicate.
        refusal = {"$schema": "aria/agent-refusal/v1", "reason_class": "scope_unclear", "reason_summary": "no"}
        with patch.object(ci_executor, "_agent_refusal_block", return_value=refusal):
            exit_code, summary = self._run_with_summary_channel(fake_run)
        self.assertEqual(exit_code, 0)
        self._assert_refused(summary, "agent_refused")
        self.assertEqual(self._release_reason(fake_run), "agent_refused:scope_unclear")
        self.assertNotIn("scope_unclear", json.dumps(summary))

    def test_no_return_zero_in_main_is_summary_less(self) -> None:
        """Make it detectable: every `return 0`-shaped exit of `_main` before
        the spawn is either the refusal helper or the final success. A new
        `return 0` (a fresh by-design exit) fails here until it names itself."""
        import ast

        source = Path(ci_executor.__file__).read_text(encoding="utf-8")
        tree = ast.parse(source)
        main = next(node for node in ast.walk(tree) if isinstance(node, ast.FunctionDef) and node.name == "_main")
        bare_zero_returns = [
            node.lineno for node in ast.walk(main)
            if isinstance(node, ast.Return) and isinstance(node.value, ast.Constant) and node.value.value == 0
        ]
        self.assertEqual(bare_zero_returns, [max(bare_zero_returns)],
                         "only the final success may `return 0` bare; a by-design exit returns _refuse_dispatch(...)")
        # ... and the exit code the helper hands back is exactly the refusal's.
        self.assertEqual(ci_executor.REFUSAL_EXIT_CODE, 0)


if __name__ == "__main__":
    unittest.main()
