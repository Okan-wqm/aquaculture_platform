"""The trailer reconciliation adopts on finally has something that writes it.

PLAN Wave 2 PR 1.5. PR 1.3 gave `mission_reconcile` an adoption path keyed on
an `ARIA-Mission:` trailer in a PR body — and shipped **no producer for that
trailer**. That is the defect class this programme has spent seven PRs closing,
introduced by one of its own changes: a consumer waiting on a string nothing
emits is machinery that can never fire.

So the trailer is now written, and the format is owned in ONE place.
`format_mission_trailer` validates its output against the very pattern
`reconcile_missions` parses, which is what makes producer/consumer drift
unrepresentable rather than merely unlikely: a formatter that emitted a shape
the pattern misses would fail at the moment it produced it, not silently on
some future night when a PR went unadopted.

The mission also reaches the dispatch row and the mission's own bindings, so a
promoted plan and its assignment are recoverable FROM the mission and the
mission is recoverable from the PR.
"""

from __future__ import annotations

import inspect
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch

from aria_kernel import promotion_controller
from aria_kernel.ledger import load_jsonl
from aria_kernel.mission import (
    bind_mission,
    fold_mission,
    mission_id_for,
    open_mission,
)
from aria_kernel.mission_reconcile import (
    MISSION_TRAILER_PATTERN,
    format_mission_trailer,
    reconcile_missions,
)
from aria_kernel.pr_manager import build_pr_body
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir
from aria_kernel.workspace import workspace_paths

REPO_HASH = "repohash0001"


class _Observer:
    """A GitHub that returns exactly the open PRs the test hands it."""

    def __init__(self, open_prs: list[dict[str, Any]]) -> None:
        self.open_prs = open_prs

    def get_pr_lifecycle(self, number: int) -> dict[str, Any] | None:
        return None

    def observe_branch(self, name: str) -> bool | None:
        return None

    def list_open_pull_requests(self) -> list[dict[str, Any]] | None:
        return self.open_prs


class WeaveTestBase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.root = ensure_tools_dir(self.base)

    def _mission(self, source_id: str = "F-1") -> str:
        # ORPHAN-MEDIUM-730 — the mint refuses a mission with no forward
        # pointer, so the fixture derives one from the finding it opens.
        open_mission(
            source_kind="finding",
            source_id=source_id,
            repo_hash=REPO_HASH,
            title=f"close {source_id}",
            next_action=f"close {source_id}",
            wake_condition={"kind": "evidence", "key": f"finding:{source_id}"},
            base_dir=self.base,
        )
        return mission_id_for("finding", source_id, REPO_HASH)


# =====================================================================
# One definition, two directions.
# =====================================================================


class TrailerContractTests(WeaveTestBase):
    def test_what_the_formatter_writes_is_what_the_pattern_reads(self) -> None:
        """The round trip IS the contract. Two literals in two modules is how
        a producer and a consumer come to disagree about a format."""
        mission_id = self._mission()
        match = MISSION_TRAILER_PATTERN.search(format_mission_trailer(mission_id))
        self.assertIsNotNone(match)
        self.assertEqual(match.group(1), mission_id)

    def test_the_formatter_refuses_an_id_the_pattern_would_miss(self) -> None:
        """A formatter that can emit an unparseable trailer moves the failure
        from write-time to some future night when a PR goes unadopted."""
        for bad in ("m-NOTHEX0000000000", "mission-1", "", "m-abc"):
            with self.assertRaises(GovernanceError):
                format_mission_trailer(bad)

    def test_the_trailer_stands_on_its_own_line(self) -> None:
        """The pattern is anchored with MULTILINE. A trailer indented into a
        bullet — the obvious place to put it in a Provenance section — would
        never match."""
        mission_id = self._mission()
        trailer = format_mission_trailer(mission_id)
        self.assertFalse(trailer.startswith((" ", "\t", "-", "*")))
        self.assertEqual(trailer, trailer.strip())


