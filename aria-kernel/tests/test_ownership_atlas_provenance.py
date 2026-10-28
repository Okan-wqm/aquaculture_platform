"""F0.9p — the atlas extracts which ledgers' rows cite which, from the code that builds each row.

WHY THIS EXISTS. A learned row is only as trustworthy as what it cites, and when a source is found to be poisoned the
rows that cite it have to be found too (F4.6 walks that graph). The chain PLAN-v2 names (finding -> plan -> change ->
merge -> outcome -> lesson / convention / belief -> next plan) is already on the existing hash-chained ledgers and
single writers; what no code says is WHICH ledger's row carries WHICH citation. The atlas already reads every kernel
module through the one parse (``source_facts``); this package extends it, it does not add a second generator or a second
parser (tests/test_ownership_atlas_ssot.py pins that neither binds ``ast``).

THE API THIS PINS (new in F0.9p; at the branch base none of it exists, so each test reports an assertion failure, not an
import error):
  aria_kernel.ownership_atlas
    ROW_SCOPES                  {surface: ("<repo path>:<top-level scope>", ...)}: where each ledger's row is BUILT
    provenance_edges(sources)   {surface: {field: cited surface}}: the citation-vocabulary keys the row scopes write,
                                minus the ledger's own key (``change_id`` on change_planned is its identity, not a citation)
    provenance_offenders(sources) sorted ``<surface>:stale_row_scope:<path>:<scope>``,
                                ``<field>:id_field_not_written:<surface>.<id_field>``,
                                ``<kind>:source_field_not_written:<field>`` and ``<kind>:no_row_scope``; ``[]`` on the real tree
    build_atlas(repo)["provenance"]  {surface: {"row_scopes", "cites", "kind", "sources"}} from the SAME parsed facts
    render_atlas                a ``## Provenance`` section after the families table, before the footer
    FAMILIES["row_provenance"]  the single-owner family of the census
The keys are read at SCOPE granularity (the top-level statement, as every other symbol fact): a scope that writes two
ledgers attributes its keys to both. That approximation is stated by the render, not hidden.

The golden table below is the extraction's result on the tree at the branch base (spec-author measurement).
"""
from __future__ import annotations

import contextlib
import functools
import importlib
import importlib.util
import re
import unittest
from collections import Counter
from pathlib import Path
from typing import Any
from unittest import mock

from aria_kernel.state_manifest import surface_by_name

REPO = Path(__file__).resolve().parents[2]
GENERATOR = "aria_kernel.ownership_atlas"
OWNER = "aria_kernel.row_provenance"
K = "aria-kernel/aria_kernel/"

PLAN, CHANGE, FINDING, COMMIT = "plan_convergence_events", "change_planned", "repo_finding_events", "change_committed"
GOLDEN: dict[str, dict[str, str]] = {
    "change_committed": {"change_id": CHANGE, "finding_id": FINDING, "plan_id": PLAN},
    "change_outcome": {"change_id": CHANGE, "commit_sha": COMMIT, "finding_id": FINDING, "plan_id": PLAN},
    "change_planned": {"finding_id": FINDING, "plan_id": PLAN},
    "change_validated": {"change_id": CHANGE, "commit_sha": COMMIT, "finding_id": FINDING, "plan_id": PLAN},
    "kg_conventions": {"plan_id": PLAN, "supersedes_pattern_id": "kg_conventions"},
    "memory_beliefs": {},  # a belief cites repo evidence, not ledger rows
    "memory_procedural": {"plan_id": PLAN, "supersedes": "memory_procedural"},
    "plan_convergence_events": {},  # plan -> finding lives inside payload.plan_content.finding_id, not at row level
}
ROW_SCOPES_EXPECTED: dict[str, tuple[str, ...]] = {
    "plan_convergence_events": (f"{K}plan_convergence.py:_append_event",),
    "change_planned": (f"{K}change_ledger.py:emit_change_planned",),
    "change_committed": (f"{K}change_ledger.py:emit_change_committed",),
    "change_validated": (f"{K}change_ledger.py:emit_change_validated",),
    "change_outcome": (f"{K}change_outcome.py:emit_change_outcome",),
    "memory_procedural": (f"{K}agent_eval.py:_episode",),
    "kg_conventions": (f"{K}knowledge_graph.py:Pattern", f"{K}knowledge_graph.py:reconcile_convention_promotion"),
    "memory_beliefs": (f"{K}memory.py:_record_belief",),
}
LEARNED = {  # surface -> (kind, sources), as the learned-kind registry declares them
    "memory_beliefs": ("belief", ["evidence_refs"]),
    "kg_conventions": ("convention", ["plan_id"]),
    "memory_procedural": ("episode", ["plan_id", "evidence"]),
}
# The modules whose scopes ROW_SCOPES names: a planted tree needs only these, and parsing six modules instead of the
# whole kernel keeps every planted case cheap.
SCOPE_MODULES = ("plan_convergence.py", "change_ledger.py", "change_outcome.py", "agent_eval.py", "knowledge_graph.py",
                 "memory.py")


