"""Tests for the Plan 016 Faz F1 adapter portfolio MVP + the E13-C11
manifest-owned freshness metadata (parse_window_signature +
freshness_window_hours derived by validate_tool_definition, not patched
onto the registry at runtime)."""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel import adapter_portfolio
from aria_kernel.adapter_portfolio import (
    PLAN_016_MVP_TOOL_IDS,
    list_mvp_status,
)
from aria_kernel.tool_registry import (
    ensure_tools_dir,
    parse_window_signature,
)


def _seed_tools() -> Path:
    repo = Path(tempfile.mkdtemp(prefix="aria-faz-f-"))
    tools = repo / "aria-tools"
    ensure_tools_dir(tools)
    return tools


class ParseWindowSignatureTests(unittest.TestCase):
    def test_signature_is_stable_for_same_declaration(self) -> None:
        decl = {
            "declared_scope": ["apps/**/*.ts", "libs/**/*.ts"],
            "claim_types": ["tenant_scoping"],
            "default_input": {"roots": ["apps", "libs"]},
            "allowed_read_globs": ["apps/**/*.ts", "libs/**/*.ts"],
            "forbidden_read_globs": [".git/**"],
        }
        sig1 = parse_window_signature(decl)
        sig2 = parse_window_signature(decl)
        self.assertEqual(sig1, sig2)
        self.assertTrue(sig1.startswith("sha256:"))

    def test_signature_changes_when_scope_changes(self) -> None:
        base = {"declared_scope": ["apps/**/*.ts"], "claim_types": ["x"]}
        widened = {"declared_scope": ["apps/**/*.ts", "libs/**/*.ts"], "claim_types": ["x"]}
        self.assertNotEqual(parse_window_signature(base), parse_window_signature(widened))

    def test_signature_unaffected_by_field_order(self) -> None:
        a = {"declared_scope": ["a.ts", "b.ts"], "claim_types": ["a", "b"]}
        b = {"claim_types": ["b", "a"], "declared_scope": ["b.ts", "a.ts"]}
        self.assertEqual(parse_window_signature(a), parse_window_signature(b))


class SecondDeclarationSourceRemovedTests(unittest.TestCase):
    """ARIA-MEDIUM-378 — this module registered four adapters from rows of
    its own, each on the no-op shadow_runner.py, through a command no
    workflow ran; the parsers that existed never ran outside tests. The
    manifests are the only declaration now, and these pins break if a row
    builder or a registration path comes back here."""

    def test_the_portfolio_declares_no_adapter_rows(self) -> None:
        for name in ("_MVP_ADAPTERS", "_build_adapter_row", "register_mvp_adapters"):
            with self.subTest(name=name):
                self.assertFalse(hasattr(adapter_portfolio, name))


class RuntimePatchLayerRemovedTests(unittest.TestCase):
    """E13-C11 deliberate-break pins: the runtime metadata patcher is gone.

    backfill_window_metadata patched parse_window_signature +
    freshness_window_hours onto registry rows AFTER write, and every
    manifest recompile (registry_compiler / cycle.py register_tool sync)
    deleted them again — a Potemkin metadata layer with zero readers.
    Ownership moved to the manifests + validate_tool_definition; these
    pins break loudly if a post-hoc patcher or a second producer of the
    derived fields is reintroduced in this module.
    """

    def test_backfill_window_metadata_is_deleted(self) -> None:
        self.assertFalse(hasattr(adapter_portfolio, "backfill_window_metadata"))

    def test_freshness_ssot_no_longer_lives_in_adapter_portfolio(self) -> None:
        self.assertFalse(hasattr(adapter_portfolio, "DEFAULT_FRESHNESS_WINDOW_HOURS"))
        self.assertFalse(hasattr(adapter_portfolio, "parse_window_signature"))


class StatusTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools = _seed_tools()
        self.repo = self.tools.parent

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.repo, ignore_errors=True)

    def test_status_reports_full_missing_set_on_empty_registry(self) -> None:
        result = list_mvp_status(base_dir=self.tools)
        self.assertEqual(result["expected_count"], 8)
        self.assertEqual(result["registered_count"], 0)
        self.assertEqual(set(result["missing"]), set(PLAN_016_MVP_TOOL_IDS))


if __name__ == "__main__":
    unittest.main()
