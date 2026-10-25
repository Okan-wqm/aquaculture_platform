"""WP-D4 — the per-change budget: caps registered, claims held, seats counted, cost reported.

DESIGN-discovery row D4: no change review may run uncapped, so before the
first LLM DEV run one change must be bounded in what enters proof, in the
seats it may take, and in what the room reports about its cost. The red test
the design writes down: a change returning 20 claims has 8 enter proof and 12
held with one ``change_review_budget_held`` row each; seat counts never
exceed policy; a metered-admission fixture makes ``assert_within_budget``
raise before the spawn. Every cap is a HOLD for its reader, never a raise
(the 579 discipline the funnel already follows).

What is pinned, and where the owner is:

  * POLICY (``genesis_policy.change_review_policy``, the SE-13 strict parser).
    The shipped ``change_review`` block gains ``proof.claims_per_change`` (8),
    ``proof.overflow`` (the hold behaviour, a one-member vocabulary: "hold"),
    ``seats.prover_seats_per_change`` (4) and ``seats.judge_seats_per_change``
    (4). With the existing seat caps they sum to the design's 14 LLM seats per
    change (3 service + 1 lens + 2 hand-off + 4 prover + 4 judge). A missing,
    unknown or out-of-range key is refused by its dotted path; nothing is
    filled from a default. The block already lives in the shipped JSON beside
    ``service_expertise`` (SE-13), which is the one place each value is
    written: the repository's own override must not carry a second copy.
  * CLAIMS (``judgment_funnel.admit_change_claims``). The funnel is the one
    owner of what is judged and how many seats it gets, and of the ``*_budget_held``
    rows; claims enter proof through it, so the per-change cap lives there.
    A claim is ``{"claim_id", "severity", "confidence", ...}``; the caller
    (D3's bridge) resolves severity from the claim family's rule contract.
    The whole change's claims go in one call; ``admitted`` and ``held`` partition
    them. The highest ranked claims enter (severity, then confidence, then
    ``claim_id`` ascending, so the split does not depend on arrival order); every
    other claim is held, stays a hypothesis, and gets exactly one governance row
    ``change_review_budget_held`` naming it. A repeat call writes no second row.
  * SEATS (``request_admission.admit_request(..., subject_ref=...)``). Every
    mint passes the door, so the per-change seat counter lives there, derived
    from the request ledger by ``subject_ref`` (no second counter): a
    ``change_intelligence`` request for a subject that already holds
    ``service_seats_per_change + lens_seats_per_change`` is refused by name
    (``change_review_seat_cap``). A call that names no subject is untouched.
  * COST (``cycle`` payload ``change_intelligence.cost_budget`` and the room
    report of ``harness.py review-change``). The attribution the room reports
    is ``cost_budget``'s own derivation (``derived_usage``, ``_load_caps``)
    plus the monetary admission in force, read from the workspace the store is
    bound to - the same place the spawn gate reads it. The metered pin below
    already held at the branch base (the gate exists since F13/E8): it is kept
    here because the design lists it, and it fails if D4 weakens the gate.

New API pinned here (red at the base because it does not exist yet): the four
policy keys above, ``judgment_funnel.admit_change_claims(subject_ref, claims, *,
base_dir, repo_root=None)`` returning ``{"admitted": [...], "held": [...]}``,
the ``subject_ref`` keyword of ``admit_request`` with its refusal reason, and the
``cost_budget`` block (``monetary_admission``, ``daily_usd``, ``monthly_usd``,
``caps``) in the change-intelligence phase payload. Every test reaches that API
only after an assertion on it, so the red is an assertion failure, never an
import or collection error.
"""
from __future__ import annotations

import copy
import inspect
import json
import os
import random
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest import mock

_POC = Path(__file__).resolve().parents[2] / "tools" / "aria-poc"
if str(_POC) not in sys.path:
    sys.path.insert(0, str(_POC))

import claude_runtime  # noqa: E402

