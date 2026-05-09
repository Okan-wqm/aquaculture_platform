"""Diff-content suppression scanner (Plan 016 Faz D3).

Five fail-closed detector categories applied to CHANGED LINES of an
executor diff packet. A match blocks the apply gate unless the converged
plan explicitly intended the change as a quarantine cleanup or
test-only suppression removal with operator-approved scope.

Distinct from `ci.py.SUPPRESSION_PATTERNS`: that list scans CI failure
text (PR descriptions, build logs) for natural-language phrases like
"skip the test". This module scans the actual diff text for the exact
language constructs Plan 016 forbids in changed code lines.

Detector categories (Plan 016 §Suppression policy):

1. **test_skip** — Jest/Vitest/Playwright/JUnit skip primitives that
   silence a test without removing it. Patterns: `.skip(`, `xit(`,
   `it.skip(`, `describe.skip(`, `@Disabled`, `@DisabledIf`.
2. **ci_masking** — GitHub Actions / GitLab masking that lets failure
   pass without surfacing. Patterns: `continue-on-error: true`,
   `if: always()` paired with implicit success, workflow files renamed
   to `.disabled`.
3. **ts_masking** — TypeScript escape hatches CLAUDE.md bans.
   Patterns: `@ts-ignore`, `@ts-expect-error`, broad `as any`,
   `as unknown as`, `eslint-disable` (line or block).
4. **runtime_masking** — try/except/catch swallow patterns that hide
   runtime failures. Patterns: empty Python `except: pass`, empty
   TS/JS `catch (e) {}` or `catch {}`, JavaScript Promise `.catch(()
   => {})`.
5. **aria_suppression_honor** — diff that adds entries to ARIA
   suppression files (`aria-tools/suppressions.json` and similar)
   without an accompanying converged plan that calls them out. The
   detector flags the addition; whether it is acceptable is a
   downstream operator-policy decision.

Each detector returns a list of `Match` records the kernel writes to
governance.jsonl as `apply_blocked_by_suppression` events. The match
carries enough context (file path, line number, surrounding text)
that an operator can decide quickly whether to override.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Iterable


@dataclass(frozen=True)
class SuppressionMatch:
    category: str
    detector: str
    file: str
    line: int
    text: str


# --------- detector regexes ---------
# Each pattern matches a CHANGED LINE that introduces the construct.
# Detectors are deliberately broad — false positives are cheaper than
# missing a real suppression.

_TEST_SKIP_PATTERNS = (
    re.compile(r"\b(?:it|test|describe|context)\.skip\b"),
    re.compile(r"\bxit\("),
    re.compile(r"\bxdescribe\("),
    re.compile(r"\bxtest\("),
    re.compile(r"@Disabled(?:If)?\b"),
    re.compile(r"\.skip\("),
    re.compile(r"\.todo\("),
    # Playwright + Jest skip-on-condition.
    re.compile(r"test\.skip\("),
)

_CI_MASKING_PATTERNS = (
    re.compile(r"continue-on-error:\s*true", re.IGNORECASE),
    re.compile(r"#\s*disabled[-_ ]workflow", re.IGNORECASE),
    # Workflow renamed to .disabled extension via diff (path move).
    re.compile(r"rename to .+\.ya?ml\.disabled"),
)

_TS_MASKING_PATTERNS = (
    re.compile(r"//\s*@ts-ignore"),
    re.compile(r"//\s*@ts-expect-error"),
    # Broad `as any` — narrow casts like `as Record<string, any>` slip;
    # the trailing space / EOL / bracket forces "bare any".
    re.compile(r"\bas\s+any\b"),
    re.compile(r"\bas\s+unknown\s+as\s+"),
    re.compile(r"//\s*eslint-disable"),
    re.compile(r"/\*\s*eslint-disable"),
)

_RUNTIME_MASKING_PATTERNS = (
    # Python: `except: pass` or `except Exception: pass` on the same line.
    re.compile(r"except[^:]*:\s*pass\s*(?:#.*)?$"),
    # TS/JS empty catch — `catch (e) {}` or `catch {}` on the same line.
    re.compile(r"\bcatch\s*\([^)]*\)\s*\{\s*\}"),
    re.compile(r"\bcatch\s*\{\s*\}"),
    # Promise swallow: `.catch(() => {})` or `.catch(() => null)`.
    re.compile(r"\.catch\(\s*\([^)]*\)\s*=>\s*\{\s*\}\s*\)"),
    re.compile(r"\.catch\(\s*\([^)]*\)\s*=>\s*(?:null|undefined)\s*\)"),
)

_ARIA_SUPPRESSION_FILE_PATTERNS = (
    re.compile(r"aria-tools/suppressions\.json"),
    re.compile(r"aria-tools/.*?suppression.*?\.json"),
)


_DETECTOR_TABLE = (
    ("test_skip", _TEST_SKIP_PATTERNS),
    ("ci_masking", _CI_MASKING_PATTERNS),
    ("ts_masking", _TS_MASKING_PATTERNS),
    ("runtime_masking", _RUNTIME_MASKING_PATTERNS),
)


def scan_diff_added_lines(
    *,
    file_changes: Iterable[dict[str, object]],
) -> list[SuppressionMatch]:
    """Scan the added/modified lines of a diff packet for suppression patterns.

    `file_changes` is an iterable of `{path: str, added_lines:
    list[(int, str)]}` records — typically produced by parsing a unified
    diff. Each `added_lines` tuple is `(line_no, text)`.

    Returns a flat list of `SuppressionMatch` records. Empty list means
    the diff is suppression-clean.
    """
    matches: list[SuppressionMatch] = []
    for change in file_changes:
        path = str(change.get("path", ""))
        added = change.get("added_lines") or []
        if not isinstance(added, list):
            added = []
        # Plan 023 v3 §P-7 — parse_unified_diff now captures
        # rename/copy/+++ b metadata in a separate `metadata_lines`
        # field. Pre-fix the scanner only saw `+`-prefixed content; a
        # rename to a forbidden path (e.g. ci.yml.disabled) had no
        # content line and slipped through despite the existing
        # ci_masking detector explicitly targeting "rename to .+
        # .yml.disabled". Post-fix: scan added_lines (content) and
        # metadata_lines (path-class) separately, annotating each
        # match's `text` field with [path_metadata] or [added_line]
        # so operators distinguish them at review time.
        metadata = change.get("metadata_lines") or []
        if not isinstance(metadata, list):
            metadata = []

        for category, patterns in _DETECTOR_TABLE:
            for line_no, text in added:
                if not isinstance(text, str):
                    continue
                for pattern in patterns:
                    if pattern.search(text):
                        matches.append(
                            SuppressionMatch(
                                category=category,
                                detector=pattern.pattern,
                                file=path,
                                line=int(line_no),
                                text="[added_line] " + text.strip()[:200],
                            )
                        )
                        # One match per (category, line) — break out of the inner
                        # pattern loop so two patterns in the same category do
                        # not double-count.
                        break
            # Plan 023 v3 §P-7 — same detector pass against metadata
            # lines so rename/copy/+++ b path-class matches surface.
            for line_no, text in metadata:
                if not isinstance(text, str):
                    continue
                for pattern in patterns:
                    if pattern.search(text):
                        matches.append(
                            SuppressionMatch(
                                category=category,
                                detector=pattern.pattern,
                                file=path,
                                line=int(line_no),
                                text="[path_metadata] " + text.strip()[:200],
                            )
                        )
                        break

        # ARIA suppression-honor detector is path-based, not line-based.
        for pattern in _ARIA_SUPPRESSION_FILE_PATTERNS:
            if pattern.search(path) and added:
                matches.append(
                    SuppressionMatch(
                        category="aria_suppression_honor",
                        detector=pattern.pattern,
                        file=path,
                        line=int(added[0][0]) if added else 0,
                        text=f"diff modifies ARIA suppression registry: {path}",
                    )
                )
                break  # one ARIA-suppression match per file path is enough

    return matches


def parse_unified_diff(diff_text: str) -> list[dict[str, object]]:
    """Parse a unified diff into the file_changes shape `scan_diff_added_lines` expects.

    Why a small parser instead of pulling in `unidiff`: the kernel's
    discipline is zero new third-party dependencies on the hot path.
    The format the kernel sees is a deterministic git-produced unified
    diff, so the parser is small and bounded.

    Returns a list of `{path: str, added_lines: [(line_no, text), ...]}`.
    Deletions are ignored (they cannot introduce a suppression). Pure
    deletions and binary-file diffs are skipped.
    """
    # Plan 023 v3 §P-7 — capture rename/copy/+++ b metadata so the
    # scanner can apply ci_masking + ts_masking detectors against
    # path-class lines, not only `+`-prefixed content. Pre-fix only
    # added_lines were populated, so a rename to ci.yml.disabled had
    # nothing for the existing ci_masking pattern to match against.
    file_changes: list[dict[str, object]] = []
    current: dict[str, object] | None = None
    new_line_no = 0
    metadata_line_no = 0
    for line in diff_text.splitlines():
        # Plan 023 v3 §P-7 — `diff --git a/<old> b/<new>` opens a new
        # file_change. Pre-fix only `+++ b/` opened one; pure renames
        # (similarity 100%, no content change) had no +++ b/ line and
        # produced no file_change at all, so rename-to-banned-path
        # patterns had nothing to scan. Now we open a file_change
        # eagerly at `diff --git`, populate path from `b/<new>`, and
        # let subsequent `rename to` / `+++ b/` lines append to its
        # metadata_lines list.
        if line.startswith("diff --git "):
            metadata_line_no += 1
            # Parse `diff --git a/<old> b/<new>` to recover the new path.
            m = re.match(r"^diff --git a/(.+?) b/(.+)$", line)
            new_path = m.group(2) if m else ""
            current = {
                "path": new_path,
                "added_lines": [],
                "metadata_lines": [(metadata_line_no, line)],
            }
            file_changes.append(current)
            new_line_no = 0
            continue
        if (
            line.startswith("rename to ")
            or line.startswith("copy to ")
            or line.startswith("rename from ")
            or line.startswith("copy from ")
            or line.startswith("new file mode ")
            or line.startswith("deleted file mode ")
            or line.startswith("similarity index ")
            or line.startswith("--- ")
        ):
            if current is not None:
                metadata_line_no += 1
                assert isinstance(current["metadata_lines"], list)
                current["metadata_lines"].append((metadata_line_no, line))
            continue
        if line.startswith("+++ "):
            path = line[len("+++ "):]
            if path.startswith("b/"):
                path = path[2:]
            if path == "/dev/null":
                # File deleted — drop the current file_change (no
                # additions possible).
                if current is not None and current in file_changes:
                    file_changes.remove(current)
                current = None
                continue
            metadata_line_no += 1
            if current is not None:
                # Refine the current file_change's path from the +++ b/
                # header (canonical), and record the +++ line itself.
                current["path"] = path
                assert isinstance(current["metadata_lines"], list)
                current["metadata_lines"].append((metadata_line_no, line))
            else:
                # Legacy parser path: diff fragments without a `diff
                # --git ` line still produce a file_change starting at
                # +++ b/. Preserves Plan 016's parser semantics.
                current = {
                    "path": path,
                    "added_lines": [],
                    "metadata_lines": [(metadata_line_no, line)],
                }
                file_changes.append(current)
            new_line_no = 0
            continue
        if current is None:
            continue
        if line.startswith("@@"):
            # @@ -a,b +c,d @@
            match = re.search(r"\+(\d+)(?:,\d+)?", line)
            if match:
                new_line_no = int(match.group(1)) - 1
            continue
        if line.startswith("+") and not line.startswith("+++"):
            new_line_no += 1
            assert isinstance(current["added_lines"], list)
            current["added_lines"].append((new_line_no, line[1:]))
        elif line.startswith("-") and not line.startswith("---"):
            # Deletion: do not advance the new-file line counter.
            continue
        elif line.startswith(" "):
            new_line_no += 1
    return file_changes


def scan_unified_diff_text(diff_text: str) -> list[SuppressionMatch]:
    """Convenience: parse a unified-diff string and run the detectors in one call."""
    return scan_diff_added_lines(file_changes=parse_unified_diff(diff_text))
