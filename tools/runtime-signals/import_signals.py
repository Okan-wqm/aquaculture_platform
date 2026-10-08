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

Input contracts (JSON, --input):
  sentry   — a list of issue rows: {"title", "culprit"?, "project"?,
             "location"? ("in frame" list), "level"?}
  incident — a list of postmortem rows: {"summary", "service",
             "code_refs": [...], "severity"?}
  log_anomaly — a list of anomaly rows: {"summary", "service",
             "path", "severity"?}

Path resolution order for every code-ref candidate:
  1. already repo-relative (exists under --repo-root) → kept as-is;
  2. absolute under --repo-root → made relative;
  3. prefix match in --path-map (JSON: {"external/prefix": "repo/dir"})
     → rewritten to the repo dir + remainder;
  4. else → DROPPED and reported (a ref the repo cannot ground is
     noise the operator must see, not a silent pass-through).

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
    ingest_runtime_signal,
)

_LEVEL_TO_SEVERITY = {
    "debug": "low", "info": "low", "warning": "medium",
    "error": "high", "fatal": "critical",
}


def resolve_code_ref(candidate: str, repo_root: Path, path_map: dict[str, str]) -> str | None:
    """One external identifier → one repo-relative ref, or None."""
    raw = str(candidate).strip().split(":", 1)[0].replace("\\", "/")
    while raw.startswith("./"):
        raw = raw[2:]
    if not raw:
        return None
    absolute = Path(raw)
    if absolute.is_absolute():
        try:
            rel = absolute.resolve().relative_to(repo_root.resolve())
        except ValueError:
            rel = None
        if rel is not None:
            return rel.as_posix()
    else:
        if (repo_root / raw).exists():
            return raw
    for external_prefix, repo_dir in sorted(path_map.items(), key=lambda kv: -len(kv[0])):
        if raw.startswith(external_prefix):
            rewritten = f"{repo_dir.rstrip('/')}/{raw[len(external_prefix):].lstrip('/')}"
            if (repo_root / rewritten).exists() or not Path(repo_dir).is_absolute():
                return rewritten
    # An absolute path outside the repo and an unmapped prefix both fail here.
    if not absolute.is_absolute() and "/" in raw and not raw.startswith("http"):
        # A plausible repo-relative path that simply does not exist yet
        # (a branch, a rename) still speaks the repo's language.
        return raw
    return None


def _sentry_refs(row: dict[str, Any]) -> list[str]:
    refs: list[str] = []
    culprit = str(row.get("culprit") or "").strip()
    if culprit and culprit not in ("", "<unknown>"):
        # Sentry's culprit is "module in function"; the ref is the module.
        refs.append(culprit.split(" in ", 1)[0])
    location = row.get("location")
    if isinstance(location, list):
        refs.extend(str(frame) for frame in location if str(frame).strip())
    return refs


def map_rows(
    kind: str,
    rows: list[dict[str, Any]],
    *,
    repo_root: Path,
    path_map: dict[str, str],
) -> tuple[list[dict[str, Any]], list[str]]:
    """Map external rows to ingest_runtime_signal kwargs and list the
    dropped (ungroundable) refs/rows — reported, never silent."""
    mapped: list[dict[str, Any]] = []
    dropped: list[str] = []
    for row in rows:
        if kind == "sentry":
            summary = str(row.get("title") or "").strip()
            service = str(row.get("project") or row.get("platform") or "unknown-service").strip()
            candidates = _sentry_refs(row)
            level = str(row.get("level") or "error").lower()
            severity = _LEVEL_TO_SEVERITY.get(level, "high")
        elif kind == "incident":
            summary = str(row.get("summary") or "").strip()
            service = str(row.get("service") or "unknown-service").strip()
            candidates = [str(r) for r in (row.get("code_refs") or [])]
            severity = str(row.get("severity") or "high")
        elif kind == "log_anomaly":
            summary = str(row.get("summary") or "").strip()
            service = str(row.get("service") or "unknown-service").strip()
            candidates = [str(row.get("path") or "")]
            severity = str(row.get("severity") or "medium")
        else:
            raise SystemExit(f"unknown --kind: {kind}")
        if severity not in RUNTIME_SEVERITIES:
            severity = "high" if kind in ("sentry", "incident") else "medium"
        code_refs: list[str] = []
        for candidate in candidates:
            if not str(candidate).strip():
                continue
            resolved = resolve_code_ref(candidate, repo_root, path_map)
            if resolved is None:
                dropped.append(str(candidate))
            elif resolved not in code_refs:
                code_refs.append(resolved)
        if not summary or not code_refs:
            # A signal with no summary or no grounded ref cannot decay a
            # belief or point at code — record it as dropped, not as a lead.
            dropped.append(f"<row without summary or grounded ref: {summary[:60]!r}>")
            continue
        mapped.append({
            "source": {"sentry": "sentry", "incident": "incident", "log_anomaly": "prod_log"}[kind],
            "service": service,
            "summary": summary,
            "code_refs": code_refs,
            "severity": severity,
        })
    return mapped, dropped


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Import external runtime artifacts as ARIA runtime signals.")
    parser.add_argument("--kind", required=True, choices=("sentry", "incident", "log_anomaly"))
    parser.add_argument("--input", required=True, help="JSON file: a list of rows per the kind's contract.")
    parser.add_argument("--repo-root", default=".")
    parser.add_argument("--tools-dir", required=True)
    parser.add_argument("--path-map", default=None, help="JSON file mapping external path prefixes to repo dirs.")
    args = parser.parse_args(argv)

    rows = json.loads(Path(args.input).read_text(encoding="utf-8"))
    if not isinstance(rows, list):
        raise SystemExit("--input must be a JSON list of rows")
    path_map: dict[str, str] = {}
    if args.path_map:
        path_map = json.loads(Path(args.path_map).read_text(encoding="utf-8"))

    mapped, dropped = map_rows(args.kind, rows, repo_root=Path(args.repo_root), path_map=path_map)
    ingested: list[dict[str, Any]] = []
    for kwargs in mapped:
        ingested.append(ingest_runtime_signal(base_dir=args.tools_dir, **kwargs))
    print(json.dumps({
        "schema_version": 1,
        "kind": args.kind,
        "rows_read": len(rows),
        "ingested": len(ingested),
        "signal_ids": [r.get("signal_id") for r in ingested],
        # Dropped refs/rows are REPORTED, never silent — the same doctrine
        # as the decay path's unmatched_refs.
        "dropped": dropped,
    }, indent=2, sort_keys=True))
    return 0 if ingested or not rows else 1


if __name__ == "__main__":
    sys.exit(main())