from aria_kernel import cost_budget, genesis_policy, judgment_funnel  # noqa: E402
from aria_kernel.agent_invocations import (  # noqa: E402
    create_agent_invocation_request,
    list_agent_invocation_requests,
)
from aria_kernel.budget import record_cost_attribution  # noqa: E402
from aria_kernel.cycle import run_enterprise_cycle  # noqa: E402
from aria_kernel.pr_tracking import CHANGE_INTELLIGENCE_AGENT, CHANGE_INTELLIGENCE_ROLE  # noqa: E402
from aria_kernel.request_admission import admit_request  # noqa: E402
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir  # noqa: E402
from tests._helpers.git_fixtures import commit_files, make_local_git_repo  # noqa: E402

_REPO_ROOT = Path(__file__).resolve().parents[2]
SUBJECT = f"change:{'a' * 40}..{'b' * 40}"
OTHER_SUBJECT = f"change:{'a' * 40}..{'c' * 40}"
HEAD = "b" * 40
OPERATOR_PRODUCER = "change_review.operator_subject"
HELD_KIND = "change_review_budget_held"
CLAIMS_REASON = "claims_per_change_cap"
SEAT_REASON = "change_review_seat_cap"
# The four keys D4 registers: (sub-block, key).
NEW_KEYS = (
    ("proof", "claims_per_change"),
    ("proof", "overflow"),
    ("seats", "prover_seats_per_change"),
    ("seats", "judge_seats_per_change"),
)


def _shipped_block() -> dict[str, Any]:
    path = Path(genesis_policy.__file__).resolve().parent / "data" / genesis_policy.DEFAULT_FILENAME
    return copy.deepcopy(json.loads(path.read_text(encoding="utf-8"))["change_review"])


def _write_override(workspace: Path, block: dict[str, Any]) -> None:
    path = workspace / genesis_policy.OVERRIDE_RELPATH
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"change_review": block}), encoding="utf-8")


def _require_registered(test: unittest.TestCase, block: dict[str, Any], sub: str, key: str) -> None:
    test.assertIn(
        key, block.get(sub, {}),
        f"change_review.{sub}.{key} is not registered in the shipped block: the per-change "
        "budget has no pre-registered value to read",
    )


class PolicyRegistrationTests(unittest.TestCase):
    """The numbers are written once, in the shipped block, and parsed strictly."""

    def _refusal(self, block: dict[str, Any]) -> str:
        with tempfile.TemporaryDirectory() as tmp:
            _write_override(Path(tmp), block)
            with self.assertRaises(GovernanceError) as refused:
                genesis_policy.change_review_policy(tmp)
        return str(refused.exception)

    def test_the_design_numbers_are_registered_in_the_shipped_block(self) -> None:
        parsed = genesis_policy.change_review_policy()
        for sub, key in NEW_KEYS:
            _require_registered(self, parsed, sub, key)
        self.assertEqual(parsed["proof"]["claims_per_change"], 8, "DESIGN D4: 8 claims enter proof")
        self.assertEqual(parsed["proof"]["overflow"], "hold", "every cap is a hold, never a raise")
        seats = parsed["seats"]
        self.assertEqual((seats["prover_seats_per_change"], seats["judge_seats_per_change"]), (4, 4))
        ceiling = sum(seats[key] for key in (
            "service_seats_per_change", "lens_seats_per_change", "handoff_seats_per_change",
            "prover_seats_per_change", "judge_seats_per_change",
        ))
        self.assertEqual(ceiling, 14, "DESIGN D4: at most 14 LLM seats per change")

    def test_the_repository_policy_reads_the_same_registration(self) -> None:
        shipped = genesis_policy.change_review_policy()
        for sub, key in NEW_KEYS:
            _require_registered(self, shipped, sub, key)
        # One place each value is written: the operator override neither shadows
        # the block nor carries a second copy that could drift from it.
        self.assertEqual(genesis_policy.change_review_policy(_REPO_ROOT), shipped)

    def test_a_missing_key_is_refused_by_its_dotted_path(self) -> None:
        for sub, key in NEW_KEYS:
            with self.subTest(key=f"{sub}.{key}"):
                block = _shipped_block()
                _require_registered(self, block, sub, key)
                del block[sub][key]
                message = self._refusal(block)
                self.assertIn("key_missing", message)
                self.assertIn(f"change_review.{sub}.{key}", message)

    def test_a_value_outside_its_type_or_vocabulary_is_refused_by_its_dotted_path(self) -> None:
        cases = (
            ("proof", "claims_per_change", 0, "value_out_of_range"),
            ("proof", "claims_per_change", True, "value_not_a_whole_number"),
            ("proof", "claims_per_change", 8.5, "value_not_a_whole_number"),
            ("proof", "overflow", "drop", "value_not_in_vocabulary"),
        )
        for sub, key, value, code in cases:
            with self.subTest(key=f"{sub}.{key}", value=value):
                block = _shipped_block()
                _require_registered(self, block, sub, key)
                block[sub][key] = value
                message = self._refusal(block)
                self.assertIn(code, message)
                self.assertIn(f"change_review.{sub}.{key}", message)

    def test_an_unknown_key_in_the_proof_block_is_refused(self) -> None:
        block = _shipped_block()
        self.assertIn("proof", block, "the shipped change_review block has no proof sub-block")
        block["proof"]["claims_per_changes"] = 8
        message = self._refusal(block)
        self.assertIn("key_unknown", message)
        self.assertIn("change_review.proof", message)


