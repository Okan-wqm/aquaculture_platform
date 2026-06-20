"""Plan ARIA-V3 Phase A3 — DraftIntent + grammar validator + PII filter.

Closes GAP-4 architecturally. Pre-V3 ``_render_agent_markdown`` and
``_render_skill`` returned hardcoded markdown templates with zero
behavioural content. The kernel was a stub generator, not an intent
author. V3 inverts: kernel emits ``AgentDraftIntent``/``SkillDraftIntent``
(grammar + acceptance tests + evidence allowlist + diff classifier
lane + banned phrases); body synthesis is delegated to
``tools/aria-poc/worker_executor.py`` (drafter mode); kernel
validates the returned body against the intent grammar via
``draft_validator.validate_body_against_intent``.

Locked invariants (8 cases):

  * I-V3-07a — AgentDraftIntent required_sections grammar
  * I-V3-07b — SkillDraftIntent required_sections grammar
  * I-V3-08 — validator rejects each CLAUDE.md banned phrase
  * I-V3-09 — validator rejects evidence_refs outside allowlist
  * I-V3-10 — validator rejects diff classifier lane violation (path
    under aria-kernel/** / auth / tenant / migrations / secrets etc.)
  * I-V3-12a — ``_render_agent_intent`` return type is ``AgentDraftIntent``
  * I-V3-12b — ``_render_skill`` return type is ``SkillDraftIntent``
  * I-V3-12c — kernel module tree contains NO markdown literals
    outside data files (scan for ``## `` headers + YAML frontmatter
    in aria_kernel/*.py)
  * I-V3-13a — PII masked before claude spawn (intent free-text
    fields pass through ``mask_pii_in_intent``)
"""

from __future__ import annotations

import inspect
import re
import sys
import unittest
from pathlib import Path
from typing import get_type_hints


_REPO_ROOT = Path(__file__).resolve().parents[4]
_KERNEL_ROOT = _REPO_ROOT / "aria-kernel"
if str(_KERNEL_ROOT) not in sys.path:
    sys.path.insert(0, str(_KERNEL_ROOT))

_AUTO_ACTION_POLICY = (
    _KERNEL_ROOT
    / "aria_kernel"
    / "data"
    / "auto_action_policy.json"
)


