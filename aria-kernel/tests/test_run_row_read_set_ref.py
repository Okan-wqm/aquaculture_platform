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
* a set the artifact no longer holds is refused by name, never read as empty;
* (ARIA-HIGH-617) a scope violation over a wide read set is recorded and
  quarantines: the row samples the violations and the artifact holds them all;
  where no artifact holds the read set (v1, a failed write) both lists are
  bounded by bytes on the row, and long or non-string entries are bounded too;
  the same cycle's pressure phase cites a bounded sample, so its one
  pressure-log row is appended; adapter output nested past the kernel's
  nesting bound is refused by the parser (schema_error) and quarantines.
"""

from __future__ import annotations

import base64
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
                # Both cite a bounded sample (ARIA-HIGH-617): the first 20 paths
                # of the set within the citation budget. tool_quarantine cited
                # the whole set, which a wide report made too large to append.
                self.assertEqual([*evidence, *provenance], self.read_set[:20])

    def test_the_capability_gap_gives_the_answer_the_inline_row_gave(self) -> None:
        from aria_kernel import capability_gap

        def gaps(row: dict[str, Any]) -> list[dict[str, Any]]:
            with patch.object(capability_gap, "read_runs_rows", return_value=[row]):
                return capability_gap._gaps_from_shadow_runs(row["cycle_id"], self.tools, self.tools, [])

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


# ARIA-HIGH-617 — scope_violations is derived from the read set, so it grows
# with whatever the adapter reports (read_paths is the adapter's own list,
# bounded only by the 12 MiB stdout cap). Inline, 20,000 reported out-of-scope
# paths made a 1.6 MB row; the declared append refused it (1 MiB cap) before
# evaluate_health ran, so the run was never recorded and the tool never
# quarantined. Verification round 1 found the same failure where no artifact
# holds the read set (a v1 row, or a write the adapter itself can make fail)
# and where the entries, not their count, are large.
WIDE_VIOLATION_COUNT = 20_000
# How many violations a row carries inline when its artifact holds the whole list.
VIOLATION_SAMPLE = 20
# A run row's read-set lists (read_paths, scope_violations) each take at most
# ledger_inline's per-field budget inline (128 KiB, counted as the row stores
# them), whatever the adapter reported; the rest of a fixture row is small.
BOUNDED_ROW_BYTES = 2 * 128 * 1024 + SMALL_ROW_BYTES
# What one pressure cites of a tool run, whatever the adapter reported: at most
# 20 paths within 4 KiB (runs_reader.RUN_PATH_CITATION_LIMIT / _MAX_BYTES).
RUN_PATH_CITATIONS = 20
RUN_PATH_CITATION_BYTES = 4 * 1024
# Assembled from parts, so this file matches no detection shape.
CREDENTIAL_SHAPED_KEY = "gh" + "p_" + "Kq7" * 12
CREDENTIAL_SHAPED_READ_PATH = f"docs/generated/{CREDENTIAL_SHAPED_KEY}.md"
ESCAPE_FORMED_CREDENTIAL_PATH = "x" + chr(0xEA) + "ws_secret" + "_access_key" + "=" + chr(0x1A)


def _out_of_scope_paths(count: int) -> list[str]:
    # The fixture tool may read src/**/*.ts only; a generated docs tree is outside it.
    return [f"docs/generated/area-{i % 97:02d}/section-{i // 97:04d}/page-{i:05d}.generated.md" for i in range(count)]


def _digest(values: list[Any]) -> str:
    from aria_kernel.runs_reader import read_set_digest

    return read_set_digest(values)


class _ScopeViolationStore(unittest.TestCase):
    """A fresh tools store holding the fixture tool; runs go through ``record_run``."""

    LEDGER_FORMAT = "v2-shadow"

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tools = Path(self._tmp.name) / "tools"
        self.tools.mkdir()
        env = patch.dict(os.environ, {"ARIA_RUN_LEDGER_FORMAT": self.LEDGER_FORMAT})
        env.start()
        self.addCleanup(env.stop)
        register_tool(shadow_tool(), base_dir=self.tools)

    def _record(
        self, read_paths: list[Any], *, parsed_output: dict[str, Any] | None = None, evidence_valid: bool = True,
        evidence_validation: dict[str, Any] | None = None, run_id: str = "run-escape",
    ) -> Any:
        from aria_kernel.tool_health import record_run

        run: dict[str, Any] = {
            "schema_version": 1, "run_id": run_id, "tool_id": "fixture-shadow-tool",
            "cycle_id": "cyc-escape", "status": "ok", "input_hash": "sha256:" + "1" * 64,
            "output_hash": "sha256:" + "2" * 64, "read_paths": read_paths, "emitted_observations": [],
            "emitted_findings": [],
            "evidence_validation": evidence_validation or {"valid": evidence_valid, "evidence_sources": []},
            "operator_feedback_refs": [], "duration_ms": 10, "cost_units": 1,
        }
        if parsed_output is not None:
            # The adapter's own parsed output, as tool_runner hands it to the artifact.
            run["_runtime_artifact_payload"] = {
                "stdout": "{}", "stderr": "", "parsed_output": parsed_output,
                "raw_observations": [], "raw_findings": [],
            }
        return record_run(run, base_dir=self.tools)

    def _recorded_and_quarantined(self, recorded: Any, status: str) -> tuple[int, dict[str, Any]]:
        from aria_kernel.tool_registry import get_tool

        [(row_bytes, row)] = _rows(self.tools)
        self.assertEqual(row["status"], status)
        self.assertLess(row_bytes, BOUNDED_ROW_BYTES)
        self.assertEqual(recorded.health_decision["action"], "quarantine")
        self.assertEqual(get_tool("fixture-shadow-tool", self.tools)["status"], "QUARANTINED")
        return row_bytes, row

    def _credential_shaped_read(self, **record: Any) -> tuple[dict[str, Any], str]:
        """Record one read of a credential-shaped path, echoed by evidence_validation; the row and its redaction.

        The stored line must pass the kernel's own refusal scan: the row is
        published on aria/state, and the read set's entries are the adapter's.
        """
        from aria_kernel.artifact_safety import scrub_text
        from aria_kernel.implementation_safety import verify_no_secret_in_diff

        redacted = scrub_text(CREDENTIAL_SHAPED_READ_PATH)
        self.assertNotIn(CREDENTIAL_SHAPED_KEY, redacted, "premise: the scrub redacts the shape")
        echo = {"code": "read_path_outside_snapshot", "path": CREDENTIAL_SHAPED_READ_PATH}
        self._record(
            [CREDENTIAL_SHAPED_READ_PATH],
            evidence_validation={"valid": False, "evidence_sources": [], "errors": [echo]}, **record,
        )
        [line] = (self.tools / "runs.jsonl").read_text(encoding="utf-8").splitlines()
        self.assertNotIn(CREDENTIAL_SHAPED_KEY, line)
        verify_no_secret_in_diff(line)
        row = json.loads(line)
        self.assertEqual(row["status"], "integrity_failed" if "parsed_output" in record else "scope_violation")
        self.assertEqual(row["scope_violations"], [redacted])
        # A failed write adds its own run_artifact_write_failed error after the echo.
        self.assertEqual(row["evidence_validation"]["errors"][0], {**echo, "path": redacted})
        return row, redacted

    def _tool_quarantine_citations(self) -> list[str]:
        """The same cycle's pressure phase, run for real: what its tool_quarantine pressure cites.

        ``run_pressure`` appends the cycle's pressures to pressure-log.jsonl as
        one ledger row under the 1 MiB row cap; the phase has no on_error, so a
        refused append fails the cycle (order-map SUP-20).
        """
        from aria_kernel.pressure import run_pressure

        payload = run_pressure(cycle_id="cyc-escape", base_dir=self.tools)
        [line] = (self.tools / "pressure" / "pressure-log.jsonl").read_bytes().splitlines()
        self.assertEqual(json.loads(line)["cycle_id"], "cyc-escape")
        [quarantine] = [p for p in payload["pressures"] if p["source"] == "tool_quarantine"]
        cited = [*quarantine["evidence"], *quarantine["provenance_refs"]]
        self.assertLessEqual(len(cited), RUN_PATH_CITATIONS)
        self.assertLessEqual(len(json.dumps(cited, separators=(",", ":")).encode("utf-8")), RUN_PATH_CITATION_BYTES)
        return cited


class AScopeViolationOverAWideReadSet(_ScopeViolationStore):
    """A run that read far outside its scope is recorded, and its tool quarantined."""

    def test_the_run_is_recorded_and_its_tool_quarantined(self) -> None:
        escaped = _out_of_scope_paths(WIDE_VIOLATION_COUNT)
        inline = len(json.dumps(escaped, separators=(",", ":")).encode("utf-8"))
        self.assertGreater(inline, 1024 * 1024, "premise: inline, the list alone is over the row cap")
        row_bytes, _row = self._recorded_and_quarantined(self._record(escaped), "scope_violation")
        self.assertLess(row_bytes, SMALL_ROW_BYTES)

    def test_the_row_samples_the_violations_and_the_artifact_holds_them_whole(self) -> None:
        escaped = _out_of_scope_paths(WIDE_VIOLATION_COUNT)
        row = self._record(escaped).row
        self.assertEqual(row["scope_violations"], escaped[:VIOLATION_SAMPLE])
        self.assertEqual(row["scope_violations_spilled"], {
            "spilled_sample": True,
            "reason_code": "inline_row_list_budget",
            "total": WIDE_VIOLATION_COUNT,
            "sampled": VIOLATION_SAMPLE,
            "sha256": _digest(escaped),
            "verification_status": "artifact_backed",
            "json_pointer": "/payload/scope_violations",
            "recovery": "the run artifact holds the whole list at json_pointer",
        })
        payload = resolve_artifact_payload(row["artifact_ref"], base_dir=self.tools)["payload"]
        self.assertEqual(payload["scope_violations"], escaped)
        # One digest spelling per row: the marker names the artifact's list the
        # way read_paths_ref names the read set, and verifies the same way.
        self.assertEqual(row["scope_violations_spilled"]["sha256"], _digest(payload["scope_violations"]))

    def test_a_narrow_violation_keeps_its_list_whole(self) -> None:
        row = self._record(["src/app.ts", *_out_of_scope_paths(3)]).row
        self.assertEqual(row["status"], "scope_violation")
        self.assertEqual(row["scope_violations"], _out_of_scope_paths(3))
        self.assertNotIn("scope_violations_spilled", row)

    def test_long_entries_are_bounded_by_bytes_not_only_by_count(self) -> None:
        # Twenty entries are within the count limit; at 60,000 characters each
        # they made a 1.2 MB row. A non-string entry is scope-checked as its text.
        long_entries = [f"docs/generated/{i:02d}/" + "p" * 60_000 for i in range(VIOLATION_SAMPLE)]
        with_content = {"path": "docs/generated/blob.md", "content": "c" * 200_000}
        _bytes, row = self._recorded_and_quarantined(self._record([*long_entries, with_content]), "scope_violation")
        marker = row["scope_violations_spilled"]
        self.assertEqual(marker["total"], VIOLATION_SAMPLE + 1)
        self.assertLess(marker["sampled"], VIOLATION_SAMPLE)
        self.assertEqual(row["scope_violations"], long_entries[:marker["sampled"]])
        payload = resolve_artifact_payload(row["artifact_ref"], base_dir=self.tools)["payload"]
        self.assertEqual(len(payload["scope_violations"]), VIOLATION_SAMPLE + 1)
        self.assertEqual(marker["sha256"], _digest(payload["scope_violations"]))

    def test_one_entry_over_the_row_cap_is_recorded_and_quarantined(self) -> None:
        huge = "docs/generated/" + "q" * 1_100_000
        _bytes, row = self._recorded_and_quarantined(self._record([huge]), "scope_violation")
        self.assertEqual(row["scope_violations"], [])
        self.assertEqual(row["scope_violations_spilled"]["total"], 1)
        self.assertEqual(row["scope_violations_spilled"]["sampled"], 0)

    def test_the_cycle_s_pressure_phase_appends_after_a_wide_violation(self) -> None:
        # The run row was bounded, but the pressure phase cited the run's whole
        # read set: 20,000 paths made its pressure-log row 1,243,619 B, and the
        # refused append failed the cycle the run row no longer failed.
        reported = [*_out_of_scope_paths(WIDE_VIOLATION_COUNT), ".env"]
        self._recorded_and_quarantined(self._record(reported), "scope_violation")
        # A scope violation cites the violations, the forbidden read first.
        self.assertIn(".env", self._tool_quarantine_citations())

    def test_an_evidence_error_over_a_wide_read_set_does_not_fail_the_pressure_phase(self) -> None:
        # The ARIA-HIGH-523 variant: in-scope paths, invalid evidence. The run
        # row names its read set by reference; the pressure cited it whole.
        in_scope = [f"src/generated/area-{i % 97:02d}/page-{i:05d}.generated.ts" for i in range(WIDE_VIOLATION_COUNT)]
        self._recorded_and_quarantined(self._record(in_scope, evidence_valid=False), "evidence_error")
        self.assertEqual(self._tool_quarantine_citations(), in_scope[:RUN_PATH_CITATIONS])

    def test_long_entries_do_not_fail_the_pressure_phase(self) -> None:
        # Twenty in-scope entries of 60,000 characters are within a count of 20.
        long_entries = [f"src/generated/{i:02d}/" + "p" * 60_000 + ".ts" for i in range(RUN_PATH_CITATIONS)]
        self._recorded_and_quarantined(self._record(long_entries, evidence_valid=False), "evidence_error")
        self.assertEqual(self._tool_quarantine_citations(), [])

    def test_a_credential_shaped_read_is_redacted_wherever_the_row_names_it(self) -> None:
        row, _redacted = self._credential_shaped_read()
        self.assertEqual(row["read_paths_ref"]["count"], 1)

    def test_a_forbidden_read_leads_the_row_sample(self) -> None:
        # 25 generated-tree reads, then .env: a sample of the first 20 left the
        # one read that matters visible only in the artifact.
        row = self._record([*_out_of_scope_paths(25), ".env"]).row
        self.assertEqual(row["scope_violations"][0], ".env")
        self.assertEqual(row["scope_violations_spilled"]["total"], 26)
        payload = resolve_artifact_payload(row["artifact_ref"], base_dir=self.tools)["payload"]
        self.assertEqual(row["scope_violations_spilled"]["sha256"], _digest(payload["scope_violations"]))

    def test_an_oversized_forbidden_read_first_does_not_hide_the_ones_behind_it(self) -> None:
        # The adapter orders its report: one forbidden read longer than the
        # row's budget, reported first, ended the sample, so the row kept no
        # violation at all and the .env read was visible only in the artifact.
        oversized = "secrets/" + "x" * 200_000
        reported = [oversized, ".env", "secrets/prod.key", *_out_of_scope_paths(30)]
        row = self._record(reported).row
        self.assertEqual(row["scope_violations"][:2], [".env", "secrets/prod.key"])
        self.assertNotIn(oversized, row["scope_violations"])
        self.assertEqual(len(row["scope_violations"]), VIOLATION_SAMPLE)
        self.assertEqual(row["scope_violations_spilled"]["total"], len(reported))

    def test_an_oversized_forbidden_read_first_does_not_hide_the_ones_behind_it_from_the_pressure(self) -> None:
        # The row keeps all three; the pressure's 4 KiB budget skipped none
        # but ended at the first, and cited nothing.
        long_forbidden = ".env." + "a" * 5_000
        _bytes, row = self._recorded_and_quarantined(
            self._record([long_forbidden, ".env", "secrets/prod.key"]), "scope_violation",
        )
        self.assertEqual(row["scope_violations"], [long_forbidden, ".env", "secrets/prod.key"])
        self.assertCountEqual(self._tool_quarantine_citations(), [".env", "secrets/prod.key"])


class AWideReportNoArtifactHolds(_ScopeViolationStore):
    """The adapter can make the artifact write fail; the run is still recorded and quarantined.

    ``parsed_output`` is the adapter's own dict, and the artifact encoder refuses
    a credential-shaped key in it, or a credential shape in a reported path
    (``artifact_safety.sanitized_json_text``); a full disk fails the write too.
    No artifact then holds the read set, so the row cannot name it by reference.
    """

    def _assert_bounded_without_an_artifact(self, row: dict[str, Any], reported: list[Any]) -> None:
        self.assertNotIn("read_paths_ref", row)
        marker = row["read_paths_spilled"]
        self.assertEqual(marker["total"], len(reported))
        self.assertEqual(marker["verification_status"], "digest_only")
        self.assertNotIn("json_pointer", marker)
        self.assertEqual(marker["sha256"], _digest(reported))
        self.assertGreater(marker["sampled"], 0)
        self.assertEqual(row["read_paths"], reported[:marker["sampled"]])
        self.assertEqual(row["scope_violations_spilled"]["verification_status"], "digest_only")

    def test_a_credential_shaped_key_in_the_output_fails_the_artifact_and_the_run_is_recorded(self) -> None:
        reported = _out_of_scope_paths(WIDE_VIOLATION_COUNT)
        recorded = self._record(reported, parsed_output={CREDENTIAL_SHAPED_KEY: 1})
        _bytes, row = self._recorded_and_quarantined(recorded, "integrity_failed")
        self.assertEqual(row["artifact_status"], "write_failed")
        self._assert_bounded_without_an_artifact(row, reported)

    def test_an_escape_formed_credential_path_fails_the_artifact_and_the_run_is_recorded(self) -> None:
        reported = [*_out_of_scope_paths(WIDE_VIOLATION_COUNT), ESCAPE_FORMED_CREDENTIAL_PATH]
        _bytes, row = self._recorded_and_quarantined(self._record(reported), "integrity_failed")
        self.assertEqual(row["artifact_status"], "write_failed")
        self.assertEqual(row["read_paths_spilled"]["total"], len(reported))

    def test_a_full_disk_fails_the_artifact_and_the_run_is_recorded(self) -> None:
        from aria_kernel import runtime_artifacts

        def full_disk(*_args: Any, **_kwargs: Any) -> None:
            raise OSError(28, "No space left on device")

        reported = _out_of_scope_paths(WIDE_VIOLATION_COUNT)
        with patch.object(runtime_artifacts, "_atomic_write_bytes", full_disk):
            recorded = self._record(reported)
        _bytes, row = self._recorded_and_quarantined(recorded, "integrity_failed")
        self._assert_bounded_without_an_artifact(row, reported)

    def test_the_reader_returns_the_sample_the_row_kept(self) -> None:
        # Every stored-row reader cites a sample at most (pressure, capability
        # gap); the marker beside it names the total and digest of the report.
        from aria_kernel.runs_reader import run_read_paths

        row = self._record(_out_of_scope_paths(WIDE_VIOLATION_COUNT), parsed_output={CREDENTIAL_SHAPED_KEY: 1}).row
        self.assertEqual(run_read_paths(row, base_dir=self.tools), row["read_paths"])

    def test_a_credential_shaped_read_is_redacted_on_a_failed_write_row(self) -> None:
        # No artifact holds the list, so the row stores it inline: scrubbed.
        row, redacted = self._credential_shaped_read(parsed_output={CREDENTIAL_SHAPED_KEY: 1})
        self.assertEqual(row["artifact_status"], "write_failed")
        self.assertEqual(row["read_paths"], [redacted])

    def test_a_narrow_failed_write_keeps_its_lists_whole(self) -> None:
        reported = ["src/app.ts", *_out_of_scope_paths(3)]
        row = self._record(reported, parsed_output={CREDENTIAL_SHAPED_KEY: 1}).row
        self.assertEqual(row["read_paths"], reported)
        self.assertEqual(row["scope_violations"], _out_of_scope_paths(3))
        self.assertNotIn("read_paths_spilled", row)
        self.assertNotIn("scope_violations_spilled", row)


class AWideReportInTheV1Format(_ScopeViolationStore):
    """v1 (the ADR-035 rollback format) writes no artifact: the row is the only record."""

    LEDGER_FORMAT = "v1"

    def test_a_wide_report_is_recorded_and_quarantined(self) -> None:
        _bytes, row = self._recorded_and_quarantined(
            self._record(_out_of_scope_paths(WIDE_VIOLATION_COUNT)), "scope_violation",
        )
        self.assertEqual(row["artifact_status"], "legacy_inline_or_sample_only")
        self.assertEqual(row["read_paths_spilled"]["total"], WIDE_VIOLATION_COUNT)
        self.assertEqual(row["read_paths_spilled"]["verification_status"], "digest_only")
        self.assertEqual(row["scope_violations_spilled"]["total"], WIDE_VIOLATION_COUNT)

    def test_a_narrow_violation_keeps_both_lists_whole(self) -> None:
        reported = ["src/app.ts", *_out_of_scope_paths(3)]
        row = self._record(reported).row
        self.assertEqual(row["status"], "scope_violation")
        self.assertEqual(row["read_paths"], reported)
        self.assertEqual(row["scope_violations"], _out_of_scope_paths(3))
        self.assertNotIn("scope_violations_spilled", row)

    def test_a_credential_shaped_read_is_redacted_on_a_v1_row(self) -> None:
        row, redacted = self._credential_shaped_read()
        self.assertEqual(row["read_paths"], [redacted])

    def test_compaction_leaves_the_writer_s_sample_and_its_marker_true(self) -> None:
        # One owner samples the list: runs compaction re-sampled a row its
        # writer had already bounded, and recorded the sample's length as the total.
        from datetime import datetime, timedelta, timezone

        from aria_kernel import state_compact
        from aria_kernel.ledger import load_declared_jsonl

        written = self._record(_out_of_scope_paths(WIDE_VIOLATION_COUNT)).row
        self.assertGreater(len(written["read_paths"]), 20, "premise: over compaction's own threshold")
        # A row with evidence envelopes, so compaction rewrites the ledger.
        enveloped = {"valid": True, "evidence_sources": [], "evidence_envelopes": [{"path": "src/app.ts"}]}
        self._record(["src/app.ts"], evidence_validation=enveloped, run_id="run-enveloped")
        runs = self.tools / "runs.jsonl"
        _kept, stripped = state_compact._compact_runs(runs, self.tools, datetime.now(timezone.utc) + timedelta(days=1), False)
        self.assertEqual(stripped, 1)
        [compacted] = [row for row in load_declared_jsonl(runs, expected_surface="runs") if row["run_id"] == "run-escape"]
        self.assertEqual(compacted["read_paths"], written["read_paths"])
        self.assertEqual(compacted["read_paths_spilled"], written["read_paths_spilled"])
        self.assertEqual(compacted["read_paths_spilled"]["total"], WIDE_VIOLATION_COUNT)
        self.assertNotIn("read_paths_count", compacted)


# ARIA-HIGH-617, verification round 2: the structure of the adapter's output,
# not its size. An entry nested about 1,200 deep made the scrub on the way to
# the store (artifact_safety.scrub_json, one Python frame per level) raise
# RecursionError out of record_run, before the append and evaluate_health: in
# v2-shadow on the artifact payload (read_paths or parsed_output), in v1 on the
# row's read set. Nested about 20,000 deep, json.loads itself raised it in the
# parser. Either way no run was recorded and a tool that read .env stayed
# SHADOW. The parser now refuses output nested past the kernel's lexical bound
# (ledger.json_nesting_within_limit) before it decodes it.
NESTED_PAST_THE_SCRUB = 1_200
NESTED_PAST_THE_DECODER = 20_000


def _nested(depth: int) -> str:
    return "[" * depth + '"docs/out-of-scope.md"' + "]" * depth


def _adapter_stdout(*, read_paths: str = '[".env"]', metadata: str = '{"fixture":true}') -> str:
    """An adapter's stdout as text, so a test can write nesting the encoder could not."""
    return (
        '{"observations":[],"findings":[],"read_paths":' + read_paths
        + ',"evidence_sources":[],"cost_units":1,"metadata":' + metadata + "}"
    )


