"""F0.6 — the night stops re-running a hypothesis its own observations refuted.

State at the branch base (measured on origin/aria/state, 2026-10-27): 95
observation rows, 94 of them ``matched=false, run_status=ok`` from two HIGH
``wrong_code`` experiments (47 each, 33 distinct commits). The planner
(``experiment_night.plan_night_experiments``) admits an experiment while its
finding is open and unreproduced and never reads the observation ledger, so the
same two HIGH hypotheses rank first every night, take two of the three problem
slots for good, and every lower-severity candidate starves.

The design these tests pin (SPEC D-1 .. D-8):

  * a streak is the experiment's own run of non-matching observations in ledger
    order: a ``matched is True`` row ends it, a non-matching row whose
    ``run_status`` is not ``timeout`` adds one, a timeout neither adds nor ends;
    plain observations are counted, not distinct commits;
  * the cut is decided inside ``plan_night_experiments``, AFTER the candidate
    filters and BEFORE the severity sort and the budget slice, so a cut
    experiment frees its slot; it is ``plan["cut"]``, not ``plan["problem"]``;
  * the limit and the exempt ids are the pre-registered ``hypothesis_cut`` block
    (the policy file pins the block); an exempt id no registered experiment
    carries is disclosed as ``unknown_exemptions``, never ignored;
  * each cut is one named governance row ``experiment_hypothesis_cut`` per
    (experiment, finding, limit), written once, while the standing cut is
    disclosed in the night payload (``cut_problem``) every night;
  * the cut is derived from the ledger and the policy each night: nothing is
    latched, and it is not a verdict on the finding (status, certainty and the
    author's one-experiment-per-finding dedupe are untouched, the regression
    lane is untouched).

New API pinned here, each reached by name so the test is red by assertion at
the branch base and not by an import error: ``experiment_night.nonmatching_streaks``,
``experiment_night.HYPOTHESIS_CUT_KIND``, the plan keys ``cut`` and
``unknown_exemptions``, the night payload keys ``cut_problem`` and
``unknown_exemptions``, the digest fields of the same names. The limit N is read
through ``genesis_policy.hypothesis_cut_policy`` everywhere except
``ExitMetricTests``, which pins the shipped value 5.

Reproducing the defect itself (red at base for the defect's reason, an
assertion about the runs the night makes): ``ExitMetricTests`` (94 calls where at
most 10 are allowed), the boundary, legacy-ledger, streak, budget and exemption
tests (a refuted experiment is still planned and run).
"""
from __future__ import annotations

import json
import os
import unittest
from typing import Any
from unittest import mock

from aria_kernel import experiment_night
from aria_kernel.experiment import (
    list_experiment_observations,
    list_experiments,
    observations_path,
    register_experiment,
    register_recipe,
)
from aria_kernel.experiment_night import (
    MAX_PROBLEM_RUNS_PER_NIGHT,
    plan_night_experiments,
    run_night_experiments,
)
from aria_kernel.finding import (
    _events_path,
    emit_finding,
    record_finding_reproduction,
    record_finding_status_change,
    show_finding,
)
from aria_kernel.ledger import append_declared_jsonl_rows
from aria_kernel.tool_registry import disclosure_fingerprint
from tests import test_experiment_night as _night
from tests.test_f06_hypothesis_cut_policy import SHIPPED_BLOCK, registered_n, write_override

KIND = "experiment_hypothesis_cut"
SHIPPED_N = SHIPPED_BLOCK["max_nonmatching_observations"]

# One letter per observation, in ledger order. U: the run did not match the contract
# (the measured 94). F: did not match and the run itself failed. T: did not match and
# timed out (never reached a verdict). M: matched.
_ROW = {
    "U": {"matched": False, "run_status": "ok"},
    "F": {"matched": False, "run_status": "failed"},
    "T": {"matched": False, "run_status": "timeout"},
    "M": {"matched": True, "run_status": "failed"},
}


