"""ARIA-CRITICAL-216 — every operator-approval caller, classified and pinned.

Three classes, one rule each:

* RAISING — success widens what ARIA may do. Proven only by a GitHub act of a
  listed operator (``operator_approval.verify_operator_approval``), scoped to
  exactly the grant and consumed once. ``gov:``/``review:``/``ack-env:`` are
  refused: ARIA can author every one of them.
* LOWERING — success narrows authority (revoke a grant, freeze, lower a
  profile or ceiling). A reason string on the record is enough; these callers
  reference neither verifier.
* RECORD — the reference attests a decision that grants no authority (a
  consensus finding admitted, an anti-pattern that SKIPS work, a run-ledger
  format, a surface reset). They keep the recorded-reference grammar
  (``operator_approval.verify_recorded_reference``), which refuses every
  RAISING surface by construction.

The table below is the whole population. A new call to either verifier, a new
surface, or a caller moving class fails here until it is classified.
"""
from __future__ import annotations

import ast
import os
import shutil
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

import aria_kernel
from aria_kernel.operator_approval import AUTHORITY_RAISING_SURFACES, RECORD_SURFACES
from aria_kernel.tool_registry import GovernanceError, append_tools_governance, ensure_tools_dir
from tests._helpers.operator_acts import github_operator_acts, operator_set_profile

KERNEL = Path(aria_kernel.__file__).resolve().parent

GITHUB_VERIFIER = "verify_operator_approval"
RECORDED_VERIFIER = "verify_recorded_reference"

# (module, function) -> (verifier it calls, surfaces it names). The direct call
# sites; the entry points that reach them are listed in ENTRY_POINTS.
VERIFIER_CALL_SITES: dict[tuple[str, str], tuple[str, frozenset[str]]] = {
    ("runtime_profile", "set_profile"): (GITHUB_VERIFIER, frozenset({"runtime_profile"})),
    ("runtime_profile", "set_merge_lane_grant"): (GITHUB_VERIFIER, frozenset({"merge_lane_grant"})),
    ("self_merge_freeze", "unfreeze_self_merge"): (GITHUB_VERIFIER, frozenset({"self_merge_unfreeze"})),
    ("tool_registry", "resolve_transition_approval"): (
        GITHUB_VERIFIER, frozenset({"tool_promote", "tool_unquarantine"}),
    ),
    ("policy_approval", "record_policy_approval"): (GITHUB_VERIFIER, frozenset({"l3_policy_approval"})),
    ("finding_promotion", "promote_consensus_findings"): (
        RECORDED_VERIFIER, frozenset({"consensus_finding_promotion"}),
    ),
    ("knowledge_graph", "record_anti_pattern"): (RECORDED_VERIFIER, frozenset({"knowledge_graph_anti_pattern"})),
    ("runtime_artifacts", "approve_runtime_v2_promotion"): (RECORDED_VERIFIER, frozenset({"runtime_v2_promotion"})),
    ("memory_gap", "record_surface_reset"): (RECORDED_VERIFIER, frozenset({"surface_reset"})),
}

# Every entry point an operator (or a lane) reaches, with its class. set_profile
# is both: a transition that widens the recorded grant is RAISING, any other
# transition (frozen, observe, a lower ceiling, a lane inside its ceiling) is
# LOWERING. transition_tool is RAISING for ACTIVE and for leaving QUARANTINED.
ENTRY_POINTS: dict[tuple[str, str], str] = {
    ("runtime_profile", "set_profile"): "RAISING|LOWERING",
    ("runtime_profile", "set_merge_lane_grant"): "RAISING",
    ("runtime_profile", "revoke_merge_lane_grant"): "LOWERING",
    ("self_merge_freeze", "unfreeze_self_merge"): "RAISING",
    ("self_merge_freeze", "freeze_self_merge"): "LOWERING",
    ("tool_registry", "transition_tool"): "RAISING",
    ("tool_registry", "unquarantine_tool"): "RAISING",
    ("promotion", "promote_tool"): "RAISING",
    ("policy_approval", "record_policy_approval"): "RAISING",
    ("finding_promotion", "promote_consensus_findings"): "RECORD",
    ("knowledge_graph", "record_anti_pattern"): "RECORD",
    ("runtime_artifacts", "approve_runtime_v2_promotion"): "RECORD",
    ("memory_gap", "record_surface_reset"): "RECORD",
}


def _functions(tree: ast.AST) -> list[ast.FunctionDef]:
    return [node for node in ast.walk(tree) if isinstance(node, ast.FunctionDef)]


