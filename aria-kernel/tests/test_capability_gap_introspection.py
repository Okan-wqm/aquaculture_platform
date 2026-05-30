from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from aria_kernel.capability_gap import _gaps_from_adapter_registry


class CapabilityGapIntrospectionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-capability-registry-"))
        self.repo = self.tmp / "repo"
        self.repo.mkdir()
        self.tools = self.tmp / "aria-tools"
        self.tools.mkdir()
        self.manifests = self.repo / "tools" / "aria-adapters"
        self.manifests.mkdir(parents=True)

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _registry(self, tools: list[dict[str, object]]) -> None:
        (self.tools / "registry.json").write_text(
            json.dumps({"schema_version": 2, "tools": tools}, indent=2, sort_keys=True),
            encoding="utf-8",
        )

    def _manifest(self, tool_id: str) -> None:
        (self.manifests / f"{tool_id}.tool.json").write_text(
            json.dumps({"tool_id": tool_id}, indent=2, sort_keys=True),
            encoding="utf-8",
        )

    def _gaps(self) -> list[dict[str, object]]:
        return _gaps_from_adapter_registry(
            "cycle-1",
            SimpleNamespace(repo_root=self.repo),
            self.tools,
            "sha256:index",
        )

    def test_stub_runner_detected(self) -> None:
        self._manifest("stub-adapter")
        self._registry([
            {
                "tool_id": "stub-adapter",
                "runner": {"argv": ["python3", "shadow_runner.py", "stub-adapter"]},
            },
        ])
        keys = {gap["capability_gap_key"] for gap in self._gaps()}
        self.assertIn("registry:stub_runner:stub-adapter", keys)

    def test_orphan_manifest_detected(self) -> None:
        self._manifest("orphan-adapter")
        self._registry([])
        keys = {gap["capability_gap_key"] for gap in self._gaps()}
        self.assertIn("registry:orphan:orphan-adapter", keys)

    def test_ghost_registry_entry_detected(self) -> None:
        self._registry([{"tool_id": "ghost-adapter", "runner": {"argv": ["python3", "real.py"]}}])
        keys = {gap["capability_gap_key"] for gap in self._gaps()}
        self.assertIn("registry:ghost:ghost-adapter", keys)

    def test_unreachable_candidate_tool_detected(self) -> None:
        self._registry([])
        pressure_dir = self.tools / "pressure"
        pressure_dir.mkdir()
        (pressure_dir / "cycle-1.json").write_text(
            json.dumps({"pressures": [{"pressure_id": "p1", "candidate_tools": ["missing-tool"]}]}),
            encoding="utf-8",
        )
        keys = {gap["capability_gap_key"] for gap in self._gaps()}
        self.assertIn("registry:unreachable_candidate:missing-tool", keys)


if __name__ == "__main__":
    unittest.main()
