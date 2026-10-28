"""F4.0b — the data label has one owner, every rendered key has one class, every minter is classified (tier 3, I1-I4).

PLAN-v2 F4.0 / ARIA-MEDIUM-751. Text an earlier run, a person or a repository wrote reaches an agent as DATA
only when it is inside a block ``text_safety.untrusted_block`` placed (an ``untrusted_*`` tag around a body the
owner escaped). The renderer applies the label by the KEY's class (tier 2, automatic); these four invariants
detect a tag placed by hand, a key the renderer reads that has no decision, a memory key whose payload escapes,
and a minter whose prompt text has no class (tier 3). They name what is NOT labelled yet: that list may only
shrink (F4.0c carries the rest of ARIA-MEDIUM-751).

I1  One tag placer. An AST scan of the kernel for string constants and f-strings that construct a closing data
    tag finds the owner and exactly the pinned hand-placed sites, by ``module:function`` (docstrings and comments
    excluded). ``pressure_evidence.prompt_fields`` placed its own tag until it called the owner: it is not pinned.
I2  Every top-level key ``render_invocation_prompt`` reads has exactly one class in
    ``agent_invocations.RENDERED_KEY_CLASSES`` (NEW API pinned here: red at the base because the table does not
    exist; each test asserts on it before using it). The ``untrusted_block`` class is the four memory keys.
I3  Behavioural: a payload planted in a row of each memory key never appears outside a block at the version a
    fresh mint stamps.
I4  Minter census. Every module that calls ``create_agent_invocation_request`` is classified by where its prompt
    text comes from; a new minter module is red until classified; ``pending`` may only shrink.
"""

from __future__ import annotations

import ast
import inspect
import textwrap
import unittest
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from aria_kernel import agent_invocations as ai
from aria_kernel import self_improvement
from tests._helpers import untrusted_blocks as ub

_REPO_ROOT = Path(__file__).resolve().parents[3]
_KERNEL = _REPO_ROOT / "aria-kernel" / "aria_kernel"
_KERNEL_PREFIX = "aria-kernel/aria_kernel/"

# --- I1 ------------------------------------------------------------------------------------------------
# The closing tag of a data family: a literal, or an f-string that spells ``</`` right before a formatted value.
_CLOSER = ("</untrusted_", "</derived_context", "</evidence_payload", "</obligation_data")
OWNER = frozenset({"text_safety:untrusted_block"})
# The hand-placed sites at 602f2e17d1 (the writer's scan of the kernel). Each is a mixed-origin path whose fix changes another
# owner's bytes or contract: ARIA-MEDIUM-751 (F4.0c). THE PIN MAY ONLY LOSE ENTRIES: a site that moves to the owner is deleted
# here in the same commit; a site that is added is a red test, not a line in this set.
PLACERS_AT_BASE: frozenset[str] = frozenset({
    "agent_invocations:_tagged",
    "agent_invocations:_render_obligation_data",
    "agent_invocations:render_invocation_prompt",
    "agent_invocations:_render_evidence_excerpts",
    "cross_review_bridge:_cross_review_suggested_prompt",
    "cross_review_bridge:_primary_revision_suggested_prompt",
    "cross_review_bridge:_completeness_critic_suggested_prompt",
    "cross_review_bridge:_implementation_suggested_prompt",
    "goldset:dispatch_goldset_curation",
    "typed_judgment:_render_excerpt",
})
PINNED_PLACERS: frozenset[str] = PLACERS_AT_BASE


def kernel_sources() -> dict[str, str]:
    """``{module path without suffix: source}`` for every module of the kernel package."""
    return {
        path.relative_to(_KERNEL).with_suffix("").as_posix(): path.read_text(encoding="utf-8")
        for path in sorted(_KERNEL.glob("**/*.py"))
    }


def _docstrings(tree: ast.AST) -> set[int]:
    found: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)) and node.body:
            first = node.body[0]
            if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant) and isinstance(first.value.value, str):
                found.add(id(first.value))
    return found


