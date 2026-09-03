"""Plan 033 Faz 033f — ZAP under policy: pinned image digest + Automation Framework allowlist.

WHY: ZAP is powerful and therefore dangerous. It runs only from an image pinned to
a sha256 digest the operator recorded in the repo (a floating tag or a missing pin
fails closed — no digest is ever invented here), only with an Automation Framework
plan whose job types are allowlisted (no script jobs, no add-on downloads, no
remote plans) and whose contexts name only grant-allowed hosts. ZAP alerts become
UNVERIFIED leads; a lead is a finding only after a minimized typed recipe confirms
it under the dual-executor rule.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

ZAP_PIN_RELPATH: tuple[str, ...] = ("infrastructure", "aria", "security-lab", "zap.pin.json")
ALLOWED_JOBS = ("passiveScan-config", "passiveScan-wait", "spider", "openapi", "graphql", "activeScan", "report")
FORBIDDEN_JOB_HINTS = ("script", "addOns", "exportreport", "sequence", "import", "delay", "alertFilter")
_DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")


class ZapPolicyError(ValueError):
    pass


def load_zap_pin(workspace_root: str | Path) -> dict[str, Any]:
    path = Path(workspace_root).resolve().joinpath(*ZAP_PIN_RELPATH)
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ZapPolicyError(f"ZAP pin unreadable at {path}: operator must pin an image digest") from exc
    image, digest = str(doc.get("image", "")), str(doc.get("digest", ""))
    if not image or ":" in image.rsplit("/", 1)[-1]:
        raise ZapPolicyError("ZAP image must be a bare repository reference (no floating tag)")
    if not _DIGEST.match(digest):
        raise ZapPolicyError("ZAP pin must be a sha256 digest")
    if not doc.get("pinned_by") or not doc.get("pinned_at"):
        raise ZapPolicyError("ZAP pin must record who pinned it and when")
    return {"image": image, "digest": digest, "reference": f"{image}@{digest}", "pinned_by": doc["pinned_by"], "pinned_at": doc["pinned_at"]}


def validate_automation_plan(plan: dict[str, Any], *, allowed_hosts: tuple[str, ...]) -> list[str]:
    """Return the ordered job types of a valid plan; raise on anything outside the allowlist."""
    if not isinstance(plan, dict):
        raise ZapPolicyError("plan must be a mapping")
    env = plan.get("env") or {}
    contexts = env.get("contexts") or []
    if not contexts:
        raise ZapPolicyError("plan must declare at least one context")
    for ctx in contexts:
        for url in ctx.get("urls") or []:
            host = (urlsplit(str(url)).hostname or "").lower()
            if host not in allowed_hosts:
                raise ZapPolicyError(f"context url host {host!r} is not grant-allowed")
        if ctx.get("includePaths") is None and not ctx.get("urls"):
            raise ZapPolicyError("context must scope urls")
    if env.get("parameters", {}).get("failOnError") is False:
        raise ZapPolicyError("failOnError=false hides harness errors")
    jobs = plan.get("jobs") or []
    if not jobs:
        raise ZapPolicyError("plan has no jobs")
    kinds: list[str] = []
    for job in jobs:
        kind = str(job.get("type", ""))
        if kind not in ALLOWED_JOBS:
            raise ZapPolicyError(f"job type {kind!r} not allowlisted")
        blob = json.dumps(job).lower()
        for hint in FORBIDDEN_JOB_HINTS:
            if hint.lower() in blob:
                raise ZapPolicyError(f"job {kind!r} carries forbidden material {hint!r}")
        for key in ("apiUrl", "apiFile", "schemaUrl", "schemaFile", "url"):
            value = job.get("parameters", {}).get(key)
            if isinstance(value, str) and value.startswith(("http://", "https://")):
                host = (urlsplit(value).hostname or "").lower()
                if host not in allowed_hosts:
                    raise ZapPolicyError(f"job {kind!r} references non-allowed host {host!r}")
        kinds.append(kind)
    if "report" not in kinds:
        raise ZapPolicyError("plan must end with a report job")
    return kinds


def alerts_to_leads(report: dict[str, Any], *, service: str) -> list[dict[str, Any]]:
    """ZAP JSON report → UNVERIFIED leads (external_scanner). Never findings."""
    leads: list[dict[str, Any]] = []
    for site in report.get("site") or []:
        for alert in site.get("alerts") or []:
            leads.append({
                "rule_id": f"zap:{alert.get('pluginid', 'unknown')}", "service": service,
                "title": str(alert.get("name") or alert.get("alert") or "zap alert")[:200],
                "risk": str(alert.get("riskdesc") or "").split(" ")[0] or "Informational",
                "instances": min(len(alert.get("instances") or []), 500), "trust_grade": "runtime_unverified",
                "source": "external_scanner", "tool": "zap",
            })
    return leads[:5000]


__all__ = ["ALLOWED_JOBS", "FORBIDDEN_JOB_HINTS", "ZAP_PIN_RELPATH", "ZapPolicyError", "alerts_to_leads",
           "load_zap_pin", "validate_automation_plan"]
