"""ARIA-HIGH-279 — every kernel read of the review registry goes through one view.

WHY. The kernel read ``findings.jsonl`` directly at three sites, each with
its own parser — report ingestion, the deadline organ and the ORPHAN
evidence attach — so the three could disagree about what the registry holds.
They read through ``read_registry_view`` instead, and since MF-1
(PROC-HIGH-039) the view IS the registry CLI's projection, which derives
RESOLVED from merged ``Closes:`` trailers (the second half of this file).

WHAT the first half pins:
  * an absent registry is not an empty one;
  * the view's states are the registry schema's states;
  * the live registry reads through the view, one row per finding;
  * report ingestion and the ORPHAN plan source read through the view,
    observed by behaviour on a repository the CLI can project.
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
from aria_kernel.finding_id_grammar import finding_id_sort_key
from aria_kernel.ledger import read_jsonl
from aria_kernel.plan_synthesizer import scan_orphan_findings
from aria_kernel.report_ingestion import (
    REGISTRY_FINDINGS_RELPATH,
    REGISTRY_STATES,
    read_registry_view,
    report_ingestion_scan,
)
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir
from aria_kernel.workspace import ensure_workspace, workspace_paths
from tests._helpers.witness_sources import REGISTRY_CLI_DATA, registry_cli_tool_paths

_REPO_ROOT = Path(__file__).resolve().parents[2]
_BASE_REF = "docs/reviews/_registry/findings.jsonl"


class RegistryViewContractTests(unittest.TestCase):
    def test_an_absent_chain_is_not_an_empty_registry(self) -> None:
        with tempfile.TemporaryDirectory(prefix="aria-registry-view-") as tmp:
            with self.assertRaises(FileNotFoundError):
                read_registry_view(tmp)

    def test_the_view_states_are_the_registry_schema_s_states(self) -> None:
        schema = json.loads(
            (_REPO_ROOT / "docs/reviews/_registry/findings.jsonl.schema.json").read_text(encoding="utf-8"),
        )
        self.assertEqual(REGISTRY_STATES, frozenset(schema["properties"]["state"]["enum"]))

    @unittest.skipUnless((_REPO_ROOT / "node_modules/.bin/ts-node").is_file(),
                         "the repository's ts-node is not installed in this checkout")
    def test_the_live_registry_reads_through_the_view(self) -> None:
        # MF-2: the frozen genesis segment, then every finding born after the
        # freeze, one event log each (docs/reviews/_registry/findings/<PREFIX>/<ID>.jsonl),
        # in the registry's order of ids: the sequence as a number (finding_id_sort_key),
        # not the text order of the paths, which puts ARIA-LOW-1003 before ARIA-LOW-986.
        chain = _REPO_ROOT.joinpath(*REGISTRY_FINDINGS_RELPATH).read_text(encoding="utf-8")
        chain_ids = [json.loads(line)["id"] for line in chain.splitlines() if line.strip()]
        store = _REPO_ROOT / "docs/reviews/_registry/findings"
        genesis_ids = set(chain_ids)
        born = [
            path.stem
            for path in sorted(store.glob("*/*.jsonl"), key=lambda p: finding_id_sort_key(p.stem))
            if path.stem not in genesis_ids
        ]
        view = read_registry_view(_REPO_ROOT)
        self.assertEqual([row["id"] for row in view.rows], chain_ids + born)
        # Each finding's source is the file that holds it: its event log when it has one (born
        # after the freeze, or amended since), the frozen segment otherwise.
        logs = {path.stem: path.relative_to(_REPO_ROOT).as_posix() for path in store.glob("*/*.jsonl")}
        self.assertEqual(
            [entry.source for entry in view.entries],
            [logs.get(entry.row["id"], _BASE_REF) for entry in view.entries],
        )
        self.assertTrue(any(source != _BASE_REF for source in (entry.source for entry in view.entries)))


@unittest.skipUnless((_REPO_ROOT / "node_modules/.bin/ts-node").is_file(),
                     "the repository's ts-node is not installed in this checkout")
class KernelReadSitesReadTheViewTests(unittest.TestCase):
    """Each former direct reader, observed through its own output."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="aria-registry-sites-")
        self.repo = _ProjectionRepo(Path(self.tmp.name) / "repo")
        self.paths = workspace_paths(self.repo.root, Path(self.tmp.name) / "ws")
        ensure_workspace(self.paths)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_ingestion_ingests_a_new_finding_and_cites_the_registry(self) -> None:
        self.repo.write_registry([_registry_row("ARIA-HIGH-001", "RESOLVED", closing_commits=["abcdef1"],
                                                closed_at="2026-09-01T00:00:00.000Z")])
        self.repo.commit("chore(registry): seed", "2026-10-01T10:00:00Z")
        self.assertEqual(report_ingestion_scan(self.paths, cycle_id="c1")["status"], "baselined")
        self.repo.write_registry([
            _registry_row("ARIA-HIGH-001", "RESOLVED", closing_commits=["abcdef1"],
                          closed_at="2026-09-01T00:00:00.000Z"),
            _registry_row("ARIA-HIGH-002"),
        ])
        self.repo.commit("chore(registry): a new finding", "2026-10-02T10:00:00Z")
        result = report_ingestion_scan(self.paths, cycle_id="c2")
        self.assertEqual([item["finding_key"] for item in result["ingested"]], ["ARIA-HIGH-002"])
        events = [row for row in read_jsonl(self.paths.ledgers["missed_signals"]) if row.get("cycle_id") == "c2"]
        self.assertEqual(len(events), 1)
        self.assertIn(_BASE_REF, events[0]["evidence_refs"])

    def test_ingestion_skips_a_finding_a_merged_trailer_closed(self) -> None:
        self.repo.write_registry([_registry_row("ARIA-HIGH-001", "RESOLVED", closing_commits=["abcdef1"],
                                                closed_at="2026-09-01T00:00:00.000Z")])
        self.repo.commit("chore(registry): seed", "2026-10-01T10:00:00Z")
        report_ingestion_scan(self.paths, cycle_id="c1")
        self.repo.write_registry([
            _registry_row("ARIA-HIGH-001", "RESOLVED", closing_commits=["abcdef1"],
                          closed_at="2026-09-01T00:00:00.000Z"),
            _registry_row("ARIA-HIGH-002"),
        ])
        self.repo.commit("chore(registry): a new finding", "2026-10-02T10:00:00Z")
        self.repo.close_by_merged_fix(
            "ARIA-HIGH-002", branch="fix-002", fix_date="2026-10-03T10:00:00Z", merge_date="2026-10-04T10:00:00Z",
        )
        result = report_ingestion_scan(self.paths, cycle_id="c2")
        self.assertEqual((result["ingested_count"], result["skipped_count"]), (0, 1))

    def test_orphan_plan_evidence_comes_from_the_registry_row(self) -> None:
        register = {"review_file": "docs/reviews/orphan-findings.md"}
        self.repo.write("docs/reviews/orphan-findings.md", "## ORPHAN-HIGH-501 — t — OPEN\nbody\n")
        self.repo.write_registry([_registry_row("ORPHAN-HIGH-501", evidence=["apps/b.ts:2"], **register)])
        self.repo.commit("chore(registry): seed", "2026-10-01T10:00:00Z")
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
        self.repo.write("docs/reviews/orphan-findings.md", "# register\n")
        self.repo.write_registry([
            _registry_row("ORPHAN-HIGH-501", evidence=["apps/a.ts:1"], review_file="docs/reviews/orphan-findings.md"),
            _registry_row("ORPHAN-HIGH-502", evidence=["apps/b.ts:2"], review_file=other),
        ])
        self.repo.commit("chore(registry): seed", "2026-10-01T10:00:00Z")
        by_id = {row["candidate_id"]: row for row in scan_orphan_findings(self.repo.root)}
        self.assertEqual(set(by_id), {"ORPHAN-HIGH-501", "ORPHAN-HIGH-502"})
        self.assertEqual(by_id["ORPHAN-HIGH-502"].get("review_file"), other)
        self.assertNotIn("heading_line", by_id["ORPHAN-HIGH-502"])

    def test_the_orphan_source_drops_a_finding_a_merged_trailer_closed(self) -> None:
        register = {"review_file": "docs/reviews/orphan-findings.md"}
        self.repo.write("docs/reviews/orphan-findings.md", "## ORPHAN-HIGH-501 — t — OPEN\nbody\n")
        self.repo.write_registry([_registry_row("ORPHAN-HIGH-501", evidence=["apps/b.ts:2"], **register)])
        self.repo.commit("chore(registry): seed", "2026-10-01T10:00:00Z")
        self.repo.git("checkout", "-q", "-b", "fix-501")
        self.repo.commit(
            "fix(fixture): close ORPHAN-HIGH-501\n\nCloses: docs/reviews/orphan-findings.md#ORPHAN-HIGH-501",
            "2026-10-02T10:00:00Z",
        )
        self.repo.git("checkout", "-q", "main")
        self.repo.merge("fix-501", "2026-10-03T10:00:00Z")
        self.assertEqual(scan_orphan_findings(self.repo.root), [])




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
# The fixture is a real git repository carrying the registry CLI's input set
# (its import closure, tsconfig and data files, owned by
# tests/_helpers/witness_sources.py) and a link to this checkout's
# node_modules, so the CLI runs on the fixture's own history (the TS side
# builds the same shape in tests/invariants/helpers/registry-fixture-repo.ts).
# It copies that set and nothing else: the kernel surface test requires the
# same set on the surface, so building the fixture never reads a file a PR
# could change without running this suite (the suite job's read tracer,
# ARIA-HIGH-602, fails such a read).
# ---------------------------------------------------------------------------