def closing_tag_placers(sources: Mapping[str, str]) -> set[str]:
    """``module:function`` of every string constant or f-string that constructs a closing data tag (docstrings excluded)."""
    found: set[str] = set()
    for module, source in sources.items():
        tree = ast.parse(source)
        docstrings = _docstrings(tree)

        def visit(node: ast.AST, function: str | None, module: str = module) -> None:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                function = node.name
            if isinstance(node, ast.JoinedStr):
                for index, part in enumerate(node.values):
                    if isinstance(part, ast.Constant) and isinstance(part.value, str) and (
                        any(closer in part.value for closer in _CLOSER)
                        or (part.value.endswith("</") and index + 1 < len(node.values)
                            and isinstance(node.values[index + 1], ast.FormattedValue))
                    ):
                        found.add(f"{module}:{function or '<module>'}")
                for part in node.values:
                    if isinstance(part, ast.FormattedValue):
                        visit(part.value, function)
                return
            if isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in docstrings:
                if any(closer in node.value for closer in _CLOSER):
                    found.add(f"{module}:{function or '<module>'}")
            for child in ast.iter_child_nodes(node):
                visit(child, function)

        visit(tree, None)
    return found


class OneTagPlacerTests(unittest.TestCase):
    """I1."""

    def test_the_scan_finds_a_tag_placed_by_hand_and_ignores_prose(self) -> None:
        sources = {
            "m": ('def literal():\n    return "<untrusted_x>\\n</untrusted_x>"\n'
                  'def formatted(t):\n    return f"<{t}>\\n</{t}>"\n'
                  'def doc():\n    """closes with </derived_context>"""\n    # </untrusted_y>\n    return 1\n'
                  'def tail(t):\n    return f"{t}</evidence_payload>"\n')
        }
        self.assertEqual(closing_tag_placers(sources), {"m:literal", "m:formatted", "m:tail"})

    def test_the_kernel_places_a_tag_by_hand_only_where_the_pin_says(self) -> None:
        found = closing_tag_placers(kernel_sources())
        self.assertTrue(OWNER <= found, "the scan does not see the owner: it matches nothing")
        outside = found - OWNER
        new, gone = sorted(outside - PINNED_PLACERS), sorted(PINNED_PLACERS - outside)
        self.assertEqual(
            (new, gone), ([], []),
            f"hand-placed closing data tags {new} are not the owner's (text_safety.untrusted_block); "
            f"pinned sites {gone} no longer place one, so delete them from the pin",
        )

    def test_the_pin_may_only_shrink(self) -> None:
        self.assertEqual(len(PLACERS_AT_BASE), 10)
        self.assertTrue(PINNED_PLACERS <= PLACERS_AT_BASE, "a site was added to the pin: it may only lose entries")


# --- I2 ------------------------------------------------------------------------------------------------
CLASSES = frozenset({"kernel", "law_checked", "minter_text", "untrusted_block", "pending"})
MEMORY_KEYS = frozenset({"established_knowledge", "recent_intent", "decision_memory", "predecessor_rejection"})
PENDING_KEYS = frozenset({"repository_map", "evidence_excerpts"})
# Keys read off the ITEMS of a list field (a must_satisfy entry, a validation command), not envelope fields.
_NESTED = frozenset({"cmd", "criterion", "description", "id"})


def keys_read_by_renderer(source: str) -> set[str]:
    """The top-level envelope keys the renderer's source reads (``KeySetIsDerivedFromTheRendererTest``'s derivation)."""
    read: set[str] = set()
    for node in ast.walk(ast.parse(textwrap.dedent(source))):
        if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr in {"get", "pop"}
                and node.args and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str)):
            read.add(node.args[0].value)
        if isinstance(node, ast.Subscript) and isinstance(node.slice, ast.Constant) and isinstance(node.slice.value, str):
            read.add(node.slice.value)
    return read - _NESTED


def unclassified_keys(source: str, table: Mapping[str, str]) -> set[str]:
    return keys_read_by_renderer(source) - set(table)


def _table() -> Mapping[str, str]:
    table = getattr(ai, "RENDERED_KEY_CLASSES", None)
    assert table is not None, "agent_invocations.RENDERED_KEY_CLASSES does not exist"
    return table


