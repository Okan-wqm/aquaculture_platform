"""F0.9b — a concept family the atlas shows with one owner keeps one owner.

WHY THIS EXISTS. The F0.9 atlas (d42f5488b) found 180 copy sites over 80
concepts: a second writer of a ledger or a second computer of a value appears
the moment nothing forbids it, and the copies then diverge (three merge
indexes, four rule-contract resolutions, three learning-log writers). The
families that are single-owner TODAY are pinned here so they cannot regress;
families with copies are registered as findings by the atlas, not folded here.

THE PATTERN is digest.py's (test_digest_single_owner): a static scan of the
production trees, the owner exempt, and a forged module proving every shape of
the duplicate is caught. The scan has one owner, the atlas generator, so the
family table and the writer detection are not restated in this test:
  aria_kernel.ownership_atlas.production_sources(repo_root) -> {repo path: source text}
  aria_kernel.ownership_atlas.one_owner_offenders(sources) -> ["<path>:<line>:<family_id>", ...]
    every writer or computer of a single-owner family outside the owner's module.
Both are new in F0.9b; at the branch base the module does not exist, which
every test reports as an assertion failure, not an import error.

J4 (ARIA-HIGH-1083, ARIA-HIGH-1084) adds two families, each with one owner the
commit it lands: ``item_citations`` (what a sampled adapter finding cites: the
tier-0 gate, the judge fan-out and the verdict-cache key read ONE list) and
``closing_tree`` (the mixed-tree law of a closing set: the consensus engine and
the arbiter's producer ask ONE predicate). At the branch base neither family
exists in the atlas and ``item_citations.py`` does not exist, which each new
test reports as an assertion failure.
"""
from __future__ import annotations

import ast
import importlib
import importlib.util
import json
import subprocess
import sys
import unittest
from pathlib import Path
from types import ModuleType

_REPO_ROOT = Path(__file__).resolve().parents[3]
_GENERATOR = "aria_kernel.ownership_atlas"
_KERNEL = "aria-kernel/aria_kernel/"
_FORGED = f"{_KERNEL}forged_second_owner.py"

# The families the F0.9 atlas shows with one owner and no copy, the skeptic's
# refutations applied (contested.json: the rule contract and missed signals are
# NOT single-owner and are absent here). Value: the owner's module.
SINGLE_OWNER = {
    "plan_events_ledger": f"{_KERNEL}plan_convergence.py",
    "agent_performance_episodes": f"{_KERNEL}agent_eval.py",
    "fitness_report": f"{_KERNEL}fitness.py",
    "calibration_gate": f"{_KERNEL}genesis_policy.py",
    "verbatim_quote_law": f"{_KERNEL}evidence_trust.py",
    "judge_response_contract": f"{_KERNEL}judgment_bridge.py",
    "dispatch_failure_classification": "tools/aria-poc/dispatch_failure.py",
    # The one Python-source parse the import graph and the atlas share (PLAN-v2 F0.9: no fourth engine).
    "python_source_facts": f"{_KERNEL}source_facts.py",
    # F1.1 — the learning journal: memory.record_learning_event, no other writer (goldset and pr_tracking routed).
    "learning_log": f"{_KERNEL}memory.py",
    # J4 — one reading of an item's citations (the retired private readers: tier0._item_refs, judgment_funnel._item_cited_refs).
    "item_citations": f"{_KERNEL}item_citations.py",
    # J4 — one mixed-tree predicate (the retired private spellings: feedback_store._target_shas, ._common_target_sha).
    "closing_tree": f"{_KERNEL}feedback_store.py",
    # F0.6 — the non-matching streak of an experiment: experiment_night.nonmatching_streaks, no other computer.
    "experiment_hypothesis_cut": f"{_KERNEL}experiment_night.py",
    # F3.1 (ARIA-LOW-741, ARIA-MEDIUM-742) — the decision stamp's concepts, one owner each from the commit they land.
    # Which (provider, model) executed a sealed response, and the one writer of the executor's route key.
    "executed_route": f"{_KERNEL}independence_check.py",
    # A change's per-path line counts: the one git call and the one parse (change_paths).
    "change_churn": f"{_KERNEL}change_paths.py",
    # The stamp's closed shape, its constructor, validator and readers.
    "decision_stamp": f"{_KERNEL}decision_stamp.py",
    # "this subject's change is in flight": the one fold the F loop guard reads.
    "change_in_flight": f"{_KERNEL}finding_grounding.py",
}

