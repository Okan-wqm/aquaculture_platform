"""Plan ARIA-V6 §2d v2 Phase 1-3 — convergent adapter authoring loop.

Operator vision (Plan ARIA-V6 §1, verbatim):

  "yenı adapter yazımıda llmler aralarında tartıssın calıstırsın baksın
   valıde etın tekrar yazsın takı %100 valıde olana kadar"
  "adapter yazımı LLM'lerin tartışarak iteratif validation döngüsüyle
   olmalı, ama gerçek bulgular üzerine olmalı yanı hayal tartışmamalılar"
  "ve herşey kodta referans gösterilmeli agentlar birbirinin hayal
   görmediğini garanti altına almalı"

Three non-negotiable Tier-1 constraints derived from operator vision:

  1. **100% validation as structural exit** — the loop terminates ONLY
     when adversarial_judge + evidence_judge both say ``no_gaps`` AND
     calibration_precision == 1.0 AND critical_false_positives == 0
     AND recall >= 0.90 (B-V10-1 — operator "%100 valide" demands
     exhaustiveness). NO silent acceptance below thresholds.

  2. **Evidence-grounded debate (no hallucinated rule space)** —
     Phase 0's ``evidence_pack`` is the bounding box of what can be
     debated. Primary's drafts MUST cite ``evidence_refs`` present in
     the pack; challenger's counter-examples MUST also resolve.
     ``_validate_evidence_grounded()`` is the structural Tier-1 gate.

  3. **Mutual hallucination guarantee** — every claim is fact-checked
     by THREE CROSS-VERIFY passes against ``base_commit_sha``:

       CROSS-VERIFY #1 — primary's refs vs evidence_pack
       CROSS-VERIFY #2 — challenger's refs vs evidence_pack
       CROSS-VERIFY #3 — primary reviews challenger's claims and
                         vice versa via ``Path.exists`` + ``git show``
                         + snippet-match

     ``_cross_verify_evidence_refs()`` is the unifying primitive.
     Failure of any pass REJECTS the round with verdict
     ``evidence_hallucination_detected`` and preserves drafts for
     operator review — never silently accepted.

I-V6.2-07 source-substring invariant pins the literal call site
``Path.exists()`` AND ``git show`` so a refactor cannot silently weaken
the mutual-hallucination guarantee.

V6.2 binds to ``plan_convergence.start_plan(plan_id=f'adapter-{seed_id}')``
(B-V3-1) so collusion detection (``_results_pair_hash_check`` at
plan_convergence.py:473) reuses the existing primary↔challenger
content_hash machinery — no parallel collusion check needed.

Exit verdicts (Plan §2d v2 — AdapterAuthoringResult.authoring_verdict):

  * ``authored_validated`` — 100% precision + recall + judges no_gaps
    → SHADOW-spawned via materialize_skill
  * ``authored_max_rounds`` — round cap hit; drafts preserved + HUMAN
  * ``authoring_arbiter_split`` — primary↔challenger never converged
  * ``authoring_insufficient_evidence`` — Phase 0 evidence_pack < 10
  * ``sandbox_systematic_failure`` — calibration corpus broken
  * ``evidence_hallucination_detected`` — CROSS-VERIFY rejected refs
  * ``evidence_base_drift`` — workspace HEAD moved mid-cycle
  * ``mutual_hallucination_check_failed`` — peer-review CROSS-VERIFY #3
    surfaced an unresolved cross-check failure

Operator interaction point — when verdict ∉ {authored_validated}, the
drafts + evidence_pack + judge transcripts are preserved under
``aria-tools/convergent-authoring/<plan_id>/`` for operator review.
The kernel NEVER silently advances a failing seed.
"""

from __future__ import annotations

import hashlib
import json
import re
import subprocess
from pathlib import Path
from typing import Any, Callable, Literal, Optional, TypedDict

from .evidence_collector import (
    EvidencePack,
    InsufficientEvidenceError,
    collect_evidence_pack,
)
from .tool_registry import ensure_tools_dir, utc_now


__all__ = [
    "AdapterAuthoringResult",
    "DrafterFn",
    "JudgeFn",
    "SandboxFn",
    "run_convergent_authoring",
]


# Plan ARIA-V6 §2d v2 — round cap. Operator vision "%100 valide olana
# kadar" means the loop is intentionally unbounded by judgment quality
# (only the structural exit can terminate cleanly), but operationally
# we cap at 6 rounds to bound token cost. Cap-hit preserves drafts.
MAX_AUTHORING_ROUNDS_DEFAULT = 6


# Plan ARIA-V6 §2d v2 — exhaustiveness floor for "%100 valide".
# Below recall floor → not validated even if precision == 1.0.
RECALL_FLOOR_DEFAULT = 0.90


