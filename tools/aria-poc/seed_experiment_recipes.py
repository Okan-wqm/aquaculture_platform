#!/usr/bin/env python3
"""Register THIS repository's experiment recipes on the kernel's bench (E21-b).

WHY THE RECIPES ARE NOT IN THE KERNEL
-------------------------------------

``aria_kernel.experiment`` is domain-blind on purpose, and an AST invariant
holds it to that: no language, no toolchain, no product noun may appear in
its executable surface. The corollary is that the bench cannot ship the
recipes it runs — the moment ``nx`` or ``cargo`` is written into kernel
code, the bench has learned a repository and E21's "point this same bench
at another tree" premise is dead.

So the domain lives here, in the repo-facing tool lane that already knows
this repository (``seed_drift_findings.py`` next door scans it), and it
lives as DATA: ``experiment-recipes.json``. Adding a recipe is an edit to a
JSON file, never a code change — which is the difference between a bench
that is domain-agnostic and one that merely says so.

WHY A SEEDER RATHER THAN A HARDCODED LIST
-----------------------------------------

``register_recipe``/``register_experiment`` are the kernel's only doors
onto the declared surfaces; they hash, they validate the observation
contract, and they refuse an experiment pointing at an undeclared recipe.
Writing the JSONL rows directly would bypass all three. This seeder is a
thin transport: read the manifest, hand each row to the kernel, print what
the kernel accepted.

Re-running is safe. Both surfaces are append-only ledgers and both
resolvers take the LAST row for an id, so re-seeding after a manifest edit
supersedes the previous declaration instead of colliding with it.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT / "aria-kernel") not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT / "aria-kernel"))

from aria_kernel.experiment import (  # noqa: E402
    register_experiment,
    register_recipe,
)
from aria_kernel.validation import parse_allowed_command  # noqa: E402

MANIFEST_PATH = Path(__file__).resolve().parent / "experiment-recipes.json"

_RECIPE_FIELDS = frozenset(
    {"recipe_id", "command", "timeout_ms", "deterministic", "description"},
)
_EXPERIMENT_FIELDS = frozenset(
    {"experiment_id", "hypothesis", "recipe_ref", "observation_contract"},
)


def load_manifest(path: Path = MANIFEST_PATH) -> dict[str, Any]:
    """Read the manifest and reject a shape the seeder would half-apply.

    An unknown key is an error rather than a silent drop: a recipe field
    that this loader ignores is a declaration the operator believes is in
    force and the bench never sees.
    """
    doc = json.loads(path.read_text(encoding="utf-8"))
    if doc.get("schema_version") != 1:
        raise ValueError(
            f"experiment recipe manifest schema_version must be 1, got "
            f"{doc.get('schema_version')!r}",
        )
    for recipe in doc.get("recipes") or []:
        unknown = sorted(set(recipe) - _RECIPE_FIELDS)
        if unknown:
            raise ValueError(f"recipe {recipe.get('recipe_id')!r} has unknown keys: {unknown}")
    for definition in doc.get("experiments") or []:
        unknown = sorted(set(definition) - _EXPERIMENT_FIELDS)
        if unknown:
            raise ValueError(
                f"experiment {definition.get('experiment_id')!r} has unknown keys: {unknown}",
            )
    return doc


def assert_manifest_commands_executable(doc: dict[str, Any]) -> None:
    """Refuse a manifest whose commands the execution lane would reject.

    Recipes are opaque data to the kernel, so a command that no lane will
    ever run registers happily and fails only when an experiment is run —
    turning a typo into a mystery at 03:00. This resolves each command
    through the runner's OWN parser, so the manifest cannot claim an
    authority ``validation.ALLOWED_COMMANDS`` does not grant.
    """
    for recipe in doc.get("recipes") or []:
        parse_allowed_command(str(recipe["command"]))


def seed(
    doc: dict[str, Any], *, base_dir: Path | None, cycle_id: str | None,
) -> tuple[list[str], list[str]]:
    recipe_ids: list[str] = []
    experiment_ids: list[str] = []
    for recipe in doc.get("recipes") or []:
        row = register_recipe(
            recipe_id=recipe["recipe_id"],
            command=recipe["command"],
            timeout_ms=int(recipe["timeout_ms"]),
            deterministic=bool(recipe["deterministic"]),
            description=recipe.get("description"),
            base_dir=base_dir,
            cycle_id=cycle_id,
        )
        recipe_ids.append(str(row["recipe_id"]))
    for definition in doc.get("experiments") or []:
        row = register_experiment(
            experiment_id=definition["experiment_id"],
            hypothesis=definition["hypothesis"],
            recipe_ref=definition["recipe_ref"],
            observation_contract=definition["observation_contract"],
            base_dir=base_dir,
            cycle_id=cycle_id,
        )
        experiment_ids.append(str(row["experiment_id"]))
    return recipe_ids, experiment_ids


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--manifest", default=str(MANIFEST_PATH), help="Recipe manifest to seed",
    )
    parser.add_argument(
        "--base-dir",
        default=None,
        help="ARIA tools dir the bench surfaces live under (default: kernel default)",
    )
    parser.add_argument("--cycle-id", default=None, help="Cycle id to stamp on the rows")
    args = parser.parse_args(argv)

    doc = load_manifest(Path(args.manifest))
    assert_manifest_commands_executable(doc)
    base_dir = Path(args.base_dir) if args.base_dir else None
    recipe_ids, experiment_ids = seed(doc, base_dir=base_dir, cycle_id=args.cycle_id)

    for recipe_id in recipe_ids:
        print(f"[bench] recipe declared: {recipe_id}")
    for experiment_id in experiment_ids:
        print(f"[bench] experiment declared: {experiment_id}")
    print(
        f"[bench] {len(recipe_ids)} recipes + {len(experiment_ids)} experiments "
        f"seeded from {args.manifest}",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
