"""The hash was minted over one object and verified against another.

`prompt_hash` is taken over the request row. The executor verifies it by
re-rendering whatever `claim_request` hands back. Those have to be the same
object as far as the renderer can tell, and they were not: the fused response
defaulted the optional list fields — `envelope.get("forbidden_scope", [])` and
two siblings — so a row that simply omits them came back carrying empty lists,
and the renderer distinguishes an absent key from a present-and-empty one.

Measured on production state (`aria/state`, 2026-08-09): **all 17** requests
carrying a `prompt_hash` failed to reproduce it through the claim response, and
all 17 reproduce it from the raw row. The executor had been refusing its own
kernel's envelope, every claim, forever — which is why the same request kept
coming back and the queue never drained.

The tests below pin the property (a round trip reproduces the binding), not the
key list, and one derives the renderer's key set from the renderer itself: a
hand-maintained list of "fields the prompt is made of" is precisely what went
stale here, so a future renderer that reads a new key must fail a test rather
than quietly wedge the queue again.
"""
from __future__ import annotations

import ast
import inspect
import textwrap
import unittest

from aria_kernel import agent_invocations as ai


def _row(**overrides: object) -> dict[str, object]:
    """A request row shaped like the ones the autonomy orchestrator mints.

    Deliberately WITHOUT forbidden_scope / impact_graph_refs /
    validation_commands: their absence is the live shape, and the defect only
    appears for rows that omit a key.
    """
    row: dict[str, object] = {
        "request_id": "AIR-test-binding-0001",
        "role": "maintenance_utility",
        "target_agent": "aria-autonomy-planner",
        "expected_output_path": "aria-tools/out/x.json",
        "suggested_prompt": "do the thing",
        "must_satisfy": [{"id": "M1", "criterion": "be right"}],
        "allowed_scope": ["aria-kernel/**"],
        "evidence_refs": ["docs/x.md:1"],
        "repository_map": {"projects": ["aria-kernel"]},
        "cycle_id": "cyc-1",
    }
    row.update(overrides)
    row["prompt_hash"] = ai._sha256_text(ai.render_invocation_prompt(row))
    return row


class FusedEnvelopeReproducesBindingTest(unittest.TestCase):
    def test_a_row_that_omits_optional_fields_still_verifies(self) -> None:
        # The live shape. Before the fix the fused copy invented [] for the
        # three absent keys and the digest could not be reproduced.
        row = _row()

        fused = ai._fuse_prompt_envelope(row)
        rendered = ai._sha256_text(ai.render_invocation_prompt(fused))

        self.assertEqual(rendered, row["prompt_hash"])

    def test_absence_is_carried_through_as_absence(self) -> None:
        fused = ai._fuse_prompt_envelope(_row())

        for key in ("forbidden_scope", "impact_graph_refs", "validation_commands"):
            self.assertNotIn(key, fused, f"{key} was invented by the copy")

    def test_a_row_that_sets_them_explicitly_also_verifies(self) -> None:
        # The other direction: an explicitly empty list is a value somebody
        # minted, and it must survive rather than be dropped.
        row = _row(forbidden_scope=[], impact_graph_refs=["a"], validation_commands=[])

        fused = ai._fuse_prompt_envelope(row)

        self.assertEqual(fused["forbidden_scope"], [])
        self.assertEqual(fused["impact_graph_refs"], ["a"])
        self.assertEqual(
            ai._sha256_text(ai.render_invocation_prompt(fused)), row["prompt_hash"]
        )

    def test_the_guard_refuses_an_envelope_that_cannot_reproduce_its_hash(self) -> None:
        # Genuine tampering must still be caught — this fix must not turn the
        # binding check into a formality.
        row = _row()
        row["suggested_prompt"] = "something else entirely"

        with self.assertRaises(ai.GovernanceError) as caught:
            ai._assert_envelope_reproduces_binding(row)

        self.assertIn("claim_envelope_does_not_reproduce_prompt_binding", str(caught.exception))

    def test_a_row_with_no_recorded_hash_is_left_alone(self) -> None:
        # Rows minted before the binding existed have nothing to reproduce;
        # refusing them here would strand them with no path forward.
        row = _row()
        del row["prompt_hash"]

        ai._assert_envelope_reproduces_binding(row)


class KeySetIsDerivedFromTheRendererTest(unittest.TestCase):
    """The list must not be maintained by memory.

    A hand-written "these are the fields the prompt is made of" list is what
    went stale: `request_id` is printed in the heading and was missing from the
    first draft of the fused set, which reproduced the same defect one field
    over. A renderer that starts reading a new top-level key now fails here.
    """

    def test_every_top_level_key_the_renderer_reads_is_carried(self) -> None:
        tree = ast.parse(
            textwrap.dedent(inspect.getsource(ai.render_invocation_prompt))
        )
        read: set[str] = set()
        for node in ast.walk(tree):
            if (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr in {"get", "pop"}
                and node.args
                and isinstance(node.args[0], ast.Constant)
                and isinstance(node.args[0].value, str)
            ):
                read.add(node.args[0].value)
            if (
                isinstance(node, ast.Subscript)
                and isinstance(node.slice, ast.Constant)
                and isinstance(node.slice.value, str)
            ):
                read.add(node.slice.value)

        # Keys read off the ITEMS of a list field (a must_satisfy entry, a
        # validation command) are not top-level envelope fields.
        nested = {"cmd", "criterion", "description", "id"}
        top_level = read - nested

        missing = sorted(top_level - set(ai._FUSED_ENVELOPE_KEYS))
        self.assertEqual(
            missing,
            [],
            f"the renderer reads {missing}, which the claim response drops — "
            "every claim would fail its own binding check",
        )


if __name__ == "__main__":
    unittest.main()
