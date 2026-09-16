"""implementer_turn_budget — the implementer turn cap is policy, not a literal.

Operator decision 2026-09-12: the cap the seventh pre-merge predicate
(``cycle_and_turn_budget_cap``, policy §14) admits an implementer's
Edit/Write/Bash turns against is a POLICY value with a kernel default of 120,
not the literal 10 ``turn_budget.IMPLEMENTER_TURN_BUDGET`` carried. These
tests pin the policy half; the readers (settings, hook, evidence, predicate)
are pinned in ``tests/test_turn_budget.py``:

* the block ships in the default file with ``budgeted_turns`` = 120, joins
  ``POLICY_KEYS`` (so an override merges instead of being dropped), and the
  typed accessor returns the int;
* an operator override under ``<workspace>/aria-config/genesis_policy.json``
  is honoured through the shallow merge; an empty block keeps the default;
  an annotation key (``_comment``, the template's shape) is not
  configuration and is not refused;
* a block that is not an object, or a configuration key the block does not
  know (a misspelled ``budgeted_turns``), is REFUSED with the key named —
  the cap never silently runs on the default over a mistake the operator
  cannot see;
* zero, negative, above-ceiling, boolean, float, string and null values are
  REFUSED with the bound named — a policy cannot switch the cap off;
* the ceiling is derived from the widest plan the kernel converges
  (2 × ``plan_convergence.MAX_AFFECTED_PATHS``);
* which workspace's policy binds a store is ``bound_workspace_root``'s
  answer: a bound store reads the workspace it is bound to, a legacy store
  reads its parent — never the process cwd or the kernel default; the store
  is required, and an explicit ``None`` is refused even when
  ``ARIA_TOOLS_DIR`` names a store whose policy could have answered.
"""
from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from aria_kernel.genesis_policy import DEFAULT_FILENAME, OVERRIDE_RELPATH, POLICY_KEYS
from aria_kernel.plan_convergence import MAX_AFFECTED_PATHS
from aria_kernel.tool_registry import GovernanceError, ensure_tools_binding, ensure_tools_dir
from aria_kernel.turn_budget_policy import (
    ANNOTATION_KEY_PREFIX,
    IMPLEMENTER_TURN_BUDGET_DEFAULTS,
    IMPLEMENTER_TURN_BUDGET_MAX_TURNS,
    POLICY_BLOCK,
    implementer_turn_budget_for_store,
    implementer_turn_budget_policy,
)


def write_override(workspace_root: Path, block: object) -> Path:
    """The operator's seam: one block under ``<workspace>/aria-config/genesis_policy.json``."""
    path = workspace_root / OVERRIDE_RELPATH
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({POLICY_BLOCK: block}), encoding="utf-8")
    return path


class PolicyBlockAndDefault(unittest.TestCase):
    def test_the_kernel_default_is_sixty_and_ships_in_the_default_file(self) -> None:
        self.assertEqual(POLICY_BLOCK, "implementer_turn_budget")
        self.assertEqual(IMPLEMENTER_TURN_BUDGET_DEFAULTS, {"budgeted_turns": 120})
        # The default file is the operator-visible authority: a key absent
        # there is a value the operator cannot see.
        shipped = json.loads(
            (Path(__file__).resolve().parents[1] / "aria_kernel" / "data" / DEFAULT_FILENAME).read_text(encoding="utf-8")
        )
        self.assertEqual(shipped[POLICY_BLOCK]["budgeted_turns"], 120)
        self.assertIn(POLICY_BLOCK, POLICY_KEYS, "a key outside POLICY_KEYS is dropped by the merge")
        block = implementer_turn_budget_policy()
        self.assertEqual(block, {"budgeted_turns": 120})
        self.assertIs(type(block["budgeted_turns"]), int)
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(implementer_turn_budget_policy(tmp), {"budgeted_turns": 120})

    def test_the_ceiling_is_two_turns_per_affected_path_of_the_widest_plan(self) -> None:
        # One Edit and one validating Bash turn per affected path of the
        # widest plan the kernel converges: no admissible plan argues for
        # more from its own size, so past it a "cap" is no longer one.
        self.assertEqual(IMPLEMENTER_TURN_BUDGET_MAX_TURNS, 2 * MAX_AFFECTED_PATHS)
        self.assertEqual(IMPLEMENTER_TURN_BUDGET_MAX_TURNS, 400)
        self.assertGreater(IMPLEMENTER_TURN_BUDGET_MAX_TURNS, IMPLEMENTER_TURN_BUDGET_DEFAULTS["budgeted_turns"])


