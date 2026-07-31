"""ADR-036 — per-job CI-workflow governance registry (single SSoT).

This module is the ONE definition of the governed-workflow contract set.
``workflow_contracts.py``, ``preflight.py`` and ``docs_ssot.py`` all import
``WORKFLOW_CONTRACTS`` (and the nested dataclasses) FROM here — there is no
second copy of the contract dict anywhere (CLAUDE.md root-cause SSoT rule).

Contract model (nested, per-job):

* ``WorkflowJobContract`` — the per-job governance unit. A job is the GitHub
  Actions unit that holds a ``permissions:`` scope + a ``steps:`` list, so the
  per-job granularity is what lets ADR-036 verify permissions, the
  SHA-pinned upload-artifact step, the preflight-call shape and the
  write-path allowlist independently for every job in a workflow.
* ``WorkflowContract`` — a workflow groups one-or-more ``WorkflowJobContract``.
* ``AuditedWorkflowExclusion`` — a workflow that is discovered + owned but
  deliberately NOT contract-verified, with an owner + reason + expiry so the
  exclusion is auditable rather than silent.

D1 (ADR-036) — the 3 ``aria-kernel*`` test workflows carry NO governed ARIA
write authority (they write only the ephemeral ``./.aria-ci`` scratch tree,
clean the worktree post-run, and never upload a governed artifact). They are
modelled as ``AuditedWorkflowExclusion`` so they stay in the governed
inventory (owner + reason + discovery-presence enforced) WITHOUT fabricating a
``verify_workflow_preflight`` step or a governed upload-artifact step that
would misrepresent their write surface. The canonical ``13b94c505`` blob put
them under audited-exclusion with ``expires_at=2026-07-05`` — a dated
time-bomb that would silently expire and red the registry. D1's recorded
consequence is exactly "Rejects the canonical's expires_at=2026-07-05
time-bomb": we keep the audited-exclusion shape but pin ``expires_at`` to the
non-expiring ``date.max`` sentinel (``9999-12-31``) so there is no time-bomb.
See ADR-036 §Decision Points D1 and the convergence spec for the full
rationale (this is a deliberate, documented divergence from the spec's
"FULL contract" letter in favour of its stated D1 consequence — forcing
governed-write structure into pure test workflows is not an architectural
root-cause fix, it is a misrepresentation of their write authority).
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass
from datetime import date
from pathlib import Path


@dataclass(frozen=True)
class WorkflowAbortGate:
    """A step whose output must abort every later step in the job.

    GitHub Actions has no job-level abort: ``exit 0`` inside a ``run:`` block
    ends the STEP and the job continues to the next one. The ONLY mechanism
    that stops the remainder of a job is a per-step ``if:``, so a gate is real
    only when every later step carries it. ``aria-agent-executor`` shipped the
    announce-and-``exit 0`` shape with no guard on any downstream step, so a
    lease-blocked run claimed a request, invoked an agent against a tree
    another host was mutating, and discarded the result at the publish gate.

    ``guard_output`` is the step output the gate writes (e.g.
    ``steps.lease_check.outputs.blocked``); both the continue-expression and
    its inverse are DERIVED from it, so the two spellings cannot drift apart.
    """

    gate_step: str
    guard_output: str
    # ORPHAN-HIGH-497 — the ONE step permitted to carry the inverse guard.
    # The exemption used to be global, so any step could spell
    # ``blocked == 'true'`` and pass: a one-character edit (`!=` to `==`)
    # turned a real worker step into one that runs ONLY while another host
    # holds the lease, which is ORPHAN-CRITICAL-469 restored with the
    # contract gate still green.
    announce_step: str = ""

    @property
    def guard_expression(self) -> str:
        """Every step after the gate must carry this to run when unblocked."""
        return f"{self.guard_output} != 'true'"

    @property
    def skip_expression(self) -> str:
        """...or this, for a step that exists only to announce the block."""
        return f"{self.guard_output} == 'true'"


@dataclass(frozen=True)
class WorkflowJobContract:
    job_id: str
    preflight_step: str
    first_governed_mutation_step: str
    allowed_write_path_patterns: tuple[str, ...]
    preflight_artifact_path_pattern: str
    upload_artifact_name_pattern: str
    upload_artifact_path_patterns: tuple[str, ...]
    retention_days: int
    required_permissions: tuple[tuple[str, str], ...]
    token_source: str
    network_policy: tuple[str, ...]
    dlp_artifact: str
    clean_worktree_policy: str
    external_root_allowlist: tuple[str, ...] = ()
    # Minimum effective ``timeout-minutes`` for a job whose steps run
    # ``autonomy burn-in observe``. A burn-in is all-or-nothing (the kernel
    # pins 30 cycle attempts; a partial run yields ZERO ladder evidence), so a
    # timeout sized below the measured workload silently destroys the whole
    # run — run 28577469404 died this way under a flat 50-minute limit.
    # ``None`` means the job runs no burn-in step (and the verifier rejects a
    # burn-in step appearing in such a job — both directions are enforced).
    burn_in_timeout_floor_minutes: int | None = None
    # ORPHAN-HIGH-472 — the job's ordinary (non-burn-in) ``timeout-minutes``.
    # Pinned here so the kernel can derive its own wall-clock ceiling from the
    # same number the runner enforces, instead of carrying a second constant
    # that drifts. ``_verify_job_contract`` rejects a YAML/contract mismatch,
    # so the two cannot diverge silently.
    #
    # This exists because of WHO stops the run. Today an over-running cycle is
    # killed by GitHub: the job dies mid-step, the claimed request keeps its
    # lease until expiry, no governance row is written and the breaker never
    # sees it. ARIA has to stop itself first for the halt to be observable.
    job_timeout_minutes: int | None = None
    # ORPHAN-CRITICAL-469 regression surface. ``first_governed_mutation_step``
    # pins ONE step name and its position relative to the preflight, and
    # nothing else: mutation testing showed the whole suite stayed green when
    # the restore step was moved AFTER "Find next pending request" (the exact
    # bug — the queue is read before it is restored, so next_pending_request
    # always sees a bootstrap-empty tree) and when the publish and quarantine
    # steps were deleted outright. Only renaming or deleting the restore step
    # was caught, so 469 could be reintroduced verbatim with the suite green.
    #
    # These three fields close that as DECLARED contract, deliberately by step
    # NAME rather than by index: an index contract breaks on the first
    # unrelated step insertion, and a contract that breaks for unrelated
    # reasons gets edited until it stops complaining — which is how the thing
    # it was pinning ends up moved.
    #
    # ``required_steps`` — steps that must EXIST in the job.
    required_steps: tuple[str, ...] = ()
    # ``step_order`` — (earlier, later) pairs; both must exist and the first
    # must appear strictly before the second.
    step_order: tuple[tuple[str, str], ...] = ()
    # ``abort_gate`` — the lease/kill gate whose guard every later step must
    # carry (see WorkflowAbortGate). ``None`` = this job has no such gate.
    abort_gate: WorkflowAbortGate | None = None


@dataclass(frozen=True)
class WorkflowContract:
    workflow_id: str
    workflow_file: str
    job_contracts: tuple[WorkflowJobContract, ...]


@dataclass(frozen=True)
class AuditedWorkflowExclusion:
    workflow_id: str
    reason: str
    owner: str
    expires_at: str


# ``date.max`` (9999-12-31) is a valid ISO date that never satisfies the
# ``expires_at <= date.today()`` expiry check in ``_verify_audited_exclusions``.
# It is the "audited but non-expiring" sentinel (ADR-036 D1 — no time-bomb).
_NEVER_EXPIRES = date.max.isoformat()


# Regex fragments for the upload-artifact path / name patterns. These match the
# GitHub-expression interpolations EXACTLY as the live YAMLs emit them, after
# ``_normalize_workflow_path`` collapses ``${{ runner.temp }}`` -> ``runner-temp``.
_RUNNER_TEMP = r"runner-temp"
_RUN_ID_ATTEMPT = r"\$\{\{\s*github\.run_id\s*\}\}-\$\{\{\s*github\.run_attempt\s*\}\}"
_REQUEST_ID = r"\$\{\{\s*steps\.pending\.outputs\.request_id\s*\}\}"
_REPORT_DATE = r"[0-9]{4}-[0-9]{2}-[0-9]{2}"
_REPORT_DATE_EXPR = r"\$\{\{\s*steps\.target\.outputs\.date\s*\}\}"


# Step names quoted from the live YAMLs. Named constants because each one is
# referenced from several ordering pairs below, and a typo'd literal would
# silently weaken the contract into a no-op rather than fail loudly. Note the
# two lease steps differ by an em-dash vs hyphen — the verifier matches the
# YAML text exactly, so the difference is preserved rather than normalized.
_EXECUTOR_RESTORE_STEP = "Restore aria-tools state from previous run"
_EXECUTOR_LEASE_STEP = "Pre-flight — cross-host autonomous-loop lease check"
_EXECUTOR_PENDING_STEP = "Find next pending request"
_EXECUTOR_WORK_STEP = "Run CI executor"
# RC-6 — the operator's only route to the breaker ledger that actually lives in
# the aria-tools-state artifact. Declared here so deleting it is a contract
# failure rather than a quiet loss of the recovery lever, which is how
# ORPHAN-HIGH-465 (a recovery function with no command surface) happened once.
_EXECUTOR_BREAKER_QUARANTINE_STEP = "Quarantine damaged breaker evidence (recovery dispatch)"
_CYCLE_RESTORE_STEP = "Restore aria-tools state from previous run"
_CYCLE_LEASE_STEP = "Pre-flight - cross-host autonomous-loop lease check"
_CYCLE_WORK_STEP = "Run nightly standard-profile cycle"


# All contract VALUES below are re-derived from main's LIVE workflow YAMLs
# (ADR-036: structure is portable from 13b94c505, values are NOT — they target
# a divergent YAML generation). Job keys are the YAML-true keys
# (executor / generate-report / commit-report / generate / eval / sweep / proof).
WORKFLOW_CONTRACTS: dict[str, WorkflowContract] = {
    "aria-operational-proof": WorkflowContract(
        workflow_id="aria-operational-proof",
        workflow_file=".github/workflows/aria-operational-proof.yml",
        job_contracts=(
            WorkflowJobContract(
                job_id="proof",
                preflight_step="Persist enterprise workflow preflight",
                first_governed_mutation_step="Run observe burn-in proof",
                allowed_write_path_patterns=(
                    rf"^{_RUNNER_TEMP}/aria-operational-proof$",
                ),
                preflight_artifact_path_pattern=rf"^{_RUNNER_TEMP}/aria-operational-proof/workflow-preflight\.json$",
                upload_artifact_name_pattern=r"^aria-operational-proof-\$\{\{\s*github\.sha\s*\}\}$",
                upload_artifact_path_patterns=(rf"^{_RUNNER_TEMP}/aria-operational-proof$",),
                retention_days=365,
                required_permissions=(("contents", "read"),),
                token_source="github_actions_artifact_token",
                network_policy=("github_artifact",),
                dlp_artifact="workflow-preflight.json",
                clean_worktree_policy="pre_and_post",
                external_root_allowlist=("RUNNER_TEMP",),
                # MOCK-mode burn-in (dry-run cycles, minutes-scale); the live
                # YAML's 35-minute job timeout satisfies this floor.
                burn_in_timeout_floor_minutes=30,
            ),
        ),
    ),
    "aria-agent-executor": WorkflowContract(
        workflow_id="aria-agent-executor",
        workflow_file=".github/workflows/aria-agent-executor.yml",
        job_contracts=(
            WorkflowJobContract(
                job_id="executor",
                preflight_step="Persist enterprise workflow preflight",
                first_governed_mutation_step="Restore aria-tools state from previous run",
                # ORPHAN-CRITICAL-420 S1 — the executor restores and
                # republishes the whole aria-tools tree to bridge the
                # agent-invocation queue across the 01:00/02:00 lane
                # boundary, so its write root is the tree, as the producer
                # cycle's already is. The pre-S1 six-file list could not
                # survive the move: the preflight must run BEFORE the
                # restore (workflow_contracts rejects a preflight after the
                # first governed mutation), and before the restore there is
                # no request_id with which to name request-scoped paths.
                allowed_write_path_patterns=(
                    r"^aria-tools(/.*)?$",
                ),
                preflight_artifact_path_pattern=rf"^{_RUNNER_TEMP}/aria-agent-executor-preflight\.json$",
                upload_artifact_name_pattern=rf"^aria-response-{_REQUEST_ID}$",
                upload_artifact_path_patterns=(
                    rf"^aria-tools/agent-invocations/outputs/{_REQUEST_ID}\.json$",
                    rf"^aria-tools/agent-invocations/outputs/{_REQUEST_ID}\.transcript\.jsonl$",
                ),
                retention_days=7,
                # actions:read — locate + download the prior aria-tools-state
                # artifact (ORPHAN-CRITICAL-420 S1 queue bridge).
                required_permissions=(("contents", "read"), ("actions", "read")),
                token_source="github_actions_artifact_token",
                network_policy=("github_artifact",),
                dlp_artifact="aria-agent-executor-preflight.json",
                clean_worktree_policy="pre_and_post",
                external_root_allowlist=("RUNNER_TEMP",),
                job_timeout_minutes=45,
                required_steps=(
                    _EXECUTOR_RESTORE_STEP,
                    _EXECUTOR_LEASE_STEP,
                    _EXECUTOR_BREAKER_QUARANTINE_STEP,
                    _EXECUTOR_PENDING_STEP,
                    _EXECUTOR_WORK_STEP,
                    "Persist aria-tools state (verified)",
                    "Quarantine unverified aria-tools state",
                    "Fail when aria-tools state was not published",
                ),
                step_order=(
                    # ORPHAN-CRITICAL-469 itself: the restore must precede the
                    # lease preflight (lease_state reads the restored tree, so
                    # a bootstrap-empty one cannot observe a held lease) AND
                    # the queue read (next_pending_request on an unrestored
                    # tree always answers None — the stranded-queue bug).
                    (_EXECUTOR_RESTORE_STEP, _EXECUTOR_LEASE_STEP),
                    (_EXECUTOR_RESTORE_STEP, _EXECUTOR_PENDING_STEP),
                    # RC-6 — the repair mutates the RESTORED tree and must be
                    # inside the same transaction that republishes it. Both
                    # bounds are load-bearing: before the restore it would
                    # quarantine a bootstrap-empty ledger and report a clean
                    # no-op, and after the publish it would repair a tree
                    # nothing goes on to persist.
                    (_EXECUTOR_RESTORE_STEP, _EXECUTOR_BREAKER_QUARANTINE_STEP),
                    (_EXECUTOR_BREAKER_QUARANTINE_STEP, "Persist aria-tools state (verified)"),
                    # The return half of the bridge: publish, quarantine and
                    # the not-published failure are the run's terminal
                    # accounting and must follow the work, never precede it.
                    (_EXECUTOR_WORK_STEP, "Persist aria-tools state (verified)"),
                    (_EXECUTOR_WORK_STEP, "Quarantine unverified aria-tools state"),
                    (_EXECUTOR_WORK_STEP, "Fail when aria-tools state was not published"),
                ),
                abort_gate=WorkflowAbortGate(
                    gate_step=_EXECUTOR_LEASE_STEP,
                    guard_output="steps.lease_check.outputs.blocked",
                    announce_step="Skip autonomous loop when local lease is fresh",
                ),
            ),
        ),
    ),
    "aria-auto-cycle": WorkflowContract(
        workflow_id="aria-auto-cycle",
        workflow_file=".github/workflows/aria-auto-cycle.yml",
        job_contracts=(
            WorkflowJobContract(
                job_id="cycle",
                preflight_step="Persist enterprise workflow preflight",
                first_governed_mutation_step="Restore aria-tools state from previous run",
                # The producer cycle owns the whole aria-tools state tree
                # (cycles, autonomy_state, pressure, budget shards,
                # cost-attribution, governance, handoffs, locks, burn-in
                # evidence, agent-invocations) — the state carries across
                # nights via the aria-tools-state artifact round-trip —
                # plus the gitignored aria-findings/ seed surface the
                # nightly fresh-scan seeder re-derives from repo truth.
                allowed_write_path_patterns=(
                    r"^aria-tools(/.*)?$",
                    r"^aria-findings(/.*)?$",
                ),
                preflight_artifact_path_pattern=rf"^{_RUNNER_TEMP}/aria-auto-cycle-preflight\.json$",
                upload_artifact_name_pattern=r"^aria-tools-state$",
                upload_artifact_path_patterns=(r"^aria-tools$",),
                retention_days=30,
                required_permissions=(("contents", "read"), ("actions", "read")),
                token_source="github_actions_artifact_token",
                network_policy=("github_artifact",),
                dlp_artifact="aria-auto-cycle-preflight.json",
                clean_worktree_policy="pre_and_post",
                external_root_allowlist=("RUNNER_TEMP",),
                # Measured REAL burn-in wall time ≈ 80-90 min (30 cycles ×
                # ~2.5 min); the live YAML sets 150 for burn-in mode.
                burn_in_timeout_floor_minutes=120,
                # The ordinary branch of the mode-aware expression at
                # aria-auto-cycle.yml:81 (burn-in takes the 150 branch and is
                # governed by burn_in_timeout_floor_minutes above).
                job_timeout_minutes=50,
                # The producer is the shape aria-agent-executor mirrors, so it
                # carries the same declared constraints — a reference
                # implementation that is itself unpinned is a reference that
                # drifts, and the consumer would be corrected to match it.
                required_steps=(
                    _CYCLE_RESTORE_STEP,
                    _CYCLE_LEASE_STEP,
                    _CYCLE_WORK_STEP,
                    "Persist aria-tools state (verified)",
                    "Quarantine unverified aria-tools state",
                    "Fail on unverified aria-tools state",
                ),
                step_order=(
                    (_CYCLE_RESTORE_STEP, _CYCLE_LEASE_STEP),
                    (_CYCLE_WORK_STEP, "Persist aria-tools state (verified)"),
                    (_CYCLE_WORK_STEP, "Quarantine unverified aria-tools state"),
                    (_CYCLE_WORK_STEP, "Fail on unverified aria-tools state"),
                ),
                abort_gate=WorkflowAbortGate(
                    gate_step=_CYCLE_LEASE_STEP,
                    guard_output="steps.lease_check.outputs.blocked",
                    announce_step="Skip when local lease is fresh",
                ),
            ),
        ),
    ),
    "aria-agent-eval": WorkflowContract(
        workflow_id="aria-agent-eval",
        workflow_file=".github/workflows/aria-agent-eval.yml",
        job_contracts=(
            WorkflowJobContract(
                job_id="eval",
                preflight_step="Persist enterprise workflow preflight",
                first_governed_mutation_step="Run all eval fixtures (mock mode)",
                allowed_write_path_patterns=(
                    r"^aria-tools/agent-evals/runs\.jsonl$",
                    r"^aria-tools/governance\.jsonl$",
                ),
                preflight_artifact_path_pattern=rf"^{_RUNNER_TEMP}/aria-agent-eval-preflight\.json$",
                upload_artifact_name_pattern=rf"^aria-agent-eval-proof-{_RUN_ID_ATTEMPT}$",
                upload_artifact_path_patterns=(rf"^{_RUNNER_TEMP}/aria-agent-eval-preflight\.json$",),
                retention_days=7,
                required_permissions=(("contents", "read"),),
                token_source="none",
                network_policy=("none",),
                dlp_artifact="aria-agent-eval-preflight.json",
                clean_worktree_policy="pre_and_post",
                external_root_allowlist=("RUNNER_TEMP",),
            ),
        ),
    ),
    "aria-daily-report": WorkflowContract(
        workflow_id="aria-daily-report",
        workflow_file=".github/workflows/aria-daily-report.yml",
        job_contracts=(
            WorkflowJobContract(
                job_id="generate-report",
                preflight_step="Persist enterprise workflow preflight",
                first_governed_mutation_step="Generate daily chain-tip anchor (Plan ARIA-V2 §3.9)",
                allowed_write_path_patterns=(rf"^aria-tools/reports/daily/{_REPORT_DATE}\.md$",),
                preflight_artifact_path_pattern=rf"^{_RUNNER_TEMP}/aria-daily-report-generate-preflight\.json$",
                upload_artifact_name_pattern=rf"^aria-daily-report-{_REPORT_DATE_EXPR}$",
                upload_artifact_path_patterns=(
                    rf"^aria-tools/reports/daily/{_REPORT_DATE_EXPR}\.md$",
                ),
                retention_days=365,
                required_permissions=(("contents", "read"),),
                token_source="github_actions_artifact_token",
                network_policy=("github_artifact",),
                dlp_artifact="aria-daily-report-generate-preflight.json",
                clean_worktree_policy="pre_and_post",
                external_root_allowlist=("RUNNER_TEMP",),
            ),
            WorkflowJobContract(
                job_id="commit-report",
                preflight_step="Persist enterprise workflow preflight",
                first_governed_mutation_step="Open or update daily report PR",
                allowed_write_path_patterns=(rf"^aria-tools/reports/daily/{_REPORT_DATE}\.md$",),
                preflight_artifact_path_pattern=rf"^{_RUNNER_TEMP}/aria-daily-report-preflight\.json$",
                upload_artifact_name_pattern=rf"^aria-daily-report-commit-preflight-{_RUN_ID_ATTEMPT}$",
                upload_artifact_path_patterns=(rf"^{_RUNNER_TEMP}/aria-daily-report-preflight\.json$",),
                retention_days=365,
                required_permissions=(("contents", "write"),),
                token_source="github_app:installation",
                network_policy=("github_api",),
                dlp_artifact="aria-daily-report-preflight.json",
                clean_worktree_policy="pre_and_post",
                external_root_allowlist=("RUNNER_TEMP",),
            ),
        ),
    ),
    "finding-state-sweep": WorkflowContract(
        workflow_id="finding-state-sweep",
        workflow_file=".github/workflows/finding-state-sweep.yml",
        job_contracts=(
            WorkflowJobContract(
                job_id="sweep",
                preflight_step="Persist enterprise workflow preflight",
                first_governed_mutation_step="Apply sweep",
                allowed_write_path_patterns=(r"^docs/reviews/_registry/findings\.jsonl$",),
                preflight_artifact_path_pattern=rf"^{_RUNNER_TEMP}/finding-state-sweep-preflight\.json$",
                upload_artifact_name_pattern=rf"^finding-state-sweep-proof-{_RUN_ID_ATTEMPT}$",
                upload_artifact_path_patterns=(rf"^{_RUNNER_TEMP}/finding-state-sweep-preflight\.json$",),
                retention_days=365,
                required_permissions=(("contents", "write"), ("pull-requests", "write")),
                token_source="github_app:installation",
                network_policy=("github_api",),
                dlp_artifact="finding-state-sweep-preflight.json",
                clean_worktree_policy="pre_and_post",
                external_root_allowlist=("RUNNER_TEMP",),
            ),
        ),
    ),
    "rule-health-report": WorkflowContract(
        workflow_id="rule-health-report",
        workflow_file=".github/workflows/rule-health-report.yml",
        job_contracts=(
            WorkflowJobContract(
                job_id="generate",
                preflight_step="Persist enterprise workflow preflight",
                first_governed_mutation_step="Generate report",
                allowed_write_path_patterns=(
                    r"^docs/reviews/rule-health/[0-9]{4}-[0-9]{2}-[0-9]{2}-rule-health-[0-9]{4}-[0-9]{2}\.md$",
                ),
                preflight_artifact_path_pattern=rf"^{_RUNNER_TEMP}/rule-health-report-preflight\.json$",
                upload_artifact_name_pattern=rf"^rule-health-report-proof-{_RUN_ID_ATTEMPT}$",
                upload_artifact_path_patterns=(rf"^{_RUNNER_TEMP}/rule-health-report-preflight\.json$",),
                retention_days=365,
                required_permissions=(("contents", "write"), ("pull-requests", "write")),
                token_source="github_app:installation",
                network_policy=("github_api",),
                dlp_artifact="rule-health-report-preflight.json",
                clean_worktree_policy="pre_and_post",
                external_root_allowlist=("RUNNER_TEMP",),
            ),
        ),
    ),
}


# ADR-036 D1 — the 3 test-only kernel workflows carry no governed ARIA write
# authority; audited-excluded with a non-expiring sentinel (no time-bomb).
AUDITED_WORKFLOW_EXCLUSIONS: dict[str, AuditedWorkflowExclusion] = {
    "aria-kernel": AuditedWorkflowExclusion(
        workflow_id="aria-kernel",
        reason="test-only kernel validation workflow; writes only ephemeral ./.aria-ci, "
        "verifies a clean worktree post-run, and uploads no governed ARIA artifact",
        owner="aria-kernel",
        expires_at=_NEVER_EXPIRES,
    ),
    "aria-kernel-fast": AuditedWorkflowExclusion(
        workflow_id="aria-kernel-fast",
        reason="test-only fast kernel validation workflow; writes only ephemeral ./.aria-ci "
        "and uploads no governed ARIA artifact",
        owner="aria-kernel",
        expires_at=_NEVER_EXPIRES,
    ),
    "aria-kernel-full": AuditedWorkflowExclusion(
        workflow_id="aria-kernel-full",
        reason="test-only full kernel validation workflow; writes only ephemeral ./.aria-ci, "
        "verifies a clean worktree post-run, and uploads no governed ARIA artifact",
        owner="aria-kernel",
        expires_at=_NEVER_EXPIRES,
    ),
    "aria-merge-authority": AuditedWorkflowExclusion(
        workflow_id="aria-merge-authority",
        reason="required merge-gate check workflow; asserts ARIA merge authority via "
        "`npm run gates:required-status-checks` and uploads no governed ARIA artifact",
        owner="aria-kernel",
        expires_at=_NEVER_EXPIRES,
    ),
    "aria-runner-capability-probe": AuditedWorkflowExclusion(
        workflow_id="aria-runner-capability-probe",
        reason="RC-9 operator diagnostic; workflow_dispatch only, declares "
        "`permissions: contents: read`, mutates nothing on the runner or in the "
        "repository, and uploads no governed ARIA artifact — it prints host "
        "capabilities so the sandbox provisioning design is chosen from evidence "
        "instead of guesswork",
        owner="aria-kernel",
        expires_at=_NEVER_EXPIRES,
    ),
}


def workflow_contract_registry() -> dict[str, WorkflowContract]:
    return dict(WORKFLOW_CONTRACTS)


def workflow_job_contract(workflow_id: str, job_id: str) -> WorkflowJobContract | None:
    contract = WORKFLOW_CONTRACTS.get(workflow_id)
    if contract is None:
        return None
    for job in contract.job_contracts:
        if job.job_id == job_id:
            return job
    return None


def workflow_hash(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def workflow_contract_hash(contract: WorkflowContract) -> str:
    payload = json.dumps(asdict(contract), sort_keys=True, separators=(",", ":"))
    return "sha256:" + hashlib.sha256(payload.encode("utf-8")).hexdigest()


def workflow_job_contract_hash(workflow_id: str, job_id: str) -> str | None:
    contract = WORKFLOW_CONTRACTS.get(workflow_id)
    job = workflow_job_contract(workflow_id, job_id)
    if contract is None or job is None:
        return None
    payload = {
        "workflow_id": workflow_id,
        "workflow_file": contract.workflow_file,
        "job_contract": asdict(job),
    }
    return "sha256:" + hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


# Minutes reserved between ARIA's self-imposed ceiling and the runner's hard
# kill. The steps AFTER the agent runs still have to complete for the run to
# have happened at all — submit the result, publish the aria-tools tree,
# upload the artifact. A ceiling equal to the job timeout would stop ARIA at
# the exact moment it can no longer record that it stopped.
WALL_CLOCK_RESERVE_MINUTES = 5


def cycle_wall_clock_cap_seconds(workflow_id: str, *, job_id: str | None = None) -> int | None:
    """ARIA's own ceiling for a lane, derived from the pinned job timeout.

    Returns None when the lane declares no timeout, which callers must treat
    as "no self-imposed ceiling" rather than "unlimited" — the runner's own
    timeout still applies, it just kills instead of halting.
    """
    contract = WORKFLOW_CONTRACTS.get(workflow_id)
    if contract is None:
        return None
    for job in contract.job_contracts:
        if job_id is not None and job.job_id != job_id:
            continue
        if job.job_timeout_minutes is None:
            return None
        budget = job.job_timeout_minutes - WALL_CLOCK_RESERVE_MINUTES
        return max(0, budget) * 60
    return None


__all__ = [
    "AUDITED_WORKFLOW_EXCLUSIONS",
    "WALL_CLOCK_RESERVE_MINUTES",
    "WORKFLOW_CONTRACTS",
    "cycle_wall_clock_cap_seconds",
    "AuditedWorkflowExclusion",
    "WorkflowAbortGate",
    "WorkflowContract",
    "WorkflowJobContract",
    "workflow_contract_hash",
    "workflow_contract_registry",
    "workflow_hash",
    "workflow_job_contract",
    "workflow_job_contract_hash",
]
