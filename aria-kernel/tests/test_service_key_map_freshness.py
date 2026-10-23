"""SE-1 round 2 — every finding is attributed over the CURRENT project map.

WHY (review-r1-blockers.md, both reviewers). Round 1 kept two map accessors.
``impact_graph.cached_project_roots`` checks the cache's graph fingerprint
against the workspace and rebuilds a stale map; ``published_project_roots``
returned whatever ``tools/impact/service-order-cache.json`` held. The
tool-finding mint (``feedback_store.record_findings_for_run``) and the
findings-ledger readers used the second one, and a stamped row
(``service_vocabulary`` set) was then read as stored for good. The cycle runs
its 'tools' phase, which mints, before 'service_examination', which refreshes
the map, so:

  * a finding on a project the tree gained since the last publication was
    minted with ``services: []`` and stayed invisible to the service filter
    after the map caught up (reviewer probe ``probe_stale.py``);
  * after a ``project.json`` rename, the tool-finding mint stamped the old
    name while ``finding.emit_finding`` stamped the new one, both under the
    same vocabulary, and the two never reconcile (reviewer probe
    ``probe_stale_published_map.py``).

REQUIRED FIX (B1 / BLOCKER-1): one fingerprint-checked accessor; each stamped
row carries the graph fingerprint of the map it was attributed against, and
the row reader re-derives from the row's paths when that fingerprint differs
from the current map's.

WHAT THIS PINS, against fixture workspaces whose store is BOUND to them
(``tool_registry.ensure_tools_binding``, the store's declared workspace):

  * a mint after the tree gained a project files the finding under it;
  * after a ``project.json`` rename both mint paths stamp the same, current
    name;
  * a minted row carries the fingerprint of the map it was attributed
    against (NEW ROW FIELD — the field's name is the implementer's; the test
    looks for the value anywhere in the row);
  * a row stamped before a rename is found under the new name and no longer
    under the old one, through the ledger reader and through the committed
    finding reader;
  * a malformed ``project.json`` is a named refusal of the map, not a silent
    fall back to the directory name (review note (b): the TypeScript side
    throws on the same file).
"""
from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from typing import Any

from aria_kernel.impact_graph import cached_service_analysis_order
from aria_kernel.tool_registry import GovernanceError, ensure_tools_binding, ensure_tools_dir

_EVIDENCE_LINES = 44


def _write_source(workspace: Path, rel: str) -> None:
    path = workspace / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "\n".join(f"export const line{n} = {n};" for n in range(1, _EVIDENCE_LINES + 1)) + "\n",
        encoding="utf-8",
    )


def _declare(workspace: Path, root: str, name: str) -> None:
    (workspace / root / "project.json").write_text(json.dumps({"name": name}), encoding="utf-8")


def _contains_value(value: Any, wanted: str) -> bool:
    if value == wanted:
        return True
    if isinstance(value, dict):
        return any(_contains_value(v, wanted) for v in value.values())
    if isinstance(value, list):
        return any(_contains_value(v, wanted) for v in value)
    return False


