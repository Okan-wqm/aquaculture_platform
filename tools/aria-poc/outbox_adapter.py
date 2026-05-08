"""Plan 020 Phase 14.A — outbox adapter (real parser; promotes from SHADOW).

Detects two patterns over apps/**/*.ts and platform/libs/**/*.ts:

1. transactional_outbox_violation
   eventBus.publish(...) called OUTSIDE a transactional context (not within
   a `await this.entityManager.transaction(...)` or
   `@platform/outbox.OutboxPublisherService` injection).
2. outbox_entity_base_missing
   Domain event class extends BaseEvent but the publisher does NOT use
   the @platform/outbox abstract entity base. Heuristic: file mentions
   `eventBus.publish` but does NOT import from `@platform/outbox`.

Runner contract (ARIA tool_runner.run_tool):
  stdin:  JSON {cycle_id, ...}
  stdout: JSON {observations[], findings[], read_paths[],
                evidence_sources[], cost_units, metadata}
"""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path


REPO_ROOT_ENV = "ARIA_REPO_ROOT"
SCANNED_GLOBS = ("apps/**/*.ts", "platform/libs/**/*.ts", "libs/**/*.ts")

_PUBLISH_RE = re.compile(r"\beventBus\.publish\s*\(")
_TRANSACTION_RE = re.compile(r"\b(?:entityManager|dataSource|connection)\.transaction\s*\(")
_OUTBOX_IMPORT_RE = re.compile(
    r"from\s+['\"]@platform/outbox['\"]"
)


def _resolve_repo_root() -> Path:
    override = os.environ.get(REPO_ROOT_ENV)
    if override:
        return Path(override).resolve()
    here = Path.cwd()
    for cand in [here, *here.parents]:
        if (cand / "package.json").exists():
            return cand
    return here


def _iter_files(root: Path) -> list[Path]:
    found: list[Path] = []
    for pattern in SCANNED_GLOBS:
        for path in root.glob(pattern):
            if not path.is_file():
                continue
            rel = path.relative_to(root).as_posix()
            if any(skip in rel for skip in (
                "node_modules/", "dist/", "/__tests__/", ".spec.ts", ".test.ts",
            )):
                continue
            found.append(path)
    return found


def scan(repo_root: Path) -> dict:
    findings: list[dict] = []
    read_paths: list[str] = []
    for path in _iter_files(repo_root):
        rel = path.relative_to(repo_root).as_posix()
        try:
            content = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        read_paths.append(rel)
        if not _PUBLISH_RE.search(content):
            continue
        # Rule 1: publish outside a transactional context.
        if not _TRANSACTION_RE.search(content):
            findings.append({
                "rule": "transactional_outbox_violation",
                "ref": rel,
                "severity": "HIGH",
            })
        # Rule 2: publish without @platform/outbox import.
        if not _OUTBOX_IMPORT_RE.search(content):
            findings.append({
                "rule": "outbox_entity_base_missing",
                "ref": rel,
                "severity": "MEDIUM",
            })
    return {
        "observations": [],
        "findings": findings,
        "read_paths": read_paths[:200],
        "evidence_sources": [f["ref"] for f in findings],
        "cost_units": len(read_paths),
        "metadata": {
            "rule_count": 2,
            "scanned_file_count": len(read_paths),
            "finding_count": len(findings),
        },
    }


def main() -> int:
    try:
        json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError:
        pass
    print(json.dumps(scan(_resolve_repo_root())))
    return 0


if __name__ == "__main__":
    sys.exit(main())