_FIXTURE_REVIEW = "docs/reviews/claude/2026-10-23-mf-1-fixture.md"
_ZERO_HASH = "0" * 64
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
        for rel in (*registry_cli_tool_paths(), *REGISTRY_CLI_DATA):
            (root / rel).parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(_REPO_ROOT / rel, root / rel)
        if with_node:
            (root / "node_modules").symlink_to(_REPO_ROOT / "node_modules", target_is_directory=True)
        self.write(".gitignore", "node_modules\n")
        self.write(_FIXTURE_REVIEW, "# MF-1 fixture review\n")
        # The fixture's own alias sidecar replaces the copied live one: its
        # trailers name only fixture ids.
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
    def test_a_shallow_clone_refuses_the_view_by_name(self) -> None:
        """MF-DESIGN §9 R1: a read without the whole history fails closed.

        A depth-1 clone of main holds the merge of the fix branch but not the
        fix commit that carries the trailer. A view read from that history
        would report the closed finding OPEN and raise nothing.
        """
        with tempfile.TemporaryDirectory(prefix="aria-registry-shallow-") as tmp:
            repo = _ProjectionRepo(Path(tmp) / "repo")
            repo.write_registry([_registry_row("ARIA-HIGH-952")])
            repo.commit("chore(registry): seed", "2026-10-01T10:00:00Z")
            repo.close_by_merged_fix(
                "ARIA-HIGH-952", branch="fix-952", fix_date="2026-10-02T10:00:00Z", merge_date="2026-10-03T10:00:00Z",
            )
            shallow = Path(tmp) / "shallow"
            env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
            env.update({"GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null"})
            subprocess.run(["git", "clone", "-q", "--depth", "1", f"file://{repo.root}", str(shallow)],
                           env=env, check=True, capture_output=True)
            (shallow / "node_modules").symlink_to(_REPO_ROOT / "node_modules", target_is_directory=True)
            with self.assertRaises(GovernanceError) as ctx:
                read_registry_view(shallow)
            self.assertIn("shallow clone", str(ctx.exception))


