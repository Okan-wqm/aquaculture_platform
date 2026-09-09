"""Real-mode eval refuses an unsafe debugger environment — ORPHAN-HIGH-573.

`artifact_safety.assert_real_mode_env_safe` shipped as the environment
precondition for ARIA real mode and had **zero callers anywhere**. Its dormancy
waiver was corrected on 2026-08-06 after someone re-read the CLI: the original
claimed the mode it protects is unreachable because `run_agent_eval` defaults to
`mock_mode=True`. That is false. `eval-run --no-mock-mode --real-envelope-file`
is a registered argument pair (`cli.py:1103-1106`) and `cli.py:3719` computes
`mock_mode = not args.no_mock_mode`, so real mode is reachable by an operator
today. It was an unguarded LIVE path, not a dormant future one — bounded only
because the flag is operator-typed rather than scheduled, which is why it stayed
MEDIUM rather than escalating.

The guard goes FIRST in the real-mode branch, ahead of the provenance
preconditions: an unsafe environment must be refused before the run starts
reading ledgers and binding an invocation to it.
"""

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from aria_kernel.agent_eval import EVAL_FIXTURE_SCHEMA, run_agent_eval
from aria_kernel.artifact_safety import ArtifactSafetyError, FORBIDDEN_REAL_MODE_ENV
from aria_kernel.ledger import append_declared_jsonl
from aria_kernel.runtime_profile import set_profile
from aria_kernel.tool_registry import ensure_tools_dir

FIXTURE_ID = "F900_ENVGUARD"


class RealModeEnvGuardTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.base = Path(self._tmp.name) / "aria-tools"
        ensure_tools_dir(self.base)
        # agent_eval writes require the strict profile (Plan 020 Phase 1.B).
        set_profile(
            "strict",
            operator_approval_ref="test:orphan-high-573",
            base_dir=self.base,
            set_by="operator",
        )
        append_declared_jsonl(
            self.base / "agent-evals" / "fixtures.jsonl",
            {
                "$schema": EVAL_FIXTURE_SCHEMA,
                "schema_version": 1,
                "row_id": FIXTURE_ID,
                "row_type": "fixture",
                "fixture_id": FIXTURE_ID,
                "target_agent": "test-agent",
                "role": "implementation",
                "intent": "ORPHAN-HIGH-573 environment guard",
                "scenario": "Reach the real-mode branch of run_agent_eval",
                "expected_verdict_class": "true_positive",
                "expected_evidence_refs": ["src/x.ts"],
                "max_rounds": 3,
                "max_tokens": 10000,
            },
            expected_surface="agent_eval_fixtures",
        )

    def _run_real_mode(self) -> None:
        """Enter the real-mode branch. Any later precondition may reject it.

        The assertion below is about WHICH refusal comes out, so the call
        deliberately supplies nothing else — a run that gets as far as the
        provenance checks has already passed the environment gate, which is the
        failure this test exists to catch.
        """
        run_agent_eval(fixture_id=FIXTURE_ID, base_dir=self.base, mock_mode=False)

    def test_a_forbidden_debug_variable_refuses_the_run(self) -> None:
        for name in FORBIDDEN_REAL_MODE_ENV:
            with self.subTest(variable=name):
                with mock.patch.dict(os.environ, {name: "1"}, clear=False):
                    with self.assertRaises(ArtifactSafetyError) as caught:
                        self._run_real_mode()
                self.assertIn(name, str(caught.exception))

    def test_the_guard_runs_before_provenance_is_bound(self) -> None:
        """Order is the point, not merely presence.

        With the variable set, the refusal must be the environment one — not
        `mock_mode=False requires real_response_envelope`. If the provenance
        error surfaces first, the run has already touched ledgers under a
        debugger environment the guard exists to keep it out of.
        """
        name = sorted(FORBIDDEN_REAL_MODE_ENV)[0]
        with mock.patch.dict(os.environ, {name: "1"}, clear=False):
            with self.assertRaises(ArtifactSafetyError):
                self._run_real_mode()

    def test_a_clean_environment_reaches_the_provenance_checks(self) -> None:
        """The guard must not become a blanket refusal of real mode."""
        cleaned = {name: "0" for name in FORBIDDEN_REAL_MODE_ENV}
        with mock.patch.dict(os.environ, cleaned, clear=False):
            with self.assertRaises(Exception) as caught:
                self._run_real_mode()
        self.assertNotIsInstance(
            caught.exception,
            ArtifactSafetyError,
            "a clean environment was still refused by the environment guard",
        )

    def test_mock_mode_is_unaffected(self) -> None:
        """Mock mode never enters the branch, so a debug variable is irrelevant there.

        This is the blast-radius statement the finding rests on: the guard is
        scoped to the operator-typed real-mode path and does not touch the
        default one, so wiring it cannot break a scheduled lane.
        """
        name = sorted(FORBIDDEN_REAL_MODE_ENV)[0]
        with mock.patch.dict(os.environ, {name: "1"}, clear=False):
            result = run_agent_eval(fixture_id=FIXTURE_ID, base_dir=self.base, mock_mode=True)
        self.assertEqual(result["mock_mode"], True)


if __name__ == "__main__":
    unittest.main()
