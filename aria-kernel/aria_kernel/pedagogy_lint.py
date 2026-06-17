"""Plan ARIA-V5 §3e V5.3 Phase 5.3 — pedagogy lint module.

V5.3 universalizes V4's pedagogy-tier discipline from the 9 ARIA
agents to all 81 agents under ``.claude/agents/**/*.md``. This
module is the lint SSoT: it scans agent files for imperative
prohibitions, asserts each is paired with a narrative explanation
within ≤6 lines, and reports violations via CLI exit code +
structured JSON output.

Operator anchor (Plan ARIA-V5 §1, verbatim):
  "agentlara yapma demek yerıne yaptıgında neler olacak neden
   yapmaması gerektıgı orneklerle acıklanmalı"

The pairing rule per tier (Plan v2 §3e):

  * Tier-1 (imperative-only, ~10 agents): bare imperative allowed,
    no narrative required (consequence-leak-allowlist class —
    describing the consequence IS the attack manual).
  * Tier-2 (hybrid, ~60 agents): at least ONE of **Why:** /
    **Consequence:** / **Example:** / fenced code block within ≤6
    lines below the imperative.
  * Tier-3 (full narrative, ~11 agents): **Example:** / code block
    REQUIRED, plus at least one of **Why:** / **Consequence:**
    (operator "orneklerle" plural-mandatory).

Grandfather mechanism (R-P4): the allowlist file
``tests/invariants/agent-pedagogy.allowlist.json`` carries dated
entries (file_mtime-keyed). Entries expire 30 days after entry date;
after expiry the lint goes red regardless. Operators add entries
when introducing new prohibitions that have not yet had narrative
written; entries are REMOVED when narrative lands.

Lazy expansion (R-P1, hard requirement): narrative bodies live in
sibling ``<agent>.pedagogy.md`` files. The agent loader injects
narrative ONLY on violation feedback or pedagogy_lint scan;
default system prompts stay imperative-only (grep-stable +
token-budget bounded).
"""

from __future__ import annotations

import json
import re
import sys
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


# Plan ARIA-V5 §3e v2 R4 fix — regex tightening:
#   * case-sensitive uppercase (lowercase "always" / "required" must
#     NOT trigger imperative detection)
#   * frontmatter (between --- markers) is SKIPPED
#   * fenced code blocks are SKIPPED
#   * `<!-- pedagogy-skip -->` opt-out comment exempts the next
#     imperative line
IMPERATIVE_RX = re.compile(
    r"^(?P<indent>\s*[-*]?\s*).*?\b("
    r"MUST NOT|MUST|DO NOT|NEVER|FORBIDDEN|SHALL NOT|ALWAYS|REQUIRED"
    r")\b",
    re.MULTILINE,  # NOT IGNORECASE — uppercase only
)

# Plan ARIA-V5 §3e v2 R4 — severity-tag style imperatives common in
# product-audit + frontend-expert agents. ``= CRITICAL`` / ``= HIGH``
# imperatives also require narrative pairing for Tier-2/Tier-3.
SEVERITY_TAG_RX = re.compile(
    r"=\s*(CRITICAL|HIGH)\b",
    re.MULTILINE,
)

NARRATIVE_RX = re.compile(
    r"\*\*("
    # V5 colon-terminated headers (operator-canonical shape).
    r"Why|Consequence|Example|Rationale|"
    # V4 period-terminated narrative blocks (Plan ARIA-V4 §2b
    # `**Rule.** / **The temptation.** / **Why it looks correct.** /
    # **The downstream consequence.** / **The correct path.**`).
    # The lint accepts BOTH shapes since V4 narrative is
    # architecturally equivalent to V5 — same SSoT, different
    # punctuation. Pre-V5 forcing a regex-rewrite of 9 V4 agents
    # would be churn without semantic value.
    r"Rule|The temptation|Why it looks correct|"
    r"The downstream consequence|The correct path"
    # Accept the marker punctuation INSIDE the bold (`**Why:**` / `**Rule.**` —
    # the V5 operator-canonical shape, what `narrative_prompt_validator.py`
    # expects, and what THIS lint's own remediation string prescribes) OR
    # OUTSIDE (`**Why**:` — legacy). Pre-fix only the outside form matched, so
    # the matcher contradicted its own guidance + the V4 validator (the
    # internal-inconsistency bug fixed in Phase 0).
    r")(?:[:.]\*\*|\*\*\s*[:.])\s*\S",
    re.MULTILINE,
)