def deep_finding_stdout(depth: int, *, read_paths: str = '[".env","src/app.ts"]') -> str:
    """Stdout exactly ``depth`` levels deep, its depth carried where a kernel row nests it deepest.

    The one finding's ``id`` is the nested value. A run row stores the finding
    under ``runner.raw_findings_sample``, and the finding cites no evidence,
    so ``evidence_validation`` echoes its id as a ``finding_evidence_missing``
    error's ``finding_id`` (and a fixture-runs case nests that error under
    ``cases[i].evidence_validation``).
    """
    # The object (1), findings (2) and the finding (3): the id's lists start at 4.
    levels = depth - 3
    finding = '{"id":' + "[" * levels + '"deep"' + "]" * levels + ',"rule":"fixture"}'
    return (
        '{"observations":[],"findings":[' + finding + '],"read_paths":' + read_paths
        + ',"evidence_sources":[],"cost_units":1,"metadata":{"fixture":true}}'
    )


def deepest_accepted_depth() -> int:
    """The deepest ``deep_finding_stdout`` the parser accepts, asked of the parser itself."""
    from aria_kernel.tool_runner import _parse_tool_output

    tool = shadow_tool()
    depth = 4
    assert _parse_tool_output(deep_finding_stdout(depth), tool)[0] is not None
    while depth < 10_000 and _parse_tool_output(deep_finding_stdout(depth + 1), tool)[0] is not None:
        depth += 1
    return depth


