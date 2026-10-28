"""ARIA-LOW-741 (package F3.1) — the decision stamp has ONE owner: ``aria_kernel.decision_stamp``.

WHAT BASE DOES TODAY. A delivered change carries no stamp of the route that executed
it or of its size. Three modules that cannot import each other (the delivery, the plan
ledger, the episode reader) would each need the same closed shape, so the shape has
one owner, a new module: ``aria_kernel/decision_stamp.py`` does not exist at base.

NEW MODULE. Every test reaches it through ``_module()``, which raises
``AssertionError("F3.1: aria_kernel.decision_stamp does not exist")`` at base (the
pattern of ``test_ownership_atlas_ssot.generator()``), so each test is red by
assertion, not by ``ImportError``.

THE SHAPE (closed, ``schema_version`` 1)::

    {"schema_version": 1,
     "route": {"provider": str, "model": str} | None,   # None: no route can be proven, never a guess
     "numstat": [{"path": str, "added": int | None, "deleted": int | None}, ...]}

``numstat`` is non-empty (a delivered change touched a path), sorted by path, no
duplicate path, counts ``type(x) is int and x >= 0`` (a bool is refused), ``added`` and
``deleted`` both ``None`` (a binary file) or both ints. Totals are NEVER stored beside
the entries, so they cannot drift: ``stamp_churn`` is the one place they are computed.

THE ORACLE for the counts is the CHURN fixture of ``test_change_churn_reader`` (nine
paths: added 8, deleted 6, one binary), checked there against real git.
"""
from __future__ import annotations

import ast
import copy
import importlib
import importlib.util
import json
import subprocess
import sys
import unittest
from pathlib import Path

from aria_kernel import change_paths
from aria_kernel.tool_registry import GovernanceError

_KERNEL_ROOT = Path(__file__).resolve().parents[1]

ENTRIES = [
    {"path": "a.txt", "added": 2, "deleted": 1},
    {"path": "bin.dat", "added": None, "deleted": None},
    {"path": "empty.txt", "added": 0, "deleted": 0},
    {"path": "gone.txt", "added": 0, "deleted": 2},
    {"path": "keep.sh", "added": 0, "deleted": 0},
    {"path": "moved name.txt", "added": 3, "deleted": 0},
    {"path": "new.txt", "added": 2, "deleted": 0},
    {"path": "old name.txt", "added": 0, "deleted": 3},
    {"path": "tab\tname.txt", "added": 1, "deleted": 0},
]
STAMP = {"schema_version": 1, "route": {"provider": "zai", "model": "glm-5.3"}, "numstat": ENTRIES}


def _module():
    if importlib.util.find_spec("aria_kernel.decision_stamp") is None:
        raise AssertionError("F3.1: aria_kernel.decision_stamp does not exist")
    return importlib.import_module("aria_kernel.decision_stamp")


def _churn(entries):
    """A ``ChangeChurn`` of ``(path, added, deleted)`` rows (absent at base: an assertion)."""
    if not hasattr(change_paths, "ChangeChurn"):
        raise AssertionError("F3.1: aria_kernel.change_paths.ChangeChurn does not exist")
    return change_paths.ChangeChurn(entries=tuple(entries))


def _churn_of(entry_dicts):
    return _churn((e["path"], e["added"], e["deleted"]) for e in entry_dicts)


def _stamp(**overrides):
    stamp = copy.deepcopy(STAMP)
    stamp.update(copy.deepcopy(overrides))
    return stamp