class OverrideAndValidation(unittest.TestCase):
    def test_an_override_is_honoured_through_the_merge_and_an_empty_block_keeps_the_default(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            write_override(Path(tmp), {"budgeted_turns": 25})
            self.assertEqual(implementer_turn_budget_policy(tmp), {"budgeted_turns": 25})
            write_override(Path(tmp), {"budgeted_turns": IMPLEMENTER_TURN_BUDGET_MAX_TURNS})
            self.assertEqual(implementer_turn_budget_policy(tmp)["budgeted_turns"], IMPLEMENTER_TURN_BUDGET_MAX_TURNS)
            write_override(Path(tmp), {"budgeted_turns": 1})
            self.assertEqual(implementer_turn_budget_policy(tmp)["budgeted_turns"], 1)
            write_override(Path(tmp), {})
            self.assertEqual(implementer_turn_budget_policy(tmp), {"budgeted_turns": 120})
            # The operator template ships the block with a ``_comment`` next
            # to the number; an operator who copies it must not be refused.
            # The shipped default carries ``_doc`` the same way (pinned by
            # the default-file test above).
            self.assertEqual(ANNOTATION_KEY_PREFIX, "_")
            write_override(Path(tmp), {"_comment": "why 25", "budgeted_turns": 25})
            self.assertEqual(implementer_turn_budget_policy(tmp), {"budgeted_turns": 25})

    def test_a_block_of_the_wrong_shape_or_with_an_unknown_key_is_refused_not_defaulted(self) -> None:
        # RC-4: ``"implementer_turn_budget": 30`` is the number the operator
        # meant to write under ``budgeted_turns``, and ``budget_turns: 25``
        # is a misspelling. Both used to yield the default 60 silently, so
        # the operator's model said 30 (or 25) while the hook admitted 60 —
        # the same class as a silently corrected number.
        not_an_object = "genesis_policy_implementer_turn_budget_block_not_an_object"
        unknown_key = "genesis_policy_implementer_turn_budget_unknown_key"
        shapes = (
            (30, f"{not_an_object}: {POLICY_BLOCK}=30"),
            ("60", f"{not_an_object}: {POLICY_BLOCK}='60'"),
            ([60], f"{not_an_object}: {POLICY_BLOCK}=[60]"),
            (None, f"{not_an_object}: {POLICY_BLOCK}=None"),
            ({"budget_turns": 25}, f"{unknown_key}: budget_turns"),
            ({"budgeted_turns": 25, "max_turns": 90}, f"{unknown_key}: max_turns"),
            ({"z": 1, "a": 2, "budgeted_turns": 25}, f"{unknown_key}: a, z"),
            # An unknown key is refused even next to an annotation, and the
            # annotation itself is never named as an offender.
            ({"_comment": "x", "turns": 25}, f"{unknown_key}: turns"),
        )
        for raw_block, first_sentence in shapes:
            with self.subTest(block=raw_block), tempfile.TemporaryDirectory() as tmp:
                write_override(Path(tmp), raw_block)
                with self.assertRaises(GovernanceError) as caught:
                    implementer_turn_budget_policy(tmp)
                message = str(caught.exception)
                self.assertEqual(message.split(". ", 1)[0], first_sentence)
                self.assertIn("budgeted_turns", message, "the refusal names the key the operator should write")

    def test_out_of_contract_values_are_refused_with_the_bound_named(self) -> None:
        cases = (
            (0, "genesis_policy_implementer_turn_budget_not_positive"),
            (-1, "genesis_policy_implementer_turn_budget_not_positive"),
            (IMPLEMENTER_TURN_BUDGET_MAX_TURNS + 1, "genesis_policy_implementer_turn_budget_above_ceiling"),
            (10 ** 9, "genesis_policy_implementer_turn_budget_above_ceiling"),
            (True, "genesis_policy_implementer_turn_budget_not_an_integer"),
            (60.0, "genesis_policy_implementer_turn_budget_not_an_integer"),
            ("60", "genesis_policy_implementer_turn_budget_not_an_integer"),
            (None, "genesis_policy_implementer_turn_budget_not_an_integer"),
        )
        for raw, reason in cases:
            with self.subTest(raw=raw), tempfile.TemporaryDirectory() as tmp:
                write_override(Path(tmp), {"budgeted_turns": raw})
                with self.assertRaises(GovernanceError) as caught:
                    implementer_turn_budget_policy(tmp)
                message = str(caught.exception)
                self.assertTrue(message.startswith(reason), message)
                self.assertIn(repr(raw), message)
                # RC-4 discipline: the refusal names the bound, so the
                # operator learns the contract from the error itself.
                self.assertIn(str(IMPLEMENTER_TURN_BUDGET_MAX_TURNS), message)


class WhichWorkspacesPolicyBindsAStore(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name).resolve()
        # The cap must never come from the process cwd or its ancestors.
        self._env = mock.patch.dict(os.environ, {}, clear=False)
        self._env.start()
        os.environ.pop("ARIA_TOOLS_DIR", None)

    def tearDown(self) -> None:
        self._env.stop()
        self._tmp.cleanup()

    def test_a_legacy_store_reads_its_parent_workspace(self) -> None:
        workspace = self.root / "legacy"
        tools = ensure_tools_dir(workspace / "aria-tools")
        self.assertEqual(implementer_turn_budget_for_store(tools), 120)
        write_override(workspace, {"budgeted_turns": 33})
        self.assertEqual(implementer_turn_budget_for_store(tools), 33)
        write_override(workspace, {"budgeted_turns": 0})
        with self.assertRaises(GovernanceError):
            implementer_turn_budget_for_store(tools)

    def test_the_store_is_required_and_the_env_fallback_is_refused_not_taken(self) -> None:
        # ``tools_dir(None)`` would resolve through ARIA_TOOLS_DIR (then a
        # walk up from the cwd) to a store the caller never named. With the
        # env pointing at a store whose policy says 33, the reader must
        # refuse rather than answer 33 — the spawn and the merge each name
        # the store they act on, and a cap read for any other store is the
        # ARIA-HIGH-079 class. A keyword-only, non-Optional signature is
        # prose to a Python runtime; the refusal is what binds.
        workspace = self.root / "env"
        tools = ensure_tools_dir(workspace / "aria-tools")
        write_override(workspace, {"budgeted_turns": 33})
        os.environ["ARIA_TOOLS_DIR"] = str(tools)
        self.assertEqual(implementer_turn_budget_for_store(tools), 33, "named explicitly: the store's policy")
        with self.assertRaises(GovernanceError) as caught:
            implementer_turn_budget_for_store(None)
        self.assertTrue(str(caught.exception).startswith("implementer_turn_budget_store_unnamed"), str(caught.exception))
        with self.assertRaises(TypeError):
            implementer_turn_budget_for_store()  # the argument is positional and required
        from aria_kernel.runtime_profiles import profile_by_id
        from aria_kernel.turn_budget import turn_budget_for

        with self.assertRaises(GovernanceError):
            turn_budget_for(profile_by_id("implementer"), base_dir=None)
        with self.assertRaises(TypeError):
            turn_budget_for(profile_by_id("implementer"))  # base_dir is keyword-only and required

    def test_a_bound_store_reads_the_workspace_it_is_bound_to_not_its_parent(self) -> None:
        from tests._helpers.git_fixtures import make_local_git_repo

        repo = make_local_git_repo(self.root, name="repo")
        # The store lives under trial/store/tools (ARIA-HIGH-079's shape):
        # its parent carries a policy that must NOT bind, the bound
        # workspace carries the one that must.
        store_parent = self.root / "trial" / "store"
        tools = ensure_tools_dir(store_parent / "tools")
        write_override(store_parent, {"budgeted_turns": 7})
        self.assertEqual(implementer_turn_budget_for_store(tools), 7, "unbound: the parent is the workspace")
        ensure_tools_binding(tools, workspace_root=repo)
        self.assertEqual(implementer_turn_budget_for_store(tools), 120, "bound: the parent's policy no longer binds")
        write_override(repo, {"budgeted_turns": 44})
        self.assertEqual(implementer_turn_budget_for_store(tools), 44)


if __name__ == "__main__":
    unittest.main()