class PrBodyTests(WeaveTestBase):
    PROPOSAL = {
        "proposal_id": "P-1",
        "title": "close the gap",
        "problem": "the gap",
        "evidence": ["aria-kernel/aria_kernel/mission.py"],
    }
    ACTION = {
        "base_sha": "a" * 40,
        "worktree_path": "/tmp/wt",
        "validation_commands": ["npm run aria:test:unit"],
    }

    def test_a_body_without_a_mission_carries_no_trailer(self) -> None:
        body = build_pr_body(proposal=self.PROPOSAL, action=self.ACTION)
        self.assertIsNone(MISSION_TRAILER_PATTERN.search(body))

    def test_a_body_with_a_mission_carries_the_trailer(self) -> None:
        mission_id = self._mission()
        body = build_pr_body(
            proposal=self.PROPOSAL, action=self.ACTION, mission_id=mission_id
        )
        match = MISSION_TRAILER_PATTERN.search(body)
        self.assertIsNotNone(match)
        self.assertEqual(match.group(1), mission_id)

    def test_the_body_still_satisfies_the_required_sections(self) -> None:
        from aria_kernel.pr_manager import REQUIRED_PR_SECTIONS, _validate_pr_body

        body = build_pr_body(
            proposal=self.PROPOSAL, action=self.ACTION, mission_id=self._mission()
        )
        _validate_pr_body(body)
        for section in REQUIRED_PR_SECTIONS:
            self.assertIn(f"## {section}", body)

    def test_a_pr_opener_cannot_supply_a_mission_that_contradicts_the_dispatch(
        self,
    ) -> None:
        """`open_pr_for_action` takes no mission_id. It derives one from the
        assignment it was given, so the PR's mission and the dispatch row's
        mission cannot disagree — there is only one of them."""
        from aria_kernel.pr_manager import open_pr_for_action

        self.assertNotIn(
            "mission_id", inspect.signature(open_pr_for_action).parameters
        )

    def test_the_pr_opener_actually_derives_it(self) -> None:
        """STRUCTURAL, and named so. The previous test proves only that a
        caller CANNOT pass a mission; it says nothing about whether one is
        looked up — a body built with `mission_id=None` would satisfy it and
        every PR would go untrailed. This pins the call site: the argument
        `open_pr_for_action` hands `build_pr_body` is the lookup's result."""
        import ast

        from aria_kernel import pr_manager

        tree = ast.parse(inspect.getsource(pr_manager))
        opener = next(
            node for node in ast.walk(tree)
            if isinstance(node, ast.FunctionDef) and node.name == "open_pr_for_action"
        )
        derived = [
            keyword
            for node in ast.walk(opener)
            if isinstance(node, ast.Call)
            and getattr(node.func, "id", None) == "build_pr_body"
            for keyword in node.keywords
            if keyword.arg == "mission_id"
            and isinstance(keyword.value, ast.Call)
            and getattr(keyword.value.func, "id", None) == "mission_for_assignment"
        ]
        self.assertEqual(
            len(derived), 1,
            "open_pr_for_action must pass mission_for_assignment(...) as the "
            "body's mission_id, not a constant",
        )