# One planted second owner per family: a second writer of the family's ledger
# (declared surface or raw path) or a second computer under the owner's name.
_PLANTED = {
    "plan_events_ledger": (
        "append_declared_jsonl(root / 'plans' / 'events.jsonl', row, expected_surface='plan_convergence_events')\n",
        "append_jsonl(root / 'plans' / 'events.jsonl', row)\n",
    ),
    "agent_performance_episodes": (
        "append_declared_jsonl(path, row, expected_surface='memory_procedural')\n",
        "append_jsonl(root / 'memory' / 'procedural.jsonl', row)\n",
    ),
    "fitness_report": (
        "append_declared_jsonl(root / 'fitness' / 'fitness-reports.jsonl', row, expected_surface='fitness_reports')\n",
    ),
    "calibration_gate": ("def effective_calibration_gate(configured, calibration):\n    return configured\n",),
    "verbatim_quote_law": ("def quote_matches_at(quote, *, excerpt_content):\n    return quote in excerpt_content\n",),
    "judge_response_contract": ("def validate_judge_response(response):\n    return response\n",),
    "dispatch_failure_classification": ("def classify_dispatch_failure(result):\n    return 'unknown'\n",),
    "python_source_facts": (
        "def module_name(path):\n    return path.removesuffix('.py').replace('/', '.')\n",
        "def chain_runs(operands):\n    return []\n",
    ),
    # The two direct appends F1.1 routes through the owner, in the shapes goldset.py and pr_tracking.py had, and the
    # surface-named append that needs no path literal.
    "learning_log": (
        "append_declared_jsonl(root / 'memory' / 'learning-events.jsonl', row, expected_surface='memory_learning_events')\n",
        "append_jsonl(root / 'memory' / 'learning-events.jsonl', row)\n",
        "append_declared_jsonl(path, row, expected_surface='memory_learning_events')\n",
    ),
    # J4 — a second reader of the item's citations under the owner's name, the cited-line helper, and the two retired names.
    "item_citations": (
        "def item_cited_refs(item):\n    return []\n",
        "def cited_line(item):\n    return None\n",
        "def _item_refs(item):\n    return []\n",
        "def _item_cited_refs(item):\n    return []\n",
    ),
    # J4 — a second mixed-tree predicate, a second reading of the common tree, and the two retired private spellings.
    "closing_tree": (
        "def tree_is_mixed(rows):\n    return False\n",
        "def target_shas(rows):\n    return set()\n",
        "def common_target_sha(rows):\n    return None\n",
        "def _target_shas(rows):\n    return set()\n",
        "def _common_target_sha(rows):\n    return None\n",
    ),
    # F0.6 — a second computer of the streak under the owner's name.
    "experiment_hypothesis_cut": ("def nonmatching_streaks(observations):\n    return {}\n",),
    # F3.1 — a second function under each computer name of a new family: the resolver, its caller-side wrapper and the
    # key writer; the numstat parse; the stamp's constructor, validator and two readers; the in-flight fold.
    "executed_route": (
        "def executed_route(response, *, attempt_rows):\n    return None\n",
        "def executed_route_of(response, *, base_dir):\n    return None\n",
        "def stamp_dispatch_model(details, model):\n    details['agent_dispatch_model'] = model\n",
    ),
    "change_churn": ("def parse_change_z(output):\n    return (), None\n",),
    "decision_stamp": (
        "def build_decision_stamp(route, churn):\n    return {}\n",
        "def validate_decision_stamp(stamp):\n    return None\n",
        "def stamp_churn(stamp):\n    return {}\n",
        "def stamp_route_key(stamp):\n    return 'unstamped'\n",
    ),
    "change_in_flight": ("def _in_flight_state(plan_id, tools_root, lifecycle):\n    return None\n",),
}


def _generator() -> ModuleType:
    if importlib.util.find_spec(_GENERATOR) is None:
        raise AssertionError(f"F0.9b: {_GENERATOR} (atlas generator and one-owner scan) does not exist")
    return importlib.import_module(_GENERATOR)


def _owner_sources() -> dict[str, str]:
    # A missing owner file is reported by ``test_every_declared_owner_module_exists``, by name; the scans below
    # read the owners that exist, so one new family's absent module does not fail the families that stand.
    return {
        path: (_REPO_ROOT / path).read_text(encoding="utf-8")
        for path in sorted(set(SINGLE_OWNER.values()))
        if (_REPO_ROOT / path).is_file()
    }


class SingleOwnerFamiliesKeepOneOwner(unittest.TestCase):
    def test_every_declared_owner_module_exists(self) -> None:
        missing = sorted(path for path in set(SINGLE_OWNER.values()) if not (_REPO_ROOT / path).is_file())
        self.assertEqual(missing, [], "a single-owner family whose owner module does not exist (J4: item_citations.py)")
    # An owner module that does not exist yet contributes no source here; ``test_every_owner_module_exists`` is what
    # says so (by assertion), so one missing owner does not turn every planted-forgery test into a file error.
    return {path: (_REPO_ROOT / path).read_text(encoding="utf-8")
            for path in sorted(set(SINGLE_OWNER.values())) if (_REPO_ROOT / path).is_file()}


