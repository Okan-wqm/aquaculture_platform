from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel.learning import _impact_graph_compute
from aria_kernel.ledger import load_jsonl
from aria_kernel.tool_registry import ensure_tools_dir
from aria_kernel.workspace import ensure_workspace, workspace_paths
from tests._helpers.declared_fixtures import append_declared_fixture


class ImpactGraphHookTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name) / "repo"
        self.repo.mkdir()
        # Seed a minimal Nx-style project so plan_downstream_impact can resolve paths.
        farm = self.repo / "apps" / "farm-service"
        farm.mkdir(parents=True)
        (farm / "project.json").write_text('{"name": "farm-service"}', encoding="utf-8")
        self.tools_dir = ensure_tools_dir(Path(self.tmp.name) / "aria-tools")
        self.paths = workspace_paths(self.repo, Path(self.tmp.name) / "workspaces")
        ensure_workspace(self.paths)

    def tearDown(self):
        self.tmp.cleanup()

    def _seed_pressure(self, event_id: str, evidence_refs: list[str]) -> None:
        append_declared_fixture(
            self.paths.ledgers["pressure"],
            {
                "$schema": "aria/pressure-event/v2",
                "schema_version": 2,
                "event_id": event_id,
                "primitive": "REPETITION",
                "magnitude": 3,
                "threshold": 3,
                "exceeds_threshold": True,
                "evidence_refs": evidence_refs,
                "feedback_event_ids": [],
                "detected_at": "2026-05-06T00:00:00Z",
            },
            expected_surface="workspace_memory_pressure",
        )

    def _seed_dispatch(self, assignment_id: str, pressure_event_id: str, state: str = "pending") -> None:
        append_declared_fixture(
            self.tools_dir / "dispatch" / "requests.jsonl",
            {
                "$schema": "aria/dispatch-request/v1",
                "schema_version": 1,
                "assignment_id": assignment_id,
                "pressure_event_id": pressure_event_id,
                "state": state,
                "created_at": "2026-05-06T00:00:00Z",
            },
            expected_surface="dispatch_requests",
        )

    def test_no_pending_dispatch_returns_skipped(self):
        result = _impact_graph_compute(cycle_id="cyc-empty", paths=self.paths, tools_root=self.tools_dir)
        self.assertEqual(result["status"], "skipped")
        self.assertEqual(result["reason"], "no_pending_dispatch")

    def test_pending_dispatch_with_evidence_computes_graph(self):
        self._seed_pressure("PE-1", ["apps/farm-service/src/app.ts"])
        self._seed_dispatch("A-foo-aaaa1111", "PE-1")
        result = _impact_graph_compute(cycle_id="cyc-1", paths=self.paths, tools_root=self.tools_dir)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["computed_count"], 1)
        graph_rows = load_jsonl(self.tools_dir / "impact" / "impact-graphs.jsonl")
        self.assertEqual(len(graph_rows), 1)
        self.assertEqual(graph_rows[0]["cycle_id"], "cyc-1")

    def test_dispatch_with_no_evidence_is_skipped_silently(self):
        self._seed_pressure("PE-2", [])
        self._seed_dispatch("A-bar-bbbb2222", "PE-2")
        result = _impact_graph_compute(cycle_id="cyc-2", paths=self.paths, tools_root=self.tools_dir)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["computed_count"], 0)
        self.assertEqual(result["skipped_no_evidence"], 1)

    def test_already_completed_dispatch_is_filtered(self):
        self._seed_pressure("PE-3", ["apps/farm-service/src/app.ts"])
        self._seed_dispatch("A-baz-cccc3333", "PE-3", state="completed")
        result = _impact_graph_compute(cycle_id="cyc-3", paths=self.paths, tools_root=self.tools_dir)
        self.assertEqual(result["status"], "skipped")
        self.assertEqual(result["reason"], "no_pending_dispatch")

    def test_evidence_mixing_a_placeable_and_an_unplaceable_path_does_not_abort_the_hook(self):
        """ORPHAN-HIGH-575 — the most ordinary PR shape crashed the hook.

        `plan_downstream_impact` sorted the set of resolved projects BEFORE
        filtering out the unplaceable ones, so a set holding both a project
        name and `None` raised `TypeError: '<' not supported between
        instances of 'str' and 'NoneType'`.

        The shape that triggers it is a change touching one path the graph can
        place and one it cannot — code plus its own review document, which is
        this repository's most common commit. Pure-code never triggered it (no
        `None`), and pure-docs never triggered it either (a one-element set
        needs no comparison), so both halves of the obvious test matrix passed
        while the mixture crashed.

        It is a TypeError, not a GovernanceError, so `learning.py`'s
        `except GovernanceError` did not catch it: it escaped the whole loop
        over pending dispatches and was swallowed upstream as a generic
        `learning_hook_failed`. One mixed-evidence pressure event therefore
        disabled impact-graph computation for the entire cycle, and said so
        only as a hook failure.
        """
        self._seed_pressure("PE-MIX", ["docs/reviews/claude/x.md", "apps/farm-service/src/app.ts"])
        self._seed_dispatch("A-mix-eeee5555", "PE-MIX")

        result = _impact_graph_compute(cycle_id="cyc-mix", paths=self.paths, tools_root=self.tools_dir)

        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["computed_count"], 1)
        row = load_jsonl(self.tools_dir / "impact" / "impact-graphs.jsonl")[-1]
        # The placeable path is still resolved and the unplaceable one is still
        # REPORTED as unknown — the fix must not buy survival by discarding the
        # honesty about what the graph could not place.
        self.assertEqual(row["changed_projects"], ["farm-service"])
        self.assertEqual(row["unknown_files"], ["docs/reviews/claude/x.md"])

    def test_a_wholly_unplaceable_evidence_set_still_reports_every_unknown(self):
        # Guards the fix's other direction: filtering must not silently drop
        # the unplaceable paths from `unknown_files`, which is the field the
        # blocked_unknown_graph verdict is derived from.
        self._seed_pressure("PE-DOCS", ["docs/a.md", "docs/b.md"])
        self._seed_dispatch("A-docs-ffff6666", "PE-DOCS")

        result = _impact_graph_compute(cycle_id="cyc-docs", paths=self.paths, tools_root=self.tools_dir)

        self.assertEqual(result["status"], "ok")
        row = load_jsonl(self.tools_dir / "impact" / "impact-graphs.jsonl")[-1]
        self.assertEqual(row["changed_projects"], [])
        self.assertEqual(row["unknown_files"], ["docs/a.md", "docs/b.md"])
        self.assertEqual(row["validation_scope"], "blocked_unknown_graph")

    def test_idempotent_re_run_each_cycle_appends_fresh_row(self):
        # Each cycle re-evaluates downstream from current data — append-only ledger
        # naturally keeps the audit trail; no duplicate guard required.
        self._seed_pressure("PE-4", ["apps/farm-service/src/app.ts"])
        self._seed_dispatch("A-qux-dddd4444", "PE-4")
        first = _impact_graph_compute(cycle_id="cyc-4a", paths=self.paths, tools_root=self.tools_dir)
        second = _impact_graph_compute(cycle_id="cyc-4b", paths=self.paths, tools_root=self.tools_dir)
        rows = load_jsonl(self.tools_dir / "impact" / "impact-graphs.jsonl")
        self.assertEqual(first["status"], "ok")
        self.assertEqual(second["status"], "ok")
        self.assertEqual(len(rows), 2)


if __name__ == "__main__":
    unittest.main()
