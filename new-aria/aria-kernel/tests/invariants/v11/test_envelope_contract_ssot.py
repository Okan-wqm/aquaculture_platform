"""Plan ARIA-V11 (WS2) — the ONE authoritative envelope-contract mirror.

The ARIA canonical-envelope contract is owned by the kernel as three
SSoT constants in ``aria_kernel.plan_convergence``:

- ``PLAN_CONTENT_REQUIRED``    — the 7 plan_content top-level fields
- ``CROSS_REVIEW_RISK_REQUIRED`` — the 7 cross-review risk-entry fields
- ``RISK_SEVERITY_VALUES``     — the cross-review severity vocabulary

Those constants are the SINGLE SOURCE OF TRUTH. Every other place the
contract is restated is a MIRROR that must derive from (or be asserted
against) the kernel constant — never a hand-maintained copy. Before WS2,
the contract was restated as independent literals in:

1. ``.claude/knowledge/layer-2-aria-canonical-envelope.md`` (the doc SSoT)
2. the three planner/cross-reviewer agent ``.md`` prompts (deliberate
   inline so the Opus model sees the schema without indirection)
3. ``tools/aria-poc/ci_executor.py`` (a runtime fail-fast gate + a
   standalone except-branch fallback literal)
4. ``v8/test_phase_v8_1_canonical_envelope.py`` (now imports the kernel)
5. ``v10/test_phase_v10_4_phase_3_h_7_*`` (now imports the kernel)

This file is the tier-3 "make detectable" net: each invariant below is a
CODE -> DOC / CODE -> CODE mirror with the kernel constant as the SSoT.
If any mirror drifts from the kernel, exactly one of these fails with a
precise message naming the drifted surface. The hardcoded copies inside
the v8/v10 test files (items 4 & 5) are GONE — those files now import the
kernel constants — so this file does not re-introduce a copy either; it
asserts the surviving mirrors against the kernel.

Invariants:

- I-V11-ENV-01 — the knowledge-doc SSoT mentions every PLAN_CONTENT_REQUIRED
  field name and every CROSS_REVIEW_RISK_REQUIRED field name.
- I-V11-ENV-02 — the deliberate agent-prompt inlines stay exact: the
  cross-reviewer prompt contains every CROSS_REVIEW_RISK_REQUIRED name;
  the two planner prompts each contain every PLAN_CONTENT_REQUIRED name.
- I-V11-ENV-03 — ci_executor mirrors the kernel: its runtime
  ``_PLAN_CONTENT_REQUIRED`` equals the kernel constant AND its
  standalone except-branch fallback tuple (parsed from source) equals it
  too, so even the kernel-less fallback cannot drift.
- I-V11-ENV-04 — symbol-not-line citation rule: the cross-reviewer prompt
  + the knowledge doc cite ``_validate_cross_review_risk`` by SYMBOL and
  carry NO brittle ``plan_convergence.py:<n>`` / ``(line <n>)`` suffix
  next to a validator symbol. This permanently extinguishes the line-drift
  class (the line number moved under WS1's refactor; the symbol did not).
- I-V11-ENV-05 — severity vocabulary is code-derived: the kernel accept
  set for cross-review severity is the UNION of RISK_SEVERITY_VALUES and
  KNOWN_SEVERITIES (read from _validate_cross_review_risk), and the
  knowledge-doc SSoT names the RISK_SEVERITY_VALUES members so the doc
  cannot omit an accepted value. No 7th hardcoded copy is introduced.
"""
from __future__ import annotations

import ast
import inspect
import re
import sys
import unittest
from pathlib import Path

from . import _helpers  # noqa: F401

from aria_kernel import plan_convergence
from aria_kernel.plan_convergence import (
    CROSS_REVIEW_RISK_REQUIRED,
    KNOWN_SEVERITIES,
    PLAN_CONTENT_REQUIRED,
    RISK_SEVERITY_VALUES,
)


REPO_ROOT = Path(__file__).resolve().parents[4]
KNOWLEDGE_FILE = REPO_ROOT / ".claude" / "knowledge" / "layer-2-aria-canonical-envelope.md"
CROSS_REVIEWER_FILE = REPO_ROOT / ".claude" / "agents" / "aria-cross-reviewer.md"
PRIMARY_PLANNER_FILE = REPO_ROOT / ".claude" / "agents" / "aria-primary-planner.md"
CHALLENGER_PLANNER_FILE = REPO_ROOT / ".claude" / "agents" / "aria-challenger-planner.md"
CI_EXECUTOR_FILE = REPO_ROOT / "tools" / "aria-poc" / "ci_executor.py"


