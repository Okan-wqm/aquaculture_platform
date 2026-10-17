"""ARIA-HIGH-523 — a run row names its read set; the set lives once, in the run's artifact.

Every runs.jsonl row inlined the full ``read_paths`` list that the run's own
artifact already holds (``payload.read_paths``). On origin/aria/state 8e39b2ee
that was 25.5 MB of the 39.1 MB file (690 rows): a test-gap row was 576 KB, and
536 KB of it was its 7,818-path read set. Compaction slims a row only after
seven days, and seven days of such rows outgrow the 64 MiB per-surface publish
cap, so every aria-auto-cycle publish was refused whole and the night's ledger
rows were lost (3 of 4 runs from 2026-10-13 20:34Z).

The row writer now stores ``read_paths_ref`` (the set's count, its sha256 and
the pointer into the artifact) in place of the list whenever the artifact holds
the list, and every reader takes the set from ``runs_reader.run_read_paths``.
These tests pin:

* a production-shaped row is small and does not grow with its read set;
* every reader of a stored row (pressure, capability gap, the health check of a
  stored row) gives the answer the inline row gave;
* rows written before the fix, rows of the v1 format and rows whose artifact
  write failed keep their inline list and read exactly as before;
* a set the artifact no longer holds is refused by name, never read as empty.
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _helpers.git_fixtures import make_local_git_repo  # noqa: E402
from test_enterprise_cycle import (  # noqa: E402
    FAKE_RUNNER,
    fake_tool_argv,
    register_tool,
    shadow_tool,
    tool_output,
)

from aria_kernel.runtime_artifacts import resolve_artifact_payload  # noqa: E402
from aria_kernel.tool_registry import GovernanceError  # noqa: E402
from aria_kernel.tool_runner import run_tool  # noqa: E402

# The test-gap adapter's read set on 2026-10-15: 7,818 paths, 536 KB inline.
PRODUCTION_READ_SET_SIZE = 7818
# A row that carries everything but its read set. The production rows of
# 2026-10-15 averaged 23 KB without read_paths (raw-finding samples and
# evidence envelopes); this fixture's row has neither.
SMALL_ROW_BYTES = 16 * 1024


def _production_paths() -> list[str]:
    # 67-byte paths across ~700 directories, the shape of the test-gap read
    # set (68 bytes a path on average on 2026-10-15).
    return sorted(
        f"src/apps/svc-{i % 17:02d}/src/domain-{i % 41:02d}/handlers/__tests__/case-{i:05d}.spec.ts"
        for i in range(PRODUCTION_READ_SET_SIZE)
    )


def _git(args: list[str], cwd: Path) -> None:
    subprocess.run(
        ["git", "-c", "user.email=fixture@aria.test", "-c", "user.name=Aria Fixture", *args],
        cwd=cwd, check=True, capture_output=True,
    )


def _rows(tools: Path) -> list[tuple[int, dict[str, Any]]]:
    """(line bytes, row) for every runs.jsonl row, as stored."""
    lines = (tools / "runs.jsonl").read_bytes().splitlines()
    return [(len(line), json.loads(line)) for line in lines if line.strip()]


def _legacy_shape(row: dict[str, Any], read_set: list[str]) -> dict[str, Any]:
    """The same run as the pre-fix writer stored it: the list inline."""
    legacy = {key: value for key, value in row.items() if key != "read_paths_ref"}
    legacy["read_paths"] = list(read_set)
    return legacy


class ProductionShapedReadSet(unittest.TestCase):
    """One production-shaped run, recorded through ``run_tool``, read back."""

    @classmethod
    def setUpClass(cls) -> None:
        cls._tmp = tempfile.TemporaryDirectory()
        root = Path(cls._tmp.name)
        cls.workspace = make_local_git_repo(root, name="work", initial_commit=False)
        cls.read_set = _production_paths()
        for rel in cls.read_set:
            path = cls.workspace / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("x\n", encoding="utf-8")
        _git(["add", "--", "src"], cls.workspace)
        _git(["commit", "-q", "-m", "fixture: a production-sized tree"], cls.workspace)
        cls.tools = root / "tools"
        cls.tools.mkdir()
        tool = shadow_tool()
        tool["runner"]["argv"] = ["python3", FAKE_RUNNER.as_posix(), "--read-tree", "src"]
        tool["runner"]["timeout_ms"] = 60_000
        register_tool(tool, base_dir=cls.tools)
        cls.result = run_tool(
            "fixture-shadow-tool", {}, "cyc-read-set", run_id="run-read-set",
            workspace_root=cls.workspace, base_dir=cls.tools,
        )
        [(cls.row_bytes, cls.row)] = _rows(cls.tools)

    @classmethod
    def tearDownClass(cls) -> None:
        cls._tmp.cleanup()

    def test_the_run_is_a_clean_production_run(self) -> None:
        self.assertEqual(self.row["status"], "ok", self.result)
        self.assertEqual(self.row["artifact_status"], "present")
        payload = resolve_artifact_payload(self.row["artifact_ref"], base_dir=self.tools)["payload"]
        self.assertEqual(payload["read_paths"], self.read_set)

    def test_the_row_is_small_whatever_the_read_set(self) -> None:
        inline = len(json.dumps(self.read_set, separators=(",", ":")).encode("utf-8"))
        self.assertGreater(inline, 500 * 1024)
        self.assertLess(self.row_bytes, SMALL_ROW_BYTES)

    def test_the_row_names_the_set_by_content_address(self) -> None:
        self.assertNotIn("read_paths", self.row)
        encoded = json.dumps(self.read_set, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
        self.assertEqual(self.row["read_paths_ref"], {
            "count": PRODUCTION_READ_SET_SIZE,
            "sha256": "sha256:" + hashlib.sha256(encoded.encode("utf-8")).hexdigest(),
            "json_pointer": "/payload/read_paths",
        })
        # run_tool hands its caller the stored row, not a fatter copy.
        self.assertEqual(self.result["envelope"], self.row)

    def test_the_reader_resolves_the_set_the_adapter_reported(self) -> None:
        from aria_kernel.runs_reader import run_read_paths

        self.assertEqual(run_read_paths(self.row, base_dir=self.tools), self.read_set)

    def test_the_health_check_of_the_stored_row_reads_the_same_set(self) -> None:
        # evaluate_health without a latest_run judges the STORED row; its
        # scope check read row["read_paths"] and must still see the set.
        from aria_kernel.tool_health import evaluate_health

        stored = evaluate_health("fixture-shadow-tool", base_dir=self.tools)
        self.assertEqual(stored["action"], "none", stored)
        with patch("aria_kernel.tool_health.find_scope_violations", return_value=[]) as scope:
            evaluate_health("fixture-shadow-tool", base_dir=self.tools)
        self.assertIn(self.read_set, [call.args[1] for call in scope.call_args_list])

    def _pressures(self, row: dict[str, Any]) -> list[tuple[Any, ...]]:
        from aria_kernel import pressure as pressure_mod

        with patch.object(pressure_mod, "read_runs_rows", return_value=[row]), \
             patch.object(pressure_mod, "_raw_finding_delta", return_value=3), \
             patch("aria_kernel.own_pr_ci.load_open_own_pr_reds", return_value=[]), \
             patch("aria_kernel.own_pr_ci.load_post_merge_reds", return_value=[]), \
             patch("aria_kernel.own_pr_ci.load_third_party_pr_reds", return_value=[]), \
             patch("aria_kernel.knowledge_graph.rank_pressure_sources", return_value=[]), \
             patch("aria_kernel.runtime_signal_bridge.load_open_runtime_signals", return_value=[]):
            pressures = pressure_mod.run_pressure(cycle_id=row["cycle_id"], base_dir=self.tools)["pressures"]
        return sorted(
            (p["source"], p["reason"], tuple(p["evidence"]), tuple(p["provenance_refs"]))
            for p in pressures if p["source"] in ("tool_quarantine", "shadow_raw_delta")
        )

    def test_pressure_gives_the_answer_the_inline_row_gave(self) -> None:
        for status, source in (("evidence_error", "tool_quarantine"), ("ok", "shadow_raw_delta")):
            with self.subTest(status=status):
                stored = {**self.row, "status": status}
                fixed = self._pressures(stored)
                self.assertEqual(fixed, self._pressures(_legacy_shape(stored, self.read_set)))
                [(emitted, _reason, evidence, provenance)] = fixed
                self.assertEqual(emitted, source)
                cited = len(evidence) + len(provenance)
                # tool_quarantine cites the whole set, shadow_raw_delta its first 20.
                self.assertEqual(cited, PRODUCTION_READ_SET_SIZE if status != "ok" else 20)

    def test_the_capability_gap_gives_the_answer_the_inline_row_gave(self) -> None:
        from aria_kernel import capability_gap

        def gaps(row: dict[str, Any]) -> list[dict[str, Any]]:
            with patch.object(capability_gap, "read_runs_rows", return_value=[row]):
                return capability_gap._gaps_from_shadow_runs(row["cycle_id"], self.tools, self.tools)

        shadow = {
            **self.row,
            "runner": {**self.row["runner"], "raw_findings_count": 5},
            "emitted_counts": {"observations": 0, "findings": 0},
        }
        fixed = gaps(shadow)
        self.assertEqual(
            [gap["evidence_refs"] for gap in fixed],
            [gap["evidence_refs"] for gap in gaps(_legacy_shape(shadow, self.read_set))],
        )
        self.assertEqual([gap["evidence_refs"] for gap in fixed], [self.read_set[:20]])


class RowsThatKeepTheirListInline(unittest.TestCase):
    """Rows the artifact cannot stand in for, and rows written before the fix."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        root = Path(self._tmp.name)
        self.workspace = make_local_git_repo(root, name="work", initial_commit=False)
        (self.workspace / "src").mkdir()
        (self.workspace / "src" / "app.ts").write_text("x\n", encoding="utf-8")
        _git(["add", "--", "src"], self.workspace)
        _git(["commit", "-q", "-m", "fixture"], self.workspace)
        self.tools = root / "tools"
        self.tools.mkdir()
        tool = shadow_tool()
        tool["runner"]["argv"] = fake_tool_argv(tool_output())
        register_tool(tool, base_dir=self.tools)

    def _run(self) -> dict[str, Any]:
        run_tool(
            "fixture-shadow-tool", {}, "cyc-inline", run_id="run-inline",
            workspace_root=self.workspace, base_dir=self.tools,
        )
        return _rows(self.tools)[-1][1]

    def test_a_pre_fix_row_reads_its_inline_list(self) -> None:
        from aria_kernel.runs_reader import run_read_paths

        legacy = {"run_id": "r", "read_paths": ["src/a.ts", "src/b.ts"]}
        self.assertEqual(run_read_paths(legacy, base_dir=self.tools / "absent"), ["src/a.ts", "src/b.ts"])

    def test_a_compacted_pre_fix_row_reads_its_sample_as_before(self) -> None:
        from aria_kernel.runs_reader import run_read_paths

        sample = [f"src/f{i}.ts" for i in range(5)]
        compacted = {"run_id": "r", "read_paths": sample, "read_paths_count": 7818}
        self.assertEqual(run_read_paths(compacted, base_dir=self.tools / "absent"), sample)

    def test_a_v1_row_keeps_its_read_set_inline(self) -> None:
        # v1 writes no artifact, so nothing else holds the set.
        with patch.dict(os.environ, {"ARIA_RUN_LEDGER_FORMAT": "v1"}):
            row = self._run()
        self.assertEqual(row["read_paths"], ["src/app.ts"])
        self.assertNotIn("read_paths_ref", row)

    def test_a_row_whose_artifact_failed_keeps_its_read_set_inline(self) -> None:
        failed = {
            "artifact_id": "x", "artifact_ref": None, "artifact_hash": None,
            "artifact_status": "write_failed", "artifact_error": "disk full",
        }
        with patch("aria_kernel.tool_health.write_run_artifact", return_value=failed):
            row = self._run()
        self.assertEqual(row["status"], "integrity_failed")
        self.assertEqual(row["read_paths"], ["src/app.ts"])
        self.assertNotIn("read_paths_ref", row)

    def test_a_set_the_artifact_no_longer_holds_is_refused_by_name(self) -> None:
        from aria_kernel.runs_reader import run_read_paths

        row = self._run()
        self.assertEqual(row["read_paths_ref"]["count"], 1)
        (self.tools / row["artifact_ref"]["uri"]).unlink()
        with self.assertRaises(GovernanceError) as raised:
            run_read_paths(row, base_dir=self.tools)
        self.assertIn("run-inline", str(raised.exception))

    def test_a_row_without_a_read_set_is_refused_by_name(self) -> None:
        from aria_kernel.runs_reader import run_read_paths

        with self.assertRaises(GovernanceError) as raised:
            run_read_paths({"run_id": "no-set"}, base_dir=self.tools)
        self.assertIn("no-set", str(raised.exception))


if __name__ == "__main__":
    unittest.main()
