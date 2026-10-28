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

D9a (ARIA-HIGH-758, ARIA-MEDIUM-761) adds one family, ``discovery_scoring``, owned by role_fitness: the matcher
that says whether a report hits a known defect and the one fold over (cases, reports) that ``score_zoo_discovery``
(D3) and ``measure_discovery_recall`` (D9) both call. Its retired spellings are ``_claim_hits`` and ``_reports_hit``
(the two matchers); the atlas cannot see inside the owner's own module, so the three retired spellings
(``_wilson_interval`` too), the one matcher and the one Wilson route are also pinned on role_fitness's own source
(``TheDiscoveryScoringOwnerHoldsOneMatcherAndOneWilsonRoute``). At the branch base the family does not exist and
role_fitness holds both matchers and a second Wilson spelling, which each of those tests reports as an assertion.
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
    # F1.8(a) — the paired gain decision: compare_eval_windows' paired mode, its e-process and the one McNemar tail.
    "paired_gain_decision": f"{_KERNEL}agent_eval.py",
    # J4 — one reading of an item's citations (the retired private readers: tier0._item_refs, judgment_funnel._item_cited_refs).
    "item_citations": f"{_KERNEL}item_citations.py",
    # J4 — one mixed-tree predicate (the retired private spellings: feedback_store._target_shas, ._common_target_sha).
    "closing_tree": f"{_KERNEL}feedback_store.py",
    # SE-5 — the lifecycle state of an entity: current_lifecycle_state replays the entity's chain and is the only
    # reader of the lifecycle ledger; agent_invocations._target_is_shadow, a second unverified replay, is deleted.
    "lifecycle_state": f"{_KERNEL}genesis_lifecycle.py",
    # SE-5 — which agents may serve a role: allowed_targets_for_role (the static pairing plus the per-service seat
    # agents the ledger and the workspace grant) and resolve_seat_agent, in one module.
    "role_agent_targets": f"{_KERNEL}agent_surface.py",
    # F0.9p — the provenance census: no second computer of "which learned rows have no source".
    "row_provenance": f"{_KERNEL}row_provenance.py",
    # F1.2 — a learning mechanism's contribution over a window of cycles: autonomy_evidence computes it, the scorecard
    # and every other reader (fitness included) take it from there.
    "mechanism_contribution": f"{_KERNEL}autonomy_evidence.py",
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
    # D9a — "a known defect was hit or missed, a clean commit was alarmed": one matcher and one fold in role_fitness,
    # called by the zoo scorer (window ZOO_LINE_WINDOW, no class) and the gold-corpus block (window 0, the defect's class).
    "discovery_scoring": f"{_KERNEL}role_fitness.py",
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
    # A second e-value, a second sequential verdict or a second McNemar tail under the owner's names (F1.8(a)).
    "paired_gain_decision": (
        "def paired_e_value(candidate_only, incumbent_only):\n    return 1\n",
        "def sequential_paired_verdict(candidate_only, incumbent_only, *, alpha, min_discordant_pairs):\n"
        "    return ('flat', 1, 1)\n",
        "def _upper_tail(successes, trials):\n    return 0.5\n",
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
    # SE-5 — the claim-side SHADOW predicate agent_invocations carried (a second, unverified replay of the ledger),
    # and a second writer of the lifecycle ledger under its declared surface.
    "lifecycle_state": (
        "def _target_is_shadow(root, target):\n    return False\n",
        "append_declared_jsonl(path, row, expected_surface='genesis_lifecycle_events')\n",
    ),
    # SE-5 — a second answer to 'which agents may serve this role', under the owner's name.
    "role_agent_targets": ("def allowed_targets_for_role(role):\n    return ()\n",),
    "row_provenance": ("def provenance_census(root):\n    return {}\n",),
    # A second computation under the owner's name, in the signature the owner has and in a keyword-only one.
    "mechanism_contribution": (
        "def mechanism_contribution(rows, cycle_ids):\n    return {}\n",
        "def mechanism_contribution(*, base_dir, cycle_ids):\n    return {}\n",
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
    # D9a — the two retired matchers: the zoo's (same file, +-10 lines, no class) and the gold corpus's (same path,
    # overlap, same class). Either returning in another module is a second matcher.
    "discovery_scoring": (
        "def _claim_hits(claim, label):\n    return False\n",
        "def _reports_hit(defect, reports_on_change):\n    return False\n",
    ),
}


def _generator() -> ModuleType:
    if importlib.util.find_spec(_GENERATOR) is None:
        raise AssertionError(f"F0.9b: {_GENERATOR} (atlas generator and one-owner scan) does not exist")
    return importlib.import_module(_GENERATOR)


def _owner_sources() -> dict[str, str]:
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


# --- D9a: what the atlas cannot see, the owner's own module ---------------------------------------------------------
_ROLE_FITNESS = f"{_KERNEL}role_fitness.py"
_RETIRED_DISCOVERY_SPELLINGS = ("_claim_hits", "_reports_hit", "_wilson_interval")
# The fields a defect and a report locate themselves by (the gold corpus's and the zoo label's spellings).
_LINE_FIELDS = frozenset({"start_line", "end_line", "line_start", "line_end"})
_ORDERING = (ast.Lt, ast.LtE, ast.Gt, ast.GtE)
_WILSON_OWNER_NAME = "wilson_interval"
_WILSON_ROUTE = "_proportion"


def _spelled(node: ast.AST) -> list[str]:
    """Every identifier a node introduces or uses: definitions, names, attributes, imports (and their aliases), parameters."""
    return [getattr(node, attr) for attr in ("name", "id", "attr", "asname", "arg") if isinstance(getattr(node, attr, None), str)]


def _retired_spellings(source: str) -> list[str]:
    tree = ast.parse(source)
    return sorted({spelled for node in ast.walk(tree) for spelled in _spelled(node) if spelled in _RETIRED_DISCOVERY_SPELLINGS})


def _own_nodes(function: ast.AST) -> list[ast.AST]:
    """The nodes of a function's own body: a nested function is another function and answers for its own nodes."""
    nodes: list[ast.AST] = []
    pending = list(ast.iter_child_nodes(function))
    while pending:
        node = pending.pop()
        nodes.append(node)
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            pending.extend(ast.iter_child_nodes(node))
    return nodes


def _line_matchers(source: str) -> list[str]:
    """The functions that ORDER the line fields of two records (``report["start_line"] <= defect["end_line"] + window``).

    One function that compares lines is one matcher: an ordering comparison one of whose operands names a line
    field as a string key (a subscript, or a ``.get`` argument). The zoo adapter that turns labels into cases and
    claims into reports builds dicts and calls the matcher; it orders no line fields itself.
    """
    matchers = []
    for function in ast.walk(ast.parse(source)):
        if not isinstance(function, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        for node in _own_nodes(function):
            if (isinstance(node, ast.Compare) and any(isinstance(op, _ORDERING) for op in node.ops)
                    and any(isinstance(leaf, ast.Constant) and leaf.value in _LINE_FIELDS for leaf in ast.walk(node))):
                matchers.append(function.name)
                break
    return sorted(matchers)


def _wilson_routes(source: str) -> tuple[list[str], int]:
    """(offenders, uses of the owner inside the one route).

    A second Wilson spelling is a definition, an import or a call whose name mentions "wilson" and is not
    ``judge_calibration.wilson_interval``; a use of that owner (a name or an attribute read, not its import) is an
    offender unless it sits in ``_proportion``. A variable that merely carries an interval's bound is no spelling.
    """
    tree = ast.parse(source)
    inside = {id(node) for function in ast.walk(tree) if isinstance(function, ast.FunctionDef) and function.name == _WILSON_ROUTE
              for node in ast.walk(function)}
    offenders, uses_inside = [], 0
    for node in ast.walk(tree):
        line = getattr(node, "lineno", 0)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.alias)):
            if "wilson" in node.name.lower() and node.name != _WILSON_OWNER_NAME:
                offenders.append(f"{line}:{node.name}")
        elif isinstance(node, ast.Call):
            callee = node.func.id if isinstance(node.func, ast.Name) else node.func.attr if isinstance(node.func, ast.Attribute) else ""
            if "wilson" in callee.lower() and callee != _WILSON_OWNER_NAME:
                offenders.append(f"{line}:{callee}")
        if isinstance(node, (ast.Name, ast.Attribute)) and isinstance(node.ctx, ast.Load) and _spelled(node) == [_WILSON_OWNER_NAME]:
            if id(node) in inside:
                uses_inside += 1
            else:
                offenders.append(f"{line}:{_WILSON_OWNER_NAME} outside {_WILSON_ROUTE}")
    return sorted(offenders), uses_inside


