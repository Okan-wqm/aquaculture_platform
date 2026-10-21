"""WP-J landing (PLAN-v2 F0.3) — the three named resolutions, pinned before the merge.

WHY THIS EXISTS. The WP-J expert panel (tier-0, the judgment funnel, the
verdict cache, the method seats) lands onto a main that moved underneath it:
main owns the ``sha256:`` label in ``digest.py`` (ARIA-LOW-517) and owns the
anchor's diversity question in ONE seat function (WP-P,
``feedback_store.consensus_distinct_seats``). The landing carries exactly
three pieces of new logic, and each one is a place where a merge can look
clean while keeping the wrong law. These pins were written by an independent
test writer on the WP-J tip BEFORE main is merged in: they are red on that
tip and turn green only when the landing resolves each conflict the named way.

N1 — DIGEST, ONE OWNER. ``tier0._item_fingerprint`` and
``evidence_trust.cited_blobs_code_hash`` compose the label by hand
(``"finding:sha256:" + …``, ``f"{rel}:sha256:{…}"``, ``f"sha256:{digest}"``).
The two modules may not spell the label at all outside a docstring; the
verdict-cache key composes through ``digest.py`` and keeps its exact bytes
(a key that changes shape silently misses every cached verdict).

N2 — NO DEFENSIVE FALLBACK. ``tier0`` wraps the ONE fingerprint owner in a
broad ``except`` and degrades to a second, hand-made identity; the funnel
wraps ``tier0_gate`` in a broad ``except`` that turns any crash into
``TIER0_PASS``. Both are removed: a failure is reported under a NEW named
tier-0 constant, never as a second identity and never as a pass. The tier-0
pin bans the broad handler itself; the funnel pin bans the crash-to-pass
handler and proves behaviourally that a crashing gate holds the item under
that name (a crash recorded by name and held is fail-closed, not a fallback).

N3 — ONE SEAT LAW. WP-J's ``observation_span`` /
``ANCHOR_MIN_DISTINCT_METHODS`` is a second diversity gate beside main's
``consensus_distinct_seats >= ANCHOR_MIN_JUDGE_COUNT``. The seat function is
the ONE gate; WP-J's method receipt and evidence leg become legs of that same
function, and ``observation_span`` survives only as a recorded descriptor.
Pinned behaviourally: on rows that pass the agreement precondition,
``is_ground_truth_row`` decides exactly what the seat function decides; three
distinct seats of ONE method anchor; an empty evidence leg does not.

What is deliberately NOT pinned here: ``genesis_policy
.effective_calibration_gate`` (PLAN-v2 item F0.8) and the funnel's shipped
``funnel_enabled: False`` default (the behavioural funnel test passes its own
policy and never reads the shipped one).
"""
from __future__ import annotations

import ast
import os
import subprocess
import tempfile
import unittest
from contextlib import ExitStack
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from unittest.mock import patch

_REPO_ROOT = Path(__file__).resolve().parents[3]
_KERNEL = _REPO_ROOT / "aria-kernel" / "aria_kernel"
_TIER0 = _KERNEL / "tier0.py"
_EVIDENCE_TRUST = _KERNEL / "evidence_trust.py"
_FUNNEL = _KERNEL / "judgment_funnel.py"
_FEEDBACK_STORE = _KERNEL / "feedback_store.py"

_LABEL = "sha256:"
_REGEX_CALLS = frozenset({
    "compile", "fullmatch", "match", "search", "findall", "finditer", "split", "sub", "subn",
})
_BROAD_EXCEPTIONS = frozenset({"Exception", "BaseException"})

# The tier-0 vocabulary as it stood on the WP-J tip (cbaad3b83) before the
# landing. N2 asks for a NEW named constant for "the gate could not compute";
# reusing one of these would name a different event (a refusal of the claim,
# or a tri-state note that means "nothing could be checked").
_PRE_LANDING_TIER0_NAMES = frozenset({
    "pass", "reject",
    "claim_not_falsifiable",
    "cited_path_absent_at_target_sha",
    "evidence_ref_absent_at_target_sha",
    "tier0_fingerprint_duplicate",
    "tier0_ref_line_out_of_range",
    "tier0_quote_required",
    "tier0_quote_unpinned",
    "tier0_quote_stale_excerpt",
    "tier0_quote_mismatch",
    "tier0_observable_subject_unreadable",
    "tier0_observable_premise_violated",
    "tier0_unverified_no_anchor",
    "tier0_unverified_git_unavailable",
    "tier0_item_unreadable",
    "tier0_gate_unreadable",
})