class TheBuilderIsTheOnlyConstructorTests(unittest.TestCase):
    def test_a_built_stamp_is_the_closed_json_shape(self) -> None:
        ds = _module()
        built = ds.build_decision_stamp(("zai", "glm-5.3"), _churn_of(ENTRIES))
        self.assertEqual(built, STAMP)
        self.assertEqual(set(built), {"schema_version", "route", "numstat"}, "a stamp stores no totals")
        self.assertEqual({tuple(sorted(entry)) for entry in built["numstat"]}, {("added", "deleted", "path")})
        self.assertEqual(json.loads(json.dumps(built)), built)
        self.assertIsNone(ds.validate_decision_stamp(built))
        self.assertEqual(ds.DECISION_STAMP_FIELD, "decision_stamp")

    def test_no_route_is_recorded_as_null_never_guessed(self) -> None:
        ds = _module()
        built = ds.build_decision_stamp(None, _churn_of(ENTRIES))
        self.assertEqual(built, {**STAMP, "route": None})
        self.assertIsNone(ds.validate_decision_stamp(built))

    def test_the_builder_validates_what_it_builds(self) -> None:
        # A builder that trusted its inputs would mint a stamp the ledger then refuses at every fold.
        ds = _module()
        bad_inputs = {
            "a change with no path": (("zai", "glm-5.3"), _churn(())),
            "a duplicate path": (("zai", "glm-5.3"), _churn([("a", 1, 1), ("a", 2, 2)])),
            "a negative count": (("zai", "glm-5.3"), _churn([("a", -1, 0)])),
            "a half-measured entry": (("zai", "glm-5.3"), _churn([("a", 1, None)])),
            "an empty provider": (("", "glm-5.3"), _churn_of(ENTRIES)),
            "an empty model": (("zai", ""), _churn_of(ENTRIES)),
        }
        for name, (route, churn) in bad_inputs.items():
            with self.subTest(input=name), self.assertRaisesRegex(GovernanceError, "^decision_stamp_invalid"):
                ds.build_decision_stamp(route, churn)

    def test_a_binary_only_change_is_a_stamp(self) -> None:
        ds = _module()
        built = ds.build_decision_stamp(("anthropic", "claude-opus-5"), _churn([("logo.png", None, None)]))
        self.assertEqual(built["numstat"], [{"path": "logo.png", "added": None, "deleted": None}])
        self.assertIsNone(ds.validate_decision_stamp(built))


class RefusalsAreNamedTests(unittest.TestCase):
    def _refused(self, stamp, *, naming: tuple[str, ...] = ()) -> None:
        """``stamp`` is refused as ``decision_stamp_invalid: <field>``; ``naming`` lists the spellings of the field that fit."""
        ds = _module()
        with self.assertRaises(GovernanceError) as raised:
            ds.validate_decision_stamp(stamp)
        message = str(raised.exception)
        self.assertTrue(message.startswith("decision_stamp_invalid:"), message)
        self.assertTrue(message.split(":", 1)[1].strip(), "the refusal names no field")
        if naming:
            self.assertTrue(any(field in message for field in naming), f"{message!r} names none of {naming}")

    def test_the_control_is_valid(self) -> None:
        self.assertIsNone(_module().validate_decision_stamp(copy.deepcopy(STAMP)))

    def test_the_top_level_is_closed(self) -> None:
        self._refused({**copy.deepcopy(STAMP), "totals": {"files": 9}})
        self._refused({key: value for key, value in copy.deepcopy(STAMP).items() if key != "route"})
        self._refused(_stamp(schema_version=2), naming=("schema_version",))
        self._refused(None)
        self._refused([STAMP])

    def test_the_route_is_a_pair_of_names_or_null(self) -> None:
        self._refused(_stamp(route="zai/glm-5.3"), naming=("route",))
        self._refused(_stamp(route={"provider": "zai"}), naming=("route", "model"))
        self._refused(_stamp(route={"provider": "", "model": "glm-5.3"}), naming=("route", "provider"))
        self._refused(_stamp(route={"provider": "zai", "model": ""}), naming=("route", "model"))

    def test_numstat_is_a_non_empty_sorted_list_of_unique_measured_paths(self) -> None:
        self._refused(_stamp(numstat="a.txt"), naming=("numstat",))
        self._refused(_stamp(numstat=[]), naming=("numstat",))
        self._refused(_stamp(numstat={"a.txt": [1, 2]}), naming=("numstat",))
        # added/deleted are both measured or both not.
        self._refused(_stamp(numstat=[{"path": "a", "added": 1, "deleted": None}]))
        self._refused(_stamp(numstat=[{"path": "a", "added": None, "deleted": 1}]))
        # a count is a non-negative int, and a bool is not an int here.
        self._refused(_stamp(numstat=[{"path": "a", "added": -1, "deleted": 0}]))
        self._refused(_stamp(numstat=[{"path": "a", "added": True, "deleted": 0}]))
        self._refused(_stamp(numstat=[{"path": "a", "added": 0, "deleted": False}]))
        self._refused(_stamp(numstat=[{"path": "a", "added": 1.0, "deleted": 0}]))
        # a path is a non-empty string, once, in sorted order.
        self._refused(_stamp(numstat=[{"path": "", "added": 1, "deleted": 0}]))
        self._refused(_stamp(numstat=[{"path": "a", "added": 1, "deleted": 0}, {"path": "a", "added": 2, "deleted": 0}]))
        self._refused(_stamp(numstat=[{"path": "b", "added": 1, "deleted": 0}, {"path": "a", "added": 1, "deleted": 0}]))

    def test_the_near_misses_are_accepted(self) -> None:
        ds = _module()
        self.assertIsNone(ds.validate_decision_stamp(_stamp(route=None)))
        self.assertIsNone(ds.validate_decision_stamp(_stamp(numstat=[{"path": "x.bin", "added": None, "deleted": None}])))
        self.assertIsNone(ds.validate_decision_stamp(_stamp(numstat=[{"path": "z", "added": 0, "deleted": 0}])))


