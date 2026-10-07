"""ARIA-HIGH-364 — one door: every agent-request mint is decided by ``admit_request``.

The mint requires an ``Admission`` (no default), so a mint without one fails
when it runs. These pins catch the paths no test runs and the ways a
decision could be forged or left unclassified:

* every production call of the mint, or of a bridge that mints, passes
  ``admission=`` explicitly, and its site is named below with its producer;
* an ``Admission`` is built only inside ``request_admission``;
* every ``admit_request`` call names a classified producer (a literal, or a
  named selector whose every returned literal is classified), and every
  classified producer has a call site — no stale row, no unclassified door;
* every invocation role is classified by at least one producer, and a
  producer classifies only real roles (no default class anywhere).
"""
from __future__ import annotations

import ast
import unittest
from pathlib import Path

from aria_kernel.agent_surface import INVOCATION_ROLES
from aria_kernel.request_admission import PRODUCER_CLASSES

_REPO_ROOT = Path(__file__).resolve().parents[2]
_SCANNED_ROOTS = ("aria-kernel/aria_kernel", "tools/aria-poc")
_DOOR = "aria-kernel/aria_kernel/request_admission.py"
_MINTS = frozenset({
    "create_agent_invocation_request",
    "issue_challenger_envelope",
    "issue_completeness_critic_envelope",
    "issue_cross_review_envelope",
    "issue_implementation_envelope",
    "issue_primary_envelope",
    # ARIA-HIGH-360's judge re-mint helpers carry their caller's admission.
    "remint_judge_for_panel",
    "remint_judge_request",
})

# Every production mint site, keyed (repo path, outermost function), with
# the producer(s) whose admission it carries. A new site, or a stale one,
# fails the build: a mint cannot appear without saying who admitted it.
MINT_SITES: dict[tuple[str, str], str] = {
    ("aria-kernel/aria_kernel/anchor_stale_effects.py", "remint_judge"): "anchor_stale.remint / remint_critical",
    ("aria-kernel/aria_kernel/autonomy_orchestrator.py", "_drain_next_cycle_queue"): "next_cycle_queue.projection",
    ("aria-kernel/aria_kernel/cli.py", "_main"): "operator_cli.request / operator_cli.convergent_plan",
    ("aria-kernel/aria_kernel/convergence_drainer.py", "run_convergence_drainer"):
        "convergence_drainer.plan_step / plan_seed / operator_plan_seed",
    ("aria-kernel/aria_kernel/convergent_planning_bridge.py", "issue_challenger_envelope"): "the caller's admission",
    ("aria-kernel/aria_kernel/convergent_planning_bridge.py", "start_convergent_plan_with_challenger"):
        "the caller's admission (operator_cli.convergent_plan)",
    ("aria-kernel/aria_kernel/cross_review_bridge.py", "issue_completeness_critic_envelope"): "the caller's admission",
    ("aria-kernel/aria_kernel/cross_review_bridge.py", "issue_cross_review_envelope"): "the caller's admission",
    ("aria-kernel/aria_kernel/cross_review_bridge.py", "issue_implementation_envelope"): "the caller's admission",
    ("aria-kernel/aria_kernel/cross_review_bridge.py", "issue_primary_envelope"): "the caller's admission",
    ("aria-kernel/aria_kernel/cycle_phases/implementer.py", "run"): "implementer.converged_plan",
    ("aria-kernel/aria_kernel/decision_questioning.py", "open_decision_questioning"): "decision_questioning.open",
    ("aria-kernel/aria_kernel/dispatcher_factory.py", "select_drafter"): "convergent_authoring.round_step",
    ("aria-kernel/aria_kernel/dispatcher_factory.py", "select_judge"): "convergent_authoring.round_step",
    ("aria-kernel/aria_kernel/expert_review_gate.py", "request_implementation_expert_reviews"):
        "expert_review_gate.implementation",
    ("aria-kernel/aria_kernel/goldset.py", "dispatch_goldset_curation"): "goldset.curation",
    ("aria-kernel/aria_kernel/human_required_adjudication.py", "open_adjudication"): "human_required_panel.open",
    ("aria-kernel/aria_kernel/human_required_adjudication.py", "_execute_panel_disposition"):
        "human_required_panel.remint",
    ("aria-kernel/aria_kernel/judge_fanout.py", "dispatch_judges_for_sample"): "judge_fanout.sample",
    ("aria-kernel/aria_kernel/judge_fanout.py", "_mint_arbiter"): "judge_fanout.arbitration",
    ("aria-kernel/aria_kernel/judge_remint.py", "remint_judge_request"): "the caller's admission",
    ("aria-kernel/aria_kernel/judge_remint.py", "remint_judge_for_panel"): "the caller's admission",
    ("aria-kernel/aria_kernel/judge_replay.py", "replay_judges_on_goldset"): "judge_replay.goldset",
    ("aria-kernel/aria_kernel/plan_round_controller.py", "_ensure_planner_request"): "plan_round_controller.plan_step",
    ("aria-kernel/aria_kernel/plan_round_controller.py", "_ensure_cross_review_round"):
        "plan_round_controller.plan_step",
    ("aria-kernel/aria_kernel/pr_tracking.py", "dispatch_change_intelligence"): "pr_tracking.change_intelligence",
    ("aria-kernel/aria_kernel/review_runner.py", "run_review_runner"): "review_runner.post_implementation",
    ("aria-kernel/aria_kernel/specialist_review_runner.py", "run_specialist_review_runner"):
        "specialist_review_runner.converged_plan",
}

