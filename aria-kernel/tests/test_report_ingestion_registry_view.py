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

# ARIA-HIGH-602 — the live partition: this module reads the live checkout
# outside the kernel surface, so it runs in aria-kernel.yml's always-run
# `workspace` job (aria_kernel.live_partition), never in a skippable shard.
READS_LIVE_CHECKOUT = 'the live findings registry and its schema under docs/reviews/_registry/'

import hashlib
import json
import os
import shutil
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
        orphan.write_text("## ORPHAN-HIGH-501 — t — OPEN\nbody\n", encoding="utf-8")
        register = {"review_file": "docs/reviews/orphan-findings.md"}
        self.repo.write_base([_finding("ORPHAN-HIGH-501", evidence=["apps/a.ts:1"], **register)])
        self.repo.write_delta("evidence.jsonl", [_finding("ORPHAN-HIGH-501", evidence=["apps/b.ts:2"], **register)])
        candidates = scan_orphan_findings(self.repo.root)
        self.assertEqual(candidates[0].get("evidence"), ["apps/b.ts:2"])

    def test_an_orphan_filed_in_another_review_is_still_this_sources(self) -> None:
        """ARIA-LOW-607 — the scanner's ``review_file`` filter was the defect.

        31 OPEN ORPHAN rows sit against review files other than the register
        (20 in the codex-audit verification alone); a filter that kept only
        register-filed rows meant no plan source could ever reach them. The
        candidate now carries the row's own ``review_file`` (the trailer's
        owner), and no ``heading_line`` — the register holds no heading for a
        row it does not carry.
        """
        other = "docs/reviews/2026-07-26-aria-codex-audit-verification.md"
        self.repo.write_base([
            _finding("ORPHAN-HIGH-501", evidence=["apps/a.ts:1"], review_file="docs/reviews/orphan-findings.md"),
            _finding("ORPHAN-HIGH-502", evidence=["apps/b.ts:2"], review_file=other),
        ])
        by_id = {row["candidate_id"]: row for row in scan_orphan_findings(self.repo.root)}
        self.assertEqual(set(by_id), {"ORPHAN-HIGH-501", "ORPHAN-HIGH-502"})
        self.assertEqual(by_id["ORPHAN-HIGH-502"].get("review_file"), other)
        self.assertNotIn("heading_line", by_id["ORPHAN-HIGH-502"])



# ---------------------------------------------------------------------------
# MF-1 (PROC-HIGH-039) — the view IS the registry's projection.
#
# WHY. ``state: RESOLVED`` in findings.jsonl copied what the merged
# ``Closes:`` trailer records, and only the reconcile lane refreshed the copy;
# a kernel reader of the stored state saw every closure late. MF-1 derives
# RESOLVED at read time in ONE place, ``tools/gates/finding-registry-projection.ts``,
# and the kernel reads through its CLI (``finding-registry.ts project``) as
# ``autonomy_closure`` already does for ``verify``: a second closure
# implementation in Python would be a second owner of the same fact. The
# never-written ``deltas/`` fold goes with it, so one fold format remains.
#
# WHAT these tests pin (MF-DESIGN §7 T10, §5 MF-1 aria-kernel):
#   * a trailer merged into HEAD closes the finding in the view, with the
#     closer recorded, and a legacy RESOLVED row keeps its recorded closure;
#   * the view equals the CLI projection row for row;
#   * a ``deltas/`` directory is not read, and REGISTRY_DELTAS_RELPATH is gone;
#   * without the repository's ts-node the view refuses by name instead of
#     falling back to the stored file;
#   * the deadline organ and the adapter quarantine see a derived closure.
#
# The fixture is a real git repository carrying a copy of tools/gates and a
# link to this checkout's node_modules, so the CLI runs on the fixture's own
# history (the TS side builds the same shape in
# tests/invariants/helpers/registry-fixture-repo.ts).
# ---------------------------------------------------------------------------

_FIXTURE_REVIEW = "docs/reviews/claude/2026-10-23-mf-1-fixture.md"
_ZERO_HASH = "0" * 64
_COPIED_FILES = (
    "docs/reviews/_registry/findings.jsonl.schema.json",
    "docs/reviews/_registry/path-corrections.yaml",
    ".github/CODEOWNERS",
)
_TS_NODE = Path("node_modules/.bin/ts-node")


def _registry_row(finding_id: str, state: str = "OPEN", **extra: Any) -> dict[str, Any]:
    row: dict[str, Any] = {
        "id": finding_id,
        "severity": finding_id.split("-")[1],
        "state": state,
        "title": f"fixture finding {finding_id}",
        "layer": 1,
        "evidence": ["tools/gates/finding-registry.ts:1"],
        "owner_agent": "claude",
        "raised_in_cycle": "2026-10-23-mf-1-fixture",
        "review_file": _FIXTURE_REVIEW,
        "created_at": "2026-10-01T00:00:00Z",
        "closed_at": None,
        "closing_commits": [],
        "deadline": "2026-12-31",
        "owner_user": "Okan-wqm",
        "override_of": None,
        "prev_hash": "",
        "content_hash": "",
    }
    row.update(extra)
    return row


