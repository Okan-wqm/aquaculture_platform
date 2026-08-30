"""Tests for the Plan 016 Faz C1 agent_contract schema layer."""
from __future__ import annotations

import unittest

from aria_kernel.agent_contract import (
    DEFAULT_TARGET_AGENT_WHITELIST,
    REQUEST_ROLES,
    REQUEST_SCHEMA,
    RESPONSE_SCHEMA,
    ROLE_TARGET_PAIRING,
    enforce_separation_of_duties,
    envelope_hash,
    render_refusal,
    validate_request,
    validate_response,
)
from aria_kernel.tool_registry import GovernanceError


def _good_request(**overrides):
    base = {
        "$schema": REQUEST_SCHEMA,
        "request_id": "req-2026-05-07-001",
        "cycle_id": "aria-20260507T000000Z",
        "role": "primary_plan",
        "target_agent": "aria-primary-planner",
        "evidence_refs": ["docs/aria/SPEC.md:53"],
        "allowed_scope": ["aria-kernel/**"],
        "forbidden_scope": ["aria-tools/**"],
        "must_satisfy": [
            {"id": "MS-1", "statement": "Plan must list the affected adapter."},
            {"id": "MS-2", "statement": "Plan must include validation commands."},
        ],
        "validation_commands": ["nx affected --target=test"],
        "expected_output_path": "aria-tools/agent-invocations/results/req-2026-05-07-001.json",
    }
    base.update(overrides)
    return base


def _good_response(*, request_id="req-2026-05-07-001", **overrides):
    base = {
        "$schema": RESPONSE_SCHEMA,
        "request_id": request_id,
        "claim_id": "claim_alpha-001",
        "agent_id": "aria-primary-planner",
        "role": "primary_plan",
        "status": "submitted",
        "satisfaction_matrix": [
            {"id": "MS-1", "verdict": "satisfied"},
            {"id": "MS-2", "verdict": "satisfied"},
        ],
    }
    base.update(overrides)
    return base


class RequestValidationTests(unittest.TestCase):
    def test_minimal_good_request_passes(self) -> None:
        validate_request(_good_request())

    def test_missing_must_satisfy_rejected(self) -> None:
        envelope = _good_request()
        del envelope["must_satisfy"]
        with self.assertRaisesRegex(GovernanceError, "missing required fields"):
            validate_request(envelope)

    def test_unknown_role_rejected(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "role unknown"):
            validate_request(_good_request(role="rogue_role"))

    def test_target_agent_outside_whitelist_rejected(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "not in whitelist"):
            validate_request(_good_request(target_agent="aria-rogue"))

    def test_duplicate_must_satisfy_id_rejected(self) -> None:
        env = _good_request(
            must_satisfy=[
                {"id": "MS-1", "statement": "first"},
                {"id": "MS-1", "statement": "second"},
            ]
        )
        with self.assertRaisesRegex(GovernanceError, "must_satisfy.*duplicate"):
            validate_request(env)

    def test_banned_phrase_in_must_satisfy_statement_rejected(self) -> None:
        env = _good_request(
            must_satisfy=[
                {"id": "MS-1", "statement": "Ship this for now and revisit later."},
            ]
        )
        with self.assertRaisesRegex(GovernanceError, "banned phrase"):
            validate_request(env)

    def test_request_id_pattern_rejected(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "request_id invalid"):
            validate_request(_good_request(request_id="bad id with spaces"))

    def test_empty_evidence_refs_rejected(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "evidence_refs"):
            validate_request(_good_request(evidence_refs=[]))


