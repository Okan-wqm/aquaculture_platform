"""Plan 020 Phase 14.A — outbox adapter (real parser; promotes from SHADOW).

Detects two patterns over the outbox surface area:

1. transactional_outbox_violation
   eventBus.publish(...) called OUTSIDE a transactional context (not within
   a `await this.entityManager.transaction(...)` or
   `@platform/outbox.OutboxPublisherService` injection).
2. outbox_entity_base_missing
   Domain event class extends BaseEvent but the publisher does NOT use
   the @platform/outbox abstract entity base. Heuristic: file mentions
   `eventBus.publish` but does NOT import from `@platform/outbox`.

Runner contract (ARIA tool_runner.run_tool):
  stdin:  JSON {cycle_id, repo_snapshot{allowed_paths: [...]}, ...}
  stdout: JSON {observations[], findings[], read_paths[],
                evidence_sources[], cost_units, metadata}

Scope discipline (single source of truth — Plan 022 §C-7/§C-8 follow-up):
  The manifest (`aria-tools/registry.json`, tool_id outbox-adapter) declares
  `allowed_read_globs = (apps/**/outbox/**/*.ts, platform/libs/outbox/**/*.ts)`.
  This adapter MUST NOT walk paths outside that surface; doing so produces
  scope_violation envelopes from `find_scope_violations` and quarantines
  the adapter under Plan 022 §C-5.

  Two invocation paths:

  * Through tool_runner.run_tool (production): the kernel injects
    `repo_snapshot.allowed_paths` into stdin, pre-filtered to the tool's
    declared scope via `_snapshot_for_tool`. We walk THAT list — kernel is
    the single source of truth for scope, the adapter cannot drift.
  * Direct CLI / unit tests (no stdin payload, or no `repo_snapshot`): we
    fall back to the manifest-narrow glob iteration patterns
    `_FALLBACK_SCANNED_GLOBS`. They MUST match the manifest exactly so the
    fallback path produces the same surface as the kernel-driven path.

  The pre-fix `SCANNED_GLOBS = (apps/**/*.ts, platform/libs/**/*.ts,
  libs/**/*.ts)` walked the entire backend tree, surfacing ~200 hr-service
  paths outside the outbox manifest. With kernel-side
  `find_scope_violations` correctness restored (Plan 022 §C-7/§C-8), that
  pre-fix SCANNED_GLOBS would generate a real-positive scope_violation on
  every cycle. The narrowed fallback below mirrors the manifest exactly so
  the adapter is structurally incapable of out-of-scope reads regardless
  of invocation path. SCANNED_GLOBS retained as a public alias for
  backward-compat with tests + readers; equals _FALLBACK_SCANNED_GLOBS.
"""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path
from typing import Iterable


REPO_ROOT_ENV = "ARIA_REPO_ROOT"

# Fallback iteration patterns — used ONLY when no kernel-pre-filtered
# `repo_snapshot.allowed_paths` is supplied via stdin. MUST mirror the
# manifest's `allowed_read_globs` for tool_id `outbox-adapter` exactly,
# otherwise direct-CLI runs will drift from kernel-driven runs.
#
# Source of truth: `aria-tools/registry.json` row for `outbox-adapter`,
# `allowed_read_globs` field. The invariant test
# `tools/aria-poc/test_adapter_scope_narrow.py
# ::test_outbox_adapter_scanned_globs_narrow` pins this list to the
# manifest declaration; if the manifest changes, the test fails until
# the adapter is updated.
_FALLBACK_SCANNED_GLOBS: tuple[str, ...] = (
    "apps/**/outbox/**/*.ts",
    "platform/libs/outbox/**/*.ts",
)

# Public alias retained for backward-compat with the existing test suite
# and external readers (e.g. shadow_runner). Equal to
# `_FALLBACK_SCANNED_GLOBS`; the constant exists to keep
# `outbox_adapter.SCANNED_GLOBS` resolvable as a stable read.
SCANNED_GLOBS: tuple[str, ...] = _FALLBACK_SCANNED_GLOBS

_PUBLISH_RE = re.compile(r"\beventBus\.publish\s*\(")
_TRANSACTION_RE = re.compile(r"\b(?:entityManager|dataSource|connection)\.transaction\s*\(")
_OUTBOX_IMPORT_RE = re.compile(
    r"from\s+['\"]@platform/outbox['\"]"
)