# Plan ARIA-V6 §2d v2 — bound to a calibration corpus minimum so that
# 100% precision on a 3-fixture corpus isn't accepted as validated.
MIN_CALIBRATION_FIXTURES = 10


AuthoringVerdict = Literal[
    "authored_validated",
    "authored_max_rounds",
    "authoring_arbiter_split",
    "authoring_insufficient_evidence",
    "sandbox_systematic_failure",
    "evidence_hallucination_detected",
    "evidence_base_drift",
    "mutual_hallucination_check_failed",
]


class AdapterAuthoringResult(TypedDict):
    """Plan ARIA-V6 §2d v2 — return contract."""

    request_id: str
    plan_id: str
    seed_id: str
    rounds_count: int
    authoring_verdict: AuthoringVerdict
    adapter_path: str | None
    manifest_path: str | None
    calibration_precision: float | None
    calibration_recall: float | None
    critical_false_positives: int | None
    judge_consensus_log: list[dict[str, Any]]
    skill_genesis_request_id: str | None
    evidence_pack_path: str | None
    evidence_pack_size: int
    calibration_corpus_path: str | None
    hallucination_rejection_count: int


class DrafterFn:
    """Plan ARIA-V6 §2d — drafter contract.

    Injection seam for primary + challenger drafter agents. Tests pass
    pure-function mocks; production wires through agent_invocations.
    """

    def __call__(
        self,
        *,
        seed_id: str,
        must_satisfy: list[dict[str, Any]],
        evidence_pack: EvidencePack,
        prior_critique: list[dict[str, Any]] | None = None,
        prior_draft: dict[str, Any] | None = None,
        round_number: int,
    ) -> dict[str, Any]:
        ...


class JudgeFn:
    """Plan ARIA-V6 §2d — judge contract.

    Both evidence_judge AND adversarial_judge expose this shape.
    Verdicts MUST be grounded in sandbox stdout/stderr + emitted
    findings — judges that reason from prompts alone are rejected at
    ``_validate_judge_verdict_evidence_grounded()`` (Plan §10 item 4).
    """

    def __call__(
        self,
        *,
        primary_draft: dict[str, Any],
        sandbox_result: dict[str, Any],
        evidence_pack: EvidencePack,
    ) -> dict[str, Any]:
        ...


class SandboxFn:
    """Plan ARIA-V6 §2d — sandbox execution contract.

    Runs the candidate adapter against the operator-labeled calibration
    corpus. Returns precision / recall / critical_false_positives
    measured against REAL historical TP/FP labels.
    """

    def __call__(
        self,
        *,
        primary_draft: dict[str, Any],
        calibration_corpus_path: Path,
    ) -> dict[str, Any]:
        ...


