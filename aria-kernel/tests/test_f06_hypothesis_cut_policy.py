"""F0.6 — the refuted-hypothesis cut: its pre-registered value is parsed strictly.

State at the branch base (measured, not assumed): the night planner admits an
experiment every night while its finding stays open and unreproduced, and the
number of non-matching observations after which a hypothesis stops being run
is written nowhere. PLAN-v2 principle 3: a threshold is pre-registered in
``genesis_policy``, never in code.

What this file pins (SPEC D-3, D-4, D-7):

  * the shipped block ``hypothesis_cut`` = ``{"max_nonmatching_observations": 5,
    "exempt_experiments": []}`` and its place in ``POLICY_KEYS``;
  * the accessor ``genesis_policy.hypothesis_cut_policy`` parses it strictly:
    every key required, an unknown key (there is no ``enabled`` switch on
    purpose) or an out-of-range / mistyped value refused by its dotted path,
    nothing filled from a default;
  * the one new generic check ``preregistered_policy.labels(max_len=...)``;
  * the contract through the night: a refused block makes the planner raise
    before any run, never fall back to "no cut".

New API pins (each is red at the branch base because the name is absent, and
says so by assertion, not by an import error): ``genesis_policy.hypothesis_cut_policy``,
``preregistered_policy.labels``, the ``"hypothesis_cut"`` entry of ``POLICY_KEYS``.
``test_a_refused_block_stops_the_night_before_any_run`` is red at base for the
defect itself: with a candidate and a broken override the runner is called once.
"""
from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from pathlib import Path
from typing import Any

from aria_kernel import genesis_policy, preregistered_policy
from aria_kernel.experiment import register_recipe
from aria_kernel.experiment_night import plan_night_experiments, run_night_experiments
from aria_kernel.finding import emit_finding
from aria_kernel.tool_registry import GovernanceError
from tests import test_experiment_night as _night

SHIPPED_BLOCK = {"max_nonmatching_observations": 5, "exempt_experiments": []}


def write_override(workspace: Path, block: Any) -> None:
    """Write ``aria-config/genesis_policy.json`` the way the operator does: the block, whole."""
    path = workspace / genesis_policy.OVERRIDE_RELPATH
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"hypothesis_cut": block}), encoding="utf-8")


def public(block: dict[str, Any]) -> dict[str, Any]:
    """The registered keys of a parsed block (keys starting with ``_`` are operator prose)."""
    return {key: value for key, value in block.items() if not str(key).startswith("_")}


def accessor(test: unittest.TestCase):
    """The new accessor, reached by name so its absence is an assertion failure."""
    found = getattr(genesis_policy, "hypothesis_cut_policy", None)
    test.assertTrue(callable(found), "genesis_policy.hypothesis_cut_policy is not defined (F0.6 D-3)")
    return found


def registered_n(test: unittest.TestCase) -> int:
    """N as the planner reads it: from the pre-registered block, through the accessor."""
    return accessor(test)()["max_nonmatching_observations"]


class ShippedBlockTests(unittest.TestCase):
    def test_the_key_joins_the_policy_contract(self) -> None:
        self.assertIn("hypothesis_cut", genesis_policy.POLICY_KEYS)

    def test_the_shipped_default_carries_the_block(self) -> None:
        self.assertIn("hypothesis_cut", genesis_policy.default_policy())

    def test_the_accessor_parses_the_shipped_block(self) -> None:
        self.assertEqual(public(accessor(self)()), SHIPPED_BLOCK)

    def test_the_default_policy_and_the_accessor_agree(self) -> None:
        shipped = genesis_policy.default_policy().get("hypothesis_cut")
        self.assertIsInstance(shipped, dict, "default_policy() carries no hypothesis_cut block")
        self.assertEqual(public(shipped), SHIPPED_BLOCK)

    def test_the_override_merge_honours_the_key(self) -> None:
        block = {"max_nonmatching_observations": 7, "exempt_experiments": ["exp-x"]}
        merged = genesis_policy.merge_with_override(genesis_policy.default_policy(), {"hypothesis_cut": block})
        self.assertEqual(merged.get("hypothesis_cut"), block)

    def test_a_valid_override_is_the_policy(self) -> None:
        block = {"max_nonmatching_observations": 7, "exempt_experiments": ["exp-auto-f-009", "exp.b-2"]}
        tmp = Path(tempfile.mkdtemp(prefix="aria-f06-policy-"))
        self.addCleanup(shutil.rmtree, tmp, True)
        write_override(tmp, block)
        self.assertEqual(public(accessor(self)(tmp)), block)
        # the shipped number is not shadowed for a workspace that carries no override
        self.assertEqual(public(accessor(self)()), SHIPPED_BLOCK)

    def test_an_override_replaces_the_block_whole(self) -> None:
        # No ``enabled`` switch and no default fill: the override states every key or is refused.
        tmp = Path(tempfile.mkdtemp(prefix="aria-f06-policy-"))
        self.addCleanup(shutil.rmtree, tmp, True)
        write_override(tmp, {"max_nonmatching_observations": 9})
        with self.assertRaises(GovernanceError):
            accessor(self)(tmp)


