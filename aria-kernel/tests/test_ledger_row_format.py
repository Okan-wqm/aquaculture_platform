"""ORPHAN-HIGH-552 — one row format, written by the appender itself.

Two writers shared each governed ledger and disagreed about its format:
``append_declared_jsonl`` wrote rows WITHOUT ``schema_version``, while the
tools migration restamped every row to the contract's version and re-chained
from the first unstamped row onward. The migration runs on every restore
(``tools_contract_version`` reads ``repo_identity.json``, which deliberately
does not travel on ``aria/state``), so each night's bind rewrote the rows the
previous night appended and moved the surface's ``tail_ledger_hash`` — which
is exactly the row ``append_only_suffix`` checks, making every cross-restore
replay refuse with ``replay_prefix_diverged``.

The fix is that the appender stamps the contract's ``schema_version`` itself,
from the SAME definition the migration uses (``stamp_row_format``), so an
unstamped row on a declared surface stops being possible and the migration's
restamp becomes the identity.
"""

from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

from aria_kernel import migration as migration_module
from aria_kernel.ledger import (
    ROW_FORMAT_VERSION,
    append_declared_jsonl,
    append_jsonl,
    read_jsonl,
    stamp_row_format,
    state_transaction,
)
from aria_kernel.tool_registry import ensure_tools_dir

_helpers_path = Path(__file__).parent / "_helpers" / "git_fixtures.py"
_spec = importlib.util.spec_from_file_location("aria_kernel_test_helpers_git_fixtures", _helpers_path)
git_fixtures = importlib.util.module_from_spec(_spec)
sys.modules.setdefault("aria_kernel_test_helpers_git_fixtures", git_fixtures)
_spec.loader.exec_module(git_fixtures)


class RowFormatStampTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmpdir = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmpdir.name)
        self.addCleanup(self._tmpdir.cleanup)
        self.tools = self.tmp / "aria-tools"
        ensure_tools_dir(self.tools)

    def test_the_governed_appender_stamps_the_contract_version(self) -> None:
        path = self.tools / "governance.jsonl"
        stored = append_declared_jsonl(path, {"event": "first"}, expected_surface="tools_governance")
        self.assertEqual(stored["schema_version"], ROW_FORMAT_VERSION)
        on_disk = read_jsonl(path)[0]
        self.assertEqual(on_disk["schema_version"], ROW_FORMAT_VERSION)

    def test_a_spoken_schema_version_is_never_overwritten(self) -> None:
        # `schema_version` is the SURFACE's payload-contract field whenever
        # the writer states it — the live branch carries fifteen ledgers of
        # explicit `1` (cost attribution, mission events, plans/events, …).
        # The old migration rule (`< 2 -> 2`) bumped those on every restore
        # bind, which was ORPHAN-HIGH-552 itself for those surfaces.
        path = self.tools / "governance.jsonl"
        for declared in (1, 3):
            stored = append_declared_jsonl(
                path,
                {"event": f"v{declared}-row", "schema_version": declared},
                expected_surface="tools_governance",
            )
            self.assertEqual(stored["schema_version"], declared)

    def test_the_transactional_appender_stamps_identically(self) -> None:
        path = self.tools / "governance.jsonl"
        with state_transaction([path]) as txn:
            stored = txn.append_declared_jsonl(path, {"event": "txn"}, expected_surface="tools_governance")
        self.assertEqual(stored["schema_version"], ROW_FORMAT_VERSION)

    def test_an_undeclared_path_is_not_aria_s_contract_to_stamp(self) -> None:
        # append_jsonl on an arbitrary path (test fixtures, scratch ledgers)
        # must not be rewritten into ARIA's row format — the manifest is the
        # boundary of the contract.
        path = self.tmp / "scratch.jsonl"
        stored = append_jsonl(path, {"event": "raw"})
        self.assertNotIn("schema_version", stored)

    def test_the_migration_restamp_is_the_same_definition_the_appender_uses(self) -> None:
        # "Two writers, one file, two formats" dies only if there is ONE
        # format definition. A behavioural equality test would pass today and
        # rot the day someone re-inlines a second copy; identity is the pin.
        self.assertIs(migration_module.stamp_row_format, stamp_row_format)
        self.assertFalse(hasattr(migration_module, "_restamp"))

    def test_restamping_an_appended_row_is_the_identity(self) -> None:
        path = self.tools / "governance.jsonl"
        append_declared_jsonl(path, {"event": "first"}, expected_surface="tools_governance")
        row = read_jsonl(path)[0]
        self.assertEqual(stamp_row_format(row), row)


