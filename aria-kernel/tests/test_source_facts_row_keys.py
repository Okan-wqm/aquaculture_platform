"""F0.9p — ``source_facts.extract`` yields the row keys each scope writes (``keys``), in the symbol layer only.

WHY THIS EXISTS. The provenance layer (``row_provenance``, ``ownership_atlas.provenance_edges``) answers "which
ledgers' rows cite which" from the code that BUILDS each row. A row is built as a dict literal, by a subscript store
(``row["k"] = v``) or as a dataclass declared in a class body, so the one parse the import graph and the atlas share
(``source_facts``) gains ONE fact for it, rather than the atlas parsing Python itself (tests/test_ownership_atlas_ssot.py
pins that neither consumer binds ``ast``).

THE API THIS PINS (new in F0.9p; at the branch base the fact does not exist, so each test reports an assertion failure,
``None != [...]``, not a KeyError):
  extract(source, path, name, is_package, symbols=True)["keys"]
    ``[scope, key]`` pairs, sorted and unique, for
      (a) a string-constant key of a dict literal,
      (b) ``row["key"] = ...`` (a Store subscript with a string constant),
      (c) a field declared directly in a class body (``name: type [= x]``: a dataclass is its own schema).
    NOT keys: a call keyword argument, a Load subscript or ``.get("k")``, a ``**`` spread, a non-string key, an
    annotated local inside a method. The scope is the top-level statement, as for every other symbol fact.
  The import layer and the pre-push selector (``symbols=False``) are unchanged: the selector caches ~1,500 modules'
  facts and the symbol layer would multiply that cache.
"""
from __future__ import annotations

import unittest
from typing import Any

from aria_kernel.source_facts import extract

_PATH = "aria-kernel/aria_kernel/x.py"
_MODULE = "aria_kernel.x"
_IMPORT_LAYER = {"imports", "refs", "tests", "bindings", "exports"}


def _keys(source: str) -> Any:
    # ``.get``: a module at the base has no ``keys`` fact, which must read as a failed assertion, not a KeyError.
    return extract(source, _PATH, _MODULE, False, symbols=True).get("keys")


class TheKeysARowIsBuiltWith(unittest.TestCase):
    def test_dict_literal_keys_and_subscript_stores_are_keys(self) -> None:
        source = 'def build(row):\n    row = {"plan_id": 1, "x": 2}\n    row["finding_id"] = 3\n    return row\n'
        self.assertEqual(_keys(source), [["build", "finding_id"], ["build", "plan_id"], ["build", "x"]])

    def test_the_keys_are_unique_and_sorted(self) -> None:
        source = 'def f():\n    a = {"z": 1, "k": 2}\n    a["k"] = 3\n    return {"k": 4, "a": 5}\n'
        self.assertEqual(_keys(source), [["f", "a"], ["f", "k"], ["f", "z"]])

    def test_reads_and_calls_are_not_keys(self) -> None:
        # A call keyword, .get("k") and a Load subscript read a row or name an argument: none builds a row.
        source = (
            "def read(row):\n"
            "    helper(plan_id=1)\n"
            '    a = row.get("change_id")\n'
            '    b = row["commit_sha"]\n'
            '    return {"label": b}\n'
        )
        self.assertEqual(_keys(source), [["read", "label"]])

    def test_a_class_body_field_is_a_key_and_a_method_local_is_not(self) -> None:
        source = (
            "@dataclass\n"
            "class Pattern:\n"
            "    plan_id: str | None = None\n"
            '    note: str = ""\n'
            "    def method(self):\n"
            '        local_id: str = "x"\n'
            "        return self.plan_id\n"
        )
        self.assertEqual(_keys(source), [["Pattern", "note"], ["Pattern", "plan_id"]])

    def test_a_spread_and_non_string_keys_are_not_keys(self) -> None:
        source = 'def f(base, k):\n    return {**base, 1: 2, k: 3, "z": 4}\n'
        self.assertEqual(_keys(source), [["f", "z"]])

    def test_the_scope_is_the_top_level_statement(self) -> None:
        self.assertEqual(_keys('ROW = {"plan_id": 1}\n'), [["ROW", "plan_id"]])
        nested = 'def outer():\n    def inner():\n        return {"change_id": 1}\n    return inner\n'
        self.assertEqual(_keys(nested), [["outer", "change_id"]])


class TheImportLayerIsUnchanged(unittest.TestCase):
    SOURCE = 'import os\n\ndef f():\n    return {"k": os.sep}\n'

    def test_without_symbols_there_is_no_keys_fact_and_the_cache_contract_holds(self) -> None:
        facts = extract(self.SOURCE, _PATH, _MODULE, False, symbols=False)
        self.assertNotIn("keys", facts)
        self.assertEqual(set(facts), _IMPORT_LAYER)

    def test_with_symbols_the_keys_fact_joins_the_symbol_layer_and_the_import_layer_is_kept(self) -> None:
        facts = extract(self.SOURCE, _PATH, _MODULE, False, symbols=True)
        self.assertIn("keys", facts)
        self.assertLessEqual(_IMPORT_LAYER, set(facts))
        self.assertEqual(facts["imports"], extract(self.SOURCE, _PATH, _MODULE, False, symbols=False)["imports"])


if __name__ == "__main__":
    unittest.main()