# V4 patterns that satisfy the Tier-3 Example requirement (operator
# 'orneklerle' plural-mandatory). The V4 `**The correct path.**` block
# routinely shows the right pattern via code-block or inline example;
# we accept it as a structurally-equivalent Example marker.
EXAMPLE_EQUIVALENT_RX = re.compile(
    # Same inside-OR-outside punctuation acceptance as NARRATIVE_RX (Phase 0).
    r"\*\*(Example|The correct path)(?:[:.]\*\*|\*\*\s*[:.])\s*\S",
    re.MULTILINE,
)

# Fenced code block detection (multi-line)
FENCED_CODE_BLOCK_OPEN_RX = re.compile(r"^```", re.MULTILINE)

# Frontmatter block (between --- markers at top of file)
FRONTMATTER_RX = re.compile(
    r"\A---\n.*?\n---\n",
    re.DOTALL,
)

# Opt-out comment
PEDAGOGY_SKIP_TAG = "<!-- pedagogy-skip -->"

# Plan ARIA-V5 §3e v2 — per-tier pairing requirements.
TIER_REQUIRES_EXAMPLE = {3}  # Tier-3: Example/code-block mandatory
TIER_REQUIRES_NARRATIVE = {2, 3}  # Tier-2 + Tier-3 need pairing
TIER_IMPERATIVE_ONLY = {1}  # Tier-1: bare imperative allowed

# Plan ARIA-V5 §3e v2 R-P4 — allowlist expiry in days from entry date.
ALLOWLIST_EXPIRY_DAYS = 30

# Shared shards under .claude/agents/_shared are included by the agent
# loader via explicit references. They are contract fragments, not
# invokable agents, so the universal agent frontmatter lint skips them.
NON_AGENT_FRAGMENT_DIRS = frozenset({"_shared"})


@dataclass
class Violation:
    """A pedagogy-lint violation."""

    agent_file: str
    line_number: int
    line_content: str
    imperative_kind: str  # "lexeme" or "severity_tag"
    tier: int | None
    reason: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "agent_file": self.agent_file,
            "line_number": self.line_number,
            "line_content": self.line_content[:120],
            "imperative_kind": self.imperative_kind,
            "tier": self.tier,
            "reason": self.reason,
        }


@dataclass
class LintReport:
    """Aggregate report from a pedagogy-lint scan."""

    violations: list[Violation] = field(default_factory=list)
    agents_scanned: int = 0
    agents_compliant: int = 0
    agents_allowlisted: int = 0

    @property
    def violation_count(self) -> int:
        return len(self.violations)

    @property
    def lint_pass_rate(self) -> float:
        if self.agents_scanned == 0:
            return 1.0
        return (self.agents_compliant + self.agents_allowlisted) / self.agents_scanned

    def to_dict(self) -> dict[str, Any]:
        return {
            "violation_count": self.violation_count,
            "agents_scanned": self.agents_scanned,
            "agents_compliant": self.agents_compliant,
            "agents_allowlisted": self.agents_allowlisted,
            "lint_pass_rate": self.lint_pass_rate,
            "violations": [v.to_dict() for v in self.violations],
        }


