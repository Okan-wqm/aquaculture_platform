"""PROGRAM H / H-0 — the observation map is derived, and blindness is loud.

ARIA-HIGH-531 — only the typed globs of a dispatchable adapter row observe
(``tool_registry.observing_globs``); the rows are the live registry's, passed
in by the caller.
"""
from __future__ import annotations

import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

from aria_kernel.canonical_path import typed_alternatives
from aria_kernel.observation_coverage import (
    derive_observation_map,
    evaluate_observation_coverage,
)
from aria_kernel.tool_registry import observing_globs

REPO = Path(__file__).resolve().parents[2]


def _row(tool_id: str, globs: list[str], *, status: str = "SHADOW", kind: str = "adapter") -> dict[str, Any]:
    """A registry row as far as observation reads it."""
    return {"tool_id": tool_id, "kind": kind, "status": status, "declared_scope": globs}


def _tools(scopes: dict[str, list[str]]) -> list[dict[str, Any]]:
    return [_row(tool_id, globs) for tool_id, globs in scopes.items()]


def _workspace(tmp: str, *, unowned: list[dict] | None = None) -> Path:
    root = Path(tmp)
    if unowned is not None:
        config = root / "aria-config"
        config.mkdir(parents=True, exist_ok=True)
        (config / "observation_map.json").write_text(
            json.dumps({"schema_version": 1, "intentionally_unowned": unowned}),
            encoding="utf-8",
        )
    return root