# --------------------------------------------------------------------------
# shared AST helpers
# --------------------------------------------------------------------------

def _parse(path: Path) -> ast.Module:
    return ast.parse(path.read_text(encoding="utf-8"), filename=str(path))


def _function(tree: ast.AST, name: str) -> ast.FunctionDef | ast.AsyncFunctionDef | None:
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name:
            return node
    return None


def _docstring_ids(tree: ast.AST) -> set[int]:
    """The ``id`` of every docstring constant: prose that spells no rule."""
    ids: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            body = node.body
            if (body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant)
                    and isinstance(body[0].value.value, str)):
                ids.add(id(body[0].value))
    return ids


def _label_spellings(path: Path, *, within: str | None = None) -> list[str]:
    """Every non-docstring string constant that carries the label, as ``file:line:kind``.

    Stricter than main's ``test_digest_single_owner`` on purpose, and scoped
    to the two modules N1 names: ANY constant or f-string part carrying the
    label is an offender (the slow-c versions of both modules carry none), so
    a constant hoisted into a name (``_P = "sha256:"; _P + x``) cannot slip
    past an operator-shape check. The kind mirrors main's vocabulary so a
    red line reads the same in both pins.
    """
    tree = _parse(path)
    scope: ast.AST = tree
    if within is not None:
        found = _function(tree, within)
        if found is None:
            return [f"{path.name}:0:function_{within}_missing"]
        scope = found
    docstrings = _docstring_ids(tree)
    parents: dict[int, ast.AST] = {}
    for node in ast.walk(scope):
        for child in ast.iter_child_nodes(node):
            parents[id(child)] = node
    offenders: list[tuple[int, str]] = []
    for node in ast.walk(scope):
        if not (isinstance(node, ast.Constant) and isinstance(node.value, str) and _LABEL in node.value):
            continue
        if id(node) in docstrings:
            continue
        parent = parents.get(id(node))
        if isinstance(parent, ast.BinOp) and isinstance(parent.op, (ast.Add, ast.Mod)):
            kind = "label_composed_with_operator"
        elif isinstance(parent, ast.JoinedStr):
            kind = "label_composed_in_fstring"
        elif (isinstance(parent, ast.Attribute) and parent.attr == "format"):
            kind = "label_composed_with_str_format"
        elif (isinstance(parent, ast.Call) and parent.args and parent.args[0] is node
              and ((isinstance(parent.func, ast.Attribute) and parent.func.attr in _REGEX_CALLS)
                   or (isinstance(parent.func, ast.Name) and parent.func.id in _REGEX_CALLS))):
            kind = "validator_restated_as_regex"
        else:
            kind = "label_constant_outside_digest"
        offenders.append((node.lineno, f"{path.relative_to(_REPO_ROOT)}:{node.lineno}:{kind}"))
    return [entry for _line, entry in sorted(offenders)]


def _digest_imports(tree: ast.Module) -> set[str]:
    """Names this module binds from the digest owner (module or function level)."""
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and (
            (node.level == 1 and node.module == "digest")
            or node.module == "aria_kernel.digest"
        ):
            names.update(alias.asname or alias.name for alias in node.names)
    return names


def _call_name(node: ast.Call) -> str | None:
    if isinstance(node.func, ast.Name):
        return node.func.id
    if isinstance(node.func, ast.Attribute):
        return node.func.attr
    return None


def _is_broad(handler_type: ast.expr | None) -> bool:
    if handler_type is None:
        return True  # a bare ``except:``
    if isinstance(handler_type, ast.Name):
        return handler_type.id in _BROAD_EXCEPTIONS
    if isinstance(handler_type, ast.Attribute):
        return handler_type.attr in _BROAD_EXCEPTIONS
    if isinstance(handler_type, ast.Tuple):
        return any(_is_broad(element) for element in handler_type.elts)
    return False


def _broad_handlers_around(path: Path, callee: str) -> list[str]:
    """Every broad ``except`` whose ``try`` body calls ``callee``."""
    tree = _parse(path)
    found: list[str] = []
    try_nodes = tuple(t for t in (getattr(ast, "Try", None), getattr(ast, "TryStar", None)) if t)
    for node in ast.walk(tree):
        if not isinstance(node, try_nodes):
            continue
        calls_callee = any(
            isinstance(inner, ast.Call) and _call_name(inner) == callee
            for statement in node.body for inner in ast.walk(statement)
        )
        if not calls_callee:
            continue
        for handler in node.handlers:
            if _is_broad(handler.type):
                found.append(f"{path.relative_to(_REPO_ROOT)}:{handler.lineno}:broad_except_around_{callee}")
    return sorted(found)


