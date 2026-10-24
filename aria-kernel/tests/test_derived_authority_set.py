"""PLAN-v2 B1 / ARIA-HIGH-767 — one derived authority set, applied in every place it guards.

WHY. Today "what ARIA may not change about itself" is written down twice and
both copies are short. ``self_improvement.AUTHORITY_SURFACES`` refuses a
self-change only by the paths the proposer DECLARES, and it omits the rollback,
freeze, cap and test-collection modules. ``implementation_safety.READONLY_PATHS``
(the implementer room and ARIA's merge perimeter) omits ``tools/aria-acceptance/``,
``aria-kernel/pyproject.toml`` and the dated waiver manifests. ``.github/CODEOWNERS``
covers neither ``tools/aria-acceptance/`` nor ``aria-config/``. So one change can
edit a ``change_outcome`` resolver or ``self_revert`` and disarm its own rollback,
or narrow pytest collection or add a waiver and pass its own gate (refutation
round SEC-02/04/05/12, K13).

WHAT THIS FILE PINS (the B1 specification, PLAN-v2 §2 'Türetilmiş yetki kümesi'
and §3 Faz 6 B1):

* ``self_improvement.derived_authority_set(repo_root)`` — ONE function, returning
  repo globs in ``canonical_path.matches_repo_glob`` semantics. Its members are
  AUTHORITY_SURFACES ∪ the Board's import closure (``tools/aria-acceptance/``,
  the planned ``examination_board`` module, the Board seat prompts, and the
  kernel modules the Board's scorer imports) ∪ the rollback/boundary modules ∪
  test collection (pyproject, every conftest.py under aria-kernel/,
  pytest_native_only, sandbox_pin_skip, validation*.py, validation_matrix_gate,
  the waiver/baseline manifests, aria-kernel/tests/) ∪ the trust-boundary
  renderers. The full-set invariant below lists the floor.
* The set is applied in four places from that function: READONLY_PATHS (the
  pre-PR-open scope check) and the merge perimeter
  (``readonly_paths_untouched_at_merge``); the realized diff
  (``self_improvement.realized_diff_authority_violations``, which the
  kernel-change lane calls at pin proof and before merge); the CODEOWNERS
  coverage invariant; and the full-set invariant. The self-change proposal
  check (``authority_surface_violations``) reads the same set.
* ``self_improvement.invariants_only_grow(base_root, head_root)`` — collected
  test ids base ⊆ head, waiver entries head ⊆ base.
* The realized-diff rule exempts exactly one path: the verdict-bound Board
  pin path (``board_pin_path``), matched exactly.

NEW API. ``derived_authority_set``, ``realized_diff_authority_violations`` and
``invariants_only_grow`` do not exist at the branch base, so the tests that
call them are red there by AttributeError; every other test here is red by
assertion over APIs that already exist.

NOT PINNABLE ON THIS BASE. ``kernel_change_lane`` is not on main (it is on
landing/aria-kc-l). Its two calls to ``realized_diff_authority_violations``
(pin proof, before merge) are pinned when that landing meets this one.

Import closure: the set is closed under MODULE-LEVEL import — every kernel
file a Python member executes when it is imported is a member (the Board's
scorer imports, and the modules the guards themselves import, which decide
the set). The oracle here is the interpreter, not a second walker: a
subprocess imports the Board runner and the guards and every kernel file it
loaded must be a member. ``harness.py`` also imports ``aria_kernel.cycle``
inside a function; that import runs the candidate under exam (ARIA's own
cycle), not the scorer, so it does not make the whole kernel Board code.
That holds only because ``aria_kernel/__init__.py`` is lazy (PEP 562): its old
eager export loop ran ~180 kernel files on any kernel import.

Corrective round 1 (appellate roots R1–R8) added
``TheSetHoldsWhatItsMembersExecute`` and ``TheRealizedDiffOverTheRealKernel``;
every case it added elsewhere names its root (``R<n>``) in a comment.
"""
from __future__ import annotations

import ast
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from aria_kernel import claude_settings
from aria_kernel import implementation_safety as safety
from aria_kernel import self_improvement
from aria_kernel import validation
from aria_kernel.authority_closure import import_closure
from aria_kernel.canonical_path import matches_repo_glob
from aria_kernel.risk_policy import codeowners_last_match, codeowners_rules
from aria_kernel.suite_import_roots import SUITE_IMPORT_ROOTS_RELPATH, SUITE_PYTHONPATH_ROOTS
from aria_kernel.surface_waivers import WAIVER_MANIFESTS
from aria_kernel.tool_registry import GovernanceError
from tests._helpers.git_fixtures import make_local_git_repo
from tests._helpers.pre_merge_evidence import fixture_pre_merge_evidence
from tests._helpers.sandbox_pins import require_sandbox_backend

READS_LIVE_CHECKOUT = (
    "the live .github/CODEOWNERS, tools/aria-acceptance/ imports and the tracked file list, "
    "which the derived authority set must cover"
)

# The seam this file proves by a real process (tests/invariants/seam_registry.py):
# invariants_only_grow runs the suite's collector inside the validation sandbox
# on real base/head git trees.
REAL_PROCESS_SEAMS = ("aria-kernel/aria_kernel/self_improvement.py",)

_REPO_ROOT = Path(__file__).resolve().parents[2]
_KERNEL = "aria-kernel/aria_kernel/"

# -- The B1 floor, as the specification names it ----------------------------
# Rollback and boundary modules (B1 bullet 3, SEC-05), plus the two boundary
# modules K13 names for both lists.
_RAIL_MODULES: tuple[str, ...] = tuple(f"{_KERNEL}{name}.py" for name in (
    "self_revert", "change_outcome", "merge_record", "self_merge_freeze", "genesis_policy",
    "autonomy_unlock", "autonomy_ladder", "risk_policy", "cost_budget", "provider_hold",
    "circuit_breaker", "git_containment", "egress_relay",
    "operator_approval",
    # Planned path: the kernel-change lane lands from landing/aria-kc-l.
    "kernel_change_lane",
))
# Test collection (B1 bullet 4, SEC-12). The conftest/validation/tests rows are
# PATTERNS: a probe path that does not exist yet must still be a member, or a
# change that ADDS one walks past a set computed at base.
_TEST_COLLECTION: tuple[str, ...] = (
    "aria-kernel/pyproject.toml",
    "aria-kernel/conftest.py",
    "aria-kernel/tests/conftest.py",
    "aria-kernel/aria_kernel/conftest.py",
    "aria-kernel/b1probe/conftest.py",
    f"{_KERNEL}pytest_native_only.py",
    f"{_KERNEL}sandbox_pin_skip.py",
    f"{_KERNEL}validation.py",
    f"{_KERNEL}validation_env.py",
    f"{_KERNEL}validation_suite.py",
    f"{_KERNEL}validation_runs_ledger.py",
    f"{_KERNEL}validation_b1probe.py",
    f"{_KERNEL}validation_matrix_gate.py",
    # pytest's ini candidates in the rootdir: pytest.ini and .pytest.ini
    # outrank pyproject.toml, tox.ini and setup.cfg decide once it loses its
    # section (R3).
    "aria-kernel/pytest.ini",
    "aria-kernel/.pytest.ini",
    "aria-kernel/tox.ini",
    "aria-kernel/setup.cfg",
    # `site` imports these by name from the suite's PYTHONPATH roots
    # (aria-kernel/ and the repository root) before pytest starts (R3).
    "aria-kernel/sitecustomize.py",
    "aria-kernel/usercustomize.py",
    "sitecustomize.py",
    "usercustomize.py",
    "aria-kernel/closure-reachability-baseline.json",
    *("/".join(manifest.relpath) for manifest in WAIVER_MANIFESTS),
    "aria-kernel/tests/test_b1probe.py",
    "aria-kernel/tests/invariants/test_b1probe.py",
)
# The Board (B1 bullet 2, SEC-02/04). examination_board is B2's module and
# does not exist yet: it is named by its planned path so the set is complete
# when B2 lands. aria-test-writer / aria-bug-hunter arrive with WP-J;
# aria-adversarial-judge is the devil's-advocate seat.
_BOARD: tuple[str, ...] = (
    "tools/aria-acceptance/harness.py",
    "tools/aria-acceptance/test_harness.py",
    "tools/aria-acceptance/burn_in_driver.py",
    "tools/aria-acceptance/b1probe.py",
    f"{_KERNEL}examination_board.py",
    ".claude/agents/aria-acceptance-lead.md",
    ".claude/agents/aria-acceptance-gap-hunter.md",
    ".claude/agents/aria-acceptance-gap-fixer.md",
    ".claude/agents/aria-acceptance-output-validator.md",
    ".claude/agents/aria-acceptance-b1probe.md",
    ".claude/agents/aria-test-writer.md",
    ".claude/agents/aria-bug-hunter.md",
    ".claude/agents/aria-adversarial-judge.md",
)
# Trust-boundary renderers (B1 bullet 5; PLAN-v2 §2 'Güven sınırı').
_TRUST_RENDERERS: tuple[str, ...] = tuple(f"{_KERNEL}{name}.py" for name in (
    "agent_invocations", "untrusted_tree", "text_safety",
))
_NAMED_MEMBERS: tuple[str, ...] = _RAIL_MODULES + _TEST_COLLECTION + _BOARD + _TRUST_RENDERERS