class ObservationCoverageTest(unittest.TestCase):
    def test_a_root_no_adapter_declares_is_unobserved_and_named(self) -> None:
        with TemporaryDirectory() as tmp:
            rows = derive_observation_map(
                _workspace(tmp), tools=_tools({"ts-adapter": ["apps/**/*.ts"]}),
                files=["apps/a/main.ts", "sens-api-gateway/src/lib.rs"],
            )
            by_root = {row.root: row for row in rows}
            self.assertEqual(by_root["apps"].verdict, "observed")
            # The blind root is not merely absent from the observed list — it is
            # PRESENT and named, because a blindness nobody can point at is the
            # state this module exists to end.
            self.assertEqual(by_root["sens-api-gateway"].verdict, "unobserved")
            self.assertIn("no adapter declares", by_root["sens-api-gateway"].reason)

    def test_declaring_a_root_without_parsing_its_files_is_not_coverage(self) -> None:
        with TemporaryDirectory() as tmp:
            # The adapter claims the whole root but reads only TypeScript. The
            # operator's threshold is meaningful observation, so a claim that
            # cannot touch the files must not count as seeing them.
            rows = derive_observation_map(
                _workspace(tmp), tools=_tools({"ts-only": ["sens-api-gateway/**/*.ts"]}),
                files=["sens-api-gateway/src/lib.rs"],
            )
            self.assertEqual(rows[0].verdict, "unobserved")

    def test_partial_coverage_reports_the_fraction_rather_than_rounding_to_green(self) -> None:
        with TemporaryDirectory() as tmp:
            rows = derive_observation_map(
                _workspace(tmp), tools=_tools({"ts-adapter": ["apps/**/*.ts"]}),
                files=["apps/a/main.ts", "apps/a/schema.sql"],
            )
            self.assertEqual(rows[0].verdict, "partial")
            self.assertEqual((rows[0].observed_files, rows[0].files), (1, 2))

    def test_an_exemption_must_carry_a_reason_and_leaves_the_ratio_alone(self) -> None:
        with TemporaryDirectory() as tmp:
            root = _workspace(tmp, unowned=[{"root": "vendor", "reason": "third-party checkout, upstream owns it"}])
            verdict = evaluate_observation_coverage(
                root, tools=_tools({"ts-adapter": ["apps/**/*.ts"]}), files=["apps/a/main.ts", "vendor/x.js"],
            )
            # Exempt roots are excluded from the denominator, not counted as seen:
            # an exemption is permission to stop looking, never a claim of sight.
            self.assertEqual(verdict.verdict, "green")
            self.assertEqual(verdict.observed_ratio, 1.0)

    def test_an_unreadable_tree_is_unknown_not_green(self) -> None:
        verdict = evaluate_observation_coverage(
            "/nonexistent-workspace-for-this-test", tools=_tools({"ts-adapter": ["apps/**/*.ts"]}),
        )
        self.assertEqual(verdict.verdict, "unknown")
        self.assertNotEqual(verdict.verdict, "green")

    def test_no_tool_rows_is_unknown(self) -> None:
        # No rows read is no measurement; it must break the blind-night
        # streak (capability_gap), not be read as a tree nothing observes.
        with TemporaryDirectory() as tmp:
            verdict = evaluate_observation_coverage(_workspace(tmp), tools=[], files=["apps/a/main.ts"])
        self.assertEqual((verdict.verdict, verdict.reason), ("unknown", "no tool rows were read"))

    def test_a_blind_root_names_the_file_types_nothing_can_parse(self) -> None:
        with TemporaryDirectory() as tmp:
            # H-3 — the gap this feeds has to be an assignment, not a
            # complaint: "23 files unseen" tells nobody what to build,
            # ".rs — nothing in the toolbox reads it" names the parser.
            rows = derive_observation_map(
                _workspace(tmp), tools=_tools({"ts-adapter": ["apps/**/*.ts"]}),
                files=["apps/a/main.ts", "sens-api-gateway/src/lib.rs",
                       "sens-api-gateway/Cargo.toml", "sens-api-gateway/Dockerfile"],
            )
            by_root = {row.root: row for row in rows}
            self.assertEqual(
                by_root["sens-api-gateway"].unparsed_file_types,
                (".rs", ".toml", "Dockerfile"),
            )

    def test_unparsable_types_lead_with_the_one_that_dominates_the_root(self) -> None:
        with TemporaryDirectory() as tmp:
            # Measured on this repository: alphabetical order put `.aquamobil`
            # (from `Dockerfile.aquamobil`) ahead of `.rs`, so a capped payload
            # would have handed the reader the noise instead of the 449 Rust
            # files that are the actual assignment.
            rows = derive_observation_map(
                _workspace(tmp), tools=_tools({"ts-adapter": ["apps/**/*.ts"]}),
                files=["apps/a/main.ts", "edge/Dockerfile.aquamobil",
                       "edge/a.rs", "edge/b.rs", "edge/c.rs"],
            )
            by_root = {row.root: row for row in rows}
            self.assertEqual(
                by_root["edge"].unparsed_file_types, (".rs", ".aquamobil"),
            )

    def test_a_type_parsed_elsewhere_is_not_reported_as_unparsable(self) -> None:
        with TemporaryDirectory() as tmp:
            # The adapter reads TypeScript under apps/. web/ is unobserved
            # because nothing DECLARES it — but .ts is not the missing
            # parser, it is a missing scope line, and conflating the two
            # would send someone to write an adapter that already exists.
            rows = derive_observation_map(
                _workspace(tmp), tools=_tools({"ts-adapter": ["apps/**/*.ts"]}),
                files=["apps/a/main.ts", "web/shell/src/app.ts"],
            )
            by_root = {row.root: row for row in rows}
            self.assertEqual(by_root["web"].verdict, "unobserved")
            self.assertEqual(by_root["web"].unparsed_file_types, ())

    def test_brace_globs_expand_so_a_manifest_shorthand_is_not_silently_missed(self) -> None:
        self.assertEqual(sorted(typed_alternatives("web/**/*.{ts,tsx}")), ["web/**/*.ts", "web/**/*.tsx"])
        with TemporaryDirectory() as tmp:
            rows = derive_observation_map(
                _workspace(tmp), tools=_tools({"web-adapter": ["web/**/*.{ts,tsx}"]}),
                files=["web/a/x.ts", "web/a/y.tsx"],
            )
        self.assertEqual(rows[0].verdict, "observed")