class PhaseA3DraftValidation(unittest.TestCase):
    def test_i_v3_07a_agent_draft_intent_required_sections_locked(self) -> None:
        from aria_kernel.agent_genesis import _AGENT_REQUIRED_SECTIONS

        self.assertEqual(
            _AGENT_REQUIRED_SECTIONS,
            (
                "Purpose",
                "Scope",
                "Forbidden Scope",
                "Evidence Contract",
                "Output Schema",
                "Validation Fixtures",
            ),
            msg="Agent grammar sections must match V3 §A3 contract",
        )

    def test_i_v3_07b_skill_draft_intent_required_sections_locked(self) -> None:
        from aria_kernel.skill_genesis import _SKILL_REQUIRED_SECTIONS

        self.assertEqual(
            _SKILL_REQUIRED_SECTIONS,
            ("Validation checklist",),
            msg="Skill grammar sections must match V3 §A3 contract",
        )

    def test_i_v3_08_validator_rejects_every_banned_phrase(self) -> None:
        from aria_kernel.draft_intent import BANNED_PHRASES_DEFAULT
        from aria_kernel.draft_validator import validate_body_against_intent

        intent = self._minimal_agent_intent()
        # Build a body that satisfies every other check (sections,
        # no evidence refs, target_path allowed) and ONLY the banned
        # phrase trips the gate.
        base_body = self._minimal_valid_body()
        for phrase in BANNED_PHRASES_DEFAULT:
            body_with_phrase = base_body + f"\n\nNote: {phrase} edit follows.\n"
            result = validate_body_against_intent(
                body_with_phrase, intent,
                auto_action_policy_path=_AUTO_ACTION_POLICY,
            )
            self.assertFalse(
                result.valid,
                msg=f"validator must reject banned phrase {phrase!r}",
            )
            joined = ";".join(result.complaints)
            self.assertIn("banned_phrases_present", joined)

    def test_i_v3_09_validator_rejects_evidence_ref_outside_allowlist(self) -> None:
        from aria_kernel.draft_validator import validate_body_against_intent

        intent = self._minimal_agent_intent()
        # Body declares an evidence_ref that the intent's allowlist
        # does NOT contain.
        body = (
            self._minimal_valid_body()
            + '\n\nevidence_refs: ["apps/forbidden/secret.ts:1"]\n'
        )
        result = validate_body_against_intent(
            body, intent, auto_action_policy_path=_AUTO_ACTION_POLICY,
        )
        self.assertFalse(result.valid)
        self.assertTrue(
            any("evidence_refs_outside_allowlist" in c for c in result.complaints)
        )

    def test_i_v3_10_validator_rejects_diff_classifier_lane_violation(self) -> None:
        """Body that mentions a path under the L3 exclusion list
        (aria-kernel/**, auth, tenant, migrations, secrets, etc.)
        is rejected by the SSoT classifier (CRIT-V3-003 closure).
        """
        from aria_kernel.draft_intent import (
            AcceptanceTest,
            AgentDraftIntent,
            BANNED_PHRASES_DEFAULT,
        )
        from aria_kernel.draft_validator import validate_body_against_intent

        forbidden_paths = (
            "aria-kernel/aria_kernel/cli.py",
            "apps/auth-service/src/main.ts",
            "apps/billing-service/src/billing/controllers/stripe-webhook.controller.ts",
            "infrastructure/terraform/main.tf",
            ".env.production",
            "apps/farm-service/src/database/migrations/123-init.ts",
        )
        for forbidden_path in forbidden_paths:
            intent = AgentDraftIntent(
                intent_kind="agent",
                intent_id="intent-x",
                name="aria-x",
                target_path=forbidden_path,  # forbidden by classifier
                purpose="Test",
                required_sections=("Purpose",),
                scope_globs=("**",),
                forbidden_globs=(),
                evidence_contract="Cite refs.",
                output_schema={},
                acceptance_tests=(
                    AcceptanceTest(
                        name="t", expected="x", description="",
                    ),
                ),
                evidence_allowlist=(),
                diff_classifier_lane="L0-main",
                banned_phrases=BANNED_PHRASES_DEFAULT,
            )
            body = "## Purpose\nTest body without other violations.\n"
            result = validate_body_against_intent(
                body, intent, auto_action_policy_path=_AUTO_ACTION_POLICY,
            )
            self.assertFalse(
                result.valid,
                msg=f"path {forbidden_path!r} must be rejected by classifier",
            )
            self.assertTrue(
                any(
                    "diff_classifier_lane_violation" in c
                    for c in result.complaints
                ),
                msg=f"missing lane violation complaint for {forbidden_path}: {result.complaints}",
            )

    def test_i_v3_12a_render_agent_intent_returns_AgentDraftIntent_type(self) -> None:
        from aria_kernel import agent_genesis
        from aria_kernel.draft_intent import AgentDraftIntent

        hints = get_type_hints(agent_genesis._render_agent_intent)
        self.assertEqual(hints.get("return"), AgentDraftIntent)

    def test_i_v3_12b_render_skill_returns_SkillDraftIntent_type(self) -> None:
        from aria_kernel import skill_genesis
        from aria_kernel.draft_intent import SkillDraftIntent

        hints = get_type_hints(skill_genesis._render_skill)
        self.assertEqual(hints.get("return"), SkillDraftIntent)

    def test_i_v3_12c_draft_rendering_modules_carry_no_markdown_literal(self) -> None:
        """Plan ARIA-V3 §A3 — DRAFT-RENDERING kernel modules MUST NOT
        carry markdown literals. The body is the drafter's job; the
        kernel emits grammar only on the draft path.

        Scope (narrow on purpose):
          * agent_genesis.py — _render_agent_intent returns intent
          * skill_genesis.py — _render_skill returns intent

        Other kernel surfaces that legitimately produce markdown
        (PR-body templates in pr_manager.py, dashboard renderers in
        architecture.py / reflection.py / plan_016_metrics.py, daily
        anchors in report.py) are intentionally excluded from this
        Phase A3 lock — each has its own contract gate (Plan V2 §3.9
        daily-anchor I-26 for report.py, PR-body conventions per
        CLAUDE.md for pr_manager.py).

        Scan strategy: skip docstring regions (triple-quote
        delimited) so the module's own narrative documentation does
        not false-positive. Match ``"## ``, ``'## ``, ``"### ``,
        ``'### `` (markdown-header literals) and ``"---\\n"`` /
        ``'---\\n'`` (YAML frontmatter literals).
        """
        kernel_root = _KERNEL_ROOT / "aria_kernel"
        in_scope = (
            kernel_root / "agent_genesis.py",
            kernel_root / "skill_genesis.py",
        )
        violations: list[str] = []
        for py in in_scope:
            text = py.read_text(encoding="utf-8")
            stripped = _strip_docstrings_and_comments(text)
            for marker in ('"## ', "'## ", '"### ', "'### "):
                if marker in stripped:
                    violations.append(f"{py.relative_to(_REPO_ROOT)}: {marker!r}")
            if '"---\\n"' in stripped or "'---\\n'" in stripped:
                violations.append(
                    f"{py.relative_to(_REPO_ROOT)}: YAML frontmatter literal"
                )
        self.assertEqual(
            violations,
            [],
            msg=(
                "Plan ARIA-V3 §A3 + I-V3-12c — draft-rendering kernel "
                f"modules MUST NOT carry markdown literals. Violations:\n"
                f"{violations}"
            ),
        )

    def test_i_v3_13a_pii_masked_before_intent_serialization(self) -> None:
        """The intent that reaches the drafter (via
        ``intent.to_intent_file()``) MUST have PII redacted with
        deterministic ``<pii:kind:sha8>`` tokens.
        """
        from aria_kernel.agent_genesis import _render_agent_intent

        # Construct a draft with PII shapes in operator-facing fields.
        draft = {
            "name": "aria-pii-leak-test",
            "purpose": "Reach out to john.doe@example.com for context",
            "scope_globs": ["apps/farm-service/**"],
            "forbidden_globs": ["aria-kernel/**"],
            "evidence_contract": "Operator phone: (555) 123-4567",
            "output_schema": {},
            "validation_fixtures": [
                {"name": "t1", "expected": "x", "description": ""},
                {"name": "t2", "expected": "x", "description": ""},
                {"name": "t3", "expected": "x", "description": ""},
            ],
            "evidence_refs": [],
        }
        intent = _render_agent_intent(draft)
        rendered = intent.to_intent_file()
        # Original PII shapes MUST NOT appear in the serialised intent.
        self.assertNotIn("john.doe@example.com", rendered)
        self.assertNotIn("(555) 123-4567", rendered)
        # Redaction tokens MUST appear (proves the masker fired).
        self.assertIn("<pii:email:", rendered)
        self.assertIn("<pii:phone:", rendered)

    def test_validator_passes_on_clean_body(self) -> None:
        """Sanity: a well-formed body that satisfies every grammar
        clause must return ``valid=True``.
        """
        from aria_kernel.draft_validator import validate_body_against_intent

        intent = self._minimal_agent_intent()
        body = self._minimal_valid_body()
        result = validate_body_against_intent(
            body, intent, auto_action_policy_path=_AUTO_ACTION_POLICY,
        )
        self.assertTrue(
            result.valid,
            msg=f"clean body must validate: {result.complaints}",
        )

    # --- helpers ---------------------------------------------------------

    def _minimal_agent_intent(self):
        from aria_kernel.draft_intent import (
            AcceptanceTest,
            AgentDraftIntent,
            BANNED_PHRASES_DEFAULT,
        )

        return AgentDraftIntent(
            intent_kind="agent",
            intent_id="intent-test",
            name="aria-test-agent",
            target_path=".claude/agents/aria-test-agent.md",
            purpose="Validate purpose",
            required_sections=(
                "Purpose",
                "Scope",
                "Forbidden Scope",
                "Evidence Contract",
                "Output Schema",
                "Validation Fixtures",
            ),
            scope_globs=("apps/farm-service/**",),
            forbidden_globs=("aria-kernel/**",),
            evidence_contract="cite refs",
            output_schema={"required": ["findings"]},
            acceptance_tests=(
                AcceptanceTest(
                    name="t", expected="x", description="",
                ),
            ),
            evidence_allowlist=("apps/farm-service/src/foo.ts:1",),
            diff_classifier_lane="L0-main",
            banned_phrases=BANNED_PHRASES_DEFAULT,
        )

    def _minimal_valid_body(self) -> str:
        return (
            "## Purpose\n"
            "Body purpose paragraph that satisfies the grammar.\n\n"
            "## Scope\n"
            "- apps/farm-service/**\n\n"
            "## Forbidden Scope\n"
            "- aria-kernel/**\n\n"
            "## Evidence Contract\n"
            "Findings cite repo paths.\n\n"
            "## Output Schema\n"
            "Required: findings.\n\n"
            "## Validation Fixtures\n"
            "- t: x\n"
        )


