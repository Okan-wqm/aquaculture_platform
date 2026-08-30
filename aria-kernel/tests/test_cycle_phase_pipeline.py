"""RC-1 — CYCLE_PHASES is the pipeline, and these are its properties.

SUCCESSOR TO TWO FILES, both deleted with this one added, because both were
named for and built on a mechanism that no longer exists:

  * `test_cycle_phase_chain_m1.py` pinned `DEFAULT_CYCLE_PHASES` and
    `SUPPORTED_CYCLE_PHASES` — two constants that validated the `run_phases`
    kwarg, named five of the cycle's fifteen phases, and got one of those five
    names wrong (`discover` where the body emits `discovery`).
    ORPHAN-HIGH-505. A test asserting a constant is exactly a given list is
    load-bearing only if the list is true; that one pinned the error in place.
  * `test_cycle_phase_ordering.py` pinned that `pre_tool_phases` dispatched
    before the tool loop and that an unknown phase name raised. Ordering is now
    a property of the table's `stage` field, and an unknown phase name is no
    longer expressible — there is no phase-name input to get wrong.

Their surviving behavioural coverage moved here rather than being dropped, and
the dispatch cases they duplicated (`validation_matrix` and `pr_lifecycle`
returning `no_op`) already live in `test_cycle_validation_matrix_phase.py` and
`test_cycle_pr_lifecycle_phase.py`, so they are not restated a third time.

WHAT IS ASSERTED HERE, and why each one is not obvious:

  1. the table is well-formed, and `_assert_pipeline_is_well_formed` BITES —
     an import-time check nobody has seen fail is indistinguishable from one
     that cannot fail;
  2. a phase whose precondition is unmet leaves a recorded skip naming the
     precondition, because "the gate is not wired" and "the gate passed" being
     the same observation is the whole defect this collapse removes;
  3. the phase kwargs are gone from `run_enterprise_cycle`'s signature, so a
     second entrance cannot be reintroduced quietly;
  4. patching a `_phase_*` module attribute is INERT, stated as a test so a
     future author learns it from a failure rather than from a green run that
     proved nothing.
"""

from __future__ import annotations

import inspect
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aria_kernel import cycle as cycle_mod
from aria_kernel.cycle import (
    ALWAYS,
    CYCLE_PHASES,
    CYCLE_PRECONDITIONS,
    CYCLE_STAGES,
    CyclePhase,
    PhasePrecondition,
    _assert_pipeline_is_well_formed,
    run_enterprise_cycle,
)


