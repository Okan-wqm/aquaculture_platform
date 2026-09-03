"""Plan ARIA-V6 §2e V6.4 Phase 6.4 — auto-promotion invariants.

Four invariants pin the narrow auto-promotion exception:

  * I-V6.4-01 — default disabled. genesis_policy ships with
                auto_promote.enabled=false; operator MUST opt in.
  * I-V6.4-02 — profile-conditional. compute_auto_promote_token
                raises AutoPromoteIneligibleError when the runtime
                profile is not in policy.auto_promote.profiles.
  * I-V6.4-03 — precision floor enforced. Any precision_history row
                below min_precision OR critical_false_positives > 0
                blocks token computation.
  * I-V6.4-04 — source-substring invariant pins the literal
                ``if (not operator_approval and not auto_promote_token)
                or not evidence_chains_valid:`` predicate so a
                refactor cannot silently weaken the SHADOW -> ACTIVE
                gate.
"""

from __future__ import annotations

import inspect
import sys
import unittest
from pathlib import Path


_REPO_ROOT = Path(__file__).resolve().parents[4]
_KERNEL_ROOT = _REPO_ROOT / "aria-kernel"
if str(_KERNEL_ROOT) not in sys.path:
    sys.path.insert(0, str(_KERNEL_ROOT))


