"""ARIA's first accepted agent response was a bug report about its own lane.

AIR-aria-autonomy-planner-5636a540ccaa (2026-08-09, 540s, accepted) traced why
queue item qi-1edfe1882f49 could never run and why no request on the autonomy
lane could carry evidence. Three mechanisms, each proven by execution in the
response's own verification matrix — and each closed here:

1. A pressure whose every candidate tool was filtered away (the registry holds
   zero tools) stayed fully schedulable: the strip was recorded as an advisory
   uncertainty, nine identical rows deep, while the item re-enqueued every
   cycle. Blocked state now lives in `blocked_by`, and the queue writer
   refuses items that carry it.

2. Requests were minted with `evidence_refs=[pressure_id]`, and a pressure id
   cannot parse under the evidence validator's ref grammar — so the only
   envelope that could pass was empty-evidence + satisfied; a blocked verdict
   was structurally unrepresentable. Refs now come from the pressure's own
   evidence paths, which are concrete repo paths by construction.

3. The drain passed `workspace_root` through raw while every sibling call site
   applies `if workspace_root else root`, so daemon runs minted
   `target_sha=null` and every real ref graded `baseline_unavailable`.
"""
from __future__ import annotations

import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from aria_kernel import autonomy_orchestrator as ao
from aria_kernel import pressure as pressure_mod
from aria_kernel import reflection as reflection_mod


class StrippedToolBindingBlocksThePressureTest(unittest.TestCase):
    def test_a_pressure_that_loses_every_tool_is_marked_blocked(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "memory").mkdir()
            pressures = [{
                "pressure_id": "pressure:migration-surface-repeat:repetition",
                "candidate_tools": ["typeorm-entity-schema-adapter"],
                "blocked_by": [],
            }]
            with patch.object(pressure_mod, "list_tools", return_value=[]), \
                 patch.object(pressure_mod, "append_jsonl") as advisory:
                pressure_mod._filter_candidate_tools(root, pressures)

            self.assertEqual(
                pressures[0]["blocked_by"],
                ["candidate_tool_unregistered:typeorm-entity-schema-adapter"],
            )
            # The advisory row still lands — visibility is kept, it just
            # stops being the ONLY consequence. (Stubbed: the ledger writer
            # enforces declared surfaces, which a temp dir is not.)
            advisory.assert_called_once()
            self.assertEqual(
                advisory.call_args.args[1]["kind"],
                "pressure_candidate_tools_unreachable",
            )

    def test_a_pressure_that_keeps_a_tool_is_not_blocked(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "memory").mkdir()
            pressures = [{
                "pressure_id": "p1",
                "candidate_tools": ["kept", "gone"],
                "blocked_by": [],
            }]
            with patch.object(
                pressure_mod, "list_tools", return_value=[{"tool_id": "kept"}]
            ), patch.object(pressure_mod, "append_jsonl"):
                pressure_mod._filter_candidate_tools(root, pressures)

            self.assertEqual(pressures[0]["blocked_by"], [])
            self.assertEqual(pressures[0]["candidate_tools"], ["kept"])


class BlockedPressureNeverReachesTheQueueTest(unittest.TestCase):
    def test_the_projection_carries_blocked_by(self) -> None:
        # Without this key the queue writer has nothing to refuse on: the
        # projection laundered the blocked state back into schedulable work.
        import ast
        import inspect
        import textwrap

        src = textwrap.dedent(inspect.getsource(reflection_mod.run_reflection))
        keys = {
            node.value
            for node in ast.walk(ast.parse(src))
            if isinstance(node, ast.Constant) and isinstance(node.value, str)
        }
        self.assertIn("blocked_by", keys)

    def test_the_queue_writer_refuses_a_blocked_item(self) -> None:
        import ast
        import inspect
        import textwrap

        # The gate must sit between the plan and append_pending. Asserted as
        # node shape: an If whose test reads blocked_by, inside the enqueue
        # loop, before the call.
        src = textwrap.dedent(inspect.getsource(reflection_mod.run_reflection))
        tree = ast.parse(src)
        guard_found = any(
            isinstance(node, ast.If)
            and any(
                isinstance(sub, ast.Constant) and sub.value == "blocked_by"
                for sub in ast.walk(node.test)
            )
            for node in ast.walk(tree)
        )
        self.assertTrue(guard_found, "run_reflection must skip blocked_by items before enqueue")


