"""The repository files a TypeScript tool the kernel runs needs: its import closure.

The kernel runs repository TypeScript tools inside a full checkout: the
plan-coverage witness (``aria_kernel.plan_coverage.compute_plan_coverage``)
and the finding-registry CLI (``aria_kernel.report_ingestion.run_registry_cli``).
Two things need each tool's closure, and both broke when it was hand-kept:

  * the native fixtures copy a tool into a small repository; a fixture that
    copied only the witness file broke the moment the witness imported a
    sibling module (tools/gates/nats-services.ts, ARIA-MEDIUM-314);
  * the kernel lane's PR surface must cover every file the kernel runs; the
    registry CLI's twelve modules were off it, so a PR that broke the
    projection's contract with the kernel skipped the kernel suite, passed the
    required check and turned main red on the push run (MF-1 R6).

The closure is derived from the tool's own relative imports, so both follow
the tool without a hand-kept list.
"""

from __future__ import annotations

import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]

# `import … from './x'`, `export … from '../y'`, bare `import './z'` and `require('./w')`.
_RELATIVE_SPECIFIER = re.compile(
    r"""(?:\bfrom\s*|\bimport\s*|\brequire\s*\(\s*)(['"])(\.{1,2}/[^'"]+)\1"""
)


def _resolve(importer: Path, specifier: str) -> Path:
    base = (importer.parent / specifier).resolve()
    for candidate in (base, base.with_name(base.name + ".ts"), base / "index.ts"):
        if candidate.is_file():
            return candidate
    raise AssertionError(f"{importer.relative_to(REPO_ROOT)} imports {specifier!r}, which resolves to no file")


def tool_paths(entry: str, tsconfig: str, repo_root: Path = REPO_ROOT) -> tuple[str, ...]:
    """The tool ``entry``, the ts-node project it runs under and every file it imports
    relatively, transitively; repo-relative, the entry first."""
    seen: set[Path] = set()
    pending = [(repo_root / entry).resolve()]
    while pending:
        current = pending.pop()
        if current in seen:
            continue
        seen.add(current)
        for match in _RELATIVE_SPECIFIER.finditer(current.read_text(encoding="utf-8")):
            pending.append(_resolve(current, match.group(2)))
    ordered = sorted(path.relative_to(repo_root.resolve()).as_posix() for path in seen)
    ordered.remove(entry)
    return (entry, tsconfig, *ordered)