class PipelineDeclarationTests(unittest.TestCase):
    def test_every_stage_is_populated_and_in_order(self) -> None:
        """A stage with no rows is a stage the cycle silently does not have."""
        stages = [phase.stage for phase in CYCLE_PHASES]
        self.assertEqual(
            sorted(set(stages), key=CYCLE_STAGES.index), list(CYCLE_STAGES),
            "a declared stage has no phases, or a phase declares an unknown stage",
        )
        self.assertEqual(
            stages, sorted(stages, key=CYCLE_STAGES.index),
            "CYCLE_PHASES rows are not grouped in stage order",
        )

    def test_the_precondition_vocabulary_is_closed(self) -> None:
        for phase in CYCLE_PHASES:
            with self.subTest(phase=phase.name):
                self.assertTrue(
                    any(phase.precondition is known for known in CYCLE_PRECONDITIONS),
                    f"{phase.name} declares a precondition outside CYCLE_PRECONDITIONS",
                )

    def test_the_pr_open_gate_reads_the_permission_table(self) -> None:
        """The phase's gate and the callee's guard must be the same table.

        `open_pr_for_action` calls `enforce_profile_for_action("pr_open")`. If
        this phase ran under a profile that table refuses, every approved
        proposal would take a GovernanceError and the cycle would report
        failure on a lane where nothing is wrong. The plan specified the UNION
        over all action kinds, which includes `standard` — the default profile.
        """
        from aria_kernel.runtime_profile import ACTION_PERMISSIONS

        phase = next(p for p in CYCLE_PHASES if p.name == "pr_lifecycle")
        for profile in ACTION_PERMISSIONS["pr_open"]:
            with self.subTest(profile=profile, permitted=True):
                self.assertTrue(phase.precondition.test(_context_with_profile(profile)))
        for profile in ("observe", "frozen", "standard"):
            with self.subTest(profile=profile, permitted=False):
                self.assertFalse(phase.precondition.test(_context_with_profile(profile)))

    def test_the_well_formed_check_bites(self) -> None:
        """Four ways to malform the table; each must fail the import-time check."""
        good = CYCLE_PHASES
        duplicate_name = good + (good[0],)
        out_of_stage_order = (good[-1],) + good
        foreign = PhasePrecondition("smuggled", lambda _c: True)
        unknown_precondition = good[:-1] + (
            CyclePhase(
                "smuggled_phase", good[-1].stage, good[-1].runner, precondition=foreign,
            ),
        )
        duplicate_key = good + (
            CyclePhase(
                "another_memory", "post_tool", good[0].runner,
                precondition=ALWAYS, state_key="memory",
            ),
        )
        for label, table in (
            ("duplicate name", duplicate_name),
            ("out of stage order", out_of_stage_order),
            ("unknown precondition", unknown_precondition),
            ("duplicate state key", duplicate_key),
        ):
            with self.subTest(malformation=label):
                with patch.object(cycle_mod, "CYCLE_PHASES", table):
                    with self.assertRaises(ValueError):
                        _assert_pipeline_is_well_formed()

    def test_the_phase_kwargs_are_gone_for_good(self) -> None:
        """A second entrance into the same phases is what RC-1 removed.

        Asserted against the signature rather than by reading the body: a
        reintroduced `run_phases=` would compile, pass every other test, and
        restore the exact condition in which four safety phases sat unexecuted
        for the life of the branch.
        """
        parameters = inspect.signature(run_enterprise_cycle).parameters
        for banned in ("run_phases", "pre_tool_phases"):
            self.assertNotIn(
                banned, parameters,
                f"{banned} is back — the phase list is the table, not an argument",
            )

    def test_patching_a_phase_runner_attribute_is_inert(self) -> None:
        """Stated as a test because the alternative is a silent false positive.

        CYCLE_PHASES captured each runner's function object at import, so
        `patch.object(cycle, "_phase_x")` rebinds a module attribute the driver
        never reads. A test written that way runs the REAL phase and passes,
        and its author concludes it proved a wiring property it never touched —
        ORPHAN-HIGH-499's shape exactly. Inject at the collaborator the runner
        calls (those ARE looked up at call time), not at the runner.
        """
        sentinel = object()
        with patch.object(cycle_mod, "_phase_memory", lambda _c: sentinel):
            phase = next(p for p in CYCLE_PHASES if p.name == "memory")
            self.assertIsNot(
                phase.runner, cycle_mod._phase_memory,
                "the table now resolves runners dynamically — if that is a "
                "deliberate change, delete this test; until then a reader must "
                "not believe patching the attribute works",
            )


def _context_with_profile(profile: str) -> cycle_mod.PhaseContext:
    """A context differing from a real one only in the field under test."""
    with tempfile.TemporaryDirectory(prefix="aria-phase-ctx-") as tmp:
        context = cycle_mod.build_phase_context(
            cycle_id="cyc-profile-probe",
            workspace_root=Path(tmp),
            base_dir=Path(tmp) / "aria-tools",
        )
    return cycle_mod.PhaseContext(
        cycle_id=context.cycle_id,
        workspace_root=context.workspace_root,
        base_dir=context.base_dir,
        workspace=context.workspace,
        plan_id=context.plan_id,
        shadow_only=context.shadow_only,
        defer_reflection=context.defer_reflection,
        snapshot_mode=context.snapshot_mode,
        profile=profile,
        cycle_started_at=context.cycle_started_at,
        started_monotonic=context.started_monotonic,
        results={},
        outcomes={},
    )


