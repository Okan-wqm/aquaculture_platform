"""E21-b — a declared recipe that cannot execute is a hypothesis nobody can test.

THE DEFECT THIS EXISTS TO CATCH. ``register_recipe`` treats a command as
opaque DATA on purpose: the kernel must not learn what ``nx`` or ``cargo``
is. The cost of that correctness is that a typo, a renamed nx project, or a
verb the lane never admitted registers happily and is discovered only when
the experiment runs — which, once E21-d wires the bench into the nightly, is
at 03:00, as a failure that looks like a broken repository rather than a
broken manifest.

So the manifest is proved executable HERE, at test time, through
``validation.parse_allowed_command`` — the runner's own parser, not a second
copy of the allowlist. A copy is how the manifest gate and the runner would
come to disagree about what may run, which is the same two-readers-of-one-
convention defect the seeder next door was written to avoid.

Deliberate breaks: put ``cargo publish`` (or ``npx nx test backend-common``,
which this lane does NOT admit) in the manifest and
``test_every_declared_command_is_executable_by_the_lane`` goes red; point an
experiment at a recipe id that is not declared and
``test_every_experiment_resolves_to_a_declared_recipe`` goes red.
"""
from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[3]
for _path in (_REPO_ROOT / "aria-kernel", _REPO_ROOT / "tools" / "aria-poc"):
    if str(_path) not in sys.path:
        sys.path.insert(0, str(_path))

from aria_kernel.experiment import (  # noqa: E402
    get_experiment,
    get_recipe,
)
from aria_kernel.runtime_profile import set_profile  # noqa: E402
from aria_kernel.validation import parse_allowed_command  # noqa: E402
from seed_experiment_recipes import (  # noqa: E402
    assert_manifest_commands_executable,
    load_manifest,
    seed,
)


class ExperimentRecipeManifestTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.doc = load_manifest()

    def test_the_manifest_declares_something(self) -> None:
        # A gate that passes over an empty list proves nothing; this fails
        # on collapse rather than on ordinary drift.
        self.assertGreaterEqual(len(self.doc["recipes"]), 2)
        self.assertGreaterEqual(len(self.doc["experiments"]), 2)

    def test_every_declared_command_is_executable_by_the_lane(self) -> None:
        for recipe in self.doc["recipes"]:
            with self.subTest(recipe_id=recipe["recipe_id"]):
                argv, _ = parse_allowed_command(str(recipe["command"]))
                self.assertTrue(argv)
        # And the seeder refuses the same manifest through the same door,
        # so an unrunnable recipe cannot be seeded even if this file is
        # never run.
        assert_manifest_commands_executable(self.doc)

    def test_every_experiment_resolves_to_a_declared_recipe(self) -> None:
        declared = {recipe["recipe_id"] for recipe in self.doc["recipes"]}
        for definition in self.doc["experiments"]:
            with self.subTest(experiment_id=definition["experiment_id"]):
                self.assertIn(definition["recipe_ref"], declared)

    def test_no_recipe_is_declared_without_an_experiment_to_test_it(self) -> None:
        """Dead data is how a manifest starts describing intentions rather
        than work: a recipe nothing references will never run, so nothing
        will ever notice when it stops working."""
        referenced = {
            definition["recipe_ref"] for definition in self.doc["experiments"]
        }
        orphaned = sorted(
            recipe["recipe_id"]
            for recipe in self.doc["recipes"]
            if recipe["recipe_id"] not in referenced
        )
        self.assertEqual(orphaned, [])

    def test_no_recipe_can_be_answered_from_a_build_cache(self) -> None:
        """A cached green measures the cache, not the tree.

        Measured while writing this file: the second run of the nx recipe
        returned exit 0 in seconds with ``[local cache]`` in its output and
        executed no test at all. An experiment whose observation can be
        served from a build cache is exactly the readiness claim E21 exists
        to end, and it gets worse on a schedule — a nightly would report a
        hypothesis confirmed every night after the last real execution.

        The kernel cannot know this: it must not learn what nx is. So the
        rule lives with the recipes, in the repo-facing lane that does.
        """
        for recipe in self.doc["recipes"]:
            argv, _ = parse_allowed_command(str(recipe["command"]))
            if argv[:2] != ["npx", "nx"]:
                continue
            with self.subTest(recipe_id=recipe["recipe_id"]):
                self.assertIn(
                    "--skip-nx-cache",
                    argv,
                    "an nx recipe without --skip-nx-cache can record a green "
                    "exit code without running anything",
                )
                # Measured on the same run: the default non-TTY renderer wrote
                # 63 KB of a 161 KB execution into the captured stream and cut
                # it mid-escape-sequence, dropping the summary and 80 of 124
                # suite results. The log is the run's content-addressed anchor
                # — a truncated one is a hash over an amputated record.
                self.assertIn(
                    "--output-style=stream",
                    argv,
                    "nx's default renderer truncates the captured output that "
                    "verify_validation_run re-hashes",
                )

    def test_the_kernel_accepts_the_whole_manifest(self) -> None:
        """The declarations are validated by the kernel's own doors —
        observation contracts, identifier shapes, timeout bounds — rather
        than by this test's idea of them."""
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / "aria-tools"
            set_profile("standard", operator_approval_ref="t", base_dir=base)
            recipe_ids, experiment_ids = seed(self.doc, base_dir=base, cycle_id=None)
            self.assertEqual(
                recipe_ids, [row["recipe_id"] for row in self.doc["recipes"]],
            )
            for recipe_id in recipe_ids:
                self.assertEqual(
                    get_recipe(recipe_id, base_dir=base)["recipe_id"], recipe_id,
                )
            for experiment_id in experiment_ids:
                self.assertEqual(
                    get_experiment(experiment_id, base_dir=base)["experiment_id"],
                    experiment_id,
                )


if __name__ == "__main__":
    unittest.main()
