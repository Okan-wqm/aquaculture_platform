from __future__ import annotations

import hashlib
import re
import urllib.request
from urllib.parse import urlparse
from pathlib import Path
from typing import Any

from .ledger import append_declared_jsonl, load_jsonl
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now


SOURCE_TIERS = ("official", "standards", "security_advisory", "vendor", "oss_repo", "other")
MAX_FETCH_BYTES = 1_000_000
MAX_SANITIZED_CHARS = 200_000


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
    return append_declared_jsonl(ensure_tools_dir(base_dir) / "research" / "sources.jsonl", row, expected_surface="research_sources")


def list_research_sources(*, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    return load_jsonl(ensure_tools_dir(base_dir) / "research" / "sources.jsonl")


def fetch_research_source(
    *,
    url: str,
    source_tier: str,
    title: str = "",
    base_dir: str | Path | None = None,
    content_override: str | bytes | None = None,
    allowed_domains: list[str] | None = None,
) -> dict[str, Any]:
    if not (url.startswith("https://") or url.startswith("http://")):
        raise GovernanceError("research fetch URL must be http(s)")
    if source_tier not in SOURCE_TIERS:
        raise GovernanceError(f"unknown research source tier: {source_tier}")
    policy = _source_policy(url=url, allowed_domains=allowed_domains or [], base_dir=base_dir)
    if policy["status"] != "allowed":
        raise GovernanceError("research fetch blocked by source policy")
    content_type = "text/plain"
    if content_override is None:
        payload, content_type = _fetch_url(url)
    elif isinstance(content_override, bytes):
        payload = content_override[:MAX_FETCH_BYTES]
    else:
        payload = content_override.encode("utf-8")[:MAX_FETCH_BYTES]
    if content_override is not None and b"<html" in payload[:200].lower():
        content_type = "text/html"
    sanitized = _sanitize_content(payload, content_type)
    content_hash = _sha256(sanitized.encode("utf-8"))
    source = record_research_source(
        url=url,
        source_tier=source_tier,
        content_hash=content_hash,
        title=title,
        base_dir=base_dir,
    )
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "source_ref": source["ledger_hash"],
        "url": url,
        "source_tier": source_tier,
        "title": title,
        "content_hash": content_hash,
        "content_type": content_type,
        "sanitized_text": sanitized,
        "extracted_claims": _extract_claims(sanitized),
        "source_policy": policy,
    }
    return append_declared_jsonl(ensure_tools_dir(base_dir) / "research" / "fetches.jsonl", row, expected_surface="research_fetches")


def list_research_fetches(*, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    return load_jsonl(ensure_tools_dir(base_dir) / "research" / "fetches.jsonl")


def record_research_policy(
    *,
    allowed_domains: list[str],
    base_dir: str | Path | None = None,
    cycle_id: str | None = None,
) -> dict[str, Any]:
    domains = _normalize_domains(allowed_domains)
    if not domains:
        raise GovernanceError("research policy requires at least one allowed domain")
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "cycle_id": cycle_id,
        "allowed_domains": domains,
    }
    return append_declared_jsonl(ensure_tools_dir(base_dir) / "research" / "policies.jsonl", row, expected_surface="research_policies")


