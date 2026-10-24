"""SE-2 — the routing inputs the kernel consumes are authority: derived set and CODEOWNERS.

WHY. Once SE-2 lands, ``.claude/shared/orchestrator-routing-table.md`` is the
ONE path -> Lane-A agent map (``agent_routing.ROUTING_TABLE_REL``), and it
chooses the merge-time expert reviewers of ARIA's own implementation PRs
(``expert_review_gate`` / ``specialist_review_runner``, Gate C; DECISIONS.md
Q12). At the branch base nothing guards it: it is not a member of
``self_improvement.derived_authority_set`` (PLAN-v2 B1), so neither the
implementer room (``implementation_safety.readonly_paths()``) nor the merge
perimeter refuses an ARIA-authored edit, and ``.github/CODEOWNERS`` names no
owner for ``.claude/shared/``. A change could pick its own reviewers by
editing the table in the same PR. Service-expertise PLAN.md §2 row
"Authority over routing inputs" (SK-01) adds ``.claude/shared/`` to both.

WHAT THIS PINS (PLAN.md §8 SE-2 red test (ii)).
  * The routing input the owner reads, ``agent_routing.ROUTING_TABLE_REL``,
    and every path under ``.claude/shared/`` (each file there today, plus a
    probe a change could ADD: the whole directory joins, PLAN §2) is
      - a member of the derived authority set the running kernel guards
        (``self_improvement.kernel_authority_set``);
      - refused to an implementer write by the pre-PR-open scope gate
        (``forbidden_scope_normalized``) and by the merge perimeter
        (``readonly_paths_untouched_at_merge``), both reading that set;
      - owned in ``.github/CODEOWNERS`` (the last matching rule names an owner).
  * The authority comes from the ONE owner: no hand-written entry of the
    implementer room's own anchor list
    (``implementation_safety._IMPLEMENTER_READONLY_ANCHORS``) covers
    ``.claude/shared/``. B1 derives ``readonly_paths()`` from the set; a
    second hand list is the drift B1 removed (guard, green at base).

RED AT THE BRANCH BASE, by assertion: the table and every ``.claude/shared/``
path are outside the derived set, writable through both gates and unowned.
No new API: every name used here exists at the base.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel import implementation_safety as safety
from aria_kernel import self_improvement
from aria_kernel.agent_routing import ROUTING_TABLE_REL
from aria_kernel.risk_policy import codeowners_last_match, codeowners_rules
from tests._helpers.pre_merge_evidence import fixture_pre_merge_evidence

_REPO_ROOT = Path(__file__).resolve().parents[3]
_ROUTING_INPUT_DIR = ".claude/shared"
# A file a change could ADD under the directory: the set must hold it before it exists.
_PROBE = f"{_ROUTING_INPUT_DIR}/se2-probe-routing-table.md"


def _routing_inputs() -> tuple[str, ...]:
    """The owner's routing table, each file under ``.claude/shared/`` today, and the probe."""
    directory = _REPO_ROOT / _ROUTING_INPUT_DIR
    present = sorted(path.relative_to(_REPO_ROOT).as_posix() for path in directory.rglob("*") if path.is_file())
    return tuple(dict.fromkeys((ROUTING_TABLE_REL, *present, _PROBE)))


def _registered_check(name: str):  # noqa: ANN202 — the registry's own callable type
    return {entry.name: entry for entry in safety.HARD_FAIL_CHECKS}[name].check


def _readonly_refusal(path: str) -> str | None:
    """The pre-PR-open scope gate's reason for an implementer write to ``path``."""
    with tempfile.TemporaryDirectory() as tmp:
        result = _registered_check("forbidden_scope_normalized")(
            safety.HardFailContext(workspace_root=Path(tmp), affected_paths=(path,)))
    return None if result.passed else result.reason


def _bound_evidence() -> safety._PreMergeEvidence:
    """Every native identity the pre-merge predicates require, present."""
    fields = ("repo_identity", "snapshot_hash", "pr_row_hash", "planned_row_hash", "committed_row_hash",
              "request_id", "claim_id", "request_row_hash", "claim_row_hash", "result_row_hash",
              "implementation_event_hash")
    return fixture_pre_merge_evidence((), **{field: f"{field}-x" for field in fields})


def _merge_refusal(path: str) -> str | None:
    """The merge perimeter's reason for an ARIA-authored change to ``path``."""
    result = _registered_check("readonly_paths_untouched_at_merge")(
        safety.HardFailContext(affected_paths=(path,), pre_merge_evidence=_bound_evidence()))
    return None if result.passed else result.reason


class TheRoutingInputsAreAuthority(unittest.TestCase):
    """(ii) Every kernel-consumed routing input is in the derived set and under CODEOWNERS."""

    maxDiff = None

    @classmethod
    def setUpClass(cls) -> None:
        cls.inputs = _routing_inputs()
        cls.authority = self_improvement.kernel_authority_set()
        cls.codeowners = codeowners_rules()

    def test_the_owner_reads_its_table_from_the_routing_input_directory(self) -> None:
        self.assertTrue(ROUTING_TABLE_REL.startswith(f"{_ROUTING_INPUT_DIR}/"), ROUTING_TABLE_REL)
        self.assertTrue((_REPO_ROOT / ROUTING_TABLE_REL).is_file(), f"{ROUTING_TABLE_REL} is missing")

    def test_every_routing_input_is_a_member_of_the_derived_authority_set(self) -> None:
        outside = [path for path in self.inputs if not self_improvement.in_authority_set(path, self.authority)]
        self.assertEqual(
            outside, [],
            "a routing input the kernel consumes is outside self_improvement.derived_authority_set "
            "(PLAN §2 'Authority over routing inputs', SK-01)")

    def test_the_implementer_room_cannot_write_a_routing_input(self) -> None:
        writable = [path for path in self.inputs if _readonly_refusal(path) is None]
        self.assertEqual(writable, [], "the pre-PR-open scope gate admits an implementer write to a routing input")

    def test_the_merge_perimeter_refuses_a_routing_input(self) -> None:
        admitted = [path for path in self.inputs if _merge_refusal(path) is None]
        self.assertEqual(admitted, [], "the merge perimeter admits an ARIA-authored change to a routing input")

    def test_codeowners_names_an_owner_for_every_routing_input(self) -> None:
        unowned = []
        for path in self.inputs:
            rule = codeowners_last_match(path, rules=self.codeowners)
            if rule is None or not rule.owners:
                unowned.append(path)
        self.assertEqual(unowned, [], "a routing input has no CODEOWNERS owner")

    def test_no_hand_written_room_anchor_covers_the_routing_inputs(self) -> None:
        hand_written = [entry for entry in safety._IMPLEMENTER_READONLY_ANCHORS
                        if any(safety._covered_by(path, entry) for path in self.inputs)]
        self.assertEqual(
            hand_written, [],
            "the routing inputs join the derived authority set (the one owner, B1), not the room's hand list")


if __name__ == "__main__":
    unittest.main()