class TypelessScopeObservesNothingTest(unittest.TestCase):
    """ARIA-HIGH-531 — a scope glob that fixes no file type is a read allowlist, not a parser."""

    FILES = ["apps/a.ts", "sens-api-gateway/src/lib.rs"]

    def test_a_typeless_scope_observes_nothing(self) -> None:
        with TemporaryDirectory() as tmp:
            rows = derive_observation_map(
                _workspace(tmp), tools=_tools({"banned-phrase-adapter": ["**"], "ts-adapter": ["apps/**/*.ts"]}),
                files=self.FILES,
            )
        by_root = {row.root: row for row in rows}
        self.assertEqual(by_root["sens-api-gateway"].verdict, "unobserved")
        self.assertEqual(by_root["sens-api-gateway"].unparsed_file_types, (".rs",))
        self.assertEqual(by_root["apps"].observing_adapters, ("ts-adapter",))

    def test_a_root_wide_glob_without_a_type_is_not_a_parser(self) -> None:
        with TemporaryDirectory() as tmp:
            verdict = evaluate_observation_coverage(
                _workspace(tmp), tools=_tools({"any": ["sens-api-gateway/**", "*", "*.*"], "ts": ["apps/**/*.ts"]}),
                files=self.FILES,
            )
        self.assertEqual(verdict.verdict, "red")
        self.assertIn("sens-api-gateway", verdict.reason)

    def test_brace_alternatives_are_judged_one_by_one(self) -> None:
        self.assertEqual(typed_alternatives("web/**/*.{ts,*}"), ("web/**/*.ts",))
        with TemporaryDirectory() as tmp:
            rows = derive_observation_map(
                _workspace(tmp), tools=_tools({"mixed": ["web/**/*.{ts,*}"]}),
                files=["web/a.ts", "web/b.rs"],
            )
        self.assertEqual((rows[0].verdict, rows[0].observed_files, rows[0].unparsed_file_types),
                         ("partial", 1, (".rs",)))

    def test_typed_and_typeless_alternatives(self) -> None:
        for glob in ("*.rs", "jest.config.*", "tsconfig*.json", "registry.json", "Dockerfile*", "**/jest.config.*"):
            with self.subTest(glob=glob):
                self.assertEqual(typed_alternatives(glob), (glob,))
        for glob in ("**", "*", "*.*", "x/**", "a/?"):
            with self.subTest(glob=glob):
                self.assertEqual(typed_alternatives(glob), ())

    def test_a_quarantined_row_observes_nothing(self) -> None:
        with TemporaryDirectory() as tmp:
            rows = derive_observation_map(
                _workspace(tmp), tools=[_row("rs-adapter", ["**/*.rs"], status="QUARANTINED")],
                files=["sens-api-gateway/src/lib.rs"],
            )
        self.assertEqual((rows[0].verdict, rows[0].unparsed_file_types), ("unobserved", (".rs",)))

    def test_a_non_adapter_row_observes_nothing(self) -> None:
        self.assertEqual(observing_globs(_row("a-gate", ["**/*.rs"], kind="gate")), ())
        with TemporaryDirectory() as tmp:
            rows = derive_observation_map(
                _workspace(tmp), tools=[_row("a-gate", ["**/*.rs"], kind="gate")],
                files=["sens-api-gateway/src/lib.rs"],
            )
        self.assertEqual(rows[0].verdict, "unobserved")

    def test_a_named_file_glob_still_observes(self) -> None:
        with TemporaryDirectory() as tmp:
            rows = derive_observation_map(
                _workspace(tmp), tools=_tools({"jest": ["**/jest.config.*"]}),
                files=["web/jest.config.ts"],
            )
        self.assertEqual(rows[0].verdict, "observed")

    def test_a_shadow_rs_row_makes_rs_parsable_tree_wide(self) -> None:
        with TemporaryDirectory() as tmp:
            rows = derive_observation_map(
                _workspace(tmp), tools=_tools({"rs-adapter": ["crates/**/*.rs"]}),
                files=["crates/a/src/lib.rs", "sens-api-gateway/src/lib.rs"],
            )
        by_root = {row.root: row for row in rows}
        # Unobserved (no scope line), but .rs is not the missing parser.
        self.assertEqual((by_root["sens-api-gateway"].verdict, by_root["sens-api-gateway"].unparsed_file_types),
                         ("unobserved", ()))

    def test_shipped_manifests_make_no_typeless_claim(self) -> None:
        # Structural, not a ratio: every glob a shipped manifest observes by
        # names a file type, and banned-phrase's `**` observes nothing.
        manifests = {
            path.name: json.loads(path.read_text(encoding="utf-8"))
            for path in sorted((REPO / "tools" / "aria-adapters").glob("*.tool.json"))
        }
        self.assertIn("banned-phrase-adapter.tool.json", manifests)
        self.assertEqual(observing_globs(manifests["banned-phrase-adapter.tool.json"]), ())
        for name, manifest in manifests.items():
            for glob in observing_globs(manifest):
                with self.subTest(manifest=name, glob=glob):
                    self.assertEqual(typed_alternatives(glob), (glob,))


if __name__ == "__main__":
    unittest.main()
