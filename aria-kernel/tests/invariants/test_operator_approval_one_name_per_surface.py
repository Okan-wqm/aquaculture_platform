"""ARIA-HIGH-238 — one surface name and one instance-bound scope per stop-clearing verb.

WHY THIS EXISTS. Two lines of ARIA-HIGH-238 work meet when main merges into
the slow-c landing. main (PR #2054) declared ``breaker_reset`` and
``breaker_evidence_quarantine`` with the scope ``("breaker", "tripped_at")``
and ``mcp_unquarantine`` with ``("server", "quarantined_at")``: an approval
names the trip or the quarantine it undoes, so an act posted for one cannot
clear the next (``verify_operator_approval`` has no lower freshness bound).
slow-c declared ``circuit_breaker_reset``, ``breaker_evidence_quarantine`` and
``cost_breaker_reset`` with the constant scope ``("target",)``, under which an
act clears every later trip of the same breaker, and added
``require_operator_act``, the one wrapper that maps a refusal to
``GovernanceError``. Merged as written, the kernel would carry two names for
one verb and a scope that binds to no instance.

Landing resolution R1 keeps main's names and per-instance scopes (one
``breaker_reset`` for the failure breaker AND the cost breaker, told apart by
the ``breaker`` field), drops slow-c's two duplicate names, and keeps
``require_operator_act`` as the one wrapper these verbs reach. R2 makes the
caller classification (``tests/test_operator_approval_callers.py``) classify
every surface once under that one name. This module pins both:

(a) the declaration: the duplicate names are gone and each kept name carries
    exactly main's instance fields;
(b) the wiring, read from the AST: each verb reaches
    ``operator_approval.require_operator_act`` (in its body or in a helper of
    its own module that it calls), names its R1 surface there, and calls no
    other verifier;
(c) the behaviour: each verb is asked what it needs approved (the request is
    read at the wrapper's one verifier and refused there, so nothing is spent),
    an operator approves exactly that for one instance, and that act is
    refused for a later trip of the same breaker, for the other breaker's
    trip, or for a later quarantine of the same server, while the act for the
    later instance clears it;
(d) the classification (R2): whatever shape its rows take, every row the
    caller table keeps for these verbs names exactly the R1 surface, no row
    names a dropped one, and every declared surface is classified.

GitHub is faked (``tests/_helpers/operator_acts``); nothing reaches the network.
"""
from __future__ import annotations

import ast
import dataclasses
import json
import shutil
import tempfile
import unittest
from collections.abc import Callable, Iterator, Mapping
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from unittest import mock

import aria_kernel
from aria_kernel import circuit_breaker as cb
from aria_kernel import cost_budget
from aria_kernel import mcp_client as mc
from aria_kernel import operator_approval
from aria_kernel.operator_approval import (
    APPROVAL_CONSUMED_EVENT,
    AUTHORITY_RAISING_SURFACES,
    RECORD_SURFACES,
    OperatorApprovalUnrecorded,
    canonical_scope,
)
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir
from tests._helpers.operator_acts import REPOSITORY, github_operator_acts

KERNEL = Path(aria_kernel.__file__).resolve().parent
OWNER_MODULE = "aria_kernel.operator_approval"
WRAPPER = "require_operator_act"
# Every verifier the owner exports. The wrapper calls one of them itself; a
# verb that calls any of them directly bypasses the one refusal mapping.
OTHER_VERIFIERS = frozenset(name for name in operator_approval.__all__ if name.startswith("verify_"))

# R1 — the one name per verb and the instance fields its approval carries.
KEPT_SURFACES: dict[str, tuple[str, ...]] = {
    "breaker_reset": ("breaker", "tripped_at"),
    "breaker_evidence_quarantine": ("breaker", "tripped_at"),
    "mcp_unquarantine": ("server", "quarantined_at"),
}
DROPPED_SURFACES = frozenset({"circuit_breaker_reset", "cost_breaker_reset"})

