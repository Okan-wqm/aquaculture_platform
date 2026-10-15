"""ARIA-MEDIUM-473 — pressure's ledger wrappers resolve surfaces through the manifest.

pressure.py used to carry its own ``(parent, filename) -> surface`` table, a
second copy of facts ``state_manifest.STATE_SURFACES`` already owns. The copy
could only drift: a surface moved in the manifest kept resolving in the ledger
layer but was refused by pressure's wrappers. These tests pin the wrappers to
the manifest, and pin that an undeclared path still fails closed.
"""
from __future__ import annotations

import dataclasses
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from aria_kernel import pressure, state_manifest
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir


class PressureSurfaceRouting(unittest.TestCase):
    def setUp(self) -> None:
        self._td = tempfile.TemporaryDirectory()
        self.root = ensure_tools_dir(Path(self._td.name) / "aria-tools")
        (self.root / "pressure").mkdir(parents=True, exist_ok=True)

    def tearDown(self) -> None:
        self._td.cleanup()

    def test_wrappers_follow_the_manifest_not_a_local_table(self) -> None:
        moved = tuple(
            dataclasses.replace(surface, path_pattern="pressure/pressure-log-v2.jsonl")
            if surface.name == "pressure_log"
            else surface
            for surface in state_manifest.STATE_SURFACES
        )
        target = self.root / "pressure" / "pressure-log-v2.jsonl"
        with mock.patch.object(state_manifest, "STATE_SURFACES", moved), \
                mock.patch.object(pressure, "append_declared_jsonl") as append, \
                mock.patch.object(pressure, "load_declared_jsonl") as load:
            pressure.append_jsonl(target, {"x": 1})
            pressure.load_jsonl(target)
        append.assert_called_once_with(
            target, {"x": 1}, expected_surface="pressure_log",
        )
        load.assert_called_once_with(target, expected_surface="pressure_log")

    def test_undeclared_path_still_fails_closed(self) -> None:
        target = self.root / "pressure" / "nope.jsonl"
        with self.assertRaisesRegex(GovernanceError, "pressure_append_unknown_surface"):
            pressure.append_jsonl(target, {})
        with self.assertRaisesRegex(GovernanceError, "pressure_load_unknown_surface"):
            pressure.load_jsonl(target)
        self.assertFalse(target.exists())


if __name__ == "__main__":
    unittest.main()