def _strip_docstrings_and_comments(source: str) -> str:
    """Return a source string with triple-quoted docstrings and
    line comments removed. Tokenize-based so we do not depend on
    fragile regex. Used by I-V3-12c to scan only executable code.
    """
    import io
    import tokenize

    out_parts: list[str] = []
    try:
        tokens = tokenize.generate_tokens(io.StringIO(source).readline)
        for tok in tokens:
            if tok.type in (tokenize.STRING, tokenize.COMMENT, tokenize.NL,
                            tokenize.NEWLINE, tokenize.ENCODING,
                            tokenize.ENDMARKER, tokenize.INDENT,
                            tokenize.DEDENT):
                # Strings: include only NON-docstring strings (assignment
                # values etc.). Heuristic: keep the literal so the markdown
                # scan still sees `"## "` if it appears as a value.
                # Skip pure docstring lines whose tok.start col is 0 AND
                # tok.string starts with `"""` or `'''`.
                if tok.type == tokenize.STRING:
                    s = tok.string
                    if (
                        (s.startswith('"""') or s.startswith("'''"))
                        and tok.start[1] in (0, 4, 8, 12, 16)
                    ):
                        # Likely a docstring; skip
                        continue
                    out_parts.append(s)
                continue
            out_parts.append(tok.string)
    except tokenize.TokenizeError:
        return source
    return "\n".join(out_parts)


if __name__ == "__main__":
    unittest.main()
