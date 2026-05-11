"""Plan 024 §B-4 — runtime_profile fail-closed behaviour tests.

Pre-fix get_profile silently returned DEFAULT_PROFILE ('standard') on
JSONDecodeError / OSError / unknown active_profile. An operator
deploying with intent 'frozen' (read-only / observe) silently flipped
to write-enabled if the profile JSON corrupts. Plan 024 §B-4 closes
this fail-OPEN.

Fix:
* New get_profile_with_diagnostic returns (profile_name, diagnostic).
  Diagnostic is None on success or absent file (bootstrap path);
  non-None when the resolution fell back to FROZEN_PROFILE.
* get_profile delegates to the diagnostic-aware variant and returns
  just the name (backward compatibility for existing callers).
* enforce_profile_for_action + enforce_profile_for_write at the
  write boundary consume the diagnostic and emit a best-effort
  governance event so audit trails capture WHY the gate is now
  refusing.

Tests:
1. Absent state file → ('standard', None) — bootstrap path preserved.
2. Valid 'standard' state → ('standard', None).
3. Valid 'frozen' state → ('frozen', None).
4. JSONDecodeError → ('frozen', kind=runtime_profile_parse_failure).
5. Unknown active_profile name → ('frozen',
   kind=runtime_profile_unknown_active_profile).
6. enforce_profile_for_action emits governance event when state file
   is corrupt (parse failure).
7. enforce_profile_for_action does NOT emit event under valid state.
8. get_profile (the legacy backward-compat wrapper) returns the same
   profile name as the diagnostic-aware variant — no governance
   side effect from the read path itself.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from aria_kernel.runtime_profile import (
    DEFAULT_PROFILE,
    FROZEN_PROFILE,
    PROFILE_STATE_FILENAME,
    enforce_profile_for_action,
    get_profile,
    get_profile_with_diagnostic,
    set_profile,
)
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir
from aria_kernel.ledger import load_jsonl


class RuntimeProfileFailClosedTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.tools = ensure_tools_dir(Path(self.tmp.name) / "aria-tools")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_absent_state_file_returns_default_no_diagnostic(self) -> None:
        """Plan 024 §B-4 acceptance (1): bootstrap path preserved."""
        profile, diagnostic = get_profile_with_diagnostic(base_dir=self.tools)
        self.assertEqual(profile, DEFAULT_PROFILE)
        self.assertIsNone(diagnostic)

    def test_valid_standard_state_no_diagnostic(self) -> None:
        """Plan 024 §B-4 acceptance (2)."""
        # set_profile creates the state file with active_profile=standard.
        set_profile(
            "standard",
            operator_approval_ref="OP-PLAN-024-B4-TEST",
            base_dir=self.tools,
        )
        profile, diagnostic = get_profile_with_diagnostic(base_dir=self.tools)
        self.assertEqual(profile, "standard")
        self.assertIsNone(diagnostic)

    def test_valid_frozen_state_no_diagnostic(self) -> None:
        """Plan 024 §B-4 acceptance (3)."""
        set_profile(
            "frozen",
            operator_approval_ref="OP-PLAN-024-B4-TEST",
            base_dir=self.tools,
        )
        profile, diagnostic = get_profile_with_diagnostic(base_dir=self.tools)
        self.assertEqual(profile, "frozen")
        self.assertIsNone(diagnostic)

    def test_corrupt_state_file_returns_frozen_with_parse_diagnostic(self) -> None:
        """Plan 024 §B-4 acceptance (4): malformed JSON fails closed to
        frozen with a runtime_profile_parse_failure diagnostic."""
        state_file = self.tools / PROFILE_STATE_FILENAME
        state_file.write_text("{ not valid json }", encoding="utf-8")
        profile, diagnostic = get_profile_with_diagnostic(base_dir=self.tools)
        self.assertEqual(profile, FROZEN_PROFILE,
            "corrupt state file must fall back to frozen, not standard")
        self.assertIsNotNone(diagnostic)
        self.assertEqual(diagnostic["kind"], "runtime_profile_parse_failure")
        self.assertEqual(diagnostic["path"], str(state_file))

    def test_unknown_active_profile_returns_frozen_with_diagnostic(self) -> None:
        """Plan 024 §B-4 acceptance (5)."""
        state_file = self.tools / PROFILE_STATE_FILENAME
        state_file.write_text(
            json.dumps({"active_profile": "made_up_name"}),
            encoding="utf-8",
        )
        profile, diagnostic = get_profile_with_diagnostic(base_dir=self.tools)
        self.assertEqual(profile, FROZEN_PROFILE)
        self.assertIsNotNone(diagnostic)
        self.assertEqual(diagnostic["kind"], "runtime_profile_unknown_active_profile")
        self.assertEqual(diagnostic["active_profile"], "made_up_name")

    def test_enforce_profile_for_action_emits_governance_event_on_corrupt(self) -> None:
        """Plan 024 §B-4 acceptance (6): write boundary captures the
        diagnostic in the audit trail."""
        state_file = self.tools / PROFILE_STATE_FILENAME
        state_file.write_text("{ not valid json }", encoding="utf-8")
        gov = self.tools / "governance.jsonl"
        before_rows = load_jsonl(gov) if gov.exists() else []
        # agent_claim is not permitted under frozen; expect rejection
        # AFTER the diagnostic is emitted.
        with self.assertRaises(GovernanceError):
            enforce_profile_for_action("agent_claim", base_dir=self.tools)
        after_rows = load_jsonl(gov)
        new_rows = after_rows[len(before_rows):]
        parse_events = [
            r for r in new_rows
            if r.get("kind") == "runtime_profile_parse_failure"
        ]
        self.assertEqual(
            len(parse_events), 1,
            f"expected 1 runtime_profile_parse_failure event; got {parse_events!r}",
        )

    def test_enforce_profile_for_action_no_event_under_valid_state(self) -> None:
        """Plan 024 §B-4 acceptance (7)."""
        set_profile(
            "standard",
            operator_approval_ref="OP-PLAN-024-B4-TEST",
            base_dir=self.tools,
        )
        gov = self.tools / "governance.jsonl"
        before_rows = load_jsonl(gov) if gov.exists() else []
        # agent_claim permitted under standard.
        result = enforce_profile_for_action("agent_claim", base_dir=self.tools)
        self.assertEqual(result, "standard")
        after_rows = load_jsonl(gov)
        new_rows = after_rows[len(before_rows):]
        diag_events = [
            r for r in new_rows
            if r.get("kind", "").startswith("runtime_profile_")
            and r.get("kind") != "runtime_profile_changed"
        ]
        self.assertEqual(diag_events, [],
            f"valid state must not emit diagnostic events; got {diag_events!r}")

    def test_legacy_get_profile_matches_diagnostic_aware_variant(self) -> None:
        """Plan 024 §B-4 acceptance (8): legacy wrapper returns the same
        name; pure read with no governance side effect."""
        state_file = self.tools / PROFILE_STATE_FILENAME
        state_file.write_text("{ malformed", encoding="utf-8")
        gov = self.tools / "governance.jsonl"
        before_rows = load_jsonl(gov) if gov.exists() else []
        legacy = get_profile(base_dir=self.tools)
        rich, diagnostic = get_profile_with_diagnostic(base_dir=self.tools)
        self.assertEqual(legacy, rich)
        self.assertEqual(legacy, FROZEN_PROFILE)
        self.assertIsNotNone(diagnostic)
        # Read path itself must not write governance.
        after_rows = load_jsonl(gov) if gov.exists() else []
        self.assertEqual(len(after_rows), len(before_rows),
            "get_profile / get_profile_with_diagnostic must be pure reads")


if __name__ == "__main__":
    unittest.main()
