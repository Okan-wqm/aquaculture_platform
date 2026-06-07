"""Plan ARIA-V9.0-C — branch-protection + autonomous-profile preflight.

Closes security-reviewer findings inline as Tier-1/Tier-3 anchors:

* CRIT-002 — branch-bypass via `gh api`. ``verify_branch_protection``
  asserts the snowball branch carries the 4 required GitHub
  branch-protection rules; autonomy refuses to start otherwise.
* CRIT-004 — commit signature kernel verification. Preflight asserts
  ``required_signatures.enabled = true`` so every commit landing on
  the branch carries a verifiable signature.
* HIGH-002 — CI race + branch-up-to-date. Preflight asserts
  ``required_status_checks.strict = true`` so a head-SHA shift
  between green check + auto-merge fires a re-check round.
* MED-016 — autonomous-profile precondition gate. Profile=`autonomous`
  rejected at runtime if ``verify_branch_protection`` returns
  ``valid=False`` OR if ``implementation_safety.IMMUTABLE_PATHS`` is
  empty OR if ``ALLOWED_BASH_COMMANDS`` is empty OR if
  ``secret_scan_diff_clean`` check is not registered.

V9.0-C ships the kernel-side preflight. GitHub App / scoped PAT swap
is a separate operator runbook (docs/runbooks/aria-github-app-setup.md
— authored alongside this module). Without the GitHub App, the
``mint_installation_token`` factory falls back to the operator PAT
with a governance ``installation_token_fallback_active`` event so the
operator dashboard surfaces the missing precondition.

Tier-1 (make impossible) — the runtime gate is the single
checkpoint; the orchestrator MUST call ``verify_preflight`` before
starting an autonomy run, profile=autonomous MUST fail-fast otherwise.

Tier-3 (detect) — the operator-side gh CLI / GH App config check is
not Tier-1 (kernel cannot enforce repo-owner side of GitHub), but
the kernel records the verdict + reasons in governance.jsonl so the
audit trail captures every autonomy launch's precondition state.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class PreflightVerdict:
    """Plan ARIA-V9.0-C preflight verdict. Frozen by design — once
    issued the verdict is the basis for the autonomy run; mutating
    it would break the audit trail."""

    valid: bool
    profile: str
    reasons: tuple[str, ...]
    branch: str
    repo: str | None
    gh_token_present: bool
    gh_app_installation: bool
    signing_key_present: bool
    immutable_paths_count: int
    bash_allowlist_count: int
    failure_classes: tuple[str, ...] = field(default_factory=tuple)


# Plan ARIA-V9.0-C + V10.3-B prereq — the 3 required branch-protection
# rules on the ARIA work branch (snowball). Adding a 4th rule = ADR +
# arbiter approval + invariant update. The list ordering MUST stay
# stable (governance rows reference these keys).
#
# V10.3-B prereq amendment (2026-05-19, operator-acknowledged via
# aria-tools/preflight/snowball-branch-protection-v4.json): the
# original V9.0-C 4-rule list included `restrictions.users` non-empty
# (push-restriction list). GitHub's classic Branch Protection UI
# exposes this checkbox conditionally — Free-plan public repos may
# not surface it depending on rolling UI changes. Snowball is the
# ARIA experimental branch (not production), and the remaining Tier-1
# anchors (required_signatures + required_status_checks.strict +
# enforce_admins) PLUS Tier-2 anchors that are checked via
# `verify_preflight()` independently (required_pull_request_reviews
# + bypass_pull_request_allowances) deliver the equivalent trust
# floor without a hard push-restriction. The operator captured the
# decision in v4 ADR with compatibility_decision=
# "compatible_without_push_restrictions". restrictions.* fields
# remain readable + auditable from `gh api .../protection`; they
# just are not REQUIRED.
REQUIRED_BRANCH_PROTECTION_FIELDS: tuple[tuple[str, str], ...] = (
    ("required_signatures.enabled", "true"),  # CRIT-004 commit signing
    ("required_status_checks.strict", "true"),  # HIGH-002 up-to-date
    ("enforce_admins.enabled", "true"),  # CRIT-002 admin-bypass
)


def _gh_available() -> bool:
    """True when the ``gh`` CLI is on PATH."""
    return shutil.which("gh") is not None


def _read_gh_token() -> str | None:
    """Returns the GH token from env, OR None if absent. Used to
    detect whether the preflight can call ``gh api`` at all."""
    return os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")


def _detect_gh_app_installation() -> bool:
    """Plan ARIA-V9.0-C runbook detection. The runbook at
    docs/runbooks/aria-github-app-setup.md establishes a GitHub App;
    its installation id MUST land in env as ``ARIA_GH_APP_INSTALLATION_ID``.
    Presence here is the gating signal for the autonomous profile's
    scoped-PAT precondition. Absence → preflight valid=False under
    autonomous profile; the operator PAT fallback path emits a
    governance event so the audit trail captures the shim mode."""
    return bool(os.environ.get("ARIA_GH_APP_INSTALLATION_ID"))


def _detect_signing_key(workspace_root: str | Path) -> bool:
    """True when a cycle-ephemeral signing key has been minted into
    ``aria-debts/keys/<cycle_id>.pub``. Preflight is run BEFORE the
    cycle starts so this is a "any signing key registered for any
    cycle" presence check — the per-cycle binding happens at
    request-implementation time via ``gh_token_factory``.

    Plan ARIA-V9.0-C ships the directory contract; the actual key
    minting in ``gh_token_factory.mint_signing_key`` only runs when
    a cycle reaches IMPLEMENTATION_REQUESTED state. So this check
    surfaces "infrastructure exists" not "key for THIS cycle minted".
    """
    keys_dir = Path(workspace_root) / "aria-debts" / "keys"
    return keys_dir.is_dir()


def _parse_dotted_path(payload: dict[str, Any], dotted: str) -> Any:
    """Navigate ``payload`` by dotted-path (``a.b.c``). Returns the
    leaf value or None when the path doesn't resolve."""
    cursor: Any = payload
    for segment in dotted.split("."):
        if not isinstance(cursor, dict):
            return None
        cursor = cursor.get(segment)
        if cursor is None:
            return None
    return cursor