class CountingRunner:
    """A runner that records which experiment each call ran, then delegates to a fake that writes the row."""

    def __init__(self, inner: Any) -> None:
        self._inner = inner
        self.calls: list[str] = []

    def __call__(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(str(kwargs["experiment_id"]))
        return self._inner(**kwargs)


class CutBase(_night.NightBase):
    def setUp(self) -> None:
        super().setUp()
        register_recipe(
            recipe_id="recipe-night", command="npx nx test farm-service",
            timeout_ms=60000, deterministic=True, base_dir=self.tools,
        )
        self._seeded: dict[str, int] = {}

    # --- fixtures -----------------------------------------------------------------

    def _wrong_code_finding(self, *, severity: str = "HIGH", suffix: str = "1") -> str:
        # wrong_code has a MEDIUM severity floor; the planner reads severity, never the claim type,
        # so the one LOW hypothesis of the budget test is a duplication finding.
        record = emit_finding(
            repo_root=self.repo, base_dir=self.tools,
            claim_type="duplication" if severity == "LOW" else "wrong_code",
            claim_summary=f"Module {suffix} computes the wrong tenant scope",
            severity=severity, evidences=_night._evidence(3), facts=["fact a", "fact b", "fact c"],
            scope_files=["apps/farm-service/src/module1.ts"],
        )
        return record["finding_id"]

    def _hypothesis(self, experiment_id: str, *, severity: str = "HIGH", recipe_id: str = "recipe-night") -> str:
        """A wrong_code finding with one red-contract experiment bound to it; returns the finding id."""
        finding_id = self._wrong_code_finding(severity=severity, suffix=experiment_id)
        self._bind_experiment(finding_id, experiment_id=experiment_id, recipe_id=recipe_id)
        return finding_id

    def _seed(self, experiment_id: str, outcomes: str) -> list[str]:
        """Append observation rows for ``experiment_id``; returns their validation run ids in order."""
        return self._seed_sequence([(experiment_id, letter) for letter in outcomes])

    def _seed_sequence(self, sequence: list[tuple[str, str]]) -> list[str]:
        """Append ``(experiment_id, letter)`` rows in this order, as one batch on the declared surface.

        The batch form of ``append_declared_jsonl`` (one chain verification for the lot): the rows
        are the ones ``NightFoldTests._resolved_binding`` writes, and a legacy ledger of 94 of them
        would otherwise cost the module minutes.
        """
        rows: list[dict[str, Any]] = []
        for experiment_id, letter in sequence:
            index = self._seeded.get(experiment_id, 0) + 1
            self._seeded[experiment_id] = index
            shape = _ROW[letter]
            rows.append({
                "schema_version": 1, "recorded_at": "2026-08-16T00:00:00Z",
                "cycle_id": None, "experiment_id": experiment_id,
                "recipe_ref": "recipe-night", "hypothesis": "h",
                "change_id": "change-seed", "commit_sha": "a" * 40,
                "runner_identity": "t", "validation_run_id": f"seed-{experiment_id}-{index:03d}",
                "validation_plan_ref": "sha256:test",
                "comparator": "status_equals", "expected": "failed",
                "observed": shape["run_status"], "matched": shape["matched"],
                "run_status": shape["run_status"],
            })
        append_declared_jsonl_rows(observations_path(self.tools), rows, expected_surface="experiment_observations")
        return [row["validation_run_id"] for row in rows]

    def _runner(self, *, matched: bool = False, run_status: str = "ok") -> CountingRunner:
        return CountingRunner(self._fake_runner(matched=matched, run_status=run_status))

    # --- the night, and what it left behind ---------------------------------------

    def _night_run(self, runner: CountingRunner, *, cycle: str = "cycle-f06") -> dict[str, Any]:
        return run_night_experiments(self.repo, cycle_id=cycle, base_dir=self.tools, runner=runner)

    def _plan(self) -> dict[str, Any]:
        return plan_night_experiments(self.repo, base_dir=self.tools)

    def _governance(self, kind: str) -> list[dict[str, Any]]:
        path = self.tools / "governance.jsonl"
        if not path.exists():
            return []
        rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
        return [row for row in rows if row.get("kind") == kind]

    def _cut_rows(self) -> list[dict[str, Any]]:
        return self._governance(KIND)

    @staticmethod
    def _ids(items: list[dict[str, Any]]) -> list[str]:
        return [str(item["experiment_id"]) for item in items]

    def _planned_cut(self, plan: dict[str, Any]) -> list[dict[str, Any]]:
        self.assertIn("cut", plan, "plan_night_experiments does not name the experiments it cut (F0.6 D-2)")
        return plan["cut"]

    def _payload_cut(self, payload: dict[str, Any]) -> list[dict[str, Any]]:
        self.assertIn("cut_problem", payload, "the night payload does not disclose the cut (F0.6 D-5)")
        return payload["cut_problem"]


class ExitMetricTests(CutBase):
    """SPEC T1 — the program's number, reproduced on a fixture: 94 runs drop to at most 10."""

    def test_forty_seven_nights_over_two_refuted_hypotheses_cost_ten_runs(self) -> None:
        for service, experiment_id in (("admin-api-service", "exp-auto-f-001"), ("ai-service", "exp-auto-f-002")):
            recipe_id = f"recipe-auto-{service}"
            register_recipe(
                recipe_id=recipe_id,
                command=f"npx nx run-many --target=test --projects={service} --skip-nx-cache --output-style=stream",
                timeout_ms=900_000, deterministic=True, base_dir=self.tools,
            )
            self._hypothesis(experiment_id, severity="HIGH", recipe_id=recipe_id)
        runner = self._runner(matched=False, run_status="ok")

        payloads = [self._night_run(runner, cycle=f"cycle-night-{night:02d}") for night in range(1, 48)]

        self.assertLessEqual(
            len(runner.calls), 10,
            f"{len(runner.calls)} runs in 47 nights: two refuted HIGH hypotheses are still run every night",
        )
        self.assertEqual(len(runner.calls), 2 * SHIPPED_N)
        self.assertEqual(sorted(set(runner.calls)), ["exp-auto-f-001", "exp-auto-f-002"])
        self.assertEqual(
            len(list_experiment_observations(base_dir=self.tools)), len(runner.calls),
            "every run leaves one observation; a cut experiment leaves none",
        )
        self.assertEqual(len(self._cut_rows()), 2, "one named governance row per cut experiment, not one per night")
        last = payloads[-1]
        self.assertEqual(last["planned_problem"], 0)
        self.assertEqual(len(self._payload_cut(last)), 2)
        self.assertEqual(registered_n(self), SHIPPED_N, "the shipped limit is the plan's value")


class BoundaryTests(CutBase):
    """SPEC T2 — N-1 non-matching observations still run, N cut."""

    def test_below_the_limit_the_experiment_still_runs(self) -> None:
        n = registered_n(self)
        self._hypothesis("exp-a")
        self._seed("exp-a", "U" * (n - 1))
        plan = self._plan()
        self.assertEqual(self._ids(plan["problem"]), ["exp-a"])
        self.assertEqual(self._planned_cut(plan), [])
        self.assertEqual(plan.get("unknown_exemptions"), [])

    def test_at_the_limit_the_experiment_is_cut_and_named(self) -> None:
        n = registered_n(self)
        finding_id = self._hypothesis("exp-a")
        run_ids = self._seed("exp-a", "U" * n)
        plan = self._plan()
        self.assertEqual(self._ids(plan["problem"]), [], "an experiment at the limit is still planned")
        self.assertEqual(self._planned_cut(plan), [{
            "experiment_id": "exp-a", "finding_id": finding_id, "recipe_ref": "recipe-night",
            "nonmatching_observations": n, "max_nonmatching_observations": n,
            "first_validation_run_id": run_ids[0], "last_validation_run_id": run_ids[-1],
        }])

    def test_past_the_limit_the_count_keeps_counting(self) -> None:
        n = registered_n(self)
        self._hypothesis("exp-a")
        self._seed("exp-a", "U" * (n + 3))
        plan = self._plan()
        self.assertEqual(self._ids(plan["problem"]), [])
        self.assertEqual([c["nonmatching_observations"] for c in self._planned_cut(plan)], [n + 3])

    def test_cut_items_are_sorted_by_experiment_id(self) -> None:
        n = registered_n(self)
        for experiment_id in ("exp-z", "exp-a", "exp-m"):
            self._hypothesis(experiment_id)
            self._seed(experiment_id, "U" * n)
        plan = self._plan()
        self.assertEqual(self._ids(plan["problem"]), [])
        self.assertEqual(self._ids(self._planned_cut(plan)), ["exp-a", "exp-m", "exp-z"])

    def test_a_failed_run_that_did_not_match_counts_like_an_ok_one(self) -> None:
        # D-1: only a timeout is excepted; every other non-matching status is a refutation.
        n = registered_n(self)
        self._hypothesis("exp-a")
        self._seed("exp-a", "F" * (n - 2) + "U" + "F")
        plan = self._plan()
        self.assertEqual(self._ids(plan["problem"]), [])
        self.assertEqual([c["nonmatching_observations"] for c in self._planned_cut(plan)], [n])


class LegacyLedgerTests(CutBase):
    """SPEC T3 — what origin/aria/state holds today (47 + 47) costs no further run."""

    def test_a_ledger_that_already_holds_the_refutations_is_cut_at_the_first_night(self) -> None:
        for experiment_id in ("exp-auto-f-001", "exp-auto-f-002"):
            self._hypothesis(experiment_id)
            self._seed(experiment_id, "U" * 47)
        runner = self._runner()

        first = self._night_run(runner, cycle="cycle-legacy-1")

        self.assertEqual(runner.calls, [], "the legacy ledger must cost no further run")
        self.assertEqual(first["planned_problem"], 0)
        rows = self._cut_rows()
        self.assertEqual(sorted(row["details"]["experiment_id"] for row in rows), ["exp-auto-f-001", "exp-auto-f-002"])
        self.assertEqual([row["details"]["nonmatching_observations"] for row in rows], [47, 47])
        self.assertEqual(self._ids(self._payload_cut(first)), ["exp-auto-f-001", "exp-auto-f-002"])

        self._night_run(runner, cycle="cycle-legacy-2")
        self.assertEqual(runner.calls, [])
        self.assertEqual(len(self._cut_rows()), 2, "a second night writes no second row for the same cut")


class StreakEndsTests(CutBase):
    """SPEC T4, T5 — near-misses: a match ends the streak; a timeout is neither evidence nor a reset."""

    def _assert_not_cut(self, experiment_id: str) -> None:
        plan = self._plan()
        self.assertEqual(self._planned_cut(plan), [], "the experiment was cut")
        self.assertEqual(self._ids(plan["problem"]), [experiment_id])

    def _assert_cut_at(self, experiment_id: str, count: int) -> None:
        plan = self._plan()
        self.assertEqual(self._ids(plan["problem"]), [])
        cut = self._planned_cut(plan)
        self.assertEqual(self._ids(cut), [experiment_id])
        self.assertEqual(cut[0]["nonmatching_observations"], count)

    def test_a_match_ends_the_streak(self) -> None:
        n = registered_n(self)
        self._hypothesis("exp-a")
        # n unmatched in all, but a match between them: the streak after it is 2.
        self._seed("exp-a", "U" * (n - 2) + "M" + "UU")
        self._assert_not_cut("exp-a")

    def test_a_match_at_the_end_leaves_no_streak(self) -> None:
        n = registered_n(self)
        self._hypothesis("exp-a")
        self._seed("exp-a", "U" * (n + 2) + "M")
        self._assert_not_cut("exp-a")

    def test_the_streak_counts_again_after_a_match(self) -> None:
        n = registered_n(self)
        self._hypothesis("exp-a")
        self._seed("exp-a", "U" * (n + 2) + "M" + "U" * n)
        self._assert_cut_at("exp-a", n)

    def test_timeouts_are_not_evidence(self) -> None:
        n = registered_n(self)
        self._hypothesis("exp-a")
        self._seed("exp-a", "U" * (n - 1) + "TTT")
        self._assert_not_cut("exp-a")
        self._seed("exp-a", "U")
        self._assert_cut_at("exp-a", n)

    def test_timeouts_do_not_reset_the_streak(self) -> None:
        n = registered_n(self)
        self._hypothesis("exp-a")
        self._seed("exp-a", "U" * (n - 2) + "T" + "U")
        self._assert_not_cut("exp-a")
        self._seed("exp-a", "U")
        self._assert_cut_at("exp-a", n)

    def test_only_timeouts_never_cut(self) -> None:
        n = registered_n(self)
        self._hypothesis("exp-a")
        self._seed("exp-a", "T" * (n + 4))
        self._assert_not_cut("exp-a")


class PerExperimentTests(CutBase):
    """SPEC T6 — near-miss: the streak is the experiment's own; other experiments' rows never count."""

    def test_two_experiments_on_one_recipe_are_counted_apart(self) -> None:
        n = registered_n(self)
        self._hypothesis("exp-a")
        self._hypothesis("exp-b")
        self._seed("exp-a", "U" * n)
        self._seed("exp-b", "U" * (n - 1))
        plan = self._plan()
        self.assertEqual(self._ids(plan["problem"]), ["exp-b"])
        self.assertEqual(self._ids(self._planned_cut(plan)), ["exp-a"])

    def test_interleaved_rows_of_other_experiments_do_not_end_or_extend_a_streak(self) -> None:
        n = registered_n(self)
        self._hypothesis("exp-a")
        self._hypothesis("exp-b")
        self._hypothesis("exp-c")
        sequence = []
        for _ in range(n - 1):
            # a match of ANOTHER experiment between every pair of rows
            sequence += [("exp-a", "U"), ("exp-b", "U"), ("exp-c", "M")]
        self._seed_sequence(sequence + [("exp-a", "U")])
        plan = self._plan()
        self.assertEqual(self._ids(plan["problem"]), ["exp-b", "exp-c"])
        self.assertEqual(self._ids(self._planned_cut(plan)), ["exp-a"])


class BudgetTests(CutBase):
    """SPEC T7 — the cut frees the budget: it is decided before the severity sort and the slice."""

    def test_a_cut_experiment_frees_its_problem_slot(self) -> None:
        n = registered_n(self)
        for experiment_id, severity in (
            ("exp-1", "HIGH"), ("exp-2", "HIGH"), ("exp-3", "HIGH"), ("exp-4", "MEDIUM"), ("exp-5", "LOW"),
        ):
            self._hypothesis(experiment_id, severity=severity)
        self._seed("exp-1", "U" * n)

        plan = self._plan()

        self.assertEqual(self._ids(plan["problem"]), ["exp-2", "exp-3", "exp-4"])
        self.assertEqual(len(plan["problem"]), MAX_PROBLEM_RUNS_PER_NIGHT)
        self.assertEqual(plan["skipped_problem"], 1, "skipped_problem means over budget only; a cut one is not skipped")
        self.assertEqual(self._ids(self._planned_cut(plan)), ["exp-1"])

    def test_the_night_runs_what_the_cut_freed(self) -> None:
        n = registered_n(self)
        for experiment_id, severity in (
            ("exp-1", "HIGH"), ("exp-2", "HIGH"), ("exp-3", "HIGH"), ("exp-4", "MEDIUM"), ("exp-5", "LOW"),
        ):
            self._hypothesis(experiment_id, severity=severity)
        self._seed("exp-1", "U" * n)
        runner = self._runner()

        payload = self._night_run(runner)

        self.assertEqual(runner.calls, ["exp-2", "exp-3", "exp-4"])
        self.assertEqual(payload["planned_problem"], 3)
        self.assertEqual(payload["skipped_problem"], 1)
        self.assertEqual(self._ids(self._payload_cut(payload)), ["exp-1"])


class OnlyRealCandidatesTests(CutBase):
    """SPEC T8 — the cut is decided after the candidate filters: only what would have run can be cut."""

    def _assert_nothing_cut(self, runner: CountingRunner | None = None) -> None:
        plan = self._plan()
        self.assertEqual(self._planned_cut(plan), [])
        payload = self._night_run(runner or self._runner())
        self.assertEqual(self._payload_cut(payload), [])
        self.assertEqual(self._cut_rows(), [], "a hypothesis that was never a candidate gets no row")

    def test_a_withdrawn_finding_is_never_listed_as_cut(self) -> None:
        n = registered_n(self)
        finding_id = self._hypothesis("exp-a")
        self._seed("exp-a", "U" * (n + 3))
        record_finding_status_change(
            self.repo, finding_id=finding_id, to_status="WITHDRAWN",
            reason="the claim rested on a stale fixture", actor="operator:test", base_dir=self.tools,
        )
        self._assert_nothing_cut()

    def test_a_green_contract_experiment_is_never_listed_as_cut(self) -> None:
        # The solution experiment of a finding: same recipe, green contract. It is not a hypothesis
        # about the defect, so its unmatched runs are not refutations.
        n = registered_n(self)
        finding_id = self._wrong_code_finding(suffix="green")
        self._bind_experiment(finding_id, experiment_id="exp-green", expected="ok")
        self._seed("exp-green", "U" * n)
        self._assert_nothing_cut()

    def test_an_unbound_experiment_is_never_listed_as_cut(self) -> None:
        n = registered_n(self)
        register_experiment(
            experiment_id="exp-unbound", hypothesis="a hypothesis about the tree, bound to no finding",
            recipe_ref="recipe-night",
            observation_contract={"comparator": "status_equals", "expected": "failed"},
            base_dir=self.tools,
        )
        self._seed("exp-unbound", "U" * (n + 3))
        self._assert_nothing_cut()

    def test_an_experiment_whose_finding_no_finding_answers_is_never_listed_as_cut(self) -> None:
        n = registered_n(self)
        register_experiment(
            experiment_id="exp-typo", hypothesis="a ref no finding answers", recipe_ref="recipe-night",
            observation_contract={"comparator": "status_equals", "expected": "failed"},
            finding_ref="F-999", base_dir=self.tools,
        )
        self._seed("exp-typo", "U" * n)
        plan = self._plan()
        self.assertEqual(self._planned_cut(plan), [])
        self.assertEqual(plan["unresolvable_bindings"], [{"experiment_id": "exp-typo", "finding_ref": "F-999"}])

    def test_a_reproduced_finding_is_never_listed_as_cut(self) -> None:
        n = registered_n(self)
        finding_id = self._hypothesis("exp-a")
        red_run = self._seed("exp-a", "M")[0]
        record_finding_reproduction(self.repo, finding_id=finding_id, validation_run_id=red_run, base_dir=self.tools)
        self._seed("exp-a", "U" * n)
        self._assert_nothing_cut()


class RegressionLaneTests(CutBase):
    """SPEC T9 — the regression lane is untouched: an unmatched re-run there is a regression, not a refutation."""

    def test_the_fix_verified_binding_is_rerun_every_night_and_never_cut(self) -> None:
        _night.NightFoldTests._resolved_binding(self)
        runner = self._runner(matched=False, run_status="failed")

        payloads = [self._night_run(runner, cycle=f"cycle-regression-{night}") for night in range(1, 7)]

        self.assertEqual(runner.calls, ["exp-1-fix"] * 6)
        self.assertEqual(len(self._governance("experiment_regression_detected")), 6)
        for payload in payloads:
            self.assertEqual(self._payload_cut(payload), [])
            self.assertEqual(len(payload["regressions"]), 1)
        self.assertEqual(self._cut_rows(), [])
        plan = self._plan()
        self.assertEqual(self._planned_cut(plan), [])
        self.assertEqual([b["experiment_id"] for b in plan["regression"]], ["exp-1-fix"])


class ExemptionTests(CutBase):
    """SPEC T10 — only an explicit operator-written id list exempts; the override's N is the one read."""

    def _override(self, limit: int, exempt: list[str]) -> None:
        write_override(self.repo, {"max_nonmatching_observations": limit, "exempt_experiments": exempt})

    def test_an_exempt_experiment_keeps_running_and_the_override_limit_is_honoured(self) -> None:
        self._hypothesis("exp-a")
        self._hypothesis("exp-b")
        self._seed("exp-a", "U" * 9)
        self._seed("exp-b", "U" * 3)
        self._override(3, ["exp-a", "exp-typo"])

        plan = self._plan()

        self.assertEqual(self._ids(plan["problem"]), ["exp-a"])
        cut = self._planned_cut(plan)
        self.assertEqual(self._ids(cut), ["exp-b"])
        self.assertEqual((cut[0]["nonmatching_observations"], cut[0]["max_nonmatching_observations"]), (3, 3))
        self.assertEqual(plan.get("unknown_exemptions"), ["exp-typo"])

        runner = self._runner()
        payload = self._night_run(runner)
        self.assertEqual(runner.calls, ["exp-a"])
        self.assertEqual(self._ids(self._payload_cut(payload)), ["exp-b"])
        self.assertEqual(payload.get("unknown_exemptions"), ["exp-typo"])
        self.assertEqual([row["details"]["experiment_id"] for row in self._cut_rows()], ["exp-b"])

    def test_an_exempt_id_that_a_registered_experiment_carries_is_not_unknown(self) -> None:
        self._hypothesis("exp-a")
        register_experiment(
            experiment_id="exp-unbound", hypothesis="registered, bound to no finding", recipe_ref="recipe-night",
            observation_contract={"comparator": "status_equals", "expected": "failed"}, base_dir=self.tools,
        )
        self._override(5, ["exp-a", "exp-unbound"])
        self.assertEqual(self._plan().get("unknown_exemptions"), [])

    def test_unknown_exemptions_are_sorted_and_named(self) -> None:
        self._override(5, ["exp-z", "exp-a", "exp-m"])
        self.assertEqual(self._plan().get("unknown_exemptions"), ["exp-a", "exp-m", "exp-z"])

    def test_without_an_override_nothing_is_exempt(self) -> None:
        n = registered_n(self)
        self._hypothesis("exp-a", severity="HIGH")
        self._seed("exp-a", "U" * n)
        plan = self._plan()
        self.assertEqual(self._ids(plan["problem"]), [])
        self.assertEqual(self._ids(self._planned_cut(plan)), ["exp-a"])


class NamedRowTests(CutBase):
    """SPEC T11 — one named governance row per cut experiment, once; the standing cut is disclosed in the payload."""

    def test_the_kind_is_the_named_constant(self) -> None:
        self.assertEqual(getattr(experiment_night, "HYPOTHESIS_CUT_KIND", None), KIND)

    def test_the_row_has_the_named_shape(self) -> None:
        n = registered_n(self)
        finding_id = self._hypothesis("exp-a")
        run_ids = self._seed("exp-a", "U" * n)

        self._night_run(self._runner(), cycle="cycle-row-1")

        rows = self._cut_rows()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["details"], {
            "experiment_id": "exp-a", "finding_id": finding_id, "recipe_ref": "recipe-night",
            "nonmatching_observations": n, "max_nonmatching_observations": n,
            "first_validation_run_id": run_ids[0], "last_validation_run_id": run_ids[-1],
            "cycle_id": "cycle-row-1",
            "disclosure_fingerprint": disclosure_fingerprint(KIND, {
                "experiment_id": "exp-a", "finding_id": finding_id, "max_nonmatching_observations": n,
            }),
        })

    def test_a_standing_cut_is_disclosed_every_night_and_written_once(self) -> None:
        n = registered_n(self)
        self._hypothesis("exp-a")
        self._seed("exp-a", "U" * n)
        runner = self._runner()

        self._night_run(runner, cycle="cycle-row-1")
        for night in range(2, 5):
            payload = self._night_run(runner, cycle=f"cycle-row-{night}")
            self.assertEqual(self._ids(self._payload_cut(payload)), ["exp-a"], "the standing cut is disclosed nightly")

        self.assertEqual(len(self._cut_rows()), 1, "three more nights add zero rows")
        self.assertEqual(self._cut_rows()[0]["details"]["cycle_id"], "cycle-row-1")
        self.assertEqual(runner.calls, [])

    def test_the_claim_is_the_experiment_the_finding_and_the_limit(self) -> None:
        # More refuting runs behind the same cut are not a new claim; only a changed limit is (T12).
        n = registered_n(self)
        self._hypothesis("exp-a")
        self._seed("exp-a", "U" * n)
        self._night_run(self._runner(), cycle="cycle-row-1")
        self._seed("exp-a", "UUU")
        self._night_run(self._runner(), cycle="cycle-row-2")
        self.assertEqual(len(self._cut_rows()), 1)

    def test_a_cut_write_that_fails_is_recorded_as_a_cut_lane_error(self) -> None:
        # The writer is reached through whichever name the module imported it under: patch both.
        from aria_kernel import tool_registry
        from aria_kernel.tool_registry import GovernanceError

        n = registered_n(self)
        self._hypothesis("exp-a")
        self._seed("exp-a", "U" * n)
        refusal = GovernanceError("governance_unwritable")
        runner = self._runner()
        with mock.patch.object(tool_registry, "append_tools_governance_once", side_effect=refusal), \
                mock.patch.object(experiment_night, "append_tools_governance_once", side_effect=refusal, create=True):
            payload = self._night_run(runner)
        self.assertEqual([(e["lane"], e["error"]) for e in payload["errors"]], [("cut", "governance_unwritable")])
        self.assertEqual(runner.calls, [], "a cut that could not be recorded is still not run")