def _handlers_producing_pass_around(path: Path, callee: str) -> list[str]:
    """Every ``except`` (any type) around ``callee`` whose body produces a pass.

    The shape N2 removes from the funnel: the handler of a ``try`` that calls
    the tier-0 gate names ``TIER0_PASS`` (or spells its value), i.e. a crash
    of the gate becomes an admission. Catching a crash to record it under a
    NAMED failure is not this shape; the behavioural test below pins that.
    """
    from aria_kernel.tier0 import TIER0_PASS

    tree = _parse(path)
    found: list[str] = []
    try_nodes = tuple(t for t in (getattr(ast, "Try", None), getattr(ast, "TryStar", None)) if t)
    for node in ast.walk(tree):
        if not isinstance(node, try_nodes):
            continue
        calls_callee = any(
            isinstance(inner, ast.Call) and _call_name(inner) == callee
            for statement in node.body for inner in ast.walk(statement)
        )
        if not calls_callee:
            continue
        for handler in node.handlers:
            produces_pass = any(
                (isinstance(inner, ast.Name) and inner.id == "TIER0_PASS")
                or (isinstance(inner, ast.Attribute) and inner.attr == "TIER0_PASS")
                or (isinstance(inner, ast.Constant) and inner.value == TIER0_PASS)
                for statement in handler.body for inner in ast.walk(statement)
            )
            if produces_pass:
                found.append(f"{path.relative_to(_REPO_ROOT)}:{handler.lineno}:{callee}_crash_becomes_pass")
    return sorted(found)


def _new_tier0_names() -> set[str]:
    """String values tier0 NAMES at module level that the pre-landing tip did not.

    A named failure is a module-level UPPER_CASE constant (or a member of an
    UPPER_CASE tuple of names) in ``aria_kernel.tier0`` — one owner, the
    same discipline as ``TIER0_REFUSAL_REASONS``.
    """
    from aria_kernel import tier0

    values: set[str] = set()
    for name, value in vars(tier0).items():
        if not name.isupper():
            continue
        if isinstance(value, str):
            values.add(value)
        elif isinstance(value, (tuple, frozenset)):
            values.update(member for member in value if isinstance(member, str))
    return {value for value in values if value and value not in _PRE_LANDING_TIER0_NAMES}


def _git_env() -> dict[str, str]:
    """Every GIT_* variable dropped (the hermetic-git rule, Python side)."""
    return {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}


def _git(root: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-c", "commit.gpgsign=false", *args],
        cwd=str(root), text=True, capture_output=True, check=True, env=_git_env(),
    ).stdout.strip()


# --------------------------------------------------------------------------
# N1 — the sha256: label has one owner in the two WP-J modules too
# --------------------------------------------------------------------------