def _gen() -> Any:
    return importlib.import_module(GENERATOR)


def _api(name: str) -> Any:
    try:
        return getattr(_gen(), name)
    except AttributeError:
        raise AssertionError(f"F0.9p: {GENERATOR}.{name} does not exist") from None


_PARSED: dict[tuple[Any, ...], Any] = {}


@contextlib.contextmanager
def _parse_once() -> Any:
    """Within the block, a module the atlas parses with the same text, path and layer is parsed once for the whole test
    module: the extraction reads facts, never mutates them, and the real tree is ~500 modules. The one-parse test does
    NOT use this (it counts the build's own calls)."""
    gen = _gen()
    real = gen.extract

    def memoized(*args: Any, **kwargs: Any) -> Any:
        key = (args, tuple(sorted(kwargs.items())))
        if key not in _PARSED:
            _PARSED[key] = real(*args, **kwargs)
        return _PARSED[key]

    with mock.patch.object(gen, "extract", memoized):
        yield


@functools.lru_cache(maxsize=1)
def _production_sources() -> dict[str, str]:
    return _api("production_sources")(REPO)


@functools.lru_cache(maxsize=1)
def _real_edges() -> dict[str, dict[str, str]]:
    with _parse_once():
        return _api("provenance_edges")(_production_sources())


@functools.lru_cache(maxsize=1)
def _real_offenders() -> list[str]:
    with _parse_once():
        return _api("provenance_offenders")(_production_sources())


@functools.lru_cache(maxsize=1)
def _built() -> tuple[dict[str, Any], Counter[str]]:
    """The atlas of the real tree, built ONCE, with the parse calls it made (shared by the build, render, family and
    one-parse tests: the whole kernel is parsed once per process)."""
    gen = _gen()
    with mock.patch.object(gen, "extract", wraps=gen.extract) as spy:
        atlas = gen.build_atlas(REPO)
    parsed = Counter(call.args[1] if len(call.args) > 1 else call.kwargs["path"] for call in spy.call_args_list)
    return atlas, parsed


def _atlas() -> dict[str, Any]:
    return _built()[0]


def _provenance() -> dict[str, Any]:
    atlas = _atlas()
    if "provenance" not in atlas:
        raise AssertionError("F0.9p: build_atlas() has no 'provenance' key")
    return atlas["provenance"]


@functools.lru_cache(maxsize=1)
def _scope_texts() -> tuple[tuple[str, str], ...]:
    return tuple((f"{K}{module}", (REPO / K / module).read_text(encoding="utf-8")) for module in SCOPE_MODULES)


def _scope_sources(edits: dict[str, str | None] | None = None) -> dict[str, str]:
    """The six ROW_SCOPES modules as they are, with ``edits`` ({module: new text, None to drop it}) planted."""
    sources = dict(_scope_texts())
    for module, text in (edits or {}).items():
        if text is None:
            del sources[f"{K}{module}"]
        else:
            sources[f"{K}{module}"] = text
    return sources


