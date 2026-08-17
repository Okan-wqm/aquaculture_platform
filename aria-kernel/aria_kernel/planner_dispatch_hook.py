"""Plan 025 §D — Claude Code invocation hook for the autonomous
planner dispatcher daemon.

Per-tick contract: find one pending planner request, claim it, dispatch
to ``tools/aria-poc/ci_executor.py`` as a subprocess, capture exit
code + redacted stderr, emit governance events, return a structured
result dict. The daemon (autonomous_planner_dispatcher.run_planner_
dispatch_daemon) calls this on every iteration.

Subprocess parity with the §B-fixed ci_executor.py main() — both the
GHA workflow path and the autonomous daemon path reach the SAME
per-request executor so cost-cap, envelope-load (agent-invocations
list --request-id), mock vs live branch, lease-token-from-env
discipline, and submit-result wiring are tested once. Forking the
path into an in-process invoke_claude_code() helper would split
governance event coverage between two surfaces and re-open the
silent-swallow vector closed at §B.

Lease-token discipline (Plan 019 Phase 8.B):
* Lease token transit ONLY via the ARIA_LEASE_TOKEN env var.
* argv NEVER carries the raw token; the executor reads the token from
  os.environ at submit time via --lease-token-from-env.
* Stderr is redacted at the daemon boundary as defense-in-depth even
  though ci_executor already redacts at its own boundary.

Subagent-type SSoT: the daemon reads ``target_agent`` from the
request row returned by ``next_pending_request``. The role→target
pairing was enforced at request creation time by
``agent_contract.ROLE_TARGET_PAIRING``; re-deriving in the daemon
would duplicate the rule and split the SSoT.
"""
from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Any


__all__ = [
    "DEFAULT_PLANNER_ROLES",
    "DEFAULT_LEASE_SECONDS",
    "dispatch_one_pending_planner_request",
]


DEFAULT_PLANNER_ROLES: tuple[str, ...] = ("primary_plan", "challenger_plan")
DEFAULT_LEASE_SECONDS: int = 1800
LEASE_TOKEN_ENV_VAR: str = "ARIA_LEASE_TOKEN"
# Plan 026R §B.5 — single-claim env separation. ARIA_LEASE_TOKEN carries
# the raw token (sensitive, NEVER in metadata / argv / logs).
# ARIA_CLAIM_METADATA carries the fused claim envelope (claim_id,
# request_id, agent_id, envelope fields, lease_expires_at, ledger-hash
# anchors). The two-env-var split makes "metadata leaks the secret" a
# structurally-impossible bug — the serialiser rejects any
# ``lease_token`` / ``lease_token_hash`` key on output; the executor
# deserialiser rejects them on input.
CLAIM_METADATA_ENV_VAR: str = "ARIA_CLAIM_METADATA"


# Plan 026R §B.5 — fields prohibited from ARIA_CLAIM_METADATA. Any
# attempt to write or read either key in metadata raises
# ``GovernanceError``. The single source of truth — both serialiser
# (sender) and deserialiser (executor) read from this constant.
CLAIM_METADATA_FORBIDDEN_KEYS: frozenset[str] = frozenset({
    "lease_token",
    "lease_token_hash",
})


