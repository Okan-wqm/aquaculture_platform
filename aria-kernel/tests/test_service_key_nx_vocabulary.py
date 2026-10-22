"""SE-1 — the finding service dimension speaks nx project names.

The service-expertise plan (PLAN.md §8 row SE-1, owner decision Q9) moves the
finding dimension from the E15-a string vocabulary (``apps/<dir>``,
``shared:<lib>``, ``web:<app>``) to the nx project key that
``impact_graph.project_for_path`` derives from the ``project_roots`` map
``cached_service_analysis_order`` publishes. These pin, against a fixture
workspace whose map the real cache writer produced:

  (ii) a LEGACY row (no ``service_vocabulary``) re-derives its services from
       its paths at read time: ``libs/X`` and ``platform/libs/X`` resolve to
       two distinct nx projects, where the string vocabulary collapsed both
       into ``shared:X``; a stored E15 ``services`` value is not trusted and
       is not string-mapped (SK-17);
  (iv) a mint-time caller that has no ``workspace_root``
       (``feedback_store.record_findings_for_run``) receives the cached map:
       the minted row carries nx names and ``service_vocabulary:
       "nx_project/v1"``.

Expected names are computed through ``project_for_path`` itself, so the tests
pin "the one owner decides", not a naming convention.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel.impact_graph import cached_service_analysis_order, project_for_path
from aria_kernel.tool_registry import ensure_tools_dir

NX_VOCABULARY = "nx_project/v1"
LIB_PATH = "libs/storage/src/object-store.ts"
PLATFORM_LIB_PATH = "platform/libs/storage/src/bucket.ts"
APP_PATH = "apps/farm-service/src/batch/batch.service.ts"


def _workspace(root: Path) -> Path:
    """libs/storage and platform/libs/storage: one ``shared:storage`` in the
    string vocabulary, two nx projects in the graph."""
    for rel in ("libs/storage/src/index.ts", "platform/libs/storage/src/index.ts",
                "apps/farm-service/src/main.ts"):
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("export const x = 1;\n", encoding="utf-8")
    return root


class _CachedMapCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        tmp = Path(self._tmp.name)
        self.tools = ensure_tools_dir(tmp / "aria-tools")
        workspace = _workspace(tmp / "repo")
        # The real writer publishes the map the mint and the reader consume.
        roots = cached_service_analysis_order(workspace_root=workspace, base_dir=self.tools)[
            "project_roots"
        ]
        self.lib = project_for_path(LIB_PATH, roots)
        self.platform_lib = project_for_path(PLATFORM_LIB_PATH, roots)
        self.app = project_for_path(APP_PATH, roots)
        self.assertIsNotNone(self.lib)
        self.assertIsNotNone(self.platform_lib)
        self.assertNotEqual(self.lib, self.platform_lib)

    def _append_legacy_row(self, finding_id: str, *, stored_services: list[str] | None) -> None:
        from aria_kernel.feedback_store import append_jsonl, findings_path

        row: dict[str, object] = {
            "schema_version": 1,
            "tool_id": "t",
            "run_id": "r",
            "finding_id": finding_id,
            "status": "open",
            "finding": {
                "id": finding_id,
                "path": LIB_PATH,
                "evidence_refs": [PLATFORM_LIB_PATH],
            },
        }
        if stored_services is not None:
            row["services"] = stored_services
        append_jsonl(findings_path(self.tools), row)

    def _ids(self, service: str) -> list[str]:
        from aria_kernel.feedback_store import list_findings

        return [row["finding_id"] for row in list_findings(service=service, base_dir=self.tools)]


class LegacyRowReDerivesFromItsPaths(_CachedMapCase):
    def test_lib_and_platform_lib_resolve_to_two_distinct_projects(self) -> None:
        self._append_legacy_row("legacy-1", stored_services=None)
        self.assertEqual(self._ids(self.lib), ["legacy-1"])
        self.assertEqual(self._ids(self.platform_lib), ["legacy-1"])
        # No string mapping survives: the collapsed E15 key names nothing.
        self.assertEqual(self._ids("shared:storage"), [])

    def test_a_stored_e15_value_without_a_vocabulary_is_re_derived(self) -> None:
        # Mint-time E15 rows stored the string vocabulary; a row without
        # service_vocabulary is read from its paths, never trusted as stored.
        self._append_legacy_row("legacy-2", stored_services=["shared:storage"])
        self.assertEqual(self._ids(self.lib), ["legacy-2"])
        self.assertEqual(self._ids(self.platform_lib), ["legacy-2"])
        self.assertEqual(self._ids("shared:storage"), [])


class MintWithoutWorkspaceRootReceivesTheCachedMap(_CachedMapCase):
    def test_record_findings_for_run_mints_nx_names_and_the_vocabulary(self) -> None:
        from aria_kernel.feedback_store import list_findings, record_findings_for_run

        record_findings_for_run(
            {
                "tool_id": "tenant-scoping-adapter",
                "run_id": "run-se1",
                "emitted_findings": [
                    {"id": "f-lib", "path": LIB_PATH, "message": "m"},
                    {"id": "f-two", "path": APP_PATH, "evidence_refs": [PLATFORM_LIB_PATH],
                     "message": "m"},
                ],
            },
            base_dir=self.tools,
        )
        rows = {row["finding_id"]: row for row in list_findings(base_dir=self.tools)}
        self.assertEqual(rows["f-lib"]["services"], [self.lib])
        self.assertEqual(rows["f-lib"]["service"], self.lib)
        self.assertEqual(rows["f-lib"]["service_vocabulary"], NX_VOCABULARY)
        self.assertEqual(rows["f-two"]["services"], sorted([self.app, self.platform_lib]))
        self.assertIsNone(rows["f-two"]["service"])
        self.assertEqual(rows["f-two"]["service_vocabulary"], NX_VOCABULARY)


if __name__ == "__main__":
    unittest.main()
