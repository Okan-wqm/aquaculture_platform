#!/usr/bin/env python3
"""ARIA-MEDIUM-394 — runtime-signal source connectors (poller/ingest).

The kernel's `runtime signal ingest` verb existed with nothing that
could feed it: no Sentry export reader, no incident importer, no
log-anomaly tap. This module is the on-ramp. It maps external runtime
artifacts onto `ingest_runtime_signal` (the same kernel function the
CLI verb calls — one implementation, no argv layer) and resolves
external identifiers to REPO-RELATIVE `code_refs`, because a signal
whose refs don't speak repo paths can never decay a belief
(ARIA-MEDIUM-393's matcher) or point an operator at code.

The input is UNTRUSTED: Sentry accepts events from anyone holding the
project's public DSN, and a log line carries whatever a request put in
it. The bridge enforces the ref, text and severity law for every
producer; this importer adds the bounds only a file reader can apply
(file size, row count, row shape) and reports every refusal per row.

Input contracts (JSON, --input, at most MAX_INPUT_BYTES / MAX_ROWS):
  sentry   — a list of issue rows: {"title", "culprit"?, "project"?,
             "location"? (frames: "path[:line]" strings or Sentry frame
             objects {"filename"|"abs_path", "lineno"?}), "level"?}
  incident — a list of postmortem rows: {"summary", "service",
             "code_refs": [...], "severity"?}
  log_anomaly — a list of anomaly rows: {"summary", "service",
             "path", "severity"?}

Path resolution for every code-ref candidate (its `:line` is kept):
  1. repo-relative and present under --repo-root → kept;
  2. absolute and under --repo-root → made relative;
  3. prefix match in --path-map (JSON object of string → string:
     {"external/prefix": "repo/dir"}) and present under --repo-root →
     rewritten to the repo dir + remainder;
  4. else → DROPPED and reported. A ref the repo cannot ground is noise
     the operator must see, never a lead.
A resolved ref then passes the bridge's ref law
(`runtime_signal_bridge.canonical_runtime_signal_ref`); a refusal there
is reported with the law's code.

Usage:
  python3 tools/runtime-signals/import_signals.py \
      --kind sentry --input sentry-export.json \
      --repo-root . --tools-dir /var/aqua-saas/aria-tools [--path-map map.json]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from aria_kernel.runtime_signal_bridge import (
    RUNTIME_SEVERITIES,
    canonical_runtime_signal_ref,
    ingest_runtime_signal,
)
from aria_kernel.tool_registry import GovernanceError

# An export larger than this is refused before it is parsed: json.loads on an
# attacker-sized document is the first resource the importer would spend.
MAX_INPUT_BYTES = 8 * 1024 * 1024
MAX_PATH_MAP_BYTES = 64 * 1024
MAX_ROWS = 1000
MAX_CANDIDATES_PER_ROW = 64

_LEVEL_TO_SEVERITY = {
    "debug": "low", "info": "low", "warning": "medium",
    "error": "high", "fatal": "critical",
}


def _split_line(candidate: str) -> tuple[str, str]:
    """``("path", ":line")`` when the candidate ends in a numeric line suffix, else ``(candidate, "")``."""
    head, sep, tail = candidate.rpartition(":")
    if sep and head and tail.isdigit():
        return head, f":{tail}"
    return candidate, ""


def resolve_code_ref(candidate: str, repo_root: Path, path_map: dict[str, str]) -> str | None:
    """One external identifier → one repo-relative ``path[:line]`` ref, or None."""
    text = str(candidate).strip().replace("\\", "/")
    raw, line = _split_line(text)
    while raw.startswith("./"):
        raw = raw[2:]
    if not raw:
        return None
    root = repo_root.resolve()
    absolute = Path(raw)
    if absolute.is_absolute():
        try:
            return absolute.resolve().relative_to(root).as_posix() + line
        except ValueError:
            pass
    elif _is_file_under(root, raw):
        return raw + line
    for external_prefix, repo_dir in sorted(path_map.items(), key=lambda kv: -len(kv[0])):
        if raw.startswith(external_prefix):
            rewritten = f"{repo_dir.rstrip('/')}/{raw[len(external_prefix):].lstrip('/')}"
            if _is_file_under(root, rewritten):
                return rewritten + line
    return None


def _is_file_under(root: Path, relative: str) -> bool:
    """True when ``relative`` names an existing path that stays inside ``root`` once resolved."""
    try:
        target = (root / relative).resolve()
        target.relative_to(root)
    except (OSError, ValueError):
        return False
    return target.exists()


def _frame_ref(frame: Any) -> str | None:
    """A Sentry stack frame as ``path[:line]``: a string frame verbatim, a frame object by filename/abs_path + lineno."""
    if isinstance(frame, str):
        return frame if frame.strip() else None
    if not isinstance(frame, dict):
        return None
    path = frame.get("filename") or frame.get("abs_path")
    if not isinstance(path, str) or not path.strip():
        return None
    lineno = frame.get("lineno")
    if isinstance(lineno, int) and not isinstance(lineno, bool) and lineno > 0:
        return f"{path}:{lineno}"
    return path


def _sentry_refs(row: dict[str, Any]) -> list[str]:
    refs: list[str] = []
    culprit = row.get("culprit")
    if isinstance(culprit, str) and culprit.strip() and culprit.strip() != "<unknown>":
        # Sentry's culprit is "module in function"; the ref is the module.
        refs.append(culprit.strip().split(" in ", 1)[0])
    location = row.get("location")
    if isinstance(location, list):
        for frame in location:
            ref = _frame_ref(frame)
            if ref is not None:
                refs.append(ref)
    return refs


def _text(row: dict[str, Any], key: str, default: str = "") -> str:
    value = row.get(key)
    return value.strip() if isinstance(value, str) else default


def _row_fields(kind: str, row: dict[str, Any]) -> tuple[str, str, list[Any], str]:
    """``(summary, service, candidates, severity)`` read from one row of ``kind``."""
    if kind == "sentry":
        level = _text(row, "level", "error").lower()
        return (
            _text(row, "title"),
            _text(row, "project") or _text(row, "platform") or "unknown-service",
            _sentry_refs(row),
            _LEVEL_TO_SEVERITY.get(level, "high"),
        )
    if kind == "incident":
        refs = row.get("code_refs")
        return (
            _text(row, "summary"),
            _text(row, "service") or "unknown-service",
            list(refs) if isinstance(refs, list) else [],
            _text(row, "severity") or "high",
        )
    return (
        _text(row, "summary"),
        _text(row, "service") or "unknown-service",
        [row.get("path")],
        _text(row, "severity") or "medium",
    )


_SOURCE_OF_KIND = {"sentry": "sentry", "incident": "incident", "log_anomaly": "prod_log"}


def map_rows(
    kind: str,
    rows: list[Any],
    *,
    repo_root: Path,
    path_map: dict[str, str],
) -> tuple[list[dict[str, Any]], list[str]]:
    """Map external rows to ingest_runtime_signal kwargs and list every
    dropped ref and refused row — reported, never silent."""
    if kind not in _SOURCE_OF_KIND:
        raise SystemExit(f"unknown --kind: {kind}")
    mapped: list[dict[str, Any]] = []
    dropped: list[str] = []
    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            dropped.append(f"<row {index}: not a JSON object ({type(row).__name__})>")
            continue
        summary, service, candidates, severity = _row_fields(kind, row)
        if len(candidates) > MAX_CANDIDATES_PER_ROW:
            dropped.append(f"<row {index}: {len(candidates)} refs exceeds {MAX_CANDIDATES_PER_ROW}>")
            continue
        if severity not in RUNTIME_SEVERITIES:
            severity = "high" if kind in ("sentry", "incident") else "medium"
        code_refs: list[str] = []
        for candidate in candidates:
            if not isinstance(candidate, str) or not candidate.strip():
                continue
            resolved = resolve_code_ref(candidate, repo_root, path_map)
            if resolved is None:
                dropped.append(f"<row {index}: ungrounded ref {candidate[:120]!r}>")
                continue
            try:
                canonical = canonical_runtime_signal_ref(resolved)
            except GovernanceError as exc:
                dropped.append(f"<row {index}: ref refused: {str(exc)[:160]}>")
                continue
            if canonical not in code_refs:
                code_refs.append(canonical)
        if not summary or not code_refs:
            # A signal with no summary or no grounded ref cannot decay a
            # belief or point at code — record it as dropped, not as a lead.
            dropped.append(f"<row {index}: no summary or no grounded ref: {summary[:60]!r}>")
            continue
        mapped.append({
            "source": _SOURCE_OF_KIND[kind],
            "service": service,
            "summary": summary,
            "code_refs": code_refs,
            "severity": severity,
        })
    return mapped, dropped


def _read_bounded_json(path: Path, limit: int, label: str) -> Any:
    size = path.stat().st_size
    if size > limit:
        raise SystemExit(f"{label} is {size} bytes; the importer reads at most {limit}")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise SystemExit(f"{label} is not valid UTF-8 JSON: {exc}") from exc
    except RecursionError as exc:
        # A small file can still nest deeper than the parser's stack: an
        # outside-authored document reports, it never crashes the importer.
        raise SystemExit(f"{label} nests deeper than the JSON parser can read") from exc


def load_path_map(path: Path) -> dict[str, str]:
    """The --path-map document, refused unless it is a JSON object of string → string."""
    document = _read_bounded_json(path, MAX_PATH_MAP_BYTES, "--path-map")
    if not isinstance(document, dict) or not all(
        isinstance(key, str) and key and isinstance(value, str) and value
        for key, value in document.items()
    ):
        raise SystemExit("--path-map must be a JSON object mapping non-empty strings to non-empty strings")
    return document


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Import external runtime artifacts as ARIA runtime signals.")
    parser.add_argument("--kind", required=True, choices=tuple(_SOURCE_OF_KIND))
    parser.add_argument("--input", required=True, help="JSON file: a list of rows per the kind's contract.")
    parser.add_argument("--repo-root", default=".")
    parser.add_argument("--tools-dir", required=True)
    parser.add_argument("--path-map", default=None, help="JSON file mapping external path prefixes to repo dirs.")
    args = parser.parse_args(argv)

    rows = _read_bounded_json(Path(args.input), MAX_INPUT_BYTES, "--input")
    if not isinstance(rows, list):
        raise SystemExit("--input must be a JSON list of rows")
    if len(rows) > MAX_ROWS:
        raise SystemExit(f"--input holds {len(rows)} rows; the importer reads at most {MAX_ROWS} per run")
    path_map = load_path_map(Path(args.path_map)) if args.path_map else {}

    mapped, dropped = map_rows(args.kind, rows, repo_root=Path(args.repo_root), path_map=path_map)
    ingested: list[dict[str, Any]] = []
    refused: list[str] = []
    for kwargs in mapped:
        try:
            ingested.append(ingest_runtime_signal(base_dir=args.tools_dir, **kwargs))
        except GovernanceError as exc:
            refused.append(f"<{kwargs['summary'][:60]!r}: {str(exc)[:160]}>")
    print(json.dumps({
        "schema_version": 1,
        "kind": args.kind,
        "rows_read": len(rows),
        "ingested": len(ingested),
        "signal_ids": [r.get("signal_id") for r in ingested],
        # Dropped refs/rows and bridge refusals are REPORTED, never silent —
        # the same doctrine as the decay path's unmatched_refs.
        "dropped": dropped,
        "refused": refused,
    }, indent=2, sort_keys=True))
    return 0 if ingested or not rows else 1


if __name__ == "__main__":
    sys.exit(main())