# Path prefixes / substrings that disqualify a TS file from outbox parsing
# even when it sits inside the declared scope. These are test artefacts
# and emitted artefacts, not source code worth scanning.
_SKIP_SUBSTRINGS: tuple[str, ...] = (
    "node_modules/",
    "dist/",
    "/__tests__/",
    ".spec.ts",
    ".test.ts",
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


def _is_skipped(rel: str) -> bool:
    return any(skip in rel for skip in _SKIP_SUBSTRINGS)


def _iter_files_from_globs(root: Path, patterns: Iterable[str]) -> list[Path]:
    """Walk ``root`` for every glob in ``patterns``; skip test/artefact paths.

    Used as the fallback walker when no kernel-pre-filtered
    `allowed_paths` is supplied. The patterns MUST match the manifest's
    `allowed_read_globs` (enforced by the scope-narrow invariant test).
    """
    found: list[Path] = []
    seen: set[Path] = set()
    for pattern in patterns:
        for path in root.glob(pattern):
            if not path.is_file():
                continue
            if path in seen:
                continue
            rel = path.relative_to(root).as_posix()
            if _is_skipped(rel):
                continue
            seen.add(path)
            found.append(path)
    return found


def _iter_files_from_allowed_paths(root: Path, allowed_paths: Iterable[str]) -> list[Path]:
    """Filter the kernel-supplied ``allowed_paths`` to the outbox surface.

    The kernel pre-filters its repo_snapshot.allowed_paths through
    `_snapshot_for_tool` against the tool's `allowed_read_globs`, so
    every path here is already in-scope by manifest. We only need to
    keep the ``.ts`` outbox files and drop test/artefact paths.
    """
    found: list[Path] = []
    for rel in allowed_paths:
        if not isinstance(rel, str) or not rel:
            continue
        if not rel.endswith(".ts"):
            continue
        if _is_skipped(rel):
            continue
        path = root / rel
        if not path.is_file():
            continue
        found.append(path)
    return found


def _iter_files(root: Path, allowed_paths: Iterable[str] | None = None) -> list[Path]:
    """Yield TS files in scope.

    If ``allowed_paths`` is supplied (kernel injection path), use it as
    the single source of truth. Otherwise fall back to the manifest
    glob walk. Either path MUST yield only outbox-surface files.
    """
    if allowed_paths is not None:
        return _iter_files_from_allowed_paths(root, allowed_paths)
    return _iter_files_from_globs(root, _FALLBACK_SCANNED_GLOBS)


def scan(repo_root: Path, allowed_paths: Iterable[str] | None = None) -> dict:
    """Run outbox detection across the in-scope TS files; return ARIA envelope.

    Parameters
    ----------
    repo_root:
        Repository root resolved from `ARIA_REPO_ROOT` or the nearest
        ancestor with `package.json`.
    allowed_paths:
        Optional kernel-pre-filtered relative path list (from
        ``stdin.repo_snapshot.allowed_paths``). When provided, the walker
        consumes this list directly. When omitted, falls back to a
        manifest-narrow glob walk (`_FALLBACK_SCANNED_GLOBS`).
    """
    findings: list[dict] = []
    read_paths: list[str] = []
    unreadable: list[str] = []
    for path in _iter_files(repo_root, allowed_paths):
        rel = path.relative_to(repo_root).as_posix()
        try:
            content = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            # An in-scope source that cannot be read is not invisible: the
            # scan's coverage has a hole, and a "clean" verdict over a
            # partial scan is exactly the fail-open the audit reproduced.
            # Counted, surfaced, and the envelope reports incomplete.
            unreadable.append(rel)
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
    envelope = {
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
    if unreadable:
        envelope["status"] = "incomplete"
        envelope["metadata"]["unreadable_file_count"] = len(unreadable)
        envelope["metadata"]["unreadable_paths"] = unreadable[:50]
    return envelope


def _allowed_paths_from_stdin(payload: object) -> list[str] | None:
    """Extract `repo_snapshot.allowed_paths` from the stdin JSON payload.

    Returns the kernel-supplied list when shape is valid, otherwise None
    (signal to use the manifest-narrow fallback walker).
    """
    if not isinstance(payload, dict):
        return None
    snapshot = payload.get("repo_snapshot")
    if not isinstance(snapshot, dict):
        return None
    allowed = snapshot.get("allowed_paths")
    if not isinstance(allowed, list):
        return None
    return [item for item in allowed if isinstance(item, str)]


def main() -> int:
    payload: object = {}
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError:
        payload = {}
    allowed_paths = _allowed_paths_from_stdin(payload)
    print(json.dumps(scan(_resolve_repo_root(), allowed_paths=allowed_paths)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
