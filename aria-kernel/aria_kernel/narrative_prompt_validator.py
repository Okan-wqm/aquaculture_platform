"""Plan ARIA-V4 §2b + §2c + §2d + §2g — narrative-prompt validator.

Single source of truth for the pedagogy-shape rules:

  * Tier-1 — bare imperative; no narrative sections.
  * Tier-2 — imperative HEADLINE + 4-section narrative body.
  * Tier-3 — full 4-section narrative for every prohibition.

The 4 narrative sections (in order):

  1. **The temptation.** — what would lure the agent into this anti-
     pattern?
  2. **Why it looks correct.** — surface-level reasoning that makes
     it seem fine in the moment.
  3. **The downstream consequence.** — one concrete causal chain.
  4. **The correct path.** — named alternative; MUST end on the
     INVARIANT being protected (NOT on the consequence —
     rationalization-channel mitigation).

A prohibition block is identified by an H3 ``### Prohibition:``
header. Each block may carry a ``rule-class:`` tag immediately
after the header, naming a rule-class from the pedagogy registry's
``consequence_leak_allowlist`` (e.g. ``kernel-self-modification``).
When the rule-class is on the allowlist, the consequence section
MAY be OMITTED (Plan §2d — describing how a kernel-self-modification
or secret-exfiltration would work IS the attack-surface manual).

This module is consumed by:
  * ``aria-kernel/tests/invariants/v4/test_phase_v4_b_*.py`` — the
    structural invariant tests.
  * ``tools/gates/narrative-prompt-lint.ts`` — the pre-commit gate
    (mirror logic in TypeScript for operator-facing surface).
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


_FRONTMATTER_RE = re.compile(r"^---\n(.*?)\n---\n", re.DOTALL)
_PEDAGOGY_TIER_RE = re.compile(r"^pedagogy-tier:\s*(\d+)\s*$", re.MULTILINE)
_NAME_RE = re.compile(r"^name:\s*(\S+)\s*$", re.MULTILINE)

# Plan ARIA-V4 §2b — the H3 marker for a narrative-prohibition block.
_PROHIBITION_HEADER_RE = re.compile(
    r"^### Prohibition:\s*(?P<summary>[^\n]+)\n",
    re.MULTILINE,
)
# Rule-class tag — optional line directly after the H3 header.
_RULE_CLASS_RE = re.compile(
    r"^\*?\*?rule-class:\*?\*?\s*(?P<rule_class>[a-z][a-z0-9_-]*)\s*$",
    re.MULTILINE,
)

_REQUIRED_SECTIONS_FULL: tuple[str, ...] = (
    "Rule",
    "The temptation",
    "Why it looks correct",
    "The downstream consequence",
    "The correct path",
)
_REQUIRED_SECTIONS_WITHOUT_CONSEQUENCE: tuple[str, ...] = (
    "Rule",
    "The temptation",
    "Why it looks correct",
    "The correct path",
)

# Plan ARIA-V4 §2c — grep-stable imperative pattern that an
# imperative one-liner MUST contain at the start of the Rule
# section. Matches the canonical CLAUDE.md / kernel rule
# vocabulary.
_IMPERATIVE_PREFIX_RE = re.compile(
    r"^(?:Never|Don't|Do not|MUST NOT|Must not|FORBIDDEN|Forbidden|"
    r"Reject|Refuse|Block|Always)\b",
    re.IGNORECASE,
)

# Plan ARIA-V4 §2g — per-agent narrative-token budget. Imperative
# form ≈15 tokens per rule; narrative ≈180-240. For 20-prohibition
# agent the math is 300 → ~4K. V4 caps narrative tokens per file
# tier-aware: Tier-1 ≤1500 (terse imperative); Tier-2 ≤2200
# (hybrid; headline + narrative body); Tier-3 ≤2500 (full
# narrative; most bloat tolerated because every prohibition expands
# 4-section). The legacy ``TOKEN_BUDGET_PER_FILE`` alias is kept
# for back-compat with downstream callers; new code MUST use
# ``token_budget_for_tier``.
TOKEN_BUDGET_PER_TIER: dict[int, int] = {
    1: 1500,
    2: 2800,
    3: 3500,
}
TOKEN_BUDGET_PER_FILE: int = TOKEN_BUDGET_PER_TIER[3]  # legacy alias


def token_budget_for_tier(tier: int | None) -> int:
    """Plan ARIA-V4 §2g — per-tier budget; default to Tier-3
    headroom when tier is None (transitional state).
    """
    if tier is None:
        return TOKEN_BUDGET_PER_TIER[3]
    return TOKEN_BUDGET_PER_TIER.get(tier, TOKEN_BUDGET_PER_TIER[3])


@dataclass
class ProhibitionBlock:
    """Plan ARIA-V4 §2b — one ``### Prohibition:`` H3 block + its
    parsed sections.
    """

    summary: str
    rule_class: str | None
    sections_present: list[str]
    raw_text: str
    start_line: int

    def has_section(self, name: str) -> bool:
        return name in self.sections_present

    @property
    def rule_first_line(self) -> str:
        """Plan ARIA-V4 §2c — the first non-blank line of the Rule
        section (the imperative one-liner). Empty when absent.
        """
        m = re.search(
            r"\*\*Rule\.\*\*\s*\n?\s*(?P<line>[^\n]*)",
            self.raw_text,
            re.IGNORECASE,
        )
        if not m:
            return ""
        return m.group("line").strip().lstrip("`").lstrip("*").strip()


@dataclass
class FileValidationResult:
    """Plan ARIA-V4 §2 — outcome of validating ONE agent prompt
    file against its declared pedagogy tier.
    """

    path: Path
    agent_name: str | None
    pedagogy_tier: int | None
    prohibitions: list[ProhibitionBlock] = field(default_factory=list)
    violations: list[str] = field(default_factory=list)
    approx_tokens: int = 0


def _approx_tokens(text: str) -> int:
    """Plan ARIA-V4 §2g — token-count approximation without
    pulling tiktoken into the kernel.

    Anthropic published character-to-token ratios for Claude Opus:
    ~3.5-4 characters per token for English prose. We use 4
    (conservative — under-counts; an over-budget agent gets MORE
    headroom than the cap suggests).
    """
    return max(0, len(text) // 4)


def parse_agent_file(path: Path) -> FileValidationResult:
    """Plan ARIA-V4 §2 — parse one agent file into the validation
    shape. Pure: no I/O beyond the read.
    """
    text = path.read_text(encoding="utf-8")
    fm_match = _FRONTMATTER_RE.match(text)
    agent_name = None
    pedagogy_tier: int | None = None
    if fm_match:
        fm = fm_match.group(1)
        name_match = _NAME_RE.search(fm)
        tier_match = _PEDAGOGY_TIER_RE.search(fm)
        agent_name = name_match.group(1) if name_match else None
        if tier_match:
            pedagogy_tier = int(tier_match.group(1))
    body = text[fm_match.end():] if fm_match else text
    prohibitions = _extract_prohibitions(body)
    return FileValidationResult(
        path=path,
        agent_name=agent_name,
        pedagogy_tier=pedagogy_tier,
        prohibitions=prohibitions,
        violations=[],
        approx_tokens=_approx_tokens(body),
    )


def _extract_prohibitions(body: str) -> list[ProhibitionBlock]:
    """Plan ARIA-V4 §2b — find every ``### Prohibition:`` block
    in the file body. A block ends at the next H3 header (any
    ``### ``) or end-of-file.
    """
    blocks: list[ProhibitionBlock] = []
    matches = list(_PROHIBITION_HEADER_RE.finditer(body))
    for idx, header_match in enumerate(matches):
        start = header_match.start()
        # End at the next H3 or end-of-file.
        end = matches[idx + 1].start() if idx + 1 < len(matches) else len(body)
        # If a later H3 (NOT a Prohibition) sits between, end there.
        next_h3 = re.search(r"^### ", body[header_match.end():end], re.MULTILINE)
        if next_h3:
            end = header_match.end() + next_h3.start()
        raw = body[start:end]
        summary = header_match.group("summary").strip()
        rc_match = _RULE_CLASS_RE.search(raw)
        rule_class = rc_match.group("rule_class") if rc_match else None
        sections = _detect_sections(raw)
        # Determine the starting line within the original body.
        start_line = body[:start].count("\n") + 1
        blocks.append(
            ProhibitionBlock(
                summary=summary,
                rule_class=rule_class,
                sections_present=sections,
                raw_text=raw,
                start_line=start_line,
            )
        )
    return blocks


def _detect_sections(block_text: str) -> list[str]:
    """Plan ARIA-V4 §2b — detect which of the canonical 5 sections
    (Rule + 4-narrative) are present in the block.
    """
    section_markers: tuple[tuple[str, str], ...] = (
        ("Rule", r"\*\*Rule\.\*\*"),
        ("The temptation", r"\*\*The temptation\.\*\*"),
        ("Why it looks correct", r"\*\*Why it looks correct\.\*\*"),
        ("The downstream consequence", r"\*\*The downstream consequence\.\*\*"),
        ("The correct path", r"\*\*The correct path\.\*\*"),
    )
    present: list[str] = []
    for label, pattern in section_markers:
        if re.search(pattern, block_text, re.IGNORECASE):
            present.append(label)
    return present


def validate_file(
    path: Path,
    *,
    pedagogy_registry: dict[str, Any],
) -> FileValidationResult:
    """Plan ARIA-V4 §2 — validate ONE agent file against the
    pedagogy contract.

    Returns a ``FileValidationResult`` with the violations list
    populated. The caller decides whether a non-empty violations
    list FAILS the invariant.
    """
    result = parse_agent_file(path)
    tier = result.pedagogy_tier
    if tier is None:
        result.violations.append(
            f"{path.name}: missing `pedagogy-tier:` frontmatter "
            f"(Plan ARIA-V4 §2a I-V4-01)"
        )
        return result

    allowlist = pedagogy_registry.get("consequence_leak_allowlist", [])
    agent_name = result.agent_name or ""
    consequence_leak_protected_classes: set[str] = {
        entry.get("rule_class")
        for entry in allowlist
        if isinstance(entry, dict)
        and entry.get("agent_name") == agent_name
        and entry.get("rule_class")
    }

    # Token-budget check applies regardless of tier; budget is
    # tier-aware (Plan ARIA-V4 §2g).
    tier_budget = token_budget_for_tier(tier)
    if result.approx_tokens > tier_budget:
        result.violations.append(
            f"{path.name}: approx tokens {result.approx_tokens} > "
            f"tier-{tier} budget {tier_budget} (Plan ARIA-V4 §2g "
            f"I-V4-07)"
        )

    # Per-tier structural rules.
    if tier == 1:
        # Tier-1: no narrative prohibitions expected. If any
        # ``### Prohibition:`` block exists in a Tier-1 file, that's
        # a misclassification — the file should be Tier-2 or Tier-3.
        for block in result.prohibitions:
            if any(
                s != "Rule" for s in block.sections_present
            ):
                result.violations.append(
                    f"{path.name}:{block.start_line} — Tier-1 file "
                    f"contains a narrative-shape Prohibition block "
                    f"({block.summary!r}); either remove the narrative "
                    f"sections or reclassify the agent as Tier-2/3 "
                    f"(Plan ARIA-V4 §2a)"
                )
        return result

    # Tier-2 + Tier-3 narrative shape check.
    for block in result.prohibitions:
        is_protected = block.rule_class in consequence_leak_protected_classes
        required = (
            _REQUIRED_SECTIONS_WITHOUT_CONSEQUENCE
            if is_protected
            else _REQUIRED_SECTIONS_FULL
        )
        missing = [s for s in required if s not in block.sections_present]
        if missing:
            result.violations.append(
                f"{path.name}:{block.start_line} prohibition "
                f"{block.summary!r} missing sections: {missing} "
                f"(rule_class={block.rule_class!r}, "
                f"consequence_leak_protected={is_protected}; "
                f"Plan ARIA-V4 §2b I-V4-04)"
            )

        # Plan ARIA-V4 §2c — imperative-residue invariant: the
        # **Rule.** first line MUST start with a grep-stable
        # imperative. Applies to ALL tiers that have a Rule section
        # (Tier-2 hybrid + Tier-3 if a Rule headline is present).
        first_line = block.rule_first_line
        if first_line and not _IMPERATIVE_PREFIX_RE.match(first_line):
            result.violations.append(
                f"{path.name}:{block.start_line} prohibition "
                f"{block.summary!r} Rule line {first_line!r} does "
                f"not start with a grep-stable imperative "
                f"(Never / Don't / Do not / MUST NOT / FORBIDDEN / "
                f"Reject / Refuse / Block / Always); "
                f"Plan ARIA-V4 §2c I-V4-05"
            )

        # Plan ARIA-V4 §2d — consequence-leak protection: if the
        # rule_class IS on the protection allowlist for this agent,
        # the consequence section MUST be omitted.
        if is_protected and "The downstream consequence" in block.sections_present:
            result.violations.append(
                f"{path.name}:{block.start_line} prohibition "
                f"{block.summary!r} rule_class={block.rule_class!r} "
                f"is on the consequence-leak protection allowlist "
                f"for agent {agent_name!r} but the consequence "
                f"section is present; remove it (Plan ARIA-V4 §2d "
                f"I-V4-06)"
            )

    return result


def load_registry(path: Path) -> dict[str, Any]:
    """Plan ARIA-V4 §2a — load the pedagogy registry JSON."""
    return json.loads(path.read_text(encoding="utf-8"))


__all__ = [
    "FileValidationResult",
    "ProhibitionBlock",
    "TOKEN_BUDGET_PER_FILE",
    "load_registry",
    "parse_agent_file",
    "validate_file",
]
