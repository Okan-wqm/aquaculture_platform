"""The lifecycle lock's bound is a sum over the git steps the code actually runs.

`state_store.STATE_STORE_LIFECYCLE_LIVENESS_SECONDS` used to multiply a count
typed beside it (three git steps per publish attempt) by the attempt count.
The code under the lock ran five per lost-race attempt — push, the ls-remote
probe, the reconciliation fetch, the rebase's fresh fetch, the tree move —
plus a pending-recovery replay before attempt 1, so a healthy holder could
need 4500 s while a peer gave up at 2700 s: the very defect the constant had
been introduced to close, re-created by a number nothing checked.

`state_store_lifecycle_arcs` now registers every tree-or-remote-scaled git
call the holder makes as a STEP naming its call site, writes each arc as the
steps it runs, and derives the bound from the arcs. The same registry holds
the arcs kept open under ONE `ledger.state_transaction` (the pending
recovery, the rebase, the checkout cleanup), from which
`ledger.STATE_LOCK_LIVENESS_SECONDS` is derived — that bound was typed as
"two steps at cap" while the recovery holds three. This module is the check
that keeps the registry honest against the code: it walks `state_store`'s
AST from every `with _state_store_lifecycle_lock(...)` and every `with
state_transaction(...)` region, follows every call (into the sibling modules
the region reaches — the snapshot verifier, the workspace identity, the
ledger) and, for every git invocation it finds:

* the operation must be classified (tree-or-remote-scaled or
  metadata-scaled) — an unclassified command fails until someone decides
  whether it can run to the cap;
* a tree-or-remote-scaled operation must run through a step runner with a
  registered step whose operation and site match the call;
* every registered step must be run at the site it names, and be in an arc;
* the steps reachable from each arc's root function must be exactly the
  steps its arcs declare — a new heavy call reachable from the publish
  orchestrator that no arc prices fails here;
* the transaction holders that reach a heavy step must be exactly the
  registered transaction arcs, each reaching exactly its arc's steps.

The runtime half is pinned too: `_run_git_bytes_bounded` refuses a
tree-or-remote-scaled call under the lock outside a registered step, and
under a transaction any step no transaction arc prices. Multiplicity along
an arc — the same step twice on one path — is invisible to a set walk and
to the runtime guard; `tests/test_state_lock_arcs_traced.py` pins it by
running the holders and reading the spawns.
"""
from __future__ import annotations

import ast
import importlib
import subprocess
import tempfile
import unittest
from dataclasses import dataclass
from pathlib import Path
from unittest import mock

from aria_kernel import ledger as ledger_module
from aria_kernel import state_store
from aria_kernel import state_store_lifecycle_arcs as arcs
from aria_kernel.runtime_profile import set_profile

_STATE_STORE_MODULE = "aria_kernel.state_store"
# Runners whose call carries the git argv: the operation is read from the
# call's own arguments. `_git_commit` always commits.
_STEP_RUNNERS = frozenset({"_run_git_step", "_git_step"})
_FIXED_OPERATION_RUNNERS = {"_git_commit": "commit"}
# state_store's own runner chain: each forwards the argv it was handed to
# the next, down to the one `subprocess.Popen`. Their CALLERS name the
# operation; their bodies carry no operation of their own.
_ARGV_FORWARDING_RUNNERS = frozenset({
    "_git", "_run_git", "_git_succeeds", "_run_git_bytes_bounded", "_git_commit",
    *_STEP_RUNNERS,
})


@dataclass(frozen=True)
class _GitCallSite:
    module: str
    function: str
    operation: str
    step_name: str | None
    line: int


