"""Plan ARIA-V7 §2g v2 Phase 7.3 — universal agent dispatcher factories.

Producer-side counterpart to ``ci_executor.py``. V6.2's
``run_convergent_authoring`` requires 5 callables
(``primary_drafter``, ``challenger_drafter``, ``evidence_judge``,
``adversarial_judge``, ``sandbox_runner``) but V6 shipped no
production factories — the loop was dead code. V7.3 provides them.

Architecture:

  * Kernel-side factory functions (this module) return DrafterFn /
    JudgeFn / SandboxFn callables.
  * Each callable MINTS an envelope (via
    ``agent_invocations.create_agent_invocation_request``) for its
    declared role + waits for an external consumer to fulfill it.
  * The external consumer is ``tools/aria-poc/ci_executor.py``
    (V7.3 extension) which spawns a Claude Code CLI subprocess targeting
    the agent.
  * When no consumer fulfills the envelope within ``poll_timeout_
    seconds`` (default 600s), the factory returns a structured
    fallback (drafter: empty draft + critique; judge: gaps_open
    verdict; sandbox: zero-metrics result) so the convergent loop
    routes to ``dispatchers_unavailable`` verdict (NOT crash).

Operator vision principle "yama yok, kor birakma yok" honored:

  * Every factory returns a callable that ALWAYS produces a
    structured response, even on consumer absence (operator-visible
    via reflection telemetry).
  * No silent skip — the fallback verdict surfaces in the drainer's
    aggregate_verdict for operator inspection.
  * No "scheduled for later" dead code — factories are LIVE wiring
    that V7.4 drainer invokes on every cycle.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

from .agent_surface import DISPATCHABLE_ROLES, DRAFTER_ROLES
from .agent_invocations import (
    create_agent_invocation_request,
    list_agent_invocation_requests,
)
from .tool_registry import ensure_tools_dir


__all__ = [
    "SUPPORTED_ROLES",
    "DispatcherConfig",
    "select_drafter",
    "select_judge",
    "select_sandbox_runner",
    "default_dispatcher_config",
]


# Plan ARIA-V7 §2g v2 — closed enum of dispatchable roles. Adding a
# role requires updating both the kernel factory (this module) AND
# the consumer (``tools/aria-poc/ci_executor.py``). The closed enum
# prevents typo'd roles from silently flowing into the queue.
SUPPORTED_ROLES: frozenset[str] = frozenset(DISPATCHABLE_ROLES)



# Plan ARIA-V7 §2g v2 — fallback poll timeout when no consumer
# fulfills the envelope. Operator-tunable via the kernel CLI or the
# DispatcherConfig dict passed to the factories.
_DEFAULT_POLL_TIMEOUT_SECONDS = 600.0
_DEFAULT_POLL_INTERVAL_SECONDS = 5.0


class DispatcherConfig(dict):
    """Plan ARIA-V7 §2g v2 — dispatcher config dict.

    Subclassing ``dict`` rather than TypedDict so the V7.4 drainer
    can pass it directly to factories without imports.
    """


def default_dispatcher_config() -> DispatcherConfig:
    """Plan ARIA-V7 §2g v2 — default dispatcher config.

    Read environment overrides:
      * ``ARIA_DISPATCHER_POLL_TIMEOUT_SECONDS``  (float)
      * ``ARIA_DISPATCHER_POLL_INTERVAL_SECONDS`` (float)
      * ``ARIA_DISPATCHER_MAX_CONCURRENT``        (int; consumer-side)
    """
    import os
    cfg = DispatcherConfig({
        "poll_timeout_seconds": _DEFAULT_POLL_TIMEOUT_SECONDS,
        "poll_interval_seconds": _DEFAULT_POLL_INTERVAL_SECONDS,
        "max_concurrent_subprocesses": 3,
        "subprocess_timeout_seconds": 1800.0,
        "claude_auth_mode": "managed_session",
        "claude_cli_binary": "claude",
        "claude_model": "fable",
        "api_key_mode_allowed": False,
    })
    for key, env_var, cast in (
        ("poll_timeout_seconds", "ARIA_DISPATCHER_POLL_TIMEOUT_SECONDS", float),
        ("poll_interval_seconds", "ARIA_DISPATCHER_POLL_INTERVAL_SECONDS", float),
        ("max_concurrent_subprocesses", "ARIA_DISPATCHER_MAX_CONCURRENT", int),
    ):
        raw = os.environ.get(env_var)
        if raw is not None:
            try:
                cfg[key] = cast(raw)
            except (ValueError, TypeError):
                continue
    return cfg


# ---------------------------------------------------------------------
# DrafterFn factories
# ---------------------------------------------------------------------


def select_drafter(*, role: str, config: DispatcherConfig | None = None):
    """Plan ARIA-V7 §2g v2 — return a DrafterFn for the given role.

    role MUST be one of ``"primary_authoring"`` or
    ``"challenger_authoring"``. Unknown role → ValueError.
    """
    if role not in DRAFTER_ROLES:
        raise ValueError(
            f"select_drafter_unknown_role: {role!r} (must be "
            f"primary_authoring or challenger_authoring)"
        )
    cfg = config or default_dispatcher_config()

    def _drafter_fn(
        *,
        seed_id: str,
        must_satisfy: list[dict[str, Any]],
        evidence_pack: dict[str, Any],
        prior_critique: list[dict[str, Any]] | None = None,
        prior_draft: dict[str, Any] | None = None,
        round_number: int,
    ) -> dict[str, Any]:
        # Determine target_agent from role.
        target_agent = (
            "aria-primary-drafter" if role == "primary_authoring"
            else "aria-challenger-drafter"
        )
        prompt = (
            f"V6.2 convergent_skill_authoring round {round_number} "
            f"for seed {seed_id}. Read the supplied evidence_pack + "
            f"must_satisfy contracts; produce an adapter draft "
            f"citing >=3 evidence_refs per rule that resolve at "
            f"the base_commit_sha. Peer audit on round >= 2."
        )
        envelope = create_agent_invocation_request(
            target_agent=target_agent,
            role=role,
            suggested_prompt=prompt,
            must_satisfy=list(must_satisfy or []),
            allowed_scope=[f"convergent/{seed_id}"],
            evidence_refs=[f"seed:{seed_id}", f"round:{round_number}"],
            base_dir=evidence_pack.get("_base_dir"),
        )
        return _poll_for_drafter_response(
            envelope=envelope,
            role=role,
            cfg=cfg,
            base_dir=evidence_pack.get("_base_dir"),
            fallback_role=role,
            seed_id=seed_id,
        )

    return _drafter_fn


# ---------------------------------------------------------------------
# JudgeFn factories
# ---------------------------------------------------------------------


def select_judge(*, role: str, config: DispatcherConfig | None = None):
    """Plan ARIA-V7 §2g v2 — return a JudgeFn for the given role."""
    if role not in ("evidence_judgment", "adversarial_judgment"):
        raise ValueError(
            f"select_judge_unknown_role: {role!r} (must be "
            f"evidence_judgment or adversarial_judgment)"
        )
    cfg = config or default_dispatcher_config()

    def _judge_fn(
        *,
        primary_draft: dict[str, Any],
        sandbox_result: dict[str, Any],
        evidence_pack: dict[str, Any],
    ) -> dict[str, Any]:
        target_agent = (
            "aria-evidence-judge" if role == "evidence_judgment"
            else "aria-adversarial-judge"
        )
        prompt = (
            f"V6.2 judge verdict for seed "
            f"{evidence_pack.get('seed_id', 'unknown')}. Read the "
            f"sandbox_result + primary_draft + evidence_pack; "
            f"return verdict in {{no_gaps, gaps_open}}. Ground "
            f"verdict ONLY in sandbox stdout/stderr + emitted findings."
        )
        envelope = create_agent_invocation_request(
            target_agent=target_agent,
            role=role,
            suggested_prompt=prompt,
            must_satisfy=[{
                "id": f"{role}-verdict",
                "description": (
                    f"Judge {target_agent} reviewed the sandbox_result "
                    f"and returned a verdict grounded in sandbox output."
                ),
            }],
            allowed_scope=[f"convergent/{evidence_pack.get('seed_id')}"],
            evidence_refs=[
                f"seed:{evidence_pack.get('seed_id')}",
                f"sandbox_result:precision={sandbox_result.get('precision')}",
            ],
            base_dir=evidence_pack.get("_base_dir"),
        )
        return _poll_for_judge_response(
            envelope=envelope,
            role=role,
            cfg=cfg,
            base_dir=evidence_pack.get("_base_dir"),
        )

    return _judge_fn


# ---------------------------------------------------------------------
# SandboxFn factory
# ---------------------------------------------------------------------


def select_sandbox_runner(config: DispatcherConfig | None = None):
    """Plan ARIA-V7 §2g v2 — return a SandboxFn.

    Returns ``skill_genesis.execute_adapter_against_corpus`` (V6.2
    B-V3-2 surface) wrapped to match the SandboxFn signature.
    """
    def _sandbox_fn(
        *,
        primary_draft: dict[str, Any],
        calibration_corpus_path: Path,
    ) -> dict[str, Any]:
        from .skill_genesis import execute_adapter_against_corpus
        adapter_path = primary_draft.get("adapter_path") or primary_draft.get("draft_id", "unknown")
        adapter_lang = primary_draft.get("adapter_lang", "python")
        return execute_adapter_against_corpus(
            adapter_path=adapter_path,
            adapter_lang=adapter_lang,
            corpus_path=calibration_corpus_path,
            workspace_root=primary_draft.get("_workspace_root", Path.cwd()),
        )

    return _sandbox_fn


# ---------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------


def _poll_for_drafter_response(
    *,
    envelope: dict[str, Any],
    role: str,
    cfg: DispatcherConfig,
    base_dir: str | Path | None,
    fallback_role: str,
    seed_id: str,
) -> dict[str, Any]:
    """Poll for a drafter's submission; on timeout return structured fallback.

    Fallback verdict surfaces in the drainer's aggregate_verdict as
    ``dispatchers_unavailable`` so the operator sees the gap.
    """
    request_id = envelope.get("request_id", "")
    deadline = time.monotonic() + float(cfg.get("poll_timeout_seconds", _DEFAULT_POLL_TIMEOUT_SECONDS))
    interval = float(cfg.get("poll_interval_seconds", _DEFAULT_POLL_INTERVAL_SECONDS))
    while time.monotonic() < deadline:
        response_path = _find_response_path(request_id, base_dir)
        if response_path is not None and response_path.exists():
            try:
                payload = json.loads(response_path.read_text(encoding="utf-8"))
                return _normalize_drafter_response(payload, role=fallback_role)
            except (OSError, json.JSONDecodeError):
                break
        time.sleep(interval)
    # Fallback — no consumer fulfilled in time.
    return _fallback_drafter_response(role=fallback_role, seed_id=seed_id)


def _poll_for_judge_response(
    *,
    envelope: dict[str, Any],
    role: str,
    cfg: DispatcherConfig,
    base_dir: str | Path | None,
) -> dict[str, Any]:
    request_id = envelope.get("request_id", "")
    deadline = time.monotonic() + float(cfg.get("poll_timeout_seconds", _DEFAULT_POLL_TIMEOUT_SECONDS))
    interval = float(cfg.get("poll_interval_seconds", _DEFAULT_POLL_INTERVAL_SECONDS))
    while time.monotonic() < deadline:
        response_path = _find_response_path(request_id, base_dir)
        if response_path is not None and response_path.exists():
            try:
                payload = json.loads(response_path.read_text(encoding="utf-8"))
                return _normalize_judge_response(payload)
            except (OSError, json.JSONDecodeError):
                break
        time.sleep(interval)
    return {"verdict": "gaps_open", "gaps": [], "dispatchers_unavailable": True}


def _find_response_path(request_id: str, base_dir: str | Path | None) -> Path | None:
    if not request_id or base_dir is None:
        return None
    root = ensure_tools_dir(base_dir)
    response_dir = root / "agent-invocations" / "responses"
    if not response_dir.exists():
        return None
    candidate = response_dir / f"{request_id}.json"
    return candidate if candidate.exists() else None


def _normalize_drafter_response(payload: dict[str, Any], *, role: str) -> dict[str, Any]:
    """Normalize a drafter agent's response envelope into the DrafterFn return shape."""
    details = payload.get("details") or {}
    return {
        "draft_id": details.get("draft_id") or payload.get("request_id", ""),
        "role": "primary" if role == "primary_authoring" else "challenger",
        "rules": list(details.get("rules") or []),
        "evidence_refs": list(details.get("evidence_refs") or payload.get("evidence_refs") or []),
        "peer_audit": list(details.get("peer_audit") or []),
        "critiques": list(details.get("critiques") or []),
        "adapter_source": details.get("adapter_source", ""),
        "adapter_manifest": details.get("adapter_manifest") or {},
    }


def _normalize_judge_response(payload: dict[str, Any]) -> dict[str, Any]:
    details = payload.get("details") or {}
    verdict = details.get("verdict") or "gaps_open"
    return {
        "verdict": verdict,
        "gaps": list(details.get("gaps") or []),
        "evidence_refs": list(payload.get("evidence_refs") or []),
    }


def _fallback_drafter_response(*, role: str, seed_id: str) -> dict[str, Any]:
    """Plan ARIA-V7 §2g v2 — no consumer fulfilled; emit structured fallback.

    The drainer sees this empty-rules draft and routes the seed to
    ``dispatchers_unavailable`` aggregate verdict (operator-visible).
    """
    return {
        "draft_id": f"fallback-{role}-{seed_id}",
        "role": "primary" if role == "primary_authoring" else "challenger",
        "rules": [],
        "evidence_refs": [],
        "peer_audit": [],
        "critiques": [],
        "adapter_source": "",
        "adapter_manifest": {},
        "dispatchers_unavailable": True,
    }
