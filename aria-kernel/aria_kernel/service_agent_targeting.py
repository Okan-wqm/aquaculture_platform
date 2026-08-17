"""E15-c — service-specific auditor targeting (the BP2 precursor).

WHY: E15-a gave findings a service axis and E15-b let readers filter on
it, but nothing yet ACTS on the axis — a service could accumulate open
tool findings forever without anyone being asked to own it. This module
is the narrow, deterministic trigger: when one service's open-finding
count crosses a policy threshold, mint ONE agent-genesis request for a
dedicated ``aria-svc-<service>-auditor``. It deliberately reuses the
whole existing genesis machinery instead of growing a parallel lane:

* the counting axis is the E15-a service dimension
  (``service_dimension.services_for_finding_row`` — the same derivation
  ``feedback_store.list_findings`` filters with, so trigger and filter
  can never disagree about a finding's service);
* the request writer is ``agent_genesis.request_agent_genesis`` — the
  SAME writer ``learning._emit_genesis_for_gap`` uses, so the request
  row shape, the frozen-profile write gate, and the capability
  resolution ledger are shared, not copied;
* idempotency reuses ``existing_genesis_request_keys`` (the learning
  router's own suppression set) plus ``resolve_agent_md_path`` (the
  Plan-020 shared agent-file resolver).

WHAT: ``propose_service_auditor_requests`` groups open tool findings by
service, and for each service at/over threshold with no existing
``aria-svc-<service>-auditor`` agent file and no already-minted request
for the ``service-auditor:<service>`` capability key, appends one
agent-genesis REQUEST row naming the service and its top finding
classes — bounded by the same ``max_requests_per_cycle`` ceiling the
capability-gap producer honours, sickest service first. Draft → sandbox
→ materialize stays downstream and gated — this module only records
intent.
"""
from __future__ import annotations

from collections import Counter
from pathlib import Path
from typing import Any

from .agent_genesis import existing_genesis_request_keys, request_agent_genesis
from .agent_resolver import resolve_agent_md_path
from .batch_containment import guard_item, with_item_failures
from .feedback_store import list_findings
from .genesis_policy import load_policy
from .service_dimension import finding_dimension_paths, services_for_finding_row
from .tool_registry import append_tools_governance


# Stable capability-key prefix: the key (not the gap_id) is what
# existing_genesis_request_keys dedupes on, so it must be derivable from
# the service alone — the same service must always produce the same key.
SERVICE_AUDITOR_CAPABILITY_PREFIX = "service-auditor:"

# How many finding classes (adapter rule ids) the request title names.
# The title is the operator's triage surface; three classes describe the
# sickness without turning the title into a report.
TOP_FINDING_CLASS_COUNT = 3

_EVIDENCE_REF_CAP = 20


def service_auditor_agent_name(service: str) -> str:
    """Deterministic agent name for a service dimension.

    Dimension values may carry namespace colons (``shared:backend-common``,
    ``web:farm-module``) which are not filename-safe for a
    ``.claude/agents/<name>.md`` target; every non-alphanumeric run
    collapses to one hyphen so the same service always maps to the same
    agent file.
    """
    slug = "".join(ch if ch.isalnum() else "-" for ch in service.strip().lower())
    while "--" in slug:
        slug = slug.replace("--", "-")
    return f"aria-svc-{slug.strip('-')}-auditor"


def service_auditor_capability_key(service: str) -> str:
    return f"{SERVICE_AUDITOR_CAPABILITY_PREFIX}{service}"