def _tracked_files() -> tuple[str, ...]:
    result = subprocess.run(["git", "ls-files", "-z"], cwd=_REPO_ROOT, capture_output=True, check=True)
    return tuple(name for name in result.stdout.decode("utf-8").split("\0") if name)


def _literal_head(pattern: str) -> str:
    """The pattern's text before its first wildcard: a cheap pre-filter for the tracked list."""
    cut = min((pattern.index(ch) for ch in "*?{" if ch in pattern), default=len(pattern))
    return pattern[:cut]


def _probe(pattern: str) -> str:
    """One path the pattern must match, whether or not it exists yet."""
    path = pattern
    if path.endswith("/**"):
        path = path[:-3] + "/b1probe.py"
    path = path.replace("/**/", "/b1probe/")
    if path.startswith("**/"):
        path = "b1probe/" + path[3:]
    return path.replace("**", "b1probe").replace("*", "b1probe")


def _witnesses(pattern: str, tracked: tuple[str, ...]) -> list[str]:
    """Every tracked file the pattern covers, plus one probe (a file a change could ADD)."""
    head = _literal_head(pattern)
    found = [name for name in tracked if name.startswith(head) and matches_repo_glob(name, pattern)]
    probe = _probe(pattern)
    if matches_repo_glob(probe, pattern):
        found.append(probe)
    return found


def _is_member(path: str, entries: tuple[str, ...]) -> bool:
    return any(matches_repo_glob(path, entry) for entry in entries)


def _bound_evidence() -> safety._PreMergeEvidence:
    """Every native identity the pre-merge predicates require, present."""
    fields = ("repo_identity", "snapshot_hash", "pr_row_hash", "planned_row_hash", "committed_row_hash",
              "request_id", "claim_id", "request_row_hash", "claim_row_hash", "result_row_hash",
              "implementation_event_hash")
    return fixture_pre_merge_evidence((), **{field: f"{field}-x" for field in fields})


def _registered_check(name: str):  # noqa: ANN202 — the registry's own callable type
    return {entry.name: entry for entry in safety.HARD_FAIL_CHECKS}[name].check


def _readonly_refusal(path: str) -> str | None:
    """The pre-PR-open scope gate's reason for an implementer write to ``path``."""
    with tempfile.TemporaryDirectory() as tmp:
        result = _registered_check("forbidden_scope_normalized")(
            safety.HardFailContext(workspace_root=Path(tmp), affected_paths=(path,)))
    return None if result.passed else result.reason


def _merge_refusal(path: str) -> str | None:
    """The merge perimeter's reason for an ARIA-authored change to ``path``."""
    result = _registered_check("readonly_paths_untouched_at_merge")(
        safety.HardFailContext(affected_paths=(path,), pre_merge_evidence=_bound_evidence()))
    return None if result.passed else result.reason


def _owned(path: str) -> bool:
    rule = codeowners_last_match(path, rules=_CODEOWNERS_RULES)
    return rule is not None and bool(rule.owners)


_CODEOWNERS_RULES = codeowners_rules()


def _loaded_kernel_files(modules: tuple[str, ...], *, extra_path: tuple[Path, ...] = ()) -> list[str]:
    """The kernel files the INTERPRETER loads when a fresh process imports
    ``modules`` with the suite's PYTHONPATH: the oracle the closure answers to."""
    script = (
        "import importlib, sys\n"
        "for name in sys.argv[1:]:\n"
        "    importlib.import_module(name)\n"
        "for module in list(sys.modules.values()):\n"
        "    print(getattr(module, '__file__', None) or '')\n"
    )
    environment = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1", "PYTHONPATH": os.pathsep.join(
        (*map(str, extra_path), str(_REPO_ROOT / "aria-kernel"), str(_REPO_ROOT)))}
    completed = subprocess.run([sys.executable, "-c", script, *modules], cwd=_REPO_ROOT, env=environment,
                               capture_output=True, text=True, check=True)
    kernel_dir = _REPO_ROOT / "aria-kernel" / "aria_kernel"
    loaded = {Path(line).resolve() for line in completed.stdout.splitlines() if line.endswith(".py")}
    return sorted(path.relative_to(_REPO_ROOT).as_posix() for path in loaded if path.is_relative_to(kernel_dir))


def _modulefinder_reach() -> set[str]:
    """Every repository file the stdlib's ModuleFinder finds the decider
    seeds can execute, run at the suite's import roots, plus the kernel
    programs members launch or load by path (named by their owners'
    constants). The Board runner is read without its declared candidate
    entries, the one exemption."""
    from modulefinder import ModuleFinder

    board = _REPO_ROOT / "tools" / "aria-acceptance"
    roots = [str(_REPO_ROOT / "aria-kernel"), str(_REPO_ROOT), str(board)]
    finder = ModuleFinder(path=roots)
    declared = self_improvement.declared_authority_members()
    seeds = self_improvement._closure_seeds(_REPO_ROOT, declared)
    with tempfile.TemporaryDirectory() as tmp:
        for seed in seeds:
            if seed.startswith(_KERNEL):
                finder.import_hook(seed.removeprefix("aria-kernel/").removesuffix(".py").replace("/", "."))
            elif seed == "tools/aria-acceptance/harness.py":
                tree = ast.parse((_REPO_ROOT / seed).read_text(encoding="utf-8"))
                entries = next(ast.literal_eval(node.value) for node in tree.body if isinstance(node, ast.Assign)
                               and any(getattr(t, "id", None) == "BOARD_CANDIDATE_ENTRIES" for t in node.targets))
                tree.body = [node for node in tree.body
                             if not (isinstance(node, ast.FunctionDef) and node.name in entries)]
                scorer = Path(tmp, "harness.py")
                scorer.write_text(ast.unparse(tree), encoding="utf-8")
                finder.run_script(str(scorer))
            else:
                finder.run_script(str(_REPO_ROOT / seed))
        child = _REPO_ROOT / "aria-kernel" / "aria_kernel" / safety.VALIDATION_OBSERVATION_CHILD.name
        programs = [child, claude_settings.hook_client_path(_REPO_ROOT / "aria-kernel")]
        loaded = subprocess.run([sys.executable, "-I", "-c",
                                 "import runpy, sys; print(runpy.run_path(sys.argv[1])['_digest_spec'].origin)",
                                 str(child)], capture_output=True, text=True, check=True).stdout.strip()
        programs.append(Path(loaded))
        # Round 4 R2 — a program run by path has its own directory first on
        # sys.path (the interpreter's rule, unless the launch isolates it).
        modules = list(finder.modules.values())
        for program in programs:
            own = ModuleFinder(path=[str(program.parent), *roots])
            own.run_script(str(program))
            modules.extend(own.modules.values())
    files = {Path(module.__file__).resolve() for module in modules if module.__file__}
    files.update(program.resolve() for program in programs)
    return {path.relative_to(_REPO_ROOT).as_posix() for path in files
            if path.is_relative_to(_REPO_ROOT) and path.suffix == ".py"
            and not path.is_relative_to(Path(tempfile.gettempdir()))}


# =============================================================================
# 1. The consumers that exist today cover the B1 floor (red by assertion).
# =============================================================================

class TheNamedFloorIsGuardedEverywhere(unittest.TestCase):
    """Each path the B1 specification names is refused by every consumer of the set."""

    def test_the_implementer_room_cannot_write_any_named_member(self) -> None:
        for path in _NAMED_MEMBERS:
            with self.subTest(path=path):
                self.assertEqual(_readonly_refusal(path), f"readonly_path_write:{path}")

    def test_the_merge_perimeter_refuses_every_named_member(self) -> None:
        for path in _NAMED_MEMBERS:
            with self.subTest(path=path):
                self.assertEqual(_merge_refusal(path), f"readonly_path_change:{path}")

    def test_codeowners_names_an_owner_for_every_named_member_and_authority_surface(self) -> None:
        tracked = _tracked_files()
        surfaces = [name for surface in self_improvement.AUTHORITY_SURFACES
                    for name in tracked if name == surface or name.startswith(surface)]
        for path in (*_NAMED_MEMBERS, *surfaces):
            with self.subTest(path=path):
                self.assertTrue(_owned(path), f"{path} has no CODEOWNERS owner")

    def test_a_self_change_naming_a_rail_or_collection_member_is_refused_as_authority(self) -> None:
        for path in _NAMED_MEMBERS:
            if not path.startswith(self_improvement.SELF_CHANGE_ALLOWED_PREFIXES):
                continue
            with self.subTest(path=path):
                self.assertIn(f"authority_surface:{path}",
                              self_improvement.authority_surface_violations([path]))


# =============================================================================
# 2. The full-set invariant over the one function (new API).
# =============================================================================