class OneKernelRunnerOfTheRegistryCliTests(unittest.TestCase):
    """The kernel runs ``tools/gates/finding-registry.ts`` from one module.

    The view and the autonomy closure verifier each carried a runner of the
    CLI — the ts-node path, the CLI path, the tsconfig, the timeout and the
    subprocess call — and the two mapped a failure differently (one raised,
    one returned None). One runner, ``report_ingestion.run_registry_cli``,
    raises one named refusal; a second definition of the CLI path is a second
    runner in the making.
    """

    def test_the_registry_cli_path_is_defined_in_exactly_one_kernel_module(self) -> None:
        import ast

        package = _REPO_ROOT / "aria-kernel" / "aria_kernel"
        definers = sorted(
            path.relative_to(package).as_posix()
            for path in package.rglob("*.py")
            if any(
                isinstance(node, ast.Constant) and node.value == "tools/gates/finding-registry.ts"
                for node in ast.walk(ast.parse(path.read_text(encoding="utf-8")))
            )
        )
        self.assertEqual(definers, ["report_ingestion.py"])

    def test_the_autonomy_closure_verifier_runs_the_cli_through_that_runner(self) -> None:
        import aria_kernel.autonomy_closure as autonomy_closure
        import aria_kernel.report_ingestion as report_ingestion_module

        self.assertIs(autonomy_closure.run_registry_cli, report_ingestion_module.run_registry_cli)
        for retired in ("_run_registry_cli", "_TS_NODE", "_REGISTRY_CLI", "_GATES_TSCONFIG"):
            self.assertFalse(hasattr(autonomy_closure, retired), retired)

    def test_a_snapshot_verdict_names_the_runner_s_refusal(self) -> None:
        from aria_kernel.autonomy_closure import verify_registry_snapshot

        with tempfile.TemporaryDirectory(prefix="aria-registry-cli-absent-") as tmp:
            verdict = verify_registry_snapshot(Path(tmp), b"", at="HEAD", finding_ids=("ARIA-HIGH-953",))
        self.assertFalse(verdict.chain_ok)
        self.assertTrue(str(verdict.chain_reason).startswith("finding_registry_cli_unavailable:ts_node_absent:"),
                        verdict.chain_reason)


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