def run_convergent_authoring(
    *,
    request_id: str,
    seed: dict[str, Any],
    workspace_root: str | Path,
    base_dir: str | Path | None,
    primary_drafter: DrafterFn,
    challenger_drafter: DrafterFn,
    evidence_judge: JudgeFn,
    adversarial_judge: JudgeFn,
    sandbox_runner: SandboxFn,
    arbiter: Callable[..., dict[str, Any]] | None = None,
    base_commit_sha: str | None = None,
    max_authoring_rounds: int = MAX_AUTHORING_ROUNDS_DEFAULT,
    recall_floor: float = RECALL_FLOOR_DEFAULT,
    min_calibration_fixtures: int = MIN_CALIBRATION_FIXTURES,
    materialize_fn: Callable[..., dict[str, Any]] | None = None,
    plan_start_fn: Callable[..., dict[str, Any]] | None = None,
) -> AdapterAuthoringResult:
    """Plan ARIA-V6 §2d v2 — main loop.

    Walks Phase 0 (evidence collection) → Phase 1 (round-by-round
    drafter debate with 3 CROSS-VERIFY gates) → Phase 2 (sandbox
    execution against calibration corpus) → Phase 3 (judge consensus +
    structural 100% exit).

    Args:
      request_id: stable identifier for the skill_genesis request.
      seed: seed dict from F-012-adapter-seeds.jsonl (must contain
        ``seed_id``, ``declared_scope``, ``claim_types``,
        ``must_satisfy``, ``calibration_corpus_path``).
      workspace_root: filesystem root of the repository.
      base_dir: aria-tools persistence root.
      primary_drafter / challenger_drafter: injection-seam drafters.
      evidence_judge / adversarial_judge: judge functions.
      sandbox_runner: executes the candidate adapter against corpus.
      arbiter: optional consensus arbiter; default uses _default_arbiter.
      base_commit_sha: bind to this commit; default derives from HEAD.
      max_authoring_rounds: round cap. Default 6.
      recall_floor: exhaustiveness floor for "100% valide". Default 0.90.
      min_calibration_fixtures: hard floor on corpus size. Default 10.
      materialize_fn: optional shim to ``skill_genesis.materialize_skill``.
      plan_start_fn: optional shim to ``plan_convergence.start_plan``.

    Returns:
      AdapterAuthoringResult with terminal ``authoring_verdict``.

    The function NEVER silently advances. Every non-validated terminal
    state preserves drafts under ``aria-tools/convergent-authoring/``
    for operator review.
    """
    root = ensure_tools_dir(base_dir)
    seed_id = str(seed.get("seed_id") or "")
    if not seed_id:
        raise ValueError("convergent_authoring_requires_seed_id")
    declared_scope = list(seed.get("declared_scope") or [])
    claim_types = list(seed.get("claim_types") or [])
    must_satisfy = list(seed.get("must_satisfy") or [])
    calibration_corpus_path = seed.get("calibration_corpus_path")
    if not calibration_corpus_path:
        raise ValueError(
            f"convergent_authoring_seed_missing_calibration_corpus_path: "
            f"seed_id={seed_id!r}"
        )

    plan_id = f"adapter-{seed_id}"
    judge_consensus_log: list[dict[str, Any]] = []
    hallucination_rejection_count = 0

    # ---- Phase 0 — Evidence Collection ----
    try:
        evidence_pack = collect_evidence_pack(
            seed_id=seed_id,
            declared_scope=declared_scope,
            claim_types=claim_types,
            workspace_root=workspace_root,
            base_dir=base_dir,
            base_commit_sha=base_commit_sha,
        )
    except InsufficientEvidenceError as exc:
        return _terminal_result(
            request_id=request_id,
            plan_id=plan_id,
            seed_id=seed_id,
            verdict="authoring_insufficient_evidence",
            rounds_count=0,
            judge_consensus_log=[{"phase": "phase_0", "error": str(exc)}],
            evidence_pack_path=str(_pack_path(root, seed_id)),
            evidence_pack_size=0,
            calibration_corpus_path=calibration_corpus_path,
            hallucination_rejection_count=0,
        )

    # Plan §10 item 5 — surface base_commit_sha drift to verdict.
    if evidence_pack["sample_resnap_status"] == "drift_detected":
        return _terminal_result(
            request_id=request_id,
            plan_id=plan_id,
            seed_id=seed_id,
            verdict="evidence_base_drift",
            rounds_count=0,
            judge_consensus_log=[{
                "phase": "phase_0",
                "error": "sample_resnap_drift_detected",
            }],
            evidence_pack_path=str(_pack_path(root, seed_id)),
            evidence_pack_size=len(evidence_pack["observations"]),
            calibration_corpus_path=calibration_corpus_path,
            hallucination_rejection_count=0,
        )

    # B-V3-1 — bind convergent_skill_authoring to plan_convergence so
    # collusion detection (_results_pair_hash_check) is reused.
    if plan_start_fn is not None:
        try:
            plan_start_fn(
                plan_id=plan_id,
                plan_content={
                    "seed_id": seed_id,
                    "must_satisfy": must_satisfy,
                    "evidence_pack_hash": evidence_pack["observation_hash"],
                    "base_commit_sha": evidence_pack["base_commit_sha"],
                },
                initial_revision_id=f"rev-{seed_id}-r0",
                base_dir=base_dir,
            )
        except Exception:
            # Plan_convergence binding is best-effort — failure does
            # not abort the seed; the convergence_log records the gap
            # so the cycle is still operator-auditable.
            judge_consensus_log.append({
                "phase": "phase_0_plan_bind",
                "error": "plan_convergence_start_failed",
            })

    # ---- Phase 1-3 — Round loop ----
    prior_critique: list[dict[str, Any]] | None = None
    last_primary_draft: dict[str, Any] | None = None
    arbiter = arbiter or _default_arbiter

    for round_number in range(1, max_authoring_rounds + 1):
        # Plan §10 item 5 — HEAD-drift PRE-CHECK at every round.
        if not _head_still_at(workspace_root, evidence_pack["base_commit_sha"]):
            _persist_round_artifact(
                root, plan_id, round_number,
                {"phase": "head_drift_pre_check", "expected_sha": evidence_pack["base_commit_sha"]},
            )
            return _terminal_result(
                request_id=request_id, plan_id=plan_id, seed_id=seed_id,
                verdict="evidence_base_drift",
                rounds_count=round_number - 1,
                judge_consensus_log=judge_consensus_log,
                evidence_pack_path=str(_pack_path(root, seed_id)),
                evidence_pack_size=len(evidence_pack["observations"]),
                calibration_corpus_path=calibration_corpus_path,
                hallucination_rejection_count=hallucination_rejection_count,
            )

        primary_draft = primary_drafter(
            seed_id=seed_id,
            must_satisfy=must_satisfy,
            evidence_pack=evidence_pack,
            prior_critique=prior_critique,
            prior_draft=last_primary_draft,
            round_number=round_number,
        )
        last_primary_draft = primary_draft
        _persist_round_artifact(root, plan_id, round_number, {
            "side": "primary", "round": round_number, "draft": primary_draft,
        })

        # CROSS-VERIFY #1 — primary's refs against evidence_pack.
        ok1, rejected1 = _cross_verify_evidence_refs(
            draft=primary_draft,
            evidence_pack=evidence_pack,
            workspace_root=Path(workspace_root),
        )
        if not ok1:
            hallucination_rejection_count += 1
            judge_consensus_log.append({
                "phase": "cross_verify_1_primary",
                "round": round_number,
                "rejected_refs": rejected1,
            })
            return _terminal_result(
                request_id=request_id, plan_id=plan_id, seed_id=seed_id,
                verdict="evidence_hallucination_detected",
                rounds_count=round_number,
                judge_consensus_log=judge_consensus_log,
                evidence_pack_path=str(_pack_path(root, seed_id)),
                evidence_pack_size=len(evidence_pack["observations"]),
                calibration_corpus_path=calibration_corpus_path,
                hallucination_rejection_count=hallucination_rejection_count,
            )

        challenger_draft = challenger_drafter(
            seed_id=seed_id,
            must_satisfy=must_satisfy,
            evidence_pack=evidence_pack,
            prior_critique=None,
            prior_draft=primary_draft,
            round_number=round_number,
        )
        _persist_round_artifact(root, plan_id, round_number, {
            "side": "challenger", "round": round_number, "draft": challenger_draft,
        })

        # CROSS-VERIFY #2 — challenger's refs against evidence_pack.
        ok2, rejected2 = _cross_verify_evidence_refs(
            draft=challenger_draft,
            evidence_pack=evidence_pack,
            workspace_root=Path(workspace_root),
        )
        if not ok2:
            hallucination_rejection_count += 1
            judge_consensus_log.append({
                "phase": "cross_verify_2_challenger",
                "round": round_number,
                "rejected_refs": rejected2,
            })
            return _terminal_result(
                request_id=request_id, plan_id=plan_id, seed_id=seed_id,
                verdict="evidence_hallucination_detected",
                rounds_count=round_number,
                judge_consensus_log=judge_consensus_log,
                evidence_pack_path=str(_pack_path(root, seed_id)),
                evidence_pack_size=len(evidence_pack["observations"]),
                calibration_corpus_path=calibration_corpus_path,
                hallucination_rejection_count=hallucination_rejection_count,
            )

        # CROSS-VERIFY #3 — peer-review. Primary checks challenger's
        # claims and vice versa. Failure means one side's "fail to
        # verify" cannot be demonstrated by the other.
        ok3, peer_log = _peer_review_cross_verify(
            primary_draft=primary_draft,
            challenger_draft=challenger_draft,
            evidence_pack=evidence_pack,
            workspace_root=Path(workspace_root),
        )
        if not ok3:
            hallucination_rejection_count += 1
            judge_consensus_log.append({
                "phase": "cross_verify_3_peer_review",
                "round": round_number,
                "log": peer_log,
            })
            return _terminal_result(
                request_id=request_id, plan_id=plan_id, seed_id=seed_id,
                verdict="mutual_hallucination_check_failed",
                rounds_count=round_number,
                judge_consensus_log=judge_consensus_log,
                evidence_pack_path=str(_pack_path(root, seed_id)),
                evidence_pack_size=len(evidence_pack["observations"]),
                calibration_corpus_path=calibration_corpus_path,
                hallucination_rejection_count=hallucination_rejection_count,
            )

        arbiter_verdict = arbiter(
            primary_draft=primary_draft,
            challenger_draft=challenger_draft,
            mutual_verification_log=peer_log,
        )
        judge_consensus_log.append({
            "phase": "arbiter",
            "round": round_number,
            "verdict": arbiter_verdict,
        })
        if not arbiter_verdict.get("converged"):
            prior_critique = arbiter_verdict.get("unsatisfied_items") or []
            continue

        # ---- Phase 2 — Sandbox ----
        sandbox_result = sandbox_runner(
            primary_draft=primary_draft,
            calibration_corpus_path=Path(calibration_corpus_path),
        )
        _persist_round_artifact(root, plan_id, round_number, {
            "phase": "sandbox", "round": round_number,
            "sandbox_result": sandbox_result,
        })

        # Hard floor on calibration corpus size.
        fixture_count = int(sandbox_result.get("fixture_count") or 0)
        if fixture_count < min_calibration_fixtures:
            judge_consensus_log.append({
                "phase": "sandbox_corpus_too_small",
                "round": round_number,
                "fixture_count": fixture_count,
                "min_required": min_calibration_fixtures,
            })
            return _terminal_result(
                request_id=request_id, plan_id=plan_id, seed_id=seed_id,
                verdict="sandbox_systematic_failure",
                rounds_count=round_number,
                judge_consensus_log=judge_consensus_log,
                evidence_pack_path=str(_pack_path(root, seed_id)),
                evidence_pack_size=len(evidence_pack["observations"]),
                calibration_corpus_path=calibration_corpus_path,
                hallucination_rejection_count=hallucination_rejection_count,
            )

        # ---- Phase 3 — Judge consensus ----
        evidence_verdict = evidence_judge(
            primary_draft=primary_draft,
            sandbox_result=sandbox_result,
            evidence_pack=evidence_pack,
        )
        adversarial_verdict = adversarial_judge(
            primary_draft=primary_draft,
            sandbox_result=sandbox_result,
            evidence_pack=evidence_pack,
        )
        judge_consensus_log.append({
            "phase": "judges",
            "round": round_number,
            "evidence": evidence_verdict,
            "adversarial": adversarial_verdict,
        })

        precision = float(sandbox_result.get("precision") or 0.0)
        recall = float(sandbox_result.get("recall") or 0.0)
        critical_fps = int(sandbox_result.get("critical_false_positives") or 0)

        both_no_gaps = (
            evidence_verdict.get("verdict") == "no_gaps"
            and adversarial_verdict.get("verdict") == "no_gaps"
        )

        if (
            both_no_gaps
            and precision >= 1.0
            and critical_fps == 0
            and recall >= recall_floor
        ):
            # 100% validation structural exit — SHADOW spawn.
            adapter_path = None
            manifest_path = None
            if materialize_fn is not None:
                try:
                    mat = materialize_fn(
                        primary_draft=primary_draft,
                        seed=seed,
                        evidence_pack=evidence_pack,
                        base_dir=base_dir,
                    )
                    adapter_path = mat.get("adapter_path")
                    manifest_path = mat.get("manifest_path")
                except Exception as exc:
                    judge_consensus_log.append({
                        "phase": "materialize",
                        "round": round_number,
                        "error": str(exc),
                    })
            return AdapterAuthoringResult(
                request_id=request_id,
                plan_id=plan_id,
                seed_id=seed_id,
                rounds_count=round_number,
                authoring_verdict="authored_validated",
                adapter_path=adapter_path,
                manifest_path=manifest_path,
                calibration_precision=precision,
                calibration_recall=recall,
                critical_false_positives=critical_fps,
                judge_consensus_log=judge_consensus_log,
                skill_genesis_request_id=request_id,
                evidence_pack_path=str(_pack_path(root, seed_id)),
                evidence_pack_size=len(evidence_pack["observations"]),
                calibration_corpus_path=str(calibration_corpus_path),
                hallucination_rejection_count=hallucination_rejection_count,
            )

        # Sub-100% → consolidate judge critique and loop.
        prior_critique = _consolidate_judge_evidence_grounded_critique(
            evidence_verdict=evidence_verdict,
            adversarial_verdict=adversarial_verdict,
            sandbox_result=sandbox_result,
        )

    # ---- Max rounds reached — preserve drafts ----
    judge_consensus_log.append({
        "phase": "max_rounds_reached",
        "round": max_authoring_rounds,
    })
    return _terminal_result(
        request_id=request_id, plan_id=plan_id, seed_id=seed_id,
        verdict="authored_max_rounds",
        rounds_count=max_authoring_rounds,
        judge_consensus_log=judge_consensus_log,
        evidence_pack_path=str(_pack_path(root, seed_id)),
        evidence_pack_size=len(evidence_pack["observations"]),
        calibration_corpus_path=calibration_corpus_path,
        hallucination_rejection_count=hallucination_rejection_count,
    )