class ResponseValidationTests(unittest.TestCase):
    def test_minimal_good_response_passes(self) -> None:
        validate_response(_good_response(), request=_good_request())

    def test_missing_satisfaction_matrix_rejected(self) -> None:
        env = _good_response()
        del env["satisfaction_matrix"]
        with self.assertRaisesRegex(GovernanceError, "missing required fields"):
            validate_response(env)

    def test_must_satisfy_id_missing_in_matrix_rejected(self) -> None:
        request = _good_request()
        response = _good_response(
            satisfaction_matrix=[
                {"id": "MS-1", "verdict": "satisfied"},
            ]
        )
        with self.assertRaisesRegex(GovernanceError, "missing entries for must_satisfy ids"):
            validate_response(response, request=request)

    def test_extra_satisfaction_matrix_id_rejected(self) -> None:
        request = _good_request()
        response = _good_response(
            satisfaction_matrix=[
                {"id": "MS-1", "verdict": "satisfied"},
                {"id": "MS-2", "verdict": "satisfied"},
                {"id": "MS-3", "verdict": "satisfied"},
            ]
        )
        with self.assertRaisesRegex(GovernanceError, "ids not in must_satisfy"):
            validate_response(response, request=request)

    def test_blocked_verdict_requires_note_and_evidence(self) -> None:
        request = _good_request()
        response = _good_response(
            satisfaction_matrix=[
                {"id": "MS-1", "verdict": "blocked"},  # missing note + evidence
                {"id": "MS-2", "verdict": "satisfied"},
            ]
        )
        with self.assertRaisesRegex(GovernanceError, "note required when verdict='blocked'"):
            validate_response(response, request=request)

    def test_blocked_verdict_with_note_and_evidence_passes(self) -> None:
        request = _good_request()
        response = _good_response(
            satisfaction_matrix=[
                {
                    "id": "MS-1",
                    "verdict": "blocked",
                    "note": "Adapter scope unknown without nx graph data",
                    "evidence_refs": ["aria-tools/agent-network/index.json"],
                },
                {"id": "MS-2", "verdict": "satisfied"},
            ]
        )
        validate_response(response, request=request)

    def test_request_id_mismatch_rejected(self) -> None:
        request = _good_request()
        response = _good_response(request_id="req-other-001")
        with self.assertRaisesRegex(GovernanceError, "does not match request"):
            validate_response(response, request=request)

    def test_output_path_mismatch_rejected(self) -> None:
        request = _good_request()
        response = _good_response(output_path="/tmp/wrong.json")
        with self.assertRaisesRegex(GovernanceError, "differs from request"):
            validate_response(response, request=request)

    def test_unknown_status_rejected(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "status unknown"):
            validate_response(_good_response(status="forwarded"))


class SeparationOfDutiesTests(unittest.TestCase):
    def test_implementer_cannot_review_own_output(self) -> None:
        request = _good_request(
            separation_of_duties={"forbidden_agent_ids": ["aria-impl-bot"]}
        )
        with self.assertRaisesRegex(GovernanceError, "separation_of_duties forbids"):
            enforce_separation_of_duties(request=request, submitter_agent_id="aria-impl-bot")

    def test_independent_reviewer_passes(self) -> None:
        request = _good_request(
            separation_of_duties={"forbidden_agent_ids": ["aria-impl-bot"]}
        )
        enforce_separation_of_duties(
            request=request, submitter_agent_id="aria-challenger-planner"
        )


class RefusalTests(unittest.TestCase):
    def test_render_refusal_passes_through_known_reason(self) -> None:
        row = render_refusal(
            request_id="req-2026-05-07-002",
            cycle_id="aria-20260507T000000Z",
            refused_by="aria-primary-planner",
            reason_class="evidence",
            reason_text="No evidence ref points to a concrete file:line.",
            evidence_refs=["docs/aria/SPEC.md:53"],
        )
        self.assertEqual(row["$schema"], "aria/agent-refusal/v1")
        self.assertEqual(row["reason_class"], "evidence")

    def test_unknown_reason_class_rejected(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "reason_class"):
            render_refusal(
                request_id="req-x",
                cycle_id="cycle-x",
                refused_by="x",
                reason_class="convenience",
                reason_text="reason text",
            )

    def test_banned_phrase_in_refusal_text_rejected(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "banned phrase"):
            render_refusal(
                request_id="req-x",
                cycle_id="cycle-x",
                refused_by="x",
                reason_class="law",
                reason_text="Refusing for now until later.",
            )