class _NestedOutputCases:
    """One adapter run end to end through ``run_tool``, its stdout given as text."""

    LEDGER_FORMAT: str

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
        env = patch.dict(os.environ, {"ARIA_RUN_LEDGER_FORMAT": self.LEDGER_FORMAT})
        env.start()
        self.addCleanup(env.stop)

    def _run(self, stdout: str) -> tuple[dict[str, Any], str]:
        from aria_kernel.tool_registry import get_tool

        tool = shadow_tool()
        encoded = base64.b64encode(stdout.encode("utf-8")).decode("ascii")
        tool["runner"]["argv"] = ["python3", FAKE_RUNNER.as_posix(), "--stdout-b64", encoded]
        tool["runner"]["timeout_ms"] = 60_000
        register_tool(tool, base_dir=self.tools)
        run_tool(
            "fixture-shadow-tool", {}, "cyc-nested", run_id="run-nested",
            workspace_root=self.workspace, base_dir=self.tools,
        )
        [(_bytes, row)] = _rows(self.tools)
        return row, get_tool("fixture-shadow-tool", self.tools)["status"]

    def _assert_refused_and_quarantined(self, stdout: str) -> None:
        row, tool_status = self._run(stdout)
        self.assertEqual(row["status"], "schema_error")
        self.assertEqual(row["runner"]["parse_error"], "output_nesting_too_deep")
        self.assertEqual(tool_status, "QUARANTINED")

    def test_a_read_set_entry_nested_past_the_scrub_is_refused_and_quarantined(self) -> None:
        self._assert_refused_and_quarantined(_adapter_stdout(read_paths=f'[".env",{_nested(NESTED_PAST_THE_SCRUB)}]'))

    def test_metadata_nested_past_the_scrub_is_refused_and_quarantined(self) -> None:
        self._assert_refused_and_quarantined(_adapter_stdout(metadata='{"deep":' + _nested(NESTED_PAST_THE_SCRUB) + "}"))

    def test_output_nested_past_the_decoder_is_refused_and_quarantined(self) -> None:
        self._assert_refused_and_quarantined(_adapter_stdout(read_paths=f'[".env",{_nested(NESTED_PAST_THE_DECODER)}]'))

    def test_a_nested_entry_within_the_bound_is_judged_as_a_read(self) -> None:
        # The object, the read_paths list and 120 levels: within the bound, so
        # the output is parsed, the .env read is judged, and that quarantines.
        row, tool_status = self._run(_adapter_stdout(read_paths=f'[".env",{_nested(120)}]'))
        self.assertEqual(row["status"], "scope_violation")
        self.assertIsNone(row["runner"]["parse_error"])
        self.assertEqual(row["scope_violations"][0], ".env")
        self.assertEqual(tool_status, "QUARANTINED")

    def test_an_integer_the_decoder_refuses_is_refused_and_quarantined(self) -> None:
        # json.loads refuses an integer of more than 4,300 digits with a plain
        # ValueError. The parser caught only JSONDecodeError, so the error left
        # run_tool before record_run: no row, and the tool stayed SHADOW.
        row, tool_status = self._run(_adapter_stdout(metadata='{"n":' + "7" * 4_301 + "}"))
        self.assertEqual(row["status"], "schema_error")
        self.assertEqual(row["runner"]["parse_error"], "output_value_not_decodable")
        self.assertEqual(tool_status, "QUARANTINED")

    def test_the_deepest_output_the_parser_accepts_is_recorded_published_and_quarantined(self) -> None:
        # The parser accepted output as deep as the stored-line bound, and a row
        # nests a parsed value one level deeper than stdout: the run was recorded
        # and quarantined, and every publish of the runs ledger was refused.
        from aria_kernel.state_snapshot import build_snapshot

        row, tool_status = self._run(deep_finding_stdout(deepest_accepted_depth()))
        self.assertEqual(row["status"], "scope_violation")
        self.assertIsNone(row["runner"]["parse_error"])
        self.assertEqual(tool_status, "QUARANTINED")
        build_snapshot(snapshot_id="nested", cycle_id="cyc-nested", lane="test", roots={"tools": self.tools})

    def test_the_stored_evidence_validation_is_bounded_after_its_scrub(self) -> None:
        # The scrub's marker is longer than the shortest credential shapes
        # ('passwd=a' grows 2.78 times), and evidence_validation was bounded
        # before the row scrubbed it, so its stored list outgrew the budget.
        from aria_kernel.artifact_safety import scrub_json
        from aria_kernel.ledger import canonical_json
        from aria_kernel.ledger_inline import INLINE_ROW_FIELD_MAX_BYTES

        dense = [f"docs/{i:02d}/" + "passwd=a " * 280 for i in range(20)]
        self.assertLess(len(canonical_json(dense)), INLINE_ROW_FIELD_MAX_BYTES / 2, "premise: within the budget as reported")
        self.assertGreater(len(canonical_json(scrub_json(dense))), INLINE_ROW_FIELD_MAX_BYTES, "premise: over it once scrubbed")
        row, tool_status = self._run(json.dumps({
            "observations": [], "findings": [], "read_paths": [".env", *dense],
            "evidence_sources": [], "cost_units": 1,
        }))
        self.assertEqual(row["status"], "scope_violation")
        self.assertEqual(tool_status, "QUARANTINED")
        # Each reported path is echoed by a read_path_outside_snapshot error.
        errors = row["evidence_validation"]["errors"]
        self.assertNotIn("passwd=a", canonical_json(errors))
        self.assertLessEqual(len(canonical_json(errors)), INLINE_ROW_FIELD_MAX_BYTES)
        # The marker says where the whole list is: the artifact is written from
        # the bounded object (and v1 writes none), so it names a rebuild from
        # the output, never a read-back of the list.
        marker = row["evidence_validation"]["errors_spilled"]
        self.assertEqual(marker["verification_status"], "digest_only")
        self.assertNotIn("persists", marker["recovery"])
        self.assertIn("validate_tool_output_evidence", marker["recovery"])


