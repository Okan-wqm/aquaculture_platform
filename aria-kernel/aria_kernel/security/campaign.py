"""Plan 033 Faz 033e — SecurityCampaignRun: one execution, one state machine, fixed input order.

WHY: a mission is a long-lived intent; a campaign run is ONE bounded execution. The
order is fixed and enforced: profile → pack digests → graph digest (fresh) → lab
attestation → signed grant → execution → evidence seal → teardown receipt → CLOSED.
Cleanup failure never reaches CLOSED (QUARANTINED + HUMAN_REQUIRED instead). The
kill switch runs a fixed sequence: stop new traffic → revoke credentials → kill the
process tree → seal evidence → reconcile mutations → teardown.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from ..ledger import append_declared_jsonl, load_declared_jsonl
from ..tool_registry import append_tools_governance, ensure_tools_dir, utc_now
from . import attack_graph as AG
from . import lab as L

CAMPAIGN_SURFACE = "security_campaigns"
CAMPAIGN_RELPATH: tuple[str, ...] = ("security", "campaigns.jsonl")
STATES = (
    "PLANNED", "SCOPE_VALIDATED", "LAB_PROVISIONING", "LAB_ATTESTED", "GRANT_ACTIVE", "EXECUTING",
    "REPLAY_VALIDATING", "EVIDENCE_SEALED", "CLEANUP_VERIFIED", "CLOSED",
    "HUMAN_REQUIRED", "STOPPING", "ABORTED", "QUARANTINED",
)
TERMINAL = ("CLOSED", "QUARANTINED")
TRANSITIONS: dict[str, tuple[str, ...]] = {
    "PLANNED": ("SCOPE_VALIDATED", "ABORTED", "HUMAN_REQUIRED"),
    "SCOPE_VALIDATED": ("LAB_PROVISIONING", "ABORTED"),
    "LAB_PROVISIONING": ("LAB_ATTESTED", "ABORTED", "QUARANTINED"),
    "LAB_ATTESTED": ("GRANT_ACTIVE", "ABORTED"),
    "GRANT_ACTIVE": ("EXECUTING", "STOPPING", "ABORTED"),
    "EXECUTING": ("REPLAY_VALIDATING", "STOPPING", "HUMAN_REQUIRED"),
    "REPLAY_VALIDATING": ("EVIDENCE_SEALED", "STOPPING", "HUMAN_REQUIRED"),
    "EVIDENCE_SEALED": ("CLEANUP_VERIFIED", "QUARANTINED"),
    "CLEANUP_VERIFIED": ("CLOSED",),
    "STOPPING": ("EVIDENCE_SEALED", "QUARANTINED"),
    "HUMAN_REQUIRED": ("EXECUTING", "STOPPING", "ABORTED"),
    "ABORTED": ("EVIDENCE_SEALED", "QUARANTINED"),
    "CLOSED": (),
    "QUARANTINED": (),
}
# inputs each state REQUIRES to have been bound (in order) before it can be entered
REQUIRED_INPUTS: dict[str, tuple[str, ...]] = {
    "SCOPE_VALIDATED": ("profile_digest", "pack_digests", "policy_digest"),
    "LAB_ATTESTED": ("graph_digest", "lease_id", "lab_attestation_digest"),
    "GRANT_ACTIVE": ("grant_jti", "grant_digest"),
    "EVIDENCE_SEALED": ("evidence_manifest_digest",),
}


class CampaignError(ValueError):
    pass


@dataclass
class CampaignRun:
    campaign_run_id: str
    mission_id: str | None
    packs: tuple[str, ...]
    state: str = "PLANNED"
    inputs: dict[str, Any] = field(default_factory=dict)
    history: list[tuple[str, str, str]] = field(default_factory=list)  # (from, to, at)


def _path(base_dir: str | Path | None) -> Path:
    p = ensure_tools_dir(base_dir).joinpath(*CAMPAIGN_RELPATH)
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def _append(base_dir: str | Path | None, row: dict[str, Any]) -> None:
    append_declared_jsonl(_path(base_dir), {"schema_version": 1, "recorded_at": utc_now(), **row}, expected_surface=CAMPAIGN_SURFACE)


def open_campaign(*, packs: tuple[str, ...], mission_id: str | None = None, base_dir: str | Path | None = None) -> CampaignRun:
    if not packs:
        raise CampaignError("a campaign needs at least one pack")
    run = CampaignRun(campaign_run_id="scr-" + uuid.uuid4().hex[:12], mission_id=mission_id, packs=tuple(packs))
    _append(base_dir, {"event": "opened", "campaign_run_id": run.campaign_run_id, "mission_id": mission_id, "packs": list(packs)})
    return run


def fold(campaign_run_id: str, *, base_dir: str | Path | None = None) -> CampaignRun | None:
    path = _path(base_dir)
    if not path.exists():
        return None
    run: CampaignRun | None = None
    for row in load_declared_jsonl(path, expected_surface=CAMPAIGN_SURFACE):
        if row.get("campaign_run_id") != campaign_run_id:
            continue
        if row.get("event") == "opened":
            run = CampaignRun(campaign_run_id=campaign_run_id, mission_id=row.get("mission_id"), packs=tuple(row.get("packs") or ()))
        elif run is not None and row.get("event") == "bind":
            run.inputs.update(row.get("inputs") or {})
        elif run is not None and row.get("event") == "transition":
            run.history.append((run.state, str(row.get("to")), str(row.get("recorded_at"))))
            run.state = str(row.get("to"))
    return run


def bind_inputs(run: CampaignRun, *, base_dir: str | Path | None = None, **inputs: Any) -> CampaignRun:
    """Inputs are write-once: rebinding a digest to a different value is a new campaign, not an edit."""
    for k, v in inputs.items():
        if k in run.inputs and run.inputs[k] != v:
            raise CampaignError(f"input {k!r} already bound to a different value; open a new campaign")
    run.inputs.update(inputs)
    _append(base_dir, {"event": "bind", "campaign_run_id": run.campaign_run_id, "inputs": inputs})
    return run


def transition(run: CampaignRun, to: str, *, base_dir: str | Path | None = None, reason: str = "") -> CampaignRun:
    if to not in STATES:
        raise CampaignError(f"unknown state {to!r}")
    if to not in TRANSITIONS[run.state]:
        raise CampaignError(f"{run.state} -> {to} is not a legal transition")
    missing = [k for k in REQUIRED_INPUTS.get(to, ()) if k not in run.inputs]
    if missing:
        raise CampaignError(f"{to} requires bound inputs {missing}")
    if to == "LAB_ATTESTED":
        graph_row = AG.latest_graph_row(base_dir=base_dir)
        if graph_row is None or graph_row.get("graph_digest") != run.inputs["graph_digest"] or AG.is_stale(graph_row):
            raise CampaignError("bound graph digest is not the latest recorded graph or is stale")
    if to == "CLEANUP_VERIFIED":
        if not L.teardown_verified(str(run.inputs.get("lease_id")), base_dir=base_dir):
            append_tools_governance(ensure_tools_dir(base_dir), "security_campaign_quarantined",
                                    {"campaign_run_id": run.campaign_run_id, "reason": "teardown not verified"})
            return transition(run, "QUARANTINED", base_dir=base_dir, reason="teardown not verified")
    if to == "CLOSED" and run.state != "CLEANUP_VERIFIED":
        raise CampaignError("CLOSED only after CLEANUP_VERIFIED")
    _append(base_dir, {"event": "transition", "campaign_run_id": run.campaign_run_id, "from": run.state, "to": to, "reason": reason})
    run.history.append((run.state, to, utc_now()))
    run.state = to
    return run


def kill_switch(run: CampaignRun, *, stop_traffic: Callable[[], None], revoke_credentials: Callable[[], int],
                kill_processes: Callable[[], None], seal_evidence: Callable[[], str], reconcile: Callable[[], bool],
                teardown: Callable[[], bool], base_dir: str | Path | None = None) -> list[str]:
    """Fixed order; every step is recorded; a failed teardown ends in QUARANTINED, never CLOSED."""
    if run.state in TERMINAL:
        raise CampaignError("campaign already terminal")
    steps: list[str] = []
    if run.state != "STOPPING":
        if "STOPPING" not in TRANSITIONS[run.state]:
            transition(run, "ABORTED", base_dir=base_dir, reason="kill switch")
        else:
            transition(run, "STOPPING", base_dir=base_dir, reason="kill switch")
    stop_traffic(); steps.append("stop_traffic")
    revoked = revoke_credentials(); steps.append(f"revoke_credentials:{revoked}")
    kill_processes(); steps.append("kill_processes")
    manifest = seal_evidence(); steps.append("seal_evidence")
    bind_inputs(run, base_dir=base_dir, evidence_manifest_digest=manifest)
    transition(run, "EVIDENCE_SEALED", base_dir=base_dir, reason="kill switch")
    reconciled = reconcile(); steps.append(f"reconcile:{reconciled}")
    torn = teardown(); steps.append(f"teardown:{torn}")
    if not (reconciled and torn):
        transition(run, "QUARANTINED", base_dir=base_dir, reason="reconcile/teardown failed")
        return steps
    transition(run, "CLEANUP_VERIFIED", base_dir=base_dir, reason="kill switch")
    if run.state == "CLEANUP_VERIFIED":
        transition(run, "CLOSED", base_dir=base_dir, reason="kill switch")
    return steps


def bind_to_mission(run: CampaignRun, *, grant_jti: str | None = None, base_dir: str | Path | None = None) -> dict[str, Any] | None:
    if not run.mission_id:
        return None
    from ..mission import bind_mission

    bindings: dict[str, list[str]] = {"campaign_run_ids": [run.campaign_run_id]}
    if grant_jti:
        bindings["grant_jtis"] = [grant_jti]
    return bind_mission(mission_id=run.mission_id, bindings=bindings, step_id=f"campaign:{run.campaign_run_id}", base_dir=base_dir)


__all__ = [
    "CAMPAIGN_RELPATH", "CAMPAIGN_SURFACE", "REQUIRED_INPUTS", "STATES", "TERMINAL", "TRANSITIONS", "CampaignError",
    "CampaignRun", "bind_inputs", "bind_to_mission", "fold", "kill_switch", "open_campaign", "transition",
]
