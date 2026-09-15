"""The block vocabulary: every token a candidate producer mints names its owner.

Live shape this pins (origin/aria/state `tools/governance.jsonl`, read
2026-09-12): 71 ``mission_candidate_refused reason=candidate_blocked`` rows
from 2026-08-13 to 2026-09-04, every one a ``shadow_run_summary`` (42) or
``capability_gap shadow_run:*`` (29) candidate. Joined to the task-candidate
payloads on (cycle_id, source, source_id), 43 carried the panel's
``genesis_adjudication_required``, 15 the operator's pre-Y8
``operator_feedback_required``, and 13 predate the first stored payload —
two different owners, disclosed with one reason that could not be told apart
from "repair the registry".

Two pins. `describe_candidate_block` resolves a token list to ONE owner and
the operator's sentence, and refuses to describe nothing. And an AST walk over
the producers (`capability_gap`, `task`, `pressure`) asserts that every
``blocked_by`` literal they mint has a row in `CANDIDATE_BLOCKS` — a new token
cannot appear in a refusal row without also saying who clears it.
"""
from __future__ import annotations

import ast
import unittest
from pathlib import Path

from aria_kernel import capability_gap
from aria_kernel.candidate_blocks import (
    CANDIDATE_BLOCKS,
    GENESIS_ADJUDICATION_REQUIRED,
    OWNER_AGENT_PANEL,
    OWNER_OPERATOR,
    describe_candidate_block,
    lookup_candidate_block,
)
from aria_kernel.tool_registry import GovernanceError

_KERNEL = Path(__file__).resolve().parents[1] / "aria_kernel"
# The modules that MINT candidate-level `blocked_by` tokens. Readiness /
# validation / apply-engine `blocked_by` lists are packet gates, a different
# vocabulary with different readers, and are deliberately not walked here.
_PRODUCERS = ("capability_gap.py", "task.py", "pressure.py")
# Names a producer may use in place of a literal, resolved to their value.
_KNOWN_NAMES = {
    "GENESIS_ADJUDICATION_BLOCK_TOKEN": GENESIS_ADJUDICATION_REQUIRED,
    "GENESIS_ADJUDICATION_REQUIRED": GENESIS_ADJUDICATION_REQUIRED,
}


class DescribeCandidateBlock(unittest.TestCase):
    def test_the_genesis_token_belongs_to_the_panel_and_asks_nothing_of_the_operator(self) -> None:
        block = describe_candidate_block([GENESIS_ADJUDICATION_REQUIRED])

        self.assertEqual(block["owner"], OWNER_AGENT_PANEL)
        self.assertEqual(block["blocked_by"], [GENESIS_ADJUDICATION_REQUIRED])
        self.assertTrue(block["operator_action"].startswith(f"{GENESIS_ADJUDICATION_REQUIRED}: none:"))
        self.assertIn("sweep_candidate_gaps_for_adjudication", block["operator_action"])
        self.assertEqual(block["unregistered"], [])

    def test_an_operator_token_names_the_repair(self) -> None:
        block = describe_candidate_block(["registry_repair_required"])

        self.assertEqual(block["owner"], OWNER_OPERATOR)
        self.assertIn("repair aria-tools/registry.json", block["operator_action"])

    def test_a_parameterized_token_matches_on_its_prefix_and_keeps_its_parameter(self) -> None:
        block = describe_candidate_block(["candidate_tool_unregistered:typeorm-entity-schema-adapter"])

        self.assertEqual(block["owner"], OWNER_OPERATOR)
        self.assertIn("candidate_tool_unregistered:typeorm-entity-schema-adapter:", block["operator_action"])
        # The bare prefix is not a token: it names no tool.
        self.assertIsNone(lookup_candidate_block("candidate_tool_unregistered:"))

    def test_the_operator_owns_a_candidate_that_carries_any_operator_token(self) -> None:
        block = describe_candidate_block([GENESIS_ADJUDICATION_REQUIRED, "manifest_required"])

        self.assertEqual(block["owner"], OWNER_OPERATOR)
        self.assertIn("manifest_required:", block["operator_action"])
        self.assertIn(f"{GENESIS_ADJUDICATION_REQUIRED}:", block["operator_action"])

    def test_an_unregistered_token_is_disclosed_and_handed_to_the_operator(self) -> None:
        block = describe_candidate_block(["something_new_required"])

        self.assertEqual(block["owner"], OWNER_OPERATOR)
        self.assertEqual(block["unregistered"], ["something_new_required"])
        self.assertIn("add a CandidateBlock row in aria_kernel/candidate_blocks.py", block["operator_action"])

    def test_describing_no_block_is_refused(self) -> None:
        with self.assertRaises(GovernanceError):
            describe_candidate_block([])
        with self.assertRaises(GovernanceError):
            describe_candidate_block(["", None])

    def test_the_vocabulary_has_no_duplicate_tokens(self) -> None:
        tokens = [block.token for block in CANDIDATE_BLOCKS]
        self.assertEqual(len(tokens), len(set(tokens)), tokens)

    def test_the_producer_and_the_vocabulary_share_one_genesis_literal(self) -> None:
        self.assertIs(capability_gap.GENESIS_ADJUDICATION_BLOCK_TOKEN, GENESIS_ADJUDICATION_REQUIRED)