class NestedOutputInTheDefaultFormat(_NestedOutputCases, unittest.TestCase):
    LEDGER_FORMAT = "v2-shadow"


class NestedOutputInTheV1Format(_NestedOutputCases, unittest.TestCase):
    LEDGER_FORMAT = "v1"


class TheSampleHelperIsBoundedByBytes(unittest.TestCase):
    """``ledger_inline.sample_inline_list`` bounds every caller, evidence_validation's lists too."""

    def test_an_evidence_validation_error_list_of_long_entries_is_bounded(self) -> None:
        from aria_kernel.ledger_inline import INLINE_ROW_FIELD_MAX_BYTES, spill_evidence_validation

        errors = [{"code": "evidence_path_missing", "path": "e" * 100_000} for _ in range(20)]
        spilled = spill_evidence_validation({"valid": False, "errors": errors}, recovery="re-run the validator")
        stored = json.dumps(spilled["errors"], sort_keys=True, separators=(",", ":"))
        self.assertLessEqual(len(stored.encode("utf-8")), INLINE_ROW_FIELD_MAX_BYTES)
        self.assertEqual(spilled["errors_spilled"]["total"], 20)
        self.assertEqual(spilled["errors_spilled"]["recovery"], "re-run the validator")

    def test_an_oversized_value_is_counted_and_named_as_the_row_stores_it(self) -> None:
        # One encoding per row: spill_oversized_inline and the evidence_validation
        # gate counted UTF-8 and digested an unsorted, non-ASCII spelling.
        from aria_kernel.ledger import canonical_json, sha256_digest_of_canonical_json
        from aria_kernel.ledger_inline import INLINE_ROW_FIELD_MAX_BYTES, spill_evidence_validation, spill_oversized_inline

        wide = "docs/" + chr(0x00E7) * 61_000
        self.assertLess(len(wide.encode("utf-8")), INLINE_ROW_FIELD_MAX_BYTES, "premise: under the budget in UTF-8")
        self.assertGreater(len(canonical_json(wide)), 2 * INLINE_ROW_FIELD_MAX_BYTES, "premise: over it on the row")
        stub = spill_oversized_inline("value", wide, recovery="none")
        self.assertEqual(stub["size_bytes"], len(canonical_json(wide)))
        self.assertEqual(stub["sha256"], sha256_digest_of_canonical_json(wide))
        validation = {"valid": False, "errors": [{"code": "read_path_outside_snapshot", "path": wide}]}
        spilled = spill_evidence_validation(validation, recovery="none")
        self.assertEqual(spilled["spilled_bulk"]["sha256"], sha256_digest_of_canonical_json(validation))
        self.assertEqual(spilled["errors_spilled"]["sha256"], sha256_digest_of_canonical_json(validation["errors"]))
        self.assertLessEqual(len(canonical_json(spilled)), INLINE_ROW_FIELD_MAX_BYTES)

    def test_the_budget_counts_the_bytes_the_row_stores(self) -> None:
        # The ledger writes a row with ASCII escapes, so one non-ASCII character
        # is six bytes on the row: a budget counted in UTF-8 lets a sample triple.
        from aria_kernel.ledger_inline import INLINE_ROW_FIELD_MAX_BYTES, sample_inline_list

        wide = ["docs/" + chr(0x00E7) * 15_000 for _ in range(10)]
        fields = sample_inline_list("scope_violations", wide, limit=None, json_pointer=None, recovery="none")
        self.assertGreater(fields["scope_violations_spilled"]["sampled"], 0)
        stored = json.dumps(fields["scope_violations"], sort_keys=True, separators=(",", ":"))
        self.assertLessEqual(len(stored.encode("utf-8")), INLINE_ROW_FIELD_MAX_BYTES)


if __name__ == "__main__":
    unittest.main()