class DerivedNotLatchedTests(CutBase):
    """SPEC T12 — "is cut" is recomputed each night from the ledger and the policy; raising N re-arms it."""

    def test_raising_the_limit_re_arms_the_experiment_and_a_new_limit_is_a_new_claim(self) -> None:
        n = registered_n(self)
        self._hypothesis("exp-a")
        self._seed("exp-a", "U" * n)
        runner = self._runner()

        self._night_run(runner, cycle="cycle-rearm-0")
        self.assertEqual(runner.calls, [])
        self.assertEqual(len(self._cut_rows()), 1)
        first_row = self._cut_rows()[0]

        write_override(self.repo, {"max_nonmatching_observations": n + 3, "exempt_experiments": []})
        plan = self._plan()
        self.assertEqual(self._ids(plan["problem"]), ["exp-a"], "raising N must put the experiment back, with no state edit")
        self.assertEqual(self._planned_cut(plan), [])

        for night in range(1, 4):
            self._night_run(runner, cycle=f"cycle-rearm-{night}")
        self.assertEqual(runner.calls, ["exp-a"] * 3)
        self.assertEqual(len(self._cut_rows()), 1, "no second row while the experiment runs")

        self._night_run(runner, cycle="cycle-rearm-4")
        self.assertEqual(runner.calls, ["exp-a"] * 3, "cut again at the new limit")
        rows = self._cut_rows()
        self.assertEqual(len(rows), 2, "a changed limit is a changed claim and gets its own row")
        self.assertEqual(rows[0], first_row, "the first row is not rewritten")
        self.assertEqual([row["details"]["max_nonmatching_observations"] for row in rows], [n, n + 3])
        self.assertEqual(rows[1]["details"]["nonmatching_observations"], n + 3)

    def test_lowering_the_limit_cuts_what_the_ledger_already_holds(self) -> None:
        self._hypothesis("exp-a")
        self._seed("exp-a", "UUU")
        write_override(self.repo, {"max_nonmatching_observations": 3, "exempt_experiments": []})
        plan = self._plan()
        self.assertEqual(self._ids(plan["problem"]), [])
        self.assertEqual(self._ids(self._planned_cut(plan)), ["exp-a"])