def propose_service_auditor_requests(
    *,
    cycle_id: str,
    base_dir: str | Path,
    repo_root: str | Path,
    threshold: int | None = None,
) -> dict[str, Any]:
    """Mint agent-genesis requests for services whose open-finding count
    crossed the policy threshold.

    ``repo_root`` anchors both the policy override
    (``aria-config/genesis_policy.json``) and the existing-agent check —
    an agent that already exists on disk must suppress the request even
    when its genesis request rows were pruned.
    ``threshold=None`` reads ``service_auditor_threshold`` from the
    merged genesis policy (default 25).
    """
    policy = load_policy(repo_root)
    if not policy.get("enable_request_generation", True):
        # Same operator kill-switch the learning genesis hook honours —
        # a disabled genesis lane must silence EVERY request producer,
        # not just the capability-gap one.
        return {
            "schema_version": 1,
            "cycle_id": cycle_id,
            "status": "skipped",
            "reason": "genesis_disabled",
        }
    if threshold is None:
        threshold = int(policy["service_auditor_threshold"])

    open_rows = list_findings(status="open", base_dir=base_dir)
    per_service: dict[str, list[dict[str, Any]]] = {}
    for row in open_rows:
        # A multi-service finding counts toward EACH service it cites:
        # the finding is evidence of sickness in every service it names,
        # and collapsing it to one would undercount the others.
        for service in services_for_finding_row(row):
            per_service.setdefault(service, []).append(row)

    already_requested = existing_genesis_request_keys(base_dir=base_dir)
    requests_emitted: list[dict[str, Any]] = []
    suppressed: list[dict[str, Any]] = []
    item_failures: list[dict[str, Any]] = []
    eligible: list[tuple[str, list[dict[str, Any]], str, str]] = []
    for service in sorted(per_service):
        rows = per_service[service]
        if len(rows) < threshold:
            continue
        target_agent = service_auditor_agent_name(service)
        capability_key = service_auditor_capability_key(service)
        if resolve_agent_md_path(target_agent, Path(repo_root)) is not None:
            suppressed.append({
                "service": service,
                "target_agent": target_agent,
                "reason": "existing_agent",
            })
            continue
        if capability_key in already_requested:
            suppressed.append({
                "service": service,
                "target_agent": target_agent,
                "reason": "pending_request",
            })
            continue
        eligible.append((service, rows, target_agent, capability_key))

    # ``max_requests_per_cycle`` is a genesis-lane cap, not a
    # capability-gap-producer cap: a second request producer that ignored
    # it would make the operator's configured ceiling untrue by silently
    # minting requests above it. Suppressed services never spend cap
    # budget (they mint nothing), and the sickest services are kept first
    # so a capped night still buys the worst offenders their auditor;
    # the rest re-qualify next cycle because the trigger is stateless.
    cap = int(policy.get("max_requests_per_cycle", 5))
    ranked = sorted(eligible, key=lambda item: (-len(item[1]), item[0]))
    capped = ranked[:cap]
    for service, rows, target_agent, capability_key in capped:
        # Per-service containment (learning batch idiom): one service's
        # bad rows must not cost the other services their requests, and
        # a partial batch must surface as partial, not silently ok.
        guard_item(
            item_failures,
            item_kind="service_auditor_request",
            item_id=service,
            work=lambda service=service, rows=rows, target_agent=target_agent, capability_key=capability_key: _mint_request(
                service=service,
                rows=rows,
                target_agent=target_agent,
                capability_key=capability_key,
                cycle_id=cycle_id,
                base_dir=base_dir,
                requests_emitted=requests_emitted,
            ),
        )

    # E14-b (ORPHAN-697) — the architecture organ's first production
    # producers, riding the SAME threshold event that mints the auditor
    # request (E15-c's declared neighbour). A sick service gets both a
    # reviewer AND an architecture picture: an option-set (what could be
    # done) and an evidence pack (what we can already prove). Packs missing
    # authoritative refs record status="blocked" — an honestly-blocked pack
    # names its gaps; the ADR draft stays a deliberate operator/CLI act.
    architecture_rows: list[dict[str, Any]] = []
    for service, rows, target_agent, capability_key in capped:
        guard_item(
            item_failures,
            item_kind="service_architecture_evidence",
            item_id=service,
            work=lambda service=service, rows=rows: architecture_rows.append(
                _mint_architecture_evidence(
                    service=service, rows=rows, threshold=threshold,
                    cycle_id=cycle_id, base_dir=base_dir,
                )
            ),
        )

    return with_item_failures({
        "schema_version": 1,
        "cycle_id": cycle_id,
        "status": "ok",
        "threshold": threshold,
        "open_finding_count": len(open_rows),
        "service_counts": {service: len(rows) for service, rows in sorted(per_service.items())},
        "eligible_count": len(eligible),
        "capped_count": max(0, len(eligible) - len(capped)),
        "requested_count": len(requests_emitted),
        "requests": requests_emitted,
        "suppressed": suppressed,
        "architecture_evidence": architecture_rows,
    }, item_failures)


