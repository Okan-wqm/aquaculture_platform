"""ARIA-MEDIUM-029 — the execution spine's PRODUCER behaviour, importable at any base.

Split from ``test_execution_spine.py`` so the closure can be re-proven red at
the commit before its fix: the two checks here never import the new
``execution_spine`` API at module load. ``ARIAActorIsUnread`` scans the source
tree (nothing to import), and ``CycleSessionSpineTests`` runs the real cycle and
asserts the declared ``sessions/session-ledger.jsonl`` surface exists before it
reaches for ``ACTOR_KINDS``. At a base without the fix both fail on the defect
itself — a module reading ``ARIA_ACTOR``, and a cycle that never writes the
session ledger — not on an ImportError (re-proof 2026-10-22, landings/slow-c/
reproof.md). ``test_execution_spine.py`` keeps the API's unit invariants.
"""

from __future__ import annotations

import ast
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

_PARENT = Path(__file__).resolve().parents[1]
if str(_PARENT) not in sys.path:
    sys.path.insert(0, str(_PARENT))


def _hermetic_environ() -> dict[str, str]:
    """The process env minus every ``GIT_*`` variable.

    HANDOVER 2026-10-18 §2: a fixture that runs git in a temp repo must drop
    every ``GIT_*`` variable in Python. In a linked worktree an inherited
    ``GIT_DIR`` rewrote a real branch once (10-18 incident); this suite's
    fixture cycle runs git through ``tests._helpers.production_shaped``.
    """
    return {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}



class ARIAActorIsUnread(unittest.TestCase):
    """Part A — the env var nobody sets is now the env var nobody reads."""

    ROOTS = (
        Path(__file__).resolve().parents[1] / "aria_kernel",
        Path(__file__).resolve().parents[2] / "tools" / "aria-poc",
    )

    def test_no_kernel_or_poc_module_reads_aria_actor(self) -> None:
        offenders: list[str] = []
        for root in self.ROOTS:
            for path in sorted(root.rglob("*.py")):
                tree = ast.parse(path.read_text(encoding="utf-8"))
                for node in ast.walk(tree):
                    if (
                        isinstance(node, ast.Constant)
                        and isinstance(node.value, str)
                        and node.value == "ARIA_ACTOR"
                    ):
                        offenders.append(f"{path.relative_to(root.parent.parent)}:{node.lineno}")
        self.assertEqual(
            offenders, [],
            "ARIA_ACTOR must have no reader: identity is derived from the "
            f"platform, not declared by the environment. Offenders: {offenders}",
        )



class CycleSessionSpineTests(unittest.TestCase):
    """Part B — a real cycle run is the session ledger's producer.

    Production-shaped: the workspace comes from ``cycle_workspace`` (a git
    repo with history, the shape the cycle discovers), the mission comes
    from the kernel's own ``open_mission`` mint (the same producer the
    service-seed phase uses), and the cycle is ``run_enterprise_cycle``
    itself — the nightly entry point — under a GIT_*-stripped environment.
    """

    def test_a_cycle_run_writes_its_session_thread(self) -> None:
        from aria_kernel.cycle import run_enterprise_cycle
        from aria_kernel.mission import open_mission
        from aria_kernel.workspace import repo_hash
        from tests._helpers.production_shaped import cycle_workspace

        cycle_id = "cyc-029-spine"
        with tempfile.TemporaryDirectory(prefix="aria-029-cycle-") as tmp:
            fixture = cycle_workspace(Path(tmp))
            open_mission(
                source_kind="service_hardening",
                source_id="fixture-svc",
                repo_hash=repo_hash(fixture.workspace_root),
                title="Harden fixture-svc (session spine fixture)",
                next_action="Examine fixture-svc against the spine fixture",
                wake_condition={"kind": "evidence", "key": "changed_path:src/app.ts"},
                evidence_refs=["src/app.ts:1"],
                capability="service_hardening",
                base_dir=fixture.tools_dir,
            )
            with mock.patch.dict(os.environ, _hermetic_environ(), clear=True):
                state = run_enterprise_cycle(
                    workspace_root=fixture.workspace_root,
                    cycle_id=cycle_id,
                    base_dir=fixture.tools_dir,
                    workspace_base=Path(tmp) / "ws",
                )
            self.assertEqual(state["status"], "completed", state.get("failure_reason"))
            selected = state.get("mission_selection") or {}
            self.assertEqual(selected.get("outcome"), "selected", selected)

            ledger_path = fixture.tools_dir / "sessions" / "session-ledger.jsonl"
            self.assertTrue(
                ledger_path.exists(),
                "the cycle must produce the declared sessions/session-ledger.jsonl surface",
            )
            # Imported only once the producer is shown to exist: at a base without
            # the spine, this test must fail on the missing ledger (the defect),
            # not on an import of the API the fix introduces.
            from aria_kernel.execution_spine import ACTOR_KINDS

            rows = [
                json.loads(line)
                for line in ledger_path.read_text().splitlines()
                if line.strip()
            ]
            self.assertEqual(
                [row["event"] for row in rows],
                ["session_started", "mission_bound", "session_completed"],
                rows,
            )
            for row in rows:
                self.assertEqual(row["session_id"], f"sess-{cycle_id}")
                self.assertEqual(row["cycle_id"], cycle_id)
                self.assertIn(row["actor"]["kind"], ACTOR_KINDS, row)
                self.assertNotEqual(row["actor"]["kind"], "human", row)

            # The started cycle row carries the same thread: the derived
            # actor block and the session id it opened.
            cycle_rows = [
                json.loads(line)
                for line in (fixture.tools_dir / "cycles.jsonl").read_text().splitlines()
                if line.strip()
            ]
            started = next(
                row for row in cycle_rows
                if row.get("cycle_id") == cycle_id and row.get("event") == "started"
            )
            self.assertEqual(started.get("session_id"), f"sess-{cycle_id}")
            self.assertIn(started["actor"]["kind"], ACTOR_KINDS, started)

            # Governance rows appended INSIDE the cycle carry the session id
            # (bootstrap rows written before the session began do not).
            governance = [
                json.loads(line)
                for line in (fixture.tools_dir / "governance.jsonl").read_text().splitlines()
                if line.strip()
            ]
            in_cycle = [row for row in governance if row.get("session_id") == f"sess-{cycle_id}"]
            self.assertTrue(
                in_cycle,
                "no governance row written inside the cycle carries the session id",
            )
            schedule_rows = [
                row for row in in_cycle
                if row.get("kind") == "mission_schedule_decided"
            ]
            self.assertTrue(schedule_rows, in_cycle)



if __name__ == "__main__":
    unittest.main()