class PipelineExecutionTests(unittest.TestCase):
    """The behaviour the two deleted files covered, against the new pipeline."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-pipeline-"))
        self.repo = self.tmp / "repo"
        self.repo.mkdir()
        subprocess.run(["git", "init", "-q"], cwd=self.repo, check=True)
        subprocess.run(["git", "config", "user.email", "t@t.invalid"], cwd=self.repo, check=True)
        subprocess.run(["git", "config", "user.name", "t"], cwd=self.repo, check=True)
        (self.repo / "x.ts").write_text("export const x = 1;\n", encoding="utf-8")
        subprocess.run(["git", "add", "."], cwd=self.repo, check=True)
        subprocess.run(
            ["git", "commit", "-q", "-m", "init"],
            cwd=self.repo, check=True, capture_output=True,
        )
        self.tools = self.tmp / "aria-tools"

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_a_discovery_only_cycle_completes_and_reports_its_phases(self) -> None:
        state = run_enterprise_cycle(
            workspace_root=self.repo,
            cycle_id="cycle-pipeline-discovery",
            base_dir=self.tools,
            discovery_only=True,
        )
        self.assertEqual(state["status"], "completed")
        self.assertEqual(state["phases"]["discovery"]["outcome"], "ran")
        self.assertEqual(state["phases"]["cycle_diff"]["outcome"], "ran")
        self.assertNotIn(
            "tools", state["phases"],
            "a discovery-only cycle returns before the tool stage, so no later "
            "phase should have an outcome at all",
        )

    def test_an_unmet_precondition_is_a_recorded_skip_naming_the_reason(self) -> None:
        """The property whose absence WAS the defect.

        `architecture_baseline` needs a plan_id and no production caller
        supplies one, so it does not run — but before the collapse a phase that
        did not run produced nothing: no key, no reason, no trace. "This gate
        is not wired" and "this gate passed" were the same observation from
        outside. They are different rows now.
        """
        state = run_enterprise_cycle(
            workspace_root=self.repo,
            cycle_id="cycle-pipeline-skip",
            base_dir=self.tools,
            shadow_only=True,
        )
        baseline = state["phases"]["architecture_baseline"]
        self.assertEqual(baseline["outcome"], "skipped")
        self.assertEqual(baseline["reason"], "precondition_unmet:plan_id_present")

        # And a no-write cycle skips the write-class phases for a DIFFERENT
        # stated reason, so an operator can tell the two apart.
        decay = state["phases"]["belief_decay"]
        self.assertEqual(decay["outcome"], "skipped")
        self.assertEqual(decay["reason"], "precondition_unmet:writes_permitted")

    def test_a_pre_tool_phase_runs_before_the_tool_loop(self) -> None:
        """Plan 023 v3 §R-1, now a property of the table rather than a kwarg.

        Order is asserted by observation — the sequence phases were recorded
        in — rather than by reading the table that is supposed to produce it.
        """
        state = run_enterprise_cycle(
            workspace_root=self.repo,
            cycle_id="cycle-pipeline-order",
            base_dir=self.tools,
            shadow_only=True,
            plan_id="PLAN-PIPELINE-ORDER",
        )
        recorded = list(state["phases"])
        self.assertIn("architecture_baseline", recorded)
        self.assertIn("tools", recorded)
        self.assertLess(
            recorded.index("architecture_baseline"), recorded.index("tools"),
            "the architecture baseline observed consequences instead of "
            "preconditions — it must run before tool dispatch",
        )
        self.assertLess(
            recorded.index("tools"), recorded.index("memory"),
            "a post-tool phase ran before the tool loop",
        )


if __name__ == "__main__":
    unittest.main()