def _real(module: str) -> str:
    return dict(_scope_texts())[f"{K}{module}"]


def _without(text: str, anchor: str, *, after: str) -> str:
    """``text`` with the first ``anchor`` at or after ``after`` removed. A missing anchor raises, so a plant that stopped
    matching the real source fails loudly instead of testing nothing."""
    at = text.index(anchor, text.index(after))
    return text[:at] + text[at + len(anchor):]


def _edges(edits: dict[str, str | None] | None = None) -> dict[str, dict[str, str]]:
    with _parse_once():
        return _api("provenance_edges")(_scope_sources(edits))


def _offenders(edits: dict[str, str | None] | None = None) -> list[str]:
    with _parse_once():
        return _api("provenance_offenders")(_scope_sources(edits))


# --- ROW_SCOPES: where each ledger's row is built ---------------------------------------------------------------------

class TheRowScopesAreDeclaredOnce(unittest.TestCase):
    def test_each_ledger_names_the_scopes_that_build_its_row_and_only_those(self) -> None:
        row_scopes = _api("ROW_SCOPES")
        self.assertEqual({surface: sorted(scopes) for surface, scopes in row_scopes.items()},
                         {surface: sorted(scopes) for surface, scopes in ROW_SCOPES_EXPECTED.items()})

    def test_a_scope_is_a_repo_path_and_a_scope_and_a_surface_is_a_declared_ledger(self) -> None:
        for surface, scopes in _api("ROW_SCOPES").items():
            with self.subTest(surface=surface):
                surface_by_name(surface)  # KeyError when the ledger is not declared; its path comes from the manifest
                for scope in scopes:
                    path, _, name = scope.rpartition(":")
                    self.assertTrue(name and (REPO / path).is_file(), scope)

    def test_the_row_scope_and_the_family_owner_of_a_ledger_are_one_module(self) -> None:
        # ROW_SCOPES says where a row is BUILT, FAMILIES where the ledger is OWNED: for the three ledgers both name,
        # they name one module (a second declaration site that disagrees would be a copy).
        owner_module = {surface: family.owner.rsplit(":", 1)[0] for family in _api("FAMILIES").values()
                        if family.owner for surface, _ in family.ledgers}
        shared = set(_api("ROW_SCOPES")) & set(owner_module)
        self.assertLessEqual({"plan_convergence_events", "memory_procedural", "change_outcome"}, shared)
        for surface in sorted(shared):
            with self.subTest(surface=surface):
                self.assertEqual({scope.rpartition(":")[0] for scope in _api("ROW_SCOPES")[surface]},
                                 {owner_module[surface]})

    def test_every_learned_kinds_ledger_has_a_row_scope(self) -> None:
        if importlib.util.find_spec(OWNER) is None:
            raise AssertionError(f"F0.9p: {OWNER} (the provenance owner) does not exist")
        for kind, learned in importlib.import_module(OWNER).LEARNED_KINDS.items():
            with self.subTest(kind=kind):
                self.assertIn(learned.surface, _api("ROW_SCOPES"))


# --- the extraction: golden table, own-key rule, read-only near-miss, scope precision, removal -------------------------