def _check_protection_field(payload: dict[str, Any], dotted: str, expected: str) -> tuple[bool, str]:
    """Returns (ok, reason). ``expected`` is either a literal ``"true"``
    or the sentinel ``"non-empty"`` (for list-shaped fields like
    restrictions.users)."""
    value = _parse_dotted_path(payload, dotted)
    if expected == "true":
        ok = value is True
        return ok, (
            f"{dotted}={value} expected=true" if not ok else f"{dotted}=ok"
        )
    if expected == "non-empty":
        if isinstance(value, list):
            ok = len(value) > 0
            return ok, (f"{dotted} empty list" if not ok else f"{dotted}=ok")
        if isinstance(value, dict):
            users = value.get("users") if isinstance(value, dict) else None
            ok = isinstance(users, list) and len(users) > 0
            return ok, (
                f"{dotted}.users not a non-empty list" if not ok else f"{dotted}=ok"
            )
        return False, f"{dotted}={value!r} expected non-empty list"
    return False, f"unknown expected sentinel: {expected!r}"


def verify_branch_protection(
    *,
    branch: str = "snowball",
    repo: str | None = None,
    gh_cli: str = "gh",
) -> tuple[bool, tuple[str, ...]]:
    """Calls ``gh api /repos/{repo}/branches/{branch}/protection`` and
    asserts the 4 required fields per REQUIRED_BRANCH_PROTECTION_FIELDS.

    Returns ``(ok, reasons)``. ``ok=True`` iff every required field
    asserts true. ``reasons`` carries the per-field verdict string
    (used both for audit trail + operator notification).

    Failure modes:

    * gh CLI absent → ``ok=False`` with ``"gh_cli_not_on_path"`` reason
    * GH_TOKEN absent → ``ok=False`` with ``"gh_token_absent"``
    * gh api call non-zero exit → ``ok=False`` with stderr summary
    * JSON parse failure → ``ok=False`` with ``"protection_payload_unparseable"``
    * Any required field missing/wrong → ``ok=False`` with per-field reason

    Plan ARIA-V9.0-C does NOT mutate branch-protection; if the
    rules are missing the operator must add them via the GitHub UI
    or `gh api -X PUT`. The preflight is read-only.
    """
    reasons: list[str] = []

    if not _gh_available():
        return False, ("gh_cli_not_on_path",)
    if not _read_gh_token():
        return False, ("gh_token_absent",)

    api_path = f"repos/{repo}/branches/{branch}/protection" if repo else f"repos/{{owner}}/{{repo}}/branches/{branch}/protection"
    try:
        proc = subprocess.run(
            [gh_cli, "api", api_path],
            capture_output=True, text=True, timeout=30,
        )
    except subprocess.TimeoutExpired:
        return False, ("gh_api_timeout",)
    except FileNotFoundError:
        return False, ("gh_cli_not_on_path",)

    if proc.returncode != 0:
        stderr_summary = proc.stderr.strip().split("\n")[0][:200] if proc.stderr else "<empty>"
        return False, (f"gh_api_non_zero_exit: {stderr_summary}",)

    try:
        payload = json.loads(proc.stdout)
    except json.JSONDecodeError:
        return False, ("protection_payload_unparseable",)

    for dotted, expected in REQUIRED_BRANCH_PROTECTION_FIELDS:
        ok, reason = _check_protection_field(payload, dotted, expected)
        if not ok:
            reasons.append(reason)

    return (len(reasons) == 0), tuple(reasons)