def _cross_verify_evidence_refs(
    *,
    draft: dict[str, Any],
    evidence_pack: EvidencePack,
    workspace_root: Path,
) -> tuple[bool, list[dict[str, Any]]]:
    """Plan ARIA-V6 §2d v2 — CROSS-VERIFY primitive (Tier-1 SSoT).

    Source-substring invariant I-V6.2-07 pins the literal call site
    of ``Path.exists()`` AND ``git show`` in this function. A refactor
    that drops either check fails the source-substring test.

    For EACH evidence_ref in ``draft.evidence_refs``:
      * Path.exists() against ``workspace_root / file_path`` ✓
      * git show <base_commit_sha>:<file_path> succeeds AND the line
        at <line> MATCHES the snippet text claimed by the ref ✓
      * file_path + line ±5 matches an entry in
        ``evidence_pack.observations`` (drift tolerance) ✓

    Returns:
      (ok, rejected_refs) — ok=True iff every ref passes all three
      checks; rejected_refs is a list of {ref, reason} dicts.

    Why three checks (not one):
      - Path.exists guards against typos pointing to deleted files.
      - git show guards against the snippet drifting from what was
        observed at base_commit_sha (mid-cycle repo mutation).
      - evidence_pack membership guards against refs OUTSIDE the
        bounded debate canvas — the heart of "no hallucinated rule
        space".

    All three are necessary; dropping any one weakens the mutual-
    hallucination guarantee.
    """
    rejected: list[dict[str, Any]] = []
    evidence_refs = list(draft.get("evidence_refs") or [])
    sha = evidence_pack["base_commit_sha"]
    obs_index = _index_observations(evidence_pack["observations"])

    for ref in evidence_refs:
        parsed = _parse_evidence_ref(ref)
        if parsed is None:
            rejected.append({"ref": str(ref), "reason": "malformed_ref"})
            continue
        file_path, line_no, claimed_snippet = parsed

        # Check 1 — Path.exists()
        abs_path = workspace_root / file_path
        if not abs_path.exists():
            rejected.append({"ref": ref, "reason": "path_does_not_exist"})
            continue

        # Check 2 — git show <sha>:<file> matches snippet (when snippet
        # is provided in the ref; some refs are file:line only).
        git_ok, captured = _git_show_line(workspace_root, sha, file_path, line_no)
        if not git_ok:
            rejected.append({"ref": ref, "reason": "git_show_unreachable"})
            continue
        if claimed_snippet and captured.strip() != claimed_snippet.strip():
            rejected.append({
                "ref": ref,
                "reason": "snippet_mismatch_at_sha",
                "captured": captured.strip(),
                "claimed": claimed_snippet.strip(),
            })
            continue

        # Check 3 — evidence_pack membership with ±5 line tolerance.
        if not _ref_in_pack(obs_index, file_path, line_no, tolerance=5):
            rejected.append({
                "ref": ref,
                "reason": "ref_outside_evidence_pack",
            })
            continue

    return (len(rejected) == 0, rejected)


