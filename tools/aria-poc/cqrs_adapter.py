"""Plan 020 Phase 14.B — cqrs adapter (real parser; promotes from SHADOW).

Detects two patterns over apps/**/controllers/**/*.ts and apps/**/*.controller.ts:

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

Runner contract: ARIA tool_runner.run_tool envelope. Through the kernel the
adapter reads exactly ``repo_snapshot.allowed_paths`` (pre-filtered to the
manifest's ``allowed_read_globs``); a direct CLI run falls back to
``SCANNED_GLOBS``, which mirror the manifest
(``tools/aria-adapters/cqrs-adapter.tool.json``).
"""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path
from typing import Iterable


REPO_ROOT_ENV = "ARIA_REPO_ROOT"
# ARIA-MEDIUM-378 — `*.controller.ts` as well: 40 tracked controllers live
# outside a `controllers/` directory and the first glob alone never read them.
SCANNED_GLOBS = ("apps/**/controllers/**/*.ts", "apps/**/*.controller.ts")

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


_SKIP_SUBSTRINGS = ("node_modules/", "dist/", "/__tests__/", ".spec.ts")


def _line_of(content: str, pattern: re.Pattern[str]) -> int | None:
    match = pattern.search(content)
    return None if match is None else content[: match.start()].count("\n") + 1


def _finding(rule: str, severity: str, rel: str, *, line: int | None, message: str) -> dict:
    """The kernel's evidence contract (``evidence_validator``): id, path,
    line and a per-finding ``evidence`` list. ARIA-MEDIUM-378 — the former
    ``{"rule", "ref", "severity"}`` row carried no ``evidence`` and would
    have been ``evidence_error`` on its first real run (ARIA-HIGH-098)."""
    location = rel if line is None else f"{rel}:{line}"
    finding: dict = {
        "id": f"{rule}:{location}",
        "rule": rule,
        "severity": severity,
        "path": rel,
        "message": message,
        "evidence": [{"path": rel} if line is None else {"path": rel, "line": line}],
    }
    if line is not None:
        finding["line"] = line
    # ARIA-MEDIUM-378 — both rules describe one defect, a controller that
    # skips the service and bus layers; one subject per controller makes the
    # two findings one subject (finding_subject.adapter_subject_key), so the
    # defect is planned once and closed together.
    finding["subject"] = f"cqrs-adapter:controller_layer_skip:{rel}"
    return finding


def _resolve_repo_root() -> Path:
    override = os.environ.get(REPO_ROOT_ENV)
    if override:
        return Path(override).resolve()
    here = Path.cwd()
    for cand in [here, *here.parents]:
        if (cand / "package.json").exists():
            return cand
    return here


def _iter_files(root: Path, allowed_paths: Iterable[str] | None = None) -> list[Path]:
    """The kernel's pre-filtered ``allowed_paths`` when given, else the glob walk."""
    if allowed_paths is not None:
        candidates = [
            root / rel for rel in allowed_paths
            if isinstance(rel, str) and rel.endswith(".ts")
        ]
    else:
        candidates = sorted({path for pattern in SCANNED_GLOBS for path in root.glob(pattern)})
    found: list[Path] = []
    for path in candidates:
        if not path.is_file():
            continue
        rel = path.relative_to(root).as_posix()
        if any(skip in rel for skip in _SKIP_SUBSTRINGS):
            continue
        found.append(path)
    return found


def scan(repo_root: Path, allowed_paths: Iterable[str] | None = None) -> dict:
    findings: list[dict] = []
    read_paths: list[str] = []
    for path in _iter_files(repo_root, allowed_paths):
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
            findings.append(_finding(
                "controller_skips_command_query_bus", "HIGH", rel,
                line=_line_of(content, _TYPEORM_METHOD_CALL_RE),
                message="controller calls a TypeORM method with no CommandBus/QueryBus.execute",
            ))
        # Rule 2: @InjectRepository or Repository<T> in constructor.
        if _INJECT_REPOSITORY_RE.search(content):
            findings.append(_finding(
                "controller_injects_repository_directly", "HIGH", rel,
                line=_line_of(content, _INJECT_REPOSITORY_RE),
                message="controller injects a Repository instead of going through the bus",
            ))
    # Every file read is declared: an evidence path must be a declared read
    # path, so the former ``[:200]`` cap could contradict a finding.
    return {
        "observations": [],
        "findings": findings,
        "read_paths": sorted(read_paths),
        "evidence_sources": sorted({f["path"] for f in findings}),
        "cost_units": len(read_paths),
        "metadata": {
            "rule_count": 2,
            "scanned_file_count": len(read_paths),
            "finding_count": len(findings),
        },
    }


def _allowed_paths_from_stdin(payload: object) -> list[str] | None:
    """``repo_snapshot.allowed_paths`` from the kernel's stdin, or None for a direct run."""
    if not isinstance(payload, dict):
        return None
    snapshot = payload.get("repo_snapshot")
    if not isinstance(snapshot, dict) or not isinstance(snapshot.get("allowed_paths"), list):
        return None
    return [item for item in snapshot["allowed_paths"] if isinstance(item, str)]


def main() -> int:
    payload: object = {}
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError:
        payload = {}
    print(json.dumps(scan(_resolve_repo_root(), _allowed_paths_from_stdin(payload))))
    return 0


if __name__ == "__main__":
    sys.exit(main())
