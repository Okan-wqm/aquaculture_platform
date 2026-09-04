"""Plan 033 followup — the producer that turns passive pack output into assurance.

WHY this module exists: Plan 033 shipped every read side of the security lane
(profile, packs, graph, coverage, doctor, fitness) and no WRITE side.
`assurance.record_assurance` had zero non-test callers, so `security coverage`
folded 34 applicable cells against an empty ledger and reported all 34
NOT_TESTED forever. The lane could describe itself but never measure itself.

The honest part is the STATUS MAPPING, and it is deliberately conservative:

  * A pack rule that ran and found nothing is real evidence, but only for what
    a static rule can prove. For a STATIC_DETERMINISTIC claim (an RLS policy
    either exists in the schema or it does not) a clean run IS the proof, and
    the cell becomes TESTED_NO_VIOLATION with a matching static proof row.
  * For an ACTIVE_DUAL claim (an authorization bypass is a runtime property)
    a clean passive rule proves nothing about the running system, so the cell
    is INCONCLUSIVE — never TESTED_NO_VIOLATION. Only a lab campaign with two
    independent executors can clear it.
  * A lead on a STATIC_DETERMINISTIC claim confirms; a lead on an ACTIVE_DUAL
    claim is INCONCLUSIVE until `reproduction.dual_reproduce` says otherwise.

So this producer can move cells to a real verdict without a lab, and it cannot
manufacture a clean bill of health for anything a lab is required to prove.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from . import assurance as A
from . import packs as P
from . import reproduction as R

# Which claim each control is really asserting. The proof class follows from
# the claim (reproduction.proof_class_for), which is why this is the only
# mapping the producer needs.
CONTROL_CLAIM_TYPES: dict[str, str] = {
    "multi_tenant/rls_coverage": "rls_gap",
    "api/public_write_guard": "authz_bypass",
}


def _asset_of(code_ref: str) -> str | None:
    """`apps/<service>/...` -> `service:<service>`; anything else has no asset."""
    parts = str(code_ref).split("/")
    if len(parts) >= 2 and parts[0] == "apps" and parts[1]:
        return f"service:{parts[1]}"
    return None


def assess(*, workspace_root: str | Path, profile_row: dict[str, Any],
           base_dir: str | Path | None = None, record: bool = True) -> dict[str, Any]:
    """Run every applicable pack and fold the result into the assurance ledger."""
    manifests = P.select_packs(profile_row)
    applicable = [m for m in manifests if m.applicable]
    profile_digest = str(profile_row.get("profile_digest") or "unknown")
    target_sha = str(profile_row.get("repo_sha") or "unknown")

    # (pack, rule_id) -> {asset_id: [lead, ...]}
    leads_by_control: dict[str, dict[str, list[P.Lead]]] = {}
    for manifest in applicable:
        for lead in P.run_pack(manifest.name, workspace_root=workspace_root, profile_row=profile_row):
            control = f"{manifest.name}/{lead.rule_id.split('.', 1)[0]}"
            for ref in lead.code_refs:
                asset = _asset_of(ref)
                if asset:
                    leads_by_control.setdefault(control, {}).setdefault(asset, []).append(lead)

    digest_by_pack = {m.name: m.digest for m in manifests}
    rows: list[dict[str, Any]] = []
    for cell in A.applicable_cells(profile_row=profile_row, pack_manifests=manifests):
        claim = CONTROL_CLAIM_TYPES.get(cell.control_id)
        proof_class = R.proof_class_for(claim) if claim else "HUMAN_REQUIRED"
        hits = leads_by_control.get(cell.control_id, {}).get(cell.asset_id, [])
        if proof_class == "STATIC_DETERMINISTIC":
            status = "VULNERABILITY_CONFIRMED" if hits else "TESTED_NO_VIOLATION"
            detail = "static prover found a violation" if hits else "static prover ran clean"
        elif hits:
            status = "INCONCLUSIVE"
            detail = "passive lead awaiting dual-executor reproduction in a lab"
        else:
            status = "INCONCLUSIVE"
            detail = "passive rule clean; ACTIVE_DUAL confirmation needs a lab campaign"
        row = {
            "asset_id": cell.asset_id, "control_id": cell.control_id, "status": status,
            "claim_type": claim, "proof_class": proof_class, "lead_count": len(hits), "detail": detail,
        }
        rows.append(row)
        if not record:
            continue
        pack_name = cell.control_id.split("/", 1)[0]
        A.record_assurance(
            asset_id=cell.asset_id, control_id=cell.control_id, status=status,
            profile_digest=profile_digest, pack_digest=digest_by_pack.get(pack_name, "unknown"),
            evidence_ref=f"pack:{cell.control_id}:{len(hits)}", base_dir=base_dir,
        )
        if proof_class == "STATIC_DETERMINISTIC" and claim:
            # The static prover's own row: a repo-verified deterministic verdict,
            # which is what lets readiness count this cell without a lab.
            R.static_prove(
                claim_type=claim, prover_id=f"pack:{cell.control_id}", violated=bool(hits),
                evidence_digest=digest_by_pack.get(pack_name, "sha256:unknown"),
                target_sha=target_sha, base_dir=base_dir,
            )

    by_status: dict[str, int] = {}
    for row in rows:
        by_status[row["status"]] = by_status.get(row["status"], 0) + 1
    return {
        "schema_version": 1, "profile_digest": profile_digest, "recorded": bool(record),
        "packs_applicable": [m.name for m in applicable], "cells": rows, "by_status": by_status,
        "coverage": A.compute_coverage(profile_row=profile_row, pack_manifests=manifests, base_dir=base_dir),
    }


__all__ = ["CONTROL_CLAIM_TYPES", "assess"]