class MigrationContentIdempotenceTests(unittest.TestCase):
    """The production loop's core: a restored tree binds without rewriting.

    ``repo_identity.json`` and ``migration_state.json`` do not travel on
    ``aria/state`` (host-local by design), so every restore re-runs
    ``migrate_tools_v1_to_v2`` over a tree whose ledgers carry real rows.
    That rewrite must be byte-identical — the published ``tail_ledger_hash``
    is what ``append_only_suffix`` proves replay prefixes against.
    """

    def setUp(self) -> None:
        self._tmpdir = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmpdir.name)
        self.addCleanup(self._tmpdir.cleanup)
        self.repo = git_fixtures.make_local_git_repo(
            self.tmp, name="repo", remote_url="https://github.com/test-owner/test-repo.git"
        )
        from aria_kernel.migration import migrate_workspace_v1_to_v2

        self.workspace_base = self.tmp / "ws"
        self.workspace_base.mkdir()
        migrate_workspace_v1_to_v2(
            workspace_root=self.repo,
            workspace_base=self.workspace_base,
            acknowledge=True,
            reason="ORPHAN-HIGH-552 fixture workspace bootstrap",
        )
        self.tools = self.tmp / "aria-tools"

    def _bind(self) -> None:
        from aria_kernel.migration import migrate_tools_bootstrap

        migrate_tools_bootstrap(
            tools_dir=self.tools,
            workspace_root=self.repo,
            acknowledge=True,
            reason="ORPHAN-HIGH-552 restore-bind loop",
        )

    def test_a_restore_bind_does_not_move_the_appended_tail(self) -> None:
        # Night 1: bootstrap, then append through the governed writer.
        self._bind()
        ledger = self.tools / "runs.jsonl"
        append_declared_jsonl(ledger, {"event": "night-1-work"}, expected_surface="runs")
        published_rows = ledger.read_text(encoding="utf-8")
        published_tail = read_jsonl(ledger)[-1]["ledger_hash"]

        # The restore boundary: host-local markers do not travel.
        (self.tools / "repo_identity.json").unlink()
        (self.tools / "migration_state.json").unlink(missing_ok=True)

        # Night 2: the restore action re-binds the tree.
        self._bind()

        self.assertEqual(
            read_jsonl(ledger)[-1]["ledger_hash"],
            published_tail,
            "the bind rewrote a row the previous night appended — the published "
            "tail did not survive the restore (ORPHAN-HIGH-552)",
        )
        self.assertEqual(ledger.read_text(encoding="utf-8"), published_rows)

    def test_no_row_leaves_the_appender_silent(self) -> None:
        # A silent row is the only thing the old restamp could legitimately
        # rewrite, so the appender makes silence impossible; explicit
        # contract versions pass through untouched.
        self._bind()
        ledger = self.tools / "runs.jsonl"
        append_declared_jsonl(ledger, {"event": "silent-row"}, expected_surface="runs")
        append_declared_jsonl(
            ledger, {"event": "contract-row", "schema_version": 1}, expected_surface="runs"
        )
        rows = read_jsonl(ledger)
        self.assertNotIn("<ABSENT>", [row.get("schema_version", "<ABSENT>") for row in rows])
        self.assertEqual(rows[-2]["schema_version"], ROW_FORMAT_VERSION)
        self.assertEqual(rows[-1]["schema_version"], 1)

    def test_json_shape_survives_the_stamp(self) -> None:
        # The stamp must ride the canonical serialisation, not fight it.
        self._bind()
        ledger = self.tools / "runs.jsonl"
        append_declared_jsonl(ledger, {"event": "shape"}, expected_surface="runs")
        line = ledger.read_text(encoding="utf-8").splitlines()[-1]
        parsed = json.loads(line)
        self.assertEqual(
            line,
            json.dumps(parsed, sort_keys=True, separators=(",", ":")),
        )


if __name__ == "__main__":
    unittest.main()
