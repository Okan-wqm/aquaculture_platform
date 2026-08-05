"""Plan ARIA-V3 §A2 — required-injection GitHub adapter selection.

GAP-3 closure: pre-V3 ``worker_dispatch_hook.dispatch_one_pending_worker_assignment``
accepted ``github_adapter: Any | None = None`` with a ``None``
default that silently routed every verified assignment to
``verified_pending_merge``. Every cycle ran without an adapter
because the scheduler daemon never plumbed one through. V3 makes
the adapter REQUIRED on both surfaces (scheduler + hook) and
supplies a profile-derived factory.

Adapters:

* :class:`GhCliGitHubAdapter` — re-exported from ``auto_merge``;
  real ``gh`` CLI calls. Used by ``strict`` + ``autonomous``
  profiles where merge / observe must hit GitHub for real state.
* :class:`RecordingGitHubAdapter` — audit-only sink that satisfies
  the ``auto_merge.GitHubAdapter`` Protocol but never calls ``gh``.
  Every invocation appends a row to
  ``aria-tools/audit/intended-gh-calls.jsonl`` so the scope-out
  audit chain captures the intent without firing the side effect.
  Used by ``observe`` / ``standard`` / ``frozen`` profiles where
  the loop should NOT touch GitHub state.

The factory ``select_github_adapter`` does the profile → adapter
mapping. Unknown profile raises ``ValueError``.

Plan-026R discipline: invariant tests I-V3-04..06 lock the contract
(scheduler requires the adapter, Recording adapter writes the
audit log, verified-and-mergeable path reaches ``merge_if_green``
when adapter is present).
"""

from __future__ import annotations

import json
import os
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .auto_merge import GhCliGitHubAdapter

__all__ = [
    "GhCliGitHubAdapter",
    "RecordingGitHubAdapter",
    "select_github_adapter",
]


_REAL_ADAPTER_PROFILES: frozenset[str] = frozenset({"strict", "autonomous"})
_RECORDING_ADAPTER_PROFILES: frozenset[str] = frozenset(
    {"observe", "standard", "frozen"}
)

