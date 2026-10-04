"""ARIA-HIGH-279 — every kernel read of the review registry sees delta rows.

WHY. Program plan rev2 F-P2 moves a PR's registry write out of the
hash-chained ``docs/reviews/_registry/findings.jsonl`` into its own
``docs/reviews/_registry/deltas/<branch>.jsonl``; a fold later writes those
rows into the chain. The kernel read ``findings.jsonl`` directly at three
sites, each with its own parser — report ingestion
(``report_ingestion.py:55``), the deadline organ (``deadlines.py:191``) and
the ORPHAN evidence attach (``plan_synthesizer.py:571``) — so a finding a
merged PR added, or a transition it recorded, stayed invisible to all three
until the fold ran, and ingestion cited ``findings.jsonl`` for a row that was
not in it (``report_ingestion.py:263``).

WHAT these tests pin:
  * ``read_registry_view`` folds delta rows over the chain: a row for a
    known id replaces it in place (the transition ``close``/``reopen`` make
    by rewriting the row), a new id is appended, and every entry names the
    file that holds its effective row.
  * a delta row with no id, a state outside the registry's five, or an id
    two delta files both claim is refused in strict mode and recorded as
    malformed in tolerant mode — never folded silently.
  * an ``override_of`` successor is its own finding: the overridden row is
    not rewritten (the README's successor-finding pattern).
  * all three kernel sites read through the view, observed by behaviour.
"""
from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from aria_kernel import deadlines
from aria_kernel.ledger import read_jsonl
from aria_kernel.plan_synthesizer import scan_orphan_findings
from aria_kernel.report_ingestion import (
    REGISTRY_DELTAS_RELPATH,
    REGISTRY_FINDINGS_RELPATH,
    REGISTRY_STATES,
    read_registry_view,
    report_ingestion_scan,
)
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir
from aria_kernel.workspace import ensure_workspace, workspace_paths

_REPO_ROOT = Path(__file__).resolve().parents[2]
_BASE_REF = "docs/reviews/_registry/findings.jsonl"


def _finding(finding_id: str, state: str = "OPEN", **extra: Any) -> dict[str, Any]:
    row: dict[str, Any] = {
        "id": finding_id,
        "severity": "HIGH",
        "state": state,
        "title": f"finding {finding_id}",
        "owner_agent": "claude",
        "evidence": [],
        "override_of": None,
    }
    row.update(extra)
    return row


class _Repo:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.base = root.joinpath(*REGISTRY_FINDINGS_RELPATH)
        self.deltas = root.joinpath(*REGISTRY_DELTAS_RELPATH)
        self.base.parent.mkdir(parents=True, exist_ok=True)

    def write_base(self, rows: list[dict[str, Any]]) -> None:
        self.base.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")

    def write_delta(self, name: str, rows: list[dict[str, Any]] | list[str]) -> str:
        self.deltas.mkdir(parents=True, exist_ok=True)
        path = self.deltas / name
        lines = [row if isinstance(row, str) else json.dumps(row) for row in rows]
        path.write_text("".join(line + "\n" for line in lines), encoding="utf-8")
        return path.relative_to(self.root).as_posix()


class RegistryViewFoldTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="aria-registry-view-")
        self.repo = _Repo(Path(self.tmp.name))

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_the_chain_alone_is_read_as_written(self) -> None:
        self.repo.write_base([_finding("ARIA-HIGH-001"), _finding("ARIA-LOW-002", "RESOLVED")])
        view = read_registry_view(self.repo.root)
        self.assertEqual([row["id"] for row in view.rows], ["ARIA-HIGH-001", "ARIA-LOW-002"])
        self.assertEqual({entry.source for entry in view.entries}, {_BASE_REF})
        self.assertEqual(view.malformed, ())

    def test_a_delta_transition_replaces_the_row_in_place_and_names_its_file(self) -> None:
        self.repo.write_base([_finding("ARIA-HIGH-001"), _finding("ARIA-HIGH-002")])
        ref = self.repo.write_delta("fix-x.jsonl", [
            _finding("ARIA-HIGH-001", "RESOLVED", closing_commits=["abc1234"]),
        ])
        view = read_registry_view(self.repo.root)
        self.assertEqual([row["id"] for row in view.rows], ["ARIA-HIGH-001", "ARIA-HIGH-002"])
        first = view.entries[0]
        self.assertEqual((first.row["state"], first.source), ("RESOLVED", ref))
        self.assertEqual(view.entries[1].source, _BASE_REF)

    def test_a_delta_finding_is_appended_and_later_rows_of_one_file_win(self) -> None:
        self.repo.write_base([_finding("ARIA-HIGH-001")])
        ref = self.repo.write_delta("feat-y.jsonl", [
            _finding("ARIA-MEDIUM-003"),
            _finding("ARIA-MEDIUM-003", "IN-PROGRESS"),
        ])
        view = read_registry_view(self.repo.root)
        self.assertEqual([row["id"] for row in view.rows], ["ARIA-HIGH-001", "ARIA-MEDIUM-003"])
        self.assertEqual((view.entries[1].row["state"], view.entries[1].source), ("IN-PROGRESS", ref))

    def test_an_override_successor_does_not_rewrite_the_row_it_overrides(self) -> None:
        self.repo.write_base([_finding("ARIA-HIGH-001", "RESOLVED")])
        self.repo.write_delta("reopen.jsonl", [_finding("ARIA-HIGH-004", override_of="ARIA-HIGH-001")])
        view = {row["id"]: row for row in read_registry_view(self.repo.root).rows}
        self.assertEqual(view["ARIA-HIGH-001"]["state"], "RESOLVED")
        self.assertEqual(
            (view["ARIA-HIGH-004"]["state"], view["ARIA-HIGH-004"]["override_of"]),
            ("OPEN", "ARIA-HIGH-001"),
        )

    def test_two_delta_files_claiming_one_finding_are_a_conflict_not_a_choice(self) -> None:
        self.repo.write_base([_finding("ARIA-HIGH-001")])
        first = self.repo.write_delta("a.jsonl", [_finding("ARIA-HIGH-001", "RESOLVED")])
        second = self.repo.write_delta("b.jsonl", [_finding("ARIA-HIGH-001", "BLOCKED")])
        with self.assertRaises(GovernanceError) as ctx:
            read_registry_view(self.repo.root)
        self.assertIn(f"finding_registry_delta_conflict:ARIA-HIGH-001:{first}", str(ctx.exception))
        self.assertIn(second, str(ctx.exception))
        tolerant = read_registry_view(self.repo.root, strict=False)
        self.assertEqual(tolerant.entries[0].row["state"], "RESOLVED")
        self.assertEqual([item["file"] for item in tolerant.malformed], [second])

    def test_a_delta_row_without_an_id_or_a_registry_state_is_refused(self) -> None:
        self.repo.write_base([_finding("ARIA-HIGH-001")])
        ref = self.repo.write_delta("bad.jsonl", [
            {"state": "RESOLVED"},
            _finding("ARIA-HIGH-001", "DONE"),
        ])
        with self.assertRaises(GovernanceError) as ctx:
            read_registry_view(self.repo.root)
        self.assertIn(f"finding_registry_delta_row_without_id:{ref}:1", str(ctx.exception))
        tolerant = read_registry_view(self.repo.root, strict=False)
        self.assertEqual(tolerant.entries[0].row["state"], "OPEN")
        self.assertEqual(
            [item["reason"] for item in tolerant.malformed], ["row_without_id", "row_state_unknown"],
        )

    def test_a_corrupt_delta_line_follows_the_registry_s_strict_contract(self) -> None:
        self.repo.write_base([_finding("ARIA-HIGH-001")])
        ref = self.repo.write_delta("torn.jsonl", ['{"id": "ARIA-HIGH-001"'])
        with self.assertRaises(GovernanceError):
            read_registry_view(self.repo.root)
        tolerant = read_registry_view(self.repo.root, strict=False)
        self.assertEqual([item["file"] for item in tolerant.malformed], [ref])

    def test_an_absent_chain_is_not_an_empty_registry(self) -> None:
        with self.assertRaises(FileNotFoundError):
            read_registry_view(self.repo.root)

    def test_the_fold_states_are_the_registry_schema_s_states(self) -> None:
        schema = json.loads(
            (_REPO_ROOT / "docs/reviews/_registry/findings.jsonl.schema.json").read_text(encoding="utf-8"),
        )
        self.assertEqual(REGISTRY_STATES, frozenset(schema["properties"]["state"]["enum"]))

    def test_the_live_registry_reads_through_the_view(self) -> None:
        chain = _REPO_ROOT.joinpath(*REGISTRY_FINDINGS_RELPATH).read_text(encoding="utf-8")
        chain_ids = {json.loads(line)["id"] for line in chain.splitlines() if line.strip()}
        view = read_registry_view(_REPO_ROOT)
        self.assertEqual(view.malformed, ())
        self.assertLessEqual(chain_ids, {row["id"] for row in view.rows})