# (module, function) -> the one surface it asks an operator to approve.
VERBS: dict[tuple[str, str], str] = {
    ("circuit_breaker", "reset_breaker"): "breaker_reset",
    ("circuit_breaker", "quarantine_breaker_evidence"): "breaker_evidence_quarantine",
    ("cost_budget", "reset_breaker"): "breaker_reset",
    ("mcp_client", "release_quarantine"): "mcp_unquarantine",
}


def _stamp(moment: datetime) -> str:
    """The kernel's stamp spelling, microseconds kept (a scope drops them)."""
    return moment.strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _second(stamp: str) -> str:
    """``stamp`` at the one-second UTC precision a scope is compared in."""
    moment = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# The failure breaker counts rows inside a sliding window measured from the
# real clock, so both trips happen minutes ago, a minute apart: two distinct
# instances at the scope's one-second precision.
_FIRST = (datetime.now(timezone.utc) - timedelta(minutes=5)).replace(microsecond=123456)
FIRST_TRIP = _stamp(_FIRST)
LATER_TRIP = _stamp(_FIRST + timedelta(minutes=1))
# MCP quarantine is decided by call counts, not by the clock.
FIRST_QUARANTINE = "2026-10-16T08:00:00+00:00"
LATER_QUARANTINE = "2026-10-16T09:00:00+00:00"
_TRUNCATED_ROW = '{"ts":"2020-01'
# Well-formed, so a verb that checks the grammar before asking still asks.
_PROBE_REF = f"gh:{REPOSITORY}#1/comment/1"
_REFUSED = r"_approval_unrecorded.*approves"


# ----- (a) the declaration ----------------------------------------------------------


class OneNamePerVerb(unittest.TestCase):
    def test_the_duplicate_names_are_gone(self) -> None:
        self.assertEqual(sorted(DROPPED_SURFACES & set(AUTHORITY_RAISING_SURFACES)), [])
        self.assertEqual(sorted(DROPPED_SURFACES & set(RECORD_SURFACES)), [])

    def test_each_kept_name_carries_its_instance_fields(self) -> None:
        declared = {name: AUTHORITY_RAISING_SURFACES.get(name) for name in KEPT_SURFACES}
        self.assertEqual(declared, KEPT_SURFACES)

    def test_no_third_name_covers_a_breaker_or_an_mcp_release(self) -> None:
        """A renamed duplicate (``cost_breaker_clear``, ``mcp_release``) fails here too."""
        self.assertEqual(
            sorted(name for name in AUTHORITY_RAISING_SURFACES if "breaker" in name),
            ["breaker_evidence_quarantine", "breaker_reset"],
        )
        self.assertEqual(sorted(name for name in AUTHORITY_RAISING_SURFACES if "mcp" in name), ["mcp_unquarantine"])


# ----- (b) the wiring, read from the AST ------------------------------------------------


@dataclasses.dataclass(frozen=True)
class _Module:
    name: str
    tree: ast.Module
    functions: dict[str, ast.FunctionDef | ast.AsyncFunctionDef]  # module level only
    constants: dict[str, str]  # module-level string constants
    wrapper_names: frozenset[str]  # local names bound to operator_approval.require_operator_act
    owner_aliases: frozenset[str]  # local names bound to the operator_approval module


def _imported_from(node: ast.ImportFrom) -> str:
    """The absolute module an ``ImportFrom`` in a top-level kernel module reads."""
    if node.level == 0:
        return node.module or ""
    if node.level == 1:
        return ".".join(part for part in ("aria_kernel", node.module) if part)
    return ""


