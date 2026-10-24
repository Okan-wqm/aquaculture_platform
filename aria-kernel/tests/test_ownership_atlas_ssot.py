"""F0.9b — the ownership atlas is generated from code and pinned byte-for-byte.

WHY THIS EXISTS. The F0.9 atlas (80 concepts, 180 copy sites, 28 dead or
dormant, at d42f5488b) was written by hand from four evidence-first readers and
one skeptic. A hand atlas is stale at the first merge after it: nothing
recomputes "who owns this concept, who writes its ledger, who calls it, is it
reachable". PLAN-v2 F0.9b moves it into a deterministic generator that extends
the existing graph tooling (aria-import-graph's parse; no fourth engine) and
commits its render under docs/aria/generated/, the JUDGE-DIGEST pattern.

THE API THIS PINS (new in F0.9b; at the branch base the module does not exist,
which every test reports as an assertion failure, not an import error):
  aria_kernel.ownership_atlas
    ATLAS_PATH     "docs/aria/generated/OWNERSHIP-ATLAS.md"
    REGEN_COMMAND  the command that rewrites ATLAS_PATH; the render's footer carries it
    build_atlas(repo_root: Path) -> {"families": {family_id: facts}}
    render_atlas(atlas) -> str
  facts: owner ("<repo path>:<symbol>", None when no owner exists), writers
  (every "<repo path>:<symbol>" that writes the family's ledger or computes its
  value, the owner included), ledgers_written, ledgers_read, callers
  ("<repo path>:<function>"), liveness ("live" | "dormant" | "dead"),
  liveness_via (the cycle phase, CLI command or workflow that reaches the owner),
  plan_package and finding (set when the family has copies or no owner).

The registry check reads docs/reviews/_registry/, outside the kernel surface.
"""
from __future__ import annotations

import ast
import importlib
import importlib.util
import json
import unittest
from pathlib import Path
from types import ModuleType
from typing import Any

READS_LIVE_CHECKOUT = "every family with copies names a finding in docs/reviews/_registry/findings.jsonl"

REPO_ROOT = Path(__file__).resolve().parents[2]
GENERATOR = "aria_kernel.ownership_atlas"
REGISTRY = REPO_ROOT / "docs" / "reviews" / "_registry" / "findings.jsonl"
KERNEL = "aria-kernel/aria_kernel/"
FACTS_OWNER = "aria_kernel.source_facts"
IMPORT_GRAPH = "scripts/ci/aria-import-graph.py"
# What each consumer of the parse uses from its owner, by the consumer's module name.
SHARED_PRIMITIVES = {
    "aria_import_graph": ("KERNEL_ROOT", "KERNEL_PACKAGE", "module_name", "iter_modules", "path_parts", "extract",
                          "deepest_module"),
    GENERATOR: ("module_name", "iter_modules", "path_parts", "extract", "deepest_module"),
}

# The copy families PLAN-v2 F0.9b names with the package that folds each one;
# F0.9b registers them, it does not fold them.
NAMED_PACKAGES = {
    "finding_acceptance_bar": "F2.3",
    "red_first_prover": "F3.2",
    "change_outcome": "F3.3",
    "plan_round_cap": "F3.1",
    "impact_analysis": "SE-4",
}


def generator() -> ModuleType:
    if importlib.util.find_spec(GENERATOR) is None:
        raise AssertionError(f"F0.9b: {GENERATOR} (the atlas generator) does not exist")
    return importlib.import_module(GENERATOR)


def path_of(site: str) -> str:
    return site.rsplit(":", 1)[0]


class AtlasCase(unittest.TestCase):
    _atlas: dict[str, Any] | None = None

    def atlas(self) -> dict[str, Any]:
        if AtlasCase._atlas is None:
            AtlasCase._atlas = generator().build_atlas(REPO_ROOT)
        return AtlasCase._atlas

    def family(self, family_id: str) -> dict[str, Any]:
        families = self.atlas()["families"]
        self.assertIn(family_id, families, f"the atlas has no family {family_id!r}")
        return families[family_id]


class TheCommittedAtlasIsTheRender(AtlasCase):
    def test_committed_atlas_matches_render_byte_for_byte(self) -> None:
        gen = generator()
        committed_path = REPO_ROOT / gen.ATLAS_PATH
        self.assertTrue(committed_path.is_file(), f"{gen.ATLAS_PATH} is not committed")
        self.assertEqual(
            committed_path.read_text(encoding="utf-8"), gen.render_atlas(self.atlas()),
            f"{gen.ATLAS_PATH} is stale: an owner, writer, caller or liveness fact changed "
            f"without regenerating. Run: {gen.REGEN_COMMAND}",
        )

    def test_the_footer_carries_the_regen_command(self) -> None:
        gen = generator()
        self.assertTrue(gen.ATLAS_PATH.startswith("docs/aria/generated/"), gen.ATLAS_PATH)
        self.assertIn(gen.ATLAS_PATH, gen.REGEN_COMMAND)
        footer = "\n".join(gen.render_atlas(self.atlas()).rstrip("\n").splitlines()[-6:])
        self.assertIn(gen.REGEN_COMMAND, footer)


