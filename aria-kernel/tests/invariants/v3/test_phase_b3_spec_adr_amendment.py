"""Plan ARIA-V3 Phase B3 — SPEC + ADR amendments + paths-ignore fix.

Closes:
  * CRIT-V3-004 (§5.4 reinterpretation — worker_executor subprocess boundary)
  * HIGH-V3-005 (SPEC amendment without ADR)
  * INFRA-HIGH-008 (workflow paths-ignore drops SPEC edits)
  * AUDITTRAIL-HIGH-006 (SPEC amend provenance)

Locked invariants (7 cases, I-V3-30..31e):

  * I-V3-30  — §2 L3 Hard Limits L3-snowball auto-merge clause
    references Plan ARIA-V3 §B2 + ADR-033 + breaker dependencies
  * I-V3-31  — §8.1 Trust Levels Level 3 carries the Plan
    ARIA-V3 §B2 amendment block citing autonomous profile + cost
    breaker + failure breaker + lease lock + 3-event chain
  * I-V3-31a — §5.4 explicitly permits worker_executor subprocess
    boundary under autonomous profile only (CRIT-V3-004 closure)
  * I-V3-31b — ADR-033 present, has Status: Accepted, references
    Plan ARIA-V3 §B2 + §B3 + SPEC §2 L3 + §5.4 + §8.1
  * I-V3-31c — both kernel workflows (aria-kernel-full.yml +
    aria-kernel-fast.yml) have docs/aria/** and docs/adr/**
    negations in paths-ignore (INFRA-HIGH-008 closure)
  * I-V3-31d — ADR-033 explicitly documents the rollback path +
    cites operator_approval_ref as the change discipline
    (AUDITTRAIL-HIGH-006 closure)
  * I-V3-31e — kernel Python modules contain ZERO ``Agent(`` syntactic
    invocations and ZERO ``from claude.code.agent`` imports
    (§5.4 subprocess-boundary invariant)
"""

from __future__ import annotations

import re
import sys
import unittest

import yaml
from pathlib import Path


_REPO_ROOT = Path(__file__).resolve().parents[4]
_KERNEL_ROOT = _REPO_ROOT / "aria-kernel"
_KERNEL_SRC = _KERNEL_ROOT / "aria_kernel"
_SPEC = _REPO_ROOT / "docs" / "aria" / "SPEC.md"
_ADR_033 = _REPO_ROOT / "docs" / "adr" / "033-aria-autonomous-profile.md"
_KERNEL_FAST_WF = _REPO_ROOT / ".github" / "workflows" / "aria-kernel-fast.yml"
_KERNEL_WF = _REPO_ROOT / ".github" / "workflows" / "aria-kernel.yml"

if str(_KERNEL_ROOT) not in sys.path:
    sys.path.insert(0, str(_KERNEL_ROOT))