class NotAVerdictOnTheFindingTests(CutBase):
    """SPEC T13 — D-8: a cut is the night planner's selection; the finding and its author are untouched."""

    def setUp(self) -> None:
        super().setUp()
        state_root = mock.patch.dict(os.environ, {"ARIA_REPO_STATE_ROOT": str(self.repo / "repo-state")})
        state_root.start()
        self.addCleanup(state_root.stop)

    def test_the_finding_stays_open_and_the_author_mints_no_replacement(self) -> None:
        from aria_kernel.experiment_author import author_night_experiments

        n = registered_n(self)
        finding_id = self._wrong_code_finding()
        authored = author_night_experiments(self.repo, cycle_id="cycle-author-1", base_dir=self.tools)
        self.assertEqual([a["finding_id"] for a in authored["authored"]], [finding_id])
        experiment_id = authored["authored"][0]["experiment_id"]
        self._seed(experiment_id, "U" * n)
        before = show_finding(self.repo, finding_id)
        events_before = _events_path(self.repo).read_bytes()
        runner = self._runner()

        payload = self._night_run(runner, cycle="cycle-cut-1")

        self.assertEqual(runner.calls, [])
        self.assertEqual(self._ids(self._payload_cut(payload)), [experiment_id])
        after = show_finding(self.repo, finding_id)
        self.assertEqual((after["status"], after["certainty"]), ("OPEN", "OBSERVED"))
        self.assertEqual(after, before, "a cut must not touch the finding")
        self.assertEqual(_events_path(self.repo).read_bytes(), events_before, "a cut writes no finding event")

        again = author_night_experiments(self.repo, cycle_id="cycle-author-2", base_dir=self.tools)
        self.assertEqual(again["authored"], [])
        self.assertEqual(again["deduped"], [finding_id])
        self.assertEqual(len(list_experiments(base_dir=self.tools)), 1)


