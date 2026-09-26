"""E4/C1 — the promotion verb the registry never had.

`promote_tool` shipped with every gate (fixture pass, readiness, operator
approval) and ZERO command surface, so no adapter could ever leave SHADOW
and every finding was suppressed at the emission gate (the live registry
was 5 SHADOW + 1 QUARANTINED, 0 ACTIVE; 687 raw findings, 0 operator-
facing). This pins the new `aria-kernel tool promote` verb: it routes to
`promote_tool`, and the promotion gates hold through the CLI.

ARIA-CRITICAL-216 — the operator path is an operator's GitHub act approving
``surface=tool_promote tool=<id> target=ACTIVE``, read from a fake GitHub.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel import cli
from aria_kernel.tool_registry import GovernanceError, get_tool, register_tool
from tests._helpers.operator_acts import github_operator_acts

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
        acts = github_operator_acts()
        self.github = acts.__enter__()
        self.addCleanup(acts.__exit__, None, None, None)

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

    def _operator_act(self, target: str = "ACTIVE") -> str:
        return self.github.approve("tool_promote", {"tool": "e4-adapter", "target": target})

    def test_active_refused_when_readiness_blocked(self) -> None:
        # With an operator's approval but no shadow-run/fixture evidence,
        # readiness blocks — the gate holds through the CLI.
        ref = self._operator_act()
        with self.assertRaisesRegex(GovernanceError, "readiness blocked"):
            self._promote(
                "--target-status", "ACTIVE",
                "--reason", "promote e4 adapter to active",
                "--operator-approval-ref", ref,
            )
        self.assertEqual(get_tool("e4-adapter", self.tools)["status"], "SHADOW")

    def test_unrecorded_approval_ref_is_refused(self) -> None:
        # ARIA-HIGH-209 — a non-empty string is not authority.
        with self.assertRaisesRegex(GovernanceError, "tool_transition_approval_unrecorded"):
            self._promote(
                "--target-status", "ACTIVE",
                "--reason", "promote e4 adapter to active",
                "--operator-approval-ref", "OPS-123",
            )
        self.assertEqual(get_tool("e4-adapter", self.tools)["status"], "SHADOW")

    def test_recorded_references_are_refused_for_active(self) -> None:
        # ARIA-CRITICAL-216 — an environment acknowledgment, a governance
        # event (ARIA writes them) and a review file are all things the
        # governed system can author; none of them promotes.
        import os
        from unittest.mock import patch

        from aria_kernel.tool_registry import append_tools_governance

        event = append_tools_governance(self.tools, "operator_action", {"action": "approve"})
        with patch.dict(os.environ, {"ARIA_PROMOTE_ACK": "yes"}):
            for ref in ("ack-env:ARIA_PROMOTE_ACK", f"gov:{event['event_id']}"):
                with self.subTest(ref=ref), self.assertRaisesRegex(
                    GovernanceError, "tool_transition_approval_unrecorded.*gh:<owner>/<repo>",
                ):
                    self._promote(
                        "--target-status", "ACTIVE",
                        "--reason", "promote e4 adapter to active",
                        "--operator-approval-ref", ref,
                    )
        self.assertEqual(get_tool("e4-adapter", self.tools)["status"], "SHADOW")

    def test_an_act_for_another_target_does_not_promote(self) -> None:
        from unittest.mock import patch

        ready = {
            "active_ready": True, "zero_finding_lane": True, "precision": None,
            "critical_false_positives": 0, "blocked_by": [],
        }
        with patch("aria_kernel.promotion.adapter_active_readiness", return_value=ready), \
                self.assertRaisesRegex(GovernanceError, "tool_transition_approval_unrecorded"):
            self._promote(
                "--target-status", "ACTIVE",
                "--reason", "promote e4 adapter to active",
                "--operator-approval-ref", self._operator_act("SHADOW"),
            )
        self.assertEqual(get_tool("e4-adapter", self.tools)["status"], "SHADOW")

    def test_operator_act_is_accepted_and_recorded_on_the_transition(self) -> None:
        from unittest.mock import patch

        ref = self._operator_act()
        ready = {
            "active_ready": True, "zero_finding_lane": True, "precision": None,
            "critical_false_positives": 0, "blocked_by": [],
        }
        with patch("aria_kernel.promotion.adapter_active_readiness", return_value=ready):
            self._promote(
                "--target-status", "ACTIVE",
                "--reason", "promote e4 adapter to active",
                "--operator-approval-ref", ref,
            )
        tool = get_tool("e4-adapter", self.tools)
        self.assertEqual(tool["status"], "ACTIVE")
        transition = tool["last_transition"]
        self.assertEqual(transition["operator_approval_ref"], ref)
        self.assertEqual(transition["operator_approval"]["kind"], "gh")
        self.assertEqual(transition["operator_approval"]["login"], "Okan-wqm")
        self.assertEqual(
            transition["operator_approval"]["scope"], {"tool": "e4-adapter", "target": "ACTIVE"},
        )

    def test_transition_tool_verifies_the_ref_at_consume_time(self) -> None:
        # The state machine itself resolves the ref: a caller that skips
        # promote_tool cannot hand it an unrecorded string as authority.
        from aria_kernel.tool_registry import transition_tool

        with self.assertRaisesRegex(GovernanceError, "tool_transition_approval_unrecorded"):
            transition_tool(
                "e4-adapter", "ACTIVE", reason="direct", base_dir=self.tools,
                precision=1.0, critical_false_positives=0, evidence_chains_valid=True,
                operator_approval_ref="OPS-123",
            )
        self.assertEqual(get_tool("e4-adapter", self.tools)["status"], "SHADOW")

    def test_bad_target_status_rejected_by_parser(self) -> None:
        with self.assertRaises(SystemExit):
            self._promote("--target-status", "BROKEN", "--reason", "x y z")


class ReadinessAdapterViewTests(unittest.TestCase):
    """ARIA-HIGH-209 — the operator can see what blocks ACTIVE."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.tools = Path(self.tmp.name) / "aria-tools"
        register_tool(_shadow_adapter(), base_dir=self.tools)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _view(self, tool_id: str) -> tuple[int, dict]:
        import contextlib
        import io
        import json

        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = cli.main([
                "readiness", "adapter", "--tool-id", tool_id, "--tools-dir", str(self.tools),
            ])
        return code, json.loads(out.getvalue())

    def test_view_lists_the_active_blockers(self) -> None:
        code, view = self._view("e4-adapter")
        self.assertEqual(code, 1)
        self.assertIs(view["active_ready"], False)
        self.assertEqual(view["tool_id"], "e4-adapter")
        for blocker in ("fewer_than_5_shadow_runs", "latest_current_fixture_not_passed"):
            self.assertIn(blocker, view["blocked_by"])

    def test_unknown_tool_is_named(self) -> None:
        code, view = self._view("no-such-adapter")
        self.assertEqual(code, 2)
        self.assertIn("tool not found", view["error"])


if __name__ == "__main__":
    unittest.main()