class KernelReadSitesSeeDeltaRowsTests(unittest.TestCase):
    """Each former direct reader, observed through its own output."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="aria-registry-sites-")
        self.repo = _Repo(Path(self.tmp.name) / "repo")
        for argv in (
            ("init", "-q"),
            ("config", "user.email", "aria@example.test"),
            ("config", "user.name", "ARIA Test"),
        ):
            subprocess.run(["git", *argv], cwd=self.repo.root, check=True)
        self.paths = workspace_paths(self.repo.root, Path(self.tmp.name) / "ws")
        ensure_workspace(self.paths)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_ingestion_ingests_a_delta_finding_and_cites_the_delta_file(self) -> None:
        self.repo.write_base([_finding("ARIA-HIGH-001", "RESOLVED")])
        self.assertEqual(report_ingestion_scan(self.paths, cycle_id="c1")["status"], "baselined")
        ref = self.repo.write_delta("feat-y.jsonl", [_finding("ARIA-HIGH-002")])
        result = report_ingestion_scan(self.paths, cycle_id="c2")
        self.assertEqual([item["finding_key"] for item in result["ingested"]], ["ARIA-HIGH-002"])
        events = [row for row in read_jsonl(self.paths.ledgers["missed_signals"]) if row.get("cycle_id") == "c2"]
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["evidence_refs"], [ref])

    def test_ingestion_skips_a_finding_a_delta_resolved(self) -> None:
        self.repo.write_base([_finding("ARIA-HIGH-001", "RESOLVED")])
        report_ingestion_scan(self.paths, cycle_id="c1")
        self.repo.write_base([_finding("ARIA-HIGH-001", "RESOLVED"), _finding("ARIA-HIGH-002")])
        self.repo.write_delta("fix-z.jsonl", [_finding("ARIA-HIGH-002", "RESOLVED")])
        result = report_ingestion_scan(self.paths, cycle_id="c2")
        self.assertEqual((result["ingested_count"], result["skipped_count"]), (0, 1))

    def test_the_deadline_organ_tracks_the_folded_state(self) -> None:
        due = (datetime.now(timezone.utc) + timedelta(days=3)).date().isoformat()
        self.repo.write_base([_finding("ARIA-HIGH-001", deadline=due), _finding("ARIA-HIGH-002", deadline=due)])
        self.repo.write_delta("fix.jsonl", [
            _finding("ARIA-HIGH-001", "RESOLVED", deadline=due),
            _finding("ARIA-HIGH-005", deadline=due),
        ])
        tools = ensure_tools_dir(Path(self.tmp.name) / "aria-tools")
        rows = deadlines.read_registry_deadlines(tools, self.repo.root)
        self.assertEqual(sorted(row.key for row in rows), ["ARIA-HIGH-002", "ARIA-HIGH-005"])

    def test_orphan_plan_evidence_comes_from_the_folded_row(self) -> None:
        orphan = self.repo.root / "docs" / "reviews" / "orphan-findings.md"
        orphan.write_text("## ORPHAN-HIGH-501\nStatus: OPEN\nbody\n", encoding="utf-8")
        self.repo.write_base([_finding("ORPHAN-HIGH-501", evidence=["apps/a.ts:1"])])
        self.repo.write_delta("evidence.jsonl", [_finding("ORPHAN-HIGH-501", evidence=["apps/b.ts:2"])])
        candidates = scan_orphan_findings(self.repo.root)
        self.assertEqual(candidates[0].get("evidence"), ["apps/b.ts:2"])


if __name__ == "__main__":
    unittest.main()