def _canonical(value: Any) -> str:
    # finding-registry-chain.ts canonicalJson: sorted keys, no whitespace.
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _chained(rows: list[dict[str, Any]]) -> str:
    previous = _ZERO_HASH
    lines: list[str] = []
    for source in rows:
        row = dict(source)
        row["prev_hash"] = previous
        body = {key: value for key, value in row.items() if key != "content_hash"}
        row["content_hash"] = hashlib.sha256(_canonical(body).encode("utf-8")).hexdigest()
        previous = row["content_hash"]
        lines.append(json.dumps(row, separators=(",", ":"), ensure_ascii=False))
    return "".join(line + "\n" for line in lines)


class _ProjectionRepo:
    """A git repository the registry CLI can run in, on its own history."""

    def __init__(self, root: Path, *, with_node: bool = True) -> None:
        self.root = root
        root.mkdir(parents=True)
        shutil.copytree(
            _REPO_ROOT / "tools" / "gates", root / "tools" / "gates",
            ignore=shutil.ignore_patterns("fixtures", "node_modules", "*.spec.ts"),
        )
        for rel in _COPIED_FILES:
            (root / rel).parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(_REPO_ROOT / rel, root / rel)
        if with_node:
            (root / "node_modules").symlink_to(_REPO_ROOT / "node_modules", target_is_directory=True)
        self.write(".gitignore", "node_modules\n")
        self.write(_FIXTURE_REVIEW, "# MF-1 fixture review\n")
        self.write("docs/reviews/_registry/finding-id-aliases.yaml", "version: 1\n\naliases: []\n")
        self.git("init", "-q", "-b", "main")

    def write(self, rel: str, text: str) -> None:
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")

    def write_registry(self, rows: list[dict[str, Any]]) -> None:
        self.write("/".join(REGISTRY_FINDINGS_RELPATH), _chained(rows))

    def git(self, *args: str, date: str | None = None) -> str:
        env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
        env.update({"GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null", "LC_ALL": "C"})
        if date is not None:
            env.update({"GIT_AUTHOR_DATE": date, "GIT_COMMITTER_DATE": date})
        return subprocess.run(
            ["git", "-c", "user.name=Registry Fixture", "-c", "user.email=fixture@example.invalid",
             "-c", "commit.gpgsign=false", *args],
            cwd=self.root, env=env, check=True, capture_output=True, text=True,
        ).stdout.strip()

    def commit(self, message: str, date: str) -> str:
        self.git("add", "-A")
        self.git("commit", "-q", "--allow-empty", "-m", message, date=date)
        return self.git("rev-parse", "HEAD")

    def merge(self, branch: str, date: str) -> str:
        self.git("merge", "--no-ff", "--no-edit", branch, date=date)
        return self.git("rev-parse", "HEAD")

    def close_by_merged_fix(self, finding_id: str, *, branch: str, fix_date: str, merge_date: str) -> str:
        """A fix branch whose commit carries the trailer, merged into main; returns the fix sha."""
        self.git("checkout", "-q", "-b", branch)
        fix = self.commit(f"fix(fixture): close {finding_id}\n\nCloses: {_FIXTURE_REVIEW}#{finding_id}", fix_date)
        self.git("checkout", "-q", "main")
        self.merge(branch, merge_date)
        return fix

    def project_cli(self) -> subprocess.CompletedProcess[str]:
        env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
        return subprocess.run(
            [str(self.root / _TS_NODE), "--project", "tools/gates/tsconfig.json",
             "tools/gates/finding-registry.ts", "project", "--format=jsonl"],
            cwd=self.root, env=env, check=False, capture_output=True, text=True, timeout=300,
        )


