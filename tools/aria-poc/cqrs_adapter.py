"""Plan 020 Phase 14.B — cqrs adapter (real parser; promotes from SHADOW).

Detects two patterns over apps/**/controllers/**/*.ts:

1. controller_skips_command_query_bus
   Controller method body directly invokes a Repository / DataSource /
   EntityManager method (find/save/findOne) WITHOUT going through
   CommandBus.execute(...) or QueryBus.execute(...). Violates CLAUDE.md
   inviolable rule #1: Controller → Service → Command/Query Bus →
   Handler → Repository.
2. controller_injects_repository_directly
   Controller constructor parameter has @InjectRepository(...) decorator
   OR `Repository<...>` typed parameter — same architectural violation
   surfaced at the DI layer.

Runner contract: ARIA tool_runner.run_tool envelope.
"""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path


REPO_ROOT_ENV = "ARIA_REPO_ROOT"
SCANNED_GLOBS = ("apps/**/controllers/**/*.ts",)

_REPO_TYPE_REFERENCE_RE = re.compile(
    r"\b(?:Repository|DataSource|EntityManager)\b"
)
_TYPEORM_METHOD_CALL_RE = re.compile(
    r"this\.\w+\.(find|save|findOne|findOneBy|update|delete|insert|softDelete)\s*\("
)
_INJECT_REPOSITORY_RE = re.compile(
    r"@InjectRepository\s*\(|Repository\s*<\s*\w+\s*>"
)
_BUS_CALL_RE = re.compile(r"\b(?:CommandBus|QueryBus)\.execute\s*\(")


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
                "node_modules/", "dist/", "/__tests__/", ".spec.ts",
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
        # Rule 1: file imports Repository/DataSource/EntityManager AND
        # invokes a TypeORM method on this.<x> WITHOUT going through
        # CommandBus/QueryBus.execute(). Two-signal detection avoids
        # false positives on controllers that only TYPE-reference
        # Repository for parameter shapes.
        if (_REPO_TYPE_REFERENCE_RE.search(content)
                and _TYPEORM_METHOD_CALL_RE.search(content)
                and not _BUS_CALL_RE.search(content)):
            findings.append({
                "rule": "controller_skips_command_query_bus",
                "ref": rel,
                "severity": "HIGH",
            })
        # Rule 2: @InjectRepository or Repository<T> in constructor.
        if _INJECT_REPOSITORY_RE.search(content):
            findings.append({
                "rule": "controller_injects_repository_directly",
                "ref": rel,
                "severity": "HIGH",
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