class TheFullSetInvariant(unittest.TestCase):
    """``derived_authority_set`` holds at least every member the specification names."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.entries = tuple(self_improvement.derived_authority_set(_REPO_ROOT))
        cls.tracked = _tracked_files()

    def test_the_set_is_repo_globs(self) -> None:
        self.assertTrue(self.entries)
        for entry in self.entries:
            with self.subTest(entry=entry):
                self.assertIsInstance(entry, str)
                self.assertFalse(entry.startswith(("/", "./", "../")), entry)

    def test_every_named_member_is_in_the_set(self) -> None:
        for path in _NAMED_MEMBERS:
            with self.subTest(path=path):
                self.assertTrue(_is_member(path, self.entries), path)

    def test_every_authority_surface_is_in_the_set(self) -> None:
        # Today's prefix semantics: genesis_policy.json also covers its .template.
        for surface in self_improvement.AUTHORITY_SURFACES:
            covered = [name for name in self.tracked if name == surface or name.startswith(surface)]
            if surface.endswith("/"):
                covered.append(f"{surface}b1probe.yml")
            for path in covered or [surface]:
                with self.subTest(surface=surface, path=path):
                    self.assertTrue(_is_member(path, self.entries), path)

    def test_every_registered_waiver_manifest_is_in_the_set(self) -> None:
        for manifest in WAIVER_MANIFESTS:
            path = "/".join(manifest.relpath)
            with self.subTest(path=path):
                self.assertTrue(_is_member(path, self.entries), path)

    def test_every_kernel_file_the_board_runner_loads_is_in_the_set(self) -> None:
        board = _REPO_ROOT / "tools" / "aria-acceptance"
        runners = tuple(sorted(path.stem for path in board.glob("*.py") if not path.name.startswith("test_")))
        loaded = _loaded_kernel_files(runners, extra_path=(board,))
        self.assertIn(f"{_KERNEL}evidence_trust.py", loaded)  # the oracle sees the harness
        for path in loaded:
            with self.subTest(path=path):
                self.assertTrue(_is_member(path, self.entries), path)


class TheClosureIsComputedFromTheTree(unittest.TestCase):
    """The Board closure is derived from the imports in the checkout handed in, not a copied list."""

    def test_a_module_the_board_reaches_joins_and_an_unreached_one_does_not(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            kernel = root / "aria-kernel" / "aria_kernel"
            kernel.mkdir(parents=True)
            (root / "tools" / "aria-acceptance").mkdir(parents=True)
            (kernel / "__init__.py").write_text("", encoding="utf-8")
            (kernel / "b1_alpha.py").write_text("from .b1_beta import Y\nX = Y\n", encoding="utf-8")
            (kernel / "b1_beta.py").write_text("Y = 1\n", encoding="utf-8")
            (kernel / "b1_gamma.py").write_text("Z = 2\n", encoding="utf-8")
            (root / "tools" / "aria-acceptance" / "harness.py").write_text(
                "from aria_kernel.b1_alpha import X\n", encoding="utf-8")
            entries = tuple(self_improvement.derived_authority_set(root))
        self.assertTrue(_is_member(f"{_KERNEL}b1_alpha.py", entries))
        self.assertTrue(_is_member(f"{_KERNEL}b1_beta.py", entries))
        self.assertFalse(_is_member(f"{_KERNEL}b1_gamma.py", entries),
                         "a kernel module the Board does not reach is not Board code")

    @staticmethod
    def _tree(root: Path, files: dict[str, str]) -> None:
        for rel, text in files.items():
            target = root / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text, encoding="utf-8")

    def test_the_planned_board_module_brings_its_imports_once_it_exists(self) -> None:
        # R2 — examination_board seeds the closure the day it exists.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._tree(root, {f"{_KERNEL}__init__.py": "", f"{_KERNEL}b1_scorer.py": "S = 1\n",
                              "tools/aria-acceptance/harness.py": "import json\n"})
            before = tuple(self_improvement.derived_authority_set(root))
            self._tree(root, {f"{_KERNEL}examination_board.py": "from .b1_scorer import S\n"})
            after = tuple(self_improvement.derived_authority_set(root))
        self.assertFalse(_is_member(f"{_KERNEL}b1_scorer.py", before))
        self.assertTrue(_is_member(f"{_KERNEL}b1_scorer.py", after))

    def test_a_guard_brings_the_modules_it_imports(self) -> None:
        # R1 — the modules that decide the set are members because a guard imports them.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._tree(root, {f"{_KERNEL}__init__.py": "",
                              f"{_KERNEL}self_improvement.py": "from .b1_decider import DECIDE\n",
                              f"{_KERNEL}self_revert.py": "from aria_kernel.b1_rail_helper import H\n",
                              f"{_KERNEL}b1_decider.py": "from . import b1_decider_dep\nDECIDE = 1\n",
                              f"{_KERNEL}b1_decider_dep.py": "D = 1\n",
                              f"{_KERNEL}b1_rail_helper.py": "H = 1\n",
                              f"{_KERNEL}b1_bystander.py": "B = 1\n"})
            entries = tuple(self_improvement.derived_authority_set(root))
        for name in ("b1_decider", "b1_decider_dep", "b1_rail_helper"):
            with self.subTest(module=name):
                self.assertTrue(_is_member(f"{_KERNEL}{name}.py", entries))
        self.assertFalse(_is_member(f"{_KERNEL}b1_bystander.py", entries))

    def test_an_import_inside_a_function_brings_its_module_transitively(self) -> None:
        # R2 — a rail imports its decision inputs when it is called; so does the callee.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._tree(root, {f"{_KERNEL}__init__.py": "",
                              f"{_KERNEL}self_revert.py": "def candidates():\n    from .b1_callee import reds\n    return reds()\n",
                              f"{_KERNEL}b1_callee.py": "def reds():\n    import aria_kernel.b1_deeper as d\n    return d.R\n",
                              f"{_KERNEL}b1_deeper.py": "R = ()\n",
                              f"{_KERNEL}b1_bystander.py": "B = 1\n"})
            entries = tuple(self_improvement.derived_authority_set(root))
        for name in ("b1_callee", "b1_deeper"):
            with self.subTest(module=name):
                self.assertTrue(_is_member(f"{_KERNEL}{name}.py", entries))
        self.assertFalse(_is_member(f"{_KERNEL}b1_bystander.py", entries))

    def test_a_program_a_member_runs_by_path_is_in_the_set(self) -> None:
        # R2 — a child launched by path, and the file it loads by path.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._tree(root, {f"{_KERNEL}__init__.py": "",
                              f"{_KERNEL}implementation_safety.py":
                                  "from pathlib import Path\nCHILD = Path(__file__).with_name('b1_child.py')\n",
                              f"{_KERNEL}b1_child.py": "import importlib.util\nfrom pathlib import Path\n"
                                                       "SPEC = importlib.util.spec_from_file_location(\n"
                                                       "    'x', Path(__file__).with_name('b1_loaded.py'))\n",
                              f"{_KERNEL}b1_loaded.py": "L = 1\n",
                              f"{_KERNEL}b1_bystander.py": "B = 1\n"})
            entries = tuple(self_improvement.derived_authority_set(root))
        for name in ("b1_child", "b1_loaded"):
            with self.subTest(module=name):
                self.assertTrue(_is_member(f"{_KERNEL}{name}.py", entries))
        self.assertFalse(_is_member(f"{_KERNEL}b1_bystander.py", entries))

    def test_an_import_found_at_the_repository_root_brings_its_module(self) -> None:
        # R2 — imports resolve at the suite's import roots, the repository root included.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._tree(root, {f"{_KERNEL}__init__.py": "",
                              f"{_KERNEL}change_outcome.py": "def resolve():\n    from tools.shared.b1_shared import S\n",
                              "tools/__init__.py": "", "tools/shared/__init__.py": "",
                              "tools/shared/b1_shared.py": "S = 1\n", "tools/shared/b1_unused.py": "U = 1\n"})
            entries = tuple(self_improvement.derived_authority_set(root))
        for path in ("tools/shared/b1_shared.py", "tools/shared/__init__.py", "tools/__init__.py"):
            with self.subTest(path=path):
                self.assertTrue(_is_member(path, entries))
        self.assertFalse(_is_member("tools/shared/b1_unused.py", entries))

    def test_only_the_board_runners_declared_candidate_entries_are_not_walked(self) -> None:
        # R2 — the one exemption: the runner names the functions that run the candidate.
        runner = (f"BOARD_CANDIDATE_ENTRIES = ('run_candidate',)\n\n"
                  "def run_candidate():\n    from aria_kernel.b1_candidate import C\n\n"
                  "def score():\n    from aria_kernel.b1_scorer import S\n")
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._tree(root, {f"{_KERNEL}__init__.py": "", f"{_KERNEL}b1_candidate.py": "C = 1\n",
                              f"{_KERNEL}b1_scorer.py": "S = 1\n", f"{_KERNEL}b1_rail_input.py": "R = 1\n",
                              # the same declaration anywhere else exempts nothing
                              f"{_KERNEL}self_revert.py": "BOARD_CANDIDATE_ENTRIES = ('attribute',)\n\n"
                                                         "def attribute():\n    from .b1_rail_input import R\n",
                              "tools/aria-acceptance/harness.py": runner})
            entries = tuple(self_improvement.derived_authority_set(root))
        self.assertTrue(_is_member(f"{_KERNEL}b1_scorer.py", entries))
        self.assertTrue(_is_member(f"{_KERNEL}b1_rail_input.py", entries))
        self.assertFalse(_is_member(f"{_KERNEL}b1_candidate.py", entries))

    def test_a_candidate_entry_the_runner_does_not_define_is_refused(self) -> None:
        # R2 — a stale declaration cannot exempt a body.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._tree(root, {f"{_KERNEL}__init__.py": "",
                              "tools/aria-acceptance/harness.py": "BOARD_CANDIDATE_ENTRIES = ('gone',)\n"})
            with self.assertRaisesRegex(GovernanceError, "authority_closure_candidate_entry_unknown:.*harness.py:gone"):
                self_improvement.derived_authority_set(root)

    def test_a_name_only_the_package_getattr_resolves_is_refused(self) -> None:
        # R2 — a PEP 562 `__getattr__` loads modules the source does not name,
        # so the closure refuses to guess what such an import runs.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._tree(root, {f"{_KERNEL}__init__.py": "VERSION = 1\ndef __getattr__(name):\n    raise AttributeError(name)\n",
                              f"{_KERNEL}b1_alpha.py": "A = 1\n",
                              "tools/aria-acceptance/harness.py": "from aria_kernel import b1_alpha, VERSION\n"})
            self.assertTrue(_is_member(f"{_KERNEL}b1_alpha.py", tuple(self_improvement.derived_authority_set(root))))
            self._tree(root, {"tools/aria-acceptance/harness.py": "from aria_kernel import register_b1\n"})
            with self.assertRaisesRegex(GovernanceError, "authority_closure_dynamic_import:.*__init__.py:register_b1"):
                self_improvement.derived_authority_set(root)


class TheSetHoldsWhatItsMembersExecute(unittest.TestCase):
    """R1/R2 — the interpreter is the oracle: what importing a member loads is in the set."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.entries = tuple(self_improvement.derived_authority_set(_REPO_ROOT))

    def test_importing_one_kernel_module_runs_only_its_own_imports(self) -> None:
        # R2 — the package's eager export loop ran ~180 files on any kernel import.
        loaded = _loaded_kernel_files(("aria_kernel.evidence_trust",))
        self.assertIn(f"{_KERNEL}evidence_trust.py", loaded)
        self.assertNotIn(f"{_KERNEL}cycle.py", loaded)
        self.assertNotIn(f"{_KERNEL}pressure.py", loaded)

    def test_every_kernel_file_the_guards_load_is_in_the_set(self) -> None:
        # R1 — the guards (self_improvement, implementation_safety, the rails) and what they import.
        guards = ("self_improvement", "implementation_safety", *(
            Path(rail).stem for rail in self_improvement.RAIL_MODULES if (_REPO_ROOT / rail).is_file()))
        loaded = _loaded_kernel_files(tuple(f"aria_kernel.{name}" for name in guards))
        for decider in ("change_paths", "surface_waivers", "closure_reachability"):
            self.assertIn(f"{_KERNEL}{decider}.py", loaded)
        for path in loaded:
            with self.subTest(path=path):
                self.assertTrue(_is_member(path, self.entries), path)

    def test_every_file_a_decider_can_execute_is_in_the_set(self) -> None:
        # R2 — the full-set invariant over what the deciders EXECUTE: the
        # standard library's modulefinder (it scans every code object, so a
        # function body's import counts) from every decider seed, plus the
        # kernel programs members run by path, read from their owners.
        reached = _modulefinder_reach()
        for path in (f"{_KERNEL}own_pr_ci.py", f"{_KERNEL}containment_probe.py", f"{_KERNEL}digest.py",
                     f"{_KERNEL}_validation_unittest_child.py", f"{_KERNEL}hook_client.py"):
            self.assertIn(path, reached)  # the oracle sees the call-time and by-path edges
        for path in sorted(reached):
            with self.subTest(path=path):
                self.assertTrue(_is_member(path, self.entries), path)

    def test_every_data_file_a_decider_names_is_in_the_set(self) -> None:
        # Round 4 R3 — a rail's decision data is what the rail decides by:
        # every non-Python file a closure file names by a string literal,
        # under its own directory, is a member (genesis_policy's default
        # layer alone sets the circuit breaker's threshold).
        tracked = _tracked_files()
        closure = import_closure(_REPO_ROOT, self_improvement._closure_seeds(
            _REPO_ROOT, self_improvement.declared_authority_members()))
        named: set[str] = set()
        for relative in closure.files:
            if not relative.endswith(".py"):
                continue
            literals = {node.value for node in ast.walk(ast.parse((_REPO_ROOT / relative).read_text(encoding="utf-8")))
                        if isinstance(node, ast.Constant) and isinstance(node.value, str) and node.value}
            directory = relative.rpartition("/")[0]
            under = [name for name in tracked if name.startswith(f"{directory}/") and not name.endswith(".py")]
            named.update(name for name in under for literal in literals
                         if name == f"{directory}/{literal}" or name.endswith(f"/{literal}"))
        self.assertIn(f"{_KERNEL}data/genesis_policy_default.json", named)
        self.assertIn(f"{_KERNEL}data/sandbox_etc/hosts", named)
        for path in sorted(named):
            with self.subTest(path=path):
                self.assertTrue(_is_member(path, self.entries), path)

    def test_every_kernel_module_member_is_refused_by_its_name_in_every_form(self) -> None:
        # R5 — a package or an extension module beside a member is imported instead of it.
        members = [name for name in _tracked_files()
                   if name.startswith(_KERNEL) and name.endswith(".py") and not name.endswith("/__init__.py")
                   and _is_member(name, self.entries)]
        self.assertIn(f"{_KERNEL}self_revert.py", members)
        for path in members:
            stem = path.removesuffix(".py")
            for shadow in (f"{stem}/__init__.py", f"{stem}.abi3.so", f"{stem}.cpython-312-x86_64-linux-gnu.so"):
                with self.subTest(shadow=shadow):
                    self.assertEqual(self_improvement.authority_surface_violations([shadow]),
                                     [f"authority_surface:{shadow}"])


