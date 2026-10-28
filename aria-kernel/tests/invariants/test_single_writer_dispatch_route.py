"""ARIA-LOW-741 (package F3.1) — ``details.agent_dispatch_model`` has ONE writer: ``independence_check``.

WHY THIS EXISTS. The key is the executor's word for which model ran a sealed response; the kernel
resolves "which (provider, model) executed this" from it (``independence_check.executed_route``),
and the distinct-model guarantee of the anchor, the judge's calibration identity and now the
delivery's decision stamp all stand on it. The agent's own spelling of the key is never trusted:
the executor FORCE-sets it (ORPHAN-HIGH-781, ARIA-MEDIUM-171: a named model overwrites what the agent
wrote, no model REMOVES the key). That rule was written out twice, inline: ``ci_executor`` (an
``if model: details[k] = m / else: details.pop(k)`` block) and the judge-batch envelope builder (a
dict literal). Two spellings of one rule diverge the first time one of them changes, and nothing
stopped a third. ``independence_check.stamp_dispatch_model`` is the one writer; this pin is the
"impossible" tier: any other module that writes the key fails here by name.

THE PATTERN is ``test_digest_single_owner``: a static scan of ``ownership_atlas.production_sources``
(the kernel and the executor, tests excluded), the owner exempt, and planted forgeries proving the
scan sees every shape it bans. A WRITE is the key (the string ``agent_dispatch_model``, or the
owner's ``DISPATCH_MODEL_KEY`` constant) as: a dict-literal key, a subscript store or delete,
``.pop`` / ``.setdefault`` / ``.update`` with it, or a keyword of ``dict(...)`` / ``.update(...)``.
A read (``details.get(key)``, a subscript load, ``in``) writes nothing and stays legal: the
readers (``judgment_bridge``, ``feedback_store``) are not touched.

WHAT BASE DOES TODAY. Three sites are offenders: ``ci_executor.py`` (the subscript store and the
``.pop``) and ``ci_executor_judge_batch.py`` (the dict-literal key). The repository scan is red at
base for exactly them; ``stamp_dispatch_model`` does not exist in the owner.
"""
from __future__ import annotations

import ast
import unittest
from collections.abc import Mapping
from pathlib import Path

from aria_kernel.ownership_atlas import production_sources

_REPO_ROOT = Path(__file__).resolve().parents[3]
_OWNER = "aria-kernel/aria_kernel/independence_check.py"
_FORGED = "aria-kernel/aria_kernel/forged_dispatch_writer.py"
_KEY = "agent_dispatch_model"
_KEY_CONSTANT = "DISPATCH_MODEL_KEY"
_MUTATORS = frozenset({"pop", "setdefault", "update", "__setitem__", "__delitem__"})


def _names_the_key(node: ast.AST | None) -> bool:
    if isinstance(node, ast.Constant):
        return node.value == _KEY
    if isinstance(node, ast.Name):
        return node.id == _KEY_CONSTANT
    if isinstance(node, ast.Attribute):
        return node.attr == _KEY_CONSTANT
    return False


def dispatch_model_writers(sources: Mapping[str, str]) -> list[str]:
    """``<path>:<line>:<shape>`` of every write of the key outside the owner."""
    found: list[str] = []
    for path, text in sorted(sources.items()):
        if path == _OWNER:
            continue
        for node in ast.walk(ast.parse(text, filename=path)):
            where = f"{path}:{getattr(node, 'lineno', 0)}"
            if isinstance(node, ast.Dict) and any(_names_the_key(key) for key in node.keys):
                found.append(f"{where}:dict_literal_key")
            elif isinstance(node, ast.Subscript) and isinstance(node.ctx, (ast.Store, ast.Del)) and _names_the_key(node.slice):
                found.append(f"{where}:subscript_{'store' if isinstance(node.ctx, ast.Store) else 'delete'}")
            elif isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr in _MUTATORS:
                if any(_names_the_key(arg) for arg in node.args) or any(kw.arg == _KEY for kw in node.keywords):
                    found.append(f"{where}:{node.func.attr}")
            elif isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "dict":
                if any(kw.arg == _KEY for kw in node.keywords):
                    found.append(f"{where}:dict_keyword")
    return sorted(set(found))


class TheDispatchRouteHasOneWriter(unittest.TestCase):
    def test_no_module_but_the_owner_writes_the_key(self) -> None:
        self.assertEqual(
            dispatch_model_writers(production_sources(_REPO_ROOT)), [],
            "a second writer of details.agent_dispatch_model: call independence_check.stamp_dispatch_model (ARIA-LOW-741)",
        )

    def test_the_owner_defines_the_writer_so_the_ban_has_a_taker(self) -> None:
        # RED AT BASE: the owner has no stamp_dispatch_model, so banning every other writer would leave none.
        owner = ast.parse(production_sources(_REPO_ROOT)[_OWNER])
        defined = {node.name for node in ast.walk(owner) if isinstance(node, ast.FunctionDef)}
        self.assertIn("stamp_dispatch_model", defined)
        assigned = {target.id for node in ast.walk(owner) if isinstance(node, ast.Assign)
                    for target in node.targets if isinstance(target, ast.Name)}
        self.assertIn(_KEY_CONSTANT, assigned)

    def test_the_scan_covers_both_executors(self) -> None:
        sources = production_sources(_REPO_ROOT)
        for path in ("tools/aria-poc/ci_executor.py", "tools/aria-poc/ci_executor_judge_batch.py", _OWNER):
            with self.subTest(path=path):
                self.assertIn(path, sources)


class APlantedSecondWriterIsRed(unittest.TestCase):
    def test_every_shape_of_a_second_writer_is_reported(self) -> None:
        shapes = {
            "a dict literal": 'details = {"agent_dispatch_model": model}\n',
            "a subscript store": 'details["agent_dispatch_model"] = model\n',
            "a subscript store through the constant": 'details[DISPATCH_MODEL_KEY] = model\n',
            "a subscript store through the module": 'details[independence_check.DISPATCH_MODEL_KEY] = model\n',
            "a pop": 'details.pop("agent_dispatch_model", None)\n',
            "a setdefault": 'details.setdefault("agent_dispatch_model", model)\n',
            "an update with a dict": 'details.update({"agent_dispatch_model": model})\n',
            "an update with a keyword": 'details.update(agent_dispatch_model=model)\n',
            "a dict() keyword": 'details = dict(agent_dispatch_model=model)\n',
            "a delete": 'del details["agent_dispatch_model"]\n',
        }
        for name, source in shapes.items():
            with self.subTest(shape=name):
                self.assertEqual(len(dispatch_model_writers({_FORGED: source})), 1, name)
                self.assertTrue(dispatch_model_writers({_FORGED: source})[0].startswith(f"{_FORGED}:1:"))

    def test_reads_and_the_owner_are_not_offenders(self) -> None:
        reads = (
            'model = details.get("agent_dispatch_model")\n'
            'present = "agent_dispatch_model" in details\n'
            'value = details["agent_dispatch_model"]\n'
            'other = {"agent_subagent_type": subagent}\n'
        )
        self.assertEqual(dispatch_model_writers({_FORGED: reads}), [])
        self.assertEqual(dispatch_model_writers({_OWNER: 'details["agent_dispatch_model"] = model\n'}), [])


if __name__ == "__main__":
    unittest.main()