class DigestAndReportTests(CutBase):
    """SPEC T14 — the night digest carries the cut and the report stops calling the night empty."""

    @staticmethod
    def _night_payload(**changes: Any) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "schema_version": 1, "cycle_id": "cyc-f06",
            "planned_problem": 0, "planned_regression": 0,
            "skipped_problem": 0, "skipped_regression": 0,
            "reproduced": [], "refuted": [], "regressions": [], "still_fixed": [],
            "unresolvable_bindings": [], "errors": [],
            "cut_problem": [], "unknown_exemptions": [],
        }
        payload.update(changes)
        return payload

    def _digest_and_section(self, payload: dict[str, Any]) -> tuple[dict[str, Any], str]:
        from aria_kernel import cycle as cycle_mod
        from aria_kernel.reflection import _render_experiment_night_section

        context = cycle_mod.build_phase_context(
            cycle_id="cyc-f06", workspace_root=self.repo, base_dir=self.tools,
        )
        context.results["experiment_night"] = payload
        context.outcomes["experiment_night"] = {"outcome": "ran"}
        with mock.patch.object(cycle_mod, "record_cycle_metrics", side_effect=lambda **kw: kw) as record:
            cycle_mod._phase_metrics(context)
        digests = record.call_args.kwargs["phase_digests"] or {}
        section = "\n".join(_render_experiment_night_section({"phase_digest_summary": {"digests": digests}}))
        return digests["experiment_night"], section

    def test_the_digest_counts_the_cut_and_the_unknown_exemptions(self) -> None:
        cut = [
            {"experiment_id": "exp-a", "finding_id": "F-001"},
            {"experiment_id": "exp-b", "finding_id": "F-002"},
        ]
        digest, _section = self._digest_and_section(self._night_payload(cut_problem=cut, unknown_exemptions=["x"]))
        self.assertEqual(digest.get("cut_problem"), 2)
        self.assertEqual(digest.get("unknown_exemptions"), 1)

    def test_a_night_that_cut_is_not_reported_empty(self) -> None:
        cut = [
            {"experiment_id": "exp-a", "finding_id": "F-001"},
            {"experiment_id": "exp-b", "finding_id": "F-002"},
        ]
        _digest, section = self._digest_and_section(self._night_payload(cut_problem=cut, unknown_exemptions=["x"]))
        self.assertNotIn("ran EMPTY", section)
        self.assertIn("- hypotheses cut after repeated non-matching observations: 2", section)
        self.assertIn("- exempt experiments no experiment carries: 1", section)

    def test_no_unknown_exemption_prints_no_unknown_exemption_line(self) -> None:
        cut = [{"experiment_id": "exp-a", "finding_id": "F-001"}]
        _digest, section = self._digest_and_section(self._night_payload(cut_problem=cut))
        self.assertIn("- hypotheses cut after repeated non-matching observations: 1", section)
        self.assertNotIn("exempt experiments no experiment carries", section)

    def test_a_night_with_no_cut_and_nothing_admitted_still_says_ran_empty(self) -> None:
        digest, section = self._digest_and_section(self._night_payload())
        self.assertEqual((digest.get("cut_problem"), digest.get("unknown_exemptions")), (0, 0))
        self.assertIn("ran EMPTY", section)

    def test_a_cut_night_with_runs_still_reports_the_runs(self) -> None:
        cut = [{"experiment_id": "exp-a", "finding_id": "F-001"}]
        _digest, section = self._digest_and_section(
            self._night_payload(planned_problem=2, refuted=[{"finding_id": "F-003"}, {"finding_id": "F-004"}], cut_problem=cut)
        )
        self.assertNotIn("ran EMPTY", section)
        self.assertIn("problem runs planned: 2", section)
        self.assertIn("- hypotheses cut after repeated non-matching observations: 1", section)


