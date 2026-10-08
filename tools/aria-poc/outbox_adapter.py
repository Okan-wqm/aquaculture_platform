"""Outbox adapter — a domain event published around the transactional outbox (ARIA-MEDIUM-379).

The rule (``@platform/outbox``, ``OutboxPublisher``): a command handler that
writes state inside a transaction emits its domain event with
``outboxPublisher.enqueue(event, queryRunner.manager)``, so the outbox row
commits or rolls back with the write and the worker delivers it
at-least-once. A raw ``eventBus.publish(...)`` in that same write path is a
dual write: published before the commit, a rolled-back write still announces
itself; published after it, a crash or a NATS outage between the two loses
the event while the state change stands. Every service that registers
``OutboxModule.forFeature`` has the outbox available, so there the raw
publish is the defect (DATA-HIGH-001 moved auth's state-change events onto
it; the leave-approval handler enqueues while its reject sibling published).

Rule:

1. domain_event_published_outside_outbox (HIGH)
   In one unit of work — a class method, together with the same-class helper
   methods it calls directly (one level) — a durable write (``.save(``,
   ``.insert(``, ``.upsert(``, ``.softDelete(``, or ``update`` / ``delete`` /
   ``remove`` / ``increment`` / ``decrement`` on a repository or entity
   manager) followed by a non-comment ``eventBus.publish(``, in a service
   whose source registers ``OutboxModule.forFeature``. A transaction is not
   required: a save and a publish without one are the same dual write. The
   finding cites the publish and, as its second evidence line, the nearest
   preceding write — the premise a judge verifies.

What it does not flag, by construction:
  - the outbox implementation itself (``platform/libs/outbox`` and every
    ``outbox/`` directory) — it is never read;
  - a publish in a unit of work that makes no durable write before it
    (telemetry streams, reactions to already-committed events);
  - a service that has not registered the outbox.

The former two rules read only the outbox directories, so all three of their
hits on main were the outbox relay and the sanctioned best-effort wrapper.

Runner contract (ARIA tool_runner.run_tool):
  stdin:  JSON {cycle_id, repo_snapshot{allowed_paths: [...]}, ...}
  stdout: JSON {observations[], findings[], read_paths[],
                evidence_sources[], cost_units, metadata}

Scope: through the kernel the adapter reads exactly
``repo_snapshot.allowed_paths`` (pre-filtered to the manifest's
``allowed_read_globs``); a direct run walks ``SCANNED_GLOBS``, which mirror
the manifest (``tools/aria-adapters/outbox-adapter.tool.json``), and the
invariant ``tools/aria-poc/invariants/test_adapter_scope_narrow.py`` pins
the two together.
"""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path
from typing import Iterable


REPO_ROOT_ENV = "ARIA_REPO_ROOT"

# Mirrors the manifest's allowed_read_globs: application source only.
_FALLBACK_SCANNED_GLOBS: tuple[str, ...] = ("apps/*/src/**/*.ts",)
SCANNED_GLOBS: tuple[str, ...] = _FALLBACK_SCANNED_GLOBS

_SKIP_SUBSTRINGS: tuple[str, ...] = (
    "node_modules/",
    "dist/",
    "/__tests__/",
    ".spec.ts",
    ".test.ts",
    "/migrations/",
)
# The outbox machinery publishes by design; it is what the rule protects. Its
# files are read (a service registers the outbox there) but never judged.
_OUTBOX_DIR = "/outbox/"
_SERVICE_SOURCE_RE = re.compile(r"^apps/([^/]+)/src/")

_PUBLISH_RE = re.compile(r"\beventBus\.publish\s*\(")
_OUTBOX_REGISTRATION_RE = re.compile(r"\bOutboxModule\.forFeature\s*\(")
# A durable write. The unambiguous TypeORM writers match on any receiver; the
# verbs a Map, a Set or a hash also have match only on a repository or an
# entity manager (``this.cache.delete(key)`` is not a write).
_WRITE_RE = re.compile(
    r"\.(save|insert|upsert|softDelete|softRemove)\s*\("
    r"|\b\w*(?:[Rr]epo(?:sitory)?|[Mm]anager)\b\s*\.(update|delete|remove|increment|decrement)\s*\("
)
_SELF_CALL_RE = re.compile(r"\bthis\.(\w+)\s*\(")
# A class member at the two-space class-body indent: the enclosing method.
_METHOD_RE = re.compile(
    r"^  (?:(?:public|private|protected|static|readonly|override)\s+)*(?:async\s+)?"
    r"([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*\("
)
_COMMENT_RE = re.compile(r"^\s*(?://|\*|/\*)")


def _finding(
    rule: str, severity: str, rel: str, *, line: int, write_line: int, message: str,
) -> dict:
    """The kernel's evidence contract (``evidence_validator``): the publish
    line, then the durable write it follows."""
    return {
        "id": f"{rule}:{rel}:{line}",
        "rule": rule,
        "severity": severity,
        "path": rel,
        "line": line,
        "message": message,
        "evidence": [{"path": rel, "line": line}, {"path": rel, "line": write_line}],
    }


def _resolve_repo_root() -> Path:
    override = os.environ.get(REPO_ROOT_ENV)
    if override:
        return Path(override).resolve()
    here = Path.cwd()
    for cand in [here, *here.parents]:
        if (cand / "package.json").exists():
            return cand
    return here


def _service_of(rel: str) -> str:
    """The service an in-scope path belongs to (``apps/<service>/src/...``)."""
    return rel.split("/", 2)[1]