class ByPathProgramsRunIsolated(unittest.TestCase):
    """Round 4 R2 — a program run BY PATH has its own directory first on
    sys.path unless its launch isolates it. The validation observation child
    lives in aria-kernel/aria_kernel/, so without isolation a ``json.py``
    added beside it ran before the child's first line, and the set, which
    resolves imports at the suite's import roots, did not hold it."""

    def test_the_observation_child_is_launched_with_safe_path(self) -> None:
        # (a) `-P` sits immediately before the child's path.
        argv = validation.observation_child_argv(
            "python3", receipt_fd=9, byte_limit=1, path_limit=1, receipt_limit=1, modules=[],
            time_budget=0.0, unittest_arguments=["-v", "test_x"])
        child = str(Path(validation.__file__).with_name("_validation_unittest_child.py"))
        self.assertEqual(argv[:3], ["python3", "-P", child])

    def test_a_module_planted_beside_the_child_does_not_run(self) -> None:
        # (b) a temp copy of the package, a marker-writing json.py planted
        # beside its child, the child launched as that copy's launcher
        # composes it: the marker stays absent and the receipt parses.
        with tempfile.TemporaryDirectory(prefix="aria-b1-r4-child-") as tmp:
            scratch = Path(tmp)
            kernel = scratch / "aria-kernel"
            shutil.copytree(_REPO_ROOT / "aria-kernel" / "aria_kernel", kernel / "aria_kernel",
                            ignore=shutil.ignore_patterns("__pycache__"))
            marker = scratch / "planted-json-ran"
            (kernel / "aria_kernel" / "json.py").write_text(
                f"open({str(marker)!r}, 'w').write('ran')\nraise SystemExit(97)\n", encoding="utf-8")
            work = scratch / "work"
            work.mkdir()
            (work / "test_b1_r4.py").write_text(
                "import unittest\n\n\nclass B1R4(unittest.TestCase):\n    def test_ok(self):\n"
                "        self.assertTrue(True)\n", encoding="utf-8")
            read_end, write_end = os.pipe()
            try:
                composed = subprocess.run(
                    [sys.executable, "-I", "-c",
                     "import sys\nsys.path.insert(0, sys.argv[1])\n"
                     "from aria_kernel.validation import observation_child_argv\n"
                     "sys.stdout.write(chr(0).join(observation_child_argv(sys.executable, receipt_fd=int(sys.argv[2]),"
                     " byte_limit=1048576, path_limit=4, receipt_limit=4096, modules=['test_b1_r4'],"
                     " time_budget=5.0, unittest_arguments=['-v', 'test_b1_r4'])))",
                     str(kernel), str(write_end)],
                    capture_output=True, text=True, check=True).stdout
                argv = composed.split("\0")
                self.assertEqual(argv[2], str(kernel / "aria_kernel" / "_validation_unittest_child.py"))
                completed = subprocess.run(argv, cwd=work, pass_fds=(write_end,), capture_output=True, text=True,
                                           env={"PATH": os.environ["PATH"], "PYTHONDONTWRITEBYTECODE": "1"})
                os.close(write_end)
                write_end = -1
                receipt = validation._read_unittest_receipt(read_end, 4096, 1048576, 4)
            finally:
                os.close(read_end)
                if write_end >= 0:
                    os.close(write_end)
            self.assertFalse(marker.exists(), completed.stderr)
            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertIn("Ran 1 test", completed.stderr)
            self.assertIsNotNone(receipt)

    def test_every_program_the_closure_names_has_its_directory_names_in_the_set(self) -> None:
        # (c) the full-set pin. The closure cannot tell a launch from a
        # mention, nor read the launcher's flags, so every Python file it
        # reaches by file name is modelled as a program run by path with
        # its own directory first, and that directory's standard-library
        # names are members (the kernel's real by-path programs are
        # launched isolated as well: (a), ISOLATED_INTERPRETER_FLAGS).
        root = _REPO_ROOT
        entries = tuple(self_improvement.derived_authority_set(root))
        closure = import_closure(root, self_improvement._closure_seeds(root, self_improvement.declared_authority_members()))
        self.assertIn(f"{_KERNEL}_validation_unittest_child.py", closure.programs)
        self.assertIn(f"{_KERNEL}hook_client.py", closure.programs)
        directories = sorted({program.rpartition("/")[0] for program in closure.programs})
        for directory in directories:
            for name in sorted(sys.stdlib_module_names):
                for form in (f"{name}.py", f"{name}/__init__.py"):
                    path = f"{directory}/{form}"
                    with self.subTest(path=path):
                        self.assertTrue(_is_member(path, entries), path)