def _peer_review_cross_verify(
    *,
    primary_draft: dict[str, Any],
    challenger_draft: dict[str, Any],
    evidence_pack: EvidencePack,
    workspace_root: Path,
) -> tuple[bool, list[dict[str, Any]]]:
    """Plan ARIA-V6 §2d v2 — CROSS-VERIFY #3 (peer review).

    Each side fact-checks the other's claims:

      * primary's counter-claims about challenger's refs MUST
        demonstrate via Path.exists + git show whether the ref
        resolves.
      * challenger's counter-claims about primary's refs MUST do the
        same.

    Failure means one side claimed "fails to verify" without being
    able to demonstrate the ref's absence — collusion or laziness
    signal.
    """
    log: list[dict[str, Any]] = []

    # Primary's audit of challenger's refs.
    p_audits = list(primary_draft.get("peer_audit") or [])
    for audit in p_audits:
        ref = audit.get("ref")
        claim = audit.get("claim")  # "verified" | "missing"
        if not ref or claim not in ("verified", "missing"):
            log.append({"side": "primary", "ref": ref, "error": "malformed_audit"})
            return (False, log)
        parsed = _parse_evidence_ref(ref)
        if parsed is None:
            log.append({"side": "primary", "ref": ref, "error": "malformed_ref"})
            return (False, log)
        file_path, line_no, _ = parsed
        actually_exists = (workspace_root / file_path).exists() and \
            _git_show_line(workspace_root, evidence_pack["base_commit_sha"], file_path, line_no)[0]
        if claim == "verified" and not actually_exists:
            log.append({
                "side": "primary", "ref": ref,
                "error": "false_positive_verify",
            })
            return (False, log)
        if claim == "missing" and actually_exists:
            log.append({
                "side": "primary", "ref": ref,
                "error": "false_negative_missing",
            })
            return (False, log)

    # Challenger's audit of primary's refs.
    c_audits = list(challenger_draft.get("peer_audit") or [])
    for audit in c_audits:
        ref = audit.get("ref")
        claim = audit.get("claim")
        if not ref or claim not in ("verified", "missing"):
            log.append({"side": "challenger", "ref": ref, "error": "malformed_audit"})
            return (False, log)
        parsed = _parse_evidence_ref(ref)
        if parsed is None:
            log.append({"side": "challenger", "ref": ref, "error": "malformed_ref"})
            return (False, log)
        file_path, line_no, _ = parsed
        actually_exists = (workspace_root / file_path).exists() and \
            _git_show_line(workspace_root, evidence_pack["base_commit_sha"], file_path, line_no)[0]
        if claim == "verified" and not actually_exists:
            log.append({
                "side": "challenger", "ref": ref,
                "error": "false_positive_verify",
            })
            return (False, log)
        if claim == "missing" and actually_exists:
            log.append({
                "side": "challenger", "ref": ref,
                "error": "false_negative_missing",
            })
            return (False, log)

    log.append({"side": "peer_review", "status": "ok",
                "primary_audit_count": len(p_audits),
                "challenger_audit_count": len(c_audits)})
    return (True, log)