class N1DigestOneOwnerTest(unittest.TestCase):
    def test_tier0_spells_no_sha256_label(self) -> None:
        offenders = _label_spellings(_TIER0)
        self.assertEqual(
            offenders, [],
            "tier0.py spells the 'sha256:' label outside digest.py (N1; ARIA-LOW-517 owner):\n"
            + "\n".join(offenders),
        )

    def test_evidence_trust_spells_no_sha256_label(self) -> None:
        offenders = _label_spellings(_EVIDENCE_TRUST)
        self.assertEqual(
            offenders, [],
            "evidence_trust.py spells the 'sha256:' label outside digest.py (N1; ARIA-LOW-517 owner):\n"
            + "\n".join(offenders),
        )

    def test_the_verdict_cache_code_hash_composes_through_the_digest_owner(self) -> None:
        # The named N1 site in evidence_trust, pinned on its own so the red
        # line names WP-J's composition even while main's own sites in the
        # same module (routed by slow-c) are still unmerged.
        offenders = _label_spellings(_EVIDENCE_TRUST, within="cited_blobs_code_hash")
        self.assertEqual(
            offenders, [],
            "cited_blobs_code_hash composes the verdict-cache key's label by hand (N1):\n"
            + "\n".join(offenders),
        )
        self.assertTrue(
            _digest_imports(_parse(_EVIDENCE_TRUST)),
            "evidence_trust.py imports nothing from aria_kernel.digest: the code hash "
            "cannot be composed through the label's owner (N1)",
        )

    def test_routing_through_digest_keeps_the_cache_key_bytes(self) -> None:
        # Guard (green on the WP-J tip too): the verdict-cache key is persisted
        # on judgment_cache rows, so routing its composition through digest.py
        # must not change one byte of it — a re-shaped key silently misses
        # every cached verdict. The golden is composed through the owner.
        from aria_kernel.digest import is_sha256_digest, sha256_digest, sha256_digest_text
        from aria_kernel.evidence_trust import cited_blobs_code_hash

        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            (repo / "src").mkdir()
            a_bytes = b"alpha\nconsole.log('x')\ngamma\n"
            b_bytes = b"export const b = 1;\n"
            (repo / "src" / "a.ts").write_bytes(a_bytes)
            (repo / "src" / "b.ts").write_bytes(b_bytes)
            _git(repo, "init", "-q")
            _git(repo, "config", "user.email", "aria-test@example.invalid")
            _git(repo, "config", "user.name", "ARIA Test")
            _git(repo, "add", "-A")
            _git(repo, "commit", "-q", "-m", "fixture: verdict-cache key tree")
            head = _git(repo, "rev-parse", "HEAD")

            key = cited_blobs_code_hash(repo, ["src/a.ts:2", "src/b.ts", "src/gone.ts"], head)

        pairs = sorted([
            f"src/a.ts:{sha256_digest(a_bytes)}",
            f"src/b.ts:{sha256_digest(b_bytes)}",
            "src/gone.ts:absent",
        ])
        self.assertTrue(is_sha256_digest(key), key)
        self.assertEqual(key, sha256_digest_text("\n".join(pairs)))


# --------------------------------------------------------------------------
# N2 — no defensive fallback: a failure is named, never a second identity,
# never a pass
# --------------------------------------------------------------------------

