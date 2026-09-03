"""ARIA-HIGH-034 — fixture-run rows bound their evidence-validation inventory.

The 2026-09-02 row that broke the publish carried ONE case whose
``evidence_validation`` serialised to 1 461 828 bytes: ``valid: true``,
``errors: []`` — no defect, just the inventory (1 323 ``checked_sources``
+ 2 996 ``evidence_envelopes``) written inline. The inventory grows with
the repository, so the overflow was a matter of when. The writer now bounds
the field through the shared ``ledger_inline`` discipline (the same one
runs.jsonl uses), BEFORE the suite hash binds the row.
"""

from __future__ import annotations

import base64
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from aria_kernel import fixture_runner, register_tool, run_fixture_suite
from aria_kernel.ledger import LEDGER_ROW_MAX_BYTES
from aria_kernel.ledger_inline import INLINE_ROW_FIELD_MAX_BYTES
from aria_kernel.tool_registry import ensure_tools_dir

FAKE_RUNNER = Path(__file__).resolve().parent / "_helpers" / "fake_tool_runner.py"


def _fake_tool_argv(output: dict) -> list[str]:
    encoded = base64.b64encode(json.dumps(output, separators=(",", ":")).encode("utf-8")).decode("ascii")
    return ["python3", FAKE_RUNNER.as_posix(), "--output-b64", encoded]


def _inventory_validation(sources: int, envelopes: int) -> dict:
    """The production shape: a VALID verdict whose inventory dwarfs the row."""
    return {
        "valid": True,
        "errors": [],
        "evidence_sources": [f"src/f{i:05d}.ts" for i in range(sources)],
        "checked_sources": [f"src/f{i:05d}.ts" for i in range(sources)],
        "evidence_envelopes": [
            {
                "path": f"src/f{i % sources:05d}.ts",
                "sha256": "sha256:" + ("ab" * 32),
                "line_start": 1,
                "line_end": 40,
                # ~490 bytes per envelope, the production average behind the
                # 1 461 828-byte field (1 323 sources, 2 996 envelopes).
                "excerpt": "export const value = " + ("x" * 360) + ";",
            }
            for i in range(envelopes)
        ],
        "self_output_evidence": False,
    }


class FixtureRunRowCapTests(unittest.TestCase):
    def setUp(self) -> None:
        self._saved_env = {key: os.environ.get(key) for key in ("ARIA_TOOLS_DIR", "ARIA_REPO_ROOT")}
        os.environ.pop("ARIA_REPO_ROOT", None)
        os.environ.pop("ARIA_TOOLS_DIR", None)
        self.workspace = Path(tempfile.mkdtemp(prefix="aria-034-workspace-"))
        (self.workspace / ".git").mkdir()
        self.tools = self.workspace / ".aria-state-store" / "tools"
        ensure_tools_dir(self.tools)
        self.fixture_dir = self.workspace / "tools" / "aria-adapters" / "fixtures" / "x-adapter"
        (self.fixture_dir / "cases").mkdir(parents=True)
        (self.fixture_dir / "cases" / "baseline.json").write_text(
            json.dumps({"input": {}, "expected": {"status": "ok", "max_findings": 0}}),
            encoding="utf-8",
        )
        (self.workspace / "src").mkdir()
        (self.workspace / "src" / "app.ts").write_text("export const app = true;\n", encoding="utf-8")
        register_tool(
            {
                "tool_id": "x-adapter",
                "kind": "adapter",
                "version": "1.0.0",
                "status": "SHADOW",
                "declared_scope": ["src/**/*.ts"],
                "output_schema": {"type": "object", "required": ["observations", "findings", "read_paths", "evidence_sources"]},
                "fixture_set": "tools/aria-adapters/fixtures/x-adapter",
                "health_thresholds": {"max_cost_units": 10},
                "allowed_read_globs": ["src/**/*.ts"],
                "forbidden_read_globs": [],
                "claim_types": ["drift"],
                "owner": "platform",
                "runner": {
                    "type": "subprocess",
                    "argv": _fake_tool_argv(
                        {
                            "observations": [],
                            "findings": [],
                            "read_paths": ["src/app.ts"],
                            "evidence_sources": ["src/app.ts"],
                            "cost_units": 1,
                        }
                    ),
                    "cwd": ".",
                    "timeout_ms": 30_000,
                    "stdin_json": True,
                },
                "schema_version": 1,
            },
            base_dir=self.tools,
        )

    def tearDown(self) -> None:
        for key, value in self._saved_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        shutil.rmtree(self.workspace, ignore_errors=True)

    def _run_with_inventory(self, validation: dict) -> tuple[dict, str]:
        with mock.patch.object(fixture_runner, "validate_tool_output_evidence", return_value=validation):
            summary = run_fixture_suite(
                "x-adapter",
                workspace_root=self.workspace,
                cycle_id="cycle-034",
                base_dir=self.tools,
            )
        lines = (self.tools / "fixture-runs.jsonl").read_text(encoding="utf-8").splitlines()
        return summary, lines[-1]

    def test_repository_sized_inventory_still_yields_a_publishable_row(self) -> None:
        validation = _inventory_validation(sources=1323, envelopes=2996)
        self.assertGreater(len(json.dumps(validation).encode("utf-8")), LEDGER_ROW_MAX_BYTES)

        summary, line = self._run_with_inventory(validation)

        self.assertEqual(summary["actual_status"], "pass", summary["failed_cases"])
        self.assertLessEqual(len(line.encode("utf-8")) + 1, LEDGER_ROW_MAX_BYTES)
        case = json.loads(line)["cases"][0]
        inline = case["evidence_validation"]
        # Verdict and error list stay queryable; the inventory is a sample +
        # digest, and the whole object is represented once as a stub that
        # names how the reader rebuilds it.
        self.assertIs(inline["valid"], True)
        self.assertEqual(inline["errors"], [])
        self.assertEqual(len(inline["evidence_sources"]), 100)
        self.assertEqual(inline["evidence_sources_spilled"]["total"], 1323)
        self.assertNotIn("evidence_envelopes", inline)
        bulk = inline["spilled_bulk"]
        self.assertTrue(bulk["spilled"])
        self.assertGreater(bulk["size_bytes"], INLINE_ROW_FIELD_MAX_BYTES)
        self.assertIn("output_hash", bulk["recovery"])
        self.assertEqual(case["status"], "ok")

    def test_evidence_hash_binds_the_bounded_row_not_the_raw_inventory(self) -> None:
        # The hash is computed over the summary as written: two suites with
        # identical bounded rows hash identically even though the raw
        # inventories would differ only past the sample.
        validation = _inventory_validation(sources=1323, envelopes=2996)
        summary, line = self._run_with_inventory(validation)
        written = json.loads(line)
        self.assertEqual(written["evidence_hash"], summary["evidence_hash"])
        # Recomputed from the row AS WRITTEN (the hash helper excludes its
        # own volatile/chain fields): the bounded inventory is what the
        # hash binds — a raw-inventory hash would never verify again.
        self.assertEqual(fixture_runner._compute_suite_evidence_hash(written), written["evidence_hash"])

    def test_small_inventory_is_written_verbatim(self) -> None:
        validation = _inventory_validation(sources=3, envelopes=5)
        _summary, line = self._run_with_inventory(validation)
        inline = json.loads(line)["cases"][0]["evidence_validation"]
        self.assertEqual(inline, validation)


if __name__ == "__main__":
    unittest.main()
