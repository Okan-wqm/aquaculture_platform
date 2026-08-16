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
    register_mvp_adapters,
)
from aria_kernel.tool_registry import (
    DEFAULT_FRESHNESS_WINDOW_HOURS,
    ensure_tools_dir,
    load_registry,
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


class RegisterMVPTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools = _seed_tools()
        self.repo = self.tools.parent

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.repo, ignore_errors=True)

    def test_register_creates_four_new_adapters_on_empty_registry(self) -> None:
        result = register_mvp_adapters(base_dir=self.tools)
        self.assertEqual(len(result["registered"]), 4)
        self.assertEqual(result["skipped_existing"], [])
        # Each registered tool carries the freshness fields — derived by
        # validate_tool_definition (E13-C11), NOT set by adapter_portfolio.
        registry = load_registry(self.tools)
        ids = {t["tool_id"] for t in registry["tools"]}
        for expected in ("banned-phrase-adapter", "cqrs-adapter", "outbox-adapter", "dual-alias-adapter"):
            self.assertIn(expected, ids)
            tool = next(t for t in registry["tools"] if t["tool_id"] == expected)
            self.assertTrue(tool["parse_window_signature"].startswith("sha256:"))
            self.assertEqual(tool["parse_window_signature"], parse_window_signature(tool))
            self.assertEqual(tool["freshness_window_hours"], DEFAULT_FRESHNESS_WINDOW_HOURS)
            self.assertEqual(tool["status"], "SHADOW")

    def test_register_is_idempotent(self) -> None:
        first = register_mvp_adapters(base_dir=self.tools)
        second = register_mvp_adapters(base_dir=self.tools)
        self.assertEqual(len(first["registered"]), 4)
        self.assertEqual(len(second["registered"]), 0)
        self.assertEqual(set(second["skipped_existing"]), set(first["registered"]))


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

    def test_status_after_register_has_no_missing_for_new_adapters(self) -> None:
        register_mvp_adapters(base_dir=self.tools)
        result = list_mvp_status(base_dir=self.tools)
        # Four MVP names registered; the other four (tenant-scoping etc.) are not
        # in this fresh fixture registry, so they will appear in `missing`.
        self.assertEqual(result["registered_count"], 4)
        new_ids = {
            "banned-phrase-adapter",
            "cqrs-adapter",
            "outbox-adapter",
            "dual-alias-adapter",
        }
        for mid in result["missing"]:
            self.assertNotIn(mid, new_ids)


if __name__ == "__main__":
    unittest.main()
