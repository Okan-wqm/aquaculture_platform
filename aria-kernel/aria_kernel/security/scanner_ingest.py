"""Plan 033 Faz 033b — SARIF ingest: untrusted scanner output → external_scanner leads.

WHY: CI already runs Trivy (→ GitHub Code Scanning SARIF) and Gitleaks (→ Actions
artifact), but ARIA only ever read the pass/fail conclusion, never the results. This
reads the SARIF, treating it as UNTRUSTED input (it can carry attacker-influenced
text and paths), and emits leads on the existing external_scanner lane — never
canonical findings, which still require repo-verified proof.

WHAT: closed `SCANNER_SOURCES`; scanners not actually configured resolve to
NOT_CONFIGURED (never counted as clean). `parse_sarif` hardens schema/size/URI/path,
drops path-traversal locations, and normalizes to `ScannerLead`.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

# tool → how ARIA obtains its SARIF. NOT_CONFIGURED sources are never treated as clean.
SCANNER_SOURCES: dict[str, str] = {
    "trivy": "github_code_scanning",
    "gitleaks": "github_actions_artifact",
    "snyk": "not_configured",
    "codeql": "not_configured",
    "semgrep": "not_configured",
}
SARIF_SEVERITY = {"error": "high", "warning": "medium", "note": "low", "none": "low"}
MAX_RESULTS = 5000
MAX_MESSAGE = 500
_PATH_TRAVERSAL = re.compile(r"(^|/)\.\.(/|$)")
_ABS_OR_SCHEME = re.compile(r"^([a-zA-Z]:[\\/]|/|[a-zA-Z][a-zA-Z0-9+.-]*://)")


class SarifError(ValueError):
    """The SARIF document is malformed — quarantined, never counted as clean."""


@dataclass(frozen=True)
class ScannerLead:
    tool: str
    rule_id: str
    severity: str
    message: str
    location: str | None


def source_status(tool: str) -> str:
    return SCANNER_SOURCES.get(tool.lower(), "not_configured")


def _safe_uri(uri: Any) -> str | None:
    if not isinstance(uri, str) or not uri.strip():
        return None
    text = uri.strip()[:400]
    # untrusted: reject traversal and absolute/scheme URIs (a finding must point inside the repo)
    if _PATH_TRAVERSAL.search(text) or _ABS_OR_SCHEME.match(text):
        return None
    return text


def parse_sarif(document: Mapping[str, Any], *, tool_hint: str | None = None) -> list[ScannerLead]:
    """Normalize a SARIF 2.1.0 document into leads. Raises SarifError on malformed input."""
    if not isinstance(document, Mapping):
        raise SarifError("sarif_not_object")
    version = str(document.get("version") or "")
    if not version.startswith("2.1"):
        raise SarifError(f"sarif_version_unsupported:{version!r}")
    runs = document.get("runs")
    if not isinstance(runs, list):
        raise SarifError("sarif_runs_not_list")
    leads: list[ScannerLead] = []
    for run in runs:
        if not isinstance(run, Mapping):
            raise SarifError("sarif_run_not_object")
        tool = tool_hint or str(((run.get("tool") or {}).get("driver") or {}).get("name") or "unknown").lower()
        rules_index = {}
        driver = (run.get("tool") or {}).get("driver") or {}
        for rule in driver.get("rules") or []:
            if isinstance(rule, Mapping) and rule.get("id"):
                rules_index[str(rule["id"])] = rule
        results = run.get("results")
        if results is None:
            continue
        if not isinstance(results, list):
            raise SarifError("sarif_results_not_list")
        if len(results) > MAX_RESULTS:
            raise SarifError(f"sarif_results_exceed_cap:{len(results)}")
        for result in results:
            if not isinstance(result, Mapping):
                raise SarifError("sarif_result_not_object")
            rule_id = str(result.get("ruleId") or "unknown")[:200]
            level = str(result.get("level") or (rules_index.get(rule_id, {}).get("defaultConfiguration", {}) or {}).get("level") or "warning").lower()
            severity = SARIF_SEVERITY.get(level, "medium")
            message = str(((result.get("message") or {}).get("text")) or "")[:MAX_MESSAGE]
            location = None
            locs = result.get("locations")
            if isinstance(locs, list) and locs:
                uri = (((locs[0] or {}).get("physicalLocation") or {}).get("artifactLocation") or {}).get("uri")
                location = _safe_uri(uri)
            leads.append(ScannerLead(tool=tool, rule_id=rule_id, severity=severity, message=message, location=location))
    return leads


def ingest_sarif(document: Mapping[str, Any], *, service: str, base_dir: str | Path | None,
                 tool_hint: str | None = None) -> dict[str, Any]:
    """Parse + emit each lead to the external_scanner lane. Returns a summary; a malformed
    document is quarantined (recorded as governance, not counted clean)."""
    from ..runtime_signal_bridge import ingest_runtime_signal
    from ..tool_registry import append_tools_governance, ensure_tools_dir

    root = ensure_tools_dir(base_dir)
    try:
        leads = parse_sarif(document, tool_hint=tool_hint)
    except SarifError as exc:
        append_tools_governance(root, "security_sarif_quarantined", {"service": service, "reason": str(exc)[:200], "tool_hint": tool_hint})
        return {"status": "quarantined", "reason": str(exc), "ingested": 0}
    ingested = 0
    for lead in leads:
        if source_status(lead.tool) == "not_configured" and tool_hint is None:
            continue  # a scanner we do not trust as a live source is never counted
        ingest_runtime_signal(
            source="external_scanner", service=service,
            summary=f"[sarif:{lead.tool}/{lead.rule_id}] {lead.message}"[:300],
            code_refs=[lead.location] if lead.location else [f"sarif:{lead.tool}"],
            severity=lead.severity, base_dir=root,
        )
        ingested += 1
    return {"status": "ingested", "tools": sorted({l.tool for l in leads}), "leads": len(leads), "ingested": ingested}


__all__ = [
    "MAX_RESULTS", "SARIF_SEVERITY", "SCANNER_SOURCES", "SarifError", "ScannerLead",
    "ingest_sarif", "parse_sarif", "source_status",
]
