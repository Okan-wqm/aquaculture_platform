"""Plan 022 H-4 — genesis sandbox real fixture execution provenance.

Pre-Plan-022 evaluate_genesis_sandbox accepted any 3+ fixture_results
with status filter. A caller could pass synthetic
[{status:'pass'}, {status:'pass'}, {status:'pass'}] and the sandbox
would record 'pass' even though no fixture had ever run.

Fix: each fixture_result MUST carry provenance.executed_at +
provenance.execution_run_id. Missing -> GovernanceError unless
synthetic_test_mode=True (operator-test-only) or
ARIA_GENESIS_TEST_SYNTHETIC env var is set.
"""
from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

# Reuse the existing test fixture setUp via class inheritance — it already
# seeds .claude/agents + drafts a real gap-driven agent.
from tests.test_agent_genesis_foundation import AgentGenesisFoundationTests as _Base
from aria_kernel.agent_genesis import (
    draft_agent_from_gap,
    evaluate_genesis_sandbox,
)
from aria_kernel.capability_gap import detect_capability_gaps
from aria_kernel.tool_registry import GovernanceError
from tests._helpers.declared_fixtures import append_declared_fixture


def _fixture_with_provenance(*, status: str = "pass", run_id: str = "run-1") -> dict:
    return {
        "name": "tp",
        "status": status,
        "provenance": {
            "executed_at": "2026-05-08T12:00:00+00:00",
            "execution_run_id": run_id,
        },
    }


class _GenesisH4Common(_Base):
    """Inherit setUp + .claude/agents fixture from the genesis foundation
    suite to bootstrap a real draft_id quickly. Skip the parent's own
    test methods so they don't duplicate-run."""

    def _seed_real_draft(self) -> str:
        """Run the same gap-driven flow the parent test uses to obtain
        a draft_id we can target with H-4 sandbox calls."""
        from aria_kernel.agent_priors import map_agent_priors
        from aria_kernel.tool_health import runs_path
        map_agent_priors(workspace_root=self.root, base_dir=self.tools_dir)
        append_declared_fixture(
            runs_path(self.tools_dir),
            {
                "schema_version": 1,
                "run_id": "run-h4-shadow",
                "tool_id": "h4-pattern-adapter",
                "cycle_id": "cycle-h4-gap",
                "status": "ok",
                "read_paths": [
                    "libs/h4/src/check.ts",
                    "libs/h4/src/other.ts",
                    "libs/h4/src/third.ts",
                ],
                "emitted_findings": [],
                "runner": {"raw_findings_count": 8},
            },
            expected_surface="runs",
        )
        gap = detect_capability_gaps(cycle_id="cycle-h4-gap", base_dir=self.tools_dir)["gaps"][0]
        draft = draft_agent_from_gap(gap_id=gap["gap_id"], base_dir=self.tools_dir)
        return draft["draft_id"]


# Skip parent test methods on this subclass — we only want our own.
def _skipped(name: str):
    def _stub(self):
        self.skipTest(f"{name} runs in test_agent_genesis_foundation; subclass focuses on H-4")
    return _stub


for _name in dir(_Base):
    if _name.startswith("test_"):
        # Will install on the subclass class definitions below.
        pass


