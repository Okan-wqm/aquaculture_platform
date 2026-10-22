"""WP-P — the role x provider matrix is a generated SSoT artifact, pinned byte-for-byte.

WHY these tests exist (the JUDGE-DIGEST pattern, E17-a):
``docs/aria/generated/ROLE-PROVIDER-MATRIX.md`` is the artifact that makes
WP-P's empty cells visible (package §1.1). Two failure modes are pinned:

1. Drift — a routing/envelope/fleet fact changes without regenerating the
   artifact, and the matrix silently teaches the operator a stale truth
   (byte-for-byte test; the regen command rides the failure message).
2. Inverted verdict — the generator's one indirect question (the Codex
   runtime's profile-controls gate, asked through its own typed refusal)
   silently flips if the owner reorders its checks; the pinned answers
   fail loudly instead.
"""
from __future__ import annotations

import unittest
from pathlib import Path
from unittest.mock import patch

from tests._helpers.role_provider_matrix import (
    MATRIX_PATH, REASON_CODEX_CONTROLS, codex_controls_verdict, render_role_provider_matrix,
)

REPO_ROOT = Path(__file__).resolve().parents[2]


class TheCommittedMatrixIsTheRender(unittest.TestCase):
    """(a) committed artifact ≡ renderer output, byte-for-byte."""

    def test_committed_matrix_matches_render_byte_for_byte(self):
        committed = (REPO_ROOT / MATRIX_PATH).read_text(encoding="utf-8")
        rendered = render_role_provider_matrix(REPO_ROOT)
        self.assertEqual(
            committed,
            rendered,
            (
                f"{MATRIX_PATH} is stale — a routing, envelope or fleet fact changed"
                " without regenerating. Run: cd aria-kernel &&"
                " python3 -m tests._helpers.role_provider_matrix"
                f" > ../{MATRIX_PATH}"
            ),
        )


class TheDriftPinDetectsASourceChange(unittest.TestCase):
    """(b) the deliberate break: a changed gate changes the render."""

    def test_a_changed_codex_controls_gate_changes_the_render(self):
        baseline = render_role_provider_matrix(REPO_ROOT)
        with patch("tests._helpers.role_provider_matrix.codex_controls_verdict",
                   return_value=REASON_CODEX_CONTROLS):
            broken = render_role_provider_matrix(REPO_ROOT)
        self.assertNotEqual(baseline, broken)
        self.assertIn(REASON_CODEX_CONTROLS, broken)
        # Every read seat keeps its two non-Codex rungs: the break narrows
        # the matrix, it never silently widens a cell.
        self.assertIn("| implementation | aria-implementer | openai | refused: provider_readonly_runtime",
                      broken)

    def test_every_dispatchable_role_has_a_row(self):
        from aria_kernel.agent_surface import DISPATCHABLE_ROLES
        from tests._helpers.role_provider_matrix import seat_rows

        rows = seat_rows(REPO_ROOT)
        roles = {row.role for row in rows}
        self.assertEqual(roles, set(DISPATCHABLE_ROLES),
                         sorted(set(DISPATCHABLE_ROLES) - roles))
        # The committed artifact carries them too.
        committed = (REPO_ROOT / MATRIX_PATH).read_text(encoding="utf-8")
        for role in sorted(DISPATCHABLE_ROLES):
            self.assertIn(f"| {role} |", committed)


class TheCodexControlsQuestionIsPinned(unittest.TestCase):
    """(c) the generator asks the Codex runtime's own gate; the answers are pinned.

    The generator reaches the gate through its typed refusal (the gate is
    inline in ``codex_runtime._prepare_managed_codex_context`` and runs before
    any filesystem fact). If the owner ever reorders those checks, these two
    pinned answers invert and fail here rather than flipping matrix cells.
    """

    def test_a_read_only_tools_profile_passes_the_controls_gate(self):
        from aria_kernel.runtime_profiles import profile_by_id

        self.assertIsNone(codex_controls_verdict(profile_by_id("planner")))

    def test_a_profile_with_tools_beyond_read_grep_glob_is_refused(self):
        from aria_kernel.runtime_profiles import profile_by_id

        self.assertEqual(codex_controls_verdict(profile_by_id("planner_orchestrator")),
                         REASON_CODEX_CONTROLS)
        self.assertEqual(codex_controls_verdict(profile_by_id("implementer")),
                         REASON_CODEX_CONTROLS)


if __name__ == "__main__":
    unittest.main()