class TheEdgesAreTheCitationsTheRowBuildersWrite(unittest.TestCase):
    def test_the_real_tree_yields_the_golden_table_for_all_eight_ledgers(self) -> None:
        self.assertEqual(_real_edges(), GOLDEN)

    def test_a_ledgers_own_key_is_its_identity_not_a_citation(self) -> None:
        forged = (
            "def emit_change_planned():\n    return {'change_id': 1}\n\n"
            "def emit_change_committed():\n    return {'commit_sha': 1, 'change_id': 2}\n\n"
            "def emit_change_validated():\n    return {}\n"
        )
        edges = _edges({"change_ledger.py": forged})
        self.assertEqual(edges["change_committed"], {"change_id": "change_planned"})
        self.assertEqual(edges["change_planned"], {})
        self.assertEqual(edges["change_validated"], {})

    def test_reads_of_a_row_are_not_citations(self) -> None:
        forged = "def emit_change_outcome(row):\n    return row.get('finding_id'), row['finding_id']\n"
        self.assertEqual(_edges({"change_outcome.py": forged})["change_outcome"], {})

    def test_only_the_declared_scope_counts_not_the_whole_module(self) -> None:
        forged = (
            "def emit_change_outcome():\n    return {'plan_id': 1}\n\n"
            "def helper():\n    return {'finding_id': 2}\n"
        )
        self.assertEqual(_edges({"change_outcome.py": forged})["change_outcome"], {"plan_id": PLAN})

    def test_removing_a_citation_from_the_real_row_removes_the_edge(self) -> None:
        text = _without(_real("change_outcome.py"), '        "finding_id": computed["finding_id"],\n',
                        after="def emit_change_outcome(")
        self.assertEqual(_edges({"change_outcome.py": text})["change_outcome"],
                         {"change_id": CHANGE, "commit_sha": COMMIT, "plan_id": PLAN})


# --- the invariant: every declared scope exists, every cited id and every learned source is written ---------------------

class TheDeclarationsAgreeWithTheCode(unittest.TestCase):
    def test_the_real_tree_has_no_offender(self) -> None:
        self.assertEqual(_real_offenders(), [])

    def test_a_learned_source_field_the_row_no_longer_writes_is_named(self) -> None:
        text = _without(_real("knowledge_graph.py"), "    plan_id: str | None = None\n", after="class Pattern:")
        self.assertEqual(_offenders({"knowledge_graph.py": text}), ["convention:source_field_not_written:plan_id"])

    def test_a_belief_row_that_stops_carrying_its_refs_is_named(self) -> None:
        text = _without(_real("memory.py"), '        "evidence_refs": evidence_refs,\n', after="def _record_belief(")
        self.assertEqual(_offenders({"memory.py": text}), ["belief:source_field_not_written:evidence_refs"])

    def test_a_renamed_row_builder_is_a_stale_scope_and_its_sources_go_unwritten(self) -> None:
        text = _real("agent_eval.py")
        self.assertIn("def _episode(", text)
        offenders = _offenders({"agent_eval.py": text.replace("def _episode(", "def _episode_renamed(", 1)})
        self.assertLessEqual({
            f"memory_procedural:stale_row_scope:{K}agent_eval.py:_episode",
            "episode:source_field_not_written:plan_id",
            "episode:source_field_not_written:evidence",
        }, set(offenders))

    def test_a_module_missing_from_the_tree_makes_each_of_its_scopes_stale(self) -> None:
        offenders = _offenders({"change_ledger.py": None})
        self.assertLessEqual({
            f"change_planned:stale_row_scope:{K}change_ledger.py:emit_change_planned",
            f"change_committed:stale_row_scope:{K}change_ledger.py:emit_change_committed",
            f"change_validated:stale_row_scope:{K}change_ledger.py:emit_change_validated",
        }, set(offenders))

    def test_a_cited_id_the_cited_ledger_no_longer_writes_is_named(self) -> None:
        forged = (
            "def emit_change_planned():\n    return {}\n\n"
            "def emit_change_committed():\n    return {'commit_sha': 1}\n\n"
            "def emit_change_validated():\n    return {}\n"
        )
        offenders = _offenders({"change_ledger.py": forged})
        self.assertIn("change_id:id_field_not_written:change_planned.change_id", offenders)
        # A ledger nobody here builds (the finding mint) is cited only: it has no row scope to check, so no offender.
        self.assertEqual([o for o in offenders if "repo_finding_events" in o], [])

    def test_a_learned_kind_whose_ledger_has_no_row_scope_is_named(self) -> None:
        with mock.patch.dict(_api("ROW_SCOPES")):
            del _api("ROW_SCOPES")["memory_beliefs"]
            self.assertIn("belief:no_row_scope", _offenders())


# --- build_atlas()["provenance"] ---------------------------------------------------------------------------------------