def _parse(name: str) -> _Module:
    tree = ast.parse((KERNEL / f"{name}.py").read_text(encoding="utf-8"))
    functions = {
        node.name: node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    }
    constants = {
        target.id: node.value.value
        for node in tree.body
        if isinstance(node, ast.Assign) and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str)
        for target in node.targets
        if isinstance(target, ast.Name)
    }
    wrapper: set[str] = set()
    owner: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            source = _imported_from(node)
            for alias in node.names:
                if source == OWNER_MODULE and alias.name == WRAPPER:
                    wrapper.add(alias.asname or alias.name)
                elif source == "aria_kernel" and alias.name == "operator_approval":
                    owner.add(alias.asname or alias.name)
        elif isinstance(node, ast.Import):
            owner.update(alias.asname for alias in node.names if alias.name == OWNER_MODULE and alias.asname)
    return _Module(name, tree, functions, constants, frozenset(wrapper), frozenset(owner))


def _calls(node: ast.AST) -> Iterator[ast.Call]:
    for child in ast.walk(node):
        if isinstance(child, ast.Call):
            yield child


def _call_name(call: ast.Call) -> str | None:
    if isinstance(call.func, ast.Name):
        return call.func.id
    if isinstance(call.func, ast.Attribute):
        return call.func.attr
    return None


def _reachable(module: _Module, name: str) -> list[ast.FunctionDef | ast.AsyncFunctionDef]:
    """``name`` and every module-level function of its module it calls, transitively."""
    seen: list[str] = []
    queue = [name]
    while queue:
        current = queue.pop()
        if current in seen:
            continue
        seen.append(current)
        queue.extend(
            call.func.id for call in _calls(module.functions[current])
            if isinstance(call.func, ast.Name) and call.func.id in module.functions
        )
    return [module.functions[current] for current in seen]


def _is_wrapper_call(module: _Module, call: ast.Call) -> bool:
    func = call.func
    if isinstance(func, ast.Name):
        return func.id in module.wrapper_names
    return (
        isinstance(func, ast.Attribute) and func.attr == WRAPPER
        and isinstance(func.value, ast.Name) and func.value.id in module.owner_aliases
    )


def _surface(module: _Module, call: ast.Call) -> str | None:
    node = next((keyword.value for keyword in call.keywords if keyword.arg == "surface"), None)
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.Name):
        return module.constants.get(node.id)
    return None


class EachVerbReachesTheOneWrapper(unittest.TestCase):
    def test_each_verb_asks_through_require_operator_act_for_its_one_surface(self) -> None:
        for (name, function), surface in VERBS.items():
            with self.subTest(verb=f"{name}.{function}"):
                module = _parse(name)
                self.assertIn(function, module.functions)
                defined = {
                    node.name for node in ast.walk(module.tree)
                    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
                }
                self.assertEqual(sorted(module.wrapper_names & defined), [], "a local def shadows the wrapper")
                calls = [call for reached in _reachable(module, function) for call in _calls(reached)]
                asked = [call for call in calls if _is_wrapper_call(module, call)]
                self.assertTrue(asked, f"{name}.{function} never reaches operator_approval.{WRAPPER}")
                self.assertEqual({_surface(module, call) for call in asked}, {surface})
                self.assertEqual(
                    sorted({_call_name(call) for call in calls} & OTHER_VERIFIERS), [],
                    f"{name}.{function} calls a verifier besides operator_approval.{WRAPPER}",
                )


# ----- (c) the behaviour --------------------------------------------------------------