class TheReadersAreTheOnlyPlaceTotalsAreComputedTests(unittest.TestCase):
    def test_churn_totals(self) -> None:
        ds = _module()
        self.assertEqual(ds.stamp_churn(copy.deepcopy(STAMP)), {"files": 9, "added": 8, "deleted": 6, "binary": 1})
        # A binary file is a file and a binary, never zero lines of a measured one.
        self.assertEqual(ds.stamp_churn(_stamp(numstat=[{"path": "b", "added": None, "deleted": None}])),
                         {"files": 1, "added": 0, "deleted": 0, "binary": 1})

    def test_the_route_key(self) -> None:
        ds = _module()
        self.assertEqual(ds.stamp_route_key(copy.deepcopy(STAMP)), "zai/glm-5.3")
        self.assertEqual(ds.UNSTAMPED_ROUTE, "unstamped")
        self.assertEqual(ds.stamp_route_key(None), ds.UNSTAMPED_ROUTE)
        self.assertEqual(ds.stamp_route_key(_stamp(route=None)), ds.UNSTAMPED_ROUTE)


class ImportDisciplineTests(unittest.TestCase):
    """``decision_stamp`` is imported by the plan ledger at module level: it may add no import cycle."""

    def _import(self, statement: str) -> subprocess.CompletedProcess[str]:
        code = f"import sys; sys.path.insert(0, sys.argv[1]); {statement}"
        return subprocess.run([sys.executable, "-I", "-c", code, str(_KERNEL_ROOT)], capture_output=True, text=True, check=False)

    def test_it_imports_in_a_fresh_interpreter_before_and_after_the_plan_ledger(self) -> None:
        _module()
        for statement in (
            "import aria_kernel.plan_convergence, aria_kernel.decision_stamp",
            "import aria_kernel.decision_stamp, aria_kernel.plan_convergence",
            "import aria_kernel.decision_stamp",
        ):
            with self.subTest(statement=statement):
                done = self._import(statement)
                self.assertEqual(done.returncode, 0, done.stderr[-800:])

    def test_it_does_not_import_change_paths_at_module_level(self) -> None:
        _module()
        spec = importlib.util.find_spec("aria_kernel.decision_stamp")
        tree = ast.parse(Path(spec.origin).read_text(encoding="utf-8"))

        def names(node: ast.AST) -> list[str]:
            if isinstance(node, ast.Import):
                return [alias.name for alias in node.names]
            if isinstance(node, ast.ImportFrom):
                return [f"{'.' * node.level}{node.module or ''}", *(alias.name for alias in node.names)]
            return []

        def is_type_checking(node: ast.AST) -> bool:
            return isinstance(node, ast.If) and "TYPE_CHECKING" in ast.dump(node.test)

        module_level = [name for node in tree.body if not is_type_checking(node) for name in names(node)]
        self.assertFalse([name for name in module_level if "change_paths" in name],
                         f"decision_stamp imports change_paths at module level: {module_level}")


if __name__ == "__main__":
    unittest.main()
