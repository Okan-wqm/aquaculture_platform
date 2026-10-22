"""SE-1 — a repository path is attributed to a service by ONE function.

WHY. Two kernel functions answered "which service owns this path" in two
vocabularies. ``impact_graph.project_for_path`` names nx projects over the
``project_roots`` map that ``cached_service_analysis_order`` publishes;
``service_dimension.service_for_path`` (E15-a) names ``apps/<dir>``,
``shared:<lib>`` and ``web:<app>``. Measured against this repository, 54 of
71 nx project names are values the second vocabulary can never produce
(``impact_graph.py`` ``project_for_path`` docstring), and ``libs/X`` and
``platform/libs/X`` collapse into one ``shared:X``. A finding minted in one
vocabulary and routed or filtered in the other is filed under a service that
does not exist in the impacted set. The service-expertise plan (PLAN.md §2
row "Path → service/project key", owner decision Q9) keeps
``project_for_path`` and deletes the second implementation with every caller
migrated, no wrapper, no string fallback.

WHAT THIS PINS.
  * No kernel module defines a path→service/project function other than the
    owner (``impact_graph.project_for_path``) and its shape adapter
    (``impact_graph._project_for_path``, which calls the owner).
  * ``service_dimension`` no longer exports ``service_for_path``,
    ``services_for_paths`` or ``service_dimension``; ``services_for_finding_row``
    stays as the ROW reader.
  * No kernel module imports those deleted names.

``recursive_impact._project_for_path`` is a third implementation the plan
tombstones with its whole module in F0.9b (PLAN.md §2, same row, item 3), not
in SE-1. It is named here with that owner so this invariant does not grow a
silent exception: when F0.9b deletes it, the stale-entry check below goes red
until the entry is removed.
"""
from __future__ import annotations

import ast
import re
import unittest
from pathlib import Path

_KERNEL = Path(__file__).resolve().parents[2] / "aria_kernel"

# The one owner and its shape adapter (the adapter calls the owner).
_OWNER = {("impact_graph", "project_for_path"), ("impact_graph", "_project_for_path")}

# Implementations another tracked package removes, with that package.
_TOMBSTONED_ELSEWHERE = {("recursive_impact", "_project_for_path"): "F0.9b"}

# A path -> service/project attribution, by the names this kernel has used
# for one: service_for_path, services_for_paths, project_for_path,
# _project_for_path, services_of_path, ...
_ATTRIBUTION_NAME = re.compile(r"^_?(service|project)s?_(for|of)_paths?$")

_DELETED_FROM_SERVICE_DIMENSION = ("service_for_path", "services_for_paths", "service_dimension")


def _module_name(path: Path) -> str:
    return ".".join(path.relative_to(_KERNEL).with_suffix("").parts)


def _kernel_sources() -> list[Path]:
    return sorted(p for p in _KERNEL.rglob("*.py") if "__pycache__" not in p.parts)


def _top_level_functions(path: Path) -> list[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    return [
        node.name
        for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    ]


class OnePathToServiceImplementation(unittest.TestCase):
    def test_only_impact_graph_attributes_a_path_to_a_service(self) -> None:
        found = {
            (_module_name(path), name)
            for path in _kernel_sources()
            for name in _top_level_functions(path)
            if _ATTRIBUTION_NAME.match(name)
        }
        second_owners = sorted(
            f"{module}.{name}"
            for module, name in found - _OWNER - set(_TOMBSTONED_ELSEWHERE)
        )
        self.assertEqual(
            second_owners,
            [],
            "a second path->service implementation exists in aria_kernel; the one "
            "owner is impact_graph.project_for_path over the cached project_roots map",
        )

    def test_the_owner_is_still_there(self) -> None:
        from aria_kernel import impact_graph

        self.assertTrue(callable(getattr(impact_graph, "project_for_path", None)))

    def test_entries_tombstoned_elsewhere_are_not_stale(self) -> None:
        for (module, name), package in _TOMBSTONED_ELSEWHERE.items():
            path = _KERNEL / (module.replace(".", "/") + ".py")
            present = path.is_file() and name in _top_level_functions(path)
            self.assertTrue(
                present,
                f"{module}.{name} is gone ({package} landed): drop its entry here",
            )


class ServiceDimensionKeepsOnlyTheRowReader(unittest.TestCase):
    def test_the_string_vocabulary_functions_are_deleted(self) -> None:
        from aria_kernel import service_dimension

        still_exported = [
            name for name in _DELETED_FROM_SERVICE_DIMENSION if hasattr(service_dimension, name)
        ]
        self.assertEqual(still_exported, [])

    def test_the_row_reader_stays(self) -> None:
        from aria_kernel import service_dimension

        self.assertTrue(callable(getattr(service_dimension, "services_for_finding_row", None)))

    def test_no_kernel_module_imports_a_deleted_name(self) -> None:
        importers: list[str] = []
        for path in _kernel_sources():
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
            for node in ast.walk(tree):
                if not isinstance(node, ast.ImportFrom):
                    continue
                if (node.module or "").rsplit(".", 1)[-1] != "service_dimension":
                    continue
                for alias in node.names:
                    if alias.name in _DELETED_FROM_SERVICE_DIMENSION:
                        importers.append(
                            f"{path.relative_to(_KERNEL.parent).as_posix()}:{node.lineno}:{alias.name}"
                        )
        self.assertEqual(
            importers,
            [],
            "every caller migrates to impact_graph.project_for_path with the cached map",
        )


if __name__ == "__main__":
    unittest.main()