class StrictParserTests(unittest.TestCase):
    """SPEC P2 — each refusal names ``hypothesis_cut.<key>`` and the code of the shared parser."""

    def _refusal(self, block: Any) -> str:
        found = accessor(self)
        tmp = Path(tempfile.mkdtemp(prefix="aria-f06-policy-"))
        self.addCleanup(shutil.rmtree, tmp, True)
        write_override(tmp, block)
        with self.assertRaises(GovernanceError) as refused:
            found(tmp)
        return str(refused.exception)

    def _accepted(self, block: dict[str, Any]) -> dict[str, Any]:
        found = accessor(self)
        tmp = Path(tempfile.mkdtemp(prefix="aria-f06-policy-"))
        self.addCleanup(shutil.rmtree, tmp, True)
        write_override(tmp, block)
        return public(found(tmp))

    @staticmethod
    def _block(**changes: Any) -> dict[str, Any]:
        return {**SHIPPED_BLOCK, **changes}

    def test_a_missing_key_is_refused_by_its_dotted_path(self) -> None:
        for key in SHIPPED_BLOCK:
            with self.subTest(key=key):
                block = self._block()
                del block[key]
                message = self._refusal(block)
                self.assertIn("key_missing", message)
                self.assertIn(f"hypothesis_cut.{key}", message)

    def test_an_unknown_key_is_refused_and_named(self) -> None:
        # ``enabled`` is the switch the design refuses on purpose: a boolean that turns the cut off
        # is how the 94-run pattern returns.
        for unknown in ("enabled", "bogus"):
            with self.subTest(unknown=unknown):
                message = self._refusal(self._block(**{unknown: False}))
                self.assertIn("key_unknown", message)
                self.assertIn("hypothesis_cut", message)
                self.assertIn(unknown, message)

    def test_the_limit_must_lie_in_two_to_fifty(self) -> None:
        for bad in (1, 0, -3, 51, 1000):
            with self.subTest(limit=bad):
                message = self._refusal(self._block(max_nonmatching_observations=bad))
                self.assertIn("value_out_of_range", message)
                self.assertIn("hypothesis_cut.max_nonmatching_observations", message)
        for good in (2, 5, 50):
            with self.subTest(limit=good):
                self.assertEqual(
                    self._accepted(self._block(max_nonmatching_observations=good))["max_nonmatching_observations"],
                    good,
                )

    def test_the_limit_must_be_a_whole_number_not_coerced(self) -> None:
        for bad in (True, 5.0, "5", None, [5]):
            with self.subTest(limit=bad):
                message = self._refusal(self._block(max_nonmatching_observations=bad))
                self.assertIn("value_not_a_whole_number", message)
                self.assertIn("hypothesis_cut.max_nonmatching_observations", message)

    def test_the_exemptions_must_be_a_list(self) -> None:
        for bad in ("exp-a", None, {"exp-a": 1}, 5):
            with self.subTest(exempt=bad):
                message = self._refusal(self._block(exempt_experiments=bad))
                self.assertIn("value_not_a_label_list", message)
                self.assertIn("hypothesis_cut.exempt_experiments", message)

    def test_an_exempt_entry_must_be_a_label(self) -> None:
        for bad in ("", " x", "x ", "exp a", "a\tb", "x" * 65, 5, None, ["exp-a"]):
            with self.subTest(entry=bad):
                message = self._refusal(self._block(exempt_experiments=["exp-fine", bad]))
                self.assertIn("value_not_a_label_list", message)
                self.assertIn("hypothesis_cut.exempt_experiments", message)

    def test_a_repeated_exemption_is_refused(self) -> None:
        message = self._refusal(self._block(exempt_experiments=["exp-a", "exp-b", "exp-a"]))
        self.assertIn("value_repeats_a_name", message)
        self.assertIn("hypothesis_cut.exempt_experiments", message)

    def test_experiment_ids_are_labels_not_snake_case_names(self) -> None:
        # ``preregistered_policy.names`` cannot carry these: they hold ``-`` and ``.`` and digits first.
        ids = ["exp-auto-f-009", "exp.b-2", "7-seven", "Recipe_X.v1"]
        self.assertEqual(self._accepted(self._block(exempt_experiments=ids))["exempt_experiments"], ids)

    def test_an_empty_exemption_list_is_a_value_not_a_missing_key(self) -> None:
        self.assertEqual(self._accepted(self._block(exempt_experiments=[]))["exempt_experiments"], [])

    def test_a_block_that_is_not_an_object_is_refused(self) -> None:
        for bad in (None, 5, "5", [5]):
            with self.subTest(block=bad):
                self.assertIn("block_not_an_object", self._refusal(bad))