class EveryConsumerProjectsTheWholeSet(unittest.TestCase):
    """READONLY_PATHS, the merge perimeter, CODEOWNERS and the proposal check cover EVERY member.

    A consumer that keeps a list of its own drifts the day a member is added;
    iterating the function's output catches that.
    """

    @classmethod
    def setUpClass(cls) -> None:
        tracked = _tracked_files()
        cls.paths = sorted({path for entry in self_improvement.derived_authority_set(_REPO_ROOT)
                            for path in _witnesses(entry, tracked)})

    def test_the_set_has_witnesses(self) -> None:
        self.assertIn("tools/aria-acceptance/harness.py", self.paths)

    def test_readonly_paths_cover_every_member(self) -> None:
        for path in self.paths:
            with self.subTest(path=path):
                self.assertEqual(_readonly_refusal(path), f"readonly_path_write:{path}")

    def test_the_merge_perimeter_covers_every_member(self) -> None:
        for path in self.paths:
            with self.subTest(path=path):
                self.assertEqual(_merge_refusal(path), f"readonly_path_change:{path}")

    def test_codeowners_covers_every_member(self) -> None:
        for path in self.paths:
            with self.subTest(path=path):
                self.assertTrue(_owned(path), f"{path} has no CODEOWNERS owner")

    def test_the_envelope_mint_refuses_every_member(self) -> None:
        # Round 4 R1 — the mint (`classify_declared_surface`, which the
        # envelope's writable scope subtracts by) judges the one read-only set
        # the room, the hook and the merge perimeter judge, pattern entries
        # included. `json.py` and `pytest/__init__.py` are top-level names at
        # the repository root's import directory; `pytest` contains one.
        for path in (*self.paths, "json.py", "x.pyc", "pytest", "pytest/__init__.py"):
            with self.subTest(path=path):
                self.assertIsNotNone(safety.classify_declared_surface(path))
                self.assertEqual(safety.implementation_allowed_scope([path], admission_scope=None)[0], [])

    def test_a_surface_contains_what_lies_below_only_when_it_can_be_a_directory(self) -> None:
        # Round 5 (program-lead decision C) — the containment half judges a
        # surface by what the base tree holds at it, the checkout the running
        # kernel derives its set from. A regular FILE has no children, so it
        # is judged as itself only; a directory, and a name the tree does not
        # hold (unknown: fail closed), contain what lies below.
        name = "fixture-surface.json"
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(safety, "KERNEL_CHECKOUT_ROOT", Path(tmp)):
            with self.subTest(tree="absent"):
                self.assertEqual(safety.readonly_entry_below(name), "*/__init__.*")
                self.assertIsNotNone(safety.classify_declared_surface(name))
            (Path(tmp) / name).mkdir()
            with self.subTest(tree="directory"):
                self.assertEqual(safety.readonly_entry_below(name), "*/__init__.*")
                self.assertIsNotNone(safety.classify_declared_surface(name))
            (Path(tmp) / name).rmdir()
            (Path(tmp) / name).write_text("{}\n", encoding="utf-8")
            with self.subTest(tree="file"):
                self.assertIsNone(safety.readonly_entry_below(name))
                self.assertIsNone(safety.classify_declared_surface(name))
                self.assertEqual(safety.implementation_allowed_scope([name], admission_scope=None)[0], [name])

    def test_the_envelope_mint_admits_a_root_file_the_base_tree_holds(self) -> None:
        # Round 5 — a root package.json is a file in the base tree, so only
        # `readonly_entry_for` judges it; ARIA can declare a root-level file.
        self.assertEqual(safety.KERNEL_CHECKOUT_ROOT, _REPO_ROOT)
        self.assertTrue((_REPO_ROOT / "package.json").is_file())
        self.assertIsNone(safety.classify_declared_surface("package.json"))
        self.assertEqual(safety.implementation_allowed_scope(["package.json"], admission_scope=None)[0],
                         ["package.json"])

    def test_the_envelope_mint_refuses_a_one_segment_surface_the_base_tree_does_not_hold(self) -> None:
        # Round 5 — unknown is not a file: a name the tree does not hold can
        # become a package directory (`<name>/__init__.py`), so it stays refused.
        name = "aria-b1-surface-not-in-the-tree"
        self.assertFalse(os.path.lexists(_REPO_ROOT / name))
        self.assertEqual(safety.classify_declared_surface(name),
                         f"declared_surface_contains_readonly:{name}->*/__init__.*")
        self.assertEqual(safety.implementation_allowed_scope([name], admission_scope=None)[0], [])

    def test_the_self_change_proposal_check_refuses_every_member(self) -> None:
        for path in self.paths:
            with self.subTest(path=path):
                violations = self_improvement.authority_surface_violations([path])
                if path.startswith(self_improvement.SELF_CHANGE_ALLOWED_PREFIXES):
                    self.assertIn(f"authority_surface:{path}", violations)
                else:
                    self.assertIn(f"outside_kernel_scope:{path}", violations)


class TheImportRootsAreGuarded(unittest.TestCase):
    """R1/R3 — the suite's import roots are declared once, and no top-level name at either is free."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.entries = tuple(self_improvement.derived_authority_set(_REPO_ROOT))

    def test_the_kernel_package_name_at_the_repository_root_is_guarded_everywhere(self) -> None:
        # R3 — `python3 -m aria_kernel` from the repository root imports the cwd first.
        for path in ("aria_kernel/__init__.py", "aria_kernel/__main__.py", "aria_kernel.py"):
            with self.subTest(path=path):
                self.assertIsNotNone(safety.readonly_entry_for(path))
                self.assertTrue(_is_member(path, self.entries))
                self.assertEqual(_merge_refusal(path), f"readonly_path_change:{path}")
                self.assertTrue(_owned(path), f"{path} has no CODEOWNERS owner")

    def test_every_top_level_name_at_the_kernel_root_is_a_member(self) -> None:
        # R3 — the declared check, at aria-kernel/ (inside the self-change scope).
        for name in _SHADOWED_NAMES:
            for form in _SHADOW_FORMS:
                path = f"aria-kernel/{form.format(name)}"
                with self.subTest(path=path):
                    self.assertTrue(_is_member(path, self.entries))
                    self.assertEqual(self_improvement.authority_surface_violations([path]),
                                     [f"authority_surface:{path}"])


class TheSuiteHasOneOwner(unittest.TestCase):
    """R1 — the suite's import roots are declared once, and invariants_only_grow collects through the owner."""

    def test_the_suite_script_reads_the_one_declaration_of_the_roots(self) -> None:
        # R1 — scripts/ci/aria-suite-run.sh exports what aria-kernel/suite-import-roots declares.
        declared = (_REPO_ROOT / SUITE_IMPORT_ROOTS_RELPATH).read_text(encoding="utf-8").splitlines()
        self.assertEqual(declared, [root or "." for root in SUITE_PYTHONPATH_ROOTS])
        exported = subprocess.run(
            ["bash", "-c", f"source <(grep -E '^(suite_roots|export PYTHONPATH)=' {self_improvement.SUITE_RUNNER}"
                           f" | sed 's/^export //'); printf '%s' \"$PYTHONPATH\""],
            cwd=_REPO_ROOT, env={"PATH": os.environ["PATH"]}, capture_output=True, text=True, check=True).stdout
        self.assertEqual(exported, ":".join(declared))
        script = (_REPO_ROOT / self_improvement.SUITE_RUNNER).read_text(encoding="utf-8")
        self.assertNotIn('PYTHONPATH="aria-kernel', script)

    def test_invariants_only_grow_collects_through_the_suite_owner(self) -> None:
        # R1 — the collect mode is the owner's, not a private pytest argv.
        self.assertEqual(self_improvement.SUITE_COLLECT_ARGV, ("bash", self_improvement.SUITE_RUNNER, "--collect"))
        self.assertIn('= "--collect" ]', (_REPO_ROOT / self_improvement.SUITE_RUNNER).read_text(encoding="utf-8"))