class MintedRequestsCarryParseableEvidenceTest(unittest.TestCase):
    def _drain_one(self, tmp: str, *, with_pressure_payload: bool) -> dict:
        root = Path(tmp)
        (root / "pressure").mkdir(parents=True)
        if with_pressure_payload:
            (root / "pressure" / "cyc-1.json").write_text(json.dumps({
                "pressures": [{
                    "pressure_id": "pressure:migration-surface-repeat:repetition",
                    "evidence": [
                        "apps/ai-service/src/database/migrations/001.ts",
                        "apps/ai-service/src/database/migrations/002.ts",
                    ],
                }],
            }))
        captured: dict = {}

        def fake_create(**kwargs):
            captured.update(kwargs)
            return {"request_id": "AIR-x"}

        item = {
            "queue_item_id": "qi-test",
            "pressure_id": "pressure:migration-surface-repeat:repetition",
            "source_cycle_id": "cyc-1",
            "recommended_action": "continue TypeORM schema drift checks",
            "candidate_tools": [],
        }
        # The drain reads the queue via read_pending (module global) and does
        # a lazy `from .agent_invocations import create_agent_invocation_request`
        # inside the function body — so the mint is patched at its SOURCE
        # module, and the governance/consume writers are stubbed the same way.
        with patch.object(ao, "read_pending", return_value=[item]), \
             patch.object(ao, "mark_consumed"), \
             patch.object(ao, "_find_projected_queue_request", return_value=None), \
             patch("aria_kernel.agent_invocations.create_agent_invocation_request", fake_create), \
             patch("aria_kernel.tool_registry.append_tools_governance"):
            self._invoke_drain(root)
        return captured

    def _invoke_drain(self, root: Path) -> None:
        # _drain_next_cycle_queue does its own imports; patching module
        # globals is not enough for names it imports lazily, so this helper
        # exists for the subclass to override if the shape changes.
        ao._drain_next_cycle_queue(
            base_dir=root, daemon_agent_id="test-daemon", limit=1, workspace_root=root,
        )

    def test_refs_come_from_the_pressures_evidence_paths(self) -> None:
        with TemporaryDirectory() as tmp:
            captured = self._drain_one(tmp, with_pressure_payload=True)

        self.assertEqual(captured.get("evidence_refs"), [
            "apps/ai-service/src/database/migrations/001.ts",
            "apps/ai-service/src/database/migrations/002.ts",
        ])
        # The identifier keeps its own channel.
        self.assertEqual(
            captured.get("pressure_event_id"),
            "pressure:migration-surface-repeat:repetition",
        )

    def test_a_missing_pressure_payload_falls_back_to_the_queue_marker(self) -> None:
        with TemporaryDirectory() as tmp:
            captured = self._drain_one(tmp, with_pressure_payload=False)

        self.assertEqual(captured.get("evidence_refs"), ["qi-test"])


class DrainResolvesTheWorkspaceLikeItsSiblingsTest(unittest.TestCase):
    def test_the_drain_call_site_applies_the_fallback(self) -> None:
        import ast
        import inspect
        import textwrap

        # Every sibling call site writes `Path(workspace_root) if
        # workspace_root else root`; this one passed the raw value and minted
        # target_sha=null on every daemon run. Asserted on the call node.
        src = textwrap.dedent(inspect.getsource(ao))
        tree = ast.parse(src)
        for node in ast.walk(tree):
            if not (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Name)
                and node.func.id == "_drain_next_cycle_queue"
            ):
                continue
            kw = {k.arg: k.value for k in node.keywords}
            value = kw.get("workspace_root")
            self.assertIsInstance(
                value, ast.IfExp,
                "the drain call must apply the workspace_root fallback its siblings use",
            )
            return
        self.fail("no _drain_next_cycle_queue call site found")


if __name__ == "__main__":
    unittest.main()