def is_agent_markdown_file(path: Path, agents_dir: Path) -> bool:
    """Return True for invokable agent markdown files.

    ``agents_dir`` is the root ``.claude/agents`` directory. README
    files and shared prompt-contract fragments are not runtime agents
    and must not be counted in registry/frontmatter invariants.
    """
    if path.name == "README.md":
        return False
    try:
        rel_parts = path.relative_to(agents_dir).parts
    except ValueError:
        rel_parts = path.parts
    return not any(part in NON_AGENT_FRAGMENT_DIRS for part in rel_parts)


def _strip_frontmatter(text: str) -> tuple[str, int]:
    """Plan ARIA-V5 §3e v2 R4 — return (body, frontmatter_line_count).

    The lint MUST NOT scan frontmatter for imperatives (YAML keys
    like ``model: required`` would false-positive). Return the body
    with the frontmatter stripped, plus the number of lines the
    frontmatter occupied so line numbers can be re-offset.
    """
    match = FRONTMATTER_RX.match(text)
    if not match:
        return text, 0
    fm = match.group(0)
    body = text[len(fm):]
    return body, fm.count("\n")


def _find_fenced_code_ranges(body: str) -> list[tuple[int, int]]:
    """Plan ARIA-V5 §3e v2 R4 — return (start_line, end_line) tuples
    for every fenced code block. Imperatives inside fences are
    EXEMPT from pairing because they're literal examples.
    """
    ranges: list[tuple[int, int]] = []
    lines = body.split("\n")
    in_block = False
    block_start = 0
    for i, line in enumerate(lines):
        if line.startswith("```"):
            if not in_block:
                in_block = True
                block_start = i
            else:
                in_block = False
                ranges.append((block_start, i))
    return ranges


def _line_in_ranges(line_number: int, ranges: list[tuple[int, int]]) -> bool:
    """Return True if ``line_number`` (0-indexed) is inside any range."""
    return any(start <= line_number <= end for start, end in ranges)


def _has_skip_tag_above(lines: list[str], line_idx: int, lookback: int = 2) -> bool:
    """Plan ARIA-V5 §3e v2 R4 — `<!-- pedagogy-skip -->` opt-out.

    Check if any of the ``lookback`` lines immediately above the
    imperative carry the skip tag. Returns True if the imperative
    is opted-out.
    """
    for i in range(max(0, line_idx - lookback), line_idx):
        if PEDAGOGY_SKIP_TAG in lines[i]:
            return True
    return False


def _narrative_within_window(
    lines: list[str],
    imperative_line_idx: int,
    window: int = 6,
) -> tuple[bool, bool]:
    """Plan ARIA-V5 §3e v2 — check for narrative pairing within
    ``window`` lines below the imperative.

    Returns (has_any_narrative, has_example_or_code_block):
      * has_any_narrative — True if **Why:**, **Consequence:**,
        **Example:**, or **Rationale:** is found OR a fenced code
        block opens within the window.
      * has_example_or_code_block — True specifically if
        **Example:** OR a fenced code block opens within the
        window (required for Tier-3 per operator "orneklerle"
        plural-mandatory).
    """
    end = min(len(lines), imperative_line_idx + 1 + window)
    has_any = False
    has_example = False
    for i in range(imperative_line_idx + 1, end):
        line = lines[i]
        if line.startswith("```"):
            has_any = True
            has_example = True
            continue
        nm = NARRATIVE_RX.search(line)
        if nm:
            has_any = True
        em = EXAMPLE_EQUIVALENT_RX.search(line)
        if em:
            has_example = True
    return has_any, has_example


def _parse_tier_from_frontmatter(text: str) -> int | None:
    """Read ``pedagogy-tier: N`` from YAML frontmatter."""
    match = FRONTMATTER_RX.match(text)
    if not match:
        return None
    fm = match.group(0)
    tier_match = re.search(r"^pedagogy-tier:\s*([123])\s*$", fm, re.MULTILINE)
    if not tier_match:
        return None
    return int(tier_match.group(1))