class LabelsCheckTests(unittest.TestCase):
    """SPEC item 3 — ONE new generic check in the parser's own module, next to ``names``."""

    def _labels(self, max_len: int):
        built = getattr(preregistered_policy, "labels", None)
        self.assertTrue(callable(built), "preregistered_policy.labels is not defined (F0.6 item 3)")
        return built(max_len=max_len)

    def test_distinct_labels_pass_through_as_a_list(self) -> None:
        check = self._labels(8)
        self.assertEqual(check("w", ["ab", "a-b.c", "12345678"]), ["ab", "a-b.c", "12345678"])

    def test_an_empty_list_is_a_value(self) -> None:
        self.assertEqual(self._labels(8)("w", []), [])

    def test_a_non_list_is_refused_by_name(self) -> None:
        for bad in ("ab", None, 3, {"a": 1}):
            with self.subTest(raw=bad):
                with self.assertRaises(GovernanceError) as refused:
                    self._labels(8)("block.key", bad)
                self.assertTrue(
                    str(refused.exception).startswith("genesis_policy_preregistered_value_not_a_label_list: block.key"),
                    str(refused.exception),
                )

    def test_an_entry_that_is_not_a_label_is_refused(self) -> None:
        for bad in ("", " a", "a b", "a\n", "abcdefghi", 4, None):
            with self.subTest(entry=bad):
                with self.assertRaises(GovernanceError) as refused:
                    self._labels(8)("block.key", ["ok", bad])
                self.assertIn("value_not_a_label_list", str(refused.exception))
                self.assertIn("block.key", str(refused.exception))

    def test_the_length_bound_is_the_one_asked_for(self) -> None:
        self.assertEqual(self._labels(3)("w", ["abc"]), ["abc"])
        with self.assertRaises(GovernanceError):
            self._labels(3)("w", ["abcd"])

    def test_a_repeated_label_is_refused(self) -> None:
        with self.assertRaises(GovernanceError) as refused:
            self._labels(8)("block.key", ["a", "b", "a"])
        self.assertIn("value_repeats_a_name", str(refused.exception))


class RefusedBlockStopsTheNightTests(_night.NightBase):
    """SPEC P3 / D-7 — a refused block is raised before any run; it never reads as "no cut"."""

    def setUp(self) -> None:
        super().setUp()
        register_recipe(
            recipe_id="recipe-night", command="npx nx test farm-service",
            timeout_ms=60000, deterministic=True, base_dir=self.tools,
        )
        # One admissible candidate: at the branch base nothing reads the block, so the runner is called.
        record = emit_finding(
            repo_root=self.repo, base_dir=self.tools, claim_type="wrong_code",
            claim_summary="Module one computes the wrong tenant scope", severity="HIGH",
            evidences=_night._evidence(3), facts=["fact a", "fact b", "fact c"],
            scope_files=["apps/farm-service/src/module1.ts"],
        )
        self._bind_experiment(record["finding_id"], experiment_id="exp-p3")

    def _counting_runner(self):
        inner = self._fake_runner(matched=False, run_status="ok")
        calls: list[str] = []

        def run(**kwargs):
            calls.append(str(kwargs["experiment_id"]))
            return inner(**kwargs)

        return run, calls

    def test_the_planner_raises_on_an_incomplete_block(self) -> None:
        accessor(self)
        write_override(self.repo, {"max_nonmatching_observations": 5})
        with self.assertRaises(GovernanceError) as refused:
            plan_night_experiments(self.repo, base_dir=self.tools)
        self.assertIn("genesis_policy_preregistered_key_missing", str(refused.exception))
        self.assertIn("hypothesis_cut.exempt_experiments", str(refused.exception))

    def test_a_refused_block_stops_the_night_before_any_run(self) -> None:
        accessor(self)
        write_override(self.repo, {"max_nonmatching_observations": 5})
        runner, calls = self._counting_runner()
        with self.assertRaises(GovernanceError) as refused:
            run_night_experiments(self.repo, cycle_id="cycle-p3", base_dir=self.tools, runner=runner)
        self.assertIn("genesis_policy_preregistered_key_missing", str(refused.exception))
        self.assertEqual(calls, [], "a refused hypothesis_cut block must run no experiment that night")

    def test_every_kind_of_refusal_stops_the_night(self) -> None:
        accessor(self)
        for label, block in (
            ("unknown key", {**SHIPPED_BLOCK, "enabled": False}),
            ("range", {**SHIPPED_BLOCK, "max_nonmatching_observations": 1}),
            ("type", {**SHIPPED_BLOCK, "max_nonmatching_observations": "5"}),
            ("exempt", {**SHIPPED_BLOCK, "exempt_experiments": [""]}),
            ("not an object", None),
        ):
            with self.subTest(refusal=label):
                write_override(self.repo, block)
                runner, calls = self._counting_runner()
                with self.assertRaises(GovernanceError):
                    run_night_experiments(self.repo, cycle_id="cycle-p3", base_dir=self.tools, runner=runner)
                self.assertEqual(calls, [])

    def test_a_valid_block_lets_the_night_run(self) -> None:
        # The near-miss of the three tests above: the same candidate, a complete block, one run.
        accessor(self)
        write_override(self.repo, SHIPPED_BLOCK)
        runner, calls = self._counting_runner()
        payload = run_night_experiments(self.repo, cycle_id="cycle-p3", base_dir=self.tools, runner=runner)
        self.assertEqual(calls, ["exp-p3"])
        self.assertEqual(payload["errors"], [])


if __name__ == "__main__":
    unittest.main()