def _mint_architecture_evidence(
    *,
    service: str,
    rows: list[dict[str, Any]],
    threshold: int,
    cycle_id: str,
    base_dir: str | Path,
) -> dict[str, Any]:
    from .architecture import (
        generate_architecture_options,
        record_architecture_evidence_pack,
    )

    # Path extraction rides the SSoT collector (İ1) — feedback-store rows
    # carry `path`, repo findings carry scope.files/evidences; the
    # dimension collector already speaks both.
    from .service_dimension import finding_dimension_paths

    scope_refs: list[str] = []
    adr_refs: list[str] = []
    for row in rows:
        # feedback-store rows nest the tool finding under "finding"; the
        # collector reads the finding document itself.
        doc = row.get("finding") if isinstance(row.get("finding"), dict) else row
        for path in finding_dimension_paths(doc):
            if isinstance(path, str) and path.strip():
                scope_refs.append(path)
                if path.startswith("docs/adr/"):
                    adr_refs.append(path)
    # Bounded, deterministic evidence: the twelve most-cited paths.
    from collections import Counter

    ranked = [path for path, _count in Counter(scope_refs).most_common(12)]
    option_set = generate_architecture_options(
        technology=f"service:{service}",
        evidence_refs=ranked,
        root_cause=(
            f"{len(rows)} open findings crossed the service-auditor "
            f"threshold ({threshold}) for {service}"
        ),
        authoritative_refs=sorted(set(adr_refs)),
        cycle_id=cycle_id,
        base_dir=base_dir,
    )
    evidence_pack = record_architecture_evidence_pack(
        technology=f"service:{service}",
        repo_fit_refs=ranked,
        current_stable_refs=ranked[:5],
        authoritative_refs=sorted(set(adr_refs)),
        migration_risk=(
            f"finding-density remediation for {service}; risk scales with "
            f"the {len(rows)} open findings' blast radius"
        ),
        repo_value=(
            f"service {service} carries {len(rows)} open findings; an "
            f"architecture decision here pays down the densest debt cluster"
        ),
        cycle_id=cycle_id,
        base_dir=base_dir,
    )
    return {
        "service": service,
        "option_set_id": option_set.get("option_set_id"),
        "evidence_pack_id": evidence_pack.get("evidence_pack_id"),
        "evidence_pack_status": evidence_pack.get("status"),
    }


def _mint_request(
    *,
    service: str,
    rows: list[dict[str, Any]],
    target_agent: str,
    capability_key: str,
    cycle_id: str,
    base_dir: str | Path,
    requests_emitted: list[dict[str, Any]],
) -> dict[str, Any]:
    top_classes = _top_finding_classes(rows)
    gap = {
        # gap_id carries the cycle for audit; capability_gap_key stays
        # cycle-free so the dedup set recognises the service next night.
        "gap_id": f"svc-auditor:{cycle_id}:{service}",
        "gap_type": "agent_gap",
        "capability_gap_key": capability_key,
        "title": (
            f"{target_agent}: service '{service}' carries {len(rows)} open tool "
            f"findings (top classes: {', '.join(top_classes)})"
        ),
        "evidence_refs": _evidence_refs(rows),
        "score": min(100, len(rows)),
    }
    row = request_agent_genesis(gap, base_dir=base_dir, cycle_id=cycle_id)
    requests_emitted.append(row)
    append_tools_governance(
        base_dir,
        "service_auditor_request_emitted",
        {
            "cycle_id": cycle_id,
            "service": service,
            "target_agent": target_agent,
            "capability_gap_key": capability_key,
            "open_finding_count": len(rows),
            "top_finding_classes": top_classes,
        },
    )
    return row


def _top_finding_classes(rows: list[dict[str, Any]]) -> list[str]:
    """Most frequent adapter rule ids, ties broken alphabetically.

    ``rule`` is the finding-class axis ``finding_fingerprint`` already
    normalises on; the same lowercase/strip normalisation keeps the two
    views of "class" from drifting apart.
    """
    counts: Counter[str] = Counter(
        str((row.get("finding") or {}).get("rule") or "unknown").strip().lower()
        for row in rows
    )
    ranked = sorted(counts.items(), key=lambda item: (-item[1], item[0]))
    return [rule for rule, _count in ranked[:TOP_FINDING_CLASS_COUNT]]


def _evidence_refs(rows: list[dict[str, Any]]) -> list[str]:
    """Distinct cited paths across the service's findings, capped.

    Reuses the E15-a path collector so the request's evidence is exactly
    the path set the service dimension itself was derived from.
    """
    refs: list[str] = []
    seen: set[str] = set()
    for row in rows:
        for path in finding_dimension_paths(row.get("finding") or {}):
            if path not in seen:
                seen.add(path)
                refs.append(path)
            if len(refs) >= _EVIDENCE_REF_CAP:
                return refs
    return refs