def _extract_fallback_plan_content_required(source: str) -> tuple[str, ...]:
    """AST-walk ci_executor source; return the ``_PLAN_CONTENT_REQUIRED``
    tuple assigned inside an ``except`` handler (the standalone, kernel-less
    fallback). The kernel SSoT is loaded in the matching ``try`` body via an
    import — the literal copy lives ONLY in the except branch, which is what
    this drift guard checks. Returns the string members in declaration order.
    """
    tree = ast.parse(source)
    for node in ast.walk(tree):
        if not isinstance(node, ast.Try):
            continue
        for handler in node.handlers:
            for stmt in ast.walk(handler):
                if not isinstance(stmt, ast.Assign):
                    continue
                targets = stmt.targets
                if not (len(targets) == 1 and isinstance(targets[0], ast.Name)):
                    continue
                if targets[0].id != "_PLAN_CONTENT_REQUIRED":
                    continue
                value = stmt.value
                if not isinstance(value, (ast.Tuple, ast.List)):
                    raise AssertionError(
                        "ci_executor except-branch _PLAN_CONTENT_REQUIRED "
                        "must be a tuple/list literal for the drift guard "
                        f"to parse it; got {type(value).__name__}."
                    )
                members: list[str] = []
                for elt in value.elts:
                    if not (isinstance(elt, ast.Constant) and isinstance(elt.value, str)):
                        raise AssertionError(
                            "ci_executor except-branch _PLAN_CONTENT_REQUIRED "
                            "members must be string literals."
                        )
                    members.append(elt.value)
                return tuple(members)
    raise AssertionError(
        "could not locate an except-branch _PLAN_CONTENT_REQUIRED fallback "
        "assignment in ci_executor.py — the WS1 try/except contract changed."
    )


