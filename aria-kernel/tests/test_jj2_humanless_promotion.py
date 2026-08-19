"""JJ-2 (ORPHAN-HIGH-732) — promotion without a human on the critical path.

Operator directive 2026-08-18: a human must be nowhere REQUIRED, and tool
promotion to ACTIVE becomes PANEL-APPROVED with a 24-hour operator VETO
window (not an operator approval). Two halves:

(a) readiness's ``operator_precision_unjudged`` blocker was, by its name and
    its mechanics, a request for a person. It is now satisfied by ANCHOR
    volume (JJ-1: judgments settled by >= 3 judges). An operator verdict
    still satisfies it — accepted, never required.

(b) ``promote_tool`` accepts a ``panel_approval_ref`` (a RESOLVED
    human-required adjudication, the Y7/Y8 vocabulary) and arms a 24h veto
    window instead of transitioning. A later cycle activates it if no veto
    arrived; a veto inside the window kills it. THE KERNEL-SCOPE EXCEPTION
    STAYS: an adapter scoped into aria-kernel/** still requires the
    operator, because promoting it is ARIA widening its authority over its
    own control plane.

Deliberate-breakage pins throughout: each asserts the NEW behaviour in a way
that fails if the behaviour is removed or quietly loosened.
"""
from __future__ import annotations

import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from unittest.mock import patch

from aria_kernel import cli
from aria_kernel.feedback_store import (
    ANCHOR_MIN_JUDGE_COUNT,
    ANCHOR_PROMOTION_MIN_JUDGMENTS,
    record_operator_feedback,
)
from aria_kernel.human_required import (
    OUTCOME_REFUSED,
    OUTCOME_RESOLVED,
    OUTCOME_STILL_ESCALATED,
    PANEL_DECIDED_OUTCOMES,
)
from aria_kernel.promotion import promote_tool
from aria_kernel.promotion_veto import (
    PENDING_STATUS,
    VETO_WINDOW_HOURS,
    PanelApprovalIneligibleError,
    compute_panel_approval_token,
    pending_promotion,
    settle_pending_promotions,
    tool_scope_touches_kernel,
    veto_promotion,
)
from aria_kernel.readiness import adapter_active_readiness
from aria_kernel.tool_registry import GovernanceError, get_tool, register_tool

_FAKE_RUNNER = Path(__file__).resolve().parent / "_helpers" / "fake_tool_runner.py"


def _adapter(tool_id: str, scope: list[str]) -> dict[str, Any]:
    return {
        "tool_id": tool_id,
        "kind": "adapter",
        "version": "1.0.0",
        "status": "SHADOW",
        "declared_scope": scope,
        "output_schema": {
            "type": "object",
            "required": ["observations", "findings", "read_paths", "evidence_sources"],
        },
        "fixture_set": f"fixtures/{tool_id}",
        "health_thresholds": {"precision_min": 0.85},
        "allowed_read_globs": scope,
        "forbidden_read_globs": ["dist/**"],
        "claim_types": ["schema_drift"],
        "owner": "platform",
        "runner": {
            "type": "subprocess",
            "argv": ["python3", _FAKE_RUNNER.as_posix()],
            "cwd": ".",
            "timeout_ms": 1000,
            "stdin_json": True,
        },
        "schema_version": 1,
    }


_GREEN_READINESS: dict[str, Any] = {
    "active_ready": True,
    "blocked_by": [],
    "zero_finding_lane": False,
    "precision": 0.97,
    "critical_false_positives": 0,
    "anchor_judged_count": ANCHOR_PROMOTION_MIN_JUDGMENTS,
}


# --------------------------------------------------------------------------
# (a) readiness: the blocker that used to require a person
# --------------------------------------------------------------------------
def _ok_run(run_id: str) -> dict[str, Any]:
    # The run_id is load-bearing: readiness joins anchor/operator volume to
    # the runs the registry actually recorded, so a run row without an id is
    # not evidence any judgment can be counted against.
    return {
        "run_id": run_id,
        "status": "ok",
        "evidence_validation": {"valid": True},
        "runner": {"raw_findings_count": 1},
        "recorded_at": datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat(),
    }


_FIXTURES_GREEN = {
    "current_tool_passed": True,
    "fixture_baseline_passed": True,
    "semantic_fixture_passed": True,
}
_METRICS = {
    "precision": 0.97,
    # Deliberately "unjudged": the old blocker read THIS string, so a test
    # that passes with it proves the gate no longer depends on it.
    "precision_status": "unjudged",
    "critical_false_positives": 0,
}


class AnchorPrecisionBlockerTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-jj2a-")
        self.tools = Path(self._tmp.name) / "aria-tools"
        register_tool(_adapter("jj2-adapter", ["apps/farm-service/src/**/*.ts"]), base_dir=self.tools)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _readiness(self) -> dict[str, Any]:
        recorded_runs = [_ok_run(f"run-{index}") for index in range(5)] + [_ok_run("run-h")]
        with patch("aria_kernel.readiness.read_runs_rows", return_value=iter(recorded_runs)), \
             patch("aria_kernel.readiness.runs_path", return_value=Path("unused-runs.jsonl")), \
             patch("aria_kernel.readiness.latest_fixture_status", return_value=dict(_FIXTURES_GREEN)), \
             patch("aria_kernel.readiness.compute_metrics", return_value=dict(_METRICS)):
            return adapter_active_readiness("jj2-adapter", base_dir=self.tools)

    def _consensus(self, index: int, judges: int, *, run_id: str | None = None) -> None:
        record_operator_feedback(
            tool_id="jj2-adapter",
            run_id=run_id or f"run-{index}",
            finding_id=f"F-{index}",
            verdict="true_positive",
            severity="medium",
            note="consensus",
            source_type="ai_consensus",
            judge_id="aria-consensus-arbiter",
            confidence=0.9,
            judgment_group_id=f"judge:jj2-adapter:F-{index}",
            finding_fingerprint=f"fp-{index}",
            judge_count=judges,
            judges_voted=judges,
            base_dir=self.tools,
        )

    def test_no_judgment_at_all_blocks(self) -> None:
        result = self._readiness()
        self.assertIn("precision_not_anchor_judged", result["blocked_by"])
        self.assertNotIn("operator_precision_unjudged", result["blocked_by"])

    def test_anchor_volume_satisfies_the_blocker_with_no_human(self) -> None:
        """The directive's core claim: the fleet can qualify itself."""
        for index in range(ANCHOR_PROMOTION_MIN_JUDGMENTS):
            self._consensus(index, ANCHOR_MIN_JUDGE_COUNT)
        result = self._readiness()
        self.assertEqual(result["anchor_judged_count"], ANCHOR_PROMOTION_MIN_JUDGMENTS)
        self.assertTrue(result["precision_anchored"])
        self.assertNotIn("precision_not_anchor_judged", result["blocked_by"])
        self.assertTrue(result["active_ready"], result["blocked_by"])

    def test_two_judge_volume_never_satisfies_it(self) -> None:
        """Deliberate breakage: the volume that used to qualify a tool for
        promotion (any number of agreeing pairs) now qualifies nothing."""
        for index in range(ANCHOR_PROMOTION_MIN_JUDGMENTS * 2):
            self._consensus(index, 2)
        result = self._readiness()
        self.assertEqual(result["anchor_judged_count"], 0)
        self.assertIn("precision_not_anchor_judged", result["blocked_by"])

    def test_one_operator_verdict_satisfies_it(self) -> None:
        """Accepted, never required: the operator still outranks the panel."""
        record_operator_feedback(
            tool_id="jj2-adapter", run_id="run-h", finding_id="F-h",
            verdict="true_positive", severity="medium", note="operator",
            source_type="human", judgment_group_id="judge:jj2-adapter:F-h",
            finding_fingerprint="fp-h", base_dir=self.tools,
        )
        result = self._readiness()
        self.assertEqual(result["operator_judged_count"], 1)
        self.assertNotIn("precision_not_anchor_judged", result["blocked_by"])

    def test_anchors_about_unrecorded_runs_qualify_nothing(self) -> None:
        """Deliberate breakage. The two key sets are folded off the feedback
        ledger and used to join nothing, so judgments naming a run_id the
        registry never recorded counted toward the gate that promotes an
        adapter to ACTIVE. Evidence about runs that never happened is not
        evidence."""
        for index in range(ANCHOR_PROMOTION_MIN_JUDGMENTS):
            self._consensus(index, ANCHOR_MIN_JUDGE_COUNT, run_id=f"ghost-{index}")
        result = self._readiness()
        self.assertEqual(result["anchor_judged_count"], 0)
        self.assertIn("precision_not_anchor_judged", result["blocked_by"])

    def test_short_of_the_anchor_floor_still_blocks(self) -> None:
        for index in range(ANCHOR_PROMOTION_MIN_JUDGMENTS - 1):
            self._consensus(index, ANCHOR_MIN_JUDGE_COUNT)
        self.assertIn("precision_not_anchor_judged", self._readiness()["blocked_by"])


# --------------------------------------------------------------------------
# (b) promotion: panel approval + 24h operator veto window
# --------------------------------------------------------------------------
def _panel_resolved_record(
    tools: Path, tool_id: str, ref: str, *, kind: str = "tool_promotion",
    outcome: str | None = OUTCOME_RESOLVED,
) -> str:
    """The adjudication a panel ref NAMES — built through the real surface.

    The pre-fix test hand-built ``{"context": {...}}`` dicts and asserted
    that "a forged panel ref cannot promote anything" while its own body
    demonstrated the opposite. A ref is now only as good as the record it
    resolves to, so the fixture has to make one.

    ``outcome`` (successor to the old ``resolve: bool``) is the panel's
    DECISION: ``OUTCOME_RESOLVED`` for an approval, ``OUTCOME_REFUSED`` for
    a refusal, ``None`` to leave the question open. The boolean could not
    express a refusal at all — an approval fixture and a refusal fixture
    came out byte-identical apart from an unread note — which is exactly
    the ambiguity that let a REFUSED ref promote an adapter.
    """
    from aria_kernel.human_required import (
        RESOLVED_BY_AGENT_PANEL,
        record_human_required,
        resolve_human_required,
    )

    record_human_required(
        request_id=ref, severity="MEDIUM",
        reason=f"adapter {tool_id!r} is promotion-ready",
        context={"kind": kind, "tool_id": tool_id},
        base_dir=tools,
    )
    if outcome is not None:
        note = (
            "promotion approved by independent agent panel (3/3 resolve)"
            if outcome == OUTCOME_RESOLVED else
            "promotion refused by independent agent panel (3/3 refuse)"
        )
        resolve_human_required(
            request_id=ref,
            resolution_note=note,
            resolved_by=RESOLVED_BY_AGENT_PANEL,
            panel_outcome=outcome,
            base_dir=tools,
        )
    return ref


class PanelPromotionVetoTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-jj2b-")
        self.tools = Path(self._tmp.name) / "aria-tools"
        register_tool(_adapter("jj2-product", ["apps/farm-service/src/**/*.ts"]), base_dir=self.tools)
        register_tool(_adapter("jj2-kernel", ["aria-kernel/aria_kernel/**/*.py"]), base_dir=self.tools)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _arm(
        self, tool_id: str = "jj2-product", ref: str = "promote-abc123",
        *, adjudicated: bool = True,
    ) -> dict[str, Any]:
        if adjudicated:
            _panel_resolved_record(self.tools, tool_id, ref)
        with patch("aria_kernel.promotion.latest_fixture_status", return_value={"current_tool_passed": True}), \
             patch("aria_kernel.promotion.adapter_active_readiness", return_value=dict(_GREEN_READINESS)):
            return promote_tool(
                tool_id, "ACTIVE",
                reason=f"panel approved promotion (adjudication {ref})",
                panel_approval_ref=ref, base_dir=self.tools,
            )

    def test_panel_ref_arms_the_window_and_does_not_activate(self) -> None:
        result = self._arm()
        self.assertEqual(result["status"], PENDING_STATUS)
        self.assertTrue(result["armed"])
        self.assertEqual(result["veto_window_hours"], VETO_WINDOW_HOURS)
        self.assertEqual(
            get_tool("jj2-product", self.tools)["status"], "SHADOW",
            "panel approval alone must never move the tool",
        )

    def test_arming_is_idempotent_so_the_clock_never_restarts(self) -> None:
        """Without this the cycle phase would re-arm every night and the
        promotion would be permanently 24 hours away."""
        first = self._arm()
        second = self._arm()
        self.assertFalse(second["armed"])
        self.assertEqual(second["veto_deadline"], first["veto_deadline"])

    def test_settle_leaves_the_tool_shadow_while_the_window_is_open(self) -> None:
        self._arm()
        result = settle_pending_promotions(cycle_id="cyc-1", base_dir=self.tools)
        self.assertEqual(result["activated"], [])
        self.assertEqual(result["still_pending"][0]["tool_id"], "jj2-product")
        self.assertEqual(get_tool("jj2-product", self.tools)["status"], "SHADOW")

    def test_veto_inside_the_window_kills_the_promotion(self) -> None:
        self._arm()
        veto_promotion(
            tool_id="jj2-product", reason="operator disagrees with the panel",
            operator_ref="op-1", base_dir=self.tools,
        )
        self.assertIsNone(pending_promotion(tool_id="jj2-product", base_dir=self.tools))
        with patch("aria_kernel.promotion_veto.VETO_WINDOW_HOURS", 0):
            result = settle_pending_promotions(cycle_id="cyc-2", base_dir=self.tools)
        self.assertEqual(result["activated"], [])
        self.assertEqual(get_tool("jj2-product", self.tools)["status"], "SHADOW")

    def test_veto_needs_a_live_pending_row(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "no_pending_promotion_to_veto"):
            veto_promotion(
                tool_id="jj2-product", reason="nothing to veto", base_dir=self.tools,
            )

    def test_expiry_activates_without_any_operator_action(self) -> None:
        """Silence is consent — the whole point of a veto window."""
        with patch("aria_kernel.promotion_veto.VETO_WINDOW_HOURS", 0):
            self._arm()
            with patch(
                "aria_kernel.readiness.adapter_active_readiness",
                return_value=dict(_GREEN_READINESS),
            ):
                result = settle_pending_promotions(cycle_id="cyc-3", base_dir=self.tools)
        self.assertEqual(result["activated"], ["jj2-product"])
        self.assertEqual(get_tool("jj2-product", self.tools)["status"], "ACTIVE")

    def test_activation_re_checks_readiness_at_settle_time(self) -> None:
        """24h is long enough for the adapter to crash or drift; activating on
        the arm-time picture would make the window a hole in the gate."""
        with patch("aria_kernel.promotion_veto.VETO_WINDOW_HOURS", 0):
            self._arm()
            with patch(
                "aria_kernel.readiness.adapter_active_readiness",
                return_value={**_GREEN_READINESS, "active_ready": False,
                              "blocked_by": ["last_5_runs_not_stable"]},
            ):
                result = settle_pending_promotions(cycle_id="cyc-4", base_dir=self.tools)
        self.assertEqual(result["activated"], [])
        self.assertIn("readiness_regressed", result["refused"][0]["reason"])
        self.assertEqual(get_tool("jj2-product", self.tools)["status"], "SHADOW")

    def test_kernel_scope_stays_operator_gated(self) -> None:
        """THE exception the directive preserves. Asserted at BOTH gates: the
        promote arm refuses, and the token mint refuses, so a caller cannot
        reach activation by skipping promote_tool."""
        self.assertTrue(tool_scope_touches_kernel(get_tool("jj2-kernel", self.tools)))
        with self.assertRaisesRegex(GovernanceError, "kernel_scope_promotion_requires_operator"):
            self._arm(tool_id="jj2-kernel", ref="promote-kernel")
        with self.assertRaises(PanelApprovalIneligibleError) as ctx:
            compute_panel_approval_token(tool_id="jj2-kernel", base_dir=self.tools)
        self.assertIn("kernel_scope_promotion_requires_operator", str(ctx.exception))

    def test_kernel_scope_detected_through_read_globs_too(self) -> None:
        """A narrow declared_scope with a wide read allowance is still
        kernel-scoped in the only sense that matters at runtime."""
        self.assertTrue(tool_scope_touches_kernel({
            "declared_scope": ["apps/**"],
            "allowed_read_globs": ["aria-kernel/aria_kernel/**/*.py"],
        }))

    def test_kernel_scope_survives_ordinary_glob_spellings(self) -> None:
        """Deliberate breakage. The exception used to be a text-prefix match
        (`glob.startswith("aria-kernel")`), which every one of these spellings
        walks straight past while granting kernel reads at runtime. It is now
        the same five-tier evaluator the sandbox uses, so the carve-out cannot
        be defeated by how a manifest spells its scope."""
        for scope in (["**"], ["**/*.py"], ["./**"], ["{apps,aria-kernel}/**"]):
            with self.subTest(scope=scope):
                self.assertTrue(
                    tool_scope_touches_kernel({"allowed_read_globs": scope}),
                    f"{scope} grants kernel reads and must stay operator-gated",
                )
        # A tool with no allow list at all is permissive by the evaluator's
        # legacy tier — fail-closed, it stays with the operator too.
        self.assertTrue(tool_scope_touches_kernel({}))
        # And the product adapter is still NOT kernel-scoped: this gate has
        # to keep letting the humanless lane work.
        self.assertFalse(
            tool_scope_touches_kernel(get_tool("jj2-product", self.tools)),
        )

    def test_a_kernel_glob_spelling_cannot_arm_a_window(self) -> None:
        """The predicate is only worth what the gate does with it."""
        register_tool(_adapter("jj2-wide", ["**/*.py"]), base_dir=self.tools)
        with self.assertRaisesRegex(
            GovernanceError, "kernel_scope_promotion_requires_operator",
        ):
            self._arm(tool_id="jj2-wide", ref="promote-wide")

    def test_token_refuses_while_the_window_is_open(self) -> None:
        self._arm()
        with self.assertRaises(PanelApprovalIneligibleError) as ctx:
            compute_panel_approval_token(tool_id="jj2-product", base_dir=self.tools)
        self.assertIn("veto_window_open", str(ctx.exception))

    def test_token_is_minted_once_the_deadline_passes(self) -> None:
        armed = self._arm()
        deadline = datetime.strptime(
            armed["veto_deadline"], "%Y-%m-%dT%H:%M:%SZ",
        ).replace(tzinfo=timezone.utc)
        token = compute_panel_approval_token(
            tool_id="jj2-product", base_dir=self.tools,
            now=deadline + timedelta(seconds=1),
        )
        self.assertEqual(len(token), 64)

    def test_no_pending_row_means_no_token(self) -> None:
        with self.assertRaises(PanelApprovalIneligibleError) as ctx:
            compute_panel_approval_token(tool_id="jj2-product", base_dir=self.tools)
        self.assertIn("no_pending_promotion", str(ctx.exception))

    def test_veto_cli_verb_exists_and_routes(self) -> None:
        self._arm()
        exit_code = cli.main([
            "tool", "veto-promotion",
            "--tool-id", "jj2-product",
            "--tools-dir", str(self.tools),
            "--reason", "operator vetoes this promotion after review",
        ])
        self.assertEqual(exit_code, 0)
        self.assertIsNone(pending_promotion(tool_id="jj2-product", base_dir=self.tools))


