"""WP-P — the matrix invariant: no dispatchable role serves fewer than two providers.

Operator requirement (HANDOVER 2026-10-18 §7 / WP-P package §2): "Matrix
invariant: no role has fewer than 2 runnable providers. The exception is a
role that the operator explicitly pins."

The invariant is a CONSUMER of the matrix, never a second gate: the runnable
verdicts are the generator's (computed from the production accessors), the
floor and the exceptions are the operator's (``tests/fixtures/
role_provider_matrix_pins.json``), and a failing cell is named exactly so the
fix is one edit in the owner of the fact it broke — the routing table, the
envelope or the fleet — never a hand-edit of the artifact.
"""
from __future__ import annotations

import json
import unittest
from pathlib import Path

from tests._helpers.role_provider_matrix import seat_rows

REPO_ROOT = Path(__file__).resolve().parents[2]
PINS_PATH = Path(__file__).resolve().parent / "fixtures" / "role_provider_matrix_pins.json"


def _pins() -> dict:
    document = json.loads(PINS_PATH.read_text(encoding="utf-8"))
    assert document["schema_version"] == 1, "role_provider_matrix_pins.json: unknown schema_version"
    return document


class NoRoleServesFewerThanTheFloor(unittest.TestCase):
    def test_every_dispatchable_role_meets_the_runnable_floor(self):
        pins = _pins()
        floor = pins["minimum_runnable_providers"]
        pinned_roles = {cell["role"] for cell in pins["operator_pinned"]}
        rows = seat_rows(REPO_ROOT)
        self.assertTrue(rows)
        failures = []
        for row in rows:
            runnable = row.runnable_providers
            if len(runnable) >= floor:
                continue
            if row.role in pinned_roles:
                # The operator excused the shortfall; the pin file's own
                # honesty tests keep the excuse real (a pin must name a
                # refusing cell and carry the decision).
                continue
            refused = [f"{cell.provider} ({cell.reason})" for cell in row.cells if not cell.runnable]
            failures.append(
                f"{row.role}/{row.seat}: {len(runnable)} runnable provider(s) "
                f"{list(runnable)} < floor {floor}; refused: {refused}"
            )
        self.assertEqual(failures, [], "\n".join(failures))

    def test_the_write_seats_refusal_names_the_fleet_fact(self):
        # The one structurally empty cell of WP-P round 1: the write seat on
        # the Codex provider. Today it is legitimately counted (the role still
        # has its two Anthropic/Z.ai rungs); this pin states WHERE the third
        # rung is refused, so the commit that opens it flips exactly this cell.
        rows = {row.role: row for row in seat_rows(REPO_ROOT) if row.role == "implementation"}
        (row,) = rows.values()
        openai = next(cell for cell in row.cells if cell.provider == "openai")
        self.assertFalse(openai.runnable)
        self.assertEqual(openai.reason, "refused: provider_readonly_runtime (admits_writes=False)")
        self.assertEqual(row.runnable_providers, ("anthropic", "zai"))


class ThePinListIsHonest(unittest.TestCase):
    def test_every_pin_names_a_real_role_and_provider(self):
        from aria_kernel.agent_surface import DISPATCHABLE_ROLES
        from aria_kernel.model_fleet import _FLEET

        fleet = {provider.key for provider in _FLEET}
        for cell in _pins()["operator_pinned"]:
            self.assertIn(cell["role"], DISPATCHABLE_ROLES, cell)
            self.assertIn(cell["provider"], fleet, cell)
            self.assertTrue(cell.get("decided_by") and cell.get("date") and cell.get("note"), cell)

    def test_a_pinned_cell_actually_refuses(self):
        matrix = {(row.role, cell.provider): cell for row in seat_rows(REPO_ROOT) for cell in row.cells}
        for cell in _pins()["operator_pinned"]:
            self.assertFalse(matrix[(cell["role"], cell["provider"])].runnable, cell)


if __name__ == "__main__":
    unittest.main()