class _ModuleSource:
    """One module's AST, its functions by name, and its `from .x import y` map."""

    def __init__(self, module_name: str) -> None:
        self.name = module_name
        module = importlib.import_module(module_name)
        self.tree = ast.parse(Path(module.__file__).read_text(encoding="utf-8"))
        self.functions: dict[str, ast.FunctionDef] = {}
        for node in ast.walk(self.tree):
            if isinstance(node, ast.FunctionDef):
                self.functions.setdefault(node.name, node)
        self.module_imports = self._imports(self.tree)
        self.runners = {
            name for name, fn in self.functions.items() if self._is_runner(fn)
        }

    @staticmethod
    def _imports(scope: ast.AST) -> dict[str, str]:
        found: dict[str, str] = {}
        for node in ast.walk(scope):
            if isinstance(node, ast.ImportFrom) and node.level == 1 and node.module:
                for alias in node.names:
                    found[alias.asname or alias.name] = f"aria_kernel.{node.module}"
        return found

    @staticmethod
    def _git_argv_literal(call: ast.Call) -> ast.List | None:
        """The `["git", ...]` list literal of a `subprocess.run`/`Popen` call."""
        func = call.func
        if not (isinstance(func, ast.Attribute) and func.attr in {"run", "Popen", "check_output"}):
            return None
        if not (isinstance(func.value, ast.Name) and func.value.id == "subprocess"):
            return None
        argv = call.args[0] if call.args else next(
            (kw.value for kw in call.keywords if kw.arg == "args"), None,
        )
        if isinstance(argv, ast.List) and argv.elts:
            head = argv.elts[0]
            if isinstance(head, ast.Constant) and head.value == "git":
                return argv
        return None

    def _is_runner(self, fn: ast.FunctionDef) -> bool:
        """A function that spawns git with an argv it was HANDED (a starred
        parameter): its callers name the operation, it does not."""
        for node in ast.walk(fn):
            if isinstance(node, ast.Call):
                literal = self._git_argv_literal(node)
                if literal is not None and any(isinstance(e, ast.Starred) for e in literal.elts):
                    return True
        return False


def _tokens(nodes: list[ast.expr]) -> list[str]:
    """Literal string tokens of an argv, every non-literal as `?`."""
    out: list[str] = []
    for node in nodes:
        if isinstance(node, (ast.Tuple, ast.List)):
            out.extend(_tokens(list(node.elts)))
        elif isinstance(node, ast.Constant) and isinstance(node.value, str):
            out.append(node.value)
        else:
            out.append("?")
    return out


def _operation(tokens: list[str]) -> str:
    """The same classification the runtime applies (`arcs.git_operation`),
    after the `-C <dir>` the raw runner adds itself."""
    stripped: list[str] = []
    index = 0
    while index < len(tokens):
        if tokens[index] == "-C":
            index += 2
            continue
        stripped.append(tokens[index])
        index += 1
    return arcs.git_operation(tuple(stripped))


class _LockedRegionWalk:
    """Every git call reachable from a set of seed functions, across modules."""

    def __init__(self) -> None:
        self.modules: dict[str, _ModuleSource] = {}
        self.sites: list[_GitCallSite] = []
        self.visited: set[tuple[str, str]] = set()

    def module(self, name: str) -> _ModuleSource:
        if name not in self.modules:
            self.modules[name] = _ModuleSource(name)
        return self.modules[name]

    def walk(self, seeds: list[tuple[str, str]]) -> "_LockedRegionWalk":
        stack = list(seeds)
        while stack:
            module_name, function = stack.pop()
            key = (module_name, function)
            if key in self.visited:
                continue
            self.visited.add(key)
            source = self.module(module_name)
            fn = source.functions.get(function)
            if fn is None:
                continue
            stack.extend(self._visit(source, fn))
        return self

    def walk_regions(
        self, source: _ModuleSource, regions: dict[str, list[ast.With]],
    ) -> "_LockedRegionWalk":
        """Every git call reachable from `with` bodies, keyed by enclosing function.

        The body is a scope of its own: a step runner called directly inside
        it (the checkout cleanup's `worktree remove`) is a site of the
        enclosing function, and every function the body calls is a seed.
        """
        for holder, withs in regions.items():
            for region in withs:
                self.walk(self._visit_scope(source, holder, region, source.module_imports))
        return self

    def _visit(self, source: _ModuleSource, fn: ast.FunctionDef) -> list[tuple[str, str]]:
        if source.name == _STATE_STORE_MODULE and fn.name in _ARGV_FORWARDING_RUNNERS:
            return []
        imports = {**source.module_imports, **source._imports(fn)}
        return self._visit_scope(source, fn.name, fn, imports)

    def _visit_scope(
        self, source: _ModuleSource, scope: str, root: ast.AST, imports: dict[str, str],
    ) -> list[tuple[str, str]]:
        callees: list[tuple[str, str]] = []
        for node in ast.walk(root):
            if not isinstance(node, ast.Call):
                continue
            literal = source._git_argv_literal(node)
            if literal is not None:
                if scope in source.runners:
                    continue  # the callers of a runner name the operation
                self.sites.append(_GitCallSite(
                    source.name, scope, _operation(_tokens(list(literal.elts))[1:]), None, node.lineno,
                ))
                continue
            if not isinstance(node.func, ast.Name):
                continue
            name = node.func.id
            if name in _FIXED_OPERATION_RUNNERS:
                self.sites.append(_GitCallSite(
                    source.name, scope, _FIXED_OPERATION_RUNNERS[name], None, node.lineno,
                ))
            elif name in _STEP_RUNNERS:
                step = node.args[0]
                self.sites.append(_GitCallSite(
                    source.name, scope, _operation(_tokens(list(node.args[2:]))),
                    step.id if isinstance(step, ast.Name) else "?", node.lineno,
                ))
            elif name in source.runners or name in {"_git", "_git_succeeds", "_run_git", "_run_git_bytes_bounded"}:
                argv_nodes = list(node.args[1:]) + [kw.value for kw in node.keywords if kw.arg in {"args", "argv"}]
                self.sites.append(_GitCallSite(
                    source.name, scope, _operation(_tokens(argv_nodes)), None, node.lineno,
                ))
            if name in source.functions:
                callees.append((source.name, name))
            elif name in imports:
                callees.append((imports[name], name))
        return callees


