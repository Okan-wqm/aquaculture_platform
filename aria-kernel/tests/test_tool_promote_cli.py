"""E4/C1 — the promotion verb the registry never had.

`promote_tool` shipped with every gate (fixture pass, readiness, operator
approval) and ZERO command surface, so no adapter could ever leave SHADOW
and every finding was suppressed at the emission gate (the live registry
was 5 SHADOW + 1 QUARANTINED, 0 ACTIVE; 687 raw findings, 0 operator-
facing). This pins the new `aria-kernel tool promote` verb: it routes to
`promote_tool`, and the promotion gates hold through the CLI.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel import cli
from aria_kernel.tool_registry import GovernanceError, get_tool, register_tool

_FAKE_RUNNER = Path(__file__).resolve().parent / "_helpers" / "fake_tool_runner.py"


def _shadow_adapter(tool_id: str = "e4-adapter") -> dict:
    return {
        "tool_id": tool_id,
        "kind": "adapter",
        "version": "1.0.0",
        "status": "SHADOW",
        "declared_scope": ["apps/farm-service/src/**/*.ts"],
        "output_schema": {
            "type": "object",
            "required": ["observations", "findings", "read_paths", "evidence_sources"],
        },
        "fixture_set": "fixtures/e4-adapter",
        "health_thresholds": {"precision_min": 0.85},
        "allowed_read_globs": ["apps/farm-service/src/**/*.ts"],
        "forbidden_read_globs": ["dist/**"],
        "claim_types": ["schema_drift"],
        "owner": "platform",
        "runner": {"type": "subprocess", "argv": ["python3", _FAKE_RUNNER.as_posix()], "cwd": ".", "timeout_ms": 1000, "stdin_json": True},
        "schema_version": 1,
    }


class ToolPromoteCliTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.tools = Path(self.tmp.name) / "aria-tools"
        register_tool(_shadow_adapter(), base_dir=self.tools)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _promote(self, *extra: str) -> int:
        return cli.main([
            "tool", "promote",
            "--tool-id", "e4-adapter",
            "--tools-dir", str(self.tools),
            *extra,
        ])

    def test_verb_exists_and_routes(self) -> None:
        # The verb is parseable and reaches promote_tool — a SHADOW->ACTIVE
        # without an approval ref is refused by promote_tool's OWN gate
        # (a GovernanceError, matching the sibling tool verbs' contract:
        # unquarantine etc. also let the governance error surface). This
        # proves routing + the operator-approval gate, not a parser reject.
        with self.assertRaisesRegex(GovernanceError, "operator approval ref"):
            self._promote("--target-status", "ACTIVE", "--reason", "promote e4 adapter to active")
        self.assertEqual(
            get_tool("e4-adapter", self.tools)["status"], "SHADOW",
            "a refused promotion must not move the tool",
        )

    def test_active_refused_when_readiness_blocked(self) -> None:
        # With an approval ref but no shadow-run/fixture evidence, readiness
        # blocks — the gate holds through the CLI.
        with self.assertRaisesRegex(GovernanceError, "readiness blocked"):
            self._promote(
                "--target-status", "ACTIVE",
                "--reason", "promote e4 adapter to active",
                "--operator-approval-ref", "OPS-123",
            )
        self.assertEqual(get_tool("e4-adapter", self.tools)["status"], "SHADOW")

    def test_bad_target_status_rejected_by_parser(self) -> None:
        with self.assertRaises(SystemExit):
            self._promote("--target-status", "BROKEN", "--reason", "x y z")


if __name__ == "__main__":
    unittest.main()
