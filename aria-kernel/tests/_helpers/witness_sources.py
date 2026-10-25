"""The repository files the plan-coverage witness needs to run in a fixture repo.

In production the kernel runs ``tools/gates/plan-coverage-witness.ts`` inside a
full checkout (``aria_kernel.plan_coverage.compute_plan_coverage``), so every
module it imports is there. The native fixtures copy the witness into a small
repository instead; a fixture that copied only the witness file broke the
moment the witness imported a sibling module (tools/gates/nats-services.ts,
ARIA-MEDIUM-314). The closure is derived from the witness's own relative
imports, so the fixtures follow the witness without a hand-kept list.

The registry CLI (``aria_kernel.report_ingestion.run_registry_cli``) is the
second kernel-run tool with a native fixture. Its input set — the closure, its
tsconfig and the data files it reads — is named once here: the kernel surface
test requires exactly this set on the surface, and the projection fixture
copies exactly this set, so the fixture cannot read a file the surface does not
name (the suite job's read tracer, ARIA-HIGH-602, fails such a read).
"""

from __future__ import annotations

import re
from pathlib import Path

from aria_kernel import report_ingestion
from aria_kernel.plan_coverage import WITNESS_RELPATH, WITNESS_TSCONFIG

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


def tool_closure_paths(*entries: str, repo_root: Path = REPO_ROOT) -> tuple[str, ...]:
    """The given TypeScript entries and every file they import relatively, transitively; repo-relative, sorted.

    One closure walk serves every native fixture that copies a kernel-run tool into a small
    repository: the plan-coverage witness and the two code-fact bridge entries (SE-3).
    """
    seen: set[Path] = set()
    pending = [(repo_root / entry).resolve() for entry in entries]
    while pending:
        current = pending.pop()
        if current in seen:
            continue
        seen.add(current)
        for match in _RELATIVE_SPECIFIER.finditer(current.read_text(encoding="utf-8")):
            pending.append(_resolve(current, match.group(2)))
    return tuple(sorted(path.relative_to(repo_root.resolve()).as_posix() for path in seen))


def witness_tool_paths(repo_root: Path = REPO_ROOT) -> tuple[str, ...]:
    """The witness, its tsconfig and every file it imports relatively, transitively; repo-relative."""
    ordered = list(tool_closure_paths(WITNESS_RELPATH, repo_root=repo_root))
    ordered.remove(WITNESS_RELPATH)
    return (WITNESS_RELPATH, WITNESS_TSCONFIG, *ordered)


# The data the registry CLI reads on every kernel call beside its code: the row
# contract a derived row is held to and the alias sidecar a trailer's name
# resolves through. No import names them, so they are listed here; each must
# still be named by the CLI's own sources (test_kernel_surface pins that), so
# the list cannot outlive the read.
REGISTRY_CLI_DATA = (
    "docs/reviews/_registry/findings.jsonl.schema.json",
    "docs/reviews/_registry/finding-id-aliases.yaml",
)


def registry_cli_tool_paths(repo_root: Path = REPO_ROOT) -> tuple[str, ...]:
    """The registry CLI, every file it imports relatively, transitively, and its tsconfig; repo-relative."""
    return (
        *tool_closure_paths(report_ingestion._REGISTRY_CLI, repo_root=repo_root),
        report_ingestion._GATES_TSCONFIG,
    )