def _own_nodes(fn: ast.FunctionDef):
    """`ast.walk` over one function's body without descending into nested scopes."""
    stack: list[ast.AST] = list(fn.body)
    while stack:
        node = stack.pop()
        yield node
        for child in ast.iter_child_nodes(node):
            if not isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef)):
                stack.append(child)


def _regions(source: _ModuleSource, context: str) -> dict[str, list[ast.With]]:
    """Every `with <context>(...)` body in the module, keyed by its enclosing function."""
    found: dict[str, list[ast.With]] = {}
    for fn in source.functions.values():
        for node in _own_nodes(fn):
            if isinstance(node, ast.With) and any(
                isinstance(item.context_expr, ast.Call)
                and isinstance(item.context_expr.func, ast.Name)
                and item.context_expr.func.id == context
                for item in node.items
            ):
                found.setdefault(fn.name, []).append(node)
    return found


def _heavy_steps_at(sites: list[_GitCallSite]) -> frozenset[arcs.LifecycleGitStep]:
    return frozenset(
        getattr(state_store, str(site.step_name))
        for site in sites
        if site.operation in arcs.TREE_OR_REMOTE_SCALED_GIT_OPERATIONS and site.step_name
    )


def _heavy_steps_reachable_from(root: str) -> frozenset[arcs.LifecycleGitStep]:
    return _heavy_steps_at(_LockedRegionWalk().walk([(_STATE_STORE_MODULE, root)]).sites)