class N2NoDefensiveFallbackTest(unittest.TestCase):
    def test_tier0_has_no_broad_except_around_the_fingerprint_owner(self) -> None:
        offenders = _broad_handlers_around(_TIER0, "finding_fingerprint")
        self.assertEqual(
            offenders, [],
            "tier0.py wraps feedback_store.finding_fingerprint in a broad except (N2):\n"
            + "\n".join(offenders),
        )

    def test_a_failing_fingerprint_owner_is_a_named_failure_never_a_second_identity_or_pass(self) -> None:
        from aria_kernel import feedback_store, tier0

        def _owner_fails(*_args: Any, **_kwargs: Any) -> str:
            raise ValueError("fixture: the fingerprint owner cannot read this finding")

        item = {"tool_id": "lint-rules-adapter", "rule": "no-console", "path": "src/a.ts"}
        with ExitStack() as stack:
            stack.enter_context(patch.object(feedback_store, "finding_fingerprint", _owner_fails))
            if hasattr(tier0, "finding_fingerprint"):
                # A module-level import of the owner binds its own name.
                stack.enter_context(patch.object(tier0, "finding_fingerprint", _owner_fails))
            verdict = tier0.tier0_gate(item, None, None, None)

        self.assertIsInstance(verdict, dict)
        self.assertNotEqual(
            verdict.get("status"), tier0.TIER0_PASS,
            f"a fingerprint the owner could not compute must never pass tier-0 (N2): {verdict}",
        )
        self.assertFalse(
            verdict.get("fingerprint"),
            f"no second, hand-made identity when the ONE owner failed (N2): {verdict}",
        )
        new_names = _new_tier0_names()
        self.assertIn(
            verdict.get("reason"), new_names,
            f"the failure must carry a NEW named tier0 constant (N2); "
            f"new tier0 names: {sorted(new_names)}; verdict: {verdict}",
        )

    def test_the_funnel_never_turns_a_tier0_crash_into_pass(self) -> None:
        offenders = _handlers_producing_pass_around(_FUNNEL, "tier0_gate")
        self.assertEqual(
            offenders, [],
            "judgment_funnel.py turns a tier0_gate crash into TIER0_PASS (N2):\n" + "\n".join(offenders),
        )

    def test_a_crashing_tier0_gate_is_recorded_by_name_and_never_routed(self) -> None:
        from aria_kernel import judgment_funnel, tier0
        from aria_kernel.ledger import load_declared_jsonl
        from aria_kernel.request_admission import CRITICAL_PATH, Admission

        def _gate_crashes(*_args: Any, **_kwargs: Any) -> dict[str, Any]:
            raise RuntimeError("fixture: tier-0 crashed")

        def _always_admit(producer: str, role: str, **_kwargs: Any) -> Admission:
            # The door is an input organ here, pinned by its own suite
            # (test_judgment_funnel._door_open, same shape).
            return Admission(producer, role, CRITICAL_PATH, "test", 1, True, CRITICAL_PATH)

        now = datetime.now(timezone.utc)

        def _iso(moment: datetime) -> str:
            return moment.isoformat().replace("+00:00", "Z")

        # 91 drained results inside the 7-day window: 13/day, so the envelope
        # (13) is never what holds the item — only tier-0 may.
        requests = [{"request_id": f"d-{i}", "role": "evidence_judgment", "state": "pending",
                     "created_at": _iso(now - timedelta(days=1, hours=1))} for i in range(91)]
        results = [{"request_id": f"d-{i}", "status": "rejected",
                    "submitted_at": _iso(now - timedelta(days=1))} for i in range(91)]
        policy = {
            "funnel_enabled": True,
            "funnel_nightly_envelope": 13,
            "funnel_tier4_quota": 0.10,
            "funnel_tier1_budget_seconds": 0.0,
            "funnel_calibration_sample_per_cycle": 0,
        }
        item = {"finding_id": "F1", "tool_id": "adapter-a", "run_id": "run-1", "rule": "rule-x",
                "severity": "medium", "path": "src/real.py", "finding_fingerprint": "finding:fixture-f1"}

        with tempfile.TemporaryDirectory() as tmp, ExitStack() as stack:
            stack.enter_context(patch.object(tier0, "tier0_gate", _gate_crashes))
            if hasattr(judgment_funnel, "tier0_gate"):
                stack.enter_context(patch.object(judgment_funnel, "tier0_gate", _gate_crashes))
            stack.enter_context(patch("aria_kernel.request_admission.admit_request", _always_admit))
            stack.enter_context(patch("aria_kernel.request_drain_capacity._request_ledgers",
                                      return_value=(requests, results, [])))
            base_dir = Path(tmp) / "aria-tools"
            result = judgment_funnel.route_judgment_sample(
                sample={"sample_id": "S1", "cycle_id": "cyc-n2", "items": [dict(item)]},
                base_dir=base_dir, repo_root=None, target_sha=None, policy=policy,
            )
            path = judgment_funnel.routing_path(base_dir)
            rows = (load_declared_jsonl(path, expected_surface=judgment_funnel.ROUTING_SURFACE)
                    if path.exists() else [])

        routed_ids = [str(entry.get("finding_id")) for entry in result.get("routed") or []]
        planned_ids = [
            str(entry.get("finding_id"))
            for leg in result.get("plan") or [] for entry in (leg.get("sample") or {}).get("items") or []
        ]
        self.assertNotIn(
            "F1", routed_ids + planned_ids,
            f"a crashing tier-0 gate must never route the item as a pass (N2): {result.get('summary')}",
        )
        own_rows = [row for row in rows if row.get("finding_id") == "F1"]
        self.assertTrue(own_rows, "the funnel must record the item it did not dispatch (N2)")
        new_names = _new_tier0_names()
        for row in own_rows:
            held = str(row.get("held") or "")
            self.assertEqual(row.get("seats_planned"), 0, row)
            self.assertTrue(
                held and any(name in held for name in new_names),
                f"the routing row must name the tier-0 failure with a NEW tier0 constant (N2); "
                f"held={held!r}; new tier0 names: {sorted(new_names)}",
            )


# --------------------------------------------------------------------------
# N3 — one seat law: main's seat function is the ONE anchor diversity gate
# --------------------------------------------------------------------------

def _consensus_row(observers: list[dict[str, str]], *, evidence: tuple[str, ...] = ("src/app.ts:10",)) -> dict[str, Any]:
    """A consensus row that passes the agreement precondition (3 agreed, 3 voted).

    Only the diversity and evidence legs vary across the fixtures, so the
    anchor decision on them is exactly the seat law's decision.
    """
    from aria_kernel.feedback_store import ANCHOR_MIN_JUDGE_COUNT

    return {
        "source_type": "ai_consensus",
        "verdict": "true_positive",
        "judge_count": ANCHOR_MIN_JUDGE_COUNT,
        "judges_voted": ANCHOR_MIN_JUDGE_COUNT,
        "evidence_refs": list(evidence),
        "observers": observers,
    }