class TheDiscoveryScoringScansCatchEveryShape(unittest.TestCase):
    """The scans are pinned on planted shapes first (green at the base: they test the scans, not role_fitness)."""

    _FIRST_MATCHER = (
        "def _reports_hit(defect, reports):\n"
        "    return any(r['path'] == defect['path'] and r['start_line'] <= defect['end_line']\n"
        "               and defect['start_line'] <= r['end_line'] for r in reports)\n"
    )
    _SECOND_MATCHER = (
        "def _claim_hits(claim, label):\n"
        "    return claim.get('start_line') <= label['line_end'] + 10 and claim['end_line'] >= label['line_start'] - 10\n"
    )
    _ONE_MATCHER_WITH_A_WINDOW = (
        "def lines_hit(defect, report, window):\n"
        "    return report['start_line'] <= defect['end_line'] + window and defect['start_line'] - window <= report['end_line']\n"
    )
    _ADAPTER = (
        "def as_cases(labels):\n"
        "    return [{'start_line': label['line_start'], 'end_line': label['line_end']} for label in labels if len(label) > 0]\n"
    )

    def test_a_line_matcher_is_found_in_either_spelling_and_in_a_unified_one(self) -> None:
        for shape, expected in ((self._FIRST_MATCHER, ["_reports_hit"]), (self._SECOND_MATCHER, ["_claim_hits"]),
                                (self._ONE_MATCHER_WITH_A_WINDOW, ["lines_hit"])):
            with self.subTest(shape=shape.splitlines()[0]):
                self.assertEqual(_line_matchers(shape), expected)

    def test_a_second_matcher_beside_the_first_is_counted_and_an_adapter_is_not_one(self) -> None:
        self.assertEqual(_line_matchers(self._ONE_MATCHER_WITH_A_WINDOW + "\n" + self._SECOND_MATCHER), ["_claim_hits", "lines_hit"])
        self.assertEqual(_line_matchers(self._ONE_MATCHER_WITH_A_WINDOW + "\n" + self._ADAPTER), ["lines_hit"])

    def test_a_nested_matcher_is_counted_once_under_its_own_name(self) -> None:
        nested = "def outer(a, b):\n    def inner(x, y):\n        return x['start_line'] <= y['end_line']\n    return inner(a, b)\n"
        self.assertEqual(_line_matchers(nested), ["inner"])

    def test_every_retired_spelling_is_found_as_a_definition_a_call_an_import_and_an_alias(self) -> None:
        for name in _RETIRED_DISCOVERY_SPELLINGS:
            for shape in (f"def {name}(a, b):\n    return a\n", f"x = {name}(1, 2)\n", f"from .m import {name}\n",
                          f"from .m import other as {name}\n", f"y = module.{name}\n"):
                with self.subTest(name=name, shape=shape.splitlines()[0]):
                    self.assertEqual(_retired_spellings(shape), [name])

    def test_a_second_wilson_spelling_is_an_offender_and_the_one_route_is_not(self) -> None:
        route = f"def {_WILSON_ROUTE}(count, n):\n    return {_WILSON_OWNER_NAME}(count, n)\n"
        self.assertEqual(_wilson_routes(route), ([], 1))
        lazy = (f"def {_WILSON_ROUTE}(count, n):\n    from .judge_calibration import {_WILSON_OWNER_NAME}\n"
                f"    return {_WILSON_OWNER_NAME}(count, n)\n")
        self.assertEqual(_wilson_routes(lazy), ([], 1))
        for forged, shape in (
            ("a second spelling", "def _wilson_interval(k, n):\n    return None, None\n"),
            ("a renamed second spelling", "def _interval_wilson_pair(k, n):\n    return None, None\n"),
            ("the lower bound's owner name", "from .judge_calibration import wilson_lower\n"),
            ("the owner called outside the route", route + "\ndef other(k, n):\n    return wilson_interval(k, n)\n"),
            ("the owner reached by attribute outside the route", route + "\ndef other(k, n):\n    return calibration.wilson_interval(k, n)\n"),
        ):
            with self.subTest(forged):
                self.assertTrue(_wilson_routes(shape)[0], shape)