class EnvelopeHashTests(unittest.TestCase):
    def test_envelope_hash_is_stable(self) -> None:
        env1 = _good_request()
        env2 = _good_request()
        self.assertEqual(envelope_hash(env1), envelope_hash(env2))

    def test_envelope_hash_changes_with_content(self) -> None:
        env = _good_request()
        h1 = envelope_hash(env)
        env["request_id"] = "req-2026-05-07-002"
        h2 = envelope_hash(env)
        self.assertNotEqual(h1, h2)


class WhitelistTests(unittest.TestCase):
    def test_whitelist_includes_all_required_agents(self) -> None:
        for agent in (
            "aria-prompt-writer",
            "aria-primary-planner",
            "aria-challenger-planner",
            "aria-evidence-judge",
            "aria-adversarial-judge",
            "aria-consensus-arbiter",
            "aria-change-intelligence",
            "aria-goldset-curator",
        ):
            self.assertIn(agent, DEFAULT_TARGET_AGENT_WHITELIST)

    def test_whitelist_keeps_the_domain_agents_the_kernel_dispatches(self) -> None:
        # E14 — Plan 019 Phase 2.5 put four domain agents here for lanes that
        # were then built differently. Two are genuinely dispatched today
        # (specialist touch-map / expert-review top-up) and stay; the other two
        # left with the roles that were their only kernel dispatch path. The
        # removal itself is pinned in tests/test_role_hygiene_e14.py.
        for agent in ("architectural-arbiter", "auth-security-expert"):
            self.assertIn(
                agent, DEFAULT_TARGET_AGENT_WHITELIST,
                f"{agent} missing from DEFAULT_TARGET_AGENT_WHITELIST",
            )


class RolePairingTests(unittest.TestCase):
    """Plan 019 Phase 2.5 — ROLE_TARGET_PAIRING is strict 1:1 where declared.

    A request using a paired role must target the paired agent; cross-routing
    is rejected before the agent ever sees the envelope. The four per-domain
    roles this class also covered were removed by E14 (no producer, no
    consumer); what remains is the judge pairing and the open-role behaviour.
    """

    def test_existing_evidence_judgment_pairing_preserved(self) -> None:
        # Plan 016 Faz C4 judges already had implicit 1:1 pairing via
        # the whitelist + role naming. Phase 2.5 codifies this in the
        # ROLE_TARGET_PAIRING map. Existing fixtures that use
        # evidence_judgment + aria-evidence-judge must still pass.
        validate_request(_good_request(
            role="evidence_judgment",
            target_agent="aria-evidence-judge",
        ))

    def test_existing_evidence_judgment_with_wrong_judge_rejected(self) -> None:
        # The flip side: evidence_judgment served by adversarial judge
        # was previously accepted (whitelist passed both). Phase 2.5
        # now rejects the mismatch — this is a tightening, not a
        # backward-compat break, because no existing kernel caller
        # routes evidence_judgment to a non-evidence judge.
        with self.assertRaisesRegex(
            GovernanceError,
            r"role 'evidence_judgment' requires target_agent in "
            r"\('aria-evidence-judge',\); got 'aria-adversarial-judge'",
        ):
            validate_request(_good_request(
                role="evidence_judgment",
                target_agent="aria-adversarial-judge",
            ))

    def test_open_role_primary_plan_accepts_any_whitelisted_agent(self) -> None:
        # primary_plan is NOT in ROLE_TARGET_PAIRING; convergent planning
        # is many-to-many by design. The whitelist alone gates target.
        for target in ("aria-primary-planner", "aria-challenger-planner", "aria-prompt-writer"):
            validate_request(_good_request(role="primary_plan", target_agent=target))


if __name__ == "__main__":
    unittest.main()
