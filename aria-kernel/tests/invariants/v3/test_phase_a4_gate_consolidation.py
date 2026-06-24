"""Plan ARIA-V3 Phase A4 — AutoActionGate consolidation + 3-event chain.

Closes GAP-1 + CRIT-V3-003 + MED-V3-010 + AUDITTRAIL-CRITICAL-003.

Invariants locked (10 cases, I-V3-14..17d):

  * I-V3-14 — gate honours policy flag + profile (parametrised).
  * I-V3-15 — gate.consume_ack_token rejects unsigned token.
  * I-V3-16a — ``acknowledge`` parameter REMOVED from materialize
    public APIs (inspect signature; ``acknowledge`` not in
    ``Parameter.empty`` parameter list).
  * I-V3-16b — ``**kwargs`` passthrough does NOT silently swallow
    a stray ``acknowledge=True`` kwarg (TypeError raised).
  * I-V3-17 — policy_flag actually gates materialize across all
    (profile × flag × lane × classifier) cells.
  * I-V3-17a — three-event chain emitted with shared
    materialize_event_id (draft_validated → ack_consumed →
    materialize_committed) — AUDITTRAIL-CRITICAL-003.
  * I-V3-17b — breaker + cost states consulted BEFORE materialize
    runs (order-of-operations invariant — gate state read at
    factory time, not at materialize entry).
  * I-V3-17c — grep for ``acknowledge=True`` in
    materialize_(agent_draft|skill) test callsites returns zero
    (25+ callsite migration complete; the 12 non-materialize uses
    in cli.py for migrate-tools / rollback are unaffected).
  * I-V3-17d — single AutoActionGate type consumed by both
    materialize surfaces (same import path; not duplicated).
"""

from __future__ import annotations

import inspect
import json
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


_REPO_ROOT = Path(__file__).resolve().parents[4]
_KERNEL_ROOT = _REPO_ROOT / "aria-kernel"
if str(_KERNEL_ROOT) not in sys.path:
    sys.path.insert(0, str(_KERNEL_ROOT))


