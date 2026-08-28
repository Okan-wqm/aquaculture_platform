"""ARIA-HIGH-017 (writer side) — runs.jsonl rows must stay inline-bounded.

The inherited 1.49 MB runs.jsonl row embedded a 1.43 MB
``evidence_validation`` (plus 88 KB of ``read_paths``) even though the
row's own artifact already persists the full parsed output: every future
reader paid for one run's verbosity, forever, and the snapshot line cap
turned that history into a publication outage. The writer now bounds the
two derived inline fields; anything over the cap is replaced by a digest
stub while the artifact keeps the full content.
"""

from __future__ import annotations

import base64
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_enterprise_cycle import (  # noqa: E402
    FAKE_RUNNER,
    fake_tool_argv,
    register_tool,
    shadow_tool,
    tool_output,
)

from aria_kernel.tool_runner import (  # noqa: E402
    INLINE_ROW_FIELD_MAX_BYTES,
    _spill_oversized_inline,
    run_tool,
)


class InlineRowCapTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)
        self.workspace = self.root / "work"
        (self.workspace / "src").mkdir(parents=True)
        (self.workspace / "src" / "app.ts").write_text("x\n", encoding="utf-8")
        self.tools_dir = self.root / "tools"
        self.tools_dir.mkdir()

    def _register(self, output: dict) -> None:
        tool = shadow_tool()
        tool["runner"]["argv"] = fake_tool_argv(output)
        register_tool(tool, base_dir=self.tools_dir)

    def _run(self):
        return run_tool(
            "fixture-shadow-tool",
            {
                "repo_snapshot": {
                    "allowed_paths": ["src/app.ts"],
                    "snapshot_mode": "committed",
                    "snapshot_hash": "sha256:test",
                },
            },
            "cycle-inline-cap",
            workspace_root=self.workspace,
            base_dir=self.tools_dir,
        )

    def _latest_row(self) -> dict:
        rows = (self.tools_dir / "runs.jsonl").read_text(
            encoding="utf-8",
        ).strip().splitlines()
        return json.loads(rows[-1])

    def test_oversized_evidence_validation_spills_to_a_digest_stub(self) -> None:
        # The argv-b64 harness caps one argument near 128 KiB, so the e2e
        # fixture drives the DERIVED field over the cap: each source's
        # validated envelope serializes far larger than the source path
        # itself — exactly the production shape (small read set, huge
        # evidence_validation). The pure read_paths spill is unit-pinned
        # below.
        huge = [f"src/f{i:06d}.ts" for i in range(2500)]
        self._register(tool_output(evidence_sources=huge, read_paths=huge))
        result = self._run()
        self.assertEqual(result["envelope"]["status"], "ok", result)
        row = self._latest_row()
        inline = row["evidence_validation"]
        self.assertIsInstance(inline, dict)
        bulk = inline["spilled_bulk"]
        self.assertTrue(bulk["spilled"])
        self.assertIn("sha256:", bulk["sha256"])
        self.assertGreater(bulk["size_bytes"], INLINE_ROW_FIELD_MAX_BYTES)
        # Structural keys stay queryable in the row itself, bounded as
        # sample + total for the oversized lists.
        self.assertIn("repository_mutation_attempt", inline)
        self.assertEqual(len(inline["evidence_sources"]), 100)
        marker = inline["evidence_sources_spilled"]
        self.assertIsInstance(marker, dict)
        self.assertTrue(marker["spilled_sample"])
        self.assertEqual(marker["total"], 2500)
        self.assertIn("sha256:", marker["sha256"])
        # The artifact keeps the full parsed output — the spill never loses it.
        payload = result["envelope"]["_runtime_artifact_payload"]
        self.assertEqual(len(payload["parsed_output"]["evidence_sources"]), 2500)
        self.assertIsInstance(row["read_paths"], list)

    def test_spill_helper_is_identity_under_the_cap(self) -> None:
        small = ["src/app.ts"]
        self.assertIs(_spill_oversized_inline("read_paths", small), small)
        stub = _spill_oversized_inline(
            "read_paths", ["x" * 100 for _ in range(2000)],
        )
        self.assertTrue(stub["spilled"])
        self.assertGreater(stub["size_bytes"], INLINE_ROW_FIELD_MAX_BYTES)
        self.assertIn("sha256:", stub["sha256"])

    def test_normal_rows_are_untouched(self) -> None:
        self._register(tool_output())
        result = self._run()
        self.assertEqual(result["envelope"]["status"], "ok", result)
        row = self._latest_row()
        self.assertIsInstance(row["read_paths"], list)
        self.assertNotIn("spilled", row["evidence_validation"])


if __name__ == "__main__":
    unittest.main()
