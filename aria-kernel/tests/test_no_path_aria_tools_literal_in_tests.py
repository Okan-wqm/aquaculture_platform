"""Plan ARIA-V2 §3.4 + I-40 + HIGH-011 — future-regression net.

Ban ``Path("aria-tools")`` constructor calls across
``aria-kernel/tests/**``. After Phase 5 the canonical
``aria-tools/`` ledger directory is gitignored; tests that resolve
it cwd-relative pick up the operator's REAL runtime state (FATES
hashes, governance.jsonl chain tip, …) and either:

  * fail with ``memory_fates_content_hash_mismatch`` against the
    operator's live cycle state, OR
  * pass while writing test-only mutations into the operator's
    live ledger (cross-test pollution).

Both modes are bug classes. Architectural fix: tests MUST hold
their own tempdir-isolated ``aria-tools/`` (or use a segment-tuple
constant like ``_SINK_PARTS``). This grep invariant is Tier-3 —
wrong behaviour is caught at CI time.

Scope of the ban:
  * ``Path("aria-tools")`` / ``Path('aria-tools')`` — UNCONDITIONAL.
    The Path constructor with a bare directory name resolves
    relative to the operator's CWD; in CI that is the repo root
    and the test then mutates real runtime state.

NOT banned (legitimate test data):
  * Bare string literals like ``"aria-tools/runs.jsonl"`` used as
    evidence_refs, scope-out fixtures, gitignore file content,
    etc. These are data values that travel through the system but
    do not perform cwd-relative resolution by themselves. Banning
    them would require an AST-aware audit, not a regex scan.
  * Comments / docstrings that mention the literal as text. Detected
    by stripping ``#``-prefixed comment tails before matching.

Allowed exceptions:
  * Files in ``_EXEMPT_FILES`` (this file, since it MUST mention
    the banned form to describe it).
  * Per-line ``# allowlist-aria-tools-literal:<reason>`` comment.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path


_REPO_ROOT = Path(__file__).resolve().parents[2]
_TESTS_DIR = _REPO_ROOT / "aria-kernel" / "tests"

# Files allowed to mention the banned literals (this file is one).
_EXEMPT_FILES: frozenset[str] = frozenset({
    "test_no_path_aria_tools_literal_in_tests.py",
})

# Plan ARIA-V2 §3.4 — only the Path() constructor form is banned.
# String literals are intent-ambiguous; we lock the unambiguous
# bug class here and rely on the tempdir-port discipline (CRITICAL-009,
# CRITICAL-010) to keep test isolation correct elsewhere.
_BANNED_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("Path(\"aria-tools\") / ...", re.compile(r'Path\(\s*["\']aria-tools["\']\s*\)')),
)

# Per-line allowlist comment recognised by the matcher.
_ALLOWLIST_TOKEN = "allowlist-aria-tools-literal:"


def _strip_comment(line: str) -> str:
    """Strip Python-style line comments AND triple-quoted line content
    that obviously functions as documentation (``#`` after the first
    non-string code) so the matcher only sees executable code.

    Heuristic, not a parser. Handles the common cases where the literal
    appears inside a single-line comment ``... # Path("aria-tools") ...``
    OR a triple-quoted docstring line. False negatives (literal hidden
    in a multi-line string) accepted in exchange for false positives
    avoided in real test files.
    """
    # Quick reject for lines that are entirely a comment.
    stripped = line.lstrip()
    if stripped.startswith("#"):
        return ""
    # Strip trailing ``  # ...`` comment when ``#`` is preceded by
    # whitespace and NOT inside a string literal. Crude — assumes no
    # ``#`` inside string literals on the same line ahead of the
    # banned token. Sufficient for the kernel test corpus.
    hash_idx = line.find("  #")
    if hash_idx == -1:
        hash_idx = line.find("\t#")
    if hash_idx != -1:
        line = line[:hash_idx]
    return line


def _scan_file(path: Path) -> list[tuple[int, str, str]]:
    """Return list of (line_no, pattern_label, line_content) hits."""
    findings: list[tuple[int, str, str]] = []
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return findings
    in_triple_quote = False
    triple_quote_marker: str | None = None
    for line_no, raw_line in enumerate(text.splitlines(), start=1):
        # Tier-3: per-line opt-out.
        if _ALLOWLIST_TOKEN in raw_line:
            continue
        # Crude triple-quote tracking — flip state on each ``"""`` /
        # ``'''`` boundary so docstring contents are skipped.
        for marker in ('"""', "'''"):
            if marker in raw_line:
                count = raw_line.count(marker)
                if not in_triple_quote:
                    if count % 2 == 1:
                        in_triple_quote = True
                        triple_quote_marker = marker
                elif marker == triple_quote_marker:
                    if count % 2 == 1:
                        in_triple_quote = False
                        triple_quote_marker = None
                break
        if in_triple_quote:
            continue
        code_line = _strip_comment(raw_line)
        if not code_line:
            continue
        for label, pat in _BANNED_PATTERNS:
            if pat.search(code_line):
                findings.append((line_no, label, raw_line.strip()))
                break
    return findings


class NoPathAriaToolsLiteralInTests(unittest.TestCase):
    def test_no_banned_literal_in_kernel_tests(self) -> None:
        if not _TESTS_DIR.exists():
            self.skipTest(f"{_TESTS_DIR} not present")

        violations: dict[str, list[tuple[int, str, str]]] = {}
        for path in sorted(_TESTS_DIR.rglob("*.py")):
            if path.name in _EXEMPT_FILES:
                continue
            hits = _scan_file(path)
            if hits:
                violations[str(path.relative_to(_REPO_ROOT))] = hits

        if violations:
            lines = [
                f"\n  {file}:"
                + "".join(
                    f"\n    line {ln}: matched {label!r} → {snippet}"
                    for (ln, label, snippet) in hits
                )
                for file, hits in violations.items()
            ]
            self.fail(
                "Plan ARIA-V2 §3.4 + I-40: banned aria-tools cwd-relative "
                "literal found in test sources. Port to tempdir or add a "
                f"# {_ALLOWLIST_TOKEN}<reason> comment on the same line."
                + "".join(lines)
            )


if __name__ == "__main__":
    unittest.main()