def _serialise_claim_metadata_for_env(
    claim: dict[str, Any], agent_id: str,
) -> str:
    """Plan 026R §B.5 — serialise a claim response into the
    ARIA_CLAIM_METADATA env-var payload.

    Schema:
    * claim_id, request_id, agent_id (control-plane identifiers)
    * expected_output_path, role, must_satisfy, allowed_scope,
      evidence_refs (envelope — fused into claim by §B.3)
    * context_hash, prompt_hash, context_ledger_hash, prompt_ledger_hash
      (model-visible context/prompt SSoT binding)
    * lease_expires_at (lease lifecycle anchor)
    * claim_ledger_hash, request_ledger_hash (§B.5 tamper-detection
      anchors — verified by the deserialiser against on-disk rows)

    Forbidden: ``lease_token`` and ``lease_token_hash``. Inclusion of
    either key in the input claim dict raises ``GovernanceError`` so
    a serialisation bug surfaces at the sender boundary rather than
    leaking the secret into env+logs. Caller MUST strip these keys
    before invoking (the dispatch hook does so via a documented
    dict-comprehension).
    """
    # Lazy import — mirrors dispatch_planner_tick (line 183) keeping
    # kernel cold-start light.
    from .tool_registry import GovernanceError
    # Plan 026R §B.5 — forbidden-key check on the INPUT claim dict.
    # The serialiser does NOT copy lease_token into payload by
    # construction, but a tampered claim dict could carry the key
    # from upstream (e.g. a buggy in-process patch on the claim
    # response); surfacing the leak at the sender boundary catches
    # the upstream bug before the secret enters env+logs.
    leaked = CLAIM_METADATA_FORBIDDEN_KEYS & set(claim.keys())
    if leaked:
        raise GovernanceError(
            f"claim_metadata_forbidden_key_in_input: {sorted(leaked)} "
            f"— lease_token MUST transit via {LEASE_TOKEN_ENV_VAR} only"
        )
    # Plan ARIA-V10.4 Phase 3.H.5 — V8.12 follow-up that closes the
    # actual F-017 root cause. The V8.12 fix at
    # ``agent_invocations.claim_request:807-827`` extended the
    # claim_request RETURN VALUE with envelope fields
    # (suggested_prompt, convergence_id, target_agent, etc.) so
    # ci_executor's ``_build_prompt_payload`` could render them. But
    # the env-var SERIALISER below (this function) was never updated
    # to PROPAGATE those fields to the ci_executor subprocess. Net
    # effect: claim dict in this process has full envelope; serialised
    # ARIA_CLAIM_METADATA env var previously carried only an envelope subset;
    # ci_executor's ``request_envelope`` build (line 1542) reads None
    # for the missing fields; the prompt file's ``## Suggested prompt``
    # section is empty; cross_reviewer (and any role) refuses with
    # ``evidence_underspecified``. Confirmed via V10.4 endurance cycle
    # 1 (cyc-20260520T112130Z-auto) — requests.jsonl had full
    # suggested_prompt (10454 chars with <untrusted_*> tags) but the
    # prompt file delivered to the subprocess had ``## Suggested
    # prompt\n\n\n`` (empty body).
    #
    # The full V8.12-extended set landed in claim_request return value
    # (lines 807-827) is the SSoT for what ci_executor needs:
    # expected_output_path, role, target_agent, convergence_id,
    # suggested_prompt, must_satisfy, allowed_scope, forbidden_scope,
    # evidence_refs, impact_graph_refs, validation_commands,
    # plan_revision_hash. The serialiser propagates all of them so
    # ci_executor sees the SAME envelope the kernel minted.
    payload = {
        "claim_id": claim.get("claim_id"),
        "request_id": claim.get("request_id"),
        "agent_id": agent_id,
        "expected_output_path": claim.get("expected_output_path"),
        "role": claim.get("role"),
        # Plan ARIA-V10.4 Phase 3.H.5 — V8.12-extended envelope fields
        # ci_executor's _build_prompt_payload reads at line 1641-1655.
        # Without these, the agent prompt's "## Suggested prompt"
        # section is empty + the <untrusted_*> tag bodies don't exist
        # in the file the subprocess reads from stdin.
        "target_agent": claim.get("target_agent"),
        "convergence_id": claim.get("convergence_id"),
        "suggested_prompt": claim.get("suggested_prompt"),
        "must_satisfy": claim.get("must_satisfy") or [],
        "allowed_scope": claim.get("allowed_scope") or [],
        "forbidden_scope": claim.get("forbidden_scope") or [],
        "evidence_refs": claim.get("evidence_refs") or [],
        "impact_graph_refs": claim.get("impact_graph_refs") or [],
        "validation_commands": claim.get("validation_commands") or [],
        # Same reason as the fused claim response in agent_invocations: the
        # prompt hash was computed over a render that INCLUDED the Twin slice,
        # so a serialiser that drops it hands the executor a prompt it can
        # never hash back to the recorded value. Two serialisers, one
        # contract — they must carry the same fields.
        "repository_map": claim.get("repository_map"),
        # FAZ 4 + Z8 — the renderer reads all three, so a serialiser that
        # drops any of them hands the executor a prompt it can never hash
        # back to the recorded value (the exact defect class the
        # repository_map comment above documents). prompt_render_version
        # selects the tagged v2 body; dropping it re-renders every fresh
        # row as v1 and fails the binding on the single-claim path.
        "established_knowledge": claim.get("established_knowledge"),
        "recent_intent": claim.get("recent_intent"),
        # E17-b — the quoted evidence bytes. Same contract as the three
        # sections above: the renderer reads the field, so a serialiser that
        # drops it hands the executor a prompt whose excerpt section vanished
        # and whose hash can never match the minted one.
        "evidence_excerpts": claim.get("evidence_excerpts"),
        "prompt_render_version": claim.get("prompt_render_version"),
        "cycle_id": claim.get("cycle_id"),
        "plan_revision_hash": claim.get("plan_revision_hash"),
        "context_hash": claim.get("context_hash"),
        "prompt_hash": claim.get("prompt_hash"),
        "context_ledger_hash": claim.get("context_ledger_hash"),
        "prompt_ledger_hash": claim.get("prompt_ledger_hash"),
        "lease_expires_at": claim.get("lease_expires_at"),
        "claim_ledger_hash": claim.get("claim_ledger_hash"),
        "request_ledger_hash": claim.get("request_ledger_hash"),
    }
    # Defense-in-depth: assert no forbidden key crept into the output.
    payload_leaked = CLAIM_METADATA_FORBIDDEN_KEYS & set(payload.keys())
    if payload_leaked:  # pragma: no cover — structural impossibility
        raise GovernanceError(
            f"claim_metadata_forbidden_key_in_payload: {sorted(payload_leaked)}"
        )
    return json.dumps(payload, sort_keys=True, separators=(",", ":"))


