"""Wave 0 §0.5 — the burn-in lane is a MODE of the pipeline, not a loop.

Pre-collapse `burn_in.run_observe_burn_in` was a THIRD hand-rolled cycle
loop: it appended its own started/terminal ledger rows and called five
observe primitives directly, importing `cycle`'s private event factories.
Its no-action guarantee ("no claim / tool / PR surface touched") lived in
a docstring and in the accident of which functions the loop happened to
call. These tests pin the property in its new home — the ``modes`` column
of ``CYCLE_PHASES`` — so widening the burn-in lane is a reviewed table
edit, never a drift.

WHAT IS ASSERTED HERE, and why each one is not obvious:

  1. the burn-in phase set is EXACTLY the observe set — a phase joining
     ``burn_in`` by omission (or falling out of it) is the regression this
     table exists to make impossible, so the membership is stated once as
     data and once here as a test;
  2. a phase declared without ``modes`` is standard-only — the default is
     the safe direction, and a test states it so a future field reorder
     cannot silently flip it;
  3. a standard cycle records the burn-in-only phase as a SKIP naming the
     mode, because "not in this lane" and "silently absent" being the same
     observation is the defect class the collapse removed;
  4. an unknown mode is refused before the started ledger row lands — a
     typo'd mode that half-runs a cycle would corrupt the lifecycle ledger;
  5. `burn_in.py` imports no cycle-phase primitive any more — the second
     entrance cannot be quietly reintroduced (I-W0-01's shape).
"""

from __future__ import annotations

import ast
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aria_kernel import burn_in as burn_in_mod
from aria_kernel import cycle as cycle_mod
from aria_kernel.cycle import (
    CYCLE_MODES,
    CYCLE_PHASES,
    CyclePhase,
    _assert_pipeline_is_well_formed,
    run_enterprise_cycle,
)
from aria_kernel.ledger import load_jsonl
from aria_kernel.tool_registry import GovernanceError

# The observe set. This is the SSoT's expected projection, restated as a
# literal on purpose: if the table changes, this test must be edited in
# the same diff, which is exactly the review moment the mode column buys.
BURN_IN_PHASES = {
    # PLAN Wave 1 §2.5 — `state_continuity` joins the observe lane, and this
    # is the reviewed decision the mode column exists to demand.
    #
    # It reads and refuses; it touches no claim, tool, PR or merge surface, so
    # the lane's no-action guarantee is intact. The reason it must be HERE and
    # not only in the standard lane is what the burn-in lane is FOR: its
    # output is the acceptance evidence the autonomy ladder counts toward an
    # unlock. Evidence gathered on a tree that forgot its history is exactly
    # the evidence that must not count — the same argument
    # `verdict_from_rows`' continuity check makes about a gap between
    # acceptance rows, one layer earlier.
    "state_continuity",
    "discovery",
    "cycle_diff",
    # PLAN Wave 3 — `twin_refresh` joins the observe lane, by the same
    # argument and with the same evidence.
    #
    # It writes ONE surface, `twin_map`, which is declared `observation` and
    # is DERIVED: every byte recomputable from the repository at
    # `indexed_sha`. No claim, tool, PR or merge surface is touched, so the
    # lane's no-action guarantee is intact — refreshing a projection of the
    # tree is not an action ON the tree.
    #
    # And it must be HERE rather than standard-only for the reason above:
    # the burn-in lane's output is the acceptance evidence the ladder counts.
    # A map frozen at some past commit would have the observe lane judging a
    # repository that no longer exists, which is the same defect as gathering
    # evidence on a tree that forgot its history.
    "twin_refresh",
    "memory",
    "pressure",
    "triage",
    "artifact_integrity",
}


class ModeDeclarationTests(unittest.TestCase):
    def test_the_burn_in_phase_set_is_exactly_the_observe_set(self) -> None:
        declared = {p.name for p in CYCLE_PHASES if "burn_in" in p.modes}
        self.assertEqual(
            declared, BURN_IN_PHASES,
            "the burn-in lane's membership changed — that is a reviewed "
            "decision about what an observe burn-in is allowed to touch, "
            "not a side effect",
        )

    def test_triage_belongs_to_the_burn_in_lane_only(self) -> None:
        triage = next(p for p in CYCLE_PHASES if p.name == "triage")
        self.assertEqual(
            triage.modes, frozenset({"burn_in"}),
            "triage in the standard cycle would double the nightly's "
            "triage path (reflection owns it there)",
        )

    def test_a_phase_declared_without_modes_is_standard_only(self) -> None:
        """The default must point away from the burn-in lane.

        A new phase added without thinking about modes lands in the
        standard cycle only; joining burn_in requires writing it down.
        """
        phase = CyclePhase("probe", "post_tool", lambda _c: {})
        self.assertEqual(phase.modes, frozenset({"standard"}))

    def test_the_well_formed_check_bites_on_modes(self) -> None:
        good = CYCLE_PHASES
        empty_modes = good + (
            CyclePhase(
                "modeless", "post_tool", good[0].runner, modes=frozenset(),
            ),
        )
        unknown_mode = good + (
            CyclePhase(
                "wanderer", "post_tool", good[0].runner,
                modes=frozenset({"standard", "shadow"}),
            ),
        )
        for label, table in (
            ("empty modes", empty_modes),
            ("unknown mode", unknown_mode),
        ):
            with self.subTest(malformation=label):
                with patch.object(cycle_mod, "CYCLE_PHASES", table):
                    with self.assertRaises(ValueError):
                        _assert_pipeline_is_well_formed()

    def test_burn_in_imports_no_cycle_phase_primitive(self) -> None:
        """The third loop stays dead — checked at the import statements.

        `run_observe_burn_in` collapsing into `run_enterprise_cycle` is only
        durable if burn_in.py cannot quietly re-acquire the pieces a
        hand-rolled loop needs: the private event factories and the observe
        primitives. The module's imports are the narrowest honest witness.
        """
        tree = ast.parse(Path(burn_in_mod.__file__).read_text(encoding="utf-8"))
        from_cycle: set[str] = set()
        forbidden_modules = {"discovery", "cycle_diff", "memory", "pressure", "triage"}
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom):
                module = (node.module or "").lstrip(".")
                if module == "cycle":
                    from_cycle.update(alias.name for alias in node.names)
                self.assertNotIn(
                    module, forbidden_modules,
                    f"burn_in.py imports {module} again — the observe "
                    "primitives belong to the pipeline's phase runners now",
                )
        self.assertEqual(
            from_cycle, {"_failed_event", "run_enterprise_cycle"},
            "burn_in.py's imports from cycle widened — a hand-rolled loop "
            "starts exactly this way",
        )


class ModeExecutionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-burnin-mode-"))
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

    def test_a_burn_in_cycle_runs_the_observe_set_and_nothing_else(self) -> None:
        state = run_enterprise_cycle(
            workspace_root=self.repo,
            cycle_id="cycle-mode-burnin",
            base_dir=self.tools,
            workspace_base=self.tmp / "ws",
            mode="burn_in",
        )
        self.assertEqual(state["status"], "completed")
        ran = {name for name, o in state["phases"].items() if o["outcome"] == "ran"}
        self.assertEqual(ran, BURN_IN_PHASES)
        for phase in CYCLE_PHASES:
            if "burn_in" in phase.modes:
                continue
            with self.subTest(phase=phase.name):
                outcome = state["phases"][phase.name]
                self.assertEqual(outcome["outcome"], "skipped")
                self.assertEqual(outcome["reason"], "mode_not_included:burn_in")
        # The observe payloads land under their declared state keys — this
        # is what run_observe_burn_in derives its evidence bundle from.
        for key in ("discovery", "cycle_diff", "memory", "pressure", "triage"):
            with self.subTest(state_key=key):
                self.assertIsInstance(state[key], dict)

    def test_a_burn_in_cycle_skips_the_learning_hooks_by_mode(self) -> None:
        state = run_enterprise_cycle(
            workspace_root=self.repo,
            cycle_id="cycle-mode-burnin-learning",
            base_dir=self.tools,
            workspace_base=self.tmp / "ws",
            mode="burn_in",
        )
        self.assertEqual(
            state["learning"]["pre_cycle"],
            {"hooks": [], "skipped": "mode:burn_in"},
            "the learning pass's pressure-decay/prune writes are "
            "standard-lane bookkeeping; the pre-collapse burn-in never "
            "ran them and the mode must keep it that way",
        )
        self.assertEqual(state["learning"]["hooks"], [])

    def test_the_pipeline_owns_the_terminal_row_in_burn_in_mode(self) -> None:
        run_enterprise_cycle(
            workspace_root=self.repo,
            cycle_id="cycle-mode-burnin-ledger",
            base_dir=self.tools,
            workspace_base=self.tmp / "ws",
            mode="burn_in",
        )
        rows = [
            row for row in load_jsonl(self.tools / "cycles.jsonl")
            if row.get("cycle_id") == "cycle-mode-burnin-ledger"
        ]
        events = [row.get("event") for row in rows]
        self.assertEqual(
            events.count("started"), 1,
            "the started row has one owner — the pipeline",
        )
        terminal = [e for e in events if e in {"completed", "failed", "stopped", "aborted"}]
        self.assertEqual(
            terminal, ["completed"],
            "exactly one terminal row per cycle; a second one is the "
            "double-close the old hand-rolled loop risked",
        )

    def test_a_standard_cycle_skips_triage_naming_the_mode(self) -> None:
        state = run_enterprise_cycle(
            workspace_root=self.repo,
            cycle_id="cycle-mode-standard",
            base_dir=self.tools,
            shadow_only=True,
        )
        triage = state["phases"]["triage"]
        self.assertEqual(triage["outcome"], "skipped")
        self.assertEqual(triage["reason"], "mode_not_included:standard")
        self.assertEqual(
            state["triage"], {},
            "a skipped phase projects its declared absent() value — a "
            "populated dict here would mean triage ran in the standard lane",
        )

    def test_an_unknown_mode_is_refused_before_any_ledger_write(self) -> None:
        with self.assertRaises(GovernanceError) as ctx:
            run_enterprise_cycle(
                workspace_root=self.repo,
                cycle_id="cycle-mode-typo",
                base_dir=self.tools,
                mode="burnin",
            )
        self.assertIn("cycle_mode_unknown", str(ctx.exception))
        self.assertIn(str(list(CYCLE_MODES)), str(ctx.exception))
        self.assertFalse(
            (self.tools / "cycles.jsonl").exists(),
            "an invalid mode must be refused before the started row lands, "
            "or the lifecycle ledger records a cycle that never was",
        )


if __name__ == "__main__":
    unittest.main()
