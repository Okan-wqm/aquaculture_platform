from __future__ import annotations

from pathlib import Path
from typing import Any

from .ledger import append_jsonl, load_jsonl
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now


SOURCE_TIERS = ("official", "standards", "security_advisory", "vendor", "oss_repo", "other")


def record_research_source(
    *,
    url: str,
    source_tier: str,
    content_hash: str,
    title: str = "",
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    if not (url.startswith("https://") or url.startswith("http://")):
        raise GovernanceError("research source URL must be http(s)")
    if source_tier not in SOURCE_TIERS:
        raise GovernanceError(f"unknown research source tier: {source_tier}")
    if not content_hash.startswith("sha256:"):
        raise GovernanceError("research source content_hash must be sha256-prefixed")
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "url": url,
        "source_tier": source_tier,
        "content_hash": content_hash,
        "title": title,
    }
    append_jsonl(ensure_tools_dir(base_dir) / "research" / "sources.jsonl", row)
    return row


def list_research_sources(*, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    return load_jsonl(ensure_tools_dir(base_dir) / "research" / "sources.jsonl")