class AssignmentLookupTests(WeaveTestBase):
    def _row(self, **extra: Any) -> None:
        from tests._helpers.declared_fixtures import append_declared_fixture

        append_declared_fixture(
            self.root / "dispatch" / "requests.jsonl",
            {
                "$schema": "aria/dispatch-request/v2",
                "schema_version": 2,
                "assignment_id": "A-1",
                "pressure_event_id": "pe-1",
                "target_agent": "aria-worker",
                "state": "pending",
                "created_at": "2026-08-04T12:00:00Z",
                "plan_id": "plan-1",
                **extra,
            },
            expected_surface="dispatch_requests",
        )

    def test_a_row_with_a_mission_resolves_it(self) -> None:
        from aria_kernel.worker_dispatch import mission_for_assignment

        mission_id = self._mission()
        self._row(mission_id=mission_id)
        self.assertEqual(
            mission_for_assignment(assignment_id="A-1", base_dir=self.base), mission_id
        )

    def test_a_row_without_a_mission_resolves_to_none(self) -> None:
        from aria_kernel.worker_dispatch import mission_for_assignment

        self._row()
        self.assertIsNone(
            mission_for_assignment(assignment_id="A-1", base_dir=self.base)
        )

    def test_a_non_string_mission_field_resolves_to_none(self) -> None:
        """`str(mission_id) if mission_id` would turn a stray `{"a": 1}` into
        the literal string "{'a': 1}" and hand it to a formatter that then
        refuses — a write-time crash caused by a read-time type guess."""
        from aria_kernel.worker_dispatch import mission_for_assignment

        self._row(mission_id={"not": "a string"})
        self.assertIsNone(
            mission_for_assignment(assignment_id="A-1", base_dir=self.base)
        )

    def test_a_blank_mission_field_resolves_to_none(self) -> None:
        from aria_kernel.worker_dispatch import mission_for_assignment

        self._row(mission_id="   ")
        self.assertIsNone(
            mission_for_assignment(assignment_id="A-1", base_dir=self.base)
        )

    def test_an_unknown_assignment_resolves_to_none(self) -> None:
        from aria_kernel.worker_dispatch import mission_for_assignment

        self.assertIsNone(
            mission_for_assignment(assignment_id="A-nope", base_dir=self.base)
        )


class ProducerReachesConsumerTests(WeaveTestBase):
    def test_a_body_this_code_produces_is_adopted_by_reconciliation(self) -> None:
        """The end-to-end claim, and the reason this PR exists: a PR body
        built here, handed to the reconciler unmodified, binds the mission.

        Asserting the regex round-trips is not the same as asserting the two
        halves connect — the first is about a string, the second is about the
        pipeline."""
        mission_id = self._mission()
        body = build_pr_body(
            proposal={"proposal_id": "P-1", "title": "t", "problem": "p", "evidence": []},
            action={"base_sha": "a" * 40, "worktree_path": "/tmp/wt"},
            mission_id=mission_id,
        )
        result = reconcile_missions(
            cycle_id="cycle-1",
            observer=_Observer([{"number": 4242, "body": body}]),
            base_dir=self.base,
        )
        self.assertEqual(
            result["adoptions"], [{"mission_id": mission_id, "pr_number": 4242}]
        )
        state = fold_mission(mission_id=mission_id, base_dir=self.base)
        self.assertEqual(state["bindings"]["pr_numbers"], [4242])


# =====================================================================
# The mission reaches the dispatch row.
# =====================================================================