class EveryGitCallUnderTheLockIsClassifiedAndPriced(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        source = _ModuleSource(_STATE_STORE_MODULE)
        cls.regions = _regions(source, "_state_store_lifecycle_lock")
        cls.walk = _LockedRegionWalk().walk_regions(source, cls.regions)
        cls.sites = cls.walk.sites

    def test_the_walk_reaches_the_locked_arcs_and_finds_git(self) -> None:
        self.assertTrue(self.regions, "no lifecycle-locked region found in state_store")
        reached = {function for _module, function in self.walk.visited}
        for root in (
            "_publish_with_contention_replay_locked",
            "_checkout_state_store_locked",
            "_recover_pending_state_replay_locked",
            "_rebase_store_onto_remote_locked",
            "_reconcile_nonzero_push",
        ):
            self.assertIn(root, reached)
        self.assertGreater(len(self.sites), 20)
        # The walk crosses into the sibling modules the region calls.
        self.assertIn("aria_kernel.autonomy_evidence", {site.module for site in self.sites})

    def test_every_operation_is_classified(self) -> None:
        classified = arcs.TREE_OR_REMOTE_SCALED_GIT_OPERATIONS | arcs.METADATA_SCALED_GIT_OPERATIONS
        unclassified = sorted(
            f"{site.module}.{site.function}:{site.line} git {site.operation!r}"
            for site in self.sites if site.operation not in classified
        )
        self.assertEqual(unclassified, [], "classify these in state_store_lifecycle_arcs")
        self.assertFalse(
            arcs.TREE_OR_REMOTE_SCALED_GIT_OPERATIONS & arcs.METADATA_SCALED_GIT_OPERATIONS,
        )

    def test_every_tree_or_remote_scaled_call_is_a_registered_step_at_its_site(self) -> None:
        heavy = [s for s in self.sites if s.operation in arcs.TREE_OR_REMOTE_SCALED_GIT_OPERATIONS]
        self.assertTrue(heavy)
        for site in heavy:
            with self.subTest(site=f"{site.module}.{site.function}:{site.line}"):
                self.assertEqual(site.module, _STATE_STORE_MODULE, "a heavy call outside the registry's module")
                self.assertIsNotNone(site.step_name, f"git {site.operation} runs outside a step runner")
                step = getattr(state_store, str(site.step_name))
                self.assertIsInstance(step, arcs.LifecycleGitStep)
                self.assertEqual(step.operation, site.operation)
                self.assertEqual(step.site, site.function)

    def test_every_registered_step_runs_at_its_site_and_sits_in_an_arc(self) -> None:
        run_at = {
            (getattr(state_store, str(s.step_name)), s.function)
            for s in self.sites if s.step_name
        }
        in_arcs: set[arcs.LifecycleGitStep] = set()
        for arc in arcs.LIFECYCLE_ARCS.values():
            in_arcs |= arcs.arc_steps(arc)
        for step in arcs.registered_lifecycle_git_steps():
            with self.subTest(step=step.name):
                self.assertIn((step, step.site), run_at, "registered but not run at its site")
                self.assertIn(step, in_arcs, "registered but priced by no arc")

    def test_each_arc_root_reaches_exactly_the_steps_its_arcs_declare(self) -> None:
        expected = {
            "_publish_with_contention_replay_locked":
                arcs.arc_steps(arcs.PUBLISH_ATTEMPT_ARC) | arcs.arc_steps(arcs.PENDING_RECOVERY_ARC),
            "_checkout_state_store_locked":
                arcs.arc_steps(arcs.CHECKOUT_RESTORE_ARC) | arcs.arc_steps(arcs.CHECKOUT_BOOTSTRAP_ARC),
            "_recover_pending_state_replay_locked": arcs.arc_steps(arcs.PENDING_RECOVERY_ARC),
        }
        for root, steps in expected.items():
            with self.subTest(root=root):
                self.assertEqual(
                    {s.name for s in _heavy_steps_reachable_from(root)},
                    {s.name for s in steps},
                )


class EveryStateTransactionHolderRunsExactlyItsArc(unittest.TestCase):
    """The transaction bound is a sum over the transaction arcs, so every
    `with state_transaction(...)` region in state_store that reaches a heavy
    git step must be one of the registered arcs and reach exactly its steps;
    a fourth holder, or a step added to one of the three, fails here until
    the registry prices it."""

    def test_the_holders_that_reach_git_are_exactly_the_registered_arcs(self) -> None:
        source = _ModuleSource(_STATE_STORE_MODULE)
        regions = _regions(source, "state_transaction")
        self.assertTrue(regions, "no state-transaction region found in state_store")
        reached: dict[str, frozenset[arcs.LifecycleGitStep]] = {}
        for holder, withs in regions.items():
            walk = _LockedRegionWalk().walk_regions(source, {holder: withs})
            for site in walk.sites:
                if site.operation in arcs.TREE_OR_REMOTE_SCALED_GIT_OPERATIONS:
                    self.assertIsNotNone(site.step_name, f"{holder}: git {site.operation} outside a step")
            steps = _heavy_steps_at(walk.sites)
            if steps:
                reached[holder] = steps
        expected = {
            "_recover_pending_state_replay_locked": arcs.PENDING_RECOVERY_ARC,
            "_rebase_store_onto_remote_with_lifecycle": arcs.REBASE_TRANSACTION_ARC,
            "_clear_existing_store": arcs.CHECKOUT_CLEANUP_TRANSACTION_ARC,
        }
        self.assertEqual(set(reached), set(expected))
        for holder, arc in expected.items():
            with self.subTest(holder=holder):
                self.assertIn(arc, arcs.STATE_TRANSACTION_ARCS.values())
                self.assertEqual({s.name for s in reached[holder]}, {s.name for s in arcs.arc_steps(arc)})
        self.assertEqual(len(arcs.STATE_TRANSACTION_ARCS), len(expected))


class TheBoundIsTheSumOverTheArcs(unittest.TestCase):
    def test_the_arcs_are_the_holders_sequences(self) -> None:
        names = lambda arc: [  # noqa: E731 - a local reader
            tuple(s.name for s in e) if isinstance(e, tuple) else e.name for e in arc
        ]
        self.assertEqual(
            names(arcs.PENDING_RECOVERY_ARC),
            ["remote_branch_fetch", "owned_store_fast_forward", "remote_tip_probe"],
        )
        # The five the typed count missed two of, in the order they run.
        self.assertEqual(
            names(arcs.PUBLISH_ATTEMPT_ARC),
            [
                "publish_push", "remote_tip_probe", "remote_branch_fetch",
                "remote_branch_fetch", ("replay_reset", "owned_store_fast_forward"),
            ],
        )
        self.assertEqual(len(arcs.CHECKOUT_RESTORE_ARC), 9)
        self.assertEqual(len(arcs.CHECKOUT_BOOTSTRAP_ARC), 5)
        # The transaction arcs are spliced into the lifecycle arcs where the
        # holder opens the transaction, so one registry cannot describe the
        # rebase or the cleanup differently from the other.
        self.assertEqual(arcs.PUBLISH_ATTEMPT_ARC[3:], arcs.REBASE_TRANSACTION_ARC)
        self.assertEqual(arcs.CHECKOUT_RESTORE_ARC[3:6], arcs.PENDING_RECOVERY_ARC)
        self.assertEqual(arcs.CHECKOUT_RESTORE_ARC[6:8], arcs.CHECKOUT_CLEANUP_TRANSACTION_ARC)
        self.assertEqual(
            names(arcs.CHECKOUT_CLEANUP_TRANSACTION_ARC), ["remote_tip_probe", "store_worktree_remove"],
        )

    def test_the_numbers_are_derived_and_pinned(self) -> None:
        cap = arcs.GIT_TIMEOUT_SECONDS
        self.assertEqual(arcs.arc_seconds(arcs.PENDING_RECOVERY_ARC), 3 * cap)
        self.assertEqual(arcs.arc_seconds(arcs.PUBLISH_ATTEMPT_ARC), 5 * cap)
        self.assertEqual(
            arcs.STATE_STORE_PUBLISH_ARC_SECONDS,
            3 * cap + arcs.PUBLISH_MAX_ATTEMPTS * 5 * cap,
        )
        self.assertEqual(arcs.STATE_STORE_CHECKOUT_ARC_SECONDS, 9 * cap)
        self.assertEqual(
            arcs.STATE_STORE_LIFECYCLE_LIVENESS_SECONDS,
            max(arcs.STATE_STORE_PUBLISH_ARC_SECONDS, arcs.STATE_STORE_CHECKOUT_ARC_SECONDS),
        )
        # The values, so a retune of the cap or the attempt count is a
        # visible change here and in every consumer that pins these.
        self.assertEqual(arcs.STATE_STORE_PUBLISH_ARC_SECONDS, 5400.0)
        self.assertEqual(arcs.STATE_STORE_CHECKOUT_ARC_SECONDS, 2700.0)
        self.assertEqual(arcs.STATE_STORE_LIFECYCLE_LIVENESS_SECONDS, 5400.0)
        # Strictly more than the typed bound this replaces (3 x 3 x cap).
        self.assertGreater(arcs.STATE_STORE_LIFECYCLE_LIVENESS_SECONDS, 9 * cap)
        # And what state_store re-exports is this derivation, not a copy.
        self.assertIs(state_store.STATE_STORE_LIFECYCLE_LIVENESS_SECONDS, arcs.STATE_STORE_LIFECYCLE_LIVENESS_SECONDS)
        self.assertIs(state_store.STATE_STORE_CHECKOUT_ARC_SECONDS, arcs.STATE_STORE_CHECKOUT_ARC_SECONDS)

    def test_the_transaction_bound_is_the_longest_transaction_arc(self) -> None:
        cap = arcs.GIT_TIMEOUT_SECONDS
        self.assertEqual(sorted(arcs.STATE_TRANSACTION_ARCS), ["checkout_cleanup", "pending_recovery", "rebase"])
        self.assertEqual(
            arcs.STATE_LOCK_LIVENESS_SECONDS,
            max(arcs.arc_seconds(arc) for arc in arcs.STATE_TRANSACTION_ARCS.values()),
        )
        self.assertEqual(arcs.STATE_LOCK_LIVENESS_SECONDS, arcs.arc_seconds(arcs.PENDING_RECOVERY_ARC))
        self.assertEqual(arcs.STATE_LOCK_LIVENESS_SECONDS, 3 * cap)
        self.assertEqual(arcs.STATE_LOCK_LIVENESS_SECONDS, 900.0)
        # The ledger's default is this derivation, not a number typed there.
        self.assertIs(ledger_module.STATE_LOCK_LIVENESS_SECONDS, arcs.STATE_LOCK_LIVENESS_SECONDS)
        # What a transaction may hold: the union of its arcs, and nothing a
        # lifecycle arc alone prices (the push, the worktree adds).
        self.assertEqual(
            {s.name for s in arcs.STATE_TRANSACTION_STEPS},
            {"remote_branch_fetch", "owned_store_fast_forward", "remote_tip_probe",
             "replay_reset", "store_worktree_remove"},
        )
        self.assertNotIn(arcs.PUBLISH_PUSH_STEP, arcs.STATE_TRANSACTION_STEPS)
        # The lifecycle holder contains every transaction holder, so its
        # bound is at least the transaction bound.
        self.assertGreaterEqual(arcs.STATE_STORE_LIFECYCLE_LIVENESS_SECONDS, arcs.STATE_LOCK_LIVENESS_SECONDS)

    def test_the_registry_refuses_what_no_arc_could_price(self) -> None:
        with self.assertRaisesRegex(ValueError, "not_tree_or_remote_scaled"):
            arcs.lifecycle_git_step("a_rev_parse", "rev-parse", site="_nowhere")
        with self.assertRaisesRegex(ValueError, "duplicate"):
            arcs.lifecycle_git_step("publish_push", "push", site="_publish_state_locked")

    def test_git_operation_names_the_command_not_its_configuration(self) -> None:
        self.assertEqual(arcs.git_operation(("-c", "user.name=x", "-c", "y=z", "commit", "-m", "m")), "commit")
        self.assertEqual(arcs.git_operation(("worktree", "add", "--detach", "/p")), "worktree add")
        self.assertEqual(arcs.git_operation(("worktree", "list", "--porcelain")), "worktree list")
        self.assertEqual(arcs.git_operation(("push", "origin", "a:b")), "push")
        self.assertEqual(arcs.git_operation(()), "")

    def test_an_index_edit_is_metadata_scaled_while_a_tree_removal_stays_priced(self) -> None:
        # The publish preamble drops inherited unclaimable entries with
        # `git rm --cached` in pathspec slices under the lifecycle lock: an
        # index edit that scales with the entry count, not with the tree on
        # disk or the remote — the walker found it unregistered on the
        # ARIA-HIGH-090 publisher once the arcs registry landed. `rm` without
        # the flag removes a tree (the bootstrap's tree clear) and is priced.
        self.assertEqual(arcs.git_operation(("rm", "--cached", "--quiet", "--", "a", "b")), "rm --cached")
        self.assertEqual(arcs.git_operation(("-c", "x=y", "rm", "--quiet", "--cached", "--", "a")), "rm --cached")
        self.assertEqual(arcs.git_operation(("rm", "-rf", "--quiet", "--ignore-unmatch", ".")), "rm")
        self.assertIn("rm --cached", arcs.METADATA_SCALED_GIT_OPERATIONS)
        self.assertIn("rm", arcs.TREE_OR_REMOTE_SCALED_GIT_OPERATIONS)
        self.assertNotIn("rm --cached", arcs.TREE_OR_REMOTE_SCALED_GIT_OPERATIONS)


class TheRuntimeRefusesAnUnregisteredHeavyCallUnderTheLock(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-lifecycle-guard-"))
        subprocess.run(["git", "init", "-q"], cwd=self.tmp, check=True)

    def tearDown(self) -> None:
        import shutil

        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_a_bare_fetch_under_the_lock_is_refused_and_a_registered_one_runs(self) -> None:
        with state_store._state_store_lifecycle_lock(self.tmp):
            with self.assertRaisesRegex(
                state_store.StateStoreError, "state_store_lifecycle_git_step_unregistered: git fetch",
            ):
                state_store._run_git(self.tmp, ("fetch", "origin"))
            # Metadata-scaled calls are not steps and run freely.
            self.assertEqual(state_store._run_git(self.tmp, ("rev-parse", "--is-bare-repository")).returncode, 0)
            # The same fetch through its registered step reaches git (which
            # answers that there is no such remote — an answer, not a refusal).
            proc = state_store._run_git_step(
                state_store.REMOTE_BRANCH_FETCH_STEP, self.tmp, ("fetch", "origin"),
            )
            self.assertNotEqual(proc.returncode, 0)
        # Outside the lock a heavy call is nobody's arc and runs unguarded.
        self.assertNotEqual(state_store._run_git(self.tmp, ("fetch", "origin")).returncode, 0)

    def test_a_step_no_transaction_arc_prices_is_refused_under_a_transaction(self) -> None:
        # The transaction bound prices fetch/reset/merge/probe/remove; a push
        # is a registered lifecycle step and still cannot run while the
        # group locks are held — every claim behind them would wait for it
        # unpriced. A transaction-arc step reaches git; a bare heavy call
        # is refused whether or not the lifecycle lock is held.
        tools = self.tmp / "aria-tools"
        set_profile("standard", operator_approval_ref="arc-guard-t", base_dir=tools)
        queue = tools / "queues" / "next_cycle_queue.jsonl"
        self.assertIsNone(arcs.active_state_transaction())
        with ledger_module.state_transaction([queue]):
            self.assertIsNotNone(arcs.active_state_transaction())
            with self.assertRaisesRegex(
                state_store.StateStoreError, "state_store_transaction_git_step_unpriced: git push",
            ):
                state_store._run_git_step(state_store.PUBLISH_PUSH_STEP, self.tmp, ("push", "origin", "HEAD"))
            with self.assertRaisesRegex(
                state_store.StateStoreError, "state_store_transaction_git_step_unpriced: git fetch",
            ):
                state_store._run_git(self.tmp, ("fetch", "origin"))
            proc = state_store._run_git_step(
                state_store.REMOTE_BRANCH_FETCH_STEP, self.tmp, ("fetch", "origin"),
            )
            self.assertNotEqual(proc.returncode, 0)  # git answered: no such remote
            self.assertEqual(state_store._run_git(self.tmp, ("rev-parse", "--is-bare-repository")).returncode, 0)
        self.assertIsNone(arcs.active_state_transaction())

    def test_a_step_cannot_run_an_operation_it_does_not_price(self) -> None:
        with self.assertRaisesRegex(state_store.StateStoreError, "operation_mismatch"):
            state_store._run_git_step(state_store.PUBLISH_PUSH_STEP, self.tmp, ("fetch", "origin"))

    def test_the_step_marker_is_restored_after_the_step(self) -> None:
        self.assertIsNone(arcs.active_lifecycle_step())
        with arcs.lifecycle_step_active(state_store.PUBLISH_PUSH_STEP):
            self.assertIs(arcs.active_lifecycle_step(), state_store.PUBLISH_PUSH_STEP)
            with arcs.lifecycle_step_active(state_store.REPLAY_RESET_STEP):
                self.assertIs(arcs.active_lifecycle_step(), state_store.REPLAY_RESET_STEP)
            self.assertIs(arcs.active_lifecycle_step(), state_store.PUBLISH_PUSH_STEP)
        self.assertIsNone(arcs.active_lifecycle_step())

    def test_the_guard_is_thread_local_like_the_lock(self) -> None:
        # A step active on this thread does not license another thread.
        import threading

        outcome: list[BaseException | None] = []

        def other_thread() -> None:
            try:
                with state_store._state_store_lifecycle_lock(self.tmp):
                    state_store._run_git(self.tmp, ("fetch", "origin"))
                outcome.append(None)
            except BaseException as exc:  # noqa: BLE001 - thread handoff
                outcome.append(exc)

        with mock.patch.object(state_store, "STATE_STORE_LIFECYCLE_LIVENESS_SECONDS", 5.0):
            worker = threading.Thread(target=other_thread, daemon=True)
            with arcs.lifecycle_step_active(state_store.REMOTE_BRANCH_FETCH_STEP):
                worker.start()
                worker.join(timeout=10.0)
        self.assertEqual(len(outcome), 1)
        self.assertIsInstance(outcome[0], state_store.StateStoreError)


if __name__ == "__main__":
    unittest.main()