class OneClassPerRenderedKeyTests(unittest.TestCase):
    """I2."""

    def test_every_key_the_renderer_reads_has_exactly_one_known_class(self) -> None:
        table = _table()
        source = inspect.getsource(ai.render_invocation_prompt)
        self.assertEqual(unclassified_keys(source, table), set(), "the renderer reads a key the table does not classify")
        self.assertEqual(set(table) - keys_read_by_renderer(source), set(), "the table classifies a key the renderer no longer reads")
        self.assertEqual({key: value for key, value in table.items() if value not in CLASSES}, {})

    def test_a_key_the_renderer_starts_to_read_is_found_unclassified(self) -> None:
        source = inspect.getsource(ai.render_invocation_prompt)
        mutant = source.replace("    render_version = int(", '    stray = request.get("zz_new_key")\n    render_version = int(', 1)
        self.assertNotEqual(mutant, source, "the mutation did not apply: the renderer's first lines changed")
        self.assertEqual(unclassified_keys(mutant, _table()), {"zz_new_key"})

    def test_the_untrusted_block_class_is_exactly_the_four_memory_keys(self) -> None:
        table = _table()
        self.assertEqual({key for key, value in table.items() if value == "untrusted_block"}, set(MEMORY_KEYS))

    def test_pending_is_exactly_the_two_keys_left_to_the_next_package(self) -> None:
        table = _table()
        self.assertEqual({key for key, value in table.items() if value == "pending"}, set(PENDING_KEYS))

    def test_every_classified_key_is_carried_by_the_fused_projection(self) -> None:
        self.assertEqual(set(_table()) - set(ai._FUSED_ENVELOPE_KEYS), set())


# --- I3 ------------------------------------------------------------------------------------------------


def _memory_row(key: str, text: str) -> dict[str, Any]:
    """A row of ``key`` whose every free-text field is ``text``."""
    return {
        "established_knowledge": {"beliefs": [{"belief_id": "b-1", "claim": text, "confidence": 0.9, "support_count": 3,
                                               "evidence_refs": []}], "conventions": []},
        "recent_intent": {"head_sha": "a" * 40, "files": [{"file": "src/feed.py", "commits": [
            {"sha": "b" * 12, "subject": text, "why": text}]}]},
        "decision_memory": {"pack_hash": "sha256:" + "0" * 32, "decisions": [
            {"source": "recovery", "when": "2026-10-01", "what": "recovery decided requeue", "why": text}]},
        "predecessor_rejection": {"request_id": "AIR-0", "rejection_codes": ["agent_evidence_path_missing"],
                                  "rejection_reasons": [text], "omitted_reasons": 0},
    }[key]


def _request(**overrides: Any) -> dict[str, Any]:
    row: dict[str, Any] = {
        "request_id": "AIR-aria-evidence-judge-f40b00000003", "role": "evidence_judgment",
        "target_agent": "aria-evidence-judge", "convergence_id": "f40b", "prompt_render_version": ai.PROMPT_RENDER_VERSION,
        "expected_output_path": "aria-tools/out/f40b.md", "suggested_prompt": "Check the feed rate.",
        "must_satisfy": [{"id": "feed-evidence", "description": "cite the feed rate source"}],
        "allowed_scope": ["src/**"], "evidence_refs": ["src/feed.py:1"],
    }
    row.update(overrides)
    return row


class MemoryKeysNeverEscapeTheirBlockTests(unittest.TestCase):
    """I3 — the payload set of the shared helper, planted in each memory key, at the version a fresh mint stamps."""

    def test_a_payload_planted_in_each_memory_key_never_renders_outside_a_block(self) -> None:
        for key in sorted(MEMORY_KEYS):
            for name, build in (("multiline", ub.multiline), ("one_line", ub.one_line)):
                with self.subTest(key=key, payload=name):
                    mark = f"F40B-I3-{key.upper()}-LINE"
                    prompt = ai.render_invocation_prompt(_request(**{key: _memory_row(key, build(mark))}))
                    self.assertNotIn(mark, ub.outside_blocks(prompt), f"{key} text reached the prompt outside every <untrusted_*> block")
                    self.assertTrue(ub.in_a_block(prompt, mark), f"{key} text was dropped, not rendered as data")
                    self.assertNotIn(f'<derived_context section="{key}">', prompt)

    def test_every_key_the_table_puts_in_the_untrusted_block_class_has_a_payload_row_here(self) -> None:
        classified = {key for key, value in _table().items() if value == "untrusted_block"}
        self.assertEqual(classified - MEMORY_KEYS, set(), "a key joined the class without a payload row in this test")