class _BoundStoreCase(unittest.TestCase):
    """A workspace and a store bound to it (outside the workspace, so ledger
    writes never touch the project layout the fingerprint covers)."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        tmp = Path(self._tmp.name)
        self.workspace = tmp / "repo"
        self.workspace.mkdir()
        self.tools = ensure_tools_dir(tmp / "aria-tools")

    def bind(self) -> None:
        ensure_tools_binding(self.tools, workspace_root=self.workspace)

    def publish(self) -> dict[str, Any]:
        return cached_service_analysis_order(workspace_root=self.workspace, base_dir=self.tools)

    def mint_tool_finding(self, finding_id: str, path: str) -> dict[str, Any]:
        from aria_kernel.feedback_store import list_findings, record_findings_for_run

        record_findings_for_run(
            {
                "tool_id": "tenant-scoping-adapter",
                "run_id": f"run-{finding_id}",
                "emitted_findings": [{"id": finding_id, "path": path, "message": "m"}],
            },
            base_dir=self.tools,
        )
        (row,) = [r for r in list_findings(base_dir=self.tools) if r["finding_id"] == finding_id]
        return row

    def filtered(self, service: str) -> list[str]:
        from aria_kernel.feedback_store import list_findings

        return [row["finding_id"] for row in list_findings(service=service, base_dir=self.tools)]


class _CommittedFindingCase(_BoundStoreCase):
    """``finding.emit_finding`` grades its evidence against git, so the
    workspace is a repository whose evidence files are committed."""

    INGEST_FILES = tuple(f"apps/ingest/src/handler-{i}.ts" for i in (1, 2, 3))

    def setUp(self) -> None:
        super().setUp()
        for rel in self.INGEST_FILES:
            _write_source(self.workspace, rel)
        _declare(self.workspace, "apps/ingest", "ingest-old")
        for args in (
            ["init", "-q"],
            ["config", "user.email", "aria-test@example.com"],
            ["config", "user.name", "ARIA Test"],
            ["add", "apps"],
            ["commit", "-q", "-m", "seed evidence"],
        ):
            subprocess.run(["git", *args], cwd=self.workspace, check=True)
        self.bind()

    def emit(self) -> dict[str, Any]:
        from aria_kernel.finding import emit_finding

        return emit_finding(
            repo_root=self.workspace,
            base_dir=self.tools,
            claim_type="duplication",
            claim_summary="Three ingest handlers share identical decode boilerplate",
            severity="LOW",
            evidences=[{"ref": f"{rel}:42", "summary": f"handler {i}"}
                       for i, rel in enumerate(self.INGEST_FILES, start=1)],
            facts=["handler 1 decodes", "handler 2 decodes", "handler 3 decodes"],
            scope_files=list(self.INGEST_FILES),
        )

    def rename(self, name: str) -> None:
        _declare(self.workspace, "apps/ingest", name)


class AMintAttributesOverTheCurrentMap(_BoundStoreCase):
    def test_a_project_the_tree_gained_since_the_last_publication_is_attributed(self) -> None:
        # review-r1 B1 probe: the previous cycle published a map; this
        # cycle's 'tools' phase mints before 'service_examination' refreshes.
        _write_source(self.workspace, "apps/farm-service/src/main.ts")
        self.bind()
        self.publish()
        _write_source(self.workspace, "apps/new-service/src/x.ts")

        row = self.mint_tool_finding("f-new", "apps/new-service/src/x.ts")

        self.assertEqual(row.get("services"), ["new-service"])
        self.assertEqual(row.get("service"), "new-service")
        self.assertEqual(self.filtered("new-service"), ["f-new"])

    def test_a_minted_row_carries_the_fingerprint_of_its_map(self) -> None:
        # NEW ROW FIELD: the stamp says which map the names came from, so a
        # reader can tell a still-valid stamp from a stale one. SE-1-R2
        # appellate R1 (b): the identity is the map's own (`ProjectMap`
        # digests its name=root pairs), not the discovery graph fingerprint
        # the cache is keyed by, which two different maps can share.
        from aria_kernel.impact_graph import project_map

        _write_source(self.workspace, "apps/farm-service/src/main.ts")
        self.bind()
        self.publish()
        fingerprint = project_map(base_dir=self.tools).fingerprint

        row = self.mint_tool_finding("f-1", "apps/farm-service/src/main.ts")

        self.assertTrue(
            _contains_value(row, fingerprint),
            "a stamped row must carry the fingerprint of the map it was attributed against",
        )


class BothMintPathsAgreeAfterARename(_CommittedFindingCase):
    def test_tool_and_committed_finding_mints_stamp_the_same_current_name(self) -> None:
        # review-r1 BLOCKER-1 probe: the published map still says
        # ``ingest-old`` when both mints run.
        self.publish()
        self.rename("ingest-new")

        tool_row = self.mint_tool_finding("f-tool", self.INGEST_FILES[0])
        committed = self.emit()

        self.assertEqual(committed.get("services"), ["ingest-new"])
        self.assertEqual(tool_row.get("services"), committed.get("services"))


class AStampedRowReDerivesWhenItsMapIsStale(_CommittedFindingCase):
    def test_the_ledger_reader_files_a_pre_rename_row_under_the_new_name(self) -> None:
        self.publish()
        row = self.mint_tool_finding("f-before", self.INGEST_FILES[0])
        self.assertEqual(row.get("services"), ["ingest-old"])

        self.rename("ingest-new")

        self.assertEqual(self.filtered("ingest-new"), ["f-before"])
        self.assertEqual(self.filtered("ingest-old"), [])

    def test_the_committed_finding_reader_files_a_pre_rename_finding_under_the_new_name(
        self,
    ) -> None:
        from aria_kernel.finding import list_findings

        committed = self.emit()
        self.assertEqual(committed.get("services"), ["ingest-old"])

        self.rename("ingest-new")

        def ids(service: str) -> list[str]:
            return [
                doc["finding_id"]
                for doc in list_findings(self.workspace, service=service, base_dir=self.tools)
            ]

        self.assertEqual(ids("ingest-new"), [committed["finding_id"]])
        self.assertEqual(ids("ingest-old"), [])


class TheStampIsBoundToTheMapNotToTheLayoutKey(_BoundStoreCase):
    """SE-1-R2 appellate R1 (b), reviewer probe evidence p3. The cache is keyed
    by `_graph_fingerprint` (discovery names, roots and tsconfig), but the map
    stored under that key can come from an nx graph file (operator CLI paths
    such as ``twin build --nx-graph-file``). An nx-sourced map and the
    discovery map that replaces it share the graph fingerprint, so a stamp
    that carried the graph fingerprint was read as stored against a map that
    no longer has its names."""

    def setUp(self) -> None:
        super().setUp()
        _write_source(self.workspace, "apps/ingest/src/a.ts")
        self.bind()
        self.graph = Path(self._tmp.name) / "nx-graph.json"
        self.graph.write_text(
            json.dumps(
                {"graph": {"nodes": {"ingest-nx": {"data": {"root": "apps/ingest"}}}, "dependencies": {}}}
            ),
            encoding="utf-8",
        )

    def _publish_from_the_nx_graph(self) -> dict[str, Any]:
        return cached_service_analysis_order(
            workspace_root=self.workspace, base_dir=self.tools, nx_graph_file=self.graph
        )

    def _lose_the_publication(self) -> None:
        (self.tools / "impact" / "service-order-cache.json").write_text("{corrupt", encoding="utf-8")

    def test_two_maps_under_one_graph_fingerprint_have_two_map_fingerprints(self) -> None:
        from aria_kernel.impact_graph import project_map

        nx_sourced = self._publish_from_the_nx_graph()
        first = project_map(base_dir=self.tools)
        self._lose_the_publication()
        rebuilt = self.publish()
        second = project_map(base_dir=self.tools)

        self.assertEqual(nx_sourced["graph_fingerprint"], rebuilt["graph_fingerprint"])
        self.assertNotEqual(dict(first), dict(second))
        self.assertNotEqual(first.fingerprint, second.fingerprint)

    def test_a_row_stamped_against_the_nx_map_is_filed_under_the_rebuilt_name(self) -> None:
        self._publish_from_the_nx_graph()
        row = self.mint_tool_finding("f1", "apps/ingest/src/a.ts")
        self.assertEqual(row.get("services"), ["ingest-nx"])

        self._lose_the_publication()

        self.assertEqual(self.filtered("ingest"), ["f1"])
        self.assertEqual(self.filtered("ingest-nx"), [])


class AMalformedManifestRefusesTheMap(_BoundStoreCase):
    def test_a_malformed_project_json_is_a_named_refusal_not_a_directory_name(self) -> None:
        # review note (b): Python fell back to the directory name while the
        # TypeScript side (event-consumer-index.ts applicationNames) throws.
        _write_source(self.workspace, "apps/broken-svc/src/main.ts")
        (self.workspace / "apps/broken-svc/project.json").write_text(
            '{"name": "broken-svc",', encoding="utf-8"
        )

        with self.assertRaises(GovernanceError) as raised:
            self.publish()
        self.assertIn("apps/broken-svc/project.json", str(raised.exception))


if __name__ == "__main__":
    unittest.main()