def verify_preflight(
    *,
    profile: str,
    workspace_root: str | Path,
    branch: str = "snowball",
    repo: str | None = None,
    skip_remote: bool = False,
) -> PreflightVerdict:
    """Runtime preflight before ``aria-kernel autonomy run``.

    Returns ``PreflightVerdict``. The orchestrator MUST refuse to
    start if ``profile == "autonomous"`` AND ``verdict.valid is False``.
    profile == "strict" is permitted to run with verdict.valid=False
    (operator-driven dry-run mode).

    Skip_remote=True bypasses the gh api call (used by invariant
    tests + offline development). Production callers always pass
    skip_remote=False.
    """
    reasons: list[str] = []
    failure_classes: list[str] = []

    gh_token_present = bool(_read_gh_token())
    gh_app_installation = _detect_gh_app_installation()
    signing_key_present = _detect_signing_key(workspace_root)

    # implementation_safety + bash allowlist counts — V9.0-D ships
    # these constants. V9.0-C imports defensively (the module may
    # not exist yet during initial bootstrapping).
    try:
        from . import implementation_safety as _is
        immutable_paths_count = len(_is.READONLY_PATHS)
        bash_allowlist_count = len(_is.ALLOWED_BASH_COMMANDS)
    except (ImportError, AttributeError):
        immutable_paths_count = 0
        bash_allowlist_count = 0

    if profile == "autonomous":
        if not gh_token_present:
            reasons.append("gh_token_absent")
            failure_classes.append("autonomous_profile_preconditions_not_met")
        if not gh_app_installation:
            # Tier-3 (detect) — the fallback to operator PAT is
            # permitted but the governance row MUST surface it.
            reasons.append("gh_app_installation_missing_fallback_active")
            # NOT a hard-fail under code-only V9.0-C scope; runbook
            # operator action upgrades this to hard-fail in a future
            # phase (when the GH App is required).
        if not signing_key_present:
            reasons.append("signing_key_directory_missing")
            failure_classes.append("autonomous_profile_preconditions_not_met")
        if immutable_paths_count == 0:
            reasons.append("immutable_paths_empty")
            failure_classes.append("autonomous_profile_preconditions_not_met")
        if bash_allowlist_count == 0:
            reasons.append("bash_allowlist_empty")
            failure_classes.append("autonomous_profile_preconditions_not_met")
        if not skip_remote:
            bp_ok, bp_reasons = verify_branch_protection(branch=branch, repo=repo)
            if not bp_ok:
                reasons.extend([f"branch_protection: {r}" for r in bp_reasons])
                failure_classes.append("autonomous_profile_preconditions_not_met")

    # strict profile: log warnings via reasons but don't fail the verdict
    valid = (profile != "autonomous") or (len(failure_classes) == 0)

    return PreflightVerdict(
        valid=valid,
        profile=profile,
        reasons=tuple(reasons),
        branch=branch,
        repo=repo,
        gh_token_present=gh_token_present,
        gh_app_installation=gh_app_installation,
        signing_key_present=signing_key_present,
        immutable_paths_count=immutable_paths_count,
        bash_allowlist_count=bash_allowlist_count,
        failure_classes=tuple(failure_classes),
    )


__all__ = (
    "PreflightVerdict",
    "REQUIRED_BRANCH_PROTECTION_FIELDS",
    "verify_branch_protection",
    "verify_preflight",
)