def _twenty_claims() -> list[dict[str, Any]]:
    """3 CRITICAL, 3 HIGH, 14 MEDIUM; confidences strictly falling inside a severity.

    Eight enter proof under severity-then-confidence: every CRITICAL and HIGH
    claim and the two most confident MEDIUM ones. The CRITICAL/HIGH
    confidences (>= 0.81) sit above every MEDIUM one that is admitted, so the
    expected split does not depend on how severity and confidence are weighed
    against each other, only on severity ranking first.
    """
    top = [("CRITICAL", 0.95), ("CRITICAL", 0.90), ("CRITICAL", 0.85),
           ("HIGH", 0.92), ("HIGH", 0.88), ("HIGH", 0.81)]
    claims = [{"claim_id": f"claim-{index:02d}", "severity": severity, "confidence": confidence}
              for index, (severity, confidence) in enumerate(top, start=1)]
    claims += [{"claim_id": f"claim-{index:02d}", "severity": "MEDIUM",
                "confidence": round(0.90 - 0.05 * offset, 2)}
               for offset, index in enumerate(range(7, 21))]
    return claims


ADMITTED_OF_TWENTY = {f"claim-{index:02d}" for index in range(1, 9)}
HELD_OF_TWENTY = {f"claim-{index:02d}" for index in range(9, 21)}