def _called_names(node: ast.AST) -> set[str]:
    names: set[str] = set()
    for call in ast.walk(node):
        if isinstance(call, ast.Call):
            func = call.func
            if isinstance(func, ast.Name):
                names.add(func.id)
            elif isinstance(func, ast.Attribute):
                names.add(func.attr)
    return names


def _verifier_calls() -> dict[tuple[str, str], tuple[str, frozenset[str]]]:
    found: dict[tuple[str, str], tuple[str, frozenset[str]]] = {}
    for path in sorted(KERNEL.rglob("*.py")):
        module = path.relative_to(KERNEL).with_suffix("").as_posix().replace("/", ".")
        if module == "operator_approval":
            continue
        for function in _functions(ast.parse(path.read_text(encoding="utf-8"))):
            for call in ast.walk(function):
                if not isinstance(call, ast.Call):
                    continue
                func = call.func
                name = func.id if isinstance(func, ast.Name) else getattr(func, "attr", None)
                if name not in (GITHUB_VERIFIER, RECORDED_VERIFIER):
                    continue
                surface = next((kw.value for kw in call.keywords if kw.arg == "surface"), None)
                literals = frozenset(
                    node.value for node in ast.walk(surface)
                    if isinstance(node, ast.Constant) and isinstance(node.value, str)
                ) if surface is not None else frozenset()
                key = (module, function.name)
                prior = found.get(key)
                if prior is not None:
                    literals = literals | prior[1]
                found[key] = (name, literals)
    return found


class CallerClassificationTests(unittest.TestCase):
    def test_every_verifier_call_site_is_classified(self) -> None:
        self.assertEqual(_verifier_calls(), VERIFIER_CALL_SITES)

    def test_the_surface_sets_are_exactly_the_classified_surfaces(self) -> None:
        raising = set().union(*(s for v, s in VERIFIER_CALL_SITES.values() if v == GITHUB_VERIFIER))
        record = set().union(*(s for v, s in VERIFIER_CALL_SITES.values() if v == RECORDED_VERIFIER))
        self.assertEqual(raising, set(AUTHORITY_RAISING_SURFACES))
        self.assertEqual(record, set(RECORD_SURFACES))

    def test_the_legacy_verifier_is_gone(self) -> None:
        for path in sorted(KERNEL.rglob("*.py")):
            self.assertNotIn("verify_operator_approval_ref", path.read_text(encoding="utf-8"), msg=str(path))

    def test_every_entry_point_exists_and_reaches_its_class(self) -> None:
        trees = {
            path.relative_to(KERNEL).with_suffix("").as_posix(): ast.parse(path.read_text(encoding="utf-8"))
            for path in KERNEL.rglob("*.py")
        }
        for (module, name), klass in ENTRY_POINTS.items():
            with self.subTest(entry=f"{module}.{name}"):
                function = next(f for f in _functions(trees[module]) if f.name == name)
                called = _called_names(function)
                if klass == "LOWERING":
                    self.assertFalse(called & {GITHUB_VERIFIER, RECORDED_VERIFIER, "resolve_transition_approval"})
                elif klass == "RECORD":
                    self.assertIn(RECORDED_VERIFIER, called)
                elif (module, name) in VERIFIER_CALL_SITES:
                    self.assertIn(GITHUB_VERIFIER, called)
                else:
                    # Reaches the verifier through the tool lifecycle resolver.
                    self.assertTrue(called & {"resolve_transition_approval", "transition_tool"}, called)