def list_research_policies(*, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    return load_jsonl(ensure_tools_dir(base_dir) / "research" / "policies.jsonl")


def _source_policy(*, url: str, allowed_domains: list[str], base_dir: str | Path | None) -> dict[str, Any]:
    configured_domains = _normalize_domains(allowed_domains)
    if not configured_domains:
        policies = list_research_policies(base_dir=base_dir)
        if policies:
            configured_domains = _normalize_domains(policies[-1].get("allowed_domains", []))
    if not configured_domains:
        return {"status": "allowed", "mode": "open"}
    host = (urlparse(url).hostname or "").lower()
    allowed = any(host == domain or host.endswith("." + domain) for domain in configured_domains)
    return {
        "status": "allowed" if allowed else "blocked",
        "mode": "allowlist",
        "host": host,
        "allowed_domains": configured_domains,
    }


def _normalize_domains(domains: list[str]) -> list[str]:
    normalized = []
    for domain in domains:
        value = str(domain).strip().lower()
        if value.startswith("http://") or value.startswith("https://"):
            value = urlparse(value).hostname or ""
        value = value.lstrip(".")
        if value:
            normalized.append(value)
    return sorted(set(normalized))


def _assert_public_http_target(url: str) -> str:
    """ARIA-AUDIT-023: resolve the host and refuse non-public targets.

    Blocks loopback, private, link-local, reserved and unspecified
    address classes AFTER DNS resolution (so hostname-based rebinding to
    an internal address is caught), and only allows http(s) schemes.
    Returns the resolved host for diagnostics.
    """
    import ipaddress
    import socket

    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise GovernanceError(f"research fetch scheme not allowed: {parsed.scheme}")
    host = (parsed.hostname or "").lower()
    if not host:
        raise GovernanceError("research fetch URL has no host")
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as exc:
        raise GovernanceError(f"research fetch host unresolvable: {host}") from exc
    for info in infos:
        address = info[4][0]
        try:
            ip = ipaddress.ip_address(address)
        except ValueError:
            continue
        if (
            ip.is_private or ip.is_loopback or ip.is_link_local
            or ip.is_reserved or ip.is_unspecified or ip.is_multicast
        ):
            raise GovernanceError(
                f"research fetch target is not a public address: {host} -> {address}"
            )
    return host


def _fetch_url(url: str) -> tuple[bytes, str]:
    # SSRF posture (ARIA-AUDIT-023): every HOP — the initial URL and each
    # redirect — passes the same public-target assertion, so a redirect to
    # an internal address cannot ride an allowed first hop. urllib follows
    # redirects internally, which would skip per-hop checks; the custom
    # opener disables auto-redirect and the loop below re-validates each
    # Location before following it (bounded).
    import urllib.error as _urlerror

    class _NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[override]
            return None

    opener = urllib.request.build_opener(_NoRedirect)
    current = url
    for _hop in range(5):
        _assert_public_http_target(current)
        request = urllib.request.Request(current, headers={"User-Agent": "ARIA-research-fetch/1"})
        try:
            response = opener.open(request, timeout=20)
        except _urlerror.HTTPError as exc:
            location = exc.headers.get("Location") if exc.headers else None
            if location and 300 <= exc.code < 400:
                current = urllib.parse.urljoin(current, location)
                continue
            raise
        content_type = response.headers.get("content-type", "application/octet-stream")
        if not _allowed_content_type(content_type):
            raise GovernanceError(f"research fetch blocked unsupported content type: {content_type}")
        return response.read(MAX_FETCH_BYTES + 1)[:MAX_FETCH_BYTES], content_type
    raise GovernanceError("research fetch exceeded redirect budget")


def _allowed_content_type(content_type: str) -> bool:
    normalized = content_type.split(";", 1)[0].strip().lower()
    return normalized in ("text/plain", "text/html", "text/markdown", "application/json")


def _sanitize_content(payload: bytes, content_type: str) -> str:
    text = payload.decode("utf-8", errors="replace")
    if "html" in content_type.lower():
        text = re.sub(r"(?is)<(script|style).*?>.*?</\1>", " ", text)
        text = re.sub(r"(?s)<[^>]+>", " ", text)
    text = re.sub(r"https?://\S+", "[url]", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:MAX_SANITIZED_CHARS]


def _extract_claims(text: str) -> list[str]:
    sentences = [item.strip() for item in re.split(r"(?<=[.!?])\s+", text) if item.strip()]
    return sentences[:10]


def _sha256(payload: bytes) -> str:
    return "sha256:" + hashlib.sha256(payload).hexdigest()
