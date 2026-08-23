"""Strict admission for fixture evidence that can authorize promotion.

The fixture-runs surface drives CALIBRATE -> SHADOW and SHADOW -> ACTIVE.
These tests pin the reader boundary itself: a valid append-only ledger is
accepted, while history rewrites, payload tamper, hostile file types, and
schema drift fail before a row can become promotion evidence.
"""
from __future__ import annotations

import hashlib
import json
import multiprocessing
import os
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch

from aria_kernel import fixture_runner as fixture_runner_module
from aria_kernel.contention_replay import replay_append_only_suffixes
from aria_kernel.fixture_runner import (
    fixture_runs_path,
    latest_fixture_status,
    load_fixture_runs,
)
from aria_kernel.ledger import (
    LedgerIntegrityError,
    LedgerReadLimitError,
    append_declared_jsonl,
)
from aria_kernel.tool_registry import ensure_tools_dir


FIXTURE_RUN_SCHEMA = "aria/agent-eval-fixture-run/v1"
FIXTURE_LEDGER_READ_BUDGET_BYTES = 64 * 1024 * 1024


def _suite_evidence_hash(row: dict[str, Any]) -> str:
    excluded = {
        "evidence_hash",
        "at",
        "execution_run_id",
        "row_type",
        "schema_version",
        "ledger_hash",
        "previous_ledger_hash",
    }
    payload = {key: value for key, value in row.items() if key not in excluded}
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _fixture_row(
    *,
    tool_id: str = "fixture-adapter",
    run_id: str = "exec-fixture-1",
    cycle_id: str = "cycle-1",
    **overrides: Any,
) -> dict[str, Any]:
    row: dict[str, Any] = {
        "$schema": FIXTURE_RUN_SCHEMA,
        "schema_version": 1,
        "row_type": "fixture_run_suite",
        "at": "2026-08-23T00:00:00Z",
        "tool_id": tool_id,
        "tool_version": "1.0.0",
        "tool_manifest_hash": "sha256:" + "1" * 64,
        "fixture_set_hash": "sha256:" + "2" * 64,
        "cycle_id": cycle_id,
        "fixture_set": f"fixtures/{tool_id}",
        "passed": True,
        "case_count": 2,
        "fixture_lanes": {
            "real_repo_baseline": 1,
            "semantic_regression": 1,
        },
        "fixture_baseline_passed": True,
        "semantic_fixture_passed": True,
        "failed_cases": [],
        "cases": [
            {"name": "baseline", "lane": "real_repo_baseline", "passed": True},
            {"name": "semantic", "lane": "semantic_regression", "passed": True},
        ],
        "execution_run_id": run_id,
        "actual_status": "pass",
        "error_code": None,
    }
    row.update(overrides)
    row["evidence_hash"] = _suite_evidence_hash(row)
    return row


def _ledger_hash(row: dict[str, Any], previous_hash: str | None) -> str:
    payload = dict(row)
    payload.pop("ledger_hash", None)
    payload.pop("previous_ledger_hash", None)
    canonical = json.dumps(
        {"previous_ledger_hash": previous_hash, "record": payload},
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
    )
    return "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _rewrite_valid_chain(path: Path, rows: list[dict[str, Any]]) -> None:
    previous_hash: str | None = None
    encoded: list[str] = []
    for source in rows:
        row = dict(source)
        row["previous_ledger_hash"] = previous_hash
        row["ledger_hash"] = _ledger_hash(row, previous_hash)
        previous_hash = row["ledger_hash"]
        encoded.append(json.dumps(row, sort_keys=True, separators=(",", ":")))
    path.write_text("\n".join(encoded) + "\n", encoding="utf-8")


def _load_fixture_runs_in_child(path: str, queue: Any) -> None:
    try:
        load_fixture_runs("fixture-adapter", base_dir=path)
    except BaseException as exc:  # pragma: no branch - child reports boundary
        queue.put((type(exc).__name__, str(exc)))
    else:
        queue.put(("returned", ""))


class FixtureRunStrictReadTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-fixture-strict-")
        self.tools = ensure_tools_dir(Path(self._tmp.name) / "aria-tools")
        self.path = fixture_runs_path(self.tools)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _append(self, **overrides: Any) -> dict[str, Any]:
        return append_declared_jsonl(
            self.path,
            _fixture_row(**overrides),
            expected_surface="agent_eval_fixture_runs",
        )

    def _two_rows(self) -> list[dict[str, Any]]:
        self._append(run_id="exec-fixture-1", cycle_id="cycle-1")
        self._append(run_id="exec-fixture-2", cycle_id="cycle-2")
        return [json.loads(line) for line in self.path.read_text().splitlines()]

    def test_absent_optional_ledger_preserves_empty_result(self) -> None:
        self.assertFalse(self.path.exists())
        self.assertEqual(
            load_fixture_runs("fixture-adapter", base_dir=self.tools),
            [],
        )

    def test_valid_declared_ledger_filters_without_changing_api(self) -> None:
        self._append()
        self._append(tool_id="other-adapter", run_id="exec-other")

        rows = load_fixture_runs("fixture-adapter", base_dir=self.tools)

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["execution_run_id"], "exec-fixture-1")

    def test_contention_replay_preserves_fixture_reader_and_latest_status_api(
        self,
    ) -> None:
        loser_tools = ensure_tools_dir(Path(self._tmp.name) / "loser-tools")
        loser_path = fixture_runs_path(loser_tools)
        base_row = _fixture_row(run_id="exec-base", cycle_id="cycle-base")
        winner_base = append_declared_jsonl(
            self.path,
            base_row,
            expected_surface="agent_eval_fixture_runs",
        )
        append_declared_jsonl(
            loser_path,
            base_row,
            expected_surface="agent_eval_fixture_runs",
        )
        loser_row = _fixture_row(run_id="exec-loser", cycle_id="cycle-loser")
        append_declared_jsonl(
            loser_path,
            loser_row,
            expected_surface="agent_eval_fixture_runs",
        )

        replayed = replay_append_only_suffixes(
            surfaces={
                "agent_eval_fixture_runs": {
                    "winner_path": self.path,
                    "loser_path": loser_path,
                    "base_row_count": 1,
                    "base_tail_hash": winner_base["ledger_hash"],
                },
            },
            replay_transaction_id="fixture-reader-replay",
        )

        rows = load_fixture_runs("fixture-adapter", base_dir=self.tools)
        self.assertEqual(replayed.replayed_rows, 1)
        self.assertEqual(
            [row["execution_run_id"] for row in rows],
            ["exec-base", "exec-loser"],
        )
        with (
            patch.object(
                fixture_runner_module,
                "get_tool",
                return_value={"version": "1.0.0"},
            ),
            patch.object(
                fixture_runner_module,
                "tool_manifest_hash",
                return_value=loser_row["tool_manifest_hash"],
            ),
            patch.object(
                fixture_runner_module,
                "resolve_fixture_dir",
                return_value=Path(self._tmp.name) / "fixtures",
            ),
            patch.object(
                fixture_runner_module,
                "fixture_set_hash",
                return_value=loser_row["fixture_set_hash"],
            ),
        ):
            status = latest_fixture_status(
                "fixture-adapter",
                base_dir=self.tools,
            )
        self.assertTrue(status["current_tool_passed"])
        self.assertEqual(status["latest"]["execution_run_id"], "exec-loser")

    def test_deleted_prefix_is_rejected(self) -> None:
        rows = self._two_rows()
        self.path.write_text(
            json.dumps(rows[1], sort_keys=True, separators=(",", ":")) + "\n",
            encoding="utf-8",
        )

        with self.assertRaises(LedgerIntegrityError):
            load_fixture_runs("fixture-adapter", base_dir=self.tools)

    def test_replaced_prefix_is_rejected(self) -> None:
        rows = self._two_rows()
        replacement = _fixture_row(
            tool_id="replacement-adapter",
            run_id="exec-replacement",
        )
        replacement["previous_ledger_hash"] = None
        replacement["ledger_hash"] = _ledger_hash(replacement, None)
        self.path.write_text(
            "\n".join(
                json.dumps(row, sort_keys=True, separators=(",", ":"))
                for row in (replacement, rows[1])
            )
            + "\n",
            encoding="utf-8",
        )

        with self.assertRaises(LedgerIntegrityError):
            load_fixture_runs("fixture-adapter", base_dir=self.tools)

    def test_bad_previous_hash_is_rejected(self) -> None:
        rows = self._two_rows()
        rows[1]["previous_ledger_hash"] = "sha256:" + "f" * 64
        self.path.write_text(
            "\n".join(
                json.dumps(row, sort_keys=True, separators=(",", ":"))
                for row in rows
            )
            + "\n",
            encoding="utf-8",
        )

        with self.assertRaises(LedgerIntegrityError):
            load_fixture_runs("fixture-adapter", base_dir=self.tools)

    def test_payload_tamper_stays_rejected_after_attacker_rechains(self) -> None:
        rows = self._two_rows()
        rows[-1]["passed"] = False
        rows[-1]["actual_status"] = "fail"
        # Recompute the public ledger chain, but deliberately retain the
        # suite evidence hash that attests the original payload.
        _rewrite_valid_chain(self.path, rows)

        with self.assertRaises(LedgerIntegrityError):
            load_fixture_runs("fixture-adapter", base_dir=self.tools)

    def test_oversized_ledger_is_rejected_before_json_decode(self) -> None:
        with self.path.open("wb") as handle:
            handle.truncate(FIXTURE_LEDGER_READ_BUDGET_BYTES + 1)

        with self.assertRaises(LedgerReadLimitError):
            load_fixture_runs("fixture-adapter", base_dir=self.tools)

    def test_oversized_line_is_rejected_by_the_public_reader_budget(self) -> None:
        self._append()

        with patch(
            "aria_kernel.fixture_runner.FIXTURE_RUN_LEDGER_MAX_LINE_BYTES",
            256,
            create=True,
        ):
            with self.assertRaises(LedgerReadLimitError):
                load_fixture_runs("fixture-adapter", base_dir=self.tools)

    def test_row_cap_is_enforced_before_rows_are_retained(self) -> None:
        self._two_rows()

        with patch(
            "aria_kernel.fixture_runner.FIXTURE_RUN_LEDGER_MAX_ROWS",
            1,
            create=True,
        ):
            with self.assertRaises(LedgerReadLimitError):
                load_fixture_runs("fixture-adapter", base_dir=self.tools)

    def test_json_nesting_depth_129_is_rejected_before_decode(self) -> None:
        row = _fixture_row()
        nested: Any = "leaf"
        # Top-level object + cases list + case object + 126 list levels = 129.
        for _ in range(126):
            nested = [nested]
        row["cases"][0]["diagnostic"] = nested
        row["evidence_hash"] = _suite_evidence_hash(row)
        _rewrite_valid_chain(self.path, [row])

        with self.assertRaisesRegex(
            LedgerIntegrityError,
            "json_nesting_limit_exceeded",
        ):
            load_fixture_runs("fixture-adapter", base_dir=self.tools)

    def test_unexpected_top_level_producer_field_is_rejected(self) -> None:
        self._append(unexpected_nested={"accepted_if_schema_is_open": True})

        with self.assertRaisesRegex(
            LedgerIntegrityError,
            "unexpected_top_level_fields",
        ):
            load_fixture_runs("fixture-adapter", base_dir=self.tools)

    def test_symlink_ledger_is_rejected(self) -> None:
        self._append()
        real = self.tools / "real-fixture-runs.jsonl"
        self.path.replace(real)
        self.path.symlink_to(real)

        with self.assertRaises(LedgerIntegrityError):
            load_fixture_runs("fixture-adapter", base_dir=self.tools)

    @unittest.skipUnless(hasattr(os, "mkfifo"), "POSIX FIFO required")
    def test_fifo_ledger_is_rejected_without_blocking(self) -> None:
        os.mkfifo(self.path)
        context = multiprocessing.get_context("fork")
        queue = context.Queue()
        process = context.Process(
            target=_load_fixture_runs_in_child,
            args=(self.tools.as_posix(), queue),
        )
        process.start()
        process.join(timeout=2)
        if process.is_alive():
            process.terminate()
            process.join(timeout=2)
            self.fail("fixture ledger reader blocked on a FIFO")
        self.assertEqual(process.exitcode, 0)
        kind, message = queue.get(timeout=1)
        self.assertEqual(kind, "LedgerIntegrityError", message)

    def test_path_replacement_during_read_is_rejected(self) -> None:
        self._append()
        replacement = self.tools / "fixture-runs-replacement.jsonl"
        replacement.write_bytes(self.path.read_bytes())
        real_read = os.read
        replaced = False

        def replace_after_first_read(descriptor: int, size: int) -> bytes:
            nonlocal replaced
            content = real_read(descriptor, size)
            if not replaced:
                replacement.replace(self.path)
                replaced = True
            return content

        with patch("aria_kernel.fixture_runner.os.read", side_effect=replace_after_first_read):
            with self.assertRaises(LedgerIntegrityError):
                load_fixture_runs("fixture-adapter", base_dir=self.tools)

    def test_schema_version_and_row_type_drift_are_rejected(self) -> None:
        invalid = (
            {"$schema": "aria/other/v1"},
            {"schema_version": 2},
            {"schema_version": True},
            {"row_type": "fixture"},
            {"tool_id": 42},
            {"passed": "true"},
        )
        for index, override in enumerate(invalid):
            with self.subTest(override=override):
                self.path.unlink(missing_ok=True)
                self._append(run_id=f"exec-invalid-{index}", **override)
                with self.assertRaises(LedgerIntegrityError):
                    load_fixture_runs("fixture-adapter", base_dir=self.tools)


if __name__ == "__main__":
    unittest.main()