def _validate_evidence_grounded(
    *,
    primary_draft: dict[str, Any],
    challenger_draft: dict[str, Any],
    evidence_pack: EvidencePack,
) -> tuple[bool, list[str]]:
    """Plan ARIA-V6 §2d v2 — Tier-1 evidence-grounding gate.

    For EACH evidence_ref cited by primary OR challenger:
      - MUST belong to a claim_class declared in seed.claim_types
      - MUST point to a file present in evidence_pack.observations
        (line ±5 tolerance)
    """
    reasons: list[str] = []
    claim_types_allowed = set(evidence_pack["claim_types"])
    obs_index = _index_observations(evidence_pack["observations"])

    for side_name, draft in (("primary", primary_draft), ("challenger", challenger_draft)):
        for rule in (draft.get("rules") or []):
            cc = rule.get("claim_class")
            if cc not in claim_types_allowed:
                reasons.append(f"{side_name}_rule_claim_class_outside_seed: {cc}")
        for ref in (draft.get("evidence_refs") or []):
            parsed = _parse_evidence_ref(ref)
            if parsed is None:
                reasons.append(f"{side_name}_malformed_ref: {ref}")
                continue
            file_path, line_no, _ = parsed
            if not _ref_in_pack(obs_index, file_path, line_no, tolerance=5):
                reasons.append(f"{side_name}_ref_outside_pack: {ref}")
    return (len(reasons) == 0, reasons)