def _in_scope(rel: str) -> bool:
    return bool(_SERVICE_SOURCE_RE.match(rel)) and rel.endswith(".ts") and not any(
        skip in rel for skip in _SKIP_SUBSTRINGS
    )


def _iter_files_from_globs(root: Path, patterns: Iterable[str]) -> list[Path]:
    found: set[Path] = set()
    for pattern in patterns:
        for path in root.glob(pattern):
            if path.is_file() and _in_scope(path.relative_to(root).as_posix()):
                found.add(path)
    return sorted(found)


def _iter_files_from_allowed_paths(root: Path, allowed_paths: Iterable[str]) -> list[Path]:
    found: list[Path] = []
    for rel in allowed_paths:
        if isinstance(rel, str) and _in_scope(rel) and (root / rel).is_file():
            found.append(root / rel)
    return sorted(found)


def _iter_files(root: Path, allowed_paths: Iterable[str] | None = None) -> list[Path]:
    """The kernel's ``allowed_paths`` when given, else the manifest glob walk."""
    if allowed_paths is not None:
        return _iter_files_from_allowed_paths(root, allowed_paths)
    return _iter_files_from_globs(root, _FALLBACK_SCANNED_GLOBS)


def _methods(lines: list[str]) -> list[tuple[str, int, int]]:
    """(name, first line index, end index) of each class method, by the class-body indent."""
    starts = [(i, m.group(1)) for i, line in enumerate(lines) if (m := _METHOD_RE.match(line))]
    return [
        (name, start, starts[k + 1][0] if k + 1 < len(starts) else len(lines))
        for k, (start, name) in enumerate(starts)
    ]


def _code_lines(lines: list[str], start: int, end: int, pattern: re.Pattern[str]) -> list[int]:
    return [i for i in range(start, end) if not _COMMENT_RE.match(lines[i]) and pattern.search(lines[i])]


def dual_writes(lines: list[str]) -> list[tuple[int, int, str]]:
    """(publish line, nearest preceding write line, unit) — 1-based — for every
    raw publish that follows a durable write in the same unit of work.

    A unit of work is a class method plus the same-class helpers it calls
    directly: a call to a helper that writes counts as a write at the call
    site, a call to a helper that publishes as its publishes at the call site.
    """
    methods = _methods(lines)
    writes = {name: _code_lines(lines, s, e, _WRITE_RE) for name, s, e in methods}
    publishes = {name: _code_lines(lines, s, e, _PUBLISH_RE) for name, s, e in methods}
    found: dict[int, tuple[int, int, str]] = {}
    for name, start, end in methods:
        last_write: int | None = None
        for i in range(start, end):
            if _COMMENT_RE.match(lines[i]):
                continue
            helpers = [h for h in _SELF_CALL_RE.findall(lines[i]) if h != name]
            if _PUBLISH_RE.search(lines[i]) and last_write is not None:
                found.setdefault(i + 1, (i + 1, last_write + 1, name))
            for helper in helpers:
                if last_write is not None:
                    for line in publishes.get(helper, []):
                        found.setdefault(line + 1, (line + 1, last_write + 1, name))
            if _WRITE_RE.search(lines[i]):
                last_write = i
            for helper in helpers:
                if writes.get(helper):
                    last_write = writes[helper][-1]
    return sorted(found.values())


def scan(repo_root: Path, allowed_paths: Iterable[str] | None = None) -> dict:
    findings: list[dict] = []
    read_paths: list[str] = []
    unreadable: list[str] = []
    contents: dict[str, list[str]] = {}
    services_with_outbox: set[str] = set()
    for path in _iter_files(repo_root, allowed_paths):
        rel = path.relative_to(repo_root).as_posix()
        try:
            content = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            # An unreadable in-scope source leaves a hole in the verdict; a
            # clean result over a partial scan would be a fail-open.
            unreadable.append(rel)
            continue
        read_paths.append(rel)
        if _OUTBOX_REGISTRATION_RE.search(content):
            services_with_outbox.add(_service_of(rel))
        if _OUTBOX_DIR not in rel and _PUBLISH_RE.search(content):
            contents[rel] = content.split("\n")
    for rel, lines in sorted(contents.items()):
        service = _service_of(rel)
        if service not in services_with_outbox:
            continue
        for publish_line, write_line, unit in dual_writes(lines):
            findings.append(_finding(
                "domain_event_published_outside_outbox", "HIGH", rel,
                line=publish_line, write_line=write_line,
                message=(
                    f"{unit}: durable write at line {write_line}, then eventBus.publish at line "
                    f"{publish_line}; {service} registers the outbox, so the event belongs in "
                    "OutboxPublisher.enqueue with that write"
                ),
            ))
    envelope = {
        "observations": [],
        "findings": findings,
        "read_paths": sorted(read_paths),
        "evidence_sources": sorted({f["path"] for f in findings}),
        "cost_units": len(read_paths),
        "metadata": {
            "rule_count": 1,
            "scanned_file_count": len(read_paths),
            "services_with_outbox": sorted(services_with_outbox),
            "finding_count": len(findings),
        },
    }
    if unreadable:
        envelope["status"] = "incomplete"
        envelope["metadata"]["unreadable_file_count"] = len(unreadable)
        envelope["metadata"]["unreadable_paths"] = unreadable[:50]
    return envelope


def _allowed_paths_from_stdin(payload: object) -> list[str] | None:
    """``repo_snapshot.allowed_paths`` from the kernel's stdin, or None for a direct run."""
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
    print(json.dumps(scan(_resolve_repo_root(), allowed_paths=_allowed_paths_from_stdin(payload))))
    return 0


if __name__ == "__main__":
    sys.exit(main())