class EnvelopeContractSsotInvariants(unittest.TestCase):
    """WS2 — kernel-constant-as-SSoT mirror invariants."""

    def test_i_v11_env_01_knowledge_doc_lists_all_kernel_fields(self):
        """I-V11-ENV-01 (CODE -> DOC mirror): the canonical-envelope
        knowledge SSoT must name every plan_content field AND every
        cross-review risk field that the kernel constants declare. The
        kernel constants are the source; the doc is the mirror."""
        body = KNOWLEDGE_FILE.read_text(encoding="utf-8")
        for field in PLAN_CONTENT_REQUIRED:
            self.assertIn(
                field, body,
                f"I-V11-ENV-01: knowledge doc must name plan_content field "
                f"{field!r} from kernel PLAN_CONTENT_REQUIRED.",
            )
        for field in CROSS_REVIEW_RISK_REQUIRED:
            self.assertIn(
                field, body,
                f"I-V11-ENV-01: knowledge doc must name cross-review risk "
                f"field {field!r} from kernel CROSS_REVIEW_RISK_REQUIRED.",
            )

    def test_i_v11_env_02_agent_prompts_inline_kernel_fields(self):
        """I-V11-ENV-02 (CODE -> DOC mirror, deliberate inline): the agent
        prompts intentionally inline the field names so the Opus model sees
        the schema without indirection (F-019 lesson: show > tell). This
        asserts the inline stays EXACT against the kernel constants — the
        cross-reviewer carries every CROSS_REVIEW_RISK_REQUIRED name; each
        planner carries every PLAN_CONTENT_REQUIRED name."""
        cross_body = CROSS_REVIEWER_FILE.read_text(encoding="utf-8")
        for field in CROSS_REVIEW_RISK_REQUIRED:
            self.assertIn(
                field, cross_body,
                f"I-V11-ENV-02: aria-cross-reviewer.md must inline cross-"
                f"review risk field {field!r} (kernel CROSS_REVIEW_RISK_REQUIRED).",
            )
        for planner in (PRIMARY_PLANNER_FILE, CHALLENGER_PLANNER_FILE):
            body = planner.read_text(encoding="utf-8")
            for field in PLAN_CONTENT_REQUIRED:
                self.assertIn(
                    field, body,
                    f"I-V11-ENV-02: {planner.name} must inline plan_content "
                    f"field {field!r} (kernel PLAN_CONTENT_REQUIRED).",
                )

    def test_i_v11_env_03_ci_executor_mirrors_kernel_runtime_and_fallback(self):
        """I-V11-ENV-03 (CODE -> CODE mirror): ci_executor must mirror the
        kernel SSoT on BOTH paths — the live runtime value (imported from
        the kernel when available) AND the standalone except-branch fallback
        literal (used when the kernel is not importable). Asserting only the
        runtime value would let the fallback drift unseen on kernel-less
        installs; asserting only the source literal would not prove the live
        value. Both equal PLAN_CONTENT_REQUIRED."""
        ci_tools_dir = REPO_ROOT / "tools" / "aria-poc"
        if str(ci_tools_dir) not in sys.path:
            sys.path.insert(0, str(ci_tools_dir))
        import ci_executor  # noqa: PLC0415 — repo-path import, intentional

        self.assertEqual(
            tuple(ci_executor._PLAN_CONTENT_REQUIRED),
            tuple(PLAN_CONTENT_REQUIRED),
            "I-V11-ENV-03: ci_executor runtime _PLAN_CONTENT_REQUIRED must "
            "equal kernel plan_convergence.PLAN_CONTENT_REQUIRED.",
        )

        source = CI_EXECUTOR_FILE.read_text(encoding="utf-8")
        fallback = _extract_fallback_plan_content_required(source)
        self.assertEqual(
            fallback,
            tuple(PLAN_CONTENT_REQUIRED),
            "I-V11-ENV-03: ci_executor except-branch fallback "
            "_PLAN_CONTENT_REQUIRED literal must equal kernel "
            "plan_convergence.PLAN_CONTENT_REQUIRED (same fields, same "
            "order) so the kernel-less standalone path cannot drift.",
        )

    def test_i_v11_env_04_symbol_not_line_citation(self):
        """I-V11-ENV-04 (anti-drift rule): the cross-reviewer prompt + the
        knowledge doc must cite the validator by SYMBOL
        (``_validate_cross_review_risk``) and carry NO brittle line-number
        suffix next to a validator symbol. WS1's refactor moved the
        function; a ``plan_convergence.py:1784`` / ``(line 1784)`` citation
        is now wrong and re-rots every time the file changes. Symbol cites
        survive refactors; line cites do not."""
        # The validator symbol must remain cited in both surfaces.
        for path in (CROSS_REVIEWER_FILE, KNOWLEDGE_FILE):
            body = path.read_text(encoding="utf-8")
            self.assertIn(
                "_validate_cross_review_risk", body,
                f"I-V11-ENV-04: {path.name} must cite the kernel validator "
                f"by symbol '_validate_cross_review_risk'.",
            )

        # No bare plan_convergence.py:<digits> file:line citation anywhere.
        file_line = re.compile(r"plan_convergence\.py:\d+")
        # No "(line <digits>)" adjacent (within ~40 chars) to a validator
        # symbol — this is the exact stale-citation shape WS2 extinguished.
        validator_line = re.compile(
            r"_validate_(?:cross_review_risk|plan_content)\b[^\n]{0,40}?\(line \d+\)"
        )
        for path in (CROSS_REVIEWER_FILE, KNOWLEDGE_FILE):
            body = path.read_text(encoding="utf-8")
            self.assertEqual(
                file_line.findall(body), [],
                f"I-V11-ENV-04: {path.name} must NOT carry a brittle "
                f"'plan_convergence.py:<line>' citation — cite the symbol "
                f"instead. Found: {file_line.findall(body)}",
            )
            self.assertEqual(
                validator_line.findall(body), [],
                f"I-V11-ENV-04: {path.name} must NOT carry a brittle "
                f"'(line <n>)' suffix next to a validator symbol. "
                f"Found: {validator_line.findall(body)}",
            )

    def test_i_v11_env_05_severity_vocab_is_code_derived(self):
        """I-V11-ENV-05 (CODE -> DOC mirror, code-derived): the kernel's
        cross-review severity accept set is the UNION of RISK_SEVERITY_VALUES
        and KNOWN_SEVERITIES — read directly from _validate_cross_review_risk
        source so this assertion tracks the validator, not a copy. The
        knowledge-doc SSoT must name every RISK_SEVERITY_VALUES member so the
        doc cannot silently omit an accepted severity. This stays modest: it
        derives the rule from code rather than hardcoding a 7th copy of the
        vocabulary."""
        validator_src = inspect.getsource(plan_convergence._validate_cross_review_risk)
        # The validator builds its accept set from both constants by name.
        self.assertIn(
            "RISK_SEVERITY_VALUES", validator_src,
            "I-V11-ENV-05: _validate_cross_review_risk must derive its "
            "severity accept set from RISK_SEVERITY_VALUES (the SSoT).",
        )
        self.assertIn(
            "KNOWN_SEVERITIES", validator_src,
            "I-V11-ENV-05: _validate_cross_review_risk must union "
            "KNOWN_SEVERITIES into the severity accept set.",
        )
        # The two vocabularies are disjoint by design (cross-review
        # lower-snake vs finding upper-case) — verifies they are kept
        # separate, not merged into one drifting literal.
        self.assertEqual(
            set(RISK_SEVERITY_VALUES) & set(KNOWN_SEVERITIES), set(),
            "I-V11-ENV-05: RISK_SEVERITY_VALUES and KNOWN_SEVERITIES must "
            "stay disjoint vocabularies (the validator unions them).",
        )
        # The doc SSoT must name every cross-review severity the kernel
        # accepts from RISK_SEVERITY_VALUES.
        doc_body = KNOWLEDGE_FILE.read_text(encoding="utf-8")
        for sev in RISK_SEVERITY_VALUES:
            self.assertIn(
                sev, doc_body,
                f"I-V11-ENV-05: knowledge doc must name accepted cross-review "
                f"severity {sev!r} from kernel RISK_SEVERITY_VALUES.",
            )


if __name__ == "__main__":
    unittest.main()
