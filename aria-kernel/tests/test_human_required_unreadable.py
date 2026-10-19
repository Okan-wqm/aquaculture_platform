"""ARIA-LOW-597 — an unreadable HUMAN_REQUIRED record is named, never skipped.

HIGH-108 doctrine, as ``deadlines.read_deadlines`` applies it: a source the
reader cannot read is reported undecided by its own name, never as an empty
or smaller list. ``list_human_required`` instead ``continue``d past every
OSError/JSONDecodeError, so a corrupted record file silently shrank the
operator inbox, the daily report, the doctor's queue count, the dashboard,
the adjudication sweep and the CLI listing — each reported the readable
subset as if it were the whole queue.
"""
from __future__ import annotations

import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path

from aria_kernel.human_required import (
    list_human_required,
    open_human_required_record,
    record_human_required,
)
from aria_kernel.tool_registry import ensure_tools_dir


class UnreadableFixture(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-hr-unreadable-")
        self.tools = Path(self._tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)
        record_human_required(
            request_id="req-open",
            severity="HIGH",
            reason="lease lifecycle exhausted requeues",
            base_dir=self.tools,
        )
        # One record that is not JSON, and one that cannot be read at all
        # (a directory wearing the record suffix — read_text raises
        # IsADirectoryError, an OSError; chmod tricks are useless as root).
        directory = self.tools / "human-required"
        (directory / "req-corrupt.json").write_text("{not json", encoding="utf-8")
        (directory / "req-unreadable.json").mkdir()

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _unreadable_ids(self, listing: object) -> set[str]:
        return {record.record_id for record in listing.unreadable}  # type: ignore[attr-defined]


class ListNamesUnreadableRecordsTests(UnreadableFixture):
    def test_the_lister_names_unreadable_records_beside_the_rows(self) -> None:
        listing = list_human_required(base_dir=self.tools)
        self.assertEqual([row["request_id"] for row in listing.rows], ["req-open"])
        self.assertEqual(self._unreadable_ids(listing), {"req-corrupt", "req-unreadable"})
        reasons = {record.record_id: record.reason for record in listing.unreadable}
        self.assertEqual(reasons["req-corrupt"], "invalid_json")
        self.assertTrue(reasons["req-unreadable"], "the unreadable record names its reason")

    def test_the_operator_inbox_names_them_undecided(self) -> None:
        from aria_kernel.operator_inbox import read_operator_inbox

        inbox = read_operator_inbox(tools_dir=self.tools, workspace_root=None)
        human = inbox["sections"]["human_required"]
        self.assertEqual(human["open"], 1)
        self.assertEqual(
            {entry["request_id"] for entry in human["unreadable"]},
            {"req-corrupt", "req-unreadable"},
        )
        self.assertIn("human_required:req-corrupt:unreadable", inbox["undecided"])
        self.assertIn("human_required:req-unreadable:unreadable", inbox["undecided"])

    def test_the_deadline_source_is_undecided_never_smaller(self) -> None:
        from aria_kernel.deadlines import read_deadlines

        readout = read_deadlines(tools_dir=self.tools, workspace_root=None)
        self.assertIn("human_required_sla:req-corrupt:unreadable", readout.undecided)
        self.assertIn("human_required_sla:req-unreadable:unreadable", readout.undecided)
        self.assertEqual(
            [row.key for row in readout.rows if row.kind == "human_required_sla"],
            ["req-open"],
            "a source that is partly unreadable must not count a smaller set of rows as decided",
        )

    def test_the_daily_report_summary_names_unreadable_records(self) -> None:
        from aria_kernel.reflection import _human_required_summary

        summary = _human_required_summary(self.tools)
        self.assertEqual(summary["open"], 1)
        self.assertEqual(
            {entry["request_id"] for entry in summary["unreadable"]},
            {"req-corrupt", "req-unreadable"},
        )

    def test_the_doctor_names_the_unreadable_records(self) -> None:
        from aria_kernel.doctor import _check_queue

        check = _check_queue(self.tools)
        self.assertEqual(check.status, "warn")
        self.assertEqual(
            {name.split(":", 1)[0] for name in check.detail["human_required_unreadable"]},
            {"req-corrupt", "req-unreadable"},
        )
        self.assertEqual(check.detail["human_required_open"], 1)

    def test_telemetry_counts_the_unreadable_records(self) -> None:
        from aria_kernel.telemetry import _store_metrics

        metrics = {(m["name"], m["value"]) for m in _store_metrics(self.tools)}
        self.assertIn(("aria_human_required_open", 1.0), metrics)
        self.assertIn(("aria_human_required_unreadable", 2.0), metrics)

    def test_the_dashboard_names_unreadable_records(self) -> None:
        from aria_kernel.plan_016_metrics import render_dashboard_markdown

        # repo_root is passed explicitly: the dashboard's default resolution
        # is a separate, pre-existing defect (stubbed, not this finding's).
        markdown = render_dashboard_markdown(base_dir=self.tools, repo_root=self._tmp.name)
        self.assertIn("HUMAN_REQUIRED unreadable: 2 (req-corrupt, req-unreadable)", markdown)
        self.assertIn("HUMAN_REQUIRED open: 1", markdown)

    def test_the_anchor_stale_sweep_carries_and_never_dispositions_them(self) -> None:
        from aria_kernel.anchor_stale import _open_records

        undecided, handed, unreadable = _open_records(self.tools)
        named = {record.record_id for record in unreadable}
        self.assertEqual(named, {"req-corrupt", "req-unreadable"})
        for record in (*undecided, *handed):
            self.assertNotIn(str(record.get("request_id")), named,
                             "an unreadable record must never be dispositioned")

    def test_the_adjudication_sweep_names_them(self) -> None:
        from aria_kernel.human_required_adjudication import sweep_human_required_adjudications

        result = sweep_human_required_adjudications(base_dir=self.tools)
        self.assertEqual(set(result["unreadable_records"]), {"req-corrupt", "req-unreadable"})

    def test_the_cli_list_prints_them(self) -> None:
        from aria_kernel.cli import main as cli_main

        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            code = cli_main(["--tools-dir", str(self.tools), "human-required", "list"])
        self.assertEqual(code, 0)
        payload = json.loads(buffer.getvalue())
        self.assertEqual([row["request_id"] for row in payload["open"]], ["req-open"])
        self.assertEqual(
            {entry["request_id"] for entry in payload["unreadable"]},
            {"req-corrupt", "req-unreadable"},
        )


class CorruptedFileHealTests(UnreadableFixture):
    """The sanctioned single-record semantics: a rewrite heals, a read of a
    corrupted record is bounded by the listing naming it (HIGH-108's
    detectable tier), never by silence."""

    def setUp(self) -> None:
        super().setUp()
        # record_human_required's own path (a corrupted file is overwritten,
        # not skipped: the queue keeps exactly one record per request id).
        (self.tools / "human-required" / "req-heal.json").write_text("{not json", encoding="utf-8")

    def test_record_overwrites_a_corrupted_file(self) -> None:
        record_human_required(
            request_id="req-heal",
            severity="MEDIUM",
            reason="rewrite heals the corrupted record",
            base_dir=self.tools,
        )
        listing = list_human_required(base_dir=self.tools)
        self.assertIn("req-heal", [row["request_id"] for row in listing.rows])
        self.assertNotIn("req-heal", self._unreadable_ids(listing))

    def test_a_single_record_read_treats_unreadable_as_not_open(self) -> None:
        # open_human_required_record is the claim-release read (ARIA-HIGH-124):
        # for one request id, unreadable reads as "no open record" — bounded
        # by the listing naming the record, which the first test class proves.
        self.assertIsNone(open_human_required_record("req-corrupt", base_dir=self.tools))
        self.assertIsNotNone(open_human_required_record("req-open", base_dir=self.tools))


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
