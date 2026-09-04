"""Plan 033 Faz 033g — dual-executor reproduction (ACTIVE_DUAL) + static prover.

WHY: a single run of an exploit is not proof. A security finding is CONFIRMED only
when TWO independent executors — separate service principals, separate clean labs —
run the SAME sealed recipe digest and BOTH observe the violation, each with a passing
positive control. Anything else (one green, a harness error, a shared principal or lab,
a recipe-digest mismatch) is not confirmation. For claim types that cannot be safely
exploited (secret_exposure, rls_gap, config drift) the proof class is
STATIC_DETERMINISTIC: a repo-verified prover gives a single deterministic verdict with
no lab at all. The LLM interprets; it never decides confirmation here.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..ledger import append_declared_jsonl, load_declared_jsonl
from ..tool_registry import ensure_tools_dir, utc_now
from .probe import CLAIM_TYPES

REPRODUCTION_SURFACE = "security_reproduction"
REPRODUCTION_RELPATH: tuple[str, ...] = ("security", "reproduction.jsonl")
PROOF_CLASSES = ("STATIC_DETERMINISTIC", "ACTIVE_DUAL", "HUMAN_REQUIRED")
# claim types proven statically (safe to prove by inspection, unsafe/pointless to exploit live)
STATIC_CLAIM_TYPES = ("secret_exposure", "rls_gap")
REPRODUCTION_OUTCOMES = ("CONFIRMED", "NOT_CONFIRMED", "HARNESS_ERROR", "HUMAN_REQUIRED")


class ReproductionError(ValueError):
    pass


@dataclass(frozen=True)
class ExecutorRun:
    executor_id: str
    lease_id: str
    recipe_digest: str
    verdict: str  # a probe.PROBE_VERDICTS value
    positive_control_ok: bool
    evidence_manifest_digest: str

    def validate(self) -> None:
        from .probe import PROBE_VERDICTS

        if self.verdict not in PROBE_VERDICTS:
            raise ReproductionError(f"unknown probe verdict {self.verdict!r}")
        if not self.evidence_manifest_digest.startswith("sha256:"):
            raise ReproductionError("each run must bind a sealed evidence manifest digest")


def proof_class_for(claim_type: str) -> str:
    if claim_type not in CLAIM_TYPES:
        raise ReproductionError(f"unknown claim type {claim_type!r}")
    return "STATIC_DETERMINISTIC" if claim_type in STATIC_CLAIM_TYPES else "ACTIVE_DUAL"


def _record(base_dir: str | Path | None, row: dict[str, Any]) -> dict[str, Any]:
    path = ensure_tools_dir(base_dir).joinpath(*REPRODUCTION_RELPATH)
    path.parent.mkdir(parents=True, exist_ok=True)
    return append_declared_jsonl(path, {"schema_version": 1, "recorded_at": utc_now(), **row}, expected_surface=REPRODUCTION_SURFACE)


def dual_reproduce(*, claim_type: str, recipe_digest: str, primary: ExecutorRun, replay: ExecutorRun,
                   base_dir: str | Path | None = None) -> dict[str, Any]:
    """Fold two executor runs into a reproduction outcome. Independence is enforced."""
    if proof_class_for(claim_type) != "ACTIVE_DUAL":
        raise ReproductionError(f"{claim_type} is not an ACTIVE_DUAL claim; use static_prove")
    primary.validate()
    replay.validate()
    if primary.recipe_digest != recipe_digest or replay.recipe_digest != recipe_digest:
        raise ReproductionError("both runs must execute the SAME sealed recipe digest")
    if primary.executor_id == replay.executor_id:
        raise ReproductionError("the two executors must be independent principals")
    if primary.lease_id == replay.lease_id:
        raise ReproductionError("the two runs must use two separate clean labs")
    if not (primary.positive_control_ok and replay.positive_control_ok):
        outcome, detail = "HARNESS_ERROR", "a positive control did not pass"
    elif primary.verdict == "VIOLATION_OBSERVED" and replay.verdict == "VIOLATION_OBSERVED":
        outcome, detail = "CONFIRMED", "both independent executors observed the violation"
    elif "HARNESS_ERROR" in (primary.verdict, replay.verdict) or "TARGET_UNAVAILABLE" in (primary.verdict, replay.verdict):
        outcome, detail = "HARNESS_ERROR", "a run errored or the target was unavailable"
    else:
        outcome, detail = "NOT_CONFIRMED", "the two runs did not agree on a violation"
    return _record(base_dir, {
        "event": "dual_reproduction", "proof_class": "ACTIVE_DUAL", "claim_type": claim_type,
        "recipe_digest": recipe_digest, "outcome": outcome, "detail": detail,
        "primary": primary.__dict__, "replay": replay.__dict__,
    })


def static_prove(*, claim_type: str, prover_id: str, violated: bool, evidence_digest: str, target_sha: str,
                 base_dir: str | Path | None = None) -> dict[str, Any]:
    """A repo-verified deterministic prover: one verdict, no lab, source-bound."""
    if proof_class_for(claim_type) != "STATIC_DETERMINISTIC":
        raise ReproductionError(f"{claim_type} is not a STATIC_DETERMINISTIC claim")
    if not evidence_digest.startswith("sha256:"):
        raise ReproductionError("static proof must bind an evidence digest")
    return _record(base_dir, {
        "event": "static_proof", "proof_class": "STATIC_DETERMINISTIC", "claim_type": claim_type,
        "prover_id": prover_id, "outcome": "CONFIRMED" if violated else "NOT_CONFIRMED",
        "evidence_digest": evidence_digest, "target_sha": target_sha,
    })


def is_confirmed(claim_type: str, recipe_digest: str, *, target_sha: str | None = None,
                 base_dir: str | Path | None = None) -> bool:
    path = ensure_tools_dir(base_dir).joinpath(*REPRODUCTION_RELPATH)
    if not path.exists():
        return False
    confirmed = False
    for row in load_declared_jsonl(path, expected_surface=REPRODUCTION_SURFACE):
        if row.get("claim_type") != claim_type:
            continue
        if row.get("event") == "dual_reproduction" and row.get("recipe_digest") == recipe_digest:
            confirmed = row.get("outcome") == "CONFIRMED"
        elif row.get("event") == "static_proof" and (target_sha is None or row.get("target_sha") == target_sha):
            confirmed = row.get("outcome") == "CONFIRMED"
    return confirmed


__all__ = ["PROOF_CLASSES", "REPRODUCTION_OUTCOMES", "REPRODUCTION_RELPATH", "REPRODUCTION_SURFACE",
           "STATIC_CLAIM_TYPES", "ExecutorRun", "ReproductionError", "dual_reproduce", "is_confirmed",
           "proof_class_for", "static_prove"]