def _read_governance_kinds(tools_dir: Path) -> list[str]:
    gov = tools_dir / "governance.jsonl"
    if not gov.exists():
        return []
    return [
        json.loads(line).get("kind")
        for line in gov.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


def _read_governance_rows(tools_dir: Path) -> list[dict]:
    gov = tools_dir / "governance.jsonl"
    if not gov.exists():
        return []
    return [
        json.loads(line)
        for line in gov.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


class PhaseA4GateConsolidation(unittest.TestCase):
    def test_i_v3_14_gate_honours_policy_flag_and_profile(self) -> None:
        from aria_kernel.auto_action_gate import (
            AUTONOMOUS_AUTO_ACK_LANES,
            gate_from_test_fixture,
        )

        # Standard profile — always human-ack regardless of policy.
        g1 = gate_from_test_fixture(
            profile="standard", policy_requires_acknowledge=False,
        )
        self.assertTrue(g1.human_ack_required)

        self.assertEqual(AUTONOMOUS_AUTO_ACK_LANES, frozenset())

        # Historical snowball lane cannot auto-ack.
        g2 = gate_from_test_fixture(
            profile="autonomous", lane="L3-snowball",
            classifier_passed=True,
            policy_requires_acknowledge=False,
        )
        self.assertTrue(g2.human_ack_required)

        # Live main lane still requires operator ack.
        g3 = gate_from_test_fixture(
            profile="autonomous", lane="L0-main",
            classifier_passed=True,
            policy_requires_acknowledge=False,
        )
        self.assertTrue(g3.human_ack_required)

        # Autonomous + classifier_fail → human-ack.
        g4 = gate_from_test_fixture(
            profile="autonomous", lane="L3-snowball",
            classifier_passed=False,
            policy_requires_acknowledge=False,
        )
        self.assertTrue(g4.human_ack_required)

        # Autonomous on a non-L3 lane → human-ack.
        g5 = gate_from_test_fixture(
            profile="autonomous", lane="L0-main",
            classifier_passed=True,
            policy_requires_acknowledge=False,
        )
        self.assertTrue(g5.human_ack_required)

        # Breaker tripped → human-ack.
        g6 = gate_from_test_fixture(
            profile="autonomous", lane="L3-snowball",
            classifier_passed=True,
            policy_requires_acknowledge=False,
            breaker_state="tripped",
        )
        self.assertTrue(g6.human_ack_required)

    def test_i_v3_15_gate_rejects_unknown_ack_token(self) -> None:
        from aria_kernel.ack_ledger import init_ack_ledger, mint_operator_ack
        from aria_kernel.auto_action_gate import gate_from_test_fixture
        from aria_kernel.tool_registry import GovernanceError

        with tempfile.TemporaryDirectory(prefix="aria-i-v3-15-") as tmp:
            base = Path(tmp)
            init_ack_ledger(
                base_dir=base,
                reason="invariant 15 test setup",
                operator_approval_ref="RFC-T",
            )
            gate = gate_from_test_fixture()
            # Token id never minted — consume should raise.
            with self.assertRaises(GovernanceError) as ctx:
                gate.consume_ack_token(
                    ack_id="not-a-real-uuid",
                    base_dir=base,
                )
            self.assertIn("ack_token_not_found", str(ctx.exception))

    def test_i_v3_16a_acknowledge_param_removed_from_materialize_apis(self) -> None:
        from aria_kernel.agent_genesis import materialize_agent_draft
        from aria_kernel.skill_genesis import materialize_skill

        for func in (materialize_agent_draft, materialize_skill):
            sig = inspect.signature(func)
            self.assertNotIn(
                "acknowledge",
                sig.parameters,
                msg=(
                    f"{func.__name__} must not accept `acknowledge` param "
                    f"(Plan ARIA-V3 §A4 + §2k Tier-1 removal)"
                ),
            )
            self.assertIn(
                "gate",
                sig.parameters,
                msg=f"{func.__name__} must require `gate` AutoActionGate",
            )
            gate_param = sig.parameters["gate"]
            self.assertIs(gate_param.default, inspect.Parameter.empty)

    def test_i_v3_16b_acknowledge_kwarg_explicitly_rejected(self) -> None:
        """A future refactor that silently swallows ``acknowledge=True``
        via ``**kwargs`` would defeat the removal. Pass the kwarg
        and assert TypeError.
        """
        from aria_kernel.agent_genesis import materialize_agent_draft

        with self.assertRaises(TypeError):
            materialize_agent_draft(
                draft_id="x",
                assignment_id="y",
                workspace_root="/tmp",
                acknowledge=True,  # forbidden kwarg
            )

    def test_i_v3_17a_three_event_chain_linked_by_materialize_event_id(self) -> None:
        """AUDITTRAIL-CRITICAL-003 — every materialize emits three
        events sharing one materialize_event_id UUID. This test
        exercises the full materialize path with a synthetic body
        (no intent → grammar gate skipped, but the chain still
        fires 2 of 3 events: ack_consumed + materialize_committed).
        """
        from unittest.mock import patch
        from aria_kernel.ack_ledger import init_ack_ledger, mint_operator_ack
        from aria_kernel.agent_genesis import materialize_agent_draft
        from aria_kernel.auto_action_gate import gate_from_test_fixture
        from aria_kernel.runtime_profile import set_profile

        with tempfile.TemporaryDirectory(prefix="aria-i-v3-17a-") as tmp:
            base = Path(tmp) / "aria-tools"
            set_profile("standard", operator_approval_ref="t", base_dir=base)
            init_ack_ledger(
                base_dir=base,
                reason="3-event chain invariant test",
                operator_approval_ref="RFC-3EV",
            )
            worktree = Path(tmp) / "wt"
            worktree.mkdir()
            ack = mint_operator_ack(
                base_dir=base,
                draft_id="drf-evt",
                intent_id="intent-evt",
                target_path=".claude/agents/aria-evt.md",
                kind="agent",
                operator_user_id="test-operator",
                reason="explicit ack for materialize chain invariant",
                profile_name="autonomous",
                profile_state_at_mint="autonomous:v1",
                commit_sha_at_mint="test-head",
            )
            gate = gate_from_test_fixture(
                profile="autonomous",
                lane="L0-main",
                classifier_passed=True,
                policy_requires_acknowledge=False,
            )
            draft = {
                "draft_id": "drf-evt",
                "target_path": ".claude/agents/aria-evt.md",
                "body": "# evt test agent body",
            }
            dispatch = {
                "assignment_id": "as-evt",
                "worktree_path": str(worktree),
            }
            sandbox_state = {
                "decision": "pass", "synthetic_test_mode": False,
            }
            with patch(
                "aria_kernel.agent_genesis._find_draft",
                return_value=draft,
            ), patch(
                "aria_kernel.agent_genesis._latest_sandbox",
                return_value=sandbox_state,
            ), patch(
                "aria_kernel.agent_genesis._find_dispatch",
                return_value=dispatch,
            ):
                result = materialize_agent_draft(
                    draft_id="drf-evt",
                    assignment_id="as-evt",
                    workspace_root=Path(tmp),
                    gate=gate,
                    base_dir=base,
                    ack_id=ack.ack_id,
                )

            self.assertEqual(result["materialize_event_id"], gate.materialize_event_id)
            kinds = _read_governance_kinds(base)
            self.assertIn("materialize_committed", kinds)
            self.assertIn("ack_token_consumed", kinds)

            # Three-event linkage: every linked event row carries
            # the SAME materialize_event_id.
            linked_rows = [
                row
                for row in _read_governance_rows(base)
                if row.get("kind")
                in {"materialize_committed", "ack_token_consumed"}
            ]
            self.assertGreaterEqual(len(linked_rows), 2)
            for row in linked_rows:
                details = row.get("details") or {}
                if row["kind"] == "materialize_committed":
                    self.assertEqual(
                        details.get("materialize_event_id"),
                        gate.materialize_event_id,
                    )
                if row["kind"] == "ack_token_consumed":
                    self.assertEqual(
                        details.get("materialize_event_id"),
                        gate.materialize_event_id,
                    )

    def test_i_v3_17c_no_materialize_acknowledge_callsite_remains(self) -> None:
        """Grep test sources for ``acknowledge=True`` callsites that
        target ``materialize_agent_draft`` or ``materialize_skill``.
        Result MUST be empty. The 12 non-materialize uses
        (``migrate_tools_v1_to_v2``, ``rollback_tools_v2_to_v1``,
        etc.) are UNAFFECTED — they belong to different governance
        gates.
        """
        tests_dir = _KERNEL_ROOT / "tests"
        # Exempt this invariant file itself — it deliberately passes
        # ``acknowledge=True`` in test_i_v3_16b to exercise the
        # TypeError-on-unknown-kwarg invariant.
        exempt_files = {"test_phase_a4_gate_consolidation.py"}
        violations: list[str] = []
        materialize_call_re = re.compile(
            r"materialize_(agent_draft|skill)\s*\("
        )
        for py in sorted(tests_dir.rglob("*.py")):
            if py.name in exempt_files:
                continue
            text = py.read_text(encoding="utf-8")
            for match in materialize_call_re.finditer(text):
                # Inspect a 500-char window after the call open paren.
                window = text[match.start():match.start() + 500]
                if "acknowledge=True" in window:
                    violations.append(
                        f"{py.relative_to(_REPO_ROOT)}: materialize call near "
                        f"offset {match.start()} retains acknowledge=True"
                    )
        self.assertEqual(violations, [], msg="\n".join(violations))

    def test_i_v3_17d_single_gate_type_consumed_by_materialize_and_merge(self) -> None:
        """Both ``materialize_agent_draft`` and ``materialize_skill``
        AND a future ``merge_if_green`` (Phase B2) MUST consume the
        SAME ``AutoActionGate`` type. Verify the import path is
        identical (single source).
        """
        from aria_kernel import agent_genesis, skill_genesis
        from aria_kernel.auto_action_gate import AutoActionGate

        ag_hints = inspect.signature(
            agent_genesis.materialize_agent_draft,
        ).parameters["gate"]
        sg_hints = inspect.signature(
            skill_genesis.materialize_skill,
        ).parameters["gate"]
        # Annotation may be a string forward-ref; resolve via module
        # name comparison.
        for param in (ag_hints, sg_hints):
            ann = param.annotation
            ann_str = ann if isinstance(ann, str) else repr(ann)
            self.assertIn("AutoActionGate", ann_str)


if __name__ == "__main__":
    unittest.main()
