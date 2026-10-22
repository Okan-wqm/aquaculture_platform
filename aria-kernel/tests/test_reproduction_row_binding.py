"""WP-J review — an R4 row's recipe must resolve to a recorded run.

``agent_contract`` grades the assertion row's reproduction block for SHAPE
(``{recipe_id, expected}``) and says so ("shape only; the submit re-grade
checks the bytes"), but the submit re-grade checked no bytes for it: a
``recipe_id`` that exists nowhere and was never run passed
``validate_response`` and then took the TOP evidence rank in the arbiter's
brief — an "executable reproduction" nobody executed. The finding-side laws
(``finding.record_finding_reproduction``) bind red runs to real recorded
observations only at the OUTCOME fold, never before the verdict votes.

The law here, at the submit re-grade: a reproduction row resolves through
the recorded experiment observations (the same binding
``record_finding_reproduction`` reads — recipe_ref on the observation, run
status on the observation), and its ``expected`` red/green must agree with
the recorded run's status. Anything else is refused by name.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel.evidence_validator import validate_agent_response_evidence
from aria_kernel.experiment import observations_path, register_recipe
from aria_kernel.ledger import append_declared_jsonl
from aria_kernel.tool_registry import ensure_tools_dir

_RECIPE = "repro-recipe-farm-tests"


def _r4_response(recipe_id: str, expected: str) -> dict:
    return {
        "evidence_refs": [],
        "satisfaction_matrix": [
            {
                "id": "MS-R4",
                "verdict": "satisfied",
                "evidence_class": "R4",
                "reproduction": {"recipe_id": recipe_id, "expected": expected},
            },
        ],
    }


def _request() -> dict:
    return {"allowed_scope": ["**"]}


def _observe(
    tools: Path,
    *,
    recipe_ref: str = _RECIPE,
    run_status: str = "failed",
    matched: bool = True,
) -> None:
    """One recorded observation, appended through the declared surface
    exactly as run_experiment writes it (no command executed in a unit
    test)."""
    append_declared_jsonl(
        observations_path(tools),
        {
            "schema_version": 1,
            "recorded_at": "2026-10-20T00:00:00Z",
            "cycle_id": None,
            "experiment_id": "exp-problem",
            "recipe_ref": recipe_ref,
            "hypothesis": "the finding reproduces as a red run",
            "change_id": "change-1",
            "commit_sha": "a" * 40,
            "runner_identity": "test-runner",
            "validation_run_id": f"run-{run_status}",
            "validation_plan_ref": "sha256:test",
            "comparator": "status_equals",
            "expected": "failed",
            "observed": run_status,
            "matched": matched,
            "run_status": run_status,
        },
        expected_surface="experiment_observations",
    )


class ReproductionRowBindsToARecordedRun(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-wpj-r4-")
        self.workspace = Path(self._tmp.name) / "workspace"
        self.workspace.mkdir()
        self.tools = ensure_tools_dir(Path(self._tmp.name) / "aria-tools")
        register_recipe(
            recipe_id=_RECIPE,
            command="npx nx test farm-service",
            timeout_ms=60000,
            deterministic=True,
            base_dir=self.tools,
        )

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _codes(self, **kwargs) -> set[str]:
        result = validate_agent_response_evidence(
            response=_r4_response(kwargs.pop("recipe_id", _RECIPE), kwargs.pop("expected", "red")),
            workspace_root=self.workspace,
            request=_request(),
            **kwargs,
        )
        return {str(error.get("code")) for error in result["errors"]}, result

    def test_a_recipe_that_never_ran_is_refused_by_name(self) -> None:
        """The review's probe: a recipe_id that exists nowhere and was never
        run. Shape passed; the re-grade must refuse it by name."""
        codes, result = self._codes(recipe_id="recipe-never-minted-anywhere", base_dir=self.tools)
        self.assertFalse(result["valid"], result)
        self.assertIn("agent_matrix_reproduction_unrecorded", codes, result["errors"])

    def test_a_recorded_red_run_backs_an_r4_row(self) -> None:
        _observe(self.tools, run_status="failed")
        result = validate_agent_response_evidence(
            response=_r4_response(_RECIPE, "red"),
            workspace_root=self.workspace,
            request=_request(),
            base_dir=self.tools,
        )
        self.assertTrue(result["valid"], result["errors"])

    def test_an_expected_green_over_a_red_run_is_refused(self) -> None:
        _observe(self.tools, run_status="failed")
        codes, result = self._codes(expected="green", base_dir=self.tools)
        self.assertFalse(result["valid"], result)
        self.assertIn("agent_matrix_reproduction_status_mismatch", codes, result["errors"])

    def test_a_green_expectation_over_a_green_run_passes(self) -> None:
        _observe(self.tools, run_status="ok")
        result = validate_agent_response_evidence(
            response=_r4_response(_RECIPE, "green"),
            workspace_root=self.workspace,
            request=_request(),
            base_dir=self.tools,
        )
        self.assertTrue(result["valid"], result["errors"])

    def test_a_timeout_run_satisfies_neither_red_nor_green(self) -> None:
        """ARIA-MEDIUM-688's own title: the row must agree with a run that
        recorded red or green. A ``timeout`` is neither colour — the
        finding-reproduction law refuses it as noise for red, and the
        fix-verification law needs an ``ok`` run for green — so a recorded
        timeout backs no expectation at all."""
        _observe(self.tools, run_status="timeout")
        for expected in ("red", "green"):
            with self.subTest(expected=expected):
                codes, result = self._codes(expected=expected, base_dir=self.tools)
                self.assertFalse(result["valid"], result)
                self.assertIn(
                    "agent_matrix_reproduction_status_mismatch", codes, result["errors"]
                )

    def test_an_unmatched_observation_proves_nothing(self) -> None:
        """The same law record_finding_reproduction applies: an observation
        that did not satisfy its contract is not a reproduction."""
        _observe(self.tools, run_status="failed", matched=False)
        codes, result = self._codes(base_dir=self.tools)
        self.assertIn("agent_matrix_reproduction_unrecorded", codes, result["errors"])

    def test_a_reproduction_row_requires_the_ledger(self) -> None:
        """Fail-closed, not unverifiable-but-accepted: a wire that cannot
        read the recorded runs must refuse a reproduction claim outright —
        the claim's whole authority is the recorded run."""
        codes, result = self._codes()
        self.assertFalse(result["valid"], result)
        self.assertIn("agent_matrix_reproduction_ledger_required", codes, result["errors"])


if __name__ == "__main__":
    unittest.main()