class PromotionWeaveTests(WeaveTestBase):
    def _promote(self, **kwargs: Any) -> dict[str, Any]:
        """Collaborators mocked, weave real.

        `plan_status`, `verify_runtime_artifacts` and `classify_cycle_evidence`
        are collaborators of the unit under test, not the unit — driving a real
        plan to CONVERGED and minting real run artifacts would test
        plan_convergence and runtime_artifacts, which have their own suites.
        """
        paths = workspace_paths(self.base, None)
        with (
            patch.object(
                promotion_controller, "plan_status",
                return_value={
                    "state": "CONVERGED",
                    "latest_revision": {"content_hash": "sha256:" + "b" * 64},
                },
            ),
            patch.object(
                promotion_controller, "verify_runtime_artifacts",
                return_value={"status": "ok", "issues": [], "verified_artifact_count": 1},
            ),
            patch.object(
                promotion_controller, "classify_cycle_evidence",
                return_value={"cycle_evidence_class": promotion_controller.ARTIFACT_BEARING},
            ),
        ):
            return promotion_controller.promote_converged_plan_to_dispatch(
                paths,
                plan_id=kwargs.pop("plan_id", "plan-1"),
                cycle_id="cycle-1",
                tools_root=self.root,
                impact_ref="impact.json",
                validation_ref="validation.json",
                base_sha="a" * 40,
                acknowledge=True,
                **kwargs,
            )

    def _dispatch_rows(self) -> list[dict[str, Any]]:
        return load_jsonl(self.root / "dispatch" / "requests.jsonl")

    def test_the_mission_reaches_the_dispatch_row(self) -> None:
        mission_id = self._mission()
        row = self._promote(mission_id=mission_id)
        self.assertEqual(row["mission_id"], mission_id)
        self.assertEqual(self._dispatch_rows()[-1]["mission_id"], mission_id)

    def test_promotion_binds_the_plan_and_the_assignment_to_the_mission(self) -> None:
        """A mission whose plan and assignment are not recoverable from it is
        a mission that cannot be reconciled against anything."""
        mission_id = self._mission()
        row = self._promote(mission_id=mission_id)
        bindings = fold_mission(mission_id=mission_id, base_dir=self.base)["bindings"]
        self.assertEqual(bindings["plan_ids"], ["plan-1"])
        self.assertEqual(bindings["assignment_ids"], [row["assignment_id"]])

    def test_binding_the_same_promotion_twice_does_not_duplicate(self) -> None:
        mission_id = self._mission()
        self._promote(mission_id=mission_id)
        self._promote(mission_id=mission_id)
        bindings = fold_mission(mission_id=mission_id, base_dir=self.base)["bindings"]
        self.assertEqual(bindings["plan_ids"], ["plan-1"])

    def test_an_unknown_mission_blocks_the_promotion(self) -> None:
        """Refused rather than written through: a dispatch row naming a
        mission that does not exist is an unresolvable binding, and the
        reconciler would record `unknown_trailer` forever."""
        result = self._promote(mission_id="m-0000000000000000")
        self.assertEqual(result["status"], "blocked")
        self.assertIn("unknown_mission", result["blockers"])

    def test_a_malformed_mission_id_blocks_the_promotion(self) -> None:
        result = self._promote(mission_id="not-a-mission")
        self.assertEqual(result["status"], "blocked")
        self.assertIn("unknown_mission", result["blockers"])

    def test_a_promotion_without_a_mission_still_works(self) -> None:
        """The weave is additive. Operator promotions predating the mission
        layer must not start failing."""
        row = self._promote()
        self.assertIsNone(row.get("mission_id"))
        self.assertTrue(row["assignment_id"])

    def test_the_mission_check_does_not_displace_the_wip_gate(self) -> None:
        """PR 1.4's admission blockers stay first — a promotion refused while
        work is in flight must say so, not report a mission problem."""
        mission_id = self._mission()
        bind_mission(
            mission_id=mission_id,
            bindings={"pr_numbers": [1]},
            step_id="fixture",
            base_dir=self.base,
        )
        from aria_kernel.mission import transition_mission

        for state in ("CONTRACTING", "PLANNING", "IMPLEMENTING"):
            transition_mission(
                mission_id=mission_id, to_state=state, reason_code="fixture",
                step_id=f"fixture-{state}", next_action="n",
                wake_condition={"kind": "timer", "key": "k"}, base_dir=self.base,
            )
        result = self._promote(mission_id=mission_id)
        self.assertEqual(result["blockers"][0], "mission_wip_unavailable")

    def test_the_wip_blockers_are_reported_before_the_mission_blocker(self) -> None:
        """Both wrong at once, which is the only arrangement that pins the
        order: with a valid mission the previous test passes no matter where
        the mission check sits."""
        from tests._helpers.declared_fixtures import append_declared_fixture

        append_declared_fixture(
            self.root / "dispatch" / "requests.jsonl",
            {
                "$schema": "aria/dispatch-request/v2",
                "schema_version": 2,
                "assignment_id": "A-live",
                "pressure_event_id": "pe-live",
                "target_agent": "aria-worker",
                "state": "pending",
                "created_at": "2026-08-04T12:00:00Z",
                "plan_id": "plan-0",
            },
            expected_surface="dispatch_requests",
        )
        result = self._promote(mission_id="m-0000000000000000")
        self.assertEqual(result["blockers"][0], "dispatch_wip_unavailable")
        self.assertIn("unknown_mission", result["blockers"])


if __name__ == "__main__":
    unittest.main()