def lint_agent_file(
    path: Path,
    allowlist: set[str] | None = None,
) -> tuple[list[Violation], bool]:
    """Plan ARIA-V5 §3e v2 — lint one agent file.

    Returns (violations, was_allowlisted). When the agent file path
    (relative to repo root) is in the allowlist, returns empty
    violations + was_allowlisted=True.
    """
    text = path.read_text(encoding="utf-8")
    tier = _parse_tier_from_frontmatter(text)

    if allowlist is not None and str(path) in allowlist:
        return [], True

    if tier is None:
        return [
            Violation(
                agent_file=str(path),
                line_number=1,
                line_content=text.splitlines()[0] if text else "",
                imperative_kind="missing_tier",
                tier=None,
                reason="Plan ARIA-V5 §3e — agent file MUST declare `pedagogy-tier: N` (N ∈ {1,2,3}) in YAML frontmatter.",
            ),
        ], False

    if tier in TIER_IMPERATIVE_ONLY:
        # Tier-1 — bare imperatives allowed; no narrative required.
        return [], False

    body, fm_offset = _strip_frontmatter(text)
    body_lines = body.split("\n")
    fence_ranges = _find_fenced_code_ranges(body)

    violations: list[Violation] = []
    for line_idx, line in enumerate(body_lines):
        if _line_in_ranges(line_idx, fence_ranges):
            continue
        if _has_skip_tag_above(body_lines, line_idx):
            continue
        m_imp = IMPERATIVE_RX.search(line)
        m_sev = SEVERITY_TAG_RX.search(line)
        if not m_imp and not m_sev:
            continue
        has_narrative, has_example = _narrative_within_window(
            body_lines, line_idx,
        )
        absolute_line = line_idx + fm_offset + 1
        if tier in TIER_REQUIRES_EXAMPLE and not has_example:
            violations.append(
                Violation(
                    agent_file=str(path),
                    line_number=absolute_line,
                    line_content=line.strip(),
                    imperative_kind="lexeme" if m_imp else "severity_tag",
                    tier=tier,
                    reason=(
                        f"Plan ARIA-V5 §3e v2 R2 — Tier-3 agent prohibition "
                        f"MUST have **Example:** or fenced code block within "
                        f"6 lines (operator 'orneklerle' plural-mandatory)."
                    ),
                ),
            )
            continue
        if tier in TIER_REQUIRES_NARRATIVE and not has_narrative:
            violations.append(
                Violation(
                    agent_file=str(path),
                    line_number=absolute_line,
                    line_content=line.strip(),
                    imperative_kind="lexeme" if m_imp else "severity_tag",
                    tier=tier,
                    reason=(
                        f"Plan ARIA-V5 §3e v2 — Tier-{tier} agent prohibition "
                        f"MUST be paired with **Why:** / **Consequence:** / "
                        f"**Example:** narrative within 6 lines."
                    ),
                ),
            )
    return violations, False


def load_allowlist(allowlist_path: Path) -> dict[str, dict[str, Any]]:
    """Plan ARIA-V5 §3e v2 R-P4 — load grandfather allowlist.

    Schema:
      {
        "entries": {
          "<repo-relative-agent-path>": {
            "reason": "<text>",
            "added_at": "<ISO-8601 date>",
            "file_mtime_at_entry": <epoch seconds>
          }
        }
      }

    Expired entries (added_at + 30 days < now) are filtered out so
    the lint goes red on long-standing exemptions regardless.
    """
    if not allowlist_path.exists():
        return {}
    data = json.loads(allowlist_path.read_text(encoding="utf-8"))
    entries = data.get("entries", {})
    now = datetime.now(timezone.utc)
    valid: dict[str, dict[str, Any]] = {}
    for path_str, entry in entries.items():
        added_at_str = entry.get("added_at", "")
        try:
            added_at = datetime.fromisoformat(added_at_str.replace("Z", "+00:00"))
        except ValueError:
            continue
        if added_at + timedelta(days=ALLOWLIST_EXPIRY_DAYS) >= now:
            valid[path_str] = entry
    return valid