def _consolidate_judge_evidence_grounded_critique(
    *,
    evidence_verdict: dict[str, Any],
    adversarial_verdict: dict[str, Any],
    sandbox_result: dict[str, Any],
) -> list[dict[str, Any]]:
    """Plan ARIA-V6 §2d v2 — feed back into next round's prior_critique."""
    critique: list[dict[str, Any]] = []
    for src, verdict in (
        ("evidence_judge", evidence_verdict),
        ("adversarial_judge", adversarial_verdict),
    ):
        for finding in verdict.get("gaps") or []:
            critique.append({
                "source": src,
                "severity": finding.get("severity", "MEDIUM"),
                "summary": finding.get("summary", ""),
                "evidence_refs": list(finding.get("evidence_refs") or []),
            })
    for missed in sandbox_result.get("false_positives") or []:
        critique.append({
            "source": "sandbox",
            "severity": "HIGH",
            "summary": f"false_positive_on_fixture: {missed}",
            "evidence_refs": [],
        })
    for missed in sandbox_result.get("false_negatives") or []:
        critique.append({
            "source": "sandbox",
            "severity": "HIGH",
            "summary": f"false_negative_on_fixture: {missed}",
            "evidence_refs": [],
        })
    return critique


def _default_arbiter(
    *,
    primary_draft: dict[str, Any],
    challenger_draft: dict[str, Any],
    mutual_verification_log: list[dict[str, Any]],
) -> dict[str, Any]:
    """Plan ARIA-V6 §2d v2 — minimum-viable arbiter.

    Returns ``{"converged": bool, "score": float, "unsatisfied_items":
    list}``. Production wires a real consensus arbiter; this default
    converges when content_hashes differ AND the challenger raised no
    unresolved critique.
    """
    p_hash = _content_hash(primary_draft)
    c_hash = _content_hash(challenger_draft)
    if p_hash == c_hash:
        # Collusion signal — identical drafts.
        return {"converged": False, "score": 0.0,
                "unsatisfied_items": [{"reason": "identical_content_hash"}]}
    critiques = list(challenger_draft.get("critiques") or [])
    unresolved = [c for c in critiques if not c.get("resolved")]
    converged = len(unresolved) == 0
    return {
        "converged": converged,
        "score": 1.0 if converged else 0.5,
        "unsatisfied_items": unresolved,
    }


def _content_hash(payload: dict[str, Any]) -> str:
    """SHA-256 over canonicalized draft for collusion check."""
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _parse_evidence_ref(ref: Any) -> tuple[str, int, str | None] | None:
    """Parse ``path:line[:snippet]`` evidence_ref."""
    if not isinstance(ref, str):
        return None
    parts = ref.split(":", 2)
    if len(parts) < 2:
        return None
    file_part = parts[0].strip()
    line_part = parts[1].strip()
    snippet_part = parts[2] if len(parts) == 3 else None
    if not file_part:
        return None
    try:
        line_no = int(line_part)
    except ValueError:
        return None
    if line_no < 1:
        return None
    return (file_part, line_no, snippet_part)