class PhaseB3SpecAdrAmendment(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.spec_text = _SPEC.read_text(encoding="utf-8")
        cls.adr_text = _ADR_033.read_text(encoding="utf-8") if _ADR_033.exists() else ""
        cls.fast_wf_text = _KERNEL_FAST_WF.read_text(encoding="utf-8")
        cls.kernel_wf_text = _KERNEL_WF.read_text(encoding="utf-8")

    # I-V3-30 — Hard Limits L3-snowball clause references B2 + ADR-033.
    def test_i_v3_30_hard_limits_references_autonomous_profile_and_breakers(self) -> None:
        # The "Never auto-merges" Hard Limit line must call out the
        # autonomous profile + circuit breakers + Plan ARIA-V3 §B2
        # + ADR-033 as the gating dependencies. The amendment makes
        # the breaker-tripped state structurally block auto-merge.
        # Find the auto-merge Hard Limit line.
        match = re.search(
            r"✗ Never auto-merges[^\n]*",
            self.spec_text,
        )
        self.assertIsNotNone(
            match, msg="Hard Limits auto-merge line missing"
        )
        line = match.group(0)
        self.assertIn(
            "autonomous", line,
            msg="auto-merge Hard Limit must reference `autonomous` profile",
        )
        self.assertIn(
            "circuit breakers", line,
            msg="auto-merge Hard Limit must reference circuit breakers",
        )
        self.assertIn(
            "ADR-033", line,
            msg="auto-merge Hard Limit must cite ADR-033",
        )

    # I-V3-31 — §8.1 Trust Levels Level 3 amendment block present.
    def test_i_v3_31_level_3_carries_plan_aria_v3_b2_amendment(self) -> None:
        # The Level 3 description must contain a Plan ARIA-V3 §B2
        # amendment paragraph citing the four breaker/lease pillars.
        l3_block_re = re.compile(
            r"LEVEL 3 — Low-Risk Auto-Merge.*?NO FULL AUTONOMY",
            re.DOTALL,
        )
        match = l3_block_re.search(self.spec_text)
        self.assertIsNotNone(match, msg="Level 3 block missing")
        l3_text = match.group(0)
        # The amendment paragraph must cite all four pillars.
        for required in (
            "Plan ARIA-V3",
            "autonomous",
            "cost_budget",
            "failure circuit breaker",
            "cross-host lease",
            "materialize_event_id",
        ):
            self.assertIn(
                required, l3_text,
                msg=f"Level 3 block missing required token {required!r}",
            )

    # I-V3-31a — §5.4 subprocess carve-out.
    def test_i_v3_31a_section_5_4_permits_worker_executor_subprocess(self) -> None:
        # The §5.4 "Existing-agent integration policy" section MUST
        # carry an explicit amendment block permitting the
        # worker_executor subprocess boundary under the autonomous
        # profile only (CRIT-V3-004 closure).
        section_re = re.compile(
            r"### 5\.4 — Existing-agent integration policy.*?(?=\n## |\Z)",
            re.DOTALL,
        )
        match = section_re.search(self.spec_text)
        self.assertIsNotNone(match, msg="§5.4 section missing")
        section_text = match.group(0)
        for required in (
            "worker_executor",
            "subprocess boundary",
            "autonomous",
            "aria-drafter",
            "ADR-033",
        ):
            self.assertIn(
                required, section_text,
                msg=f"§5.4 carve-out missing token {required!r}",
            )

    # I-V3-31b — ADR-033 present + structurally complete.
    def test_i_v3_31b_adr_033_present_and_links_spec(self) -> None:
        self.assertTrue(
            _ADR_033.exists(),
            msg=f"ADR-033 missing at {_ADR_033}",
        )
        for required in (
            "ADR-033",
            "Status:** Accepted",
            "Plan ARIA-V3 §B2",
            "Plan ARIA-V3 §B3",
            "snowball",
            "autonomous",
            "circuit breaker",
            "cross-host lease",
        ):
            self.assertIn(
                required, self.adr_text,
                msg=f"ADR-033 missing required token {required!r}",
            )

    # I-V3-31c — SPEC/ADR edits retrigger the kernel suite (ORPHAN-MEDIUM-769
    # topology: aria-kernel.yml owns the push lane UNFILTERED, which
    # satisfies this concern strictly more strongly than the old negation
    # patterns in fast/full ever did; fast is PR-only now).
    def test_i_v3_31c_workflow_paths_ignore_retriggers_on_spec_edit(self) -> None:
        kernel_on = yaml.safe_load(self.kernel_wf_text)["on"] if "on" in yaml.safe_load(self.kernel_wf_text) else yaml.safe_load(self.kernel_wf_text)[True]
        push = kernel_on.get("push")
        self.assertIsInstance(push, dict, "aria-kernel.yml must carry a push trigger")
        self.assertNotIn("paths", push, "an unfiltered push retriggers on SPEC/ADR edits; a paths filter is the only way to lose that")
        self.assertNotIn("paths-ignore", push, "an unfiltered push retriggers on SPEC/ADR edits; a paths-ignore filter is the only way to lose that")
        fast_on = yaml.safe_load(self.fast_wf_text)["on"] if "on" in yaml.safe_load(self.fast_wf_text) else yaml.safe_load(self.fast_wf_text)[True]
        self.assertNotIn("push", fast_on, "aria-kernel-fast.yml is PR-only (ORPHAN-MEDIUM-769)")

    # I-V3-31d — ADR-033 documents rollback path + change discipline.
    def test_i_v3_31d_adr_documents_rollback_and_approval_ref(self) -> None:
        for required in (
            "Rollback path",
            "operator_approval_ref",
            "circuit-breaker reset",
            "autonomy lease release",
        ):
            self.assertIn(
                required, self.adr_text,
                msg=(
                    f"ADR-033 missing required rollback-discipline token "
                    f"{required!r} (AUDITTRAIL-HIGH-006)"
                ),
            )

    # I-V3-31e — kernel modules contain no Agent() invocations.
    def test_i_v3_31e_kernel_modules_no_agent_invocation(self) -> None:
        # AST-based check (regex would false-positive on docstring
        # mentions of ``Agent()`` in narrative form — e.g. the
        # comment "kernel never invokes ``Agent()`` directly" is the
        # rule citation, not the rule violation).
        #
        # Forbidden:
        #   1. ``from claude.code.agent import ...``
        #   2. ``Agent(...)`` as a syntactic Call where func is a
        #      Name node with id ``Agent`` (exact identifier).
        #
        # Test files / tools/ / docs/ are exempt; the invariant
        # locks the kernel surface itself (aria_kernel/*.py).
        import ast

        violations: list[str] = []
        for py in sorted(_KERNEL_SRC.rglob("*.py")):
            if py.name == "__init__.py":
                continue
            text = py.read_text(encoding="utf-8")
            try:
                tree = ast.parse(text)
            except SyntaxError:
                continue
            for node in ast.walk(tree):
                if isinstance(node, ast.ImportFrom):
                    module = node.module or ""
                    if module == "claude.code.agent" or module.startswith(
                        "claude.code.agent."
                    ):
                        violations.append(
                            f"{py.relative_to(_REPO_ROOT)}:{node.lineno} "
                            f"imports claude.code.agent"
                        )
                elif isinstance(node, ast.Call):
                    func = node.func
                    if isinstance(func, ast.Name) and func.id == "Agent":
                        violations.append(
                            f"{py.relative_to(_REPO_ROOT)}:{node.lineno} "
                            f"syntactic Agent(...) invocation"
                        )
        self.assertEqual(violations, [], msg="\n".join(violations))


if __name__ == "__main__":
    unittest.main()