# =============================================================================
# 3. The realized diff (new API): the exit fixtures of B1.
# =============================================================================

_BASE_FILES: dict[str, str] = {
    f"{_KERNEL}__init__.py": "",
    f"{_KERNEL}change_outcome.py": "RESOLVERS = ('post_merge_ci', 'reverted', 'finding_recurrence')\n",
    f"{_KERNEL}self_revert.py": "TRIGGER_CHANGE_OUTCOME = 'change_outcome_regression'\n",
    f"{_KERNEL}genesis_policy.py": (
        "import json\nfrom pathlib import Path\n\nDEFAULT_FILENAME = 'genesis_policy_default.json'\n\n\n"
        "def default_policy():\n    return json.loads((Path(__file__).parent / 'data' / DEFAULT_FILENAME).read_text())\n\n\n"
        "def self_change_caps(policy):\n    return policy['self_change']\n"),
    f"{_KERNEL}data/genesis_policy_default.json": '{"circuit_breaker": {"failure_threshold": 3}}\n',
    f"{_KERNEL}git_containment.py": "READ_ONLY_GIT_PARTS = ('config', 'hooks', 'packed-refs')\n",
    "aria-kernel/surface-reachability.unwritten.json": "{}\n",
    "aria-kernel/tests/__init__.py": "",
    "aria-kernel/tests/test_b1_witness.py": "def test_witness():\n    assert True\n",
    "tools/aria-poc/notes.md": "notes\n",
    "tools/aria-acceptance/harness.py": "import json\n",
}
_WAIVER = {"owner": "okan", "reason": "fixture", "expires_on": "2099-01-01", "finding_id": "ARIA-HIGH-767"}
# R3 — names a module at an import root would replace, and the forms the importer loads a name from.
_SHADOWED_NAMES = ("pytest", "_pytest", "pluggy", "unittest", "json", "subprocess", "ast", "jwt", "sitecustomize")
_SHADOW_FORMS = ("{}.py", "{}/__init__.py", "{}.abi3.so", "{}.pyc")


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=repo, capture_output=True, text=True, check=True).stdout.strip()