class TheAtlasCarriesTheProvenance(unittest.TestCase):
    def test_every_declared_ledger_has_an_entry_with_the_same_edges_as_the_extraction(self) -> None:
        provenance = _provenance()
        self.assertEqual(set(provenance), set(GOLDEN))
        for surface, entry in provenance.items():
            with self.subTest(surface=surface):
                self.assertEqual(set(entry), {"row_scopes", "cites", "kind", "sources"})
                self.assertEqual(entry["cites"], GOLDEN[surface])
                self.assertEqual(sorted(entry["row_scopes"]), sorted(ROW_SCOPES_EXPECTED[surface]))

    def test_a_learned_ledger_names_its_kind_and_its_source_fields_in_order(self) -> None:
        provenance = _provenance()
        for surface, (kind, sources) in LEARNED.items():
            with self.subTest(surface=surface):
                self.assertEqual((provenance[surface]["kind"], list(provenance[surface]["sources"])), (kind, sources))
        self.assertEqual(provenance["memory_beliefs"]["cites"], {})

    def test_a_ledger_that_is_not_learned_memory_has_no_kind(self) -> None:
        provenance = _provenance()
        for surface in sorted(set(GOLDEN) - set(LEARNED)):
            with self.subTest(surface=surface):
                self.assertIsNone(provenance[surface]["kind"])
                self.assertFalse(provenance[surface]["sources"])

    def test_the_build_parses_each_production_module_once(self) -> None:
        _provenance()  # the provenance is part of the build this counts
        parsed = _built()[1]
        self.assertEqual(sum(parsed.values()), len(_production_sources()))
        self.assertEqual(parsed, Counter(dict.fromkeys(_production_sources(), 1)),
                         "a module was parsed twice (or not at all): the provenance reads the SAME facts as the families")


# --- the render -----------------------------------------------------------------------------------------------------------

def _section(text: str) -> list[str]:
    lines = text.splitlines()
    if "## Provenance" not in lines:
        raise AssertionError("F0.9p: the atlas has no '## Provenance' section")
    start = lines.index("## Provenance")
    end = next((i for i in range(start + 1, len(lines)) if lines[i] == "---" or lines[i].startswith("## ")), len(lines))
    return lines[start + 1:end]


def _cells(line: str) -> list[str]:
    return [cell.strip() for cell in line.strip().strip("|").split("|")]


def _pair(field: str, surface: str) -> str:
    return f"`{field}` → `{surface}`"