class TheDiscoveryScoringOwnerHoldsOneMatcherAndOneWilsonRoute(unittest.TestCase):
    """SPEC D9a ruling 1 and 3, on role_fitness's own source (the atlas exempts the owner's module)."""

    @staticmethod
    def _source() -> str:
        return (_REPO_ROOT / _ROLE_FITNESS).read_text(encoding="utf-8")

    def test_the_retired_spellings_are_gone(self) -> None:
        self.assertEqual(
            _retired_spellings(self._source()), [],
            "role_fitness still holds a retired spelling of the matcher or of the Wilson interval: one matcher with "
            "one name remains (`_claim_hits` and `_reports_hit` are retired), one Wilson spelling "
            "(`_wilson_interval` is retired; `judge_calibration.wilson_interval` through `_proportion`)",
        )

    def test_exactly_one_function_orders_the_line_fields_of_a_defect_and_a_report(self) -> None:
        matchers = _line_matchers(self._source())
        self.assertEqual(
            len(matchers), 1,
            f"role_fitness has {len(matchers)} line matchers {matchers}: the zoo scorer and the gold-corpus block call ONE "
            "matcher (a report hits a defect on the same file when its lines overlap the defect's widened by the "
            "caller's window; the class agrees when, and only when, the defect names one)",
        )

    def test_the_one_wilson_route_is_judge_calibration_wilson_interval_through_proportion(self) -> None:
        offenders, uses = _wilson_routes(self._source())
        self.assertEqual(offenders, [], "role_fitness spells the Wilson interval some way other than `_proportion` -> "
                                        "`judge_calibration.wilson_interval`")
        self.assertGreaterEqual(uses, 1, f"`{_WILSON_ROUTE}` does not call `judge_calibration.{_WILSON_OWNER_NAME}`")


if __name__ == "__main__":
    unittest.main()
