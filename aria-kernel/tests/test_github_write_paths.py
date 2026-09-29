"""ARIA-CRITICAL-246 — every GitHub write the kernel spells goes through one door.

``github_writes.run_gh_write`` refuses a write that would not run on an
installation token. A ``gh`` write argv built anywhere else skips that check.
This test reads the kernel's source, finds every list or tuple literal that
spells a ``gh`` write, and fails unless the literal is the argv handed straight
to ``run_gh_write`` or to a ``*_gh_write`` helper. Every such helper must itself
call ``run_gh_write``.
"""
from __future__ import annotations

import ast
import unittest
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
_SCANNED = (
    _REPO_ROOT / "aria-kernel" / "aria_kernel",
    _REPO_ROOT / "tools" / "aria-poc",
    _REPO_ROOT / "tools" / "aria",
)
_DOOR = _REPO_ROOT / "aria-kernel" / "aria_kernel" / "github_writes.py"

# gh subcommand -> the verbs that write.
_WRITE_VERBS: dict[str, frozenset[str]] = {
    "issue": frozenset({"create", "edit", "close", "reopen", "comment", "delete", "lock", "unlock", "pin", "unpin", "transfer"}),
    "pr": frozenset({"create", "edit", "close", "reopen", "comment", "merge", "review", "ready", "lock", "unlock"}),
    "label": frozenset({"create", "edit", "delete", "clone"}),
    "workflow": frozenset({"run", "enable", "disable"}),
    "run": frozenset({"rerun", "cancel", "delete"}),
    "release": frozenset({"create", "edit", "delete", "upload"}),
    "secret": frozenset({"set", "delete"}),
    "variable": frozenset({"set", "delete"}),
}
_METHOD_FLAGS = frozenset({"-X", "--method"})


def _strings(node: ast.List | ast.Tuple) -> list[str | None]:
    return [elt.value if isinstance(elt, ast.Constant) and isinstance(elt.value, str) else None for elt in node.elts]


def spells_a_gh_write(node: ast.List | ast.Tuple) -> bool:
    """A literal whose leading words are a gh write: `[gh] <sub> <verb>` or
    `[gh] api ... -X <non-GET>`."""
    words = _strings(node)
    if words[:1] == ["gh"]:
        words = words[1:]
    if len(words) >= 2 and words[0] in _WRITE_VERBS and words[1] in _WRITE_VERBS[words[0]]:
        return True
    if words[:1] == ["api"]:
        for flag, value in zip(words, words[1:]):
            if flag in _METHOD_FLAGS and isinstance(value, str) and value.upper() != "GET":
                return True
    return False


def _call_name(node: ast.Call) -> str:
    if isinstance(node.func, ast.Name):
        return node.func.id
    if isinstance(node.func, ast.Attribute):
        return node.func.attr
    return ""


def _is_door(name: str) -> bool:
    return name == "run_gh_write" or name.endswith("_gh_write")


def offenders(path: Path) -> list[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    handed_over: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and _is_door(_call_name(node)) and node.args:
            handed_over.add(id(node.args[0]))
    rel = path.relative_to(_REPO_ROOT).as_posix()
    return [
        f"{rel}:{node.lineno}"
        for node in ast.walk(tree)
        if isinstance(node, (ast.List, ast.Tuple)) and spells_a_gh_write(node) and id(node) not in handed_over
    ]


def _sources() -> list[Path]:
    return sorted(
        path for root in _SCANNED if root.exists() for path in root.rglob("*.py")
        if "tests" not in path.relative_to(root).parts and path != _DOOR
    )


class EveryGhWriteGoesThroughTheDoor(unittest.TestCase):
    def test_the_detector_knows_a_write_from_a_read(self) -> None:
        def literal(text: str) -> ast.List:
            node = ast.parse(text, mode="eval").body
            assert isinstance(node, ast.List)
            return node

        for write in ('["gh", "issue", "comment", n]', '["pr", "merge", n]', '["gh", "workflow", "run", w]',
                      '["api", "-X", "DELETE", "/installation/token"]', '["label", "create", x]'):
            self.assertTrue(spells_a_gh_write(literal(write)), write)
        for read in ('["gh", "issue", "list"]', '["gh", "pr", "view", n]', '["gh", "run", "list"]',
                     '["api", "repos/o/r/branches/main/protection"]', '["api", "-X", "GET", "x"]'):
            self.assertFalse(spells_a_gh_write(literal(read)), read)

    def test_no_kernel_source_spells_a_gh_write_outside_the_door(self) -> None:
        found = [hit for path in _sources() for hit in offenders(path)]
        self.assertEqual(found, [], "hand these argv to github_writes.run_gh_write")

    def test_every_write_helper_is_the_door(self) -> None:
        helpers: list[str] = []
        for path in _sources():
            tree = ast.parse(path.read_text(encoding="utf-8"))
            for node in ast.walk(tree):
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name.endswith("_gh_write"):
                    calls = {_call_name(inner) for inner in ast.walk(node) if isinstance(inner, ast.Call)}
                    helpers.append(f"{path.name}:{node.name}")
                    self.assertIn("run_gh_write", calls, f"{path.name}:{node.name} must call run_gh_write")
        self.assertIn("github_adapters.py:_gh_write", helpers)


if __name__ == "__main__":
    unittest.main()