_AUDIT_LOG_RELATIVE_PATH = ("audit", "intended-gh-calls.jsonl")
_AUDIT_WRITE_LOCK = threading.Lock()


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class RecordingGitHubAdapter:
    """Plan ARIA-V3 §A2 — audit-only ``GitHubAdapter`` Protocol impl.

    Never calls ``gh`` CLI. Every method invocation appends a row to
    ``<base_dir>/audit/intended-gh-calls.jsonl`` with the method
    name, arguments, profile context, and a UTC timestamp. Returns
    deterministic stub payloads so downstream code (``merge_if_green``
    + ``evaluate_auto_merge``) sees structurally-valid input and
    fails closed on the "no real PR data" path rather than crashing.

    Threading: the audit-append uses a module-level lock so
    multi-thread test fixtures cannot interleave row writes (the
    JSONL one-row-per-line invariant must hold).

    Plan-026R + Plan ARIA-V2 §3.4 — the audit log path is
    ``aria-tools/audit/intended-gh-calls.jsonl``, gitignored by V2
    I-23 tracked-allowlist update + V3 §A5 .gitignore expansion.
    """

    def __init__(self, *, base_dir: str | Path, profile: str) -> None:
        self.base_dir = Path(base_dir)
        self.profile = profile

    # ----- internal -----------------------------------------------------

    def _audit_path(self) -> Path:
        return self.base_dir.joinpath(*_AUDIT_LOG_RELATIVE_PATH)

    def _record(self, _method_name: str, **call_args: Any) -> None:
        # ``_method_name`` is positional-with-leading-underscore so it
        # never collides with a Protocol method's own ``method`` kwarg
        # (``merge_pr(..., method=...)`` passes ``method`` in
        # ``call_args``; using ``method`` as the slot name here would
        # raise ``TypeError: got multiple values for argument 'method'``).
        row: dict[str, Any] = {
            "schema_version": 1,
            "recorded_at": _utc_now_iso(),
            "method": _method_name,
            "args": call_args,
            "profile": self.profile,
            "adapter": "RecordingGitHubAdapter",
            "pid": os.getpid(),
        }
        audit_path = self._audit_path()
        audit_path.parent.mkdir(parents=True, exist_ok=True)
        line = json.dumps(row, sort_keys=True, separators=(",", ":")) + "\n"
        with _AUDIT_WRITE_LOCK:
            with audit_path.open("a", encoding="utf-8") as handle:
                handle.write(line)
                handle.flush()
                os.fsync(handle.fileno())

    # ----- GitHubAdapter Protocol ---------------------------------------

    def get_pr(self, number: int) -> dict[str, Any]:
        self._record("get_pr", number=number)
        # Minimal-shape stub so evaluate_auto_merge fails closed
        # (eligible=False) rather than crashing on missing keys.
        return {
            "number": number,
            "state": "recording_adapter_no_fetch",
            "baseRefName": "unknown",
            "headRefName": "unknown",
            "diff_text": "",
        }

    def get_latest_head_sha(self, number: int) -> str | None:
        self._record("get_latest_head_sha", number=number)
        return None

    def get_required_checks(self, base_branch: str) -> dict[str, Any]:
        self._record("get_required_checks", base_branch=base_branch)
        return {"contexts": [], "checks": []}

    def get_checks(self, head_sha: str) -> dict[str, Any]:
        self._record("get_checks", head_sha=head_sha)
        return {"check_runs": [], "statuses": []}

    def get_reviews(self, number: int) -> dict[str, Any]:
        self._record("get_reviews", number=number)
        return {"reviews": []}

    def get_unresolved_conversation_count(self, number: int) -> dict[str, Any]:
        self._record("get_unresolved_conversation_count", number=number)
        return {"count": 0}

    def get_pr_diff(self, number: int) -> str | None:
        self._record("get_pr_diff", number=number)
        # Empty diff → evaluate_auto_merge fails closed (Plan 023 v3
        # §P-6 — empty/whitespace/malformed diff blocks auto-merge).
        return ""

    def merge_pr(
        self, number: int, *, method: str, expected_head_sha: str,
    ) -> dict[str, Any]:
        self._record(
            "merge_pr",
            number=number,
            method=method,
            expected_head_sha=expected_head_sha,
        )
        return {
            "merged": False,
            "decision": "skipped_recording_adapter",
            "reason": f"profile_{self.profile}_uses_recording_adapter",
        }

    # ----- MissionObserver Protocol (Wave 2 PR 1.3) ----------------------
    #
    # These return ``None`` rather than a structural stub, and the difference
    # from `get_pr` above is the whole point. `get_pr`'s consumer,
    # `evaluate_auto_merge`, needs a shaped dict so it can fail CLOSED on it;
    # reconciliation's consumer needs to know whether anything was observed at
    # all, and ``None`` says exactly that. A stub here would be an answer, and
    # `mission_reconcile` would have to decide what a fabricated answer means —
    # which is how "not merged" becomes "closed unmerged" and every mission's
    # retry rung burns on a lane that never called GitHub.
    #
    # This is also why the dry-run lane needs no soak flag: the profiles that
    # must not act get an adapter that cannot answer.

    def get_pr_lifecycle(self, number: int) -> dict[str, Any] | None:
        self._record("get_pr_lifecycle", number=number)
        return None

    def observe_branch(self, name: str) -> bool | None:
        self._record("observe_branch", name=name)
        return None

    def list_open_pull_requests(self) -> list[dict[str, Any]] | None:
        self._record("list_open_pull_requests")
        return None


def _aria_dry_run_active() -> bool:
    """Plan ARIA-V3.1-F2 fix — canonical ARIA_DRY_RUN env-var read.

    Centralized truthy parser matching ARIA_REQUIRE_MODE_A in
    gh_token_factory.py. Returns True for "true" / "1" / "yes"
    (case-insensitive, whitespace-tolerant).
    """
    return os.environ.get("ARIA_DRY_RUN", "").strip().lower() in ("true", "1", "yes")


def select_github_adapter(
    *,
    profile: str,
    base_dir: str | Path,
    cwd: str | Path = ".",
) -> Any:
    """Plan ARIA-V3 §A2 — profile-derived adapter factory.

    Adding a new profile requires updating the two constants at the
    top of this module AND a matching V3 invariant test. Unknown
    profile raises ``ValueError`` — no silent default.

    Plan ARIA-V3.1-F2 fix: ARIA_DRY_RUN=true structurally prevents
    real GitHub adapter selection regardless of profile. Closes the
    smoke-runbook regression where ``profile=strict`` +
    ``unshare --net`` collided with ``GhCliGitHubAdapter.__init__``'s
    eager ``gh repo view`` call. The dry-run gate is Tier-1: the
    network-isolation invariant becomes a code guarantee, not just
    operator hygiene. RecordingGitHubAdapter still writes every
    intended call to the audit log so the override is observable.
    """
    if _aria_dry_run_active() and profile in _REAL_ADAPTER_PROFILES:
        return RecordingGitHubAdapter(base_dir=base_dir, profile=profile)
    if profile in _REAL_ADAPTER_PROFILES:
        return GhCliGitHubAdapter(cwd=cwd)
    if profile in _RECORDING_ADAPTER_PROFILES:
        return RecordingGitHubAdapter(base_dir=base_dir, profile=profile)
    raise ValueError(
        f"unknown profile for github_adapter selection: {profile!r}; "
        f"known: {sorted(_REAL_ADAPTER_PROFILES | _RECORDING_ADAPTER_PROFILES)}"
    )
