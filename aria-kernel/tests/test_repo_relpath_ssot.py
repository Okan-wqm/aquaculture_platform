"""ARIA-HIGH-186 — one repo-relative path normalizer.

``str.lstrip("./")`` strips CHARACTERS, not the ``./`` prefix, so
``.github/workflows/x.yml`` became ``github/workflows/x.yml``, ``.env`` became
``env`` and ``../x`` became ``x``. Five kernel sites carried the idiom after it
had already been fixed twice locally (ORPHAN-HIGH-576 in ``impact.py``, and
``feedback.py``), because there was no single normalizer to call. The risk
classifier therefore never matched ``.github/workflows/**`` and a skill-draft
containment check ran on a path whose ``../`` had already been erased.

These tests pin:
1. ``canonical_path.lexical_repo_path`` keeps a leading dot and strips only
   ``./`` prefixes.
2. ``canonical_path.normalize_repo_relpath`` additionally refuses absolute
   paths, ``..`` segments and empty input BEFORE anything is stripped.
3. Every former ``lstrip`` site now answers through the helper: dotfile paths
   keep their dot and traversal is refused.
4. An AST invariant: no ``.lstrip`` call whose argument contains both ``.`` and
   ``/`` exists in ``aria_kernel/`` or ``tools/aria-poc/`` — the idiom cannot
   come back a third time.
"""
from __future__ import annotations

import ast
import unittest
from pathlib import Path

from aria_kernel import architecture, auto_merge, pr_manager, service_dimension
from aria_kernel.canonical_path import lexical_repo_path, normalize_repo_relpath
from aria_kernel.convergent_skill_authoring import _git_show_line
from aria_kernel.tool_registry import GovernanceError

REPO_ROOT = Path(__file__).resolve().parents[2]


class LexicalRepoPathTests(unittest.TestCase):
    def test_keeps_leading_dot_of_dotfiles(self) -> None:
        self.assertEqual(lexical_repo_path(".github/workflows/x.yml"), ".github/workflows/x.yml")
        self.assertEqual(lexical_repo_path(".env"), ".env")
        self.assertEqual(lexical_repo_path(".claude/agents/x.md"), ".claude/agents/x.md")

    def test_strips_only_dot_slash_prefixes(self) -> None:
        self.assertEqual(lexical_repo_path("./docs/x.md"), "docs/x.md")
        self.assertEqual(lexical_repo_path("././docs/x.md"), "docs/x.md")
        self.assertEqual(lexical_repo_path(".\\docs\\x.md"), "docs/x.md")

    def test_does_not_hide_traversal(self) -> None:
        self.assertEqual(lexical_repo_path("./../x"), "../x")
        self.assertEqual(lexical_repo_path("../x"), "../x")


class NormalizeRepoRelpathTests(unittest.TestCase):
    def test_accepts_repo_relative_paths(self) -> None:
        self.assertEqual(normalize_repo_relpath("./docs/x.md"), "docs/x.md")
        self.assertEqual(normalize_repo_relpath(".env"), ".env")
        self.assertEqual(normalize_repo_relpath(".github/workflows/x.yml"), ".github/workflows/x.yml")

    def test_refuses_traversal_before_stripping(self) -> None:
        for raw in ("../x", "./../x", "a/../../b", "docs/../x", "..", ".\\..\\x"):
            with self.subTest(raw=raw):
                with self.assertRaises(GovernanceError) as ctx:
                    normalize_repo_relpath(raw)
                self.assertIn("repo_relpath_traversal", str(ctx.exception))

    def test_refuses_absolute_paths(self) -> None:
        for raw in ("/etc/passwd", "\\etc\\passwd", "C:/x", "c:\\x"):
            with self.subTest(raw=raw):
                with self.assertRaises(GovernanceError) as ctx:
                    normalize_repo_relpath(raw)
                self.assertIn("repo_relpath_absolute", str(ctx.exception))

    def test_refuses_empty(self) -> None:
        for raw in ("", "   ", "./"):
            with self.subTest(raw=raw):
                with self.assertRaises(GovernanceError) as ctx:
                    normalize_repo_relpath(raw)
                self.assertIn("repo_relpath_empty", str(ctx.exception))


class FormerLstripSitesTests(unittest.TestCase):
    def test_auto_merge_changed_files_keep_their_dot(self) -> None:
        self.assertEqual(auto_merge._changed_file_path(".github/workflows/x.yml"), ".github/workflows/x.yml")
        self.assertEqual(auto_merge._changed_file_path({"filename": ".env.prod"}), ".env.prod")
        with self.assertRaises(GovernanceError):
            auto_merge._changed_file_path("../outside.md")

    def test_auto_merge_classifies_workflow_paths_as_forbidden(self) -> None:
        verdict = auto_merge.classify_changed_files([".github/workflows/deploy.yml"])
        self.assertEqual(verdict["risk_class"], "forbidden")

    def test_pr_manager_has_no_private_normalizer(self) -> None:
        self.assertFalse(hasattr(pr_manager, "_normalize_path"))
        self.assertIs(pr_manager.normalize_repo_relpath, normalize_repo_relpath)

    def test_service_dimension_matches_dot_prefixed_owners(self) -> None:
        from aria_kernel.specialist_review_runner import domain_touch_map

        dot_prefixes = [prefix for prefix in domain_touch_map() if prefix.startswith(".")]
        if not dot_prefixes:
            self.skipTest("touch map declares no dot-prefixed path")
        prefix = dot_prefixes[0]
        owners = service_dimension.owning_agent_domains_for_paths([prefix + "x"])
        self.assertTrue(owners, f"{prefix}x must reach its owners; lstrip used to erase the dot")

    def test_architecture_project_key(self) -> None:
        self.assertEqual(architecture._project_key("./apps/farm-service/src/x.ts"), "apps/farm-service")
        self.assertIsNone(architecture._project_key(".github/apps/x/y"))

    def test_skill_authoring_refuses_traversal_before_git(self) -> None:
        self.assertEqual(_git_show_line(REPO_ROOT, "0" * 40, "../etc/passwd", 1), (False, ""))
        self.assertEqual(_git_show_line(REPO_ROOT, "0" * 40, "./../etc/passwd", 1), (False, ""))
        self.assertEqual(_git_show_line(REPO_ROOT, "0" * 40, "/etc/passwd", 1), (False, ""))


def _lstrip_dot_slash_calls(source: str) -> list[int]:
    lines: list[int] = []
    for node in ast.walk(ast.parse(source)):
        if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)):
            continue
        if node.func.attr != "lstrip" or not node.args:
            continue
        arg = node.args[0]
        if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
            if "." in arg.value and "/" in arg.value:
                lines.append(node.lineno)
    return lines


class NoLstripDotSlashInvariant(unittest.TestCase):
    def test_idiom_is_absent_from_kernel_and_executor(self) -> None:
        offenders: list[str] = []
        for root in (REPO_ROOT / "aria-kernel" / "aria_kernel", REPO_ROOT / "tools" / "aria-poc"):
            for path in sorted(root.rglob("*.py")):
                if "__pycache__" in path.parts:
                    continue
                for line in _lstrip_dot_slash_calls(path.read_text(encoding="utf-8")):
                    offenders.append(f"{path.relative_to(REPO_ROOT)}:{line}")
        self.assertEqual(
            offenders,
            [],
            "str.lstrip strips characters, not a prefix; use canonical_path.lexical_repo_path "
            "or canonical_path.normalize_repo_relpath (ARIA-HIGH-186)",
        )


if __name__ == "__main__":
    unittest.main()