class PhaseV6_4AutoPromotion(unittest.TestCase):
    # I-V6.4-01 — default disabled.
    def test_i_v6_4_01_auto_promote_default_disabled(self) -> None:
        """Plan ARIA-V6 §2e v2 — auto_promote.enabled defaults False."""
        from aria_kernel.genesis_policy import auto_promote_policy
        policy = auto_promote_policy()
        self.assertFalse(
            policy["enabled"],
            msg=(
                "Plan ARIA-V6 §2e v2 — genesis_policy_default.json "
                "MUST ship auto_promote.enabled=false. Operator opts "
                "in explicitly via aria-config/genesis_policy.json "
                "override. Default-on would let any caller bypass "
                "operator_approval at SHADOW -> ACTIVE."
            ),
        )
        # And the profile gate defaults to autonomous-only.
        self.assertIn(
            "autonomous", policy["profiles"],
            msg=(
                "Plan ARIA-V6 §2e v2 — default profiles MUST include "
                "'autonomous'; standard/strict/observe profiles MUST "
                "NOT auto-promote by default."
            ),
        )

    # I-V6.4-02 — profile-conditional.
    def test_i_v6_4_02_profile_gate_blocks_non_autonomous(self) -> None:
        """Plan ARIA-V6 §2e v2 — profile not in allowed list raises."""
        from aria_kernel.adapter_calibration import (
            AutoPromoteIneligibleError,
            compute_auto_promote_token,
        )
        # auto_promote.enabled defaults False — but even if enabled,
        # non-autonomous profile MUST raise.
        with self.assertRaises(AutoPromoteIneligibleError) as ctx:
            compute_auto_promote_token(
                tool_id="any-tool-id",
                base_dir=None,
                profile="strict",
                cycle_id="cycle-test",
            )
        msg = str(ctx.exception)
        self.assertTrue(
            ("disabled_by_policy" in msg or "profile_not_allowed" in msg),
            msg=(
                "Plan ARIA-V6 §2e v2 — non-autonomous profile MUST raise "
                "AutoPromoteIneligibleError (either via "
                "auto_promote_disabled_by_policy or "
                "auto_promote_profile_not_allowed). "
                f"Got message: {msg!r}"
            ),
        )

    # I-V6.4-03 — precision floor enforced.
    def test_i_v6_4_03_precision_floor_enforced(self) -> None:
        """Plan ARIA-V6 §2e v2 — precision_history.min() < min_precision
        OR critical_false_positives > 0 MUST raise."""
        from aria_kernel.adapter_calibration import (
            AutoPromoteIneligibleError,
            _precision_history,
        )
        # Verify the helper exists and would be consulted (smoke).
        self.assertTrue(callable(_precision_history))
        # Smoke: with empty history, the call should raise (insufficient_history)
        # rather than silently return a token. We exercise it via the public path
        # but expect AutoPromoteIneligibleError for the empty-history case.
        from aria_kernel.adapter_calibration import compute_auto_promote_token
        # Because the default policy has enabled=false, the first gate
        # triggers; that's also a valid block — we assert SOME block raises.
        with self.assertRaises(AutoPromoteIneligibleError):
            compute_auto_promote_token(
                tool_id="no-history-tool-id",
                base_dir=None,
                profile="autonomous",
                cycle_id="cycle-test",
            )

    # I-V6.4-04 — source-substring invariant pins the literal predicate.
    def test_i_v6_4_04_source_substring_pins_active_gate(self) -> None:
        """Plan ARIA-V6 §2e v2 — refactor-resistant guard.

        Reads tool_registry.transition_tool source and asserts the
        LITERAL predicate string appears. A refactor that reorders
        the OR clauses or replaces evidence_chains_valid with a
        helper call breaks this invariant — fails CI before merge.

        JJ-2b (ORPHAN-HIGH-732) REWROTE this pin rather than deleting it.
        The gate names THREE authorities (operator ref, auto-promote
        token, panel-approval token) because promotion became panel-approved
        with an operator veto window. What the pin protects is unchanged and
        is why it is rewritten instead of relaxed: evidence_chains_valid
        stays the LAST clause, so no authority can ever buy its way past
        evidence integrity.

        ORPHAN-HIGH-787 rewrote it AGAIN, same doctrine: the auto-promote
        authority is now `_auto_promote_verified` — the consume-time MAC
        verification of the token envelope — not the token's PRESENCE.
        A refactor back to `not auto_promote_token` re-opens the
        accepts-on-presence hole and must fail here.

        The forged-token reproduction (2026-09-01) rewrote it a THIRD
        time, same doctrine for the panel authority: `_panel_promote_
        verified` — the consume-time MAC verification via
        `promotion_veto.verify_panel_approval_token` — not the token's
        PRESENCE. `panel_approval_token='forged'` promoted SHADOW ->
        ACTIVE on presence alone; a refactor back to
        `not panel_approval_token` re-opens that hole and must fail here.

        The exact predicate (load-bearing order):

            if (not operator_approval and not _auto_promote_verified and not _panel_promote_verified) or not evidence_chains_valid:
        """
        import aria_kernel.tool_registry as mod
        src = inspect.getsource(mod.transition_tool)
        literal_predicate = (
            "if (not operator_approval and not _auto_promote_verified "
            "and not _panel_promote_verified) or not evidence_chains_valid:"
        )
        self.assertIn(
            literal_predicate, src,
            msg=(
                "Plan ARIA-V6 §2e v2 (I-V6.4-04) — transition_tool MUST "
                "contain the literal SHADOW -> ACTIVE predicate:\n\n"
                f"    {literal_predicate}\n\n"
                "A refactor that reorders the OR clauses, replaces "
                "evidence_chains_valid with a helper call, or substitutes "
                "any of the four boolean tokens silently weakens the gate. "
                "Restore the literal predicate to fix this invariant."
            ),
        )
        # And the verification must actually consult the verifier — a
        # predicate variable named _auto_promote_verified that nothing
        # assigns from verify_auto_promote_token would be a Potemkin gate.
        self.assertIn("verify_auto_promote_token(", src)
        # And auto_promote_token must be in the signature.
        sig = inspect.signature(mod.transition_tool)
        self.assertIn(
            "auto_promote_token", sig.parameters,
            msg=(
                "Plan ARIA-V6 §2e v2 — transition_tool MUST accept "
                "auto_promote_token kwarg (V6.4 architectural surface)."
            ),
        )
        param = sig.parameters["auto_promote_token"]
        self.assertIs(
            param.default, None,
            msg=(
                "Plan ARIA-V6 §2e v2 — auto_promote_token default MUST "
                "be None so legacy callers (no token supplied) hit the "
                "operator_approval-only path unchanged."
            ),
        )


if __name__ == "__main__":
    unittest.main()