class OneParserFeedsTheImportGraphAndTheAtlas(unittest.TestCase):
    """PLAN-v2 F0.9: aria-import-graph, twin and impact_graph stay ARIA's graph
    engines and no fourth is added. The atlas's symbol facts come from the same
    parse as the import graph's edges: ``aria_kernel.source_facts`` owns the
    parse and its primitives, and both consumers hold its function objects."""

    @staticmethod
    def owner() -> ModuleType:
        if importlib.util.find_spec(FACTS_OWNER) is None:
            raise AssertionError(f"F0.9b: {FACTS_OWNER} (the one Python-source parse) does not exist")
        return importlib.import_module(FACTS_OWNER)

    @staticmethod
    def import_graph() -> ModuleType:
        spec = importlib.util.spec_from_file_location("aria_import_graph", REPO_ROOT / IMPORT_GRAPH)
        assert spec is not None and spec.loader is not None, IMPORT_GRAPH
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_both_consumers_hold_the_owners_primitives(self) -> None:
        owner = self.owner()
        for consumer in (self.import_graph(), generator()):
            for name in SHARED_PRIMITIVES[consumer.__name__]:
                with self.subTest(consumer=consumer.__name__, name=name):
                    self.assertIs(getattr(consumer, name, None), getattr(owner, name),
                                  f"{consumer.__name__}.{name} is a copy, not {FACTS_OWNER}.{name}")

    def test_neither_consumer_parses_python_itself(self) -> None:
        for consumer in (self.import_graph(), generator()):
            with self.subTest(consumer=consumer.__name__):
                self.assertFalse(any(value is ast for value in vars(consumer).values()),
                                 f"{consumer.__name__} binds the ast module: a second parser")


class TheAtlasFindsTheKnownFacts(AtlasCase):
    """Calibration (F0.9 Aşama 0): facts the hand atlas proved at d42f5488b."""

    def test_the_acceptance_bar_is_reached_from_the_judgment_pipeline(self) -> None:
        bar = self.family("finding_acceptance_bar")
        self.assertEqual(bar["owner"], f"{KERNEL}finding_promotion.py:promote_consensus_findings")
        self.assertIn(f"{KERNEL}cycle.py:_phase_judgment_pipeline", bar["callers"])
        self.assertEqual(bar["liveness"], "live")
        self.assertIn("judgment_pipeline", bar["liveness_via"])

    def test_the_learning_log_has_three_writers(self) -> None:
        writers = {path_of(site) for site in self.family("learning_log")["writers"]}
        self.assertLessEqual({f"{KERNEL}memory.py", f"{KERNEL}goldset.py", f"{KERNEL}pr_tracking.py"}, writers)

    def test_the_plan_ledger_has_one_writer(self) -> None:
        plan_events = self.family("plan_events_ledger")
        self.assertEqual({path_of(site) for site in plan_events["writers"]}, {f"{KERNEL}plan_convergence.py"})
        self.assertIn("plans/events.jsonl", " ".join(plan_events["ledgers_written"]))

    def test_the_red_first_prover_has_no_owner(self) -> None:
        prover = self.family("red_first_prover")
        self.assertIsNone(prover["owner"])
        self.assertEqual(prover["liveness"], "dead")

    def test_the_judgment_funnel_is_dormant(self) -> None:
        funnel = self.family("judgment_funnel")
        self.assertEqual(funnel["owner"], f"{KERNEL}judgment_funnel.py:route_judgment_sample")
        self.assertEqual(funnel["liveness"], "dormant")


class EveryCopyIsATrackedFinding(AtlasCase):
    """Families with copies are not folded here: each names its package and a finding."""

    @staticmethod
    def registry() -> dict[str, str]:
        rows: dict[str, str] = {}
        for line in REGISTRY.read_text(encoding="utf-8").splitlines():
            row = json.loads(line)
            if "id" in row:
                rows[row["id"]] = json.dumps(row, ensure_ascii=False)
        return rows

    def test_the_named_copy_families_name_their_package(self) -> None:
        for family_id, package in NAMED_PACKAGES.items():
            with self.subTest(family=family_id):
                self.assertIn(package, self.family(family_id)["plan_package"] or "")

    def test_every_family_with_copies_or_no_owner_is_registered(self) -> None:
        registry = self.registry()
        unregistered = []
        for family_id, facts in sorted(self.atlas()["families"].items()):
            if facts["owner"] is not None and len({path_of(s) for s in facts["writers"]}) <= 1:
                continue
            finding, package = facts["finding"], facts["plan_package"]
            if not package or finding not in registry or package not in registry[finding]:
                unregistered.append(f"{family_id}: finding={finding!r} plan_package={package!r}")
        self.assertEqual(unregistered, [], "a copy family without a registered finding naming its package")


if __name__ == "__main__":
    unittest.main()
