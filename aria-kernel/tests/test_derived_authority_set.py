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

Board import closure: the floor pinned here is the closure over MODULE-LEVEL
imports. ``harness.py`` also imports ``aria_kernel.cycle`` inside a function;
that import runs the candidate under exam (ARIA's own cycle), not the scorer,
so it does not make the whole kernel Board code.
"""
from __future__ import annotations

import ast
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from aria_kernel import implementation_safety as safety
from aria_kernel import self_improvement
from aria_kernel.canonical_path import matches_repo_glob
from aria_kernel.risk_policy import codeowners_last_match, codeowners_rules
from aria_kernel.surface_waivers import WAIVER_MANIFESTS
from tests._helpers.git_fixtures import make_local_git_repo
from tests._helpers.pre_merge_evidence import fixture_pre_merge_evidence

READS_LIVE_CHECKOUT = (
    "the live .github/CODEOWNERS, tools/aria-acceptance/ imports and the tracked file list, "
    "which the derived authority set must cover"
)

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


def _module_level_kernel_imports(path: Path, kernel_dir: Path) -> set[str]:
    """``aria_kernel`` modules ``path`` imports at module level (top-level statements only)."""
    found: set[str] = set()
    for node in ast.parse(path.read_text(encoding="utf-8")).body:
        names: list[str] = []
        if isinstance(node, ast.ImportFrom):
            if node.level:
                names = [node.module.split(".")[0]] if node.module else [alias.name for alias in node.names]
            elif node.module and node.module.split(".")[0] == "aria_kernel":
                parts = node.module.split(".")
                names = [parts[1]] if len(parts) > 1 else [alias.name for alias in node.names]
        elif isinstance(node, ast.Import):
            names = [alias.name.split(".")[1] for alias in node.names
                     if alias.name.startswith("aria_kernel.")]
        found.update(name for name in names if (kernel_dir / f"{name}.py").is_file())
    return found


def _board_import_closure(root: Path) -> set[str]:
    """Kernel module paths reachable from tools/aria-acceptance/*.py over module-level imports."""
    kernel_dir = root / "aria-kernel" / "aria_kernel"
    pending: set[str] = set()
    for source in sorted((root / "tools" / "aria-acceptance").glob("*.py")):
        pending |= _module_level_kernel_imports(source, kernel_dir)
    seen: set[str] = set()
    while pending:
        name = pending.pop()
        if name in seen:
            continue
        seen.add(name)
        pending |= _module_level_kernel_imports(kernel_dir / f"{name}.py", kernel_dir) - seen
    return {f"{_KERNEL}{name}.py" for name in seen}


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

    def test_the_board_scorer_import_closure_is_in_the_set(self) -> None:
        closure = _board_import_closure(_REPO_ROOT)
        self.assertIn(f"{_KERNEL}evidence_trust.py", closure)  # the oracle sees the harness
        for path in sorted(closure):
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

    def test_the_self_change_proposal_check_refuses_every_member(self) -> None:
        for path in self.paths:
            with self.subTest(path=path):
                violations = self_improvement.authority_surface_violations([path])
                if path.startswith(self_improvement.SELF_CHANGE_ALLOWED_PREFIXES):
                    self.assertIn(f"authority_surface:{path}", violations)
                else:
                    self.assertIn(f"outside_kernel_scope:{path}", violations)


# =============================================================================
# 3. The realized diff (new API): the exit fixtures of B1.
# =============================================================================

_BASE_FILES: dict[str, str] = {
    f"{_KERNEL}__init__.py": "",
    f"{_KERNEL}change_outcome.py": "RESOLVERS = ('post_merge_ci', 'reverted', 'finding_recurrence')\n",
    f"{_KERNEL}self_revert.py": "TRIGGER_CHANGE_OUTCOME = 'change_outcome_regression'\n",
    f"{_KERNEL}genesis_policy.py": "def self_change_caps(policy):\n    return policy['self_change']\n",
    f"{_KERNEL}git_containment.py": "READ_ONLY_GIT_PARTS = ('config', 'hooks', 'packed-refs')\n",
    "aria-kernel/surface-reachability.unwritten.json": "{}\n",
    "aria-kernel/tests/__init__.py": "",
    "aria-kernel/tests/test_b1_witness.py": "def test_witness():\n    assert True\n",
    "tools/aria-poc/notes.md": "notes\n",
    "tools/aria-acceptance/harness.py": "import json\n",
}
_WAIVER = {"owner": "okan", "reason": "fixture", "expires_on": "2099-01-01", "finding_id": "ARIA-HIGH-767"}


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

    def test_a_conftest_the_change_adds_is_refused(self) -> None:
        head = self._change({"aria-kernel/conftest.py": "collect_ignore_glob = ['tests/*']\n"})
        self.assertIn("authority_surface:aria-kernel/conftest.py", self._violations(head))

    def test_a_rename_out_of_the_set_is_refused_by_its_old_path(self) -> None:
        head = self._change({}, renames={f"{_KERNEL}self_revert.py": f"{_KERNEL}b1_moved_rail.py"})
        self.assertIn(f"authority_surface:{_KERNEL}self_revert.py", self._violations(head))

    def test_a_deleted_member_is_refused(self) -> None:
        head = self._change({f"{_KERNEL}git_containment.py": None})
        self.assertIn(f"authority_surface:{_KERNEL}git_containment.py", self._violations(head))

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


class InvariantsOnlyGrow(unittest.TestCase):
    """Collected test ids base ⊆ head; waiver entries head ⊆ base."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-b1-grow-")
        self.addCleanup(self._tmp.cleanup)
        self.base = Path(self._tmp.name) / "base"
        kernel = self.base / "aria-kernel"
        (kernel / "tests").mkdir(parents=True)
        shutil.copy(_REPO_ROOT / "aria-kernel" / "pyproject.toml", kernel / "pyproject.toml")
        (kernel / "tests" / "__init__.py").write_text("", encoding="utf-8")
        (kernel / "tests" / "test_b1_grow.py").write_text(_GROW_TESTS, encoding="utf-8")
        (kernel / "surface-reachability.unwritten.json").write_text(
            json.dumps({"b1_surface": {"KEPT": _WAIVER}}, indent=2) + "\n", encoding="utf-8")
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


if __name__ == "__main__":
    unittest.main()
