"""The repository files the plan-coverage witness needs to run in a fixture repo.

In production the kernel runs ``tools/gates/plan-coverage-witness.ts`` inside a
full checkout (``aria_kernel.plan_coverage.compute_plan_coverage``), so every
module it imports is there. The native fixtures copy the witness into a small
repository instead; a fixture that copied only the witness file broke the
moment the witness imported a sibling module (tools/gates/nats-services.ts,
ARIA-MEDIUM-314). The closure is derived from the witness's own relative
imports, so the fixtures follow the witness without a hand-kept list.
"""

from __future__ import annotations

import re
from pathlib import Path

from aria_kernel.plan_coverage import EVENT_FACTS_RELPATH, MODULE_FACTS_RELPATH, WITNESS_RELPATH, WITNESS_TSCONFIG

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


def plan_coverage_tool_paths(repo_root: Path = REPO_ROOT) -> tuple[str, ...]:
    """Every repository source a plan-coverage run executes, repo-relative, the witness first: the
    witness and the two code-fact entries (SE-4: the closure the witness consumes is computed over
    their facts), their tsconfig and every file they import relatively, transitively."""
    ordered = list(tool_closure_paths(WITNESS_RELPATH, EVENT_FACTS_RELPATH, MODULE_FACTS_RELPATH, repo_root=repo_root))
    ordered.remove(WITNESS_RELPATH)
    return (WITNESS_RELPATH, WITNESS_TSCONFIG, *ordered)


NATS_SCHEMA_RELPATH = "infrastructure/nats/services.schema.json"


def plan_coverage_ssot_files(application: str, schema: str) -> dict[str, str]:
    """The smallest single-application SSoT inputs the code-fact entries read in a fixture tree:
    services.yaml (with the schema's grant minimums, validated against the repository's own
    schema), one MODULE_SCHEMAS module and its SCHEMA_REGISTRY owner."""
    identity = application.replace("-", "_")
    return {
        NATS_SCHEMA_RELPATH: (REPO_ROOT / NATS_SCHEMA_RELPATH).read_text(encoding="utf-8"),
        "infrastructure/nats/services.yaml": "\n".join([
            "version: 1", "services:", f"  - name: {identity}", f"    application: {application}",
            f"    description: fixture identity of {identity}",
            "    publish:", "      - $JS.API.>", "      - $JS.ACK.>", "      - _INBOX.>",
            "    subscribe:", "      - $JS.API.>", f"      - _INBOX{identity.upper()}.>", "",
        ]),
        "libs/backend-common/src/database/schema-manager.service.ts": (
            f"export const MODULE_SCHEMAS = [\n  {{ moduleName: '{schema}', sourceSchema: '{schema}', "
            f"infrastructureTables: [], tables: ['{schema}_fixture'] }},\n];\n"
            "export const TENANT_SCOPED_MODULES: ReadonlySet<string> = new Set([]);\n"
        ),
        "apps/db-migrate/src/schema-registry.ts": (
            f"export const SCHEMA_REGISTRY = [\n  {{ service: '{application}', schema: '{schema}', "
            "migrationsGlob: [], reason: 'fixture' },\n];\n"
        ),
    }
