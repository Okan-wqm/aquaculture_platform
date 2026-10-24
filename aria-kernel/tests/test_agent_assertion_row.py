"""WP-J slice A — the assertion row: every expert assertion states its
evidence class, and the classes that carry weight must carry verbatim bytes.

The defect (wpj-a-3): a ``satisfaction_matrix`` entry is validated as
``{id, verdict, note?, evidence_refs?}`` and nothing more, so an agent can
assert "the test is red" as prose self-report, cite load-bearing code with no
verbatim quote, and reach consensus with the same weight as a mechanically
verified assertion. The arbiter has no vocabulary to rank.

The law pinned here (WP-J operator protocol steps 4-7):

* ``evidence_class`` is a closed vocabulary R0..R4, ranked — R4 executable
  reproduction > R3 verified trace > R2 cited observation > R1 argument >
  R0 unverifiable;
* load-bearing classes (R2, R3) REQUIRE ``quotes`` aligned by index with the
  entry's ``evidence_refs`` (re-graded at submit by the quote law, wpj-a-1);
* a reproduction claim exists ONLY as ``{recipe_id, expected}`` with
  ``expected`` in ``{'red', 'green'}`` — mapping onto
  ``finding.record_finding_reproduction`` (red -> CONFIRMED) and
  ``record_finding_fix_verification`` (same-recipe green -> RESOLVED) — it
  is required on R4 and refused on every other class;
* rows without ``evidence_class`` stay valid (legacy wire) and default to
  R1, the lowest ranked class.
"""

from __future__ import annotations

import unittest

from aria_kernel.agent_contract import (
    RESPONSE_SCHEMA,
    validate_response,
)
from aria_kernel.tool_registry import GovernanceError


def _response(entries: list[dict]) -> dict:
    return {
        "$schema": RESPONSE_SCHEMA,
        "request_id": "req-2026-05-07-001",
        "claim_id": "claim_alpha-001",
        "agent_id": "aria-primary-planner",
        "role": "primary_plan",
        "status": "submitted",
        "satisfaction_matrix": entries,
    }


class TheClosedVocabulary(unittest.TestCase):
    def test_the_classes_are_ranked_r0_to_r4(self) -> None:
        from aria_kernel.agent_contract import EVIDENCE_CLASSES
        self.assertEqual(EVIDENCE_CLASSES, ("R0", "R1", "R2", "R3", "R4"))

    def test_the_load_bearing_classes_are_r2_and_r3(self) -> None:
        from aria_kernel.agent_contract import LOAD_BEARING_EVIDENCE_CLASSES
        self.assertEqual(LOAD_BEARING_EVIDENCE_CLASSES, ("R2", "R3"))

    def test_reproduction_expectations_map_onto_the_finding_laws(self) -> None:
        from aria_kernel.agent_contract import REPRODUCTION_EXPECTATIONS
        self.assertEqual(REPRODUCTION_EXPECTATIONS, ("red", "green"))


class TheAssertionRowIsRefusedWhenItCannotStand(unittest.TestCase):
    def _refused(self, entries: list[dict], needle: str) -> None:
        with self.assertRaises(GovernanceError) as ctx:
            validate_response(_response(entries))
        self.assertIn(needle, str(ctx.exception))

    def test_an_unknown_evidence_class_is_refused(self) -> None:
        self._refused(
            [{"id": "MS-1", "verdict": "satisfied", "evidence_class": "R9"}],
            "evidence_class_unknown",
        )

    def test_a_load_bearing_row_without_quotes_is_refused(self) -> None:
        self._refused(
            [{
                "id": "MS-1", "verdict": "satisfied", "evidence_class": "R2",
                "evidence_refs": ["src/a.ts:12"],
            }],
            "quote_required_on_load_bearing",
        )

    def test_a_load_bearing_row_without_refs_is_refused(self) -> None:
        self._refused(
            [{"id": "MS-1", "verdict": "satisfied", "evidence_class": "R3", "quotes": ["x"]}],
            "quote_required_on_load_bearing",
        )

    def test_quotes_must_align_with_the_cited_refs(self) -> None:
        self._refused(
            [{
                "id": "MS-1", "verdict": "satisfied", "evidence_class": "R2",
                "evidence_refs": ["src/a.ts:12", "src/b.ts:4"], "quotes": ["only one"],
            }],
            "quotes_must_align",
        )

    def test_an_empty_quote_position_is_refused(self) -> None:
        self._refused(
            [{
                "id": "MS-1", "verdict": "satisfied", "evidence_class": "R2",
                "evidence_refs": ["src/a.ts:12"], "quotes": ["   "],
            }],
            "quotes_must_align",
        )

    def test_an_overlong_quote_is_refused(self) -> None:
        from aria_kernel.typed_judgment import QUOTE_MAX_CHARS
        self._refused(
            [{
                "id": "MS-1", "verdict": "satisfied", "evidence_class": "R2",
                "evidence_refs": ["src/a.ts:12"], "quotes": ["x" * (QUOTE_MAX_CHARS + 1)],
            }],
            "quotes_must_align",
        )

    def test_an_r4_row_without_a_reproduction_is_refused(self) -> None:
        self._refused(
            [{"id": "MS-1", "verdict": "satisfied", "evidence_class": "R4"}],
            "reproduction_required_on_r4",
        )

    def test_a_reproduction_with_the_wrong_shape_is_refused(self) -> None:
        self._refused(
            [{
                "id": "MS-1", "verdict": "satisfied", "evidence_class": "R4",
                "reproduction": {"recipe_id": "REC-1", "expected": "purple"},
            }],
            "reproduction_invalid",
        )
        self._refused(
            [{
                "id": "MS-1", "verdict": "satisfied", "evidence_class": "R4",
                "reproduction": {"recipe_id": "REC-1", "expected": "red", "note": "trust me"},
            }],
            "reproduction_invalid",
        )

    def test_a_reproduction_on_a_non_r4_row_is_refused(self) -> None:
        self._refused(
            [{
                "id": "MS-1", "verdict": "satisfied", "evidence_class": "R1",
                "reproduction": {"recipe_id": "REC-1", "expected": "red"},
            }],
            "reproduction_requires_r4",
        )


class RowsThatStandStillPass(unittest.TestCase):
    def test_a_load_bearing_row_with_aligned_quotes_passes(self) -> None:
        validate_response(_response([{
            "id": "MS-1", "verdict": "satisfied", "evidence_class": "R2",
            "evidence_refs": ["src/a.ts:12"], "quotes": ["export async function run("],
        }]))

    def test_an_r4_row_with_a_recipe_binding_passes(self) -> None:
        validate_response(_response([{
            "id": "MS-1", "verdict": "satisfied", "evidence_class": "R4",
            "reproduction": {"recipe_id": "REC-42", "expected": "red"},
        }]))

    def test_a_legacy_row_without_any_new_field_still_passes(self) -> None:
        validate_response(_response([{"id": "MS-1", "verdict": "satisfied"}]))

    def test_the_rendered_contract_tells_the_model_the_assertion_row_law(self) -> None:
        from aria_kernel.agent_contract import render_response_validator_contract
        text = render_response_validator_contract()
        self.assertIn("evidence_class", text)
        self.assertIn("R4", text)
        self.assertIn("recipe_id", text)


if __name__ == "__main__":
    unittest.main()
