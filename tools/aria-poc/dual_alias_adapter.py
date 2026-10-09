"""ARIA-MEDIUM-378 — dual-alias adapter (real parser; replaces the shim row).

``libs/backend-common`` is published under two module aliases,
``@aquaculture/backend-common`` (primary) and ``@platform/backend-common``
(CLAUDE.md "Platform & Shared Libs"). Every module-resolution surface that
maps one root alias has to map the other to the same entrypoint, or an
importer using the alias that surface lacks fails to resolve there (or,
worse, resolves to a different copy of the library).

Rules over every ``tsconfig*.json`` ``paths`` block and every
``jest.config.*`` ``moduleNameMapper``:

1. dual_alias_missing (MEDIUM)
   The surface maps one root alias and not the other.
2. dual_alias_target_drift (HIGH)
   The surface maps both root aliases, to different targets.

Only the ROOT aliases are compared. Sub-path aliases
(``@aquaculture/backend-common/auth``) exist for the primary alias alone by
design and are not drift.

Runner contract (ARIA tool_runner.run_tool):
    stdin:  JSON {cycle_id, repo_snapshot{allowed_paths: [...]}, ...}
    stdout: JSON {observations[], findings[], read_paths[],
                  evidence_sources[], cost_units, metadata}
Through the kernel the adapter reads exactly ``repo_snapshot.allowed_paths``
(pre-filtered to ``tools/aria-adapters/dual-alias-adapter.tool.json``'s
``allowed_read_globs``); a direct run lists the same surfaces from git.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Iterable


REPO_ROOT_ENV = "ARIA_REPO_ROOT"
ALIASES: tuple[str, str] = ("@aquaculture/backend-common", "@platform/backend-common")
# Mirrors the manifest's allowed_read_globs, for a direct (non-kernel) run.
SURFACE_PATHSPECS: tuple[str, ...] = (
    "**/tsconfig*.json",
    "tsconfig*.json",
    "**/jest.config.*",
    "jest.config.*",
)
_SKIP_SUBSTRINGS = ("node_modules/", "dist/")

_ALIAS_ALT = "|".join(re.escape(alias) for alias in ALIASES)
# tsconfig ``"paths"``: "<alias>": ["<target>", ...] — the closing quote right
# after the alias keeps sub-path keys (``<alias>/auth``, ``<alias>/*``) out.
_TSCONFIG_RE = re.compile(rf'"({_ALIAS_ALT})"\s*:\s*\[\s*"([^"]+)"')
# jest ``moduleNameMapper``: '^<alias>$': '<target>'.
_JEST_RE = re.compile(rf"""['"]\^({_ALIAS_ALT})\$['"]\s*:\s*['"]([^'"]+)['"]""")


def _resolve_repo_root() -> Path:
    override = os.environ.get(REPO_ROOT_ENV)
    if override:
        return Path(override).resolve()
    here = Path.cwd()
    for cand in [here, *here.parents]:
        if (cand / "package.json").exists():
            return cand
    return here


def _is_surface(rel: str) -> bool:
    name = rel.rsplit("/", 1)[-1]
    if any(skip in rel for skip in _SKIP_SUBSTRINGS):
        return False
    return (name.startswith("tsconfig") and name.endswith(".json")) or name.startswith("jest.config.")


def _surface_paths(root: Path, allowed_paths: Iterable[str] | None) -> list[str]:
    if allowed_paths is None:
        listed = subprocess.run(
            ["git", "-C", str(root), "ls-files", "--", *SURFACE_PATHSPECS],
            capture_output=True, text=True, check=False,
        ).stdout.splitlines()
        allowed_paths = listed
    return sorted({rel for rel in allowed_paths if isinstance(rel, str) and _is_surface(rel)})


def _finding(rule: str, severity: str, rel: str, *, line: int, message: str) -> dict:
    return {
        "id": f"{rule}:{rel}:{line}",
        "rule": rule,
        "severity": severity,
        "path": rel,
        "line": line,
        "message": message,
        "evidence": [{"path": rel, "line": line}],
    }


def _mappings(content: str, pattern: re.Pattern[str]) -> dict[str, tuple[str, int]]:
    """alias -> (target, 1-based line of its first mapping)."""
    found: dict[str, tuple[str, int]] = {}
    for match in pattern.finditer(content):
        alias, target = match.group(1), match.group(2)
        if alias not in found:
            found[alias] = (target, content[: match.start()].count("\n") + 1)
    return found


def _check(rel: str, content: str) -> list[dict]:
    pattern = _JEST_RE if rel.rsplit("/", 1)[-1].startswith("jest.config.") else _TSCONFIG_RE
    mapped = _mappings(content, pattern)
    if not mapped:
        return []
    primary, secondary = ALIASES
    if len(mapped) == 1:
        (alias, (_target, line)), = mapped.items()
        other = secondary if alias == primary else primary
        return [_finding(
            "dual_alias_missing", "MEDIUM", rel, line=line,
            message=f"{alias} is mapped here and {other} is not",
        )]
    (target_a, line_a), (target_b, _line_b) = mapped[primary], mapped[secondary]
    if target_a != target_b:
        return [_finding(
            "dual_alias_target_drift", "HIGH", rel, line=line_a,
            message=f"{primary} -> {target_a} but {secondary} -> {target_b}",
        )]
    return []


def scan(repo_root: Path, allowed_paths: Iterable[str] | None = None) -> dict:
    findings: list[dict] = []
    read_paths: list[str] = []
    unreadable: list[str] = []
    for rel in _surface_paths(repo_root, allowed_paths):
        path = repo_root / rel
        if not path.is_file():
            continue
        try:
            content = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            unreadable.append(rel)
            continue
        read_paths.append(rel)
        findings.extend(_check(rel, content))
    envelope = {
        "observations": [],
        "findings": findings,
        "read_paths": read_paths,
        "evidence_sources": sorted({f["path"] for f in findings}),
        "cost_units": len(read_paths),
        "metadata": {
            "rule_count": 2,
            "scanned_file_count": len(read_paths),
            "finding_count": len(findings),
        },
    }
    if unreadable:
        # A surface that could not be read leaves a hole in the verdict; a
        # clean result over a partial scan would be a fail-open.
        envelope["status"] = "incomplete"
        envelope["metadata"]["unreadable_paths"] = unreadable[:50]
    return envelope


def _allowed_paths_from_stdin(payload: object) -> list[str] | None:
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