class SingleOwnerFamiliesKeepOneOwner(unittest.TestCase):
    def test_every_owner_module_exists(self) -> None:
        missing = sorted(path for path in set(SINGLE_OWNER.values()) if not (_REPO_ROOT / path).is_file())
        self.assertEqual(missing, [], "a single-owner family names an owner module that does not exist (F3.1: decision_stamp.py)")

    def test_no_second_writer_or_computer_exists(self) -> None:
        gen = _generator()
        self.assertEqual(gen.one_owner_offenders(gen.production_sources(_REPO_ROOT)), [],
                         "a second writer or computer of a single-owner family (F0.9b)")

    def test_the_scan_covers_the_executor_tree(self) -> None:
        self.assertIn("tools/aria-poc/dispatch_failure.py", _generator().production_sources(_REPO_ROOT))

    def test_the_atlas_declares_each_family_single_owner(self) -> None:
        families = _generator().build_atlas(_REPO_ROOT)["families"]
        for family_id, owner_module in SINGLE_OWNER.items():
            with self.subTest(family=family_id):
                self.assertIn(family_id, families)
                facts = families[family_id]
                self.assertEqual(facts["owner"].rsplit(":", 1)[0], owner_module)
                self.assertEqual({site.rsplit(":", 1)[0] for site in facts["writers"]}, {owner_module})
                self.assertIsNone(facts["finding"])


class APlantedSecondOwnerIsRed(unittest.TestCase):
    def test_every_planted_shape_is_caught_by_family(self) -> None:
        gen = _generator()
        for family_id, shapes in _PLANTED.items():
            for shape in shapes:
                with self.subTest(family=family_id, shape=shape.splitlines()[0]):
                    offenders = gen.one_owner_offenders({**_owner_sources(), _FORGED: shape})
                    self.assertEqual(
                        [o for o in offenders if o.startswith(f"{_FORGED}:")],
                        [f"{_FORGED}:1:{family_id}"],
                    )

    def test_the_owner_itself_is_not_an_offender(self) -> None:
        self.assertEqual(_generator().one_owner_offenders(_owner_sources()), [])


_CITATIONS = "aria_kernel.item_citations"


class TheCitationsOwnerIsAFoundationModule(unittest.TestCase):
    """J4 E3 — the gate, the fan-out and the funnel cannot import each other, so the owner they share imports no kernel module.

    The owner reaches ``evidence_trust.parse_evidence_ref`` lazily, inside the function that needs it: importing the
    module in a fresh interpreter loads the package and the module and nothing else of the kernel."""

    @staticmethod
    def _source() -> str:
        if importlib.util.find_spec(_CITATIONS) is None:
            raise AssertionError(f"J4: {_CITATIONS} does not exist")
        return (_REPO_ROOT / _KERNEL / "item_citations.py").read_text(encoding="utf-8")

    def test_a_fresh_interpreter_imports_it_and_loads_no_other_kernel_module(self) -> None:
        self._source()
        code = (
            "import json, sys\n"
            f"sys.path.insert(0, {str(_REPO_ROOT / 'aria-kernel')!r})\n"
            f"import {_CITATIONS}\n"
            "print(json.dumps(sorted(name for name in sys.modules if name.split('.')[0] == 'aria_kernel')))\n"
        )
        done = subprocess.run([sys.executable, "-I", "-c", code], capture_output=True, text=True, check=False)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(json.loads(done.stdout), ["aria_kernel", _CITATIONS])

    def test_no_import_of_a_kernel_module_sits_at_module_level(self) -> None:
        tree = ast.parse(self._source())
        module_level = [
            ast.unparse(node) for node in tree.body
            if (isinstance(node, ast.ImportFrom) and (node.level > 0 or str(node.module).split(".")[0] == "aria_kernel"))
            or (isinstance(node, ast.Import) and any(alias.name.split(".")[0] == "aria_kernel" for alias in node.names))
        ]
        self.assertEqual(module_level, [])


class AFifthReaderOfTheCitedLineIsRed(unittest.TestCase):
    """R11 of the J4 conformance audit - the atlas must name the retired fifth reader.

    ``system_one_points._cited_line`` read what an item cites (strings only, line 1 as the
    fallback) beside the owner, so the shadow Jev asks were about another line than the
    one the judges are handed. The ``item_citations`` family listed ``cited_line`` but
    not that private name, so a second reader under it was invisible to the one-owner
    scan. Planted the way every other forgery is: a forged module outside the owner that
    defines ``_cited_line`` must be the one offender, of the ``item_citations`` family.
    """

    _SHAPES = (
        "def _cited_line(item):\n    return None\n",
        "def _cited_line(item: dict) -> tuple[str, int] | None:\n    return (item.get('path') or '', 1)\n",
    )

    def test_a_second_reader_named_cited_line_outside_the_owner_is_an_offender(self) -> None:
        gen = _generator()
        for shape in self._SHAPES:
            with self.subTest(shape=shape.splitlines()[0]):
                offenders = gen.one_owner_offenders({**_owner_sources(), _FORGED: shape})
                self.assertEqual(
                    [o for o in offenders if o.startswith(f"{_FORGED}:")],
                    [f"{_FORGED}:1:item_citations"],
                )


if __name__ == "__main__":
    unittest.main()
