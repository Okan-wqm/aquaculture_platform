"""PROGRAM H / H-0 — the observation map is derived, and blindness is loud."""
from __future__ import annotations

import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from aria_kernel.observation_coverage import (
    _expand_braces,
    derive_observation_map,
    evaluate_observation_coverage,
)


def _workspace(tmp: str, *, scopes: dict[str, list[str]], unowned: list[dict] | None = None) -> Path:
    root = Path(tmp)
    adapters = root / "tools" / "aria-adapters"
    adapters.mkdir(parents=True)
    for tool_id, globs in scopes.items():
        (adapters / f"{tool_id}.tool.json").write_text(
            json.dumps({"tool_id": tool_id, "declared_scope": globs}), encoding="utf-8"
        )
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
            root = _workspace(tmp, scopes={"ts-adapter": ["apps/**/*.ts"]})
            rows = derive_observation_map(
                root, files=["apps/a/main.ts", "sens-api-gateway/src/lib.rs"]
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
            root = _workspace(tmp, scopes={"ts-only": ["sens-api-gateway/**/*.ts"]})
            rows = derive_observation_map(root, files=["sens-api-gateway/src/lib.rs"])
            self.assertEqual(rows[0].verdict, "unobserved")

    def test_partial_coverage_reports_the_fraction_rather_than_rounding_to_green(self) -> None:
        with TemporaryDirectory() as tmp:
            root = _workspace(tmp, scopes={"ts-adapter": ["apps/**/*.ts"]})
            rows = derive_observation_map(root, files=["apps/a/main.ts", "apps/a/schema.sql"])
            self.assertEqual(rows[0].verdict, "partial")
            self.assertEqual((rows[0].observed_files, rows[0].files), (1, 2))

    def test_an_exemption_must_carry_a_reason_and_leaves_the_ratio_alone(self) -> None:
        with TemporaryDirectory() as tmp:
            root = _workspace(
                tmp,
                scopes={"ts-adapter": ["apps/**/*.ts"]},
                unowned=[{"root": "vendor", "reason": "third-party checkout, upstream owns it"}],
            )
            verdict = evaluate_observation_coverage(
                root, files=["apps/a/main.ts", "vendor/x.js"]
            )
            # Exempt roots are excluded from the denominator, not counted as seen:
            # an exemption is permission to stop looking, never a claim of sight.
            self.assertEqual(verdict.verdict, "green")
            self.assertEqual(verdict.observed_ratio, 1.0)

    def test_an_unreadable_tree_is_unknown_not_green(self) -> None:
        verdict = evaluate_observation_coverage("/nonexistent-workspace-for-this-test")
        self.assertEqual(verdict.verdict, "unknown")
        self.assertNotEqual(verdict.verdict, "green")

    def test_brace_globs_expand_so_a_manifest_shorthand_is_not_silently_missed(self) -> None:
        self.assertEqual(
            sorted(_expand_braces("web/**/*.{ts,tsx}")),
            ["web/**/*.ts", "web/**/*.tsx"],
        )


if __name__ == "__main__":
    unittest.main()