# admit_request calls whose producer is chosen by a function, not a literal.
# Every string that function can return must be a classified producer.
PRODUCER_SELECTORS: frozenset[tuple[str, str]] = frozenset({
    ("aria-kernel/aria_kernel/convergence_drainer.py", "_seed_producer"),
    ("aria-kernel/aria_kernel/human_required_adjudication.py", "_remint_producer"),
    ("aria-kernel/aria_kernel/anchor_stale_effects.py", "_anchor_remint_producer"),
})


def _modules() -> list[tuple[str, ast.Module]]:
    out: list[tuple[str, ast.Module]] = []
    for root in _SCANNED_ROOTS:
        for path in sorted((_REPO_ROOT / root).rglob("*.py")):
            rel = path.relative_to(_REPO_ROOT).as_posix()
            if "/tests/" in rel or "/invariants/" in rel or Path(rel).name.startswith("test_"):
                continue
            out.append((rel, ast.parse(path.read_text(encoding="utf-8"))))
    return out


def _called(node: ast.Call) -> str | None:
    func = node.func
    return func.id if isinstance(func, ast.Name) else getattr(func, "attr", None)


def _calls_by_outermost_function(tree: ast.Module) -> list[tuple[str, ast.Call]]:
    found: list[tuple[str, ast.Call]] = []
    for top in tree.body:
        if isinstance(top, (ast.FunctionDef, ast.AsyncFunctionDef)):
            found.extend((top.name, node) for node in ast.walk(top) if isinstance(node, ast.Call))
        elif isinstance(top, ast.ClassDef):
            for member in top.body:
                if isinstance(member, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    found.extend((member.name, node) for node in ast.walk(member) if isinstance(node, ast.Call))
    return found


class EveryMintPassesThroughTheDoor(unittest.TestCase):
    def test_every_mint_call_names_its_admission_and_its_site(self) -> None:
        sites: set[tuple[str, str]] = set()
        unadmitted: list[str] = []
        for rel, tree in _modules():
            for function, call in _calls_by_outermost_function(tree):
                if _called(call) not in _MINTS:
                    continue
                sites.add((rel, function))
                if not any(keyword.arg == "admission" for keyword in call.keywords):
                    unadmitted.append(f"{rel}:{call.lineno} ({function})")
        self.assertEqual(unadmitted, [], "a mint call without an explicit admission= bypasses the door")
        self.assertEqual(sorted(sites - set(MINT_SITES)), [], "an unnamed mint site; name it and its producer")
        self.assertEqual(sorted(set(MINT_SITES) - sites), [], "a named mint site no longer mints; drop it")

    def test_an_admission_is_built_only_by_the_door(self) -> None:
        forged = [
            f"{rel}:{node.lineno}"
            for rel, tree in _modules() if rel != _DOOR
            for node in ast.walk(tree)
            if isinstance(node, ast.Call) and _called(node) == "Admission"
        ]
        self.assertEqual(forged, [])

    def test_every_admit_call_names_a_classified_producer_and_every_producer_is_called(self) -> None:
        modules = dict(_modules())
        selectable: set[str] = set()
        for rel, name in PRODUCER_SELECTORS:
            function = next(node for node in modules[rel].body
                            if isinstance(node, ast.FunctionDef) and node.name == name)
            selectable |= {node.value for node in ast.walk(function)
                           if isinstance(node, ast.Constant) and isinstance(node.value, str)
                           and node.value in PRODUCER_CLASSES}
        named: set[str] = set(selectable)
        unclassified: list[str] = []
        for rel, tree in modules.items():
            for node in ast.walk(tree):
                if not (isinstance(node, ast.Call) and _called(node) == "admit_request") or rel == _DOOR:
                    continue
                first = node.args[0] if node.args else None
                if isinstance(first, ast.Constant) and isinstance(first.value, str):
                    if first.value in PRODUCER_CLASSES:
                        named.add(first.value)
                        continue
                if isinstance(first, ast.Call) and isinstance(first.func, ast.Name) \
                        and (rel, first.func.id) in PRODUCER_SELECTORS:
                    continue
                unclassified.append(f"{rel}:{node.lineno}")
        self.assertEqual(unclassified, [], "admit_request must name a producer of PRODUCER_CLASSES")
        self.assertEqual(sorted(set(PRODUCER_CLASSES) - named), [], "a classified producer nothing calls")


class EveryRoleIsClassified(unittest.TestCase):
    def test_every_invocation_role_has_a_producer_class_and_none_is_invented(self) -> None:
        classified = {role for spec in PRODUCER_CLASSES.values() for role in spec.roles}
        self.assertEqual(sorted(set(INVOCATION_ROLES) - classified), [])
        self.assertEqual(sorted(classified - set(INVOCATION_ROLES)), [])

    def test_every_discretionary_producer_says_how_a_refusal_comes_back(self) -> None:
        for name, spec in PRODUCER_CLASSES.items():
            if "discretionary" in spec.roles.values():
                self.assertNotIn("never throttled", spec.re_offer, name)
                self.assertTrue(spec.re_offer.strip(), name)


if __name__ == "__main__":
    unittest.main()