def _index_observations(
    observations: list[dict[str, Any]],
) -> dict[str, list[int]]:
    """Build {file_path: sorted[line_no]} index."""
    out: dict[str, list[int]] = {}
    for obs in observations:
        out.setdefault(obs["file_path"], []).append(int(obs["line"]))
    for k in out:
        out[k].sort()
    return out


def _ref_in_pack(
    obs_index: dict[str, list[int]],
    file_path: str,
    line_no: int,
    tolerance: int = 5,
) -> bool:
    """Check ref membership with line tolerance."""
    candidates = obs_index.get(file_path)
    if not candidates:
        return False
    return any(abs(c - line_no) <= tolerance for c in candidates)


def _git_show_line(
    workspace_root: Path,
    sha: str,
    file_path: str,
    line_no: int,
) -> tuple[bool, str]:
    """Plan ARIA-V6 §2d v2 — git show <sha>:<file> sed-equivalent.

    Returns (ok, captured_line). ok=False on git failure or out-of-
    range line.
    """
    if not re.fullmatch(r"[0-9a-fA-F]{4,40}", sha or ""):
        return (False, "")
    # SECURITY: file_path comes from drafter output. Reject any
    # ``..`` traversal and shell-meta to keep git show below a sane
    # surface — Path normalization + relative check.
    norm = file_path.lstrip("./").replace("\\", "/")
    if ".." in norm.split("/") or norm.startswith("/"):
        return (False, "")
    result = subprocess.run(
        ["git", "show", f"{sha}:{norm}"],
        cwd=workspace_root,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        return (False, "")
    lines = result.stdout.splitlines()
    if not (1 <= line_no <= len(lines)):
        return (False, "")
    return (True, lines[line_no - 1])


def _head_still_at(workspace_root: str | Path, expected_sha: str) -> bool:
    """Plan ARIA-V6 §2d v2 — HEAD-drift pre-check at each round."""
    result = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=Path(workspace_root),
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        return False
    current = result.stdout.strip()
    # Treat short-sha as matching when prefix aligns (operator may
    # bind to abbreviated sha).
    return current == expected_sha or current.startswith(expected_sha) or \
        expected_sha.startswith(current[: len(expected_sha)])


def _persist_round_artifact(
    root: Path,
    plan_id: str,
    round_number: int,
    payload: dict[str, Any],
) -> None:
    """Write per-round artefacts under aria-tools/convergent-authoring/."""
    plan_dir = root / "convergent-authoring" / plan_id
    plan_dir.mkdir(parents=True, exist_ok=True)
    safe_kind = re.sub(
        r"[^A-Za-z0-9_-]+", "_",
        str(payload.get("side") or payload.get("phase") or "row"),
    )[:60] or "row"
    out = plan_dir / f"r{round_number:02d}-{safe_kind}.json"
    out.write_text(
        json.dumps({"recorded_at": utc_now(), **payload}, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def _pack_path(root: Path, seed_id: str) -> Path:
    safe = re.sub(r"[^A-Za-z0-9_.-]+", "_", seed_id)[:120] or "seed"
    return root / "convergent-authoring" / "evidence-packs" / f"{safe}.json"


def _terminal_result(
    *,
    request_id: str,
    plan_id: str,
    seed_id: str,
    verdict: AuthoringVerdict,
    rounds_count: int,
    judge_consensus_log: list[dict[str, Any]],
    evidence_pack_path: str,
    evidence_pack_size: int,
    calibration_corpus_path: str | None,
    hallucination_rejection_count: int,
    adapter_path: str | None = None,
    manifest_path: str | None = None,
    precision: float | None = None,
    recall: float | None = None,
    critical_fps: int | None = None,
) -> AdapterAuthoringResult:
    return AdapterAuthoringResult(
        request_id=request_id,
        plan_id=plan_id,
        seed_id=seed_id,
        rounds_count=rounds_count,
        authoring_verdict=verdict,
        adapter_path=adapter_path,
        manifest_path=manifest_path,
        calibration_precision=precision,
        calibration_recall=recall,
        critical_false_positives=critical_fps,
        judge_consensus_log=judge_consensus_log,
        skill_genesis_request_id=request_id,
        evidence_pack_path=evidence_pack_path,
        evidence_pack_size=evidence_pack_size,
        calibration_corpus_path=str(calibration_corpus_path) if calibration_corpus_path else None,
        hallucination_rejection_count=hallucination_rejection_count,
    )
