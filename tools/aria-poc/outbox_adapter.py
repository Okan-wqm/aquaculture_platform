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
   A non-comment ``eventBus.publish(`` inside a class method that, before the
   publish, opens or uses a transaction (``startTransaction(``,
   ``commitTransaction(``, ``.transaction(``, ``queryRunner.manager.``), in a
   service whose source registers ``OutboxModule.forFeature``.

What it does not flag, by construction:
  - the outbox implementation itself (``platform/libs/outbox`` and every
    ``outbox/`` directory) — it is never read;
  - a publish in a method with no transactional write (telemetry streams,
    reactions to already-committed events);
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
_TRANSACTION_RE = re.compile(
    r"startTransaction\s*\(|commitTransaction\s*\(|\.transaction\s*\(|queryRunner\.manager\."
)
# A class member at the two-space class-body indent: the enclosing method.
_METHOD_RE = re.compile(
    r"^  (?:(?:public|private|protected|static|readonly|override)\s+)*(?:async\s+)?"
    r"[A-Za-z_]\w*\s*(?:<[^>]*>)?\s*\("
)
_COMMENT_RE = re.compile(r"^\s*(?://|\*|/\*)")


def _finding(rule: str, severity: str, rel: str, *, line: int, message: str) -> dict:
    """The kernel's evidence contract (``evidence_validator``)."""
    return {
        "id": f"{rule}:{rel}:{line}",
        "rule": rule,
        "severity": severity,
        "path": rel,
        "line": line,
        "message": message,
        "evidence": [{"path": rel, "line": line}],
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


def _publishes_in_transactional_write(lines: list[str]) -> list[int]:
    """1-based lines of raw publishes whose enclosing method writes in a transaction first."""
    hits: list[int] = []
    for index, line in enumerate(lines):
        if _COMMENT_RE.match(line) or not _PUBLISH_RE.search(line):
            continue
        start = index
        while start > 0 and not _METHOD_RE.match(lines[start]):
            start -= 1
        body = lines[start:index]
        if any(_TRANSACTION_RE.search(text) and not _COMMENT_RE.match(text) for text in body):
            hits.append(index + 1)
    return hits


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
        for line in _publishes_in_transactional_write(lines):
            findings.append(_finding(
                "domain_event_published_outside_outbox", "HIGH", rel, line=line,
                message=(
                    f"{service} registers the outbox, yet this transactional write path "
                    "publishes its event with eventBus.publish instead of OutboxPublisher.enqueue"
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
