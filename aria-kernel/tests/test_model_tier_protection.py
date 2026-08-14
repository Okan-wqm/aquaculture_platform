"""E16 (ORPHAN-673) — model-tier write protection (operator rule).

A weaker model must never delete or overwrite what a stronger model
authored; models below the authoring floor must not author agents at
all; the duel has no exception. Enforced at the single kernel path that
writes agent files (materialize), with the provenance stamp
kernel-injected — measured at mint, never claimed.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

from aria_kernel.agent_genesis import _enforce_model_tier_and_stamp
from aria_kernel.agent_runtime_profile import (
    MIN_AGENT_AUTHORING_TIER,
    MODEL_TIER_ORDER,
    assert_model_may_author_agents,
    assert_model_may_modify_agent,
    model_tier_rank,
    parse_authored_by_model as _parse_authored_by_model,
    stamp_authored_by_model,
)
from aria_kernel.tool_registry import GovernanceError

_BODY = "---\nname: aria-svc-farm-auditor\nmodel: fable\n---\n# Agent\n"


class TierOrderTests(unittest.TestCase):
    def test_order_is_the_operator_rule(self) -> None:
        self.assertEqual(MODEL_TIER_ORDER, ("fable", "opus", "sonnet", "haiku"))
        self.assertEqual(MIN_AGENT_AUTHORING_TIER, "opus")
        self.assertLess(model_tier_rank("fable"), model_tier_rank("opus"))
        self.assertLess(model_tier_rank("opus"), model_tier_rank("sonnet"))

    def test_unknown_target_author_ranks_strongest(self) -> None:
        # A stamp this kernel does not know is most plausibly a FUTURE,
        # stronger model — it must be protected, not modifiable.
        self.assertEqual(model_tier_rank("fable-6"), -1)


class AuthoringFloorTests(unittest.TestCase):
    def test_sonnet_and_haiku_cannot_author(self) -> None:
        # Deliberate-break for the operator rule "sonnet falan agent
        # yazamasın".
        for model in ("sonnet", "haiku"):
            with self.assertRaises(GovernanceError) as ctx:
                assert_model_may_author_agents(model)
            self.assertIn("agent_authoring_tier_too_low", str(ctx.exception))

    def test_fable_and_opus_may_author(self) -> None:
        assert_model_may_author_agents("fable")
        assert_model_may_author_agents("opus")

    def test_unknown_active_model_cannot_author(self) -> None:
        # An actor that cannot prove its tier may not author.
        with self.assertRaises(GovernanceError):
            assert_model_may_author_agents("mystery-model")


class ModifyGuardTests(unittest.TestCase):
    def test_weaker_cannot_overwrite_stronger(self) -> None:
        with self.assertRaises(GovernanceError) as ctx:
            assert_model_may_modify_agent(
                active_model="opus", target_authored_by="fable"
            )
        self.assertIn("model_tier_insufficient_to_modify", str(ctx.exception))
        self.assertIn("HUMAN_REQUIRED", str(ctx.exception))

    def test_equal_and_stronger_may_overwrite(self) -> None:
        assert_model_may_modify_agent(active_model="fable", target_authored_by="fable")
        assert_model_may_modify_agent(active_model="fable", target_authored_by="opus")
        assert_model_may_modify_agent(active_model="opus", target_authored_by="sonnet")

    def test_unknown_future_author_is_protected_from_everyone_known(self) -> None:
        with self.assertRaises(GovernanceError):
            assert_model_may_modify_agent(
                active_model="fable", target_authored_by="fable-6"
            )

    def test_unstamped_legacy_target_is_modifiable(self) -> None:
        # The rule protects provenance that exists; it does not invent it.
        assert_model_may_modify_agent(active_model="opus", target_authored_by=None)


class StampTests(unittest.TestCase):
    def test_stamp_injects_into_frontmatter(self) -> None:
        stamped = stamp_authored_by_model(_BODY, "fable")
        self.assertEqual(_parse_authored_by_model(stamped), "fable")
        self.assertTrue(stamped.startswith("---\nauthored_by_model: fable\n"))

    def test_drafter_supplied_stamp_is_overwritten(self) -> None:
        # Measured at mint, never claimed: a drafter asserting a higher
        # tier than it runs at is silently corrected to the truth.
        forged = _BODY.replace("---\nname:", "---\nauthored_by_model: fable\nname:")
        stamped = stamp_authored_by_model(forged, "opus")
        self.assertEqual(_parse_authored_by_model(stamped), "opus")
        self.assertEqual(stamped.count("authored_by_model:"), 1)


class MaterializeSeamTests(unittest.TestCase):
    def _enforce(self, drafter_model: str, existing: str | None) -> str:
        with tempfile.TemporaryDirectory() as tmp:
            worktree = Path(tmp)
            target = worktree / ".claude" / "agents" / "aria-x.md"
            if existing is not None:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(existing, encoding="utf-8")
            with mock.patch(
                "aria_kernel.agent_genesis._authoring_model",
                return_value=drafter_model,
            ):
                return _enforce_model_tier_and_stamp(
                    _BODY, target=target, worktree=worktree
                )

    def test_fresh_mint_is_stamped_with_the_drafter_model(self) -> None:
        stamped = self._enforce("fable", existing=None)
        self.assertEqual(_parse_authored_by_model(stamped), "fable")

    def test_low_tier_drafter_refused_at_the_seam(self) -> None:
        with self.assertRaises(GovernanceError) as ctx:
            self._enforce("sonnet", existing=None)
        self.assertIn("agent_authoring_tier_too_low", str(ctx.exception))

    def test_overwrite_of_stronger_authors_file_refused(self) -> None:
        existing = "---\nauthored_by_model: fable\nname: aria-x\n---\nbody\n"
        with self.assertRaises(GovernanceError) as ctx:
            self._enforce("opus", existing=existing)
        self.assertIn("model_tier_insufficient_to_modify", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