class RaisingSurfacesRefuseRecordedReferences(unittest.TestCase):
    """Each RAISING entry point refuses a ref that ARIA itself could author."""

    def setUp(self) -> None:
        self._tmp = Path(tempfile.mkdtemp(prefix="aria-opa-callers-"))
        self.addCleanup(lambda: shutil.rmtree(self._tmp, ignore_errors=True))
        self.tools = ensure_tools_dir(self._tmp / "aria-tools")
        event = append_tools_governance(self.tools, "operator_action", {"action": "approve"})
        doc = self._tmp / "review.md"
        doc.write_text("## OP-1\n", encoding="utf-8")
        os.environ["ARIA_TEST_ACK_216"] = "yes"
        self.addCleanup(os.environ.pop, "ARIA_TEST_ACK_216", None)
        self.refs = (f"gov:{event['event_id']}", f"review:{doc}#OP-1", "ack-env:ARIA_TEST_ACK_216")

    def _assert_refused(self, action) -> None:
        for ref in self.refs:
            with self.subTest(ref=ref), self.assertRaisesRegex(GovernanceError, "gh:<owner>/<repo>#<number>"):
                action(ref)

    def test_profile_raise(self) -> None:
        from aria_kernel.runtime_profile import set_profile

        self._assert_refused(lambda ref: set_profile("strict", operator_approval_ref=ref, base_dir=self.tools))
        self._assert_refused(lambda ref: set_profile(
            "standard", operator_approval_ref=ref, base_dir=self.tools, scheduler_ceiling="strict",
        ))

    def test_merge_lane_grant(self) -> None:
        from aria_kernel.runtime_profile import set_merge_lane_grant

        expires = (datetime.now(timezone.utc) + timedelta(days=3)).strftime("%Y-%m-%dT%H:%M:%SZ")
        self._assert_refused(lambda ref: set_merge_lane_grant(
            lane="L1", expires_at=expires, operator_approval_ref=ref, base_dir=self.tools,
        ))

    def test_self_merge_unfreeze(self) -> None:
        from aria_kernel.self_merge_freeze import freeze_self_merge, unfreeze_self_merge

        row = freeze_self_merge(merge_sha="a" * 40, pr_number=1, trigger="test", evidence={}, base_dir=self.tools)
        self._assert_refused(lambda ref: unfreeze_self_merge(
            freeze_id=row["freeze_id"], operator_approval_ref=ref, base_dir=self.tools,
        ))

    def test_tool_promotion_and_unquarantine(self) -> None:
        from aria_kernel.tool_registry import resolve_transition_approval

        self._assert_refused(lambda ref: resolve_transition_approval(
            ref, tool_id="adapter-x", current_status="SHADOW", target_status="ACTIVE", base_dir=self.tools,
        ))
        self._assert_refused(lambda ref: resolve_transition_approval(
            ref, tool_id="adapter-x", current_status="QUARANTINED", target_status="CALIBRATE", base_dir=self.tools,
        ))

    def test_l3_policy_approval(self) -> None:
        from aria_kernel.policy_approval import record_policy_approval

        self._assert_refused(lambda ref: record_policy_approval({
            "approval_id": "a-1", "stage": "risk_owner", "pr_number": 5, "head_sha": "b" * 40,
            "policy_hash": "sha256:" + "c" * 64, "expires_at": "2099-01-01T00:00:00Z",
            "operator_approval_ref": ref,
        }, base_dir=self.tools))


class LoweringSurfacesTakeAReason(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = Path(tempfile.mkdtemp(prefix="aria-opa-lower-"))
        self.addCleanup(lambda: shutil.rmtree(self._tmp, ignore_errors=True))
        self.tools = ensure_tools_dir(self._tmp / "aria-tools")

    def test_lowering_needs_no_github_act(self) -> None:
        from aria_kernel.runtime_profile import (
            get_profile,
            get_scheduler_profile_ceiling,
            revoke_merge_lane_grant,
            set_profile,
        )
        from aria_kernel.self_merge_freeze import active_freeze, freeze_self_merge

        operator_set_profile("strict", base_dir=self.tools, scheduler_ceiling="strict")
        with github_operator_acts() as github:
            set_profile("frozen", operator_approval_ref="incident: stop everything", base_dir=self.tools)
            set_profile("observe", operator_approval_ref="incident: watch only", base_dir=self.tools)
            set_profile(
                "observe", operator_approval_ref="incident: lower the grant",
                base_dir=self.tools, scheduler_ceiling="standard",
            )
            revoke_merge_lane_grant(operator_approval_ref="incident: no merges", base_dir=self.tools)
            freeze_self_merge(merge_sha="d" * 40, pr_number=3, trigger="test", evidence={}, base_dir=self.tools)
            self.assertEqual(github.reads, [])
        self.assertEqual(get_profile(base_dir=self.tools), "observe")
        self.assertEqual(get_scheduler_profile_ceiling(base_dir=self.tools), "standard")
        self.assertIsNotNone(active_freeze(base_dir=self.tools))

    def test_a_lane_inside_the_recorded_ceiling_needs_no_github_act(self) -> None:
        from aria_kernel.runtime_profile import get_profile, set_profile

        operator_set_profile("standard", base_dir=self.tools, scheduler_ceiling="strict")
        set_profile("frozen", operator_approval_ref="incident", base_dir=self.tools)
        with github_operator_acts() as github:
            set_profile("strict", operator_approval_ref="cli-flag:nightly", base_dir=self.tools, set_by="autonomy-cli")
            self.assertEqual(github.reads, [])
        self.assertEqual(get_profile(base_dir=self.tools), "strict")


if __name__ == "__main__":
    unittest.main()