class TheRenderHasAProvenanceSection(unittest.TestCase):
    def render(self) -> str:
        return _api("render_atlas")(_atlas())

    def test_the_section_follows_the_families_table_and_precedes_the_footer(self) -> None:
        text = self.render()
        lines = text.splitlines()
        _section(text)
        header = next(i for i, line in enumerate(lines) if line.startswith("| Family |"))
        table_end = next(i for i in range(header, len(lines)) if not lines[i].startswith("|"))
        start = lines.index("## Provenance")
        footer = next(i for i, line in enumerate(lines) if line.startswith("Regenerate:"))
        self.assertGreaterEqual(start, table_end, "the section starts inside the families table")
        self.assertLess(start, footer)
        self.assertIn("---", lines[start:footer], "the footer's rule must still follow the section")

    def test_one_row_per_ledger_sorted_with_the_pinned_columns(self) -> None:
        section = _section(self.render())
        self.assertIn("| Ledger | Row built at | Cites | Learned kind (source fields) |", section)
        rows = [line for line in section if line.startswith("| ") and not line.startswith(("| Ledger", "|---"))]
        self.assertEqual([_cells(row)[0] for row in rows], sorted(GOLDEN))

    def test_the_cites_cell_lists_each_pair_and_a_dash_when_the_ledger_cites_nothing(self) -> None:
        section = _section(self.render())
        for surface, cites in GOLDEN.items():
            with self.subTest(surface=surface):
                lines = [line for line in section if line.startswith(f"| {surface} |")]
                self.assertEqual(len(lines), 1)
                cell = _cells(lines[0])[2]
                if cites:
                    self.assertEqual(set(cell.split("<br>")), {_pair(field, cited) for field, cited in cites.items()})
                else:
                    self.assertEqual(cell, "—")

    def test_the_row_built_at_and_learned_cells(self) -> None:
        section = _section(self.render())
        for surface, scopes in ROW_SCOPES_EXPECTED.items():
            with self.subTest(surface=surface):
                cells = _cells(next(line for line in section if line.startswith(f"| {surface} |")))
                self.assertEqual(set(cells[1].split("<br>")), {f"`{scope}`" for scope in scopes})
                if surface in LEARNED:
                    kind, sources = LEARNED[surface]
                    self.assertEqual(cells[3], f"`{kind}` ({', '.join(f'`{s}`' for s in sources)})")
                else:
                    self.assertEqual(cells[3], "—")

    def test_the_section_says_the_keys_are_read_at_scope_granularity_and_has_no_global_count(self) -> None:
        section = _section(self.render())
        prose = " ".join(line for line in section if line and not line.startswith("|"))
        self.assertIn("scope", prose.lower())
        # A coverage figure would move with every unrelated ledger and force a regeneration on every ledger PR.
        self.assertNotIn("coverage", prose.lower())
        self.assertIsNone(re.search(r"\b\d+\s*(of|/|%)\s*\d*", prose), prose)

    def test_the_render_reads_the_atlas_it_is_given_and_nothing_else(self) -> None:
        synthetic = {"zz_ledger": {"row_scopes": [f"{K}zz.py:build"], "cites": {"plan_id": PLAN}, "kind": None,
                                   "sources": []}}
        text = _api("render_atlas")({"families": _atlas()["families"], "provenance": synthetic})
        rows = [line for line in _section(text) if line.startswith("| ") and not line.startswith(("| Ledger", "|---"))]
        self.assertEqual([_cells(row)[0] for row in rows], ["zz_ledger"])
        self.assertEqual(_cells(rows[0])[1:], [f"`{K}zz.py:build`", _pair("plan_id", PLAN), "—"])

    def test_the_committed_atlas_carries_the_section_regenerated_with_the_generator(self) -> None:
        committed = (REPO / _api("ATLAS_PATH")).read_text(encoding="utf-8")
        section = _section(committed)
        rows = {_cells(line)[0] for line in section if line.startswith("| ") and not line.startswith(("| Ledger", "|---"))}
        self.assertEqual(rows, set(GOLDEN), f"regenerate: {_api('REGEN_COMMAND')}")
        self.assertEqual(committed, self.render())


# --- the census has one owner and the atlas reads it live -------------------------------------------------------------------

class TheCensusIsASingleOwnerFamilyThatIsLive(unittest.TestCase):
    OWNER = f"{K}row_provenance.py:provenance_census"

    def test_the_family_is_declared_with_one_owner_and_no_finding(self) -> None:
        family = _api("FAMILIES").get("row_provenance")
        if family is None:
            raise AssertionError("F0.9p: ownership_atlas.FAMILIES has no 'row_provenance' family")
        self.assertEqual((family.subsystem, family.owner, family.computers, family.ledgers, family.gate,
                          family.plan_package, family.finding),
                         ("learning-memory", self.OWNER, ("provenance_census",), (), None, None, None))

    def test_the_atlas_shows_it_single_owner_live_and_called_by_the_doctor(self) -> None:
        families = _atlas()["families"]
        self.assertIn("row_provenance", families)
        facts = families["row_provenance"]
        self.assertEqual(facts["owner"], self.OWNER)
        self.assertEqual({site.rsplit(":", 1)[0] for site in facts["writers"]}, {f"{K}row_provenance.py"})
        self.assertIsNone(facts["finding"])
        # Without a caller the atlas's own liveness model reads a family nothing reaches as dead: the doctor organ is
        # the reader that makes the census live (a store without a reader is dead code).
        self.assertEqual(facts["liveness"], "live")
        self.assertIn("cli aria_kernel", facts["liveness_via"])
        self.assertIn(f"{K}doctor.py:_check_provenance", facts["callers"])


if __name__ == "__main__":
    unittest.main()