def _seat(judge_id: str, *, model: str = "glm-5.3", method: str | None = "static_trace") -> dict[str, str]:
    receipt = {"judge_id": judge_id, "model": model}
    if method is not None:
        receipt["method"] = method
    return receipt


def _seat_law_fixtures() -> dict[str, dict[str, Any]]:
    return {
        "one_method_three_seats": _consensus_row([_seat("a"), _seat("b"), _seat("c")]),
        "legacy_one_model_three_seats": _consensus_row(
            [_seat(j, model="claude-opus-5", method=None) for j in "abc"]),
        "three_methods_three_seats": _consensus_row(
            [_seat("a"), _seat("b", method="bug_hunt"), _seat("c", method="reproduction_test")]),
        "mixed_receipts_three_seats": _consensus_row(
            [_seat("a"), _seat("b", method="bug_hunt"), _seat("c", model="fable", method=None)]),
        "three_seats_empty_evidence_leg": _consensus_row(
            [_seat("a"), _seat("b", method="bug_hunt"), _seat("c", method="reproduction_test")],
            evidence=()),
        "one_seat_asked_thrice": _consensus_row(
            [_seat("a"), _seat("a", method="bug_hunt"), _seat("a", method="reproduction_test")]),
        "two_seats": _consensus_row([_seat("a"), _seat("b"), _seat("a", method="bug_hunt")]),
    }


class N3OneSeatLawTest(unittest.TestCase):
    def test_the_anchor_decision_is_the_seat_function_and_nothing_else(self) -> None:
        from aria_kernel import feedback_store

        self.assertTrue(
            hasattr(feedback_store, "consensus_distinct_seats"),
            "feedback_store has no consensus_distinct_seats: main's seat function (WP-P) "
            "must be the ONE anchor diversity gate after the landing (N3)",
        )
        seats = feedback_store.consensus_distinct_seats
        floor = feedback_store.ANCHOR_MIN_JUDGE_COUNT
        disagreements = [
            f"{name}: is_ground_truth_row={feedback_store.is_ground_truth_row(row)} "
            f"seats={seats(row)} floor={floor}"
            for name, row in _seat_law_fixtures().items()
            if feedback_store.is_ground_truth_row(row) != (seats(row) >= floor)
        ]
        self.assertEqual(
            disagreements, [],
            "is_ground_truth_row disagrees with consensus_distinct_seats >= "
            "ANCHOR_MIN_JUDGE_COUNT — a second diversity gate decides (N3):\n"
            + "\n".join(disagreements),
        )
        gate = _function(_parse(_FEEDBACK_STORE), "is_ground_truth_row")
        self.assertIsNotNone(gate)
        named = {node.id for node in ast.walk(gate) if isinstance(node, ast.Name)} | {
            node.attr for node in ast.walk(gate) if isinstance(node, ast.Attribute)
        }
        self.assertIn("consensus_distinct_seats", named)
        second_gates = sorted(named & {
            "observation_span", "ANCHOR_MIN_DISTINCT_METHODS", "ANCHOR_MIN_DISTINCT_MODELS",
            "distinct_observer_methods", "distinct_observer_models",
        })
        self.assertEqual(
            second_gates, [],
            "is_ground_truth_row still consults a second diversity gate beside the seat "
            "function (N3: observation_span is a recorded descriptor, not a gate)",
        )

    def test_one_method_three_seats_anchor_and_an_empty_evidence_leg_does_not(self) -> None:
        from aria_kernel.feedback_store import is_ground_truth_row

        fixtures = _seat_law_fixtures()
        wrong: list[str] = []
        if not is_ground_truth_row(fixtures["one_method_three_seats"]):
            wrong.append("one_method_three_seats is not an anchor: three distinct seats of ONE "
                         "method are three observations")
        if is_ground_truth_row(fixtures["three_seats_empty_evidence_leg"]):
            wrong.append("three_seats_empty_evidence_leg is an anchor: an anchor must stand on a "
                         "non-empty evidence leg (WP-J ce6a53541)")
        self.assertEqual(wrong, [], "the one seat law decides wrongly (N3):\n" + "\n".join(wrong))


if __name__ == "__main__":
    unittest.main()