class TheRealizedDiffRefusesRailWeakening(unittest.TestCase):
    """B1 exit: every rail-weakening change is refused on the diff the branch REALLY carries."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-b1-diff-")
        self.addCleanup(self._tmp.cleanup)
        self.repo = make_local_git_repo(Path(self._tmp.name))
        files = dict(_BASE_FILES)
        files["aria-kernel/pyproject.toml"] = (_REPO_ROOT / "aria-kernel" / "pyproject.toml").read_text(encoding="utf-8")
        for rel, text in files.items():
            target = self.repo / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text, encoding="utf-8")
        _git(self.repo, "add", "-A")
        _git(self.repo, "commit", "-q", "-m", "fixture: base")
        self.base = _git(self.repo, "rev-parse", "HEAD")

    def _change(self, edits: dict[str, str | None], *, renames: dict[str, str] | None = None) -> str:
        _git(self.repo, "checkout", "-q", "--detach", self.base)
        for old, new in (renames or {}).items():
            _git(self.repo, "mv", old, new)
        for rel, text in edits.items():
            target = self.repo / rel
            if text is None:
                _git(self.repo, "rm", "-q", rel)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text, encoding="utf-8")
        _git(self.repo, "add", "-A")
        _git(self.repo, "commit", "-q", "-m", "fixture: change")
        return _git(self.repo, "rev-parse", "HEAD")

    def _violations(self, head: str, *, board_pin_path: str | None = None) -> list[str]:
        return list(self_improvement.realized_diff_authority_violations(
            self.repo, base=self.base, head=head, board_pin_path=board_pin_path))

    def test_each_rail_weakening_fixture_is_refused(self) -> None:
        pyproject = (self.repo / "aria-kernel" / "pyproject.toml").read_text(encoding="utf-8")
        fixtures: dict[str, dict[str, str | None]] = {
            # a change_outcome resolver dropped: post-merge regressions stop counting
            f"{_KERNEL}change_outcome.py": {f"{_KERNEL}change_outcome.py": "RESOLVERS = ('reverted',)\n"},
            # self_revert disarmed
            f"{_KERNEL}self_revert.py": {f"{_KERNEL}self_revert.py": "TRIGGER_CHANGE_OUTCOME = None\n"},
            # the self_change caps parser loosened
            f"{_KERNEL}genesis_policy.py": {
                f"{_KERNEL}genesis_policy.py": "def self_change_caps(policy):\n    return {}\n"},
            # the sandbox's read-only git parts widened
            f"{_KERNEL}git_containment.py": {f"{_KERNEL}git_containment.py": "READ_ONLY_GIT_PARTS = ()\n"},
            # round 4 R3 — the circuit breaker loosened through the package-default layer alone
            f"{_KERNEL}data/genesis_policy_default.json": {
                f"{_KERNEL}data/genesis_policy_default.json": '{"circuit_breaker": {"failure_threshold": 1000000}}\n'},
            # pytest collection narrowed
            "aria-kernel/pyproject.toml": {"aria-kernel/pyproject.toml": pyproject.replace(
                'python_files = ["*test*.py"]', 'python_files = ["*nothing*.py"]')},
            # a waiver added
            "aria-kernel/surface-reachability.unwritten.json": {
                "aria-kernel/surface-reachability.unwritten.json": json.dumps({"s": {"m": _WAIVER}}) + "\n"},
        }
        for path, edits in fixtures.items():
            with self.subTest(path=path):
                head = self._change(edits)
                self.assertIn(f"authority_surface:{path}", self._violations(head))

    def test_a_collection_config_that_outranks_pyproject_is_refused(self) -> None:
        # R3 — pytest reads aria-kernel/pytest.ini before pyproject.toml.
        head = self._change({"aria-kernel/pytest.ini": "[pytest]\npython_files = nothing_*.py\n"})
        self.assertIn("authority_surface:aria-kernel/pytest.ini", self._violations(head))

    def test_the_realized_judge_is_the_declared_judge(self) -> None:
        # R4 — a branch can touch nothing its declaration could not.
        paths = (".github/CODEOWNERS", "sitecustomize.py")
        head = self._change({path: "# b1\n" for path in paths})
        self.assertEqual(self._violations(head), [f"outside_kernel_scope:{path}" for path in paths])
        self.assertEqual(self_improvement.authority_surface_violations(list(paths)), self._violations(head))

    def test_an_attribute_at_base_does_not_change_what_base_derives(self) -> None:
        # R6 — `git archive` honours an in-tree export-ignore; the set reads the blobs.
        self.base = self._change({
            f"{_KERNEL}.gitattributes": "*.py export-ignore\n",
            f"{_KERNEL}evidence_probe.py": "class GitProbeSession:\n    pass\n",
            "tools/aria-acceptance/harness.py": "from aria_kernel.evidence_probe import GitProbeSession\n",
        })
        self.assertEqual(self_improvement._authority_set_at(self.repo, self.base),
                         self_improvement.derived_authority_set(self.repo))
        head = self._change({f"{_KERNEL}evidence_probe.py": "GitProbeSession = None\n"})
        self.assertIn(f"authority_surface:{_KERNEL}evidence_probe.py", self._violations(head))

    def test_a_conftest_the_change_adds_is_refused(self) -> None:
        head = self._change({"aria-kernel/conftest.py": "collect_ignore_glob = ['tests/*']\n"})
        self.assertIn("authority_surface:aria-kernel/conftest.py", self._violations(head))

    def test_a_rename_out_of_the_set_is_refused_by_its_old_path(self) -> None:
        head = self._change({}, renames={f"{_KERNEL}self_revert.py": f"{_KERNEL}b1_moved_rail.py"})
        self.assertIn(f"authority_surface:{_KERNEL}self_revert.py", self._violations(head))

    def test_a_deleted_member_is_refused(self) -> None:
        head = self._change({f"{_KERNEL}git_containment.py": None})
        self.assertIn(f"authority_surface:{_KERNEL}git_containment.py", self._violations(head))

    def test_a_tree_entry_that_climbs_out_is_refused_before_any_write(self) -> None:
        # R2 ride-along — a tree entry is written under the extraction directory by name.
        real = self_improvement._git_output
        escape = Path(tempfile.gettempdir()) / "b1-escaped.py"
        for name in ("aria-kernel/aria_kernel/../../../b1-escaped.py", "/b1-escaped.py"):

            def listing(repo_root: Path, *args: str, stdin: bytes | None = None, entry: str = name) -> bytes:
                if args[0] == "ls-tree":
                    return f"100644 blob {'0' * 40}\t{entry}\0".encode()
                return real(repo_root, *args, stdin=stdin)

            with self.subTest(name=name), mock.patch.object(self_improvement, "_git_output", side_effect=listing):
                with self.assertRaisesRegex(GovernanceError, "not a relative tree path"):
                    self_improvement._authority_set_at(self.repo, self.base)
        self.assertFalse(escape.exists())

    def test_a_module_added_at_the_kernel_import_root_under_any_name_is_refused(self) -> None:
        # R3 — aria-kernel/ precedes the standard library and site-packages.
        added = {f"aria-kernel/{form.format(name)}": "ARMED = False\n"
                 for name in _SHADOWED_NAMES for form in _SHADOW_FORMS}
        violations = self._violations(self._change(dict(added)))
        for path in added:
            with self.subTest(path=path):
                self.assertIn(f"authority_surface:{path}", violations)
                self.assertEqual(self_improvement.authority_surface_violations([path]),
                                 [f"authority_surface:{path}"])

    def test_an_ordinary_change_passes(self) -> None:
        head = self._change({"tools/aria-poc/notes.md": "more notes\n",
                             f"{_KERNEL}b1_unrelated_organ.py": "VALUE = 1\n"})
        self.assertEqual(self._violations(head), [])

    def test_only_the_verdict_bound_board_pin_path_is_exempt(self) -> None:
        witness = "aria-kernel/tests/test_b1_witness.py"
        pinned_only = self._change({witness: "def test_witness():\n    assert 1 + 1 == 2\n"})
        self.assertIn(f"authority_surface:{witness}", self._violations(pinned_only))
        self.assertEqual(self._violations(pinned_only, board_pin_path=witness), [])
        # a pin is one path, matched exactly: a directory does not exempt what is under it
        self.assertIn(f"authority_surface:{witness}",
                      self._violations(pinned_only, board_pin_path="aria-kernel/tests/"))
        # the pin exempts itself and nothing else in the same diff
        both = self._change({witness: "def test_witness():\n    assert 1 + 1 == 2\n",
                             f"{_KERNEL}self_revert.py": "TRIGGER_CHANGE_OUTCOME = None\n"})
        self.assertEqual(self._violations(both, board_pin_path=witness),
                         [f"authority_surface:{_KERNEL}self_revert.py"])


class TheRealizedDiffOverTheRealKernel(unittest.TestCase):
    """R1/R5 — the realized-diff check on a base that carries the REAL kernel and Board runner."""

    @classmethod
    def setUpClass(cls) -> None:
        cls._tmp = tempfile.TemporaryDirectory(prefix="aria-b1-real-")
        cls.repo = make_local_git_repo(Path(cls._tmp.name))
        listed = subprocess.run(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--",
                                 "aria-kernel/aria_kernel", "tools/aria-acceptance"],
                                cwd=_REPO_ROOT, capture_output=True, check=True).stdout.decode("utf-8")
        for rel in filter(None, listed.split("\0")):
            target = cls.repo / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(_REPO_ROOT / rel, target)
        _git(cls.repo, "add", "-A")
        _git(cls.repo, "commit", "-q", "-m", "fixture: the real kernel")
        cls.base = _git(cls.repo, "rev-parse", "HEAD")

    @classmethod
    def tearDownClass(cls) -> None:
        cls._tmp.cleanup()

    def _head(self, added: dict[str, str], edited: tuple[str, ...] = ()) -> str:
        _git(self.repo, "checkout", "-q", "--detach", self.base)
        for rel in edited:
            target = self.repo / rel
            target.write_text(target.read_text(encoding="utf-8") + "\nB1_WEAKENED = True\n", encoding="utf-8")
        for rel, text in added.items():
            target = self.repo / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text, encoding="utf-8")
        _git(self.repo, "add", "-A")
        _git(self.repo, "commit", "-q", "-m", "fixture: change")
        return _git(self.repo, "rev-parse", "HEAD")

    def test_an_edit_to_a_module_that_decides_the_set_is_refused(self) -> None:
        # R1 — one change to a decider, then a second one weakens a rail.
        deciders = tuple(f"{_KERNEL}{name}.py" for name in ("change_paths", "surface_waivers", "closure_reachability"))
        violations = self_improvement.realized_diff_authority_violations(self.repo, base=self.base,
                                                                         head=self._head({}, deciders))
        for path in deciders:
            with self.subTest(path=path):
                self.assertIn(f"authority_surface:{path}", violations)

    def test_an_edit_to_a_file_a_rail_executes_is_refused(self) -> None:
        # R2 — call-time imports (self_revert → own_pr_ci, change_outcome →
        # experiment/finding, implementation_safety → containment_probe and
        # operator_request_signature) and programs run by path (the
        # validation child, and the digest.py it loads by file).
        callees = tuple(f"{_KERNEL}{name}.py" for name in (
            "own_pr_ci", "experiment", "finding", "containment_probe", "operator_request_signature",
            "_validation_unittest_child", "digest"))
        violations = self_improvement.realized_diff_authority_violations(self.repo, base=self.base,
                                                                         head=self._head({}, callees))
        for path in callees:
            with self.subTest(path=path):
                self.assertIn(f"authority_surface:{path}", violations)

    def test_a_change_to_only_the_default_policy_layer_is_refused(self) -> None:
        # Round 4 R3 — genesis_policy.default_policy reads this file as layer
        # 1; it alone decides 18 of the 23 POLICY_KEYS, the circuit breaker
        # among them.
        rel = f"{_KERNEL}data/genesis_policy_default.json"
        policy = (self.repo / rel).read_text(encoding="utf-8")
        loosened = policy.replace('"failure_threshold": 3', '"failure_threshold": 1000000', 1)
        self.assertNotEqual(loosened, policy)
        violations = self_improvement.realized_diff_authority_violations(
            self.repo, base=self.base, head=self._head({rel: loosened}))
        self.assertEqual(violations, [f"authority_surface:{rel}"])

    def test_a_module_added_beside_a_member_under_its_name_is_refused(self) -> None:
        # R5 — EVERY kernel module member of the base's set (the rails, the
        # Board closure, the guards and what they import), shadowed two ways.
        entries = tuple(self_improvement.derived_authority_set(self.repo))
        stems = sorted(path.removesuffix(".py") for path in (
            p.relative_to(self.repo).as_posix() for p in (self.repo / _KERNEL).rglob("*.py"))
            if not path.endswith("/__init__.py") and _is_member(path, entries))
        for rail in ("self_revert", "change_outcome", "genesis_policy", "git_containment",
                     "evidence_trust", "self_improvement"):
            self.assertIn(f"{_KERNEL}{rail}", stems)
        shadows = {f"{stem}{form}": "ARMED = False\n" for stem in stems for form in ("/__init__.py", ".abi3.so")}
        violations = self_improvement.realized_diff_authority_violations(self.repo, base=self.base,
                                                                         head=self._head(shadows))
        for path in shadows:
            with self.subTest(path=path):
                self.assertIn(f"authority_surface:{path}", violations)


# =============================================================================
# 4. invariants_only_grow (new API).
# =============================================================================

_GROW_TESTS = '''\
import unittest


class B1GrowCase(unittest.TestCase):
    def test_b1_kept_case(self):
        self.assertTrue(True)

    def test_b1_dropped_case(self):
        self.assertTrue(True)


def test_b1_native_function():
    assert True
'''


_PIN = {"owner": "okan", "pinned_at": "2026-10-23", "reason": "fixture"}


def _suite_owner_files() -> tuple[str, ...]:
    """What a tree needs to run its suite owner's collect mode: the script,
    the unittest collector it runs, and the kernel package the collectors
    import with the repository's shared module it imports (unittest discovery
    reads `load_tests` off every package, and the kernel's PEP 562 hook
    answers by importing its export modules)."""
    listed = subprocess.run(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--",
                             "aria-kernel/aria_kernel", "tools/__init__.py", "tools/shared"], cwd=_REPO_ROOT,
                            capture_output=True, check=True).stdout.decode("utf-8")
    return (self_improvement.SUITE_RUNNER, self_improvement.SUITE_COLLECTOR, SUITE_IMPORT_ROOTS_RELPATH,
            "aria-kernel/tests/_helpers/__init__.py", *filter(None, listed.split("\0")))


class InvariantsOnlyGrow(unittest.TestCase):
    """Collected test ids base ⊆ head; waiver entries head ⊆ base."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.owner_files = _suite_owner_files()

    def setUp(self) -> None:
        # R8 — collection imports the trees' test modules, so it runs in the
        # validation sandbox; a host that cannot build one skips by the one name.
        require_sandbox_backend()
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-b1-grow-")
        self.addCleanup(self._tmp.cleanup)
        self.base = Path(self._tmp.name) / "base"
        kernel = self.base / "aria-kernel"
        (kernel / "tests").mkdir(parents=True)
        # R1 — each tree is collected by its own suite owner
        # (aria-suite-run.sh --collect), as CI runs it.
        for rel in self.owner_files:
            target = self.base / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(_REPO_ROOT / rel, target)
        shutil.copy(_REPO_ROOT / "aria-kernel" / "pyproject.toml", kernel / "pyproject.toml")
        (kernel / "tests" / "__init__.py").write_text("", encoding="utf-8")
        (kernel / "tests" / "test_b1_grow.py").write_text(_GROW_TESTS, encoding="utf-8")
        (kernel / "surface-reachability.unwritten.json").write_text(
            json.dumps({"b1_surface": {"KEPT": _WAIVER}}, indent=2) + "\n", encoding="utf-8")
        (kernel / "closure-reachability-baseline.json").write_text(
            json.dumps({"pinned": {"ORPHAN-HIGH-001:run_b1_kept": _PIN}, "schema_version": 1}, indent=2) + "\n",
            encoding="utf-8")
        self.head = Path(self._tmp.name) / "head"
        shutil.copytree(self.base, self.head)

    def _head_file(self, rel: str) -> Path:
        return self.head / "aria-kernel" / rel

    def _violations(self) -> list[str]:
        return list(self_improvement.invariants_only_grow(self.base, self.head))

    def test_an_identical_tree_has_no_violation(self) -> None:
        self.assertEqual(self._violations(), [])

    def test_an_added_test_and_a_removed_waiver_are_growth(self) -> None:
        self._head_file("tests/test_b1_grow.py").write_text(
            _GROW_TESTS + "\n\ndef test_b1_new_function():\n    assert True\n", encoding="utf-8")
        self._head_file("surface-reachability.unwritten.json").write_text("{}\n", encoding="utf-8")
        self.assertEqual(self._violations(), [])

    def test_a_removed_unittest_case_is_a_violation(self) -> None:
        self._head_file("tests/test_b1_grow.py").write_text(
            _GROW_TESTS.replace("    def test_b1_dropped_case(self):\n        self.assertTrue(True)\n", ""),
            encoding="utf-8")
        violations = self._violations()
        self.assertTrue(any(v.startswith("test_dropped:") and "test_b1_dropped_case" in v for v in violations),
                        violations)
        self.assertFalse(any("test_b1_kept_case" in v for v in violations), violations)

    def test_a_removed_native_pytest_function_is_a_violation(self) -> None:
        self._head_file("tests/test_b1_grow.py").write_text(
            _GROW_TESTS.replace("def test_b1_native_function():\n    assert True\n", ""), encoding="utf-8")
        violations = self._violations()
        self.assertTrue(any(v.startswith("test_dropped:") and "test_b1_native_function" in v
                            for v in violations), violations)

    def test_narrowed_collection_config_is_a_violation(self) -> None:
        pyproject = self._head_file("pyproject.toml")
        pyproject.write_text(pyproject.read_text(encoding="utf-8").replace(
            'python_files = ["*test*.py"]', 'python_files = ["*nothing*.py"]'), encoding="utf-8")
        violations = self._violations()
        self.assertTrue(any(v.startswith("test_dropped:") and "test_b1_native_function" in v
                            for v in violations), violations)

    def test_an_added_waiver_is_a_violation(self) -> None:
        self._head_file("surface-reachability.unwritten.json").write_text(
            json.dumps({"b1_surface": {"KEPT": _WAIVER, "ADDED": _WAIVER}}, indent=2) + "\n", encoding="utf-8")
        violations = self._violations()
        self.assertTrue(any(v.startswith("waiver_added:") and "ADDED" in v for v in violations), violations)
        self.assertFalse(any("KEPT" in v for v in violations), violations)

    def test_a_re_dated_waiver_is_a_violation(self) -> None:
        later = dict(_WAIVER, expires_on="2199-01-01")
        self._head_file("surface-reachability.unwritten.json").write_text(
            json.dumps({"b1_surface": {"KEPT": later}}, indent=2) + "\n", encoding="utf-8")
        violations = self._violations()
        self.assertTrue(any(v.startswith("waiver_added:") and "KEPT" in v for v in violations), violations)

    def _write_pins(self, pins: dict[str, dict[str, str]]) -> None:
        self._head_file("closure-reachability-baseline.json").write_text(
            json.dumps({"pinned": pins, "schema_version": 1}, indent=2) + "\n", encoding="utf-8")

    def test_a_pin_added_to_the_closure_baseline_is_a_violation(self) -> None:
        # R7 — the baseline's pins waive the closure gate.
        self._write_pins({"ORPHAN-HIGH-001:run_b1_kept": _PIN, "ORPHAN-HIGH-002:run_b1_added": _PIN})
        violations = self._violations()
        self.assertEqual([v for v in violations if v.startswith("waiver_added:")],
                         ['waiver_added:["aria-kernel/closure-reachability-baseline.json", '
                          '"closure_reachability_pin", "ORPHAN-HIGH-002", "run_b1_added"]'])

    def test_a_re_dated_closure_pin_is_a_violation(self) -> None:
        # R7
        self._write_pins({"ORPHAN-HIGH-001:run_b1_kept": dict(_PIN, pinned_at="2026-12-31")})
        violations = self._violations()
        self.assertTrue(any(v.startswith("waiver_added:") and "run_b1_kept" in v for v in violations), violations)

    def test_a_waiver_whose_joined_key_matches_an_existing_one_is_still_added(self) -> None:
        # R7 — surface `s.ACTIVE` member `legacy` and surface `s` member `ACTIVE.legacy`
        # both read `s.ACTIVE.legacy`; they are two waivers.
        manifest = self._head_file("surface-reachability.unwritten.json")
        manifest.write_text(json.dumps({"tool_status": {"ACTIVE.legacy": _WAIVER}}) + "\n", encoding="utf-8")
        shutil.copy(manifest, self.base / "aria-kernel" / "surface-reachability.unwritten.json")
        manifest.write_text(json.dumps({"tool_status": {"ACTIVE.legacy": _WAIVER},
                                        "tool_status.ACTIVE": {"legacy": _WAIVER}}) + "\n", encoding="utf-8")
        violations = self._violations()
        self.assertEqual([v for v in violations if v.startswith("waiver_added:")],
                         ['waiver_added:["aria-kernel/surface-reachability.unwritten.json", '
                          '"surface_waiver", "tool_status.ACTIVE", "legacy"]'])

    def _dropped(self) -> list[str]:
        return [v for v in self._violations() if v.startswith("test_dropped:")]

    def test_the_unittest_half_is_collected_as_the_suite_discovers_it(self) -> None:
        # R1 — the owner's unittest ids, not a second collector's.
        ids = self_improvement._collected_test_ids(self.base, side="base")
        self.assertIn("tests.test_b1_grow.B1GrowCase.test_b1_kept_case", ids)
        self.assertIn("tests/test_b1_grow.py::test_b1_native_function", ids)

    def test_a_load_tests_that_empties_the_module_drops_its_cases(self) -> None:
        # R1 — unittest discovery honours load_tests; a pytest walk did not.
        self._head_file("tests/test_b1_grow.py").write_text(
            _GROW_TESTS + "\n\ndef load_tests(loader, tests, pattern):\n    return unittest.TestSuite()\n",
            encoding="utf-8")
        self.assertEqual(sorted(self._dropped()), [
            "test_dropped:tests.test_b1_grow.B1GrowCase.test_b1_dropped_case",
            "test_dropped:tests.test_b1_grow.B1GrowCase.test_b1_kept_case",
        ])

    def test_a_tests_tree_without_its_package_init_drops_its_cases(self) -> None:
        # R1 — unittest discovery does not enter a directory that is not a package.
        self._head_file("tests/__init__.py").unlink()
        self.assertEqual(sorted(self._dropped()), [
            "test_dropped:tests.test_b1_grow.B1GrowCase.test_b1_dropped_case",
            "test_dropped:tests.test_b1_grow.B1GrowCase.test_b1_kept_case",
        ])

    def test_head_collection_does_not_see_a_secret_shaped_variable(self) -> None:
        # R8 — HEAD's test modules are candidate code: they get the validation env.
        (self.base / "aria-kernel" / "tests" / "test_b1_env.py").write_text(
            "def test_b1_saw_the_secret():\n    assert True\n", encoding="utf-8")
        self._head_file("tests/test_b1_env.py").write_text(
            "import os\n\nif os.environ.get('ARIA_B1_PROBE_TOKEN'):\n"
            "    def test_b1_saw_the_secret():\n        assert True\n", encoding="utf-8")
        with mock.patch.dict(os.environ, {"ARIA_B1_PROBE_TOKEN": "b1-sentinel"}):
            violations = self._violations()
        self.assertTrue(any(v.startswith("test_dropped:") and "test_b1_saw_the_secret" in v for v in violations),
                        violations)

    def test_head_collection_cannot_write_outside_its_tree(self) -> None:
        # R8 — collection runs in the validation sandbox.
        escape = self.base / "b1-escaped"
        self._head_file("tests/test_b1_write.py").write_text(
            f"try:\n    open({str(escape)!r}, 'w').write('escaped')\nexcept OSError:\n    pass\n\n\n"
            "def test_b1_writer():\n    assert True\n", encoding="utf-8")
        self._violations()
        self.assertFalse(escape.exists())


if __name__ == "__main__":
    unittest.main()