class _Store(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-change-budget-")
        self.addCleanup(self._tmp.cleanup)
        self.workspace = Path(self._tmp.name)
        self.tools = ensure_tools_dir(self.workspace / "aria-tools")

    def governance(self, kind: str) -> list[dict[str, Any]]:
        path = self.tools / "governance.jsonl"
        if not path.exists():
            return []
        rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
        return [row["details"] for row in rows if row.get("kind") == kind]


class ClaimsEnterProofTests(_Store):
    """DESIGN D4 red test: 20 claims, 8 enter proof, 12 held with one row each."""

    def _admit(self, claims: list[dict[str, Any]], *, subject: str = SUBJECT) -> dict[str, Any]:
        self.assertTrue(
            hasattr(judgment_funnel, "admit_change_claims"),
            "judgment_funnel has no admit_change_claims: nothing bounds how many of a change's "
            "claims enter proof, so a change returning 20 claims puts 20 into proof",
        )
        return judgment_funnel.admit_change_claims(subject, claims, base_dir=self.tools, repo_root=self.workspace)

    @staticmethod
    def _ids(rows: list[dict[str, Any]]) -> list[str]:
        return [row["claim_id"] for row in rows]

    def test_twenty_claims_eight_enter_proof_and_twelve_are_held_one_row_each(self) -> None:
        claims = _twenty_claims()

        result = self._admit(claims)

        self.assertEqual(set(self._ids(result["admitted"])), ADMITTED_OF_TWENTY)
        self.assertEqual(len(result["admitted"]), 8)
        self.assertEqual(set(self._ids(result["held"])), HELD_OF_TWENTY)
        self.assertEqual(len(result["held"]), 12)
        rows = self.governance(HELD_KIND)
        self.assertEqual(len(rows), 12, "exactly one change_review_budget_held row per held claim")
        self.assertEqual(sorted(row["claim_id"] for row in rows), sorted(HELD_OF_TWENTY))
        for row in rows:
            with self.subTest(claim=row["claim_id"]):
                self.assertEqual(row["subject_ref"], SUBJECT)
                self.assertEqual(row["reason"], CLAIMS_REASON, "a hold carries a named reason")
                self.assertEqual(row["cap"], 8, "the row records the cap that held the claim")

    def test_a_held_claim_is_never_dropped_silently(self) -> None:
        claims = _twenty_claims()
        before = copy.deepcopy(claims)

        result = self._admit(claims)

        partition = self._ids(result["admitted"]) + self._ids(result["held"])
        self.assertEqual(sorted(partition), sorted(claim["claim_id"] for claim in before),
                         "admitted + held must be exactly the claims that came in, once each")
        self.assertEqual(claims, before, "the caller's claims are hypotheses and are not edited")

    def test_the_highest_ranked_claims_enter_whatever_order_they_arrive_in(self) -> None:
        for seed in range(6):
            with self.subTest(seed=seed):
                shuffled = _twenty_claims()
                random.Random(seed).shuffle(shuffled)
                self.setUp()

                result = self._admit(shuffled)

                self.assertEqual(set(self._ids(result["admitted"])), ADMITTED_OF_TWENTY)

    def test_claims_of_equal_rank_are_split_the_same_way_every_time(self) -> None:
        tied = [{"claim_id": f"claim-{index:02d}", "severity": "HIGH", "confidence": 0.8} for index in range(1, 11)]
        for seed in range(6):
            with self.subTest(seed=seed):
                shuffled = copy.deepcopy(tied)
                random.Random(seed).shuffle(shuffled)
                self.setUp()

                result = self._admit(shuffled)

                self.assertEqual(sorted(self._ids(result["admitted"])), [f"claim-{index:02d}" for index in range(1, 9)],
                                 "ties are broken by claim_id ascending, never by arrival order")

    def test_a_change_within_the_cap_holds_nothing(self) -> None:
        for count in (0, 1, 8):
            with self.subTest(claims=count):
                claims = _twenty_claims()[:count]
                self.setUp()

                result = self._admit(claims)

                self.assertEqual(sorted(self._ids(result["admitted"])), sorted(claim["claim_id"] for claim in claims))
                self.assertEqual(result["held"], [])
                self.assertEqual(self.governance(HELD_KIND), [])

    def test_the_cap_is_read_from_policy_not_from_a_literal(self) -> None:
        block = _shipped_block()
        _require_registered(self, block, "proof", "claims_per_change")
        block["proof"]["claims_per_change"] = 3
        _write_override(self.workspace, block)

        result = self._admit(_twenty_claims())

        self.assertEqual(len(result["admitted"]), 3)
        self.assertEqual(len(result["held"]), 17)
        rows = self.governance(HELD_KIND)
        self.assertEqual(len(rows), 17)
        self.assertEqual({row["cap"] for row in rows}, {3})

    def test_a_repeat_call_for_the_same_change_writes_no_second_row(self) -> None:
        first = self._admit(_twenty_claims())
        second = self._admit(_twenty_claims())

        self.assertEqual(set(self._ids(second["admitted"])), set(self._ids(first["admitted"])))
        self.assertEqual(len(self.governance(HELD_KIND)), 12,
                         "a second cycle over the same claims must not hold them a second time")

    def test_an_overflow_is_a_hold_not_a_raise_and_does_not_trip_the_cost_breaker(self) -> None:
        self._admit(_twenty_claims())

        self.assertEqual(cost_budget.current_state(self.tools), "ok")
        self.assertEqual(self.governance("cost_budget_breaker_tripped"), [])


class SeatCounterTests(_Store):
    """Seat counts per change subject, derived from the request ledger, never exceed policy."""

    def _door_takes_subjects(self) -> None:
        self.assertIn(
            "subject_ref", inspect.signature(admit_request).parameters,
            "admit_request cannot be asked about a change subject: no door counts a change's seats, "
            "so a mint path can take more seats than the policy registers",
        )

    def _attempt(self, index: int, *, subject: str | None = SUBJECT) -> Any:
        self._door_takes_subjects()
        extra = {"subject_ref": subject} if subject is not None else {}
        cycle_id = f"cyc-seat-{subject or 'none'}-{index}"
        admission = admit_request(
            OPERATOR_PRODUCER, CHANGE_INTELLIGENCE_ROLE, base_dir=self.tools, cycle_id=cycle_id, **extra,
        )
        if admission.admitted:
            create_agent_invocation_request(
                target_agent=CHANGE_INTELLIGENCE_AGENT, role=CHANGE_INTELLIGENCE_ROLE,
                suggested_prompt=f"Review seat {index} of the change {subject}",
                must_satisfy=[{"id": "impact-map", "description": "details.impact_map"}],
                allowed_scope=["**"], subject_ref=subject, cycle_id=cycle_id, target_sha=HEAD,
                base_dir=self.tools, admission=admission,
            )
        return admission

    def _seats(self, subject: str) -> int:
        return sum(1 for row in list_agent_invocation_requests(base_dir=self.tools, role=CHANGE_INTELLIGENCE_ROLE)
                   if row.get("subject_ref") == subject)

    def _discovery_cap(self) -> int:
        seats = genesis_policy.change_review_policy(self.workspace)["seats"]
        return seats["service_seats_per_change"] + seats["lens_seats_per_change"]

    def test_a_change_never_takes_more_seats_than_the_policy_registers(self) -> None:
        cap = self._discovery_cap()
        self.assertGreater(cap, 0)

        admissions = [self._attempt(index) for index in range(cap + 6)]

        self.assertEqual([a.admitted for a in admissions], [True] * cap + [False] * 6,
                         "the first `cap` seats are admitted and every later one is held at the door")
        self.assertEqual(self._seats(SUBJECT), cap, "seat count on the request ledger exceeds the policy")
        for refused in admissions[cap:]:
            self.assertEqual(refused.reason, SEAT_REASON, "a refused seat carries a named reason")
            self.assertTrue(refused.refusal.endswith(SEAT_REASON))

    def test_each_change_has_its_own_seats_and_a_call_without_a_subject_is_untouched(self) -> None:
        cap = self._discovery_cap()
        for index in range(cap):
            self.assertTrue(self._attempt(index).admitted)
        self.assertFalse(self._attempt(cap).admitted, "the first change is at its cap")

        other = self._attempt(0, subject=OTHER_SUBJECT)
        anonymous = self._attempt(0, subject=None)

        self.assertTrue(other.admitted, "a second change must not inherit the first one's seat count")
        self.assertTrue(anonymous.admitted, "critical path stays unthrottled for a mint that names no subject")

    def test_the_cap_follows_the_registered_seats_not_a_literal(self) -> None:
        block = _shipped_block()
        block["seats"]["service_seats_per_change"] = 1
        block["seats"]["lens_seats_per_change"] = 0
        _write_override(self.workspace, block)
        self.assertEqual(self._discovery_cap(), 1)

        admissions = [self._attempt(index) for index in range(4)]

        self.assertEqual([a.admitted for a in admissions], [True, False, False, False])
        self.assertEqual(self._seats(SUBJECT), 1)


class CostAttributionTests(unittest.TestCase):
    """The room reports what the change cost and which admission was in force."""

    def _fixture(self, root: Path) -> tuple[Path, str, str, Path]:
        repo = make_local_git_repo(root)
        base = commit_files(repo, {"apps/orders/src/order.ts": "export const total = (a: number, b: number): number => a + b;\n"})
        head = commit_files(repo, {"apps/orders/src/order.ts": "export const total = (a: number, b: number): number => a - b;\n"})
        return repo, base, head, ensure_tools_dir(root / "aria-tools")

    def _change_intelligence_payload(self, root: Path, *, policy: dict[str, Any] | None = None) -> tuple[dict[str, Any], Path]:
        repo, base, head, tools = self._fixture(root)
        if policy is not None:
            # The cycle binds the store to the tree it runs on, so the operator
            # policy the spawn gate reads is the tree's own (bound_workspace_root).
            (repo / "aria-config").mkdir()
            (repo / "aria-config" / "genesis_policy.json").write_text(json.dumps(policy), encoding="utf-8")
        record_cost_attribution(
            cycle_id="seed-cycle", plan_id="seed-plan", agent_role=CHANGE_INTELLIGENCE_ROLE, model="opus",
            input_tokens=1000, output_tokens=500, estimated_usd=0.37, base_dir=tools,
        )
        state = run_enterprise_cycle(
            workspace_root=repo, cycle_id="cr-cost", base_dir=tools, workspace_base=root / "ws",
            mode="change_review", change_base=base, change_head=head,
        )
        self.assertEqual(state["status"], "completed", state.get("failed_phases"))
        return state["change_intelligence"], tools

    def test_a_change_review_cycle_reports_the_attribution_and_the_metered_admission(self) -> None:
        with tempfile.TemporaryDirectory(prefix="aria-change-cost-") as tmp:
            payload, tools = self._change_intelligence_payload(Path(tmp))

            block = payload.get("cost_budget")
            self.assertIsNotNone(block, "the change_review payload carries no cost_budget attribution for the room report")
            self.assertEqual(block["monetary_admission"], "metered", "no policy block: the metered default is in force")
            self.assertAlmostEqual(block["daily_usd"], 0.37)
            self.assertAlmostEqual(block["monthly_usd"], 0.37)
            self.assertEqual(block["caps"], cost_budget._load_caps(tools))

    def test_the_admission_in_force_is_the_one_the_spawn_gate_reads(self) -> None:
        managed = {"executor": {"adaptive_runtime": {
            "schema_version": 1, "enabled": True, "policy_id": "aria/adaptive-runtime/v1",
            "provider_cooldown_seconds": 900, "recheck_timeout_seconds": 20,
            "max_attempts_per_dispatch": 2, "scarcity_judgment_mode": "independent_sessions",
            "monetary_admission": "managed_subscription",
        }}}
        with tempfile.TemporaryDirectory(prefix="aria-change-cost-") as tmp:
            payload, tools = self._change_intelligence_payload(Path(tmp), policy=managed)

            block = payload.get("cost_budget")
            self.assertIsNotNone(block, "the change_review payload carries no cost_budget attribution for the room report")
            self.assertEqual(block["monetary_admission"], "managed_subscription")
            gate = cost_budget.assert_within_budget(tools, estimated_run_usd=0.0)
            self.assertEqual(gate["monetary_admission"], block["monetary_admission"])


class MeteredAdmissionBeforeSpawnTests(unittest.TestCase):
    """A metered room over its daily cap is refused before any process starts.

    HOLDS AT THE BRANCH BASE (the gate sits on ``run_claude_exec`` since F13/E8
    and ``test_spawn_budget_gate`` pins its pieces): this is the design's
    metered-admission fixture, kept so D4's change to the same owner cannot
    weaken it. It is the one test in this module that is not red at the base.
    """

    def test_an_over_budget_metered_room_raises_before_a_spawn(self) -> None:
        with tempfile.TemporaryDirectory(prefix="aria-metered-room-") as tmp:
            tools = ensure_tools_dir(Path(tmp) / "aria-tools")
            self.assertEqual(cost_budget._load_caps(tools), {"daily": 5.0, "monthly": 100.0, "per_run": 0.5})
            record_cost_attribution(
                cycle_id="seed-cycle", plan_id="seed-plan", agent_role=CHANGE_INTELLIGENCE_ROLE, model="opus",
                input_tokens=1000, output_tokens=500, estimated_usd=4.9, base_dir=tools,
            )
            env = {"ARIA_TOOLS_DIR": str(tools), "ARIA_ESTIMATED_RUN_USD": "0.4"}
            with mock.patch.dict(os.environ, env), \
                    mock.patch.object(claude_runtime, "preflight_claude_auth"), \
                    mock.patch.object(claude_runtime.subprocess, "Popen") as popen, \
                    mock.patch.object(claude_runtime.subprocess, "run") as run:
                with self.assertRaisesRegex(GovernanceError, "cost_budget_daily_cap_exceeded"):
                    claude_runtime.run_claude_exec(prompt_text="review", timeout_seconds=5, model="opus",
                                                   skip_permissions=False)

            popen.assert_not_called()
            run.assert_not_called()
            self.assertEqual(cost_budget.current_state(tools), "tripped", "the breaker records the refusal")


if __name__ == "__main__":
    unittest.main()