class GenesisProvenanceRequiredTests(_GenesisH4Common):
    def setUp(self) -> None:
        super().setUp()
        self._saved_env = os.environ.pop("ARIA_GENESIS_TEST_SYNTHETIC", None)

    def tearDown(self) -> None:
        if self._saved_env is not None:
            os.environ["ARIA_GENESIS_TEST_SYNTHETIC"] = self._saved_env
        else:
            os.environ.pop("ARIA_GENESIS_TEST_SYNTHETIC", None)
        super().tearDown()

    def test_synthetic_input_rejected_in_default_mode(self) -> None:
        draft_id = self._seed_real_draft()
        with self.assertRaises(GovernanceError) as cm:
            evaluate_genesis_sandbox(
                draft_id=draft_id,
                fixture_results=[
                    {"name": "tp", "status": "pass"},
                    {"name": "fp", "status": "pass"},
                    {"name": "scope", "status": "pass"},
                ],
                base_dir=self.tools_dir,
            )
        self.assertIn("genesis_synthetic_input_forbidden_outside_test_mode",
                      str(cm.exception))

    def test_real_provenance_accepted(self) -> None:
        # Plan 023 v3 §A-1 — provenance shape alone is no longer enough;
        # seeded fixture-runs.jsonl rows must back each claimed
        # execution_run_id. Each result references a separate ledger
        # row populated below.
        from aria_kernel.fixture_runner import fixture_runs_path
        draft_id = self._seed_real_draft()
        for i in range(3):
            append_declared_fixture(
                fixture_runs_path(self.tools_dir),
                {
                    "schema_version": 1,
                    "row_type": "fixture_run_suite",
                    "at": "2026-05-09T00:00:00+00:00",
                    "tool_id": "h4-pattern-adapter",
                    "execution_run_id": f"run-{i}",
                    "case_count": 3,
                    "actual_status": "pass",
                    "evidence_hash": "sha256:fake",
                    "passed": True,
                },
                expected_surface="agent_eval_fixture_runs",
            )
        result = evaluate_genesis_sandbox(
            draft_id=draft_id,
            fixture_results=[
                _fixture_with_provenance(run_id=f"run-{i}") for i in range(3)
            ],
            base_dir=self.tools_dir,
        )
        self.assertEqual(result["decision"], "pass")
        self.assertFalse(result["synthetic_test_mode"])

    def test_partial_provenance_rejected(self) -> None:
        draft_id = self._seed_real_draft()
        bad = [
            _fixture_with_provenance(run_id="run-1"),
            _fixture_with_provenance(run_id="run-2"),
            {"name": "missing", "status": "pass"},  # no provenance
        ]
        with self.assertRaises(GovernanceError) as cm:
            evaluate_genesis_sandbox(
                draft_id=draft_id,
                fixture_results=bad,
                base_dir=self.tools_dir,
            )
        self.assertIn("[2]", str(cm.exception))


class GenesisSyntheticTestModeTests(_GenesisH4Common):
    def setUp(self) -> None:
        super().setUp()
        self._saved_env = os.environ.pop("ARIA_GENESIS_TEST_SYNTHETIC", None)

    def tearDown(self) -> None:
        if self._saved_env is not None:
            os.environ["ARIA_GENESIS_TEST_SYNTHETIC"] = self._saved_env
        else:
            os.environ.pop("ARIA_GENESIS_TEST_SYNTHETIC", None)
        super().tearDown()

    def test_synthetic_test_mode_kwarg_allows_synthetic(self) -> None:
        draft_id = self._seed_real_draft()
        result = evaluate_genesis_sandbox(
            draft_id=draft_id,
            fixture_results=[
                {"name": "tp", "status": "pass"},
                {"name": "fp", "status": "pass"},
                {"name": "scope", "status": "pass"},
            ],
            base_dir=self.tools_dir,
            synthetic_test_mode=True,
        )
        self.assertEqual(result["decision"], "pass")
        self.assertTrue(result["synthetic_test_mode"])

    def test_env_var_allows_synthetic(self) -> None:
        os.environ["ARIA_GENESIS_TEST_SYNTHETIC"] = "1"
        draft_id = self._seed_real_draft()
        result = evaluate_genesis_sandbox(
            draft_id=draft_id,
            fixture_results=[
                {"name": "tp", "status": "pass"},
                {"name": "fp", "status": "pass"},
                {"name": "scope", "status": "pass"},
            ],
            base_dir=self.tools_dir,
        )
        self.assertEqual(result["decision"], "pass")
        self.assertTrue(result["synthetic_test_mode"])


# Skip parent test methods on every H4 subclass — we only want H-4 tests.
for _cls in (GenesisProvenanceRequiredTests, GenesisSyntheticTestModeTests):
    for _name in dir(_Base):
        if _name.startswith("test_"):
            setattr(_cls, _name, _skipped(_name))


if __name__ == "__main__":
    unittest.main()