# --- I4 ------------------------------------------------------------------------------------------------
# Where the prompt text of each module that calls ``create_agent_invocation_request`` comes from. The writer's reading of each
# minter at 602f2e17d1:
#   escaped      the text reaches the prompt through ``untrusted_block`` (named renderer must be a declared trust-boundary renderer)
#   encoded      Mode B (base64): no ASCII delimiter can appear in the payload
#   kernel_text  the module's own words (a kernel constant, an f-string over kernel-validated ids, a default no caller overrides)
#   operator     the operator's own file (``--prompt-file``)
#   pending      in-flight content (plan JSON, a diff, a finding message, a sealed prompt copied): ARIA-MEDIUM-751 (F4.0c)
MINTERS: dict[str, tuple[str, str | None]] = {
    "pr_tracking": ("escaped", "pr_tracking"),
    "autonomy_orchestrator": ("escaped", "pressure_evidence"),
    "decision_questioning": ("kernel_text", None),
    "review_runner": ("kernel_text", None),
    # every caller takes the default prompt (grep of the kernel and the CLI, 2026-10-27): the module's own sentence.
    "convergent_planning_bridge": ("kernel_text", None),
    "cli": ("operator", None),
    "cross_review_bridge": ("pending", None),
    "expert_review_gate": ("pending", None),
    "specialist_review_runner": ("pending", None),
    "dispatcher_factory": ("pending", None),
    "plan_round_controller": ("pending", None),
    "human_required_adjudication": ("pending", None),
    "goldset": ("pending", None),
    "judge_fanout": ("pending", None),
    "judge_replay": ("pending", None),
    "mutation_canary": ("pending", None),
    "judge_remint": ("pending", None),
    "stability_reask": ("pending", None),
}
MINTER_CLASSES = frozenset({"escaped", "encoded", "kernel_text", "operator", "pending"})
# The pending minters at 602f2e17d1, less the one the writer's reading classified (convergent_planning_bridge). THE PIN MAY ONLY SHRINK.
PENDING_AT_BASE = frozenset({
    "cross_review_bridge", "expert_review_gate", "specialist_review_runner", "dispatcher_factory", "plan_round_controller",
    "human_required_adjudication", "goldset", "judge_fanout", "judge_replay", "mutation_canary", "judge_remint", "stability_reask",
})
_DEFINER = "agent_invocations"


def minter_modules(sources: Mapping[str, str]) -> set[str]:
    """Every module (but the definer) that calls ``create_agent_invocation_request``."""
    found: set[str] = set()
    for module, source in sources.items():
        if module == _DEFINER:
            continue
        for node in ast.walk(ast.parse(source)):
            if isinstance(node, ast.Call):
                callee = node.func.attr if isinstance(node.func, ast.Attribute) else getattr(node.func, "id", None)
                if callee == "create_agent_invocation_request":
                    found.add(module)
    return found


def _imports(source: str, module: str) -> bool:
    return any(isinstance(node, ast.ImportFrom) and node.level >= 1 and (node.module or "").split(".")[0] == module
               for node in ast.walk(ast.parse(source)))


class MinterCensusTests(unittest.TestCase):
    """I4."""

    def test_every_minter_module_is_classified_and_every_classified_module_still_mints(self) -> None:
        found = minter_modules(kernel_sources())
        self.assertEqual(sorted(found - set(MINTERS)), [], "a new minter module has no class: classify where its prompt text comes from")
        self.assertEqual(sorted(set(MINTERS) - found), [], "a classified module no longer mints: delete it from the census")
        self.assertEqual({m: c for m, (c, _r) in MINTERS.items() if c not in MINTER_CLASSES}, {})

    def test_a_new_minter_module_is_found_unclassified(self) -> None:
        sources = {**kernel_sources(), "zz_new_minter": "from .agent_invocations import create_agent_invocation_request\n"
                                                         "def mint():\n    return create_agent_invocation_request(role='x')\n"}
        self.assertEqual(minter_modules(sources) - set(MINTERS), {"zz_new_minter"})

    def test_an_escaped_minter_names_a_declared_trust_boundary_renderer_it_is_or_imports(self) -> None:
        sources = kernel_sources()
        for module, (kind, renderer) in MINTERS.items():
            if kind != "escaped":
                continue
            with self.subTest(module=module):
                self.assertIsNotNone(renderer, f"{module} is 'escaped' but names no renderer")
                self.assertIn(f"{_KERNEL_PREFIX}{renderer}.py", self_improvement.TRUST_BOUNDARY_RENDERERS,
                              f"{renderer} places the label for {module} but is not a declared trust-boundary renderer")
                self.assertTrue(renderer == module or _imports(sources[module], renderer),
                                f"{module} is 'escaped' through {renderer} but does not import it")

    def test_the_pending_minters_may_only_shrink(self) -> None:
        pending = {module for module, (kind, _renderer) in MINTERS.items() if kind == "pending"}
        self.assertEqual(len(PENDING_AT_BASE), 12)
        self.assertEqual(sorted(pending - PENDING_AT_BASE), [], "a minter was classified pending: the census may only shrink")


if __name__ == "__main__":
    unittest.main()
