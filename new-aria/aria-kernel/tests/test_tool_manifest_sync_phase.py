"""The runtime tool registry finally has something that fills it.

`tools/aria-adapters/*.tool.json` is the declared single source for adapter
registrations, `registry_compiler` compiles them, the CLI carries `tool
register` — and none of it ran against the LIVE registry, which held zero
tools. Consequence, traced by ARIA's own first accepted agent response
(RC-1): `_filter_candidate_tools` stripped the schema-drift pressure's only
candidate tool every cycle, and the pressure re-enqueued as permanently
unrunnable work.

Same class as the claim reaper: the mechanism existed, nothing invoked it.
These pin the phase, its position (before anything reads the registry), and
the property that matters most: registration goes through the transition
matrix, so a quarantined tool stays quarantined.
"""
from __future__ import annotations

import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from aria_kernel import cycle as cycle_mod
from aria_kernel.tool_registry import ensure_tools_dir, list_tools, register_tool, transition_tool


_REAL_MANIFEST = (
    Path(__file__).resolve().parents[2]
    / "tools" / "aria-adapters" / "typeorm-entity-schema-adapter.tool.json"
)


def _manifest(tool_id: str, status: str = "SHADOW") -> dict[str, object]:
    """A valid manifest derived from the real shipped one.

    Derived, not hand-written: the validator's required shape (runner.cwd,
    timeout_ms, stdin_json, output_schema.required set, ...) already lives in
    the shipped manifests, and a hand-copy of it is the kind of second
    projection this same branch removes elsewhere.
    """
    base = json.loads(_REAL_MANIFEST.read_text(encoding="utf-8"))
    base["tool_id"] = tool_id
    base["status"] = status
    return base


class ToolManifestSyncPhaseTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = TemporaryDirectory()
        base = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)
        self.workspace = base / "repo"
        (self.workspace / "tools" / "aria-adapters").mkdir(parents=True)
        self.tools = base / "aria-tools"
        ensure_tools_dir(self.tools)

    def _context(self):
        return cycle_mod.build_phase_context(
            cycle_id="cyc-sync",
            workspace_root=self.workspace,
            base_dir=self.tools,
        )

    def _write_manifest(self, tool_id: str, status: str = "SHADOW") -> None:
        path = self.workspace / "tools" / "aria-adapters" / f"{tool_id}.tool.json"
        path.write_text(json.dumps(_manifest(tool_id, status)))

    def test_the_phase_exists_before_anything_reads_the_registry(self) -> None:
        names = [p.name for p in cycle_mod.CYCLE_PHASES]

        self.assertIn("tool_manifest_sync", names)
        self.assertLess(names.index("tool_manifest_sync"), names.index("tools"))
        self.assertLess(names.index("tool_manifest_sync"), names.index("pressure"))

    def test_it_is_an_action_and_cannot_fail_the_cycle(self) -> None:
        phase = next(p for p in cycle_mod.CYCLE_PHASES if p.name == "tool_manifest_sync")

        self.assertEqual(phase.precondition, cycle_mod.WRITES_PERMITTED)
        self.assertEqual(phase.on_error, "record_and_continue")

    def test_manifests_land_in_an_empty_registry(self) -> None:
        # The live shape: manifests in the repo, zero tools in the registry.
        self._write_manifest("typeorm-entity-schema-adapter")

        result = cycle_mod._phase_tool_manifest_sync(self._context())

        self.assertEqual(result["synced_tool_ids"], ["typeorm-entity-schema-adapter"])
        self.assertEqual(result["refused"], [])
        registered = {t["tool_id"] for t in list_tools(base_dir=self.tools)}
        self.assertIn("typeorm-entity-schema-adapter", registered)

    def test_the_sync_is_idempotent(self) -> None:
        self._write_manifest("adapter-a")
        ctx = self._context()

        cycle_mod._phase_tool_manifest_sync(ctx)
        second = cycle_mod._phase_tool_manifest_sync(ctx)

        self.assertEqual(second["refused"], [])
        rows = [t for t in list_tools(base_dir=self.tools) if t["tool_id"] == "adapter-a"]
        self.assertEqual(len(rows), 1)

    def test_a_quarantined_tool_stays_quarantined(self) -> None:
        # The property this pins is the STATUS, not the refusal count.
        # Pre-ORPHAN-625 the sync passed the manifest's birth status
        # verbatim, so the matrix refused every lifecycle-advanced tool —
        # which "protected" quarantine as a side effect while ALSO silently
        # dropping every runner-contract update (the live defect: a stale
        # timeout served two cycles after its fix merged). The sync now
        # carries the LIVE status: the re-registration succeeds as a
        # contract refresh, and quarantine survives because QUARANTINED is
        # what gets re-registered — the audited unquarantine path remains
        # the only way back.
        self._write_manifest("risky-adapter", status="SHADOW")
        # Quarantine the way production does: initial registration, then the
        # audited transition — register_tool itself refuses a first
        # registration at QUARANTINED.
        register_tool(_manifest("risky-adapter", status="SHADOW"), base_dir=self.tools)
        transition_tool(
            tool_id="risky-adapter", target_status="QUARANTINED",
            reason="test: simulated quarantine", base_dir=self.tools,
        )

        result = cycle_mod._phase_tool_manifest_sync(self._context())

        self.assertEqual(result["refused"], [])
        rows = [t for t in list_tools(base_dir=self.tools) if t["tool_id"] == "risky-adapter"]
        self.assertEqual(rows[0]["status"], "QUARANTINED")

    def test_the_real_repo_manifests_all_register(self) -> None:
        # Not a fixture: the six shipped manifests must survive their own
        # sync, else the phase is green in tests and refuses in production.
        repo_manifests = Path(__file__).resolve().parents[2] / "tools" / "aria-adapters"
        ctx = cycle_mod.build_phase_context(
            cycle_id="cyc-real",
            workspace_root=repo_manifests.parents[1],
            base_dir=self.tools,
        )

        result = cycle_mod._phase_tool_manifest_sync(ctx)

        self.assertEqual(result["refused"], [])
        self.assertIn("typeorm-entity-schema-adapter", result["synced_tool_ids"])
        self.assertGreaterEqual(len(result["synced_tool_ids"]), 6)


if __name__ == "__main__":
    unittest.main()
