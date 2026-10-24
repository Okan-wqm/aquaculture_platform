"""Plan 026R §A.5 — the registry is read strictly.

WHY. A corrupt registry row read tolerantly is a finding silently dropped.
The kernel used to parse findings.jsonl itself, strictly by default with an
operator opt-in tolerant mode. Since MF-1 (PROC-HIGH-039) the kernel reads
the registry only through the registry CLI's projection
(``report_ingestion.read_registry_view``); the projection parses every row
or refuses, so there is no tolerant mode left to opt into — a second parser
that skipped rows would also read the stored state, the copy that lags.

WHAT these tests pin:
  * a clean registry projects every row;
  * a corrupt row refuses the view by name, and report ingestion with it,
    instead of dropping the row.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel.report_ingestion import read_registry_view, report_ingestion_scan
from aria_kernel.tool_registry import GovernanceError
from aria_kernel.workspace import ensure_workspace, workspace_paths

from tests.test_report_ingestion_registry_view import _ProjectionRepo, _chained, _registry_row

_REPO_ROOT = Path(__file__).resolve().parents[2]


@unittest.skipUnless((_REPO_ROOT / "node_modules/.bin/ts-node").is_file(),
                     "the repository's ts-node is not installed in this checkout")
class RegistryReadIsStrictTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="aria-a5-strict-")
        self.repo = _ProjectionRepo(Path(self.tmp.name) / "repo")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_a_clean_registry_projects_every_row(self) -> None:
        self.repo.write_registry([_registry_row("ARIA-HIGH-961"), _registry_row("ARIA-LOW-962")])
        self.repo.commit("chore(registry): seed", "2026-10-01T10:00:00Z")
        self.assertEqual([row["id"] for row in read_registry_view(self.repo.root).rows],
                         ["ARIA-HIGH-961", "ARIA-LOW-962"])

    def test_a_corrupt_row_refuses_the_view_and_ingestion_by_name(self) -> None:
        chained = _chained([_registry_row("ARIA-HIGH-961"), _registry_row("ARIA-LOW-962")])
        first, second = chained.splitlines()
        self.repo.write("docs/reviews/_registry/findings.jsonl", f"{first}\n{{not valid json\n{second}\n")
        self.repo.commit("chore(registry): a torn row", "2026-10-01T10:00:00Z")
        with self.assertRaises(GovernanceError) as ctx:
            read_registry_view(self.repo.root)
        self.assertIn("finding_registry_cli_refused", str(ctx.exception))
        paths = workspace_paths(self.repo.root, Path(self.tmp.name) / "ws")
        ensure_workspace(paths)
        with self.assertRaises(GovernanceError):
            report_ingestion_scan(paths, cycle_id="c1")


if __name__ == "__main__":
    unittest.main()
