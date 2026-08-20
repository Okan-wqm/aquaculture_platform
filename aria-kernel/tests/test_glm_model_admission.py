"""ORPHAN-HIGH-763 — a second vendor enters the dispatchable vocabulary.

WHY THIS IS AN EXTENSION AND NOT A SECOND RUNTIME: Z.ai serves GLM through an
Anthropic-shaped endpoint, so the same `claude` binary reaches it by swapping
ANTHROPIC_BASE_URL. Nothing about the dispatch path changes. What changes is
that two closed vocabularies — which models may be declared, and which model
outranks which — stop being Anthropic-only.

WHAT ADMISSION COSTS, pinned below because it is easy to miss: an UNLISTED
model resolves asymmetrically (`model_tier_rank`) — weakest as an actor,
strongest as a target. Before this change `glm-5.3` could author nothing and
its output was protected from everyone. Listing it trades that blanket
protection for a stated rank. The operator placed it between fable and opus on
2026-08-20, which grants authoring authority and puts its output beyond opus's
reach; that is the decision these pins record, not one they argue for.
"""
from __future__ import annotations

import unittest

from aria_kernel.agent_runtime_profile import (
    MIN_AGENT_AUTHORING_TIER,
    MODEL_TIER_ORDER,
    VALID_MODELS,
    model_tier_rank,
)
from aria_kernel.budget import (
    MODEL_FAMILY_PRICING_USD_PER_MTOK,
    MODEL_PRICING_USD_PER_MTOK,
    alias_pricing_prefix,
)

GLM = "glm-5.3"


class GlmAdmissionTests(unittest.TestCase):
    def test_glm_is_declarable(self) -> None:
        self.assertIn(GLM, VALID_MODELS)

    def test_the_operator_ordering_is_what_it_says(self) -> None:
        """The rank IS the authority, so the rank is pinned literally."""
        self.assertEqual(
            MODEL_TIER_ORDER, ("fable", GLM, "opus", "sonnet", "haiku"),
        )
        self.assertLess(model_tier_rank("fable"), model_tier_rank(GLM))
        self.assertLess(model_tier_rank(GLM), model_tier_rank("opus"))

    def test_glm_may_author_because_it_outranks_the_authoring_floor(self) -> None:
        """The consequence the operator chose, stated as a consequence.

        If this pin ever fails while MODEL_TIER_ORDER still lists GLM above
        opus, the floor moved and the grant moved with it silently.
        """
        # LISTED first, then ranked. Without the membership check this pin
        # passes even when GLM is absent, because an unknown model ranks -1 as
        # a target — a pin that cannot fail is decoration, and this file is
        # about not shipping those.
        self.assertIn(GLM, MODEL_TIER_ORDER)
        self.assertLess(
            MODEL_TIER_ORDER.index(GLM),
            MODEL_TIER_ORDER.index(MIN_AGENT_AUTHORING_TIER),
        )

    def test_a_dispatch_on_glm_cannot_record_zero_dollars(self) -> None:
        """The $0.00 failure (ORPHAN-HIGH-474) must not repeat for a new vendor."""
        self.assertEqual(MODEL_PRICING_USD_PER_MTOK[GLM], (1.40, 4.40))
        prefix = alias_pricing_prefix(GLM)
        self.assertIn(prefix, MODEL_FAMILY_PRICING_USD_PER_MTOK)
        self.assertTrue(
            [k for k in MODEL_PRICING_USD_PER_MTOK if k.startswith(prefix)],
        )

    def test_the_alias_prefix_is_not_a_claude_shaped_guess(self) -> None:
        """Deliberate breakage of the old rule, stated as its own pin.

        `f"claude-{alias}"` was the rule. For GLM it yields `claude-glm-5.3`,
        an id no vendor will ever emit, so coverage would have been reported
        for a family the ledger cannot match.
        """
        self.assertEqual(alias_pricing_prefix(GLM), "glm-5")
        self.assertNotEqual(alias_pricing_prefix(GLM), f"claude-{GLM}")
        self.assertEqual(alias_pricing_prefix("opus"), "claude-opus")

    def test_an_unknown_vendor_alias_prices_under_itself_not_under_claude(self) -> None:
        """Fail toward a MISS, never toward a false hit.

        An unmapped alias must not be silently prefixed into the Anthropic
        namespace, where it could match a row belonging to another vendor.
        """
        self.assertEqual(alias_pricing_prefix("some-future-model"), "some-future-model")

    def test_the_model_vocabulary_has_exactly_one_home(self) -> None:
        """The duplicate in tools/aria-poc/claude_runtime.py is gone.

        It was defined and read by nothing. A copy with no reader cannot be
        kept in step by discipline, only by luck.
        """
        import pathlib

        runtime = pathlib.Path(__file__).resolve().parents[2] / "tools" / "aria-poc" / "claude_runtime.py"
        body = runtime.read_text(encoding="utf-8")
        self.assertNotIn("VALID_MODELS: tuple", body)


if __name__ == "__main__":
    unittest.main()
