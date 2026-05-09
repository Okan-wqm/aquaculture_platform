"""Tests for the Plan 016 Faz F1+F2 adapter portfolio MVP + parse-window signature."""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from aria_kernel.adapter_portfolio import (
    DEFAULT_FRESHNESS_WINDOW_HOURS,
    PLAN_016_MVP_TOOL_IDS,
    backfill_window_metadata,
    list_mvp_status,
    parse_window_signature,
    register_mvp_adapters,
)
from aria_kernel.tool_registry import (
    GovernanceError,
    ensure_tools_dir,
    load_registry,
    register_tool,
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
        # Each registered tool carries the F2 fields.
        registry = load_registry(self.tools)
        ids = {t["tool_id"] for t in registry["tools"]}
        for expected in ("banned-phrase-adapter", "cqrs-adapter", "outbox-adapter", "dual-alias-adapter"):
            self.assertIn(expected, ids)
            tool = next(t for t in registry["tools"] if t["tool_id"] == expected)
            self.assertTrue(tool["parse_window_signature"].startswith("sha256:"))
            self.assertEqual(tool["freshness_window_hours"], DEFAULT_FRESHNESS_WINDOW_HOURS)
            self.assertEqual(tool["status"], "SHADOW")

    def test_register_is_idempotent(self) -> None:
        first = register_mvp_adapters(base_dir=self.tools)
        second = register_mvp_adapters(base_dir=self.tools)
        self.assertEqual(len(first["registered"]), 4)
        self.assertEqual(len(second["registered"]), 0)
        self.assertEqual(set(second["skipped_existing"]), set(first["registered"]))


class BackfillWindowMetadataTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools = _seed_tools()
        self.repo = self.tools.parent

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.repo, ignore_errors=True)

    def _seed_legacy_adapter(self, tool_id: str) -> None:
        register_tool(
            {
                "tool_id": tool_id,
                "kind": "adapter",
                "version": "0.1.0",
                "status": "SHADOW",
                "schema_version": 2,
                "owner": "platform",
                "claim_types": ["legacy"],
                "declared_scope": ["apps/**/*.ts"],
                "allowed_read_globs": ["apps/**/*.ts"],
                "forbidden_read_globs": [".git/**"],
                "fixture_set": "tools/aria-poc/fixtures/legacy",
                "health_thresholds": {
                    "precision_min": 0.85,
                    "non_critical_false_positives_30d": 3,
                    "critical_false_positives": 0,
                    "crash_rate_last_10": 0.2,
                },
                "output_schema": {"type": "object", "required": ["observations", "read_paths"]},
                "runner": {
                    "type": "subprocess",
                    "argv": ["python3", "shadow_runner.py", tool_id],
                    "cwd": "tools/aria-poc",
                    "stdin_json": True,
                    "timeout_ms": 15000,
                },
            },
            base_dir=self.tools,
        )

    def test_backfill_adds_window_fields_to_legacy_adapter(self) -> None:
        self._seed_legacy_adapter("legacy-test-adapter")
        result = backfill_window_metadata(base_dir=self.tools)
        self.assertIn("legacy-test-adapter", result["updated"])
        registry = load_registry(self.tools)
        tool = next(t for t in registry["tools"] if t["tool_id"] == "legacy-test-adapter")
        self.assertTrue(tool["parse_window_signature"].startswith("sha256:"))
        self.assertEqual(tool["freshness_window_hours"], DEFAULT_FRESHNESS_WINDOW_HOURS)

    def test_backfill_idempotent_when_metadata_already_current(self) -> None:
        self._seed_legacy_adapter("idem-test-adapter")
        backfill_window_metadata(base_dir=self.tools)
        result = backfill_window_metadata(base_dir=self.tools)
        self.assertIn("idem-test-adapter", result["untouched"])

    def test_invalid_freshness_rejected(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "freshness_hours must be positive"):
            backfill_window_metadata(base_dir=self.tools, freshness_hours=0)


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