def _redact_lease_in_message(message: str, lease_token: str | None) -> str:
    """Mirror of tools/aria-poc/ci_executor._redact_lease_in_message.

    Inlined here so the daemon does not need to add tools/aria-poc to
    PYTHONPATH at runtime; the import discipline keeps the kernel
    package's runtime dependency surface aria-kernel-only.
    """
    if not lease_token:
        return message
    return message.replace(lease_token, "<lease-token-redacted>")


def _executor_timeout_seconds(lease_seconds: int) -> int:
    """Y1 (ORPHAN-703) — the child's wall-clock budget sits STRICTLY inside
    the lease. The shipped value was ``lease_seconds + 60``: the lease was
    already dead before the subprocess timeout could fire, so every timeout
    became a silent ``lease_expired`` requeue charged to the REQUEST (106 in
    one week; every planner HUMAN_REQUIRED escalation carried this signature).
    The 120s margin leaves room for the release write below to land while
    the lease is still live. Floor of 300s keeps test-scale leases usable.
    """
    return max(300, int(lease_seconds) - 120)


def _release_abandoned_claim(
    *,
    root: Path,
    claim_id: str,
    agent_id: str,
    lease_token: str,
    reason: str,
) -> bool:
    """Y1 (ORPHAN-703) — release the claim on a failure exit path.

    The child may ALREADY have released (ci_executor releases on the CLI
    failure classes it recognises). ``release_claim`` does not refuse a
    second release — it would append a duplicate released+requeued pair —
    so this helper checks the claims ledger first and skips with a recorded
    disclosure. Failures are recorded and never re-raised: this helper must
    not convert a dispatch failure into a daemon crash.
    """
    import json as _json

    from .agent_invocations import GovernanceError, release_claim
    from .tool_registry import append_tools_governance

    claims_path = root / "agent-invocations" / "claims.jsonl"
    if claims_path.exists():
        for line in claims_path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            row = _json.loads(line)
            if row.get("claim_id") == claim_id and row.get("event") == "released":
                append_tools_governance(
                    root, "planner_dispatch_release_skipped_already_released",
                    {"claim_id": claim_id, "reason": reason},
                )
                return False

    try:
        release_claim(
            claim_id=claim_id,
            agent_id=agent_id,
            lease_token=lease_token,
            reason=reason,
            base_dir=root,
        )
        return True
    except GovernanceError as exc:
        append_tools_governance(
            root, "planner_dispatch_release_refused",
            {"claim_id": claim_id, "reason": reason, "error": str(exc)},
        )
        return False