def _minted_tokens(source: str) -> list[tuple[str, str]]:
    """``(token_or_prefix, kind)`` for every ``blocked_by`` literal the module
    mints: ``kind`` is ``exact`` for a string constant / known name and
    ``prefix`` for an f-string whose leading constant is the token prefix."""
    minted: list[tuple[str, str]] = []

    def _elements(node: ast.AST) -> None:
        if isinstance(node, ast.ListComp):
            elements: list[ast.expr] = [node.elt]
        elif isinstance(node, ast.List):
            elements = list(node.elts)
        else:
            return
        for element in elements:
            if isinstance(element, ast.Constant) and isinstance(element.value, str):
                minted.append((element.value, "exact"))
            elif isinstance(element, ast.Name) and element.id in _KNOWN_NAMES:
                minted.append((_KNOWN_NAMES[element.id], "exact"))
            elif isinstance(element, ast.JoinedStr) and element.values:
                head = element.values[0]
                if isinstance(head, ast.Constant) and isinstance(head.value, str):
                    minted.append((head.value, "prefix"))

    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.keyword) and node.arg == "blocked_by":
            _elements(node.value)
        elif isinstance(node, ast.Dict):
            for key, value in zip(node.keys, node.values):
                if isinstance(key, ast.Constant) and key.value == "blocked_by":
                    _elements(value)
        elif isinstance(node, ast.Assign):
            for target in node.targets:
                if (
                    isinstance(target, ast.Subscript)
                    and isinstance(target.slice, ast.Constant)
                    and target.slice.value == "blocked_by"
                ):
                    _elements(node.value)
    return minted


class EveryMintedTokenIsRegistered(unittest.TestCase):
    def test_the_producers_mint_only_registered_tokens(self) -> None:
        seen = 0
        for name in _PRODUCERS:
            for token, kind in _minted_tokens((_KERNEL / name).read_text(encoding="utf-8")):
                seen += 1
                with self.subTest(module=name, token=token):
                    if kind == "exact":
                        self.assertIsNotNone(lookup_candidate_block(token), f"{name} mints unregistered {token!r}")
                    else:
                        matches = [b for b in CANDIDATE_BLOCKS if b.parameterized and b.token == token]
                        self.assertEqual(len(matches), 1, f"{name} mints unregistered prefix {token!r}")
        # The walk found the producers; an empty walk would pass vacuously.
        self.assertGreaterEqual(seen, 7)

    def test_the_walker_reads_the_shapes_the_producers_use(self) -> None:
        source = (
            'a = _gap(blocked_by=["x_required"])\n'
            'b = {"blocked_by": [GENESIS_ADJUDICATION_BLOCK_TOKEN]}\n'
            'row["blocked_by"] = [f"tool_missing:{tool_id}" for tool_id in missing]\n'
        )
        # `ast.walk` is breadth-first; the SET of minted tokens is the claim.
        self.assertEqual(
            set(_minted_tokens(source)),
            {
                ("x_required", "exact"),
                (GENESIS_ADJUDICATION_REQUIRED, "exact"),
                ("tool_missing:", "prefix"),
            },
        )


if __name__ == "__main__":
    unittest.main()