def run_pedagogy_lint(
    agents_dir: Path,
    allowlist_path: Path | None = None,
    strict: bool = False,
) -> LintReport:
    """Plan ARIA-V5 §3e v2 — entry point for the lint scan.

    Walks all ``*.md`` files under ``agents_dir`` (skip READMEs),
    lints each, accumulates a LintReport. ``strict=False`` (warn
    mode, C4 default) tolerates violations as long as the agent
    is on the allowlist. ``strict=True`` (C5 hard mode) ignores
    the allowlist — violations are fatal regardless.
    """
    allowlist_set: set[str] = set()
    if allowlist_path is not None and not strict:
        allowlist_data = load_allowlist(allowlist_path)
        allowlist_set = set(allowlist_data.keys())

    report = LintReport()
    agent_files = sorted(
        p for p in agents_dir.rglob("*.md")
        if is_agent_markdown_file(p, agents_dir)
    )
    for path in agent_files:
        report.agents_scanned += 1
        rel_path = str(path.relative_to(agents_dir.parent.parent))
        path_violations, was_allowlisted = lint_agent_file(
            path,
            allowlist=allowlist_set if not strict else None,
        )
        # Re-check with relative path for allowlist matching
        if not strict and rel_path in allowlist_set:
            was_allowlisted = True
            path_violations = []
        if was_allowlisted:
            report.agents_allowlisted += 1
        elif not path_violations:
            report.agents_compliant += 1
        else:
            report.violations.extend(path_violations)
    return report


def main(argv: list[str] | None = None) -> int:
    """Plan ARIA-V5 §3e v2 — CLI entry point.

    Usage:
      python -m aria_kernel.pedagogy_lint [--agents-dir PATH] \\
          [--allowlist PATH] [--strict] [--format json|text]

    Exit codes:
      0 — clean (or all violations allowlisted in warn mode)
      1 — violations present (strict mode OR violations outside allowlist)
    """
    import argparse
    parser = argparse.ArgumentParser(prog="aria-kernel pedagogy-lint")
    parser.add_argument(
        "--agents-dir",
        default=".claude/agents",
        help="Directory containing agent .md files (default: .claude/agents)",
    )
    parser.add_argument(
        "--allowlist",
        default="tests/invariants/agent-pedagogy.allowlist.json",
        help="Path to grandfather allowlist JSON",
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help="Ignore allowlist; violations are fatal regardless (C5 mode)",
    )
    parser.add_argument(
        "--format",
        choices=["json", "text"],
        default="text",
        help="Output format (default: text)",
    )
    args = parser.parse_args(argv)

    agents_dir = Path(args.agents_dir).resolve()
    allowlist_path = Path(args.allowlist).resolve() if args.allowlist else None
    report = run_pedagogy_lint(
        agents_dir=agents_dir,
        allowlist_path=allowlist_path,
        strict=args.strict,
    )

    if args.format == "json":
        print(json.dumps(report.to_dict(), indent=2, sort_keys=True))
    else:
        print(f"Plan ARIA-V5 §3e pedagogy lint report")
        print(f"  agents_scanned     : {report.agents_scanned}")
        print(f"  agents_compliant   : {report.agents_compliant}")
        print(f"  agents_allowlisted : {report.agents_allowlisted}")
        print(f"  violation_count    : {report.violation_count}")
        print(f"  lint_pass_rate     : {report.lint_pass_rate:.2%}")
        if report.violations:
            print("\n  Violations:")
            for v in report.violations[:20]:
                print(f"    {v.agent_file}:{v.line_number} — {v.reason}")
            if len(report.violations) > 20:
                print(f"    ...and {len(report.violations) - 20} more")

    return 0 if report.violation_count == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