class NonmatchingStreakFunctionTests(unittest.TestCase):
    """SPEC D-1 — ``nonmatching_streaks`` is the one computer of the streak; pinned directly on literal rows."""

    @staticmethod
    def _row(experiment_id: str, letter: str, run: str, **extra: Any) -> dict[str, Any]:
        return {"experiment_id": experiment_id, "validation_run_id": run, **_ROW[letter], **extra}

    def _streaks(self, rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
        found = getattr(experiment_night, "nonmatching_streaks", None)
        self.assertTrue(callable(found), "experiment_night.nonmatching_streaks is not defined (F0.6 D-1)")
        return found(rows)

    def _count(self, streaks: dict[str, dict[str, Any]], experiment_id: str) -> int:
        return streaks.get(experiment_id, {"count": 0})["count"]

    def test_a_plain_streak_counts_every_observation_and_names_its_first_and_last_run(self) -> None:
        rows = [self._row("a", "U", f"run-{i}") for i in range(1, 5)]
        streak = self._streaks(rows)["a"]
        self.assertEqual((streak["count"], streak["first_run"], streak["last_run"]), (4, "run-1", "run-4"))

    def test_observations_are_counted_not_distinct_commits(self) -> None:
        rows = [self._row("a", "U", f"run-{i}", commit_sha="c" * 40) for i in range(1, 6)]
        self.assertEqual(self._count(self._streaks(rows), "a"), 5)

    def test_a_match_ends_the_streak_in_ledger_order(self) -> None:
        rows = [self._row("a", letter, f"run-{i}") for i, letter in enumerate("UUUMUU", start=1)]
        self.assertEqual(self._count(self._streaks(rows), "a"), 2)
        rows = [self._row("a", letter, f"run-{i}") for i, letter in enumerate("UUUUM", start=1)]
        self.assertEqual(self._count(self._streaks(rows), "a"), 0)

    def test_a_timeout_neither_adds_nor_ends(self) -> None:
        rows = [self._row("a", letter, f"run-{i}") for i, letter in enumerate("UUTTUT", start=1)]
        self.assertEqual(self._count(self._streaks(rows), "a"), 3)

    def test_experiments_are_counted_apart(self) -> None:
        rows = [
            self._row("a", "U", "r1"), self._row("b", "U", "r2"), self._row("a", "U", "r3"),
            self._row("c", "M", "r4"), self._row("a", "U", "r5"), self._row("b", "M", "r6"),
        ]
        streaks = self._streaks(rows)
        self.assertEqual([self._count(streaks, e) for e in "abc"], [3, 0, 0])

    def test_a_row_whose_matched_is_not_a_bool_is_ignored(self) -> None:
        # Neither an observation nor a match: it does not add, and it does not end the streak.
        ignored = (None, 1, 0, "false", "true", [], {})
        for value in ignored:
            with self.subTest(matched=repr(value)):
                rows = [
                    self._row("a", "U", "r1"), self._row("a", "U", "r2"),
                    {"experiment_id": "a", "validation_run_id": "r3", "matched": value, "run_status": "ok"},
                    self._row("a", "U", "r4"),
                ]
                self.assertEqual(self._count(self._streaks(rows), "a"), 3)

    def test_no_observation_is_no_streak(self) -> None:
        self.assertEqual(self._count(self._streaks([]), "a"), 0)


if __name__ == "__main__":
    unittest.main()
