"""Plan 032 Faz 032c — Claude sessions are bound, fingerprinted and resumable.

WHY: every dispatch started a fresh Claude session; a requeued request paid
the whole prompt again and the previous session's tool history was lost. The
CLI already supports ``--session-id`` and ``--resume`` — nothing in ARIA
minted a session id or decided when resuming was SAFE.

WHAT: a per-claim session record on ``agent-invocations/sessions.jsonl``
(declared; a separate ledger so the claim fold stays untouched):
``{request_id, claim_id, claude_session_id, fingerprint, ...}``. The
FINGERPRINT is what makes resume safe: the sha256 of every input that shapes
the session's authority — target_sha, runtime profile id, prompt hash,
settings hash (policy + hooks), model family, policy version. A session
started under one envelope is never resumed under another; the recovery
classifier (``recovery.classify_recovery``) consults this ledger and the work
journal and returns ``resume`` only when the fingerprint matches AND the
session made progress.
"""
from __future__ import annotations

import hashlib
import json
import os
import uuid
from pathlib import Path
from typing import Any, Mapping

from .ledger import append_declared_jsonl, load_declared_jsonl
from .tool_registry import ensure_tools_dir, utc_now

SESSIONS_SURFACE = "agent_sessions"
SESSIONS_RELPATH = ("agent-invocations", "sessions.jsonl")
POLICY_VERSION = "aria-policy/2026-09-03"

# ARIA-HIGH-179 — where a session's transcript OUTLIVES the spawn that wrote
# it. The managed sandbox gives every spawn a tmpfs HOME and points
# CLAUDE_CONFIG_DIR inside it (implementation_safety.SANDBOX_HOME): the CLI
# writes the conversation under `<config>/projects/<cwd>/<session>.jsonl`
# and the tmpfs is gone with the process. A resumed session (`--resume`)
# therefore never found its conversation — the CLI answered
# `error_during_execution: No conversation found with session ID` in zero
# turns, the executor released the claim `native_runtime_execution_
# unavailable`, and the next dispatch resumed the same session again
# (observed 2026-09-19, AIR-aria-challenger-planner-2d16fdbb749e: the
# fingerprint matched, the journal showed progress, the transcript did not
# exist). The store is a directory on the runner outside every checkout,
# bound writable at `<config>/projects` inside the sandbox, so the next
# spawn of the same request (same worktree path, hence the same project
# key) reads what the last one wrote; and `decide_session` resumes only
# when the transcript is actually there.
SESSION_STORE_ENV_VAR = "ARIA_SESSION_STORE_DIR"
SESSION_STORE_PROJECTS_DIRNAME = "projects"


def session_store_dir(environ: Mapping[str, str] | None = None) -> Path:
    """The durable session store: ``$ARIA_SESSION_STORE_DIR`` when the runner
    sets it, else ``~/.config/aria/sessions`` of the executor's own user."""
    env = os.environ if environ is None else environ
    explicit = str(env.get(SESSION_STORE_ENV_VAR) or "").strip()
    if explicit:
        return Path(explicit)
    xdg = str(env.get("XDG_CONFIG_HOME") or "").strip()
    base = Path(xdg) if xdg else Path.home() / ".config"
    return base / "aria" / "sessions"


def transcript_present(session_id: str, *, store_dir: Path | None) -> bool:
    """True when the store holds the CLI's conversation file for ``session_id``."""
    if store_dir is None or not session_id:
        return False
    projects = Path(store_dir) / SESSION_STORE_PROJECTS_DIRNAME
    if not projects.is_dir():
        return False
    return any(projects.glob(f"*/{session_id}.jsonl"))


def mint_session_id() -> str:
    return str(uuid.uuid4())


def session_fingerprint(
    *,
    target_sha: str | None,
    profile_id: str | None,
    prompt_hash: str | None,
    settings_hash: str | None,
    model: str | None,
    policy_version: str = POLICY_VERSION,
) -> str:
    payload = json.dumps({
        "target_sha": target_sha or "", "profile_id": profile_id or "", "prompt_hash": prompt_hash or "",
        "settings_hash": settings_hash or "", "model_family": _model_family(model), "policy_version": policy_version,
    }, sort_keys=True)
    return "fp:" + hashlib.sha256(payload.encode("utf-8")).hexdigest()[:32]


def _model_family(model: str | None) -> str:
    text = str(model or "")
    return "glm" if text.startswith("glm") else (
        "codex" if "codex" in text or text == "gpt-6-astra" else "anthropic"
    )


def bind_session(
    *,
    request_id: str,
    claim_id: str,
    claude_session_id: str,
    fingerprint: str,
    resumed_from: str | None = None,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    return append_declared_jsonl(
        ensure_tools_dir(base_dir).joinpath(*SESSIONS_RELPATH),
        {
            "schema_version": 1, "event": "bound", "recorded_at": utc_now(), "request_id": request_id,
            "claim_id": claim_id, "claude_session_id": claude_session_id, "fingerprint": fingerprint,
            "resumed_from": resumed_from,
        },
        expected_surface=SESSIONS_SURFACE,
    )


def sessions_for(request_id: str, *, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    path = ensure_tools_dir(base_dir).joinpath(*SESSIONS_RELPATH)
    if not path.exists():
        return []
    return [r for r in load_declared_jsonl(path, expected_surface=SESSIONS_SURFACE) if r.get("request_id") == request_id]


def last_session_for(request_id: str, *, base_dir: str | Path | None = None) -> dict[str, Any] | None:
    """The latest bound session plus how much work its journal shows."""
    rows = sessions_for(request_id, base_dir=base_dir)
    if not rows:
        return None
    last = dict(rows[-1])
    from .hooks import journal_rows_for

    session_id = str(last.get("claude_session_id") or "")
    journal = [r for r in journal_rows_for(request_id, base_dir=base_dir) if r.get("session_id") == session_id]
    last["journal_rows"] = len(journal)
    return last


def decide_session(
    *,
    request_id: str,
    claim_id: str,
    fingerprint: str,
    base_dir: str | Path | None = None,
    store_dir: Path | None = None,
) -> tuple[str, bool]:
    """(claude_session_id, resume) for a dispatch about to spawn.

    Resume only when the previous session for this request carries the same
    fingerprint, made progress, AND its transcript is in the durable
    ``store_dir`` (ARIA-HIGH-179 — a resume the CLI cannot honour is a
    dispatch that dies in zero turns); otherwise mint a fresh session. The
    binding row is appended either way so the next dispatch can decide, and
    it says whether the transcript was there.
    """
    previous = last_session_for(request_id, base_dir=base_dir)
    if previous and previous.get("fingerprint") == fingerprint and int(previous.get("journal_rows") or 0) > 0:
        session_id = str(previous["claude_session_id"])
        if transcript_present(session_id, store_dir=store_dir):
            bind_session(request_id=request_id, claim_id=claim_id, claude_session_id=session_id,
                         fingerprint=fingerprint, resumed_from=str(previous.get("claim_id") or ""),
                         base_dir=base_dir)
            return session_id, True
    session_id = mint_session_id()
    bind_session(request_id=request_id, claim_id=claim_id, claude_session_id=session_id,
                 fingerprint=fingerprint, base_dir=base_dir)
    return session_id, False


__all__ = [
    "POLICY_VERSION", "SESSIONS_RELPATH", "SESSIONS_SURFACE", "SESSION_STORE_ENV_VAR",
    "SESSION_STORE_PROJECTS_DIRNAME", "bind_session", "decide_session", "last_session_for",
    "mint_session_id", "session_fingerprint", "session_store_dir", "sessions_for", "transcript_present",
]