class AnActForOneInstanceClearsOnlyThatInstance(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = Path(tempfile.mkdtemp(prefix="aria-238-one-name-"))
        self.addCleanup(shutil.rmtree, self._tmp, True)
        self.root = ensure_tools_dir(self._tmp / "aria-tools")
        acts = github_operator_acts()
        self.github = acts.__enter__()
        self.addCleanup(acts.__exit__, None, None, None)

    # --- the verbs, as an operator invokes them -----------------------------------

    def reset_failure_breaker(self, ref: str) -> object:
        return cb.reset_breaker(base_dir=self.root, operator_approval_ref=ref, reason="investigated")

    def reset_cost_breaker(self, ref: str) -> object:
        return cost_budget.reset_breaker(base_dir=self.root, reason="caps adjusted", operator_approval_ref=ref)

    def quarantine_evidence(self, ref: str) -> object:
        return cb.quarantine_breaker_evidence(base_dir=self.root, operator_approval_ref=ref, reason="truncated row")

    def release_server(self, ref: str) -> object:
        return mc.release_quarantine("aria", base_dir=self.root, operator_ref=ref)

    # --- the instances ----------------------------------------------------------------

    def trip_failure_breaker(self, at: str, tag: str) -> None:
        with mock.patch.object(cb, "utc_now_stamp", return_value=at):
            for index in range(3):
                cb.record_failure(base_dir=self.root, kind="ci_red", materialize_event_id=f"{tag}-{index}")
        self.assertEqual(cb.current_state(self.root), cb.BREAKER_STATE_TRIPPED)

    def trip_cost_breaker(self, at: str) -> None:
        with mock.patch.object(cost_budget, "utc_now_stamp", return_value=at):
            cost_budget._trip_breaker(self.root, cap_name="daily", amount=6.0, cap=5.0)
        self.assertEqual(cost_budget.current_state(self.root), "tripped")

    def damage_failure_ledger(self) -> None:
        with cb._failures_path(self.root).open("a", encoding="utf-8") as ledger:
            ledger.write(_TRUNCATED_ROW + "\n")

    def quarantine_server(self, at: str) -> None:
        # Only the kernel's own side=server outcomes quarantine (ARIA-MEDIUM-609),
        # and a fault class the caller caused never counts.
        with mock.patch.object(mc, "utc_now", return_value=at):
            for _ in range(mc.QUARANTINE_MIN_CALLS):
                mc.record_mcp_call(tool_name="aria/search", ok=False, side="server",
                                   error_class="RuntimeError", base_dir=self.root)
        self.assertIn("aria", mc.quarantined_servers(self.root))

    # --- reading what a verb asks for ---------------------------------------------------

    def asked(self, verb: Callable[[str], object]) -> tuple[str, dict[str, Any]]:
        """The (surface, scope) ``verb`` asks an operator to approve.

        Read where the one wrapper verifies and refused there, so no act is
        spent and the verb changes nothing.
        """
        requests: list[tuple[str, dict[str, Any]]] = []

        def refuse(*_args: object, **kwargs: Any) -> dict[str, Any]:
            requests.append((kwargs["surface"], dict(kwargs["scope"])))
            raise OperatorApprovalUnrecorded("probe: the request was read, nothing is approved")

        outcome: object = None
        with mock.patch.object(operator_approval, "verify_operator_approval", side_effect=refuse):
            try:
                outcome = verb(_PROBE_REF)
            except GovernanceError as refusal:
                outcome = refusal
        self.assertEqual(
            len(requests), 1,
            f"the verb asked {len(requests)} operator act(s) through operator_approval.{WRAPPER}; "
            f"it returned {outcome!r}",
        )
        return requests[0]

    def assert_names_instance(self, request: tuple[str, dict[str, Any]], stamp: str) -> None:
        self.assertIn(
            _second(stamp), list(canonical_scope(*request).values()),
            f"the approval {request} names no instance: an act for it clears every later one",
        )

    def spent(self) -> int:
        ledger = self.root / "governance.jsonl"
        if not ledger.exists():
            return 0
        rows = [json.loads(line) for line in ledger.read_text(encoding="utf-8").splitlines() if line.strip()]
        return sum(1 for row in rows if row.get("kind") == APPROVAL_CONSUMED_EVENT)

    # --- the pins ----------------------------------------------------------------------

    def test_failure_breaker_reset(self) -> None:
        self.trip_failure_breaker(FIRST_TRIP, "first")
        first = self.asked(self.reset_failure_breaker)
        self.assert_names_instance(first, FIRST_TRIP)
        stale, spent = self.github.approve(*first), self.github.approve(*first)
        self.assertEqual(self.reset_failure_breaker(spent), {"status": "ok"})
        self.assertEqual(cb.current_state(self.root), cb.BREAKER_STATE_OK)

        self.trip_failure_breaker(LATER_TRIP, "later")
        later = self.asked(self.reset_failure_breaker)
        self.assertEqual(later[0], first[0])
        self.assert_names_instance(later, LATER_TRIP)
        with self.assertRaisesRegex(GovernanceError, _REFUSED):
            self.reset_failure_breaker(stale)
        self.assertEqual(cb.current_state(self.root), cb.BREAKER_STATE_TRIPPED)
        self.assertEqual(self.spent(), 1)

        self.assertEqual(self.reset_failure_breaker(self.github.approve(*later)), {"status": "ok"})
        self.assertEqual(self.spent(), 2)

    def test_cost_breaker_reset(self) -> None:
        self.trip_cost_breaker(FIRST_TRIP)
        first = self.asked(self.reset_cost_breaker)
        self.assert_names_instance(first, FIRST_TRIP)
        stale, spent = self.github.approve(*first), self.github.approve(*first)
        self.reset_cost_breaker(spent)
        self.assertEqual(cost_budget.current_state(self.root), "ok")

        self.trip_cost_breaker(LATER_TRIP)
        later = self.asked(self.reset_cost_breaker)
        self.assertEqual(later[0], first[0])
        self.assert_names_instance(later, LATER_TRIP)
        with self.assertRaisesRegex(GovernanceError, _REFUSED):
            self.reset_cost_breaker(stale)
        self.assertEqual(cost_budget.current_state(self.root), "tripped")
        self.assertEqual(self.spent(), 1)

        self.reset_cost_breaker(self.github.approve(*later))
        self.assertEqual(cost_budget.current_state(self.root), "ok")
        self.assertEqual(self.spent(), 2)

    def test_one_name_resets_both_breakers_and_the_scope_tells_them_apart(self) -> None:
        """R1: ``breaker_reset`` covers both stops; only ``breaker`` keeps their acts apart."""
        self.trip_failure_breaker(FIRST_TRIP, "first")
        self.trip_cost_breaker(FIRST_TRIP)
        failure = self.asked(self.reset_failure_breaker)
        cost = self.asked(self.reset_cost_breaker)
        self.assertEqual(failure[0], cost[0], "two surface names for one verb")
        self.assertNotEqual(canonical_scope(*failure), canonical_scope(*cost))
        for verb, other in ((self.reset_failure_breaker, cost), (self.reset_cost_breaker, failure)):
            with self.subTest(verb=verb.__name__), self.assertRaisesRegex(GovernanceError, _REFUSED):
                verb(self.github.approve(*other))
        self.assertEqual(cb.current_state(self.root), cb.BREAKER_STATE_TRIPPED)
        self.assertEqual(cost_budget.current_state(self.root), "tripped")
        self.assertEqual(self.spent(), 0)

        self.reset_failure_breaker(self.github.approve(*failure))
        self.reset_cost_breaker(self.github.approve(*cost))
        self.assertEqual(cb.current_state(self.root), cb.BREAKER_STATE_OK)
        self.assertEqual(cost_budget.current_state(self.root), "ok")
        self.assertEqual(self.spent(), 2)

    def test_breaker_evidence_quarantine(self) -> None:
        self.trip_failure_breaker(FIRST_TRIP, "first")
        self.damage_failure_ledger()
        first = self.asked(self.quarantine_evidence)
        self.assert_names_instance(first, FIRST_TRIP)
        stale, spent = self.github.approve(*first), self.github.approve(*first)
        self.assertEqual(self.quarantine_evidence(spent)["quarantined"], 1)
        # A later trip: the operator clears this one, the breaker trips again
        # and its ledger is damaged again.
        self.reset_failure_breaker(self.github.approve(*self.asked(self.reset_failure_breaker)))
        self.trip_failure_breaker(LATER_TRIP, "later")
        self.damage_failure_ledger()

        later = self.asked(self.quarantine_evidence)
        self.assertEqual(later[0], first[0])
        self.assert_names_instance(later, LATER_TRIP)
        sidecar = cb._quarantine_path(self.root).read_bytes()
        ledger = cb._failures_path(self.root).read_bytes()
        with self.assertRaisesRegex(GovernanceError, _REFUSED):
            self.quarantine_evidence(stale)
        self.assertEqual(cb._quarantine_path(self.root).read_bytes(), sidecar)
        self.assertEqual(cb._failures_path(self.root).read_bytes(), ledger)
        self.assertEqual(self.spent(), 2)

        self.assertEqual(self.quarantine_evidence(self.github.approve(*later))["quarantined"], 1)
        self.assertEqual(self.spent(), 3)

    def test_mcp_release(self) -> None:
        self.quarantine_server(FIRST_QUARANTINE)
        first = self.asked(self.release_server)
        self.assert_names_instance(first, FIRST_QUARANTINE)
        stale, spent = self.github.approve(*first), self.github.approve(*first)
        self.release_server(spent)
        self.assertNotIn("aria", mc.quarantined_servers(self.root))

        self.quarantine_server(LATER_QUARANTINE)
        later = self.asked(self.release_server)
        self.assertEqual(later[0], first[0])
        self.assert_names_instance(later, LATER_QUARANTINE)
        with self.assertRaisesRegex(GovernanceError, _REFUSED):
            self.release_server(stale)
        self.assertIn("aria", mc.quarantined_servers(self.root))
        self.assertEqual(self.spent(), 1)

        self.release_server(self.github.approve(*later))
        self.assertNotIn("aria", mc.quarantined_servers(self.root))
        self.assertEqual(self.spent(), 2)


# ----- (d) the caller classification (R2) -------------------------------------------


def _is_caller_table(value: object) -> bool:
    """A table keyed by (module, function), whatever its rows hold."""
    return isinstance(value, Mapping) and bool(value) and all(
        isinstance(key, tuple) and len(key) == 2 and all(isinstance(part, str) for part in key)
        for key in value
    )


def _strings(value: object) -> set[str]:
    """Every string a classification row carries: tuples, sets, mappings, dataclasses."""
    if isinstance(value, str):
        return {value}
    if isinstance(value, Mapping):
        return set().union(*(_strings(item) for item in value.values()))
    if isinstance(value, (tuple, list, set, frozenset)):
        return set().union(*(_strings(item) for item in value))
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return set().union(*(_strings(getattr(value, field.name)) for field in dataclasses.fields(value)))
    return set()


class TheClassificationNamesOneSurfacePerVerb(unittest.TestCase):
    def test_every_surface_is_classified_once_under_its_r1_name(self) -> None:
        from tests import test_operator_approval_callers as classification

        vocabulary = set(AUTHORITY_RAISING_SURFACES) | set(RECORD_SURFACES) | DROPPED_SURFACES
        tables = [value for value in vars(classification).values() if _is_caller_table(value)]
        self.assertTrue(tables, "the caller classification keeps no (module, function) table")
        named: dict[tuple[str, str], set[str]] = {}
        for table in tables:
            for key, row in table.items():
                named.setdefault(key, set()).update(_strings(row) & vocabulary)
        for verb, surface in VERBS.items():
            with self.subTest(verb=".".join(verb)):
                self.assertEqual(named.get(verb), {surface})
        classified = set().union(*named.values())
        self.assertEqual(sorted(classified & DROPPED_SURFACES), [], "a row still names a dropped surface")
        self.assertEqual(
            sorted((set(AUTHORITY_RAISING_SURFACES) | set(RECORD_SURFACES)) - classified), [],
            "declared surfaces no row classifies",
        )


if __name__ == "__main__":
    unittest.main()