def _default_ci_executor_path(base_dir: Path) -> Path:
    """Resolve the ci_executor.py path — from the CODE tree, not the store.

    `base_dir.parent` was correct while the ledgers lived at
    `<repo>/aria-tools`. After the durable-store cutover ARIA_TOOLS_DIR is
    `<repo>/.aria-state-store/tools`, so the old arithmetic resolved
    `<repo>/.aria-state-store/tools/aria-poc/ci_executor.py` — a path
    inside the STATE branch worktree, which contains no code. Every
    in-cycle dispatch therefore spawned a nonexistent file (exit 2), the
    plan state never moved, and the claim it had already taken was held
    for the whole lease window. Nothing overrode the default: this
    function's result was the only path any caller used.

    The executor lives in the repository that contains THIS module, so
    resolve from the package location and fall back to the legacy
    arithmetic only if that tree does not carry it (installed-package
    layouts).
    """
    from_code_tree = Path(__file__).resolve().parents[2] / "tools" / "aria-poc" / "ci_executor.py"
    if from_code_tree.is_file():
        return from_code_tree
    return base_dir.parent / "tools" / "aria-poc" / "ci_executor.py"


def dispatch_one_pending_planner_request(
    *,
    base_dir: str | Path,
    agent_id: str,
    lease_seconds: int = DEFAULT_LEASE_SECONDS,
    planner_roles: tuple[str, ...] = DEFAULT_PLANNER_ROLES,
    ci_executor_path: Path | None = None,
) -> dict[str, Any]:
    """Find one pending planner request, claim it, dispatch the
    Claude Code CLI via ci_executor.py subprocess.

    Returns aggregate dict with ``status`` ∈
    ``{no_pending, claim_failed, executor_failed, dispatched}``,
    plus ``request_id``, ``claim_id``, ``exit_code``,
    ``governance_event_count``, ``stderr_redacted``.

    Does NOT raise on operational failures (claim rejections,
    subprocess non-zero exit, subprocess timeout); only programmer
    errors raise (e.g. base_dir missing). The daemon's loop treats
    every dict return as one tick.

    Does NOT acquire any daemon-level lock. The kernel primitives
    claim_request and submit_claim_result already carry their own
    §A.1 / §H-1 locks; the daemon's outer single-instance lock
    guards the loop, not this hook.

    Does NOT set CLAUDE_CODE_MOCK. The operator controls mock vs
    live mode via the env var at daemon launch time; this hook
    inherits the parent process env unchanged.
    """
    # Local imports keep kernel cold-start light. The daemon module
    # already imports this hook lazily from inside its own loop; the
    # sub-imports below run only on the first dispatch tick.
    from .agent_invocations import claim_request, next_pending_request
    from .tool_registry import (
        GovernanceError,
        append_tools_governance,
        ensure_tools_dir,
    )

    root = ensure_tools_dir(base_dir)

    # Step 1 — find one pending request whose role is in planner_roles.
    # Role iteration order = priority order (primary_plan first by
    # default; operator can re-order via the planner_roles kwarg).
    request: dict[str, Any] | None = None
    for role in planner_roles:
        request = next_pending_request(role=role, base_dir=root)
        if request is not None:
            break
    if request is None:
        return {
            "status": "no_pending",
            "request_id": None,
            "claim_id": None,
            "exit_code": None,
            "governance_event_count": 0,
            "stderr_redacted": "",
        }

    request_id: str = request["request_id"]
    target_agent: str = str(request.get("target_agent", ""))
    if not target_agent:
        # Programmer-error: every request row should carry target_agent
        # (enforced at create_agent_invocation_request). Surface as a
        # claim_failed governance event so the operator can repair the
        # row instead of silently retrying.
        append_tools_governance(
            root, "planner_dispatch_request_missing_target_agent",
            {"request_id": request_id, "role": request.get("role")},
        )
        return {
            "status": "claim_failed",
            "request_id": request_id,
            "claim_id": None,
            "exit_code": None,
            "governance_event_count": 1,
            "stderr_redacted": "",
        }

    # Step 2 — claim the request via the kernel primitive (in-process,
    # already lock-bound by Plan 024 §H-1). claim_request emits its
    # own agent_claim_created governance event on success; we count
    # that toward governance_event_count so the daemon's structured
    # log aligns with the ledger.
    governance_count = 0
    try:
        claim = claim_request(
            request_id=request_id,
            agent_id=agent_id,
            lease_seconds=lease_seconds,
            base_dir=root,
        )
        governance_count += 1  # agent_claim_created
    except GovernanceError as exc:
        append_tools_governance(
            root, "planner_dispatch_claim_failed",
            {"request_id": request_id, "error": str(exc)},
        )
        return {
            "status": "claim_failed",
            "request_id": request_id,
            "claim_id": None,
            "exit_code": None,
            "governance_event_count": 1,
            "stderr_redacted": "",
        }

    claim_id: str = claim["claim_id"]
    lease_token: str = claim["lease_token"]

    # Step 3 — invoke ci_executor.py as a subprocess. Lease token via
    # env var; argv carries only public identifiers. Plan 026R §B.5 —
    # ARIA_CLAIM_METADATA env var carries the fused envelope + ledger-
    # hash anchors so the subprocess SKIPS its own ``agent claim`` step
    # (single-claim mode). Pre-§B.5 the subprocess re-claimed and the
    # defensive double-claim reject in agent_invocations was noisy.
    if ci_executor_path is None:
        ci_executor_path = _default_ci_executor_path(root)
    # PYTHONPATH and cwd must name the CODE tree for the same reason the
    # executor path does: under the durable store `root.parent` is
    # `<repo>/.aria-state-store`, which has no `aria-kernel` package and
    # no repository to work in. Derive both from the resolved executor.
    repo_root = ci_executor_path.resolve().parents[2]
    argv: list[str] = [
        "python3",
        str(ci_executor_path),
        request_id,
        target_agent,
    ]
    # Plan 026R §B.5 — strip the secret BEFORE handing the dict to the
    # serialiser. The serialiser raises GovernanceError if any forbidden
    # key (lease_token / lease_token_hash) is present in the input, so
    # the planner explicitly scrubs them here. This makes the boundary
    # auditable: a single explicit dict-comprehension is the only path
    # by which the planner ever drops secrets from the claim shape.
    sanitised_claim = {
        k: v for k, v in claim.items()
        if k not in CLAIM_METADATA_FORBIDDEN_KEYS
    }
    metadata_env = _serialise_claim_metadata_for_env(sanitised_claim, agent_id)
    env: dict[str, str] = {
        **os.environ,
        "PYTHONPATH": str(repo_root / "aria-kernel"),
        LEASE_TOKEN_ENV_VAR: lease_token,
        CLAIM_METADATA_ENV_VAR: metadata_env,
    }
    timeout_seconds = _executor_timeout_seconds(lease_seconds)
    try:
        proc = subprocess.run(
            argv,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            env=env,
            cwd=str(repo_root),
        )
        exit_code = proc.returncode
        stderr_text = proc.stderr or ""
    except subprocess.TimeoutExpired:
        append_tools_governance(
            root, "planner_dispatch_executor_timeout",
            {
                "request_id": request_id, "claim_id": claim_id,
                "target_agent": target_agent,
                "timeout_seconds": timeout_seconds,
            },
        )
        # ORPHAN-CRITICAL-485 — the failure breaker's production producer on
        # the SCHEDULED lane.
        #
        # WHY HERE. The nightly is aria-auto-cycle.yml -> `autonomy run
        # --profile standard` -> run_autonomy_orchestrator, which calls the
        # planner drainer unconditionally after the cycle phase. The drainer's
        # default hook is THIS function and its profile gate is `agent_claim`,
        # which `standard` permits. So this arm sits on a path a schedule
        # actually walks.
        #
        # WHY NOT the cycle's pr_lifecycle phase, where the producer was first
        # placed. When this was written there were three independent reasons it
        # could not fire on a schedule: the callsite is gated on `pr_create`,
        # which `standard` does NOT permit; the phase sat behind a `run_phases`
        # kwarg the orchestrator never passed; and the proposal set it iterates
        # has no autonomous producer. Written, tested, and unreachable — the
        # exact defect class this branch exists to close.
        #
        # RC-1 removed the second reason: `pr_lifecycle` is now a row in
        # `cycle.CYCLE_PHASES` rather than an opt-in phase. The other two stand,
        # and the phase's precondition reads `ACTION_PERMISSIONS["pr_open"]`, so
        # under the nightly's `standard` profile it records a skip. The
        # conclusion is unchanged for a different reason, which is worth stating
        # rather than leaving a comment that would read as still-true by
        # accident: this arm remains the breaker's live producer on the
        # scheduled lane.
        #
        # WHY subprocess_timeout. It is already a declared FAILURE_KIND and it
        # is literally what happened: the agent subprocess blew its wall-clock
        # budget. The discrimination is STRUCTURAL — only this except arm
        # records — rather than a prefix match on an error message, so it
        # cannot drift the way PERIMETER_REFUSED_PREFIX did.
        try:
            from .circuit_breaker import record_failure
            record_failure(
                base_dir=root,
                kind="subprocess_timeout",
                materialize_event_id=str(claim_id or request_id or "unknown"),
                extra={
                    "request_id": request_id,
                    "claim_id": claim_id,
                    "target_agent": target_agent,
                    "timeout_seconds": timeout_seconds,
                    "observed_at": "planner_dispatch_hook",
                },
            )
            governance_count += 1
        except Exception:
            # The breaker ledger must never convert a dispatch timeout into a
            # crash: the timeout itself is already recorded above, and losing
            # the row is strictly better than losing the governance event.
            pass
        # Y1 (ORPHAN-703) — the killed child cannot have released; do it
        # here while the lease is still live (timeout < lease guarantees
        # the window). Harness-fault reason: a wall-clock kill says nothing
        # about the request, so its requeue budget is not burned.
        if _release_abandoned_claim(
            root=root, claim_id=claim_id, agent_id=agent_id,
            lease_token=lease_token, reason="planner_dispatch_executor_timeout",
        ):
            governance_count += 1
        return {
            "status": "executor_failed",
            "request_id": request_id,
            "claim_id": claim_id,
            "exit_code": None,
            "governance_event_count": governance_count + 1,
            "stderr_redacted": "executor_timeout",
        }

    # Step 4 — redact lease token from stderr at the daemon boundary
    # (defense in depth: ci_executor already redacts at its own
    # boundary, but the daemon does not trust subprocess stderr
    # untouched).
    stderr_redacted = _redact_lease_in_message(stderr_text, lease_token)

    # Step 5 — emit terminal governance events. The exit-code-suffixed
    # event lets operators alert on planner_dispatch_executor_exit_*
    # without parsing payloads; the dispatched event records the
    # full per-tick context.
    append_tools_governance(
        root, f"planner_dispatch_executor_exit_{exit_code}",
        {
            "request_id": request_id, "claim_id": claim_id,
            "target_agent": target_agent, "exit_code": exit_code,
        },
    )
    governance_count += 1
    append_tools_governance(
        root, "planner_dispatch_dispatched",
        {
            "request_id": request_id, "claim_id": claim_id,
            "target_agent": target_agent, "exit_code": exit_code,
        },
    )
    governance_count += 1

    status = "dispatched" if exit_code == 0 else "executor_failed"
    if exit_code != 0:
        # Y1 (ORPHAN-703) — a failed child usually releases through its own
        # CLI-failure classes; when it dies before reaching them (spawn
        # crash, unhandled exception) the claim used to dangle into
        # lease_expired. The helper tolerates the already-released case.
        if _release_abandoned_claim(
            root=root, claim_id=claim_id, agent_id=agent_id,
            lease_token=lease_token,
            reason="planner_dispatch_executor_exit_nonzero",
        ):
            governance_count += 1
    return {
        "status": status,
        "request_id": request_id,
        "claim_id": claim_id,
        "exit_code": exit_code,
        "governance_event_count": governance_count,
        "stderr_redacted": stderr_redacted,
    }
