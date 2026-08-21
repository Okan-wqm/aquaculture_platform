"""Plan ARIA-V9.0-C — branch-protection + autonomous-profile preflight.

Closes security-reviewer findings inline as Tier-1/Tier-3 anchors:

* CRIT-002 — branch-bypass via `gh api`. ``verify_branch_protection``
  asserts the main branch carries the 4 required GitHub
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

# ORPHAN-HIGH-728 — profile authority is READ from the table, never
# restated. Every `profile == "autonomous"` / `profile in (...)` in this
# module was a second copy of it, and copies of that mapping are what
# shipped a nightly lane running a profile the table said could not open a
# pull request. `pr_merge` names the merge-class profiles (the ones that can
# land without a human, and so must satisfy branch protection and signing
# preconditions); `PROFILES_WITH_ACTION_AUTHORITY` names every profile that
# can act at all, which is the right audience for environment facts.
from .runtime_profile import ACTION_PERMISSIONS, PROFILES_WITH_ACTION_AUTHORITY
from .workflow_contract_registry import (
    WORKFLOW_CONTRACTS,
    WorkflowJobContract,
    workflow_hash as compute_workflow_hash,
    workflow_job_contract,
    workflow_job_contract_hash,
)
from .workflow_contracts import verify_workflow_contract


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
    # FAZ 5d — the environment facts every RUN profile needs (additive,
    # defaulted so pre-existing constructions stay valid).
    sandbox_backend_present: bool = False
    node_modules_present: bool = False


@dataclass(frozen=True)
class WorkflowPreflightVerdict:
    schema_version: int
    workflow_id: str
    job_id: str
    profile: str
    kill_switch_active: bool
    network_policy: tuple[str, ...]
    allowed_write_roots: tuple[str, ...]
    path_allowlist: tuple[str, ...]
    external_root_allowlist: tuple[str, ...]
    token_provenance: str | None
    dlp_mode: str
    audit_reason: str | None
    valid: bool
    workflow_hash: str | None = None
    contract_hash: str | None = None
    runtime_write_paths: tuple[str, ...] = ()
    network_enforcement_evidence: str | None = None
    audit_artifact_path: str | None = None
    worktree_clean: bool | None = None
    dlp_scan_clean: bool | None = None
    failure_classes: tuple[str, ...] = field(default_factory=tuple)
    reasons: tuple[str, ...] = field(default_factory=tuple)


# Plan ARIA-V9.0-C + V10.3-B prereq — the 3 required branch-protection
# rules on the ARIA target branch (main). Adding a 4th rule = ADR +
# arbiter approval + invariant update. The list ordering MUST stay
# stable (governance rows reference these keys).
#
# V10.3-B prereq amendment (2026-05-19, operator-acknowledged for
# the mainline branch-protection decision): the
# original V9.0-C 4-rule list included `restrictions.users` non-empty
# (push-restriction list). GitHub's classic Branch Protection UI
# exposes this checkbox conditionally — Free-plan public repos may
# not surface it depending on rolling UI changes. Main is the
# current ARIA target branch, and the remaining Tier-1
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


# E18 (ORPHAN-672) — minimum free disk for a night to start. 5 GB covers
# a full cycle's worktrees + ledger appends + artifact hot-tier with
# headroom; the operator can widen or narrow it per host without a code
# change. Guarded as env because disk is a HOST property, not repo policy.
MIN_FREE_DISK_GB = float(os.environ.get("ARIA_MIN_FREE_DISK_GB", "5"))


def _free_disk_gb(workspace_root: str | Path) -> float | None:
    """Free space on the filesystem carrying the workspace, in GB.

    Returns None when the probe itself fails (permission, exotic mount) —
    an unprobeable disk must not fail preflight; only a MEASURED low disk
    does. The distinction keeps this check honest on unusual hosts.
    """
    try:
        usage = shutil.disk_usage(str(workspace_root))
    except OSError:
        return None
    return usage.free / (1024**3)


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


def probe_branch_protection(
    *,
    branch: str = "main",
    repo: str | None = None,
    gh_cli: str = "gh",
) -> tuple[bool, tuple[str, ...], dict[str, Any] | None]:
    """The ONE branch-protection probe: verdict + reasons + RAW payload.

    F5-b (ORPHAN-694) — the readiness proof producer needs the payload
    itself (snapshot hash, measured fields), not just the verdict. One
    probe serves both consumers (İ1): ``verify_branch_protection`` keeps
    its (ok, reasons) contract as a thin projection of this function.

    Failure modes (payload=None in every one):

    * gh CLI absent → ``ok=False`` with ``"gh_cli_not_on_path"`` reason
    * GH_TOKEN absent → ``ok=False`` with ``"gh_token_absent"``
    * gh api call non-zero exit → ``ok=False`` with stderr summary
    * JSON parse failure → ``ok=False`` with ``"protection_payload_unparseable"``
    * Any required field missing/wrong → ``ok=False`` with per-field
      reason, but the PAYLOAD is still returned — a proof producer must
      be able to record honestly what IS configured.

    Plan ARIA-V9.0-C does NOT mutate branch-protection; if the
    rules are missing the operator must add them via the GitHub UI
    or `gh api -X PUT`. The probe is read-only.
    """
    reasons: list[str] = []

    if not _gh_available():
        return False, ("gh_cli_not_on_path",), None
    if not _read_gh_token():
        return False, ("gh_token_absent",), None

    api_path = f"repos/{repo}/branches/{branch}/protection" if repo else f"repos/{{owner}}/{{repo}}/branches/{branch}/protection"
    try:
        proc = subprocess.run(
            [gh_cli, "api", api_path],
            capture_output=True, text=True, timeout=30,
        )
    except subprocess.TimeoutExpired:
        return False, ("gh_api_timeout",), None
    except FileNotFoundError:
        return False, ("gh_cli_not_on_path",), None

    if proc.returncode != 0:
        stderr_summary = proc.stderr.strip().split("\n")[0][:200] if proc.stderr else "<empty>"
        return False, (f"gh_api_non_zero_exit: {stderr_summary}",), None

    try:
        payload = json.loads(proc.stdout)
    except json.JSONDecodeError:
        return False, ("protection_payload_unparseable",), None

    for dotted, expected in REQUIRED_BRANCH_PROTECTION_FIELDS:
        ok, reason = _check_protection_field(payload, dotted, expected)
        if not ok:
            reasons.append(reason)

    return (len(reasons) == 0), tuple(reasons), payload


def verify_branch_protection(
    *,
    branch: str = "main",
    repo: str | None = None,
    gh_cli: str = "gh",
) -> tuple[bool, tuple[str, ...]]:
    """(ok, reasons) projection of ``probe_branch_protection`` — see there."""
    ok, reasons, _payload = probe_branch_protection(
        branch=branch, repo=repo, gh_cli=gh_cli,
    )
    return ok, reasons


def verify_preflight(
    *,
    profile: str,
    workspace_root: str | Path,
    branch: str = "main",
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

    merge_authority_profiles = ACTION_PERMISSIONS["pr_merge"]
    # FAZ 5d — environment facts, measured for EVERY run profile. The
    # nightly producer runs `standard` and used to skip preflight entirely,
    # so a host with no sandbox or no node deps produced a green-looking run
    # whose every dispatch then failed downstream with the fault priced on
    # the tools (M-2.5). Signature and branch-protection checks stay
    # autonomous-only; the environment subset is universal.
    try:
        from .implementation_safety import sandbox_backend as _sandbox_backend

        sandbox_backend_present = _sandbox_backend() is not None
    except (ImportError, AttributeError):
        sandbox_backend_present = False
    node_modules_present = (Path(workspace_root) / "node_modules").is_dir()
    # E18 (ORPHAN-672) — disk is an environment precondition. A 98%-full
    # host turned ledger writes into ENOSPC failures that masqueraded as
    # test errors and chain corruption (lived 2026-08-13); the honest
    # defence is refusing to START a night the disk cannot carry, with a
    # named reason instead of downstream noise.
    free_disk_gb = _free_disk_gb(workspace_root)
    disk_ok = free_disk_gb is None or free_disk_gb >= MIN_FREE_DISK_GB
    if profile in PROFILES_WITH_ACTION_AUTHORITY:
        if not sandbox_backend_present:
            reasons.append("sandbox_backend_absent")
            if profile in merge_authority_profiles:
                failure_classes.append("autonomous_profile_preconditions_not_met")
            else:
                failure_classes.append("environment_preconditions_not_met")
        if not node_modules_present:
            reasons.append("node_modules_absent")
            if profile not in merge_authority_profiles:
                failure_classes.append("environment_preconditions_not_met")
        if not disk_ok:
            reasons.append(
                f"disk_low:free_gb={free_disk_gb:.1f}:min_gb={MIN_FREE_DISK_GB}"
            )
            failure_classes.append("environment_preconditions_not_met")

    if profile in merge_authority_profiles:
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

    # Proposal-class profiles: log warnings via reasons but don't fail the
    # verdict. Only merge-class authority hard-fails on its own preconditions.
    valid = (profile not in merge_authority_profiles) or (len(failure_classes) == 0)

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
        sandbox_backend_present=sandbox_backend_present,
        node_modules_present=node_modules_present,
    )


def verify_workflow_preflight(
    *,
    workflow_id: str,
    job_id: str,
    profile: str,
    workspace_root: str | Path,
    allowed_write_roots: tuple[str, ...] | list[str],
    path_allowlist: tuple[str, ...] | list[str],
    network_policy: tuple[str, ...] | list[str] = (),
    token_provenance: str | None = None,
    dlp_mode: str = "fail_closed",
    dlp_scan_clean: bool = True,
    workflow_hash: str | None = None,
    audit_reason: str | None = None,
    network_enforcement_evidence: str | None = None,
    audit_artifact_path: str | Path | None = None,
    require_github_app: bool = True,
    external_root_allowlist: tuple[str, ...] | list[str] = (),
) -> WorkflowPreflightVerdict:
    """Enterprise per-job workflow preflight for governed ARIA write paths.

    ADR-036 — ``job_id`` is REQUIRED (BREAKING CHANGE, D5). When the
    (workflow_id, job_id) pair resolves to a registered ``WorkflowJobContract``
    the verdict is bound to that contract: network policy, token provenance,
    write paths and the audit-artifact path are checked against the contract
    exactly. When no job contract matches (standalone / un-registered callers)
    the verdict falls back to main's pre-ADR-036 checks, INCLUDING the
    github-app token-VALUE allowlist (``allowed_token_provenance``), so a
    standalone caller does not silently lose the token-value security check.

    The verdict is frozen so a workflow can persist it as audit evidence
    without mutation risk.
    """
    reasons: list[str] = []
    failure_classes: list[str] = []
    workspace = Path(workspace_root).resolve()
    contract = WORKFLOW_CONTRACTS.get(workflow_id)
    job_contract = workflow_job_contract(workflow_id, job_id)
    contract_digest = workflow_job_contract_hash(workflow_id, job_id)
    observed_workflow_hash: str | None = None
    if contract is not None and job_contract is not None:
        workflow_path = workspace / contract.workflow_file
        if workflow_path.exists():
            observed_workflow_hash = compute_workflow_hash(workflow_path)
        else:
            reasons.append(f"workflow_yaml_missing:{contract.workflow_file}")
            failure_classes.append("workflow_preflight_contract")

    kill_switch = (
        _env_truthy("ARIA_GLOBAL_KILL_SWITCH")
        or _env_truthy("ARIA_STOP")
        or (workspace / ".aria-kill-switch").exists()
        or (workspace / "aria-tools" / "KILL_SWITCH").exists()
    )

    external_roots = tuple(
        str(item).strip()
        for item in external_root_allowlist
        if str(item).strip()
    )
    roots = tuple(
        _normalise_runtime_path(str(root).strip(), workspace=workspace, external_roots=external_roots)
        for root in allowed_write_roots
        if str(root).strip()
    )
    allowlist = tuple(
        _normalise_runtime_path(str(item).strip(), workspace=workspace, external_roots=external_roots)
        for item in path_allowlist
        if str(item).strip()
    )
    network = tuple(str(item).strip() for item in network_policy if str(item).strip())

    if kill_switch:
        reasons.append("global_kill_switch_active")
        failure_classes.append("global_kill_switch")
    if not workflow_id.strip():
        reasons.append("workflow_id_missing")
        failure_classes.append("workflow_preflight_contract")
    if not job_id.strip():
        reasons.append("workflow_job_id_missing")
        failure_classes.append("workflow_preflight_contract")
    if profile == "frozen" and roots:
        reasons.append("frozen_profile_blocks_mutating_workflow")
        failure_classes.append("frozen_profile_write_block")
    if not roots:
        reasons.append("allowed_write_roots_missing")
        failure_classes.append("workflow_preflight_contract")
    if not allowlist:
        reasons.append("path_allowlist_missing")
        failure_classes.append("workflow_preflight_contract")
    if dlp_mode != "fail_closed":
        reasons.append("dlp_mode_must_be_fail_closed")
        failure_classes.append("dlp_fail_closed_required")
    if dlp_scan_clean is not True:
        reasons.append("dlp_scan_not_clean")
        failure_classes.append("dlp_fail_closed_required")
    if workflow_hash and not re.fullmatch(r"sha256:[0-9a-f]{64}", str(workflow_hash)):
        reasons.append("workflow_hash_invalid")
        failure_classes.append("workflow_preflight_contract")
    if workflow_hash and observed_workflow_hash and workflow_hash != observed_workflow_hash:
        reasons.append("workflow_hash_mismatch")
        failure_classes.append("workflow_preflight_contract")
    if not audit_reason or not audit_reason.strip():
        reasons.append("audit_reason_missing")
        failure_classes.append("workflow_preflight_contract")

    if job_contract is not None:
        # ADR-036 contracted path — bind the verdict to the per-job contract.
        if tuple(sorted(network)) != tuple(sorted(job_contract.network_policy)):
            reasons.append(
                f"network_policy_mismatch:{tuple(sorted(network))}!={tuple(sorted(job_contract.network_policy))}"
            )
            failure_classes.append("network_policy_required")
        if (token_provenance or "") != job_contract.token_source:
            reasons.append(f"token_provenance_mismatch:{token_provenance}!={job_contract.token_source}")
            failure_classes.append("token_provenance_required")
        if audit_artifact_path is not None:
            audit_label = _normalise_runtime_path(
                str(audit_artifact_path),
                workspace=workspace,
                external_roots=external_roots,
            )
            if not re.fullmatch(job_contract.preflight_artifact_path_pattern, audit_label):
                reasons.append(f"preflight_artifact_path_mismatch:{audit_label}")
                failure_classes.append("workflow_preflight_contract")
        for item in roots:
            if not _matches_contract_path(job_contract, item):
                reasons.append(f"allowed_write_root_outside_contract:{item}")
                failure_classes.append("path_allowlist_violation")
        for item in allowlist:
            if not _matches_contract_path(job_contract, item):
                reasons.append(f"path_allowlist_outside_contract:{item}")
                failure_classes.append("path_allowlist_violation")
        if set(roots) != set(allowlist):
            reasons.append("allowed_write_roots_and_path_allowlist_mismatch")
            failure_classes.append("path_allowlist_violation")
    else:
        # No registered job contract — preserve main's pre-ADR-036 checks,
        # INCLUDING the github-app token-VALUE allowlist so standalone callers
        # keep the token-value security check (canonical dropped this).
        if workflow_id.strip() and job_id.strip():
            reasons.append(f"workflow_job_contract_missing:{workflow_id}:{job_id}")
            failure_classes.append("workflow_preflight_contract")
        if require_github_app and not token_provenance:
            reasons.append("token_provenance_missing")
            failure_classes.append("token_provenance_required")
        allowed_token_provenance = {
            "github_app:installation",
            "github_app:installation_token",
            "github_app:verified",
        }
        if require_github_app and token_provenance and token_provenance not in allowed_token_provenance:
            reasons.append("github_app_token_required")
            failure_classes.append("token_provenance_required")

    if not network:
        reasons.append("network_policy_missing")
        failure_classes.append("network_policy_required")
    if network and not (network_enforcement_evidence or "").strip():
        reasons.append("network_enforcement_evidence_missing")
        failure_classes.append("network_policy_required")
    for item in allowlist:
        if any(ch in item for ch in "*?[]"):
            reasons.append(f"path_allowlist_must_be_exact:{item}")
            failure_classes.append("path_allowlist_violation")

    worktree_clean = _git_worktree_clean(workspace)
    if worktree_clean is False:
        reasons.append("workspace_worktree_not_clean")
        failure_classes.append("workflow_preflight_contract")

    for root in roots:
        if not root or root == ".":
            reasons.append(f"allowed_write_root_is_workspace_root:{root}")
            failure_classes.append("path_allowlist_violation")

    verdict = WorkflowPreflightVerdict(
        schema_version=1,
        workflow_id=workflow_id,
        job_id=job_id,
        profile=profile,
        kill_switch_active=kill_switch,
        network_policy=network,
        allowed_write_roots=roots,
        path_allowlist=allowlist,
        external_root_allowlist=external_roots,
        token_provenance=token_provenance,
        dlp_mode=dlp_mode,
        audit_reason=audit_reason,
        workflow_hash=workflow_hash or observed_workflow_hash,
        contract_hash=contract_digest,
        runtime_write_paths=roots,
        network_enforcement_evidence=network_enforcement_evidence,
        audit_artifact_path=str(audit_artifact_path) if audit_artifact_path is not None else None,
        worktree_clean=worktree_clean,
        dlp_scan_clean=dlp_scan_clean,
        valid=not failure_classes,
        failure_classes=tuple(failure_classes),
        reasons=tuple(reasons),
    )
    if audit_artifact_path is not None:
        _write_workflow_preflight_audit(Path(audit_artifact_path), verdict)
    return verdict


def _normalise_runtime_path(path: str, *, workspace: Path, external_roots: tuple[str, ...]) -> str:
    raw = path.strip().strip('"').strip("'")
    raw = re.sub(r"\$\{\{\s*runner\.temp\s*\}\}", "runner-temp", raw)
    if not raw:
        return raw
    raw_path = Path(raw)
    if raw_path.is_absolute():
        resolved = raw_path.resolve()
        try:
            return resolved.relative_to(workspace).as_posix().strip("/")
        except ValueError:
            for external in external_roots:
                external_path = Path(external)
                if not external_path.is_absolute():
                    continue
                try:
                    rel = resolved.relative_to(external_path.resolve())
                    rel_text = rel.as_posix().strip("/")
                    return "runner-temp" if not rel_text else f"runner-temp/{rel_text}"
                except ValueError:
                    continue
            return resolved.as_posix()
    return raw.strip("/")


def _matches_contract_path(job_contract: WorkflowJobContract, path: str) -> bool:
    return any(re.fullmatch(pattern, path) for pattern in job_contract.allowed_write_path_patterns)


def _env_truthy(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes", "on"}


def _git_worktree_clean(workspace: Path) -> bool | None:
    """Is the worktree clean, IGNORING files the cycle legitimately writes.

    A cycle that runs for 30+ minutes modifies tracked files as part of its
    normal operation (CURRENT_STATE.md authority hash, format-scope.json,
    JUDGE-DIGEST.md, generated reports, aria-tools state). The mid-run
    "resolved profile" preflight then sees these as dirt and rejects the
    very run that produced them — a gate that punishes the mechanism it
    guards. The check is scoped: files the cycle is DESIGNED to write are
    excluded; everything else (hand-edited source, unexpected artifact)
    still trips the gate.
    """
    if not (workspace / ".git").exists():
        return None
    completed = subprocess.run(
        ["git", "status", "--porcelain", "--untracked-files=all"],
        cwd=workspace,
        text=True,
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0:
        return False
    _CYCLE_WRITE_PREFIXES = (
        "docs/aria/CURRENT_STATE.md",
        "docs/aria/generated/",
        "tools/quality/format-scope.json",
        "aria-tools/",
    )
    for line in completed.stdout.strip().splitlines():
        path = line[3:] if len(line) > 3 else ""
        if not path:
            continue
        if not any(path.startswith(prefix) for prefix in _CYCLE_WRITE_PREFIXES):
            return False
    return True


def _write_workflow_preflight_audit(path: Path, verdict: WorkflowPreflightVerdict) -> None:
    from dataclasses import asdict

    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(json.dumps(asdict(verdict), indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(path)


__all__ = (
    "PreflightVerdict",
    "WorkflowPreflightVerdict",
    "REQUIRED_BRANCH_PROTECTION_FIELDS",
    "verify_branch_protection",
    "verify_preflight",
    "verify_workflow_preflight",
    "verify_workflow_contract",
)