@unittest.skipUnless((_REPO_ROOT / _TS_NODE).is_file(), "the repository's ts-node is not installed in this checkout")
class RegistryViewIsTheProjectionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="aria-registry-projection-")
        self.repo = _ProjectionRepo(Path(self.tmp.name) / "repo")
        self.repo.write_registry([
            _registry_row("ARIA-HIGH-931"),
            _registry_row("ARIA-HIGH-932"),
            _registry_row("ARIA-LOW-933", "RESOLVED", closing_commits=["abcdef1"],
                          closed_at="2026-09-01T00:00:00.000Z"),
        ])
        self.repo.commit("chore(registry): seed the fixture registry", "2026-10-01T10:00:00Z")
        self.fix = self.repo.close_by_merged_fix(
            "ARIA-HIGH-932", branch="fix-932", fix_date="2026-10-02T10:00:00Z", merge_date="2026-10-03T10:00:00Z",
        )

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_a_merged_trailer_closes_the_finding_in_the_view(self) -> None:
        rows = {row["id"]: row for row in read_registry_view(self.repo.root).rows}
        self.assertEqual((rows["ARIA-HIGH-932"]["state"], rows["ARIA-HIGH-932"]["closing_commits"]),
                         ("RESOLVED", [self.fix]))
        self.assertEqual(rows["ARIA-HIGH-931"]["state"], "OPEN")
        self.assertEqual(
            (rows["ARIA-LOW-933"]["state"], rows["ARIA-LOW-933"]["closing_commits"], rows["ARIA-LOW-933"]["closed_at"]),
            ("RESOLVED", ["abcdef1"], "2026-09-01T00:00:00.000Z"),
        )

    def test_the_view_equals_the_registry_cli_projection(self) -> None:
        completed = self.repo.project_cli()
        self.assertEqual(completed.returncode, 0, completed.stderr)
        projected = {row["id"]: row for row in map(json.loads, filter(None, completed.stdout.splitlines()))}
        view = {row["id"]: row for row in read_registry_view(self.repo.root).rows}
        self.assertEqual(view, projected)

    def test_a_deltas_directory_is_not_read(self) -> None:
        self.repo.write("docs/reviews/_registry/deltas/stray.jsonl", "".join(json.dumps(row) + "\n" for row in [
            _registry_row("ARIA-HIGH-931", "RESOLVED", closing_commits=["abcdef2"], closed_at="2026-10-04T00:00:00Z"),
            _registry_row("ARIA-HIGH-939"),
        ]))
        self.repo.commit("chore(fixture): a deltas file nothing writes", "2026-10-04T10:00:00Z")
        rows = {row["id"]: row for row in read_registry_view(self.repo.root).rows}
        self.assertEqual(rows["ARIA-HIGH-931"]["state"], "OPEN")
        self.assertNotIn("ARIA-HIGH-939", rows)
        self.assertFalse(any(entry.source.startswith("docs/reviews/_registry/deltas/")
                             for entry in read_registry_view(self.repo.root).entries))

    def test_the_delta_fold_format_is_gone(self) -> None:
        import aria_kernel.report_ingestion as report_ingestion_module

        self.assertFalse(hasattr(report_ingestion_module, "REGISTRY_DELTAS_RELPATH"))


class RegistryViewRefusesWithoutTheProjectionTests(unittest.TestCase):
    def test_without_the_repository_s_ts_node_the_view_refuses_by_name(self) -> None:
        with tempfile.TemporaryDirectory(prefix="aria-registry-no-node-") as tmp:
            repo = _ProjectionRepo(Path(tmp) / "repo", with_node=False)
            repo.write_registry([_registry_row("ARIA-HIGH-951")])
            repo.commit("chore(registry): seed", "2026-10-01T10:00:00Z")
            # A silent read of the stored file would report closures late again.
            with self.assertRaises(GovernanceError):
                read_registry_view(repo.root)


@unittest.skipUnless((_REPO_ROOT / _TS_NODE).is_file(), "the repository's ts-node is not installed in this checkout")
class KernelReadersSeeDerivedClosuresTests(unittest.TestCase):
    """Each kernel reader of the registry, observed through its own output."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="aria-registry-derived-")
        self.repo = _ProjectionRepo(Path(self.tmp.name) / "repo")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_the_deadline_organ_drops_a_finding_a_merged_trailer_closed(self) -> None:
        due = (datetime.now(timezone.utc) + timedelta(days=3)).date().isoformat()
        self.repo.write_registry([_registry_row("ARIA-HIGH-941", deadline=due),
                                  _registry_row("ARIA-HIGH-942", deadline=due)])
        self.repo.commit("chore(registry): seed", "2026-10-01T10:00:00Z")
        self.repo.close_by_merged_fix(
            "ARIA-HIGH-942", branch="fix-942", fix_date="2026-10-02T10:00:00Z", merge_date="2026-10-03T10:00:00Z",
        )
        tools = ensure_tools_dir(Path(self.tmp.name) / "aria-tools")
        rows = deadlines.read_registry_deadlines(tools, self.repo.root)
        self.assertEqual(sorted(row.key for row in rows), ["ARIA-HIGH-941"])

    def test_an_adapter_quarantine_cannot_stand_on_a_finding_a_merged_trailer_closed(self) -> None:
        from aria_kernel.adapter_quarantine import quarantine_finding_refusal

        evidence = ["tools/aria-adapters/fixture-tool.tool.json:1"]
        self.repo.write_registry([_registry_row("ARIA-HIGH-943", evidence=evidence)])
        self.repo.commit("chore(registry): seed", "2026-10-01T10:00:00Z")
        block = {"finding": "ARIA-HIGH-943", "reason": "fixture quarantine"}
        self.assertIsNone(quarantine_finding_refusal(block, tool_id="fixture-tool", repo_root=self.repo.root))
        self.repo.close_by_merged_fix(
            "ARIA-HIGH-943", branch="fix-943", fix_date="2026-10-02T10:00:00Z", merge_date="2026-10-03T10:00:00Z",
        )
        refusal = quarantine_finding_refusal(block, tool_id="fixture-tool", repo_root=self.repo.root)
        self.assertEqual(refusal, "quarantine_finding_resolved: ARIA-HIGH-943 is RESOLVED")


if __name__ == "__main__":
    unittest.main()