# --------------------------------------------------------------------------
# (c) the producer chain: without it the panel authority is dead wire (i2)
# --------------------------------------------------------------------------
class PanelRefIsResolvedNotAssertedTests(unittest.TestCase):
    """The reviewer's CRITICAL #2, as executed pins.

    ``promotion_veto.record_pending_promotion`` used to check only that the
    panel ref was a non-empty STRING, and nothing downstream resolved it:
    ``promote_tool(..., panel_approval_ref="promote-i-invented-this-ref")``
    armed a veto window on a workspace with no ``human-required/`` directory
    at all, and the next settle activated the adapter with a governance row
    saying "panel approved". The ref is a claim about an adjudication that
    either happened or did not.
    """

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-jj2ref-")
        self.tools = Path(self._tmp.name) / "aria-tools"
        register_tool(_adapter("jj2-product", ["apps/farm-service/src/**/*.ts"]), base_dir=self.tools)
        register_tool(_adapter("jj2-other", ["apps/hr-service/src/**/*.ts"]), base_dir=self.tools)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _promote(self, ref: str, tool_id: str = "jj2-product") -> dict[str, Any]:
        with patch("aria_kernel.promotion.latest_fixture_status", return_value={"current_tool_passed": True}), \
             patch("aria_kernel.promotion.adapter_active_readiness", return_value=dict(_GREEN_READINESS)):
            return promote_tool(
                tool_id, "ACTIVE", reason=f"panel approved promotion ({ref})",
                panel_approval_ref=ref, base_dir=self.tools,
            )

    def test_an_invented_ref_arms_nothing_and_activates_nothing(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "adjudication_not_found"):
            self._promote("promote-i-invented-this-ref")
        self.assertFalse((self.tools / "human-required").exists())
        self.assertIsNone(pending_promotion(tool_id="jj2-product", base_dir=self.tools))
        with patch("aria_kernel.promotion_veto.VETO_WINDOW_HOURS", 0):
            settled = settle_pending_promotions(cycle_id="cyc-x", base_dir=self.tools)
        self.assertEqual(settled["activated"], [])
        self.assertEqual(get_tool("jj2-product", self.tools)["status"], "SHADOW")

    def test_an_empty_ref_is_still_refused(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "requires_adjudication_ref"):
            from aria_kernel.promotion_veto import record_pending_promotion

            record_pending_promotion(
                tool_id="jj2-product", panel_approval_ref="   ",
                reason="blank", readiness=dict(_GREEN_READINESS),
                base_dir=self.tools,
            )

    def test_an_open_record_is_not_an_approval(self) -> None:
        """A panel question that was ASKED is not a panel question that was
        ANSWERED."""
        _panel_resolved_record(
            self.tools, "jj2-product", "promote-open", outcome=None,
        )
        with self.assertRaisesRegex(GovernanceError, "not_panel_resolved"):
            self._promote("promote-open")

    def test_an_operator_resolved_record_is_not_a_panel_approval(self) -> None:
        """The panel authority is the panel's. An operator who wants to
        promote has his own ref (`operator_approval_ref`); resolving an
        escalation is a different act from vouching for a promotion."""
        from aria_kernel.human_required import (
            record_human_required,
            resolve_human_required,
        )

        record_human_required(
            request_id="promote-op", severity="MEDIUM", reason="ready",
            context={"kind": "tool_promotion", "tool_id": "jj2-product"},
            base_dir=self.tools,
        )
        resolve_human_required(
            request_id="promote-op", resolution_note="operator closed this",
            base_dir=self.tools,
        )
        with self.assertRaisesRegex(GovernanceError, "not_panel_resolved"):
            self._promote("promote-op")

    def test_a_panel_refusal_is_never_a_panel_approval(self) -> None:
        """The panel ANSWERED — with "no".

        Approval and refusal both close the record (a closed record is what
        stops the sweep re-asking every night), so before the decision was
        stamped the two were the same row on disk apart from an unread
        ``resolution_note``. Replaying the refused ref armed the window and
        the next settle activated the adapter the panel had just rejected.
        """
        _panel_resolved_record(
            self.tools, "jj2-product", "promote-refused", outcome=OUTCOME_REFUSED,
        )
        with self.assertRaisesRegex(GovernanceError, "not_approved:panel_outcome='refused'"):
            self._promote("promote-refused")
        self.assertIsNone(pending_promotion(tool_id="jj2-product", base_dir=self.tools))
        with patch("aria_kernel.promotion_veto.VETO_WINDOW_HOURS", 0):
            settled = settle_pending_promotions(cycle_id="cyc-refused", base_dir=self.tools)
        self.assertEqual(settled["activated"], [])
        self.assertEqual(get_tool("jj2-product", self.tools)["status"], "SHADOW")

    def test_a_pre_decision_record_cannot_prove_an_approval(self) -> None:
        """Fail-closed on records written before the decision was recorded.

        A record whose ``panel_outcome`` is absent never stated what the
        panel answered, so reading it as an approval would be an assumption
        — the one thing this resolver exists to refuse. Written by hand
        because the kernel can no longer produce such a record at all.
        """
        import json

        from aria_kernel.human_required import record_human_required

        record_human_required(
            request_id="promote-legacy", severity="MEDIUM", reason="ready",
            context={"kind": "tool_promotion", "tool_id": "jj2-product"},
            base_dir=self.tools,
        )
        path = self.tools / "human-required" / "promote-legacy.json"
        legacy = json.loads(path.read_text(encoding="utf-8"))
        legacy.update({
            "status": "resolved",
            "resolved_by": "agent_panel",
            "resolved_at": "2026-08-18T00:00:00Z",
            "resolution_note": "promotion approved by independent agent panel",
        })
        path.write_text(json.dumps(legacy, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        with self.assertRaisesRegex(GovernanceError, "not_approved:panel_outcome=''"):
            self._promote("promote-legacy")
        self.assertEqual(get_tool("jj2-product", self.tools)["status"], "SHADOW")

    def test_the_proof_carries_the_decision_it_verified(self) -> None:
        """The proof is what the pending row and the mint audit against, so
        it has to say WHICH answer it checked, not merely that it checked."""
        from aria_kernel.promotion_veto import resolve_panel_approval

        _panel_resolved_record(self.tools, "jj2-product", "promote-proof")
        proof = resolve_panel_approval(
            tool_id="jj2-product", panel_approval_ref="promote-proof",
            base_dir=self.tools,
        )
        self.assertEqual(proof["panel_outcome"], OUTCOME_RESOLVED)

    def test_a_real_approval_for_another_tool_cannot_be_replayed(self) -> None:
        _panel_resolved_record(self.tools, "jj2-other", "promote-other")
        with self.assertRaisesRegex(GovernanceError, "tool_id_mismatch"):
            self._promote("promote-other", tool_id="jj2-product")

    def test_a_wrong_kind_record_is_not_a_promotion_approval(self) -> None:
        """The kernel-scope queue item is `tool_promotion_kernel_scope`, a
        kind the panel may not adjudicate — it must not double as one."""
        _panel_resolved_record(
            self.tools, "jj2-product", "promote-kernelkind",
            kind="tool_promotion_kernel_scope",
        )
        with self.assertRaisesRegex(GovernanceError, "wrong_kind"):
            self._promote("promote-kernelkind")

    def test_a_real_approval_arms_and_settles(self) -> None:
        """The humanless lane still works end to end — the gate refuses
        forgeries, not promotions."""
        _panel_resolved_record(self.tools, "jj2-product", "promote-real")
        with patch("aria_kernel.promotion_veto.VETO_WINDOW_HOURS", 0):
            armed = self._promote("promote-real")
            self.assertTrue(armed["armed"])
            with patch(
                "aria_kernel.readiness.adapter_active_readiness",
                return_value=dict(_GREEN_READINESS),
            ):
                settled = settle_pending_promotions(
                    cycle_id="cyc-real", base_dir=self.tools,
                )
        self.assertEqual(settled["activated"], ["jj2-product"])
        self.assertEqual(get_tool("jj2-product", self.tools)["status"], "ACTIVE")

    def test_the_token_re_resolves_the_ref_at_mint_time(self) -> None:
        """compute_panel_approval_token promises every legitimacy gate is
        checked at mint. An adjudication re-opened after arming (the fold's
        own failure path does exactly that) must not still activate."""
        import json

        from aria_kernel.human_required import _human_required_path

        _panel_resolved_record(self.tools, "jj2-product", "promote-reopened")
        with patch("aria_kernel.promotion_veto.VETO_WINDOW_HOURS", 0):
            self._promote("promote-reopened")
            path = _human_required_path(self.tools, "promote-reopened")
            record = json.loads(path.read_text(encoding="utf-8"))
            record["status"] = "open"
            path.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8")
            with self.assertRaises(PanelApprovalIneligibleError) as ctx:
                compute_panel_approval_token(
                    tool_id="jj2-product", base_dir=self.tools,
                )
            self.assertIn("not_panel_resolved", str(ctx.exception))
            settled = settle_pending_promotions(cycle_id="cyc-r", base_dir=self.tools)
        self.assertEqual(settled["activated"], [])
        self.assertIn("not_panel_resolved", settled["refused"][0]["reason"])
        self.assertEqual(get_tool("jj2-product", self.tools)["status"], "SHADOW")

    def test_the_token_re_resolves_the_decision_not_just_the_status(self) -> None:
        """The mint checks WHICH answer, not only that one exists.

        Sibling of the test above: there the record was re-opened, here it
        still says a panel resolved it and only the decision changed. An
        armed window whose adjudication no longer approves must mint
        nothing — otherwise the 24 hours of silence would consent to a
        decision that is no longer the panel's.
        """
        import json

        from aria_kernel.human_required import _human_required_path

        _panel_resolved_record(self.tools, "jj2-product", "promote-flipped")
        with patch("aria_kernel.promotion_veto.VETO_WINDOW_HOURS", 0):
            self._promote("promote-flipped")
            path = _human_required_path(self.tools, "promote-flipped")
            record = json.loads(path.read_text(encoding="utf-8"))
            record["panel_outcome"] = OUTCOME_REFUSED
            path.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8")
            with self.assertRaises(PanelApprovalIneligibleError) as ctx:
                compute_panel_approval_token(
                    tool_id="jj2-product", base_dir=self.tools,
                )
            self.assertIn("not_approved", str(ctx.exception))
            settled = settle_pending_promotions(cycle_id="cyc-f", base_dir=self.tools)
        self.assertEqual(settled["activated"], [])
        self.assertIn("not_approved", settled["refused"][0]["reason"])
        self.assertEqual(get_tool("jj2-product", self.tools)["status"], "SHADOW")

    def test_a_pending_promotion_expires_instead_of_waiting_forever(self) -> None:
        """A promotion the settle loop kept refusing (regressed readiness)
        used to stay armed indefinitely and activate silently the day
        readiness returned — on a panel decision and a veto window that both
        elapsed long ago."""
        from aria_kernel.governance_reader import read_governance_rows
        from aria_kernel.promotion_veto import (
            EXPIRED_KIND,
            PENDING_MAX_AGE_HOURS,
        )

        _panel_resolved_record(self.tools, "jj2-product", "promote-stale")
        with patch("aria_kernel.promotion_veto.VETO_WINDOW_HOURS", -PENDING_MAX_AGE_HOURS - 1):
            self._promote("promote-stale")
            with patch(
                "aria_kernel.readiness.adapter_active_readiness",
                return_value=dict(_GREEN_READINESS),
            ):
                settled = settle_pending_promotions(
                    cycle_id="cyc-stale", base_dir=self.tools,
                )
        self.assertEqual(settled["activated"], [])
        self.assertEqual(settled["expired"][0]["tool_id"], "jj2-product")
        self.assertEqual(get_tool("jj2-product", self.tools)["status"], "SHADOW")
        # The expiry is a governance event, and it kills the pending row so a
        # later cycle cannot resurrect the elapsed approval.
        self.assertIsNone(pending_promotion(tool_id="jj2-product", base_dir=self.tools))
        kinds = [
            row.get("kind")
            for row in read_governance_rows(
                self.tools / "governance.jsonl", base_dir=self.tools,
            )
        ]
        self.assertIn(EXPIRED_KIND, kinds)


class PromotionPanelProducerTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-jj2c-")
        self.tools = Path(self._tmp.name) / "aria-tools"
        register_tool(_adapter("jj2-product", ["apps/farm-service/src/**/*.ts"]), base_dir=self.tools)
        register_tool(_adapter("jj2-kernel", ["aria-kernel/aria_kernel/**/*.py"]), base_dir=self.tools)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _sweep(self, readiness: dict[str, Any] | None = None) -> dict[str, Any]:
        from aria_kernel.promotion_panel import (
            sweep_promotable_adapters_for_adjudication,
        )

        with patch(
            "aria_kernel.readiness.adapter_active_readiness",
            return_value={**_GREEN_READINESS, **(readiness or {})},
        ):
            return sweep_promotable_adapters_for_adjudication(
                base_dir=self.tools, cycle_id="cyc-1",
            )

    def test_ready_adapter_becomes_one_panel_question(self) -> None:
        result = self._sweep()
        opened = {row["tool_id"]: row["escalation_id"] for row in result["opened"]}
        self.assertIn("jj2-product", opened)
        # Idempotent: one panel question per adapter, ever. A re-ask after a
        # refusal is the decision-questioning lane's act, not the sweep's.
        again = self._sweep()
        self.assertEqual(again["opened"], [])
        self.assertIn(
            "already_escalated",
            [row["reason"] for row in again["skipped"]],
        )

    def test_unready_adapter_is_not_asked_about(self) -> None:
        result = self._sweep({"active_ready": False, "blocked_by": ["stale_run_evidence"]})
        self.assertEqual(result["opened"], [])

    def test_kernel_scoped_adapter_lands_in_the_operator_queue(self) -> None:
        """It IS escalated — positively, as a record that waits — but under a
        context kind the panel is structurally forbidden to clear."""
        import json

        from aria_kernel import human_required_adjudication as hra
        from aria_kernel.human_required import _human_required_path
        from aria_kernel.promotion_panel import KERNEL_SCOPE_CONTEXT_KIND

        result = self._sweep()
        escalation = next(
            row["escalation_id"] for row in result["opened"] if row["tool_id"] == "jj2-kernel"
        )
        record = json.loads(
            _human_required_path(self.tools, escalation).read_text(encoding="utf-8"),
        )
        self.assertEqual(record["context"]["kind"], KERNEL_SCOPE_CONTEXT_KIND)
        self.assertNotIn(KERNEL_SCOPE_CONTEXT_KIND, hra.ADJUDICABLE_CONTEXT_KINDS)
        verdict = hra.escalation_adjudicability(record)
        self.assertFalse(verdict.adjudicable)
        self.assertIn("context_kind_not_admitted", verdict.reason)

    def test_promotion_context_is_panel_adjudicable_but_needs_its_subject(self) -> None:
        from aria_kernel import human_required_adjudication as hra
        from aria_kernel.promotion_panel import PROMOTION_CONTEXT_KIND

        self.assertIn(PROMOTION_CONTEXT_KIND, hra.ADJUDICABLE_CONTEXT_KINDS)
        blind = hra.escalation_adjudicability({"context": {"kind": PROMOTION_CONTEXT_KIND}})
        self.assertFalse(blind.adjudicable)
        self.assertEqual(blind.reason, "tool_promotion_missing:tool_id")

    def test_panel_approval_executor_arms_the_window(self) -> None:
        """The fold hands the executor the record it just cleared — and the
        executor does not take its word for it: the ref is resolved back to
        that record before anything is armed."""
        from aria_kernel.promotion_panel import (
            execute_tool_promotion_panel_approval,
        )

        ref = _panel_resolved_record(self.tools, "jj2-product", "promote-deadbeef")
        with patch("aria_kernel.promotion.latest_fixture_status", return_value={"current_tool_passed": True}), \
             patch("aria_kernel.promotion.adapter_active_readiness", return_value=dict(_GREEN_READINESS)):
            result = execute_tool_promotion_panel_approval(
                escalation_id=ref,
                record={"context": {"kind": "tool_promotion", "tool_id": "jj2-product"}},
                base_dir=self.tools,
            )
        self.assertEqual(result["status"], PENDING_STATUS)
        self.assertEqual(result["panel_approval_ref"], "promote-deadbeef")
        self.assertEqual(get_tool("jj2-product", self.tools)["status"], "SHADOW")

    def test_a_hand_built_record_arms_nothing(self) -> None:
        """The pre-fix version of the test above passed a record dict that no
        panel had ever adjudicated, and the executor armed a veto window from
        it. Same call, same dict, no record on disk: refused."""
        from aria_kernel.promotion_panel import (
            execute_tool_promotion_panel_approval,
        )

        with patch("aria_kernel.promotion.latest_fixture_status", return_value={"current_tool_passed": True}), \
             patch("aria_kernel.promotion.adapter_active_readiness", return_value=dict(_GREEN_READINESS)), \
             self.assertRaisesRegex(GovernanceError, "adjudication_not_found"):
            execute_tool_promotion_panel_approval(
                escalation_id="promote-never-adjudicated",
                record={"context": {"kind": "tool_promotion", "tool_id": "jj2-product"}},
                base_dir=self.tools,
            )
        self.assertIsNone(pending_promotion(tool_id="jj2-product", base_dir=self.tools))
        self.assertEqual(get_tool("jj2-product", self.tools)["status"], "SHADOW")


# --------------------------------------------------------------------------
# (d) the decision itself: an adjudication that happened is not an
#     adjudication that said yes
# --------------------------------------------------------------------------
def _drive_real_panel(tools: Path, escalation_id: str, verdict_value: str) -> Any:
    """Run the ACTUAL three-agent panel to a quorum and fold it.

    Deliberately not a hand-built record: the defect this class pins was
    invisible to every fixture that wrote its own resolved record, because
    the fixture author chose the fields and never chose a refusal.
    """
    import json

    from aria_kernel import human_required_adjudication as hra
    from aria_kernel.ledger import append_declared_jsonl

    record = json.loads(
        (tools / "human-required" / f"{escalation_id}.json").read_text(encoding="utf-8"),
    )
    row = hra.open_adjudication(
        escalation_request_id=escalation_id, record=record, base_dir=tools,
    )
    invocations = tools / "agent-invocations"
    invocations.mkdir(parents=True, exist_ok=True)
    for rid, agent in zip(row["request_ids"], ("judge-a", "judge-b", "judge-c")):
        output = invocations / f"{rid}.opinion.json"
        output.write_text(
            json.dumps({"verdict": verdict_value, "rationale": agent}), encoding="utf-8",
        )
        append_declared_jsonl(
            invocations / "claims.jsonl",
            {"request_id": rid, "claim_id": f"claim-{rid}", "agent_id": agent},
            expected_surface="agent_invocation_claims",
        )
        append_declared_jsonl(
            invocations / "results.jsonl",
            {"request_id": rid, "role": hra.ADJUDICATION_ROLE, "status": "accepted",
             "agent_id": agent, "output_path": output.as_posix(),
             "output_hash": "sha256:" + "0" * 64},
            expected_surface="agent_invocation_results",
        )
    return hra.adjudicate_human_required(
        escalation_request_id=escalation_id, base_dir=tools,
    )


class PanelDecisionIsRecordedNotInferredTests(unittest.TestCase):
    """A panel refusal must never be readable as a panel approval.

    Both answers CLOSE the record — that is deliberate, a closed record is
    what stops the nightly sweep re-asking a settled question. The
    consequence was that ``status=resolved, resolved_by=agent_panel`` proved
    only that the panel had ANSWERED, and the shared proof resolver read
    that as "approved". Driving the real 3/3 refuse quorum and replaying its
    ref through ``promote_tool`` activated the adapter the panel had just
    rejected.
    """

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-jj2dec-")
        self.tools = Path(self._tmp.name) / "aria-tools"
        register_tool(_adapter("jj2-product", ["apps/farm-service/src/**/*.ts"]), base_dir=self.tools)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _escalate(self) -> str:
        from aria_kernel.human_required import record_human_required
        from aria_kernel.promotion_panel import PROMOTION_CONTEXT_KIND, _escalation_id

        escalation_id = _escalation_id("jj2-product")
        record_human_required(
            request_id=escalation_id, severity="MEDIUM",
            reason="adapter 'jj2-product' is promotion-ready",
            context={
                "kind": PROMOTION_CONTEXT_KIND, "tool_id": "jj2-product",
                "precision": 0.97, "anchor_judged_count": 5,
                "evidence_refs": ["aria-tools/runs.jsonl#jj2-product"],
                "cycle_id": "cyc-1",
            },
            base_dir=self.tools,
        )
        return escalation_id

    def _record(self, escalation_id: str) -> dict[str, Any]:
        import json

        return json.loads(
            (self.tools / "human-required" / f"{escalation_id}.json").read_text(
                encoding="utf-8",
            ),
        )

    def test_a_real_refuse_quorum_promotes_nothing_even_when_replayed(self) -> None:
        from aria_kernel import human_required_adjudication as hra

        escalation_id = self._escalate()
        verdict = _drive_real_panel(self.tools, escalation_id, hra.REFUSE_VERDICT)
        self.assertEqual(verdict.outcome, OUTCOME_REFUSED)
        self.assertEqual(self._record(escalation_id)["panel_outcome"], OUTCOME_REFUSED)
        self.assertEqual(get_tool("jj2-product", self.tools)["status"], "SHADOW")

        with patch("aria_kernel.promotion.latest_fixture_status", return_value={"current_tool_passed": True}), \
             patch("aria_kernel.promotion.adapter_active_readiness", return_value=dict(_GREEN_READINESS)), \
             patch("aria_kernel.promotion_veto.VETO_WINDOW_HOURS", 0), \
             self.assertRaisesRegex(GovernanceError, "not_approved"):
            promote_tool(
                "jj2-product", "ACTIVE",
                reason="replaying the panel's REFUSAL as an approval",
                panel_approval_ref=escalation_id, base_dir=self.tools,
            )
        self.assertIsNone(pending_promotion(tool_id="jj2-product", base_dir=self.tools))
        with patch("aria_kernel.promotion_veto.VETO_WINDOW_HOURS", 0), \
             patch("aria_kernel.readiness.adapter_active_readiness", return_value=dict(_GREEN_READINESS)):
            settled = settle_pending_promotions(cycle_id="cyc-2", base_dir=self.tools)
        self.assertEqual(settled["activated"], [])
        self.assertEqual(get_tool("jj2-product", self.tools)["status"], "SHADOW")

    def test_a_real_resolve_quorum_still_arms_the_window(self) -> None:
        """The positive twin — the gate refuses refusals, not promotions."""
        from aria_kernel import human_required_adjudication as hra

        escalation_id = self._escalate()
        with patch("aria_kernel.promotion.latest_fixture_status", return_value={"current_tool_passed": True}), \
             patch("aria_kernel.promotion.adapter_active_readiness", return_value=dict(_GREEN_READINESS)):
            verdict = _drive_real_panel(self.tools, escalation_id, hra.RESOLVE_VERDICT)
        self.assertEqual(verdict.outcome, OUTCOME_RESOLVED)
        self.assertEqual(self._record(escalation_id)["panel_outcome"], OUTCOME_RESOLVED)
        pending = pending_promotion(tool_id="jj2-product", base_dir=self.tools)
        self.assertIsNotNone(pending)
        self.assertEqual(pending["panel_approval_ref"], escalation_id)
        # Still SHADOW: approval ARMS the veto window, it does not activate.
        self.assertEqual(get_tool("jj2-product", self.tools)["status"], "SHADOW")

    def test_a_panel_cannot_close_a_record_without_stating_its_decision(self) -> None:
        from aria_kernel.human_required import (
            RESOLVED_BY_AGENT_PANEL,
            resolve_human_required,
        )

        escalation_id = self._escalate()
        with self.assertRaisesRegex(
            GovernanceError, "agent_panel_resolution_requires_decided_outcome",
        ):
            resolve_human_required(
                request_id=escalation_id,
                resolution_note="a panel answered, but not what it answered",
                resolved_by=RESOLVED_BY_AGENT_PANEL,
                base_dir=self.tools,
            )
        self.assertEqual(self._record(escalation_id)["status"], "open")

    def test_an_undecided_outcome_cannot_close_a_record(self) -> None:
        """``still_escalated`` is the panel failing to answer. Closing a
        record with it would file a decision nobody reached."""
        from aria_kernel.human_required import (
            RESOLVED_BY_AGENT_PANEL,
            resolve_human_required,
        )

        escalation_id = self._escalate()
        self.assertNotIn(OUTCOME_STILL_ESCALATED, PANEL_DECIDED_OUTCOMES)
        with self.assertRaisesRegex(
            GovernanceError, "agent_panel_resolution_requires_decided_outcome",
        ):
            resolve_human_required(
                request_id=escalation_id, resolution_note="panel could not tell",
                resolved_by=RESOLVED_BY_AGENT_PANEL,
                panel_outcome=OUTCOME_STILL_ESCALATED, base_dir=self.tools,
            )
        self.assertEqual(self._record(escalation_id)["status"], "open")

    def test_an_operator_does_not_report_a_panel_outcome(self) -> None:
        """Two claims of authority in one row is one too many: the operator
        closing an escalation exercises his own authority, and a record that
        also carried a panel decision would let an operator close double as
        a panel approval."""
        from aria_kernel.human_required import resolve_human_required

        escalation_id = self._escalate()
        with self.assertRaisesRegex(
            GovernanceError, "panel_outcome_requires_agent_panel_resolver",
        ):
            resolve_human_required(
                request_id=escalation_id, resolution_note="operator closed this",
                panel_outcome=OUTCOME_RESOLVED, base_dir=self.tools,
            )
        self.assertEqual(self._record(escalation_id)["status"], "open")

    def test_the_audit_row_distinguishes_approval_from_refusal(self) -> None:
        """The governance ledger recorded both answers as one
        ``human_required_resolved`` row, so an auditor could not tell a
        rejected promotion from an approved one either."""
        from aria_kernel import human_required_adjudication as hra
        from aria_kernel.governance_reader import read_governance_rows
        from aria_kernel.promotion_veto import _governance_path

        escalation_id = self._escalate()
        _drive_real_panel(self.tools, escalation_id, hra.REFUSE_VERDICT)
        rows = [
            r for r in read_governance_rows(
                _governance_path(self.tools), base_dir=self.tools,
            )
            if r.get("kind") == "human_required_resolved"
        ]
        self.assertEqual(
            [(r.get("details") or {}).get("panel_outcome") for r in rows],
            [OUTCOME_REFUSED],
        )


class CycleWiringPins(unittest.TestCase):
    """A mechanism with no caller is the defect this kernel keeps re-finding.
    These pin the two lanes to the EXISTING phases they were folded into —
    no new phase was added for either (the task's explicit constraint)."""

    def test_anchor_mint_runs_in_the_judgment_pipeline(self) -> None:
        import inspect

        from aria_kernel import cycle

        src = inspect.getsource(cycle._phase_judgment_pipeline)
        self.assertIn("dispatch_arbiter_for_anchor_groups(", src)

    def test_panel_fold_routes_a_promotion_resolve_to_the_executor(self) -> None:
        """The last link of the humanless chain. Without this arm the panel
        can clear a promotion escalation and NOTHING happens — a resolved
        record and a tool that stays SHADOW forever, which is the "filed, not
        recovered" failure Y7 already had to fix once."""
        import inspect

        from aria_kernel import human_required_adjudication as hra

        src = inspect.getsource(hra.adjudicate_human_required)
        self.assertIn('kind == "tool_promotion"', src)
        self.assertIn("execute_tool_promotion_panel_approval(", src)
        # A refuse quorum must CLOSE the question, not leave it re-asked
        # every night by the sweep.
        self.assertIn("promotion refused by independent agent panel", src)

    def test_veto_settlement_reuses_the_tool_lifecycle_phase(self) -> None:
        """Behavioural, not a source grep: the phase is RUN and the two lanes
        are observed being called, in order. A substring pin over
        ``inspect.getsource`` passes on code behind ``if False:`` and fails on
        a pure rename — it pins the text, not the wiring."""
        from aria_kernel import cycle

        calls: list[str] = []

        def _settle(**kwargs: Any) -> dict[str, Any]:
            calls.append("settle")
            return {"activated": [], "still_pending": [], "refused": [], "expired": []}

        def _sweep(**kwargs: Any) -> dict[str, Any]:
            calls.append("sweep")
            return {"status": "ok", "opened": [], "skipped": []}

        with tempfile.TemporaryDirectory(prefix="aria-jj2-phase-") as tmp:
            context = cycle.build_phase_context(
                cycle_id="cyc-wiring",
                workspace_root=Path(tmp),
                base_dir=Path(tmp) / "aria-tools",
            )
            with patch("aria_kernel.promotion_veto.settle_pending_promotions", _settle), \
                 patch(
                     "aria_kernel.promotion_panel.sweep_promotable_adapters_for_adjudication",
                     _sweep,
                 ):
                result = cycle._phase_tool_manifest_sync(context)
        # Order is load-bearing: settle BEFORE sweep, so a tool activated on
        # this tick is not asked about on the same tick.
        self.assertEqual(calls, ["settle", "sweep"])
        self.assertIn("promotions_activated", result)
        self.assertIn("promotions_expired", result)
        # And no phase of its own was added for either lane (the task's
        # explicit constraint): the promotion lane rides the phase that
        # already owns tool lifecycle.
        phase_names = [phase.name for phase in cycle.CYCLE_PHASES]
        self.assertIn("tool_manifest_sync", phase_names)
        self.assertEqual([n for n in phase_names if "promotion" in n], [])


if __name__ == "__main__":
    unittest.main()
