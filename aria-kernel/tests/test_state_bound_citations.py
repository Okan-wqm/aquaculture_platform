"""A doc or docstring that names a gate names the gate that exists.

The lock-bound lane cites its test modules from prose — the arcs registry's
docstrings, the ledger's comment, the executor's, the workflow's, the
contract document — so a maintainer who reads "a call in neither class
fails `tests/test_X.py`" can open the gate. Two of those citations named
`tests/test_state_lock_liveness_bound.py` as the module that walks
`state_store`'s AST; the walker lives in
`tests/test_state_lifecycle_arcs_derived.py`, and the named module only pins
numbers. A reader following the contract landed on the wrong gate, and no
test noticed because a citation is text.

Pinned here: every `tests/test_*.py` cited in the lane's prose is a file in
this suite, and every citation that claims an AST walk names the module that
defines the walker (`_LockedRegionWalk` — the class name is the coupling on
purpose: renaming the walker is a change this pin must see). A claim is a
walk word ("walks", "walker") in a sentence that names the AST, attributed
to the citation nearest to it: one sentence can credit the walker to one
module and the runtime trace to another, and the claim must land on the
module the walk word is about, not on every module the sentence names.
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
_KERNEL_TESTS = _REPO_ROOT / "aria-kernel" / "tests"
_WALKER_CLASS = "class _LockedRegionWalk"

# The prose of this lane: every production module, executor script,
# workflow and document the hermeticity lane wrote comments or docstrings
# into. Test modules are the cited side, not the citing side.
_LANE_PROSE = (
    "aria-kernel/aria_kernel/state_store_lifecycle_arcs.py",
    "aria-kernel/aria_kernel/ledger.py",
    "aria-kernel/aria_kernel/state_store.py",
    "aria-kernel/aria_kernel/notify.py",
    "aria-kernel/aria_kernel/human_required.py",
    "aria-kernel/aria_kernel/evidence_probe.py",
    "aria-kernel/aria_kernel/evidence_validator.py",
    "aria-kernel/aria_kernel/evidence_trust.py",
    "aria-kernel/aria_kernel/verification_gate.py",
    "aria-kernel/aria_kernel/agent_invocations.py",
    "aria-kernel/aria_kernel/cli.py",
    "aria-kernel/aria_kernel/workflow_contract_registry.py",
    "aria-kernel/aria_kernel/planner_dispatch_hook.py",
    "aria-kernel/aria_kernel/release_reason.py",
    "tools/aria-poc/ci_executor.py",
    "tools/aria-poc/ci_executor_drain.py",
    ".github/workflows/aria-agent-executor.yml",
    "docs/aria/CONTRACTS.md",
    "docs/aria/ARIA-NASIL-CALISIR.md",
)
_CITATION = re.compile(r"tests/(test_[a-z0-9_]+\.py)")
# A sentence, once comment markers and line breaks are folded away.
_SENTENCE_END = re.compile(r"(?<=[.;])\s+")
_AST_WORD = re.compile(r"\bAST\b")
_WALK_WORD = re.compile(r"\bwalk(?:s|er)?\b", re.IGNORECASE)


def _prose(path: Path) -> str:
    """The file's text with comment markers folded so a sentence is one line."""
    folded = re.sub(r"^\s*#\s?", "", path.read_text(encoding="utf-8"), flags=re.MULTILINE)
    return re.sub(r"\s+", " ", folded)


def _citations(text: str) -> list[tuple[str, str]]:
    """(cited module, the sentence citing it) for every citation in the text."""
    found: list[tuple[str, str]] = []
    for sentence in _SENTENCE_END.split(text):
        for match in _CITATION.finditer(sentence):
            found.append((match.group(1), sentence))
    return found


def _walk_claims(text: str) -> list[tuple[str, str]]:
    """(claimed module, the sentence) for every AST-walk claim in the text.

    In a sentence that names the AST, each walk word is a claim about the
    citation nearest to it — measured between the word and the citation's
    closest edge — so "the AST walker `tests/test_a.py` checks the code and
    `tests/test_b.py` checks the spawns" claims the walk for `test_a.py`
    only.
    """
    claims: list[tuple[str, str]] = []
    for sentence in _SENTENCE_END.split(text):
        if not _AST_WORD.search(sentence):
            continue
        cited = list(_CITATION.finditer(sentence))
        if not cited:
            continue
        for walk in _WALK_WORD.finditer(sentence):
            nearest = min(
                cited,
                key=lambda match: min(
                    abs(match.start() - walk.end()), abs(walk.start() - match.end()),
                ),
            )
            claims.append((nearest.group(1), sentence))
    return claims


class EveryCitedTestModuleExists(unittest.TestCase):
    def test_the_lane_cites_gates_that_exist(self) -> None:
        seen = 0
        for relative in _LANE_PROSE:
            path = _REPO_ROOT / relative
            self.assertTrue(path.exists(), relative)
            for module, sentence in _citations(_prose(path)):
                seen += 1
                with self.subTest(source=relative, cites=module):
                    self.assertTrue(
                        (_KERNEL_TESTS / module).is_file(),
                        f"{relative} cites tests/{module}, which does not exist: {sentence[:160]}",
                    )
        self.assertGreater(seen, 5, "the lane's prose cites its gates; none found")

    def test_a_citation_that_claims_the_ast_walk_names_the_walker(self) -> None:
        claims = 0
        for relative in _LANE_PROSE:
            for module, sentence in _walk_claims(_prose(_REPO_ROOT / relative)):
                claims += 1
                with self.subTest(source=relative, cites=module):
                    source = (_KERNEL_TESTS / module).read_text(encoding="utf-8")
                    self.assertIn(
                        _WALKER_CLASS, source,
                        f"{relative} says tests/{module} walks the AST; it defines no walker: "
                        f"{sentence[:160]}",
                    )
        # The arcs module (its docstring and `git_operation`'s), the ledger's
        # bound comment and the contract each make the claim.
        self.assertGreaterEqual(claims, 4)

    def test_a_walk_claim_lands_on_the_module_the_walk_word_is_about(self) -> None:
        # One sentence, two citations: the walker credited to the first, the
        # runtime trace to the second. A sentence-level match would have
        # demanded a walker of both.
        shared = (
            "each arc a sequence the AST walker `tests/test_a.py` checks against "
            "the code and `tests/test_b.py` checks against the git spawns."
        )
        self.assertEqual([m for m, _ in _walk_claims(shared)], ["test_a.py"])
        # The walk word after its citation, and the plain verb form.
        trailing = "a call in neither class fails `tests/test_b.py`, which walks the AST."
        self.assertEqual([m for m, _ in _walk_claims(trailing)], ["test_b.py"])
        # Two sentences: only the one naming the AST carries a claim.
        two = "`tests/test_a.py` pins the numbers. `tests/test_b.py` walks the AST."
        self.assertEqual([m for m, _ in _walk_claims(two)], ["test_b.py"])
        # A walk that is not of the AST is no claim about the walker.
        self.assertEqual(_walk_claims("`tests/test_a.py` walks the fixtures."), [])

    def test_the_walker_is_where_the_pin_expects_it(self) -> None:
        # The pin's own precondition: the class it looks for exists in the
        # module the corrected citations name, so a rename cannot make every
        # claim pass vacuously by never matching.
        walker = _KERNEL_TESTS / "test_state_lifecycle_arcs_derived.py"
        self.assertIn(_WALKER_CLASS, walker.read_text(encoding="utf-8"))
        numbers_only = _KERNEL_TESTS / "test_state_lock_liveness_bound.py"
        self.assertNotIn(_WALKER_CLASS, numbers_only.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
