"""ARIA CI executor (Plan 019 Phase 8.B).

Orchestrates one cycle of {next-pending → claim → invoke Claude Code CLI →
submit-result} per GHA run. Designed to be called from
`.github/workflows/aria-agent-executor.yml`; the kernel CLI does the
queue/lease/submit work, and this script handles the Claude Code CLI
invocation in the middle.

Lease-token redaction discipline (operator critique #9):
  - Lease token flows ONLY through ARIA_LEASE_TOKEN env var.
  - argv NEVER carries the raw token — the executor uses
    `--lease-token-from-env ARIA_LEASE_TOKEN` so the kernel reads from
    os.environ at submit time.
  - Artifact upload limited to expected_output_path only; claims.jsonl
    + runs.jsonl explicitly excluded.

Account-budget discipline:
  - MAX_TURNS_PER_RUN, MAX_REQUESTS_PER_RUN, MAX_TIMEOUT_SECONDS env
    vars enforce a budget cap before invoking the CLI; cap exceedance
    is logged and skipped rather than failing the run (budget signal,
    not build failure).
  - Claude account/session headroom is verified by the runtime preflight.
  - API key billing mode is disallowed by default.

Invocation contract: see tools/aria-poc/ci_executor_contract_proven.md
for the load-bearing contract — argv shape locked by Plan ARIA-V3
invariant I-V3-21. `CLAUDE_CLI_MOCK=1` wires the test fixture path;
`CLAUDE_CLI_MOCK=0` requires a live `claude` binary on $PATH and a
managed Claude Code login on a trusted/private runner.
"""
from __future__ import annotations

import json
import hashlib
import os
import re
import shutil
import subprocess
import sys
import time
import tempfile as _tempfile
import uuid as _uuid
import functools as _functools
from contextlib import ExitStack as _ExitStack
from dataclasses import dataclass as _dataclass, replace as _replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

_THIS_DIR = Path(__file__).resolve().parent
_CODE_ROOT = _THIS_DIR.parents[1]
_KERNEL_PYTHONPATH = os.pathsep.join((str(_CODE_ROOT), str(_CODE_ROOT / "aria-kernel")))
if str(_THIS_DIR) not in sys.path:
    sys.path.insert(0, str(_THIS_DIR))

# ARIA-HIGH-124 (round 2) — the ONE spelling of a kernel CLI subprocess
# (`kernel_cli`): this interpreter, `-P` (the cwd — the request worktree the
# agent just wrote to — OFF sys.path), `-m aria_kernel`. Every kernel
# command below is spelled through it; a literal spelling anywhere in the
# executors is refused by `tests/test_executor_kernel_cli_argv.py`.
from kernel_cli import KERNEL_CLI_INTERPRETER_FLAGS, kernel_cli_argv as _kernel_cli_argv

from claude_runtime import (
    spawn_settings_hash,
    CLAUDE_MOCK_ENV_VAR,
    ClaudeAuthFailure,
    ClaudeCreditExhausted,
    ClaudeAuthUnavailable,
    ClaudeCliUnavailable,
    ClaudePolicyViolation,
    ClaudeRunResult,
    ClaudeUsageUnavailable,
    UsageRecording,
    extract_final_message,
    extract_usage,
    is_mock_mode as _claude_is_mock_mode,
    parse_claude_jsonl,
    preflight_claude_auth,
    run_claude_exec,
    read_contained_profile,
    run_with_model_fallback,
)
from dispatch_failure import (
    DispatchFailure,
    DispatchRoute,
    classify_dispatch_failure,
    emit_dispatch_result_summary,
    resolve_dispatch_route,
)
from ci_executor_lease import HeldClaim

# The one stderr line that says the kernel could not be imported and the
# standalone fallbacks are live. A fixed prefix so a run log — and the test
# that pins it — can find the fact instead of inferring it from behaviour.
KERNEL_IMPORT_FALLBACK_MARKER = "::warning::aria_executor_kernel_import_fallback"

try:
    sys.path[:0] = [str(_CODE_ROOT), str(_CODE_ROOT / "aria-kernel")]
    from aria_kernel.agent_surface import DISPATCHABLE_ROLES as _DISPATCHABLE_ROLES
    from aria_kernel.agent_invocations import render_invocation_prompt as _render_invocation_prompt
    # The ONE projection of a claim response into a prompt envelope. The
    # executor used to build its own — `claim.get("forbidden_scope") or []`,
    # no repository_map — and that copy is where the prompt-hash binding
    # died AFTER the kernel-side fusion was fixed: same defect, one layer up.
    from aria_kernel.agent_invocations import fuse_prompt_envelope as _fuse_prompt_envelope
    # The lease guard asks the kernel whether a claim is still held at exit;
    # the kernel's own derivation, not a flag this file would have to keep.
    from aria_kernel.agent_invocations import derive_request_state as _derive_request_state
    # Plan ARIA WS1 — import the canonical plan_content required-field set
    # from the kernel SSoT (plan_convergence.PLAN_CONTENT_REQUIRED) instead
    # of re-declaring it here, so the fail-fast gate below can never drift
    # from the kernel-side _validate_plan_content gate it mirrors.
    from aria_kernel.plan_convergence import PLAN_CONTENT_REQUIRED as _PLAN_CONTENT_REQUIRED
    # FAZ 5b — the pre-claim environment gate writes governance rows through
    # the kernel and probes the sandbox through the runtime's own accessor.
    from aria_kernel.tool_registry import append_tools_governance as _append_tools_governance
    from aria_kernel.implementation_safety import sandbox_backend as _sandbox_backend
    from aria_kernel.implementation_safety import sandbox_unavailable_detail as _sandbox_unavailable_detail
    from aria_kernel.implementation_safety import egress_boundary_probe as _egress_boundary_probe
    # The rejection codes that mean "the kernel could not verify" — owned by
    # the validator that mints them; the release seam below classifies a
    # rejected submit against this set and nothing else.
    from aria_kernel.evidence_validator import (
        EVIDENCE_VERIFICATION_UNAVAILABLE_CODES as _EVIDENCE_VERIFICATION_UNAVAILABLE_CODES,
    )
    # The two kernel liveness bounds the submit child can legitimately wait
    # out: one state-transaction lock wait and one decision's evidence
    # probes. The executor's own wall clock for that child is DERIVED from
    # them below so it can never kill the child before the kernel's bound
    # has had its say (the 120 s-vs-600 s disagreement of 2026-09-12).
    from aria_kernel.ledger import STATE_LOCK_LIVENESS_SECONDS as _STATE_LOCK_LIVENESS_SECONDS
    from aria_kernel.evidence_probe import (
        EVIDENCE_VERIFICATION_LIVENESS_SECONDS as _EVIDENCE_VERIFICATION_LIVENESS_SECONDS,
    )
    # The pre-claim gate proves git answers in the workspace with the SAME
    # probe (bounds, retry) the kernel's evidence validator will use; its
    # worst case (every attempt at its bound, every backoff) is priced into
    # the child's worst case below.
    from aria_kernel.evidence_probe import GitProbeSession as _GitProbeSession
    from aria_kernel.evidence_probe import (
        GIT_PROBE_WORST_CASE_SECONDS as _GIT_PROBE_WORST_CASE_SECONDS,
    )
    # The bounds of the steps the JOB runs outside the drain window — the
    # state restore before it and the publish after it — so the reserve the
    # window must leave (`ci_executor_drain.JOB_RESERVE_SECONDS`) is derived
    # from the store's own numbers, not retyped beside them.
    from aria_kernel.state_store import GIT_TIMEOUT_SECONDS as _GIT_TIMEOUT_SECONDS
    from aria_kernel.state_store import (
        STATE_STORE_CHECKOUT_ARC_SECONDS as _STATE_STORE_CHECKOUT_ARC_SECONDS,
        STATE_STORE_LIFECYCLE_LIVENESS_SECONDS as _STATE_STORE_LIFECYCLE_LIVENESS_SECONDS,
    )
    # What the kernel's `human-required record` can legitimately wait
    # (its governance append, then the notification's channels and outbox
    # row): the executor runs it as a child on the refusal exits and sizes
    # that child's wall clock from this number, never from a guess.
    from aria_kernel.human_required import (
        HUMAN_REQUIRED_RECORD_WAIT_SECONDS as _HUMAN_REQUIRED_RECORD_WAIT_SECONDS,
    )
    # ARIA-HIGH-124 (round 3) — what the executor runs AFTER an
    # implementation spawn (the quarantine's publication, the contained
    # gate at up to the canonical ceiling per command, the push, the PR),
    # in the canonical shape: the term `child_worst_case_seconds` adds for
    # an implementation child, so the drain's window and the workflow pin
    # hold the whole child. A request's own bound is read off its staged
    # action (`staged_delivery_worst_case_seconds`) where the executor and
    # the drain know the request.
    from aria_kernel.implementation_delivery import (
        IMPLEMENTATION_DELIVERY_WORST_CASE_SECONDS as _IMPLEMENTATION_DELIVERY_WORST_CASE_SECONDS,
    )
except Exception as _kernel_import_error:  # pragma: no cover - fallback keeps standalone contract importable
    # Say so. This block used to fail silently, and a single missing kernel
    # name switched EVERY kernel-backed seam (renderer, fusion, governance,
    # sandbox probe, rejection classification) to its standalone fallback
    # with nothing in the run log to explain the changed behaviour.
    sys.stderr.write(
        f"{KERNEL_IMPORT_FALLBACK_MARKER} "
        f"{type(_kernel_import_error).__name__}: {_kernel_import_error} — "
        "standalone fallbacks active for every kernel-backed seam\n"
    )
    _DISPATCHABLE_ROLES = frozenset({
        "specialist_domain_review",
        "primary_authoring",
        "challenger_authoring",
        "evidence_judgment",
        "adversarial_judgment",
        "primary_plan",
        "challenger_plan",
        "cross_review",
        "completeness_critique",
        "implementation",
        "human_required_adjudication",
        # E14 — the three roles that gained a producer (goldset curation,
        # change intelligence, split-verdict arbitration). This standalone
        # fallback exists only when the kernel import fails; it drifting
        # narrower than the kernel set would make exactly those envelopes
        # unclaimable in the one mode where the drift is invisible.
        "consensus_arbitration",
        "change_intelligence",
        "goldset_curation",
        # E9-c — adversarial re-review of an already-closed decision. Added
        # here in the same commit as the kernel set, which is the contract
        # this mirror is held to: standalone mode is the ONE mode where a
        # narrower copy is invisible, so the no-drift test is what makes the
        # duplication legitimate rather than latent.
        "verification",
    })
    _render_invocation_prompt = None
    _fuse_prompt_envelope = None
    _derive_request_state = None
    _append_tools_governance = None
    _sandbox_backend = None
    _sandbox_unavailable_detail = None
    _egress_boundary_probe = None
    # Without the kernel nothing can be classified as the kernel's own gap:
    # every rejected submit stays the request's fault (fail toward the
    # human). An empty set cannot drift from the kernel's.
    _EVIDENCE_VERIFICATION_UNAVAILABLE_CODES = frozenset()
    # Standalone mirrors of the kernel bounds, so the submit wall clock and
    # the child worst case derived below are the same numbers with or
    # without the kernel; `tests/test_state_lock_liveness_bound.py` and
    # `tests/test_executor_kernel_import_fallback.py` pin them equal. The
    # lock bound is the pending-recovery transaction arc (three git steps
    # at the store's cap); the record wait is that bound, the notifier's
    # channels at their wall clock, and that bound again for the outbox.
    _STATE_LOCK_LIVENESS_SECONDS = 900.0
    _EVIDENCE_VERIFICATION_LIVENESS_SECONDS = 300.0
    _GIT_PROBE_WORST_CASE_SECONDS = 93.0
    _GIT_TIMEOUT_SECONDS = 300
    _STATE_STORE_CHECKOUT_ARC_SECONDS = 2700.0
    _STATE_STORE_LIFECYCLE_LIVENESS_SECONDS = 5400.0
    _HUMAN_REQUIRED_RECORD_WAIT_SECONDS = 2280.0
    # 4 canonical commands x 2700 s + 4 git calls x 300 s + 10 s commit
    # verification + 300 s result decision (the evidence probe clock) +
    # 40 s credential mint + revoke (round 6: minted after the gate) +
    # gh 300 s + 120 s work + 600 s publication + 40 s pre-spawn credential
    # admission (`implementation_delivery`).
    # `tests/test_executor_kernel_import_fallback.py` pins this equal to
    # the kernel's derivation: round 4 moved the kernel's sum (the commit
    # verification) without this mirror, and the kernel-less child was
    # priced 10 s short of the worst case it can legitimately run.
    _IMPLEMENTATION_DELIVERY_WORST_CASE_SECONDS = 13410
    _GitProbeSession = None
    # Standalone-mode fallback: identical value/order to the kernel SSoT.
    # Intentional duplication for kernel-less importability; WS2 adds a
    # drift guard asserting this equals plan_convergence.PLAN_CONTENT_REQUIRED.
    _PLAN_CONTENT_REQUIRED = (
        "schema_version", "title", "summary", "affected_surfaces",
        "key_changes", "validation_commands", "evidence_refs",
    )


DEFAULT_MAX_TURNS = 12
DEFAULT_MAX_REQUESTS = 30
DEFAULT_TIMEOUT_SECONDS = 1800
# The kernel's own work inside ONE state-writing child once its waits are
# done — `agent claim` and `agent release` load the claim ledger, CAS the
# row and append it; `agent submit-result` also reads and seals the
# envelope, runs the contract checks, appends the journal and the result
# and runs the bridges. Seconds on any host, the ledger loads dominating
# all three; this is the whole pre-2026-09 submit bound, kept as the one
# work allowance every kernel child is priced with.
KERNEL_CHILD_WORK_SECONDS = 120
# A kernel child that only writes state (`agent claim`, `agent release`)
# carries no executor-side wall clock: the kernel's own lock bound is what
# bounds it — one state-transaction wait behind a live holder
# (`ledger.STATE_LOCK_LIVENESS_SECONDS`, one deadline across the ordered
# locks) — and then its work. Priced here so the drain loop can charge the
# child for both of them instead of letting them spill into the job reserve.
STATE_WRITE_CHILD_WORST_CASE_SECONDS = int(
    _STATE_LOCK_LIVENESS_SECONDS + KERNEL_CHILD_WORK_SECONDS
)
# ORPHAN-HIGH-081 diagnostic + survivability bound. submit-result has
# been observed to hang past consumer-loop timeout 360 (submit hung
# without ever returning, no stderr, claim leaked). This bound localizes
# the hang via timestamped stage logs AND lets ci_executor release the
# claim itself on timeout rather than leaking via SIGKILL.
#
# DERIVED, not chosen: the child legitimately waits out two kernel liveness
# bounds — its evidence probes (one decision's clock,
# `evidence_probe.EVIDENCE_VERIFICATION_LIVENESS_SECONDS`) and then ONE
# state-transaction lock wait behind a healthy replay
# (`ledger.STATE_LOCK_LIVENESS_SECONDS`) — plus its own work. A wall clock
# below that sum kills a healthy child while the kernel is still inside
# its bound: that was 120 s against 600 s, released as
# `submit_timeout_120s` and re-dispatched the next night.
#
# The lane still fits: the drain loop starts a child only while the WHOLE
# child's worst case (`child_worst_case_seconds`, of which this wall clock
# is one term) fits the remaining ARIA_DRAIN_BUDGET_SECONDS window, so a
# submit that waits its full bound still ends inside the window. Pinned by
# `tests/test_state_lock_liveness_bound.py` against the workflow file.
SUBMIT_RESULT_TIMEOUT_SECONDS = int(
    _EVIDENCE_VERIFICATION_LIVENESS_SECONDS
    + _STATE_LOCK_LIVENESS_SECONDS
    + KERNEL_CHILD_WORK_SECONDS
)
# How long the HUMAN_REQUIRED record the refusal exits write instead of the
# submit (a model refusal, an agent refusal envelope, a branch collision, a
# delivery refusal) may legitimately take. It was a `human-required record`
# CHILD at 30 s against a kernel path that waits one state transaction for
# its governance row and then notifies — the same class as the submit's
# 120 s against 600 s: a healthy record killed by its own executor, the
# operator never told. Since ARIA-HIGH-124 round 3 the record is written IN
# THIS PROCESS through the kernel's own recorder (`_record_human_required`)
# — the operator CLI's free-text `--reason` validator, which the child
# passed the reason through, refused any reason carrying a kernel-minted
# id with ten consecutive digits (an `aria-impl-*` name, a sha) as a phone
# number, and the escalation was silently lost — so the bound is the
# kernel's own for that path (`human_required.HUMAN_REQUIRED_RECORD_WAIT_SECONDS`,
# enforced by the state lock's liveness bound and the notifier's wall
# clocks) plus the work allowance every kernel step is priced with.
HUMAN_REQUIRED_RECORD_WORST_CASE_SECONDS = int(
    _HUMAN_REQUIRED_RECORD_WAIT_SECONDS + KERNEL_CHILD_WORK_SECONDS
)
# The step that ends a run after the CLI is ONE of two: the submit child, or
# on a refusal exit the in-process human-required record. The worst case
# prices the slot at the longer of the two, so neither branch can run past
# what the drain loop checked — whichever bound grows.
TERMINAL_WRITER_TIMEOUT_SECONDS = max(
    SUBMIT_RESULT_TIMEOUT_SECONDS,
    HUMAN_REQUIRED_RECORD_WORST_CASE_SECONDS,
)


# Plan 032 Faz 032h — when the drain gives each request its own worktree,
# the child is bracketed by `git worktree add` before it and `git worktree
# remove` after it: whole-tree materialisations, each bounded by the store's
# git cap (`ci_executor_drain.REQUEST_WORKTREE_GIT_TIMEOUT_SECONDS`, read
# from `state_store.GIT_TIMEOUT_SECONDS`). They ran unbounded and unpriced
# until 2026-09-12; `child_worst_case_seconds` charges them to the child
# when the policy turns the worktrees on.
REQUEST_WORKTREE_WORST_CASE_SECONDS = 2 * _GIT_TIMEOUT_SECONDS


def child_worst_case_seconds(
    max_timeout_seconds: int,
    *,
    worktree_per_request: bool = False,
    implementation_delivery_seconds: int = 0,
) -> int:
    """How long ONE executor child may legally run, end to end.

    The ONE derivation every consumer of "how long can a child take" reads:
    the drain loop's start check (`ci_executor_drain.drain_pending`), the
    env-less drain window default (`DEFAULT_DRAIN_BUDGET_SECONDS`) and the
    job-reserve arithmetic test. Pricing the CLI cap alone (the first shape)
    let a submit that waited its full lock bound run past the window; pricing
    the CLI cap plus the submit wall clock (the second) still left the claim
    child, the release child and the pre-claim git probe unpriced — up to two
    state-lock waits and a three-attempt probe, spilling out of the window
    into the reserve the job keeps for restore and publish.

    In the order the child runs them:

    1. `agent claim` — one state-transaction wait plus its work
       (STATE_WRITE_CHILD_WORST_CASE_SECONDS); the pre-claim git gate runs
       first and is priced with it (GIT_PROBE_WORST_CASE_SECONDS: every
       attempt at its bound, every backoff).
    2. The Claude CLI — `max_timeout_seconds`, the lane's MAX_TIMEOUT_SECONDS.
    3. (implementation requests only, ARIA-HIGH-124 round 3) the
       delivery — ``implementation_delivery_seconds``: the quarantine's
       publication, the contained apply gate (every staged command at the
       staged ceiling — four canonical commands at 45 minutes each), the
       push and the `gh pr create` at their bounds, the delivery's work
       (`implementation_delivery.delivery_worst_case_seconds`, the one
       derivation). The drain and the executor price a request off its
       STAGED action (`staged_delivery_worst_case_seconds`: a plan's
       recipes make it larger); the workflow pin and the env-less default
       window hold the canonical shape
       (`IMPLEMENTATION_DELIVERY_WORST_CASE_SECONDS`). Until round 3 this
       whole phase was unpriced: a child admitted at the window's edge
       could legally run three hours past it, into and beyond the job's
       reserve.
    4. The terminal writer — TERMINAL_WRITER_TIMEOUT_SECONDS: `agent
       submit-result` at SUBMIT_RESULT_TIMEOUT_SECONDS (the evidence
       probes' clock, one state-transaction wait, its work), or on a
       refusal exit the in-process human-required record at
       HUMAN_REQUIRED_RECORD_WORST_CASE_SECONDS (its governance
       transaction, the notification's channels and outbox transaction,
       its work); the slot is priced at the longer of the two.
    5. `agent release` — the same shape as the claim; every exit of the
       child that does not seal a result releases, including a submit that
       timed out, so the release is charged after the terminal writer's
       full bound.

    With ``worktree_per_request`` the drain brackets all of that with the
    request's `git worktree add` and `git worktree remove`
    (REQUEST_WORKTREE_WORST_CASE_SECONDS); the workflow pin prices the lane
    with them on, so turning the policy on cannot outgrow the window.

    The same number is the lease the executor claims with
    (`agent claim --lease-seconds`): a lease shorter than the child it
    covers expires under a healthy run, and the submit refuses an expired
    lease by construction (`lease_expired`).
    """
    return int(
        STATE_WRITE_CHILD_WORST_CASE_SECONDS
        + _GIT_PROBE_WORST_CASE_SECONDS
        + max_timeout_seconds
        + implementation_delivery_seconds
        + TERMINAL_WRITER_TIMEOUT_SECONDS
        + STATE_WRITE_CHILD_WORST_CASE_SECONDS
        + (REQUEST_WORKTREE_WORST_CASE_SECONDS if worktree_per_request else 0)
    )


def batch_worst_case_seconds(
    request_count: int, max_timeout_seconds: int, *, worktree_per_request: bool = False,
) -> int:
    """How long ONE executor child serving K read-only requests may legally run.

    Typed-judgment plan Phase 4a (ARIA-MEDIUM-163). The batch child claims
    K requests, makes ONE model call, then seals, submits and releases each
    request on its own: the per-request terms of `child_worst_case_seconds`
    — the claim's state write, the terminal writer, the release's state
    write — are charged K times; the pre-claim git probe, the model call
    and the worktree bracket once. At K = 1 this is `child_worst_case_seconds`
    with no delivery term, by construction. The same number is every claim's
    lease: K claims precede the call (the fused claim response is what the
    prompt is rendered from), so the first claim's lease must outlive the
    last request's release. Batches carry no implementation delivery term:
    the read-only routes cannot host an implementation.
    """
    if request_count < 1:
        raise ValueError(f"batch_worst_case_seconds_request_count:{request_count}")
    per_request = STATE_WRITE_CHILD_WORST_CASE_SECONDS + TERMINAL_WRITER_TIMEOUT_SECONDS + STATE_WRITE_CHILD_WORST_CASE_SECONDS
    return int(
        _GIT_PROBE_WORST_CASE_SECONDS
        + max_timeout_seconds
        + request_count * per_request
        + (REQUEST_WORKTREE_WORST_CASE_SECONDS if worktree_per_request else 0)
    )


# ARIA-HIGH-124 (round 3) — the canonical implementation term, for the
# consumers that price a child before they know its request: the env-less
# drain window (`ci_executor_drain.DEFAULT_DRAIN_BUDGET_SECONDS`) and the
# workflow pin. A known request is priced off its staged action instead
# (`_request_delivery_seconds`).
IMPLEMENTATION_DELIVERY_WORST_CASE_SECONDS = int(_IMPLEMENTATION_DELIVERY_WORST_CASE_SECONDS)

# Plan ARIA-V8.1 Phase 3 — fail-fast canonical plan_content / cross_review
# validation BEFORE submit subprocess. Mirrors the kernel-side gate at
# plan_convergence._validate_plan_content + _validate_cross_review_record.
# Without this gate, the agent's structurally invalid envelope reaches
# submit_claim_result, gets ACCEPTED, then plan_convergence_bridge emits
# `agent_bridge_warning: plan content must be a JSON object` and the
# state machine stays in DRAFT — wasting the Opus cycle ($0.35/cycle)
# and producing zero convergence signal. Fail-fast here releases the
# claim with a precise reason so operators see WHICH field was wrong.
#
# The required-field list (_PLAN_CONTENT_REQUIRED) is imported from the
# kernel SSoT (plan_convergence.PLAN_CONTENT_REQUIRED) in the try/except
# above, with an identical standalone fallback — see Plan ARIA WS1.
#
# Plan ARIA-V8.5 R1 — V8 cross_review canonical fields list. Only the
# agent's SUBSTANTIVE output is required: verdict + risks. Envelope
# metadata (`round_number`, `target_revision_id`, `task_packet_hash`,
# etc.) is synthesized by kernel `submit_cross_review_v8` from plan
# state — the agent does not need to know it. Pre-V8.5 the validator
# listed `round_number` as required and rejected envelopes where Opus
# correctly produced verdict + risks but didn't echo back envelope
# metadata it never authored.
_CROSS_REVIEW_REQUIRED = ("verdict", "risks")

LEASE_TOKEN_ENV_VAR = "ARIA_LEASE_TOKEN"


# Diagnostic — timestamped stage trace for ORPHAN-HIGH-081 root-cause hunt.
# Lives on stderr so the consumer-loop log file captures it without
# interfering with the kernel submit-result stdout JSON contract.
_CI_T0 = time.monotonic()


# Plan 032 Faz 032b — the code tree the executor dispatches into.
# Plan 032 Faz 032d — a write lane whose scoped credential cannot be minted
# is released, never run blind. EX_CONFIG keeps the code distinct from the
# Claude CLI's own exits in `claude_cli_exit_<n>` release reasons.
DELIVERY_CREDENTIAL_EXIT = 78
# Plan 032 Faz 032c — the checkpoint taken before a write-capable spawn. A
# constant (not a `reason="..."` literal) so I-V12-RELEASE-02's scan of release
# sites does not read a checkpoint reason as a claim release.
_PRE_SPAWN_CHECKPOINT_REASON = "pre_spawn"
# Plan 032 Faz 032h — a drain child may run inside its own worktree; the
# drain exports ARIA_WORKSPACE_ROOT and every workspace-bound path follows.
_REPO_ROOT = Path(os.environ.get("ARIA_WORKSPACE_ROOT") or Path(__file__).resolve().parents[2]).resolve()
# ARIA-HIGH-142 — where that root came from. Without the env the executor
# publishes into the tree its own file lives in, which is the kernel's
# checkout and not necessarily the request's; a live run must say so in
# its log (``REPO_ROOT_FROM_MODULE_MARKER``, emitted by ``_main``) rather
# than let the two trees be confused a second time.
_REPO_ROOT_SOURCE = "env" if os.environ.get("ARIA_WORKSPACE_ROOT") else "module_location"
REPO_ROOT_FROM_MODULE_MARKER = "::warning::aria_executor_repo_root_from_module_location"


def _kernel_checkout_root() -> Path:
    """The checkout the RUNNING kernel is part of — where its agent contracts
    and runtime profiles (`.claude/agents/*.md`) are read from (ARIA-HIGH-146).

    The contract used to be rendered from the workspace (`_REPO_ROOT`): the
    tree the implementer changes, at the request's `target_sha`. A workspace
    at an older commit ran the contract of that commit while this executor
    validated the response against its own; trial eleven's implementer got
    the 2026-09-12 contract, whose first obligation the sandbox's command
    policy cannot execute (ARIA-HIGH-147), twice. The contract belongs to
    the kernel that grades it — the same root ARIA-HIGH-142 serves the
    in-sandbox clients from.
    """
    from aria_kernel.claude_settings import kernel_code_root

    return kernel_code_root().parent


def repo_root_provenance_note() -> str | None:
    """The one line a run writes when its repo root was not handed to it,
    or None when ARIA_WORKSPACE_ROOT named the request's tree."""
    if _REPO_ROOT_SOURCE == "env":
        return None
    return (
        f"{REPO_ROOT_FROM_MODULE_MARKER} ARIA_WORKSPACE_ROOT is unset; the executor's repo root "
        f"is this module's own checkout ({_REPO_ROOT}) — set it when the request's tree is another"
    )


def _operator_policy_root(tools_dir: Path) -> Path:
    """The root the operator policy (aria-config/genesis_policy.json) is read from.

    WHY not the workspace: the workspace is the TASK tree — with
    worktree_per_request (B8) it is a worktree at the request's target_sha,
    and the policy as of that commit is not the operator's policy. A request
    minted before an operator decision landed would otherwise be governed by
    the policy from before the decision (pre-B8: no adaptive block, the
    metered gate, refused by price), so the decision would reach only
    requests minted after it. The kernel already answers "which root's
    policy" for the cost gate (ARIA-HIGH-079): the workspace the tools store
    is BOUND to — the persistent checkout the drain runs from, the fixture
    repo a test binds its store to. The executor reads the same root, so the
    admission, the spawn gate and the cost gate read ONE policy.
    """
    from aria_kernel.tool_registry import bound_workspace_root

    return bound_workspace_root(tools_dir)


def _stage(msg: str) -> None:
    elapsed = time.monotonic() - _CI_T0
    sys.stderr.write(f"[ci-stage t={elapsed:7.2f}s] {msg}\n")
    sys.stderr.flush()


def _write_dispatch_summary(
    *, route: DispatchRoute, request_id: str, outcome: str,
    failure: DispatchFailure | None, exit_code: int | None,
) -> None:
    """One sanitized ``aria/dispatch-result/v1`` summary for a terminal path.

    The summary is telemetry: a dispatch outcome must never fail because the
    telemetry channel did, so an unwritable summary is named on stderr and
    the outcome stands. Every terminal path — inside ``invoke_claude_cli``
    and every by-design exit of ``_main`` before it — writes through here.
    """
    try:
        emit_dispatch_result_summary(
            route=route, request_id=request_id, outcome=outcome,
            failure=failure, exit_code=exit_code,
        )
    except (OSError, ValueError) as summary_exc:
        sys.stderr.write(f"dispatch_summary_unwritable: {summary_exc}\n")


# A refusal is a legitimate terminal, not a build failure: the request keeps
# its budget, the run stays green, and the SUMMARY — never the exit code —
# says it was not a success.
REFUSAL_EXIT_CODE = 0


def _dispatch_route_for(request: dict[str, Any], *, target_agent: str) -> DispatchRoute:
    """ARIA-HIGH-002 — the route this child dispatches (or would dispatch) on.

    The trusted request envelope names the agent/role; the frontmatter SSoT
    in the CODE root resolves the model and the fleet resolves the provider.
    The code root, not the workspace: the drain resolves the same route from
    the same checkout before it claims, and the two must key one circuit.
    ``target_agent`` is the dispatched argv agent, the fallback when the
    envelope (a mocked one) names none.
    """
    return resolve_dispatch_route(
        request={"role": request.get("role"),
                 "target_agent": str(request.get("target_agent") or target_agent)},
        repo_root=_CODE_ROOT,
    )


def _refuse_dispatch(
    *, request: dict[str, Any], request_id: str, target_agent: str, reason: str,
    failure_class: str = "policy_violation", retryable: bool = False,
) -> int:
    """A by-design non-dispatch, NAMED in the child's summary (B8, 2026-09-12).

    WHY: the child exited 0 with no summary on every refusal decided before
    ``invoke_claude_cli`` — the native admission's task-binding refusal, the
    fleet's ``no_eligible_provider``, the budget signal, the operator cancel,
    the recovery escalation — and the drain read "exit 0, no summary" as a
    drained success. Under ``managed_subscription`` the task binding refuses
    whenever main has moved past a request's ``target_sha``, so a night of
    orphaned requests read as a green drain (verifier B8 MUST FIX 1). The
    drain now names a summary-less child as ``child_without_summary`` and
    counts nothing but a ``succeeded`` summary as drained; this is the other
    half: every by-design exit says what it was.

    WHAT: outcome ``refused``, ``failure_class``/``retryable`` as the
    refusal's own kind — ``policy_violation`` / not retryable by default
    (the dispatch met one of the executor's own admission policies), and
    what the fleet's refusal table declares for a halted admission
    (``harness_unavailable`` / retryable: the host, not the request, and
    the daemon retries it after a back-off) — and ``reason`` as the detail
    code, the closed vocabulary the drain and the operator read. Returns
    the exit code a refusal carries.
    """
    _write_dispatch_summary(
        route=_dispatch_route_for(request, target_agent=target_agent),
        request_id=request_id, outcome="refused",
        failure=DispatchFailure(
            failure_class=failure_class, retryable=retryable, detail_code=reason,
            phase="preflight", exit_code=REFUSAL_EXIT_CODE,
        ),
        exit_code=REFUSAL_EXIT_CODE,
    )
    return REFUSAL_EXIT_CODE


def _fail_submit_dispatch(
    *, request: dict[str, Any], request_id: str, target_agent: str, failure_class: str, retryable: bool,
    detail_code: str,
) -> int:
    """A submit that did not land the result, NAMED in the child's summary
    (ARIA-HIGH-124 round 5).

    WHY: `invoke_claude_cli` writes `outcome: succeeded` the moment the CLI
    exits 0, and the four submit exits below (`return 1`: the kernel's
    rejected result row, a rejection before any row, an undecided
    verification, a submit that hung past its wall clock) left that summary
    standing — the drain counts nothing but a `succeeded` summary as
    drained, so a rejected implementation result was a drained success in
    the night's count while its claim ledger read `rejected`. The refusal
    exits already supersede the CLI's summary (`_refuse_dispatch`); this is
    the failure half.

    WHAT: outcome `failed`, phase `submit`, the failure's own class from
    the closed vocabulary (`response_schema_rejected` for a rejection the
    kernel recorded or refused before a row — the request's; `harness_unavailable`
    for a verification the kernel could not decide; `timeout` for a hung
    submit — the host's, retryable), and the detail code the release reason
    carries. Returns the exit code a failed submit carries.
    """
    _write_dispatch_summary(
        route=_dispatch_route_for(request, target_agent=target_agent),
        request_id=request_id, outcome="failed",
        failure=DispatchFailure(
            failure_class=failure_class, retryable=retryable, detail_code=detail_code,
            phase="submit", exit_code=1,
        ),
        exit_code=1,
    )
    return 1


def _staged_implementation_ids(*, tools_dir: Path, request_id: str) -> dict[str, Any]:
    """ARIA-HIGH-124 — the staged ids of an implementation request
    (`{proposal_id, change_id, branch, base_sha}`), read from the REQUEST
    ROW on the ledger: the claim's fused projection carries only what the
    sealed prompt renders, and these are the kernel's facts for the branch
    it stands the sandbox on and the delivery it runs — never the prompt's
    to restate. Empty when the row carries none (the branch step then
    refuses by name)."""
    from aria_kernel.agent_invocations import _find_request_by_id
    from aria_kernel.tool_registry import ensure_tools_dir

    row = _find_request_by_id(ensure_tools_dir(tools_dir), request_id) or {}
    ids = row.get("implementation_ids")
    return dict(ids) if isinstance(ids, dict) else {}


class HumanRequiredRecordUnavailable(RuntimeError):
    """The kernel's HUMAN_REQUIRED recorder did not land the record: the
    escalation the release rests on does not exist, and the release site
    must say so (`_release_unescalated`), never release as if it did."""


def _record_human_required(
    *, tools_dir: Path, request_id: str, severity: str, reason: str, context: dict[str, Any],
) -> dict[str, Any]:
    """Persist the HUMAN_REQUIRED record IN THIS PROCESS through the kernel's
    own recorder (`human_required.record_human_required`), the way every
    kernel producer of an escalation does; the state machine then marks the
    request terminal from the release that follows.

    ARIA-HIGH-124 (round 3) — this was a `human-required record` CHILD,
    whose `--reason` went through the operator CLI's free-text validator
    (`cli._validate_reason`): a PII heuristic whose phone-number shape
    matches ANY ten consecutive digits. Every kernel-minted id embeds hex,
    and 8% of `aria-impl-*` names (11% of shas) carry such a run, so one
    escalation in ten — a branch collision, an invalid request row, a
    delivery refusal naming its branch — was refused at argparse, the
    record never written, the release then `requeued` instead of
    `human_required`, and the drain re-claimed the request into the same
    refusal until the requeue threshold caught it: the two-wasted-claims
    loop the round-2 contract claims to close. The executor holds the store
    as its own fact; the machine ids go in ``context`` (the record's
    structured field, read by the adjudication classifier under the
    unadmitted kind ``EXECUTOR_ESCALATION_KIND``, which keeps the record
    with the operator), and ``reason`` is the code and its sentence — no
    free-text validator sees either. A recorder that does not answer
    raises :class:`HumanRequiredRecordUnavailable` (an ImportError of the
    kernel, a refused governance write, a dying disk) with the whole cause,
    never a truncated stderr line.
    """
    try:
        from aria_kernel.human_required import EXECUTOR_ESCALATION_KIND, record_human_required
        from aria_kernel.tool_registry import GovernanceError
    except ImportError as exc:
        raise HumanRequiredRecordUnavailable(f"kernel_unimportable:{type(exc).__name__}: {exc}") from exc
    try:
        return record_human_required(
            request_id=request_id, severity=severity, reason=reason,
            context={"kind": EXECUTOR_ESCALATION_KIND, "request_id": request_id, **context},
            base_dir=tools_dir,
        )
    except (GovernanceError, OSError, ValueError) as exc:
        raise HumanRequiredRecordUnavailable(f"{type(exc).__name__}: {exc}") from exc


def _release_unescalated(
    *, tools_dir: Path, repo: Path, request: dict[str, Any], request_id: str, target_agent: str,
    claim_id: str, agent_id: str, lease_token: str, escalation_reason: str, phase: str,
    error: HumanRequiredRecordUnavailable,
) -> int:
    """The release site's ERROR for an escalation whose record did not land.

    The claim is still released — a leaked lease is the worse outcome —
    but under a reason that names the recorder's failure
    (`human_required_record_unavailable:<escalation reason>`, harness-class:
    the STORE's recorder failed, not the request, so the budget stands and
    the retry escalates again once the recorder answers), with the cause on
    governance and on stderr as a job error, and the child's summary a
    FAILED harness dispatch (exit 1) — never a `refused` by-design exit that
    reads as if the escalation happened.
    """
    from aria_kernel.tool_registry import append_tools_governance

    cause = str(error)
    sys.stderr.write(
        f"::error::aria executor could not record HUMAN_REQUIRED for request {request_id} "
        f"({escalation_reason}): {cause}. The claim is released harness-class under "
        f"human_required_record_unavailable and the request stays queued.\n"
    )
    try:
        append_tools_governance(tools_dir, "human_required_record_unavailable", {
            "request_id": request_id, "claim_id": claim_id, "escalation_reason": escalation_reason,
            "error": cause[:1000],
        })
    except Exception as governance_exc:  # the store's governance may be what failed
        sys.stderr.write(f"human_required_record_unavailable governance row not written: {governance_exc}\n")
    _release_claim(
        tools_dir=tools_dir, repo=repo, claim_id=claim_id,
        agent_id=agent_id, lease_token=lease_token,
        reason=f"human_required_record_unavailable:{escalation_reason}",
    )
    _write_dispatch_summary(
        route=_dispatch_route_for(request, target_agent=target_agent),
        request_id=request_id, outcome="failed",
        failure=DispatchFailure(
            failure_class="harness_unavailable", retryable=True,
            detail_code="human_required_record_unavailable", phase=phase, exit_code=1,
        ),
        exit_code=1,
    )
    return 1


def _publish_artifact_paths(envelope_path: Path, transcript_path: Path) -> None:
    """Tell the workflow WHERE the envelope actually landed.

    The upload step used to rebuild the path from the request id
    (`outputs/<request_id>.json`), while the request envelope names it
    `outputs/<group>/<round>-<role>-<request_id>.md` — two spellings of one
    path that never agreed, so `if-no-files-found: error` failed every run
    that claimed a request, AFTER the agent work had already succeeded. The
    producer knows the path; it says so here instead of letting YAML guess.

    Paths are emitted relative to the workspace because that is what
    actions/upload-artifact resolves against; an absolute path outside the
    workspace would silently upload nothing.
    """
    output_file = os.environ.get("GITHUB_OUTPUT")
    if not output_file:
        return
    workspace = Path(os.environ.get("GITHUB_WORKSPACE", ".")).resolve()

    def _relative(path: Path) -> str:
        resolved = path.resolve()
        try:
            return resolved.relative_to(workspace).as_posix()
        except ValueError:
            return resolved.as_posix()

    with open(output_file, "a", encoding="utf-8") as handle:
        handle.write(f"envelope_path={_relative(envelope_path)}\n")
        handle.write(f"transcript_path={_relative(transcript_path)}\n")


def _write_sanitized_envelope(path: Path, envelope: dict[str, Any]) -> None:
    """Write executor output through the central artifact-safety boundary."""
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "aria-kernel"))
    from aria_kernel.artifact_safety import write_sanitized_json
    write_sanitized_json(path, envelope)


def _safe_agent_text_excerpt(text: str, *, limit: int = 4000) -> str:
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "aria-kernel"))
        from aria_kernel.artifact_safety import scrub_text
        text = scrub_text(text)
    except Exception:
        pass
    return text[:limit] + ("..." if len(text) > limit else "")


def _canonicalize_plan_content(envelope: dict[str, Any]) -> bool:
    """Plan ARIA-V8.4 — auto-fill missing canonical plan_content fields.

    Opus is observed to non-deterministically drop one or two canonical
    fields (e.g. emits all 6 of {schema_version, title, summary,
    affected_surfaces, key_changes, validation_commands} but omits
    `evidence_refs` from plan_content even though the same array
    exists at the envelope top level). The agent's substantive output
    is intact; only the bookkeeping field is missing.

    This Tier-1 normalizer auto-fills missing canonical fields from
    compatible sources WITHIN the envelope itself so the cycle does
    not bounce on agent non-determinism. Auto-fill is conservative:
    only fills from values the agent already produced, never
    fabricates evidence.

    Returns True if the envelope was mutated (changes need to be
    written back to disk before submit), False if unchanged.
    """
    plan_content = envelope.get("plan_content")
    if not isinstance(plan_content, dict):
        return False
    mutated = False

    # evidence_refs: copy from envelope top-level if missing inside
    # plan_content. The two SHOULD be the same per agent contract; if
    # the agent only populated the top-level one, mirror it.
    if "evidence_refs" not in plan_content:
        top_refs = envelope.get("evidence_refs")
        if isinstance(top_refs, list):
            plan_content["evidence_refs"] = list(top_refs)
            mutated = True

    # schema_version: default 1 (only value the kernel accepts today)
    if "schema_version" not in plan_content:
        plan_content["schema_version"] = 1
        mutated = True

    # affected_surfaces: if it's a flat list of strings (paths), wrap
    # in the canonical `[{paths: [...]}]` envelope. Some agent outputs
    # use the simpler shape.
    surfaces = plan_content.get("affected_surfaces")
    if isinstance(surfaces, list) and surfaces and all(isinstance(s, str) for s in surfaces):
        plan_content["affected_surfaces"] = [{"paths": list(surfaces)}]
        mutated = True

    # validation_commands: each entry MUST be a dict per kernel
    # _validate_validation_command. Bare strings get auto-wrapped.
    cmds = plan_content.get("validation_commands")
    if isinstance(cmds, list):
        wrapped: list[dict[str, Any]] = []
        cmd_mutated = False
        for c in cmds:
            if isinstance(c, dict):
                wrapped.append(c)
            elif isinstance(c, str) and c.strip():
                wrapped.append({"cmd": c, "expected_exit": 0, "timeout_ms": 60000})
                cmd_mutated = True
            else:
                wrapped.append(c)  # keep as-is; validator will catch
        if cmd_mutated:
            plan_content["validation_commands"] = wrapped
            mutated = True

    if mutated:
        envelope["plan_content"] = plan_content
    return mutated


def _canonicalize_satisfaction_matrix(
    envelope: dict[str, Any],
    must_satisfy: list[dict[str, Any]] | None = None,
) -> bool:
    """Plan ARIA-V8.8 + V8.15 — auto-fill missing satisfaction_matrix
    verdicts AND missing `id` fields from request's must_satisfy.

    Kernel response-schema validator rejects entries that are missing
    `id` or `verdict`. Agent non-determinism: Opus sometimes provides
    only the substantive verdict text and omits the id, OR provides
    the id but leaves verdict null. Both modes are recoverable.

    V8.15 extension: when an entry has no `id`, attempt three
    fallback strategies in order:
      1. Position-match against the request's must_satisfy[] (the
         agent's matrix entries are usually in must_satisfy order)
      2. Single must_satisfy entry — copy its id unconditionally
      3. Auto-synthesize `id=auto-sm-NNN` so the entry remains
         operator-visible without fabricating a real must_satisfy
         linkage

    Returns True when the envelope was mutated.
    """
    matrix = envelope.get("satisfaction_matrix")
    if not isinstance(matrix, list):
        return False
    ms_ids = []
    if isinstance(must_satisfy, list):
        for ms in must_satisfy:
            if isinstance(ms, dict) and ms.get("id"):
                ms_ids.append(ms["id"])
    mutated = False
    for idx, entry in enumerate(matrix):
        if not isinstance(entry, dict):
            continue
        # V8.15 — id auto-fill from position match
        if not entry.get("id"):
            if idx < len(ms_ids):
                entry["id"] = ms_ids[idx]
            elif len(ms_ids) == 1:
                entry["id"] = ms_ids[0]
            else:
                entry["id"] = f"auto-sm-{idx:03d}"
            mutated = True
        verdict = entry.get("verdict")
        if verdict in (None, "", "null"):
            # ARIA-AUDIT-024: the executor is a TRANSPORT, not a judge.
            # A missing verdict is unverified — auto-filling "satisfied"
            # made the producer the author of its own acceptance.
            entry["verdict"] = "unverified"
            mutated = True
    return mutated


def _canonicalize_cross_review(
    envelope: dict[str, Any],
    request_envelope: dict[str, Any] | None = None,
) -> bool:
    """Plan ARIA-V8.7 — auto-fill missing canonical cross_review fields.

    Mirrors `_canonicalize_plan_content` for the cross_review role:
    the agent's substantive output (verdict + maybe nested
    reviews/risks/notes) is preserved, while bookkeeping fields the
    agent dropped get filled from compatible sources within the
    envelope itself. Never fabricates evidence.

    Auto-fills handled:

    - `cross_review.reviewer_agent` ← envelope.agent_id when missing
    - `cross_review.risks` ← [] when missing (matches kernel
      _validate_cross_review_record which accepts empty list when
      verdict=agreed)
    - `cross_review.risks` ← gathered from `cross_review.reviews[*]
      .risks` lists when the top-level field is missing but the
      nested form is present (Opus non-determinism)

    Returns True when the envelope was mutated.
    """
    details = envelope.get("details")
    if not isinstance(details, dict):
        return False
    cross_review = details.get("cross_review")
    if not isinstance(cross_review, dict):
        return False
    mutated = False

    # Plan ARIA-V8.19 — reviewer_agent fallback uses the request's
    # target_agent (kernel-trustworthy "aria-cross-reviewer"), NOT
    # the envelope's outer agent_id (which is "ci-executor:gha-local"
    # — the executor identity, not a declared reviewer in
    # `.claude/agents/`). Pre-V8.19 the normalizer auto-filled with
    # the executor identity, the bridge's V8.17 fallback never fired
    # because reviewer_agent was already truthy, and the kernel's
    # `_validate_cross_review_record` rejected with `unknown reviewer:
    # ci-executor:gha-local`. The kernel's `reviewer_names()` scans
    # `.claude/agents/*.md` for valid reviewer identities.
    if not cross_review.get("reviewer_agent"):
        if isinstance(request_envelope, dict):
            target_agent = request_envelope.get("target_agent")
            if isinstance(target_agent, str) and target_agent.strip():
                cross_review["reviewer_agent"] = target_agent.strip()
                mutated = True
        if not cross_review.get("reviewer_agent"):
            cross_review["reviewer_agent"] = "aria-cross-reviewer"
            mutated = True

    # risks: if missing OR None, default to empty list (kernel accepts
    # empty risks when verdict=agreed). If nested under
    # `reviews[*].risks`, gather them up into the top-level list so
    # downstream record_cross_review sees ONE canonical list.
    risks = cross_review.get("risks")
    if not isinstance(risks, list):
        gathered: list[Any] = []
        reviews = cross_review.get("reviews")
        if isinstance(reviews, list):
            for r in reviews:
                if isinstance(r, dict) and isinstance(r.get("risks"), list):
                    gathered.extend(r["risks"])
        cross_review["risks"] = gathered
        mutated = True

    # Plan ARIA-V8.9 — wrap string-format risks into canonical dicts.
    # Kernel `_validate_cross_review_risk` requires every risk to be
    # a dict with risk_id, risk_category, severity, summary,
    # recommendation, affected_files, evidence_refs. Opus often emits
    # risks as descriptive strings instead. We wrap each string into
    # a canonical dict that:
    #   - preserves the agent's text as `summary`
    #   - tags `risk_category="agent_uncategorized"` and
    #     `severity="LOW"` so operator can identify auto-wrapped
    #     entries vs explicitly-scored ones
    #   - leaves affected_files + evidence_refs as [] (NEVER
    #     fabricates ref content)
    risks_list = cross_review.get("risks")
    if isinstance(risks_list, list):
        wrapped_risks: list[dict[str, Any]] = []
        any_wrapped = False
        for idx, raw in enumerate(risks_list):
            if isinstance(raw, dict):
                wrapped_risks.append(raw)
            elif isinstance(raw, str) and raw.strip():
                wrapped_risks.append({
                    "risk_id": f"cr-auto-{idx:03d}",
                    "risk_category": "agent_uncategorized",
                    "severity": "LOW",
                    "summary": raw.strip(),
                    "recommendation": "Operator review the agent's string-format risk.",
                    "affected_files": [],
                    "evidence_refs": [],
                })
                any_wrapped = True
            else:
                wrapped_risks.append(raw)
        if any_wrapped:
            cross_review["risks"] = wrapped_risks
            mutated = True

    if mutated:
        details["cross_review"] = cross_review
        envelope["details"] = details
    return mutated


def _pre_submit_validate_envelope(
    envelope: dict[str, Any], role: str, request: dict[str, Any] | None = None,
    tools_dir: str | Path | None = None,
) -> list[str]:
    """Plan ARIA-V8.1 Phase 3 — fail-fast canonical schema gate.

    Validates the agent's response envelope against the same canonical
    fields the kernel-side `plan_convergence._validate_plan_content` and
    `_validate_cross_review_record` check. Returns a list of missing or
    malformed field names (empty list = valid).

    Why fail-fast here vs at kernel: kernel acceptance + bridge warning
    leaves the plan in DRAFT and the cycle abandons with no convergence
    signal. Detecting the drift in ci_executor lets us release the claim
    with a precise reason so operators see WHICH field was wrong rather
    than a generic "plan content must be a JSON object" warning.
    """
    errors: list[str] = []
    from aria_kernel.agent_surface import JUDGE_ROLES as _judge_roles
    if role in _judge_roles:
        # ARIA-MEDIUM-166 — the arbiter is gated with the two judges: an
        # arbitration envelope the bridge cannot fold was sealed, accepted
        # and retried in the bridge until permanent_fail.
        # Y5 (ORPHAN-706) — the judge output contract, enforced BEFORE the
        # result is sealed. The second sealed night accepted 12 judge
        # results with no readable verdict block; each became an accepted
        # row the bridge could never fold ("expected verdict ..., got
        # None"), burning bridge retries toward permanent_fail. The check
        # is the KERNEL's own (`judgment_bridge.validate_judge_response`)
        # so the executor and the bridge can never disagree about what a
        # valid judge response is.
        #
        # Restart follow-through: the first healed drain refused two
        # PERFECTLY-IDENTIFIED judge envelopes with
        # missing_tool_run_or_finding_id — the caller's ``request`` here is
        # the TRIMMED claim payload, which never carried the judgment
        # identity fields; the full ledger row does (the submit-time bridge
        # reads that row, which is why folding worked while this gate
        # refused). Read the SAME row the bridge reads, so gate and bridge
        # judge one truth.
        from aria_kernel.judgment_bridge import validate_judge_response

        gate_request = dict(request or {})
        if not (gate_request.get("tool_id") and gate_request.get("run_id") and gate_request.get("finding_id")):
            request_id = str(gate_request.get("request_id") or envelope.get("request_id") or "")
            tools_dir_raw = os.environ.get("ARIA_TOOLS_DIR")
            if request_id and tools_dir_raw:
                try:
                    from aria_kernel.agent_invocations import _find_request_by_id
                    from aria_kernel.tool_registry import ensure_tools_dir as _etd

                    full_row = _find_request_by_id(_etd(tools_dir_raw), request_id)
                except Exception:
                    full_row = None
                if full_row:
                    for key in ("tool_id", "run_id", "finding_id", "judgment_group_id"):
                        if not gate_request.get(key) and full_row.get(key):
                            gate_request[key] = full_row[key]
        return validate_judge_response(
            request=gate_request,
            response={**envelope, "role": role},
        )
    # B6 — a self-change request shares `maintenance_utility` with the queue
    # projection, so the gate keys on the CONTRACT the request declared
    # (self_change_bridge.is_self_change_request), never on the role. Same
    # doctrine as the judge branch: the check is the KERNEL's own validator,
    # so the gate and the accepted-result bridge cannot disagree about what a
    # well-formed answer is. Shape only — the authority boundary is judged
    # by `propose_self_change` in the kernel, where a refusal is a ledger row.
    from aria_kernel.self_change_bridge import is_self_change_request, validate_self_change_response

    if is_self_change_request(request or {}):
        return validate_self_change_response(
            request=request or {},
            response={**envelope, "role": role},
        )
    if role in ("primary_plan", "challenger_plan"):
        plan_content = envelope.get("plan_content")
        if not isinstance(plan_content, dict):
            return ["plan_content:absent_or_not_object"]
        missing = [f for f in _PLAN_CONTENT_REQUIRED if f not in plan_content]
        for f in missing:
            errors.append(f"plan_content.{f}:missing")
        # Lightweight value checks (kernel re-validates strictly)
        if "title" in plan_content and not (
            isinstance(plan_content["title"], str) and plan_content["title"].strip()
        ):
            errors.append("plan_content.title:empty_or_not_string")
        if "summary" in plan_content and not (
            isinstance(plan_content["summary"], str) and plan_content["summary"].strip()
        ):
            errors.append("plan_content.summary:empty_or_not_string")
        if "key_changes" in plan_content and not (
            isinstance(plan_content["key_changes"], list) and plan_content["key_changes"]
        ):
            errors.append("plan_content.key_changes:empty_or_not_list")
        if "affected_surfaces" in plan_content and not isinstance(
            plan_content["affected_surfaces"], list
        ):
            errors.append("plan_content.affected_surfaces:not_list")
        if "validation_commands" in plan_content and not isinstance(
            plan_content["validation_commands"], list
        ):
            errors.append("plan_content.validation_commands:not_list")
        if "evidence_refs" in plan_content and not isinstance(
            plan_content["evidence_refs"], list
        ):
            errors.append("plan_content.evidence_refs:not_list")
        # The plan contract (architectural_tier + admissible validation
        # commands), read through the KERNEL's own check so this gate, the
        # submit refusal and the CONVERGED gate judge one truth. Released
        # here as `plan_content_invalid:plan_architectural_tier_missing`
        # (request fault, retried under the Y1 budget) instead of accepted
        # and then bridged into a dead envelope.
        if not errors:
            from aria_kernel.plan_contract import plan_contract_violations

            # The contract is judged against THIS store's recipe catalog, so
            # the store must be named; this function's contract is to return
            # error strings, so an unnamed store is one of them rather than a
            # GovernanceError escaping from the catalog read.
            store = tools_dir or os.environ.get("ARIA_TOOLS_DIR") or None
            if store is None:
                errors.append("plan_contract_store_unnamed")
            else:
                errors.extend(plan_contract_violations(plan_content, base_dir=store))
    elif role == "cross_review":
        # Plan ARIA-V8.1 — accept cross_review at top-level OR inside
        # details.cross_review OR details.review. The aria-cross-reviewer
        # agent prompt documents `details.cross_review` as canonical; the
        # bridge looks in the same fallback chain (`details.review ||
        # details.cross_review || details`). Match the bridge's
        # extraction order so we reject only what the bridge would
        # reject — false positives waste the cycle without cause.
        details = envelope.get("details") if isinstance(envelope.get("details"), dict) else {}
        cross_review = (
            envelope.get("cross_review")
            or (details.get("cross_review") if isinstance(details, dict) else None)
            or (details.get("review") if isinstance(details, dict) else None)
        )
        if not isinstance(cross_review, dict):
            return ["cross_review:absent_or_not_object"]
        missing = [f for f in _CROSS_REVIEW_REQUIRED if f not in cross_review]
        for f in missing:
            errors.append(f"cross_review.{f}:missing")
    return errors


MOCK_MODE_ENV_VAR = CLAUDE_MOCK_ENV_VAR

# Plan 026R §B.5 — single-claim contract (mirror of
# planner_dispatch_hook.CLAIM_METADATA_FILE_ENV_VAR). When the planner sets
# it, ci_executor SKIPS its own ``agent claim`` step and uses the fused
# envelope + ledger-hash anchors from the FILE this variable names. A file,
# not the value: an environment string is bounded like an argument
# (MAX_ARG_STRLEN), and a round-3 cross-review envelope carrying both plans
# was refused by execve before the executor started (ARIA-HIGH-085). The raw
# lease_token continues to transit ONLY via ARIA_LEASE_TOKEN — the metadata
# payload schema rejects it on both serialise + deserialise.
CLAIM_METADATA_FILE_ENV_VAR = "ARIA_CLAIM_METADATA_FILE"

# Forbidden keys in the claim metadata — mirrors
# planner_dispatch_hook.CLAIM_METADATA_FORBIDDEN_KEYS. Source of truth
# for "what MUST NOT be serialised into the metadata env-var" lives at
# both boundaries so a tamper at one boundary is caught at the other.
CLAIM_METADATA_FORBIDDEN_KEYS = frozenset({"lease_token", "lease_token_hash"})

# Plan 025 §B → 026R §B.3 — the envelope-list subprocess fetch is GONE.
# §B.3 made ``agent claim`` return the full request envelope inside the
# same exclusive-lock window that performed the claim CAS, so the
# executor no longer needs a second subprocess hop to load the envelope.
# The legacy ``REQUEST_ENVELOPE_LIST_ARGV`` constant was the pre-§B.3
# Tier-3 invariant pin; it is preserved here ONLY as the migration
# audit trail and is referenced by the §B.3 AST regression test that
# asserts no callsite in this module still spawns the legacy argv. New
# code MUST read envelope fields from ``claim`` directly.
REQUEST_ENVELOPE_LIST_ARGV: tuple[str, ...] = (
    "agent-invocations",
    "list",
    "--request-id",
)


class CostCapExceeded(Exception):
    """The request would exceed the configured cost cap; skip + log."""


# Plan ARIA-V7 §2g v2 Phase 7.3 — closed enum of dispatchable roles.
# Mirrors aria_kernel/dispatcher_factory.SUPPORTED_ROLES. Adding a
# role requires updating BOTH the consumer (this file) AND the
# kernel factory module. Closed enum prevents typo'd roles from
# silently flowing into the queue.
SUPPORTED_ROLES: frozenset[str] = frozenset(_DISPATCHABLE_ROLES)



def claim_and_dispatch_one(
    *,
    role: str,
    tools_dir: Path,
    repo_root: Path,
) -> dict[str, Any]:
    """Plan ARIA-V7 §2g v2 Phase 7.3 — single-role claim + dispatch.

    Workflow:
      1. Validate role is in SUPPORTED_ROLES.
      2. Check Claude Code CLI auth/session preflight. Unavailable → return
         ``{"status": "dispatchers_unavailable"}``.
      3. Find next pending request of the given role via
         ``aria-kernel agent-invocations list --role <role>
         --pending-only``.
      4. If no pending → return ``{"status": "no_pending"}``.
      5. Spawn this script as subprocess with ``request_id`` to
         exercise the existing claim → invoke → release flow.
      6. Capture subprocess result + return.

    Returns a dict with keys: ``status``, ``request_id``,
    ``role``, ``stdout_tail``, ``stderr_tail``, ``exit_code``.

    Used by the operator-runnable consumer loop:
      python tools/aria-poc/ci_executor.py --consume specialist_domain_review
    """
    if role not in SUPPORTED_ROLES:
        raise ValueError(
            f"claim_and_dispatch_one_unknown_role: {role!r} "
            f"(must be one of {sorted(SUPPORTED_ROLES)})"
        )

    try:
        preflight_claude_auth()
    except (ClaudeAuthUnavailable, ClaudeCliUnavailable, ClaudePolicyViolation) as exc:
        return {
            "status": "dispatchers_unavailable",
            "role": role,
            "reason": f"claude_preflight_failed: {exc}",
        }

    # Find next pending request for this role.
    list_proc = subprocess.run(
        _kernel_cli_argv(
            "agent-invocations", "list",
            "--role", role,
            "--pending-only",
            "--limit", "1",
            "--tools-dir", str(tools_dir),
        ),
        capture_output=True,
        text=True,
        env={**os.environ, "PYTHONPATH": _KERNEL_PYTHONPATH},
    )
    if list_proc.returncode != 0:
        return {
            "status": "list_failed",
            "role": role,
            "stderr_tail": list_proc.stderr[-1000:],
            "exit_code": list_proc.returncode,
        }

    try:
        pending = json.loads(list_proc.stdout)
    except json.JSONDecodeError:
        return {
            "status": "list_output_not_json",
            "role": role,
            "stdout_tail": list_proc.stdout[-500:],
        }

    if not pending:
        return {"status": "no_pending", "role": role}

    request = pending[0] if isinstance(pending, list) else pending
    request_id = request.get("request_id") or request.get("id")
    if not request_id:
        return {
            "status": "request_missing_id",
            "role": role,
            "raw": request,
        }

    target_agent = request.get("target_agent", "")
    dispatch_proc = subprocess.run(
        ["python3", str(Path(__file__).resolve()), request_id, target_agent],
        capture_output=True,
        text=True,
        env={**os.environ, "PYTHONPATH": _KERNEL_PYTHONPATH},
        cwd=str(repo_root),
    )
    return {
        "status": "dispatched" if dispatch_proc.returncode == 0 else "dispatch_failed",
        "request_id": request_id,
        "role": role,
        "target_agent": target_agent,
        "exit_code": dispatch_proc.returncode,
        "stdout_tail": dispatch_proc.stdout[-2000:],
        "stderr_tail": dispatch_proc.stderr[-2000:],
    }


def _redact_lease_in_message(message: str, lease_token: str | None) -> str:
    """Defensive: never let the raw token slip into a log message."""
    if not lease_token:
        return message
    return message.replace(lease_token, "<lease-token-redacted>")


def _max_turns() -> int:
    return int(os.environ.get("MAX_TURNS_PER_RUN", DEFAULT_MAX_TURNS))


def _max_requests() -> int:
    return int(os.environ.get("MAX_REQUESTS_PER_RUN", DEFAULT_MAX_REQUESTS))


def _max_timeout_seconds() -> int:
    return int(os.environ.get("MAX_TIMEOUT_SECONDS", DEFAULT_TIMEOUT_SECONDS))


def _child_worst_case_seconds(*, worktree_per_request: bool = False, implementation_delivery_seconds: int = 0) -> int:
    """`child_worst_case_seconds` at this run's MAX_TIMEOUT_SECONDS — the
    number the drain loop checks before starting a child, and the lease the
    executor claims with. ``implementation_delivery_seconds`` is the
    request's delivery term (`_request_delivery_seconds`), 0 for every
    other role."""
    return child_worst_case_seconds(
        _max_timeout_seconds(), worktree_per_request=worktree_per_request,
        implementation_delivery_seconds=implementation_delivery_seconds,
    )


def _batch_worst_case_seconds(request_count: int, *, worktree_per_request: bool = False) -> int:
    """`batch_worst_case_seconds` at this run's MAX_TIMEOUT_SECONDS."""
    return batch_worst_case_seconds(
        request_count, _max_timeout_seconds(), worktree_per_request=worktree_per_request,
    )


def _request_delivery_seconds(*, tools_dir: Path, request_id: str) -> int:
    """ARIA-HIGH-124 (round 3) — the post-spawn delivery term of ONE request:
    0 for every role but `implementation`; for an implementation request the
    bound priced off its STAGED action's suite and ceiling
    (`implementation_delivery.staged_delivery_worst_case_seconds`), read
    from the request ROW on the ledger — the drain reads it before it
    starts the child, the executor before it claims (the lease) and before
    it spawns (the window). A row that carries no `implementation_ids` is
    priced at the canonical shape; the branch step then refuses it by
    name."""
    from aria_kernel.agent_invocations import _find_request_by_id
    from aria_kernel.implementation_delivery import staged_delivery_worst_case_seconds
    from aria_kernel.tool_registry import ensure_tools_dir

    row = _find_request_by_id(ensure_tools_dir(tools_dir), request_id) or {}
    if row.get("role") != "implementation":
        return 0
    ids = row.get("implementation_ids")
    proposal_id = str(ids.get("proposal_id") or "") if isinstance(ids, dict) else ""
    return staged_delivery_worst_case_seconds(proposal_id=proposal_id, base_dir=tools_dir)

# ORPHAN-HIGH-472 — `_max_budget_usd` and `_max_budget_usd_per_cycle` lived
# here and are gone. Their own docstring already conceded the point ("Default
# Claude Code execution uses managed-session auth and does not use this value
# for billing control"), and after the dispatch gate moved to wall clock they
# had no readers at all. A tunable that gates nothing is worse than no
# tunable: an operator who lowers it believes they have tightened something.


_TRUTHY_BOOL_VALUES: frozenset[str] = frozenset({"1", "true", "yes", "on"})
_FALSY_BOOL_VALUES: frozenset[str] = frozenset({"0", "false", "no", "off", ""})


def _parse_bool_env(name: str, default: str = "0") -> bool:
    """Plan 026R §B.2 — case-insensitive multi-token bool env var parser.

    Pre-§B.2 ``_is_mock_mode`` did ``os.environ.get(...) == "1"`` only,
    so a workflow that exported ``CLAUDE_CLI_MOCK=true`` (the common
    shell convention) silently fell to mock=OFF → ``ClaudeCliUnavailable``
    raise → CI exit code 1. The bug is REAL in today's CI.

    Accepts the canonical truthy/falsy set:

    * Truthy: ``1``, ``true``, ``yes``, ``on`` (any case).
    * Falsy:  ``0``, ``false``, ``no``, ``off``, empty string.

    Any other value raises ``ValueError`` (no silent fallback to either
    side — typo in a workflow should fail loud).
    """
    raw = os.environ.get(name, default).strip().lower()
    if raw in _TRUTHY_BOOL_VALUES:
        return True
    if raw in _FALSY_BOOL_VALUES:
        return False
    raise ValueError(
        f"{name}={raw!r} is not a recognised boolean "
        f"(truthy={sorted(_TRUTHY_BOOL_VALUES)}, "
        f"falsy={sorted(_FALSY_BOOL_VALUES)})"
    )


def _is_mock_mode() -> bool:
    return _claude_is_mock_mode()


# Plan ARIA-V3.1-D2 — frozen mock-mode sentinel. main() sets this at
# entry exactly once; cost-attribution callers gate on this value
# rather than re-reading the live env, so a mid-run env mutation
# (e.g. a subprocess that exports CLAUDE_CLI_MOCK=1) cannot flip the
# mock decision between mint + record sites. Closes ai-safety
# HIGH-007 (mock-mode race window).
#
# Pre-main() default is None — code paths that read this BEFORE
# main() captured the sentinel are operator-error (the frozen
# sentinel exists for the cycle's lifetime, not at module load).
_MOCK_MODE_AT_ENTRY: bool | None = None


def _validate_dispatch_budget(
    *,
    request: dict[str, Any],
    tools_dir: str | Path,
    timeout_seconds: int,
) -> None:
    """Refuse a dispatch that cannot finish inside the cycle's wall clock.

    ORPHAN-HIGH-472 — this used to gate on estimated DOLLARS against
    MAX_BUDGET_USD_PER_CYCLE, and that number never described anything real.
    ARIA runs its agents through the Claude Code CLI on a logged-in
    subscription session (``claude_runtime`` is explicit that raw
    ANTHROPIC_API_KEY billing is disallowed, and both workflows reject those
    env vars), so there is no marginal per-run charge to cap. The USD figures
    price tokens at API list rates: useful as telemetry, meaningless as a
    gate. Four values disagreed by 40x — cost_budget's $0.50 per_run, the
    workflow's $20.00 per-run AND $3.00 per-cycle in the same invocation, and
    a ~$1.15 measured run — because none of them was measuring spend.

    What is actually scarce is time: the shared subscription quota and CI
    minutes. So the ceiling is wall-clock, derived from the lane's own pinned
    job timeout, and the refusal happens BEFORE a run that could not have
    finished is started.

    The turn-count heuristic is kept as a second, independent pre-flight —
    it bounds envelope shape rather than elapsed time.
    """
    _assert_cycle_wall_clock(
        request=request, tools_dir=tools_dir, timeout_seconds=timeout_seconds
    )
    expected_evidence_count = len(request.get("evidence_refs") or [])
    if expected_evidence_count > _max_turns() * 4:  # rough heuristic: 4 refs per turn
        raise CostCapExceeded(
            f"request.evidence_refs count {expected_evidence_count} exceeds "
            f"MAX_TURNS_PER_RUN={_max_turns()} * 4 cap"
        )


def _wall_clock_cap_seconds() -> int | None:
    """This lane's self-imposed ceiling, from the pinned workflow contract.

    Derived rather than configured so it cannot drift from the timeout the
    runner actually enforces — ``_verify_job_timeout_minutes`` fails the
    contract test if the YAML and the registry disagree.
    """
    from aria_kernel.workflow_contract_registry import cycle_wall_clock_cap_seconds

    workflow_id = _current_workflow_id()
    if workflow_id is None:
        return None
    return cycle_wall_clock_cap_seconds(workflow_id)


def _current_workflow_id() -> str | None:
    """Registry key for the workflow this process is running under.

    GITHUB_WORKFLOW_REF looks like
    ``owner/repo/.github/workflows/aria-agent-executor.yml@refs/heads/main``;
    the registry keys on the file stem.
    """
    ref = os.environ.get("GITHUB_WORKFLOW_REF", "")
    if not ref:
        return None
    path = ref.split("@", 1)[0]
    stem = path.rsplit("/", 1)[-1]
    for suffix in (".yml", ".yaml"):
        if stem.endswith(suffix):
            return stem[: -len(suffix)]
    return stem or None


def _record_run_wall_clock(
    *,
    request: dict[str, Any],
    tools_dir: str | Path,
    request_id: str,
    seconds: float,
) -> None:
    """Book this run's elapsed time against its cycle.

    Deliberately swallows its own failures: the ledger append is accounting,
    and a bookkeeping error must not convert a completed agent run into a
    failed one. The cost of missing a row is a cycle that over-runs its
    ceiling once; the cost of raising here would be losing real work.
    """
    from aria_kernel.budget import record_run_wall_clock

    cycle_id = request.get("cycle_id")
    if not cycle_id:
        return
    try:
        record_run_wall_clock(
            cycle_id=str(cycle_id),
            seconds=seconds,
            base_dir=tools_dir,
            request_id=request_id,
        )
    except Exception as exc:  # noqa: BLE001 — see docstring
        sys.stderr.write(f"wall_clock_record_failed: {exc}\n")


def _job_elapsed_seconds() -> float | None:
    """Seconds since this workflow RUN started, from GitHub's own timestamp.

    ORPHAN-CRITICAL-495 — the first version of this gate accounted against
    ``request["cycle_id"]``, and 15 of 17 mint paths never set it, so the
    ceiling was inert on essentially every dispatch: exactly the
    written-tested-and-never-reached defect this branch exists to close, in
    the commit that claimed to close it.

    Elapsed-since-job-start is also the better question for this lane. The
    executor handles ONE request per job, so there is no cycle total to
    accumulate; what actually matters is whether a 30-minute run still fits
    in what remains of a 35-minute job after restore, preflight and lease
    checks have taken their share. ``GITHUB_RUN_STARTED_AT`` needs nothing
    threaded through the envelope to answer that.
    """
    started = os.environ.get("GITHUB_RUN_STARTED_AT", "").strip()
    if not started:
        return None
    try:
        parsed = datetime.fromisoformat(started.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return max(0.0, (datetime.now(timezone.utc) - parsed).total_seconds())


def _assert_cycle_wall_clock(
    *,
    request: dict[str, Any],
    tools_dir: str | Path,
    timeout_seconds: int,
) -> None:
    from aria_kernel.budget import WallClockExhausted

    cap_seconds = _wall_clock_cap_seconds()
    elapsed = _job_elapsed_seconds()
    if cap_seconds is None or elapsed is None:
        # Not in a recognised lane, or GitHub gave us no run timestamp. The
        # per-run timeout still bounds this run; there is simply no job
        # ceiling to measure it against.
        return
    remaining = cap_seconds - elapsed
    if remaining < timeout_seconds:
        raise WallClockExhausted(
            f"job_wall_clock_exhausted: remaining={remaining:.0f}s "
            f"< per_run_timeout={timeout_seconds}s "
            f"(cap={cap_seconds}s elapsed={elapsed:.0f}s)"
        )
    # The run's actual duration is booked after it finishes, in the `finally`
    # arm around invoke_claude_cli. Nothing is recorded here: a zero-second
    # row at gate time would be noise in a ledger whose whole purpose is to
    # answer how long things took.


# ORPHAN-HIGH-472 — `_estimate_envelope_cost_usd` lived here. It priced an
# envelope before the call so a USD reservation could be checked against a
# cap. With the dispatch gate moved to wall clock it had no callers left, and
# its output was never spend in the first place: under a subscription session
# the number it produced was an API-list-price estimate of a call that is not
# billed per token. Deleted rather than left as an unused helper, because the
# next reader would reasonably assume something enforces it.


def _try_reconcile_envelope_cost(*, envelope_id: str, actual_cost_usd: float, tools_dir: Path) -> None:
    """Plan ARIA-V8 §4 Phase 8.0 (B-V2-11) — best-effort cost reconciliation.

    WHY: ci_executor runs as a subprocess; the parent orchestrator owns
    the reservation_token (kept in env ARIA_BUDGET_RESERVATION_TOKEN).
    On absent token (legacy ops paths), reconciliation is skipped silently
    — the per-cycle reservation discipline is opt-in; daily/monthly caps
    in `budget.record_budget_usage` still apply.
    HOW: import aria_kernel.budget at call time, look up token in env,
    reconcile if present.
    """
    token = os.environ.get("ARIA_BUDGET_RESERVATION_TOKEN", "")
    if not token:
        return
    try:
        from aria_kernel.budget import reconcile_envelope_cost  # noqa: WPS433
        reconcile_envelope_cost(
            reservation_token=token,
            envelope_id=envelope_id,
            actual_cost_usd=actual_cost_usd,
            base_dir=tools_dir,
        )
    except Exception:
        pass  # Reconciliation is observability, not a hard fail


def _clear_stale_dispatch_artifacts(output_path: Path, transcript_path: Path) -> None:
    """Remove a prior attempt's output + transcript before a (re)dispatch.

    ORPHAN-332 — a requeued request (poll timeout on the slower opus tier;
    since 2026-09-12 also a provider-quota requeue) MUST start from a clean slate.
    The dispatched agent has Read tools and is told the expected output path; if
    a prior attempt's envelope is still on disk it invokes the repo's "look
    before you write / don't overwrite existing work" discipline and REFUSES to
    regenerate — emitting a meta-response ("the expected output file already
    exists on disk") whose top-level cross_review/plan_content is absent. That
    trips plan_content_invalid:...:absent_or_not_object → requeue → same refusal
    → human_required, stalling a cycle whose FIRST attempt produced a valid
    plan. Clearing the stale artifacts makes every (re)dispatch idempotent: the
    agent always writes a fresh, schema-valid envelope.
    """
    output_path.unlink(missing_ok=True)
    transcript_path.unlink(missing_ok=True)



def _decide_session_and_recovery(
    *,
    tools_dir: Path,
    repo: Path,
    request_id: str,
    claim_id: str,
    agent_id: str,
    lease_token: str,
    subagent_type: str,
    request_envelope: dict[str, Any],
    prompt_hash: str,
    native_runtime: _NativeRuntimePlan | None = None,
) -> tuple[str | None, bool]:
    """Plan 032 Faz 032c — (session_id, resume), or (None, False) after a
    human_required recovery decision released the claim.

    Mock dispatches skip all of it: there is no session to bind and no
    workspace write to checkpoint.
    """
    if _MOCK_MODE_AT_ENTRY:
        return "mock-session", False
    from aria_kernel.agent_runtime_profile import read_agent_runtime_profile
    from aria_kernel.checkpoint import take_checkpoint
    from aria_kernel.recovery import classify_recovery, gh_remote_reader
    from aria_kernel.session_continuity import decide_session, session_fingerprint, session_store_dir

    profile = read_agent_runtime_profile(subagent_type, repo_root=_kernel_checkout_root())
    recording = UsageRecording(request_id=request_id, role=str(request_envelope.get("role") or ""),
                               target_agent=subagent_type, base_dir=tools_dir)
    fingerprint = session_fingerprint(
        target_sha=str(request_envelope.get("target_sha") or ""),
        profile_id=profile.profile_id,
        prompt_hash=prompt_hash,
        settings_hash=(native_runtime.context.settings_hash if native_runtime is not None else
                       spawn_settings_hash(agent_profile=profile, usage_recording=recording, workspace_root=repo)),
        model=native_runtime.route["model"] if native_runtime is not None else profile.model,
    )
    decision = classify_recovery(
        request_id, base_dir=tools_dir, fingerprint=fingerprint, remote_reader=gh_remote_reader(repo),
    )
    if decision.decision == "human_required":
        sys.stderr.write(f"recovery_unresolved_external_effect: {request_id} {decision.reason}\n")
        _release_claim(
            tools_dir=tools_dir, repo=repo, claim_id=claim_id, agent_id=agent_id,
            lease_token=lease_token, reason="recovery_unresolved_external_effect",
        )
        return None, False
    # ARIA-HIGH-179 — resume only a session whose transcript the durable
    # store holds; the sandbox binds that store at the private config dir.
    session_id, resume = decide_session(request_id=request_id, claim_id=claim_id, fingerprint=fingerprint,
                                        base_dir=tools_dir, store_dir=session_store_dir())
    if profile.write_capable:
        try:
            take_checkpoint(workspace_root=repo, request_id=request_id, reason=_PRE_SPAWN_CHECKPOINT_REASON, base_dir=tools_dir)
        except Exception as exc:  # noqa: BLE001 — a checkpoint that cannot be taken is named, not fatal
            sys.stderr.write(f"checkpoint_pre_spawn_failed: {type(exc).__name__}\n")
    return session_id, resume


def _rollback_after_blocked_spawn(*, tools_dir: Path, request_id: str, subagent_type: str, why: str) -> None:
    """Plan 032 Faz 032c — a write-capable spawn that ended blocked has its
    LOCAL edits put back (hand edits preserved); external effects are left to
    the recovery classifier, never to a blind reset."""
    try:
        from aria_kernel.agent_runtime_profile import read_agent_runtime_profile
        from aria_kernel.checkpoint import list_checkpoints, restore_checkpoint
        from aria_kernel.tool_registry import append_tools_governance, ensure_tools_dir

        profile = read_agent_runtime_profile(subagent_type, repo_root=_kernel_checkout_root())
        if not profile.write_capable or not list_checkpoints(request_id, base_dir=tools_dir):
            return
        result = restore_checkpoint(workspace_root=_REPO_ROOT, request_id=request_id, base_dir=tools_dir)
        append_tools_governance(ensure_tools_dir(tools_dir), "implementation_rolled_back",
                                {"request_id": request_id, "why": why, **result})
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f"rollback_after_blocked_spawn_failed: {type(exc).__name__}\n")


# ARIA-HIGH-123 — the governance row the publication of a request's sandbox
# quarantine lands on: what moved into the shared repository, what was
# refused by name.
IMPLEMENTATION_QUARANTINE_PUBLISHED_EVENT = "implementation_quarantine_published"
# (round 3) the quarantine was NOT published: the job's window could not hold
# the delivery after the spawn, so the agent's commit is discarded rather
# than published as a branch the retry would collide with.
IMPLEMENTATION_QUARANTINE_DISCARDED_EVENT = "implementation_quarantine_discarded"
# ARIA-HIGH-124 (round 5) — the executor retired the request's signing
# identity (agent stopped, private key unlinked, config restored) right
# after the quarantine's publication, before the delivery; `keys_dir_entries`
# is what the workspace keys dir still holds at that moment.
IMPLEMENTATION_IDENTITY_RETIRED_EVENT = "implementation_identity_retired"


def _publish_sandbox_commits(*, tools_dir: Path, request_id: str, claim_id: str, containment: Any) -> Any:
    """ARIA-HIGH-123 — move what the implementer committed inside its sandbox
    into the shared repository, from outside, with git's own checks
    (`git_containment.publish_quarantine`), and record the receipt. The
    bridge verifies the commit in the shared checkout right after; a
    publication that refused an object or a ref is on the row by name, and
    the refused commit is then simply not there to verify."""
    from aria_kernel.git_containment import publish_quarantine
    from aria_kernel.tool_registry import append_tools_governance, ensure_tools_dir

    publication = publish_quarantine(containment)
    append_tools_governance(
        ensure_tools_dir(tools_dir), IMPLEMENTATION_QUARANTINE_PUBLISHED_EVENT,
        {"request_id": request_id, "claim_id": claim_id, "workspace_root": str(containment.workspace_root),
         **publication.to_row()},
    )
    _stage(
        f"implementation_quarantine_published refs={list(publication.refs_published)} "
        f"objects={publication.loose_objects_migrated} packs={publication.packs_unpacked} "
        f"refused_objects={len(publication.objects_refused)} discarded_refs={len(publication.refs_discarded)} "
        f"refusal={publication.refusal}"
    )
    return publication


def invoke_claude_cli(
    *,
    request_id: str,
    subagent_type: str,
    prompt_file: Path,
    output_path: Path,
    timeout_seconds: int,
    claim_id: str | None = None,
    agent_id: str | None = None,
    role: str,
    transcript_path: Path | None = None,
    must_satisfy: list[dict[str, Any]] | None = None,
    # Plan ARIA-V3.1-D3 — request envelope + tools_dir threading for
    # per-LLM-call cost attribution. When supplied (real path), the
    # post-subprocess success branch records a cost_attribution row
    # via record_cost_attribution. When None (legacy / mock-only call
    # sites), no row is written — V8 backward-compat preserved.
    request_envelope: dict[str, Any] | None = None,
    tools_dir: Path | None = None,
    session_id: str | None = None,
    resume: bool = False,
    spawn_control: Any | None = None,
    # ARIA-HIGH-115 — the fingerprint of the signing identity THIS executor
    # holds for the request (`implementation_identity`), for the cost row;
    # None for every role that holds no key (the row then carries the
    # `SHA256:no-key` sentinel).
    signer_key_fp: str | None = None,
    # ARIA-HIGH-123 — the commit-capable git containment the same holder
    # derived (`ImplementationIdentity.containment`): the spawn is wrapped
    # with it, so the agent's git can commit in the request worktree and
    # sign through the kernel-held agent. None for every other role.
    git_containment: Any | None = None,
) -> int:
    """Call the Claude Code CLI; mock path for tests + CI dry-runs.

    Plan 024 v3 §B-8 — mock envelope reads REAL lease tokens (claim_id
    + agent_id from claim_request) and REAL role (from the request
    row). Pre-fix the mock hardcoded ``claim_id="claim_mock"`` +
    ``agent_id="ci-executor:mock"`` which Plan 023 §A-5 lease binding
    rejects on submit; the "end-to-end mock" was therefore broken at
    the submission boundary.

    Plan 025 §B — ``role`` is a REQUIRED keyword (no default). Pre-fix
    a ``role: str | None = None`` default fed a string-mangle fallback
    in the mock branch (``role or subagent_type.replace(…)``) which
    silently re-introduced the kind of synthesized identity that §B-8
    closed for hard-coded literals. Promoting role to a required
    parameter makes the missing-role surface a TypeError at the call
    site (tier-1 structural enforcement) — every caller must source
    role from the request row's SSoT field.

    Returns the CLI exit code. Raises ClaudeCliUnavailable when the
    `claude` binary is not on $PATH and mock mode is OFF — the proven
    contract doc at tools/aria-poc/ci_executor_contract_proven.md is
    the argv SSoT (Plan ARIA-V3 §B1 promotion, invariant I-V3-21).
    """
    if _is_mock_mode():
        # Test path: write a deterministic mock envelope to the output
        # path the kernel will then read on submit. The mock envelope
        # passes the agent_contract.validate_response shape check
        # (Plan 023 §A-5 lease binding + Plan 024 §H-4 role match)
        # because claim_id + agent_id come from the real claim_request
        # output and role is read from the request row.
        if not claim_id or not agent_id:
            raise ValueError(
                "ci_executor_mock_missing_lease_identity: claim_id and "
                "agent_id are required (Plan 024 §B-8); the legacy "
                "claim_mock / ci-executor:mock literals were removed."
            )
        # Synthesize a satisfaction_matrix that satisfies must_satisfy
        # so Plan 024 §B-2 evidence_validator (non-empty matrix
        # enforcement) does not reject the mock envelope.
        matrix: list[dict[str, Any]] = []
        if must_satisfy:
            for criterion in must_satisfy:
                cid = criterion.get("id") if isinstance(criterion, dict) else None
                if cid:
                    matrix.append({
                        "id": cid,
                        "verdict": "unverified",
                        "evidence_refs": [],
                    })
        # Plan 025 §B latent-bug-2 closure — no string-mangle fallback.
        # Pre-fix ``role or subagent_type.replace("aria-", "").replace
        # ("-judge", "_judgment")`` re-introduced the synthesized role
        # pattern that §B-8 explicitly removed for claim_id + agent_id.
        # role is now required at the function signature; if a caller
        # passes "" (truthy-falsy edge), surface the gap as
        # ValueError instead of fabricating a role string.
        if not role.strip():
            raise ValueError(
                "ci_executor_mock_missing_role: role is required and "
                "must be non-empty (Plan 025 §B latent-bug-2 closure). "
                "Source role from the request envelope's SSoT field."
            )
        envelope_role = role
        output_path.parent.mkdir(parents=True, exist_ok=True)
        mock_envelope = {
                "$schema": "aria/agent-response/v1",
                "request_id": request_id,
                "claim_id": claim_id,
                "agent_id": agent_id,
                "role": envelope_role,
                "status": "submitted",
                "satisfaction_matrix": matrix,
                "evidence_refs": [],
                "details": {
                    # Y5 (ORPHAN-706) — the mock envelope satisfies the SAME
                    # judge contract the pre-submit gate enforces (verdict in
                    # the closed set + resolvable ids), exactly like the eval
                    # fixtures do. The old "uncertain" placeholder was an
                    # envelope the bridge could never fold — the measured
                    # defect class this contract exists to keep out. Mock
                    # mode is env-gated and never on in production lanes;
                    # the ci-mock fallbacks only fire when the request row
                    # itself carries no judgment identity (test fixtures).
                    "agent_subagent_type": subagent_type,
                    "verdict": {
                        "verdict": "false_positive",
                        "confidence": 0.5,
                        "judge_id": subagent_type,
                        "model": "mock",
                        "tool_id": str((request_envelope or {}).get("tool_id") or "ci-mock"),
                        "run_id": str((request_envelope or {}).get("run_id") or "ci-mock"),
                        "finding_id": str((request_envelope or {}).get("finding_id") or "ci-mock"),
                        "rationale": "MOCK MODE — CI executor placeholder; real Claude Code CLI invocation not configured",
                        "evidence_refs": [],
                        "judgment_group_id": str(
                            (request_envelope or {}).get("judgment_group_id") or "ci-mock"
                        ),
                        "severity": "low",
                    },
                },
            }
        _write_sanitized_envelope(output_path, mock_envelope)
        resolved_transcript_path = transcript_path or output_path.with_suffix(".transcript.jsonl")
        resolved_transcript_path.parent.mkdir(parents=True, exist_ok=True)
        resolved_transcript_path.write_text(
            json.dumps(
                {
                    "schema_version": "aria/ci-executor-transcript/v1",
                    "mode": "mock",
                    "request_id": request_id,
                    "claim_id": claim_id,
                    "agent_id": agent_id,
                    "role": envelope_role,
                    "subagent_type": subagent_type,
                },
                sort_keys=True,
            )
            + "\n",
            encoding="utf-8",
        )
        return 0

    request_prompt_text = prompt_file.read_text(encoding="utf-8") if prompt_file.exists() else ""
    # ARIA-HIGH-073 — the model is told to answer "per your agent contract";
    # this route sends the rendered request on stdin and never passed
    # `--agent`, so the contract reached the model only if it chose to Read
    # the file. Deliver it: contract first, request second. prompt_hash keeps
    # binding the request bytes; the contract's own hash rides the envelope.
    agent_contract = _deliver_agent_contract(subagent_type, _REPO_ROOT)
    prompt_text = agent_contract.text + "\n\n" + request_prompt_text
    output_path.parent.mkdir(parents=True, exist_ok=True)
    resolved_transcript_path = transcript_path or output_path.with_suffix(".transcript.jsonl")
    # ORPHAN-332 — a re-dispatched request must start from a clean slate (see
    # _clear_stale_dispatch_artifacts). Mock dispatches never reach here (they
    # return at the mock branch above).
    _clear_stale_dispatch_artifacts(output_path, resolved_transcript_path)
    if tools_dir is not None:
        try:
            _env_audit_keys = sorted([
                k for k in os.environ.keys()
                if k.startswith(("CLAUDE_", "ANTHROPIC_")) or k in ("HOME", "USER")
            ])
            _env_audit_payload = {
                "subagent_type": subagent_type,
                "request_id": request_id,
                "claude_sensitive_env_keys_present": _env_audit_keys,
                "api_key_mode_allowed": os.environ.get("ARIA_ALLOW_CLAUDE_API_KEY_MODE") == "1",
            }
            from aria_kernel.tool_registry import (
                append_tools_governance as _at_gov,
                ensure_tools_dir as _ens_tools,
            )
            _at_gov(_ens_tools(tools_dir), "claude_subprocess_env_audit", _env_audit_payload)
        except Exception:
            pass
    # Plan 023 §A — per-agent model/effort tiering. Both levers resolve from
    # the dispatched agent's frontmatter (scout tier runs cheaper; the
    # decider/writer tier stays on the most expensive model). Fail-safe:
    # unknown agent → most expensive tier.
    from aria_kernel.agent_runtime_profile import read_agent_runtime_profile
    agent_profile = read_agent_runtime_profile(subagent_type)
    read_containment = read_contained_profile(agent_profile)
    if tools_dir is not None and read_containment:
        try:
            from aria_kernel.tool_registry import (
                append_tools_governance as _rc_gov,
                ensure_tools_dir as _rc_ens,
            )
            _rc_gov(_rc_ens(tools_dir), "claude_spawn_read_contained", {
                "request_id": request_id, "subagent_type": subagent_type,
                "profile_id": getattr(agent_profile, "profile_id", None),
                "tools": list(getattr(agent_profile, "tools", ()) or ()),
            })
        except Exception:
            pass
    # ARIA-HIGH-002 — resolve the dispatch route BEFORE the claim is taken:
    # the trusted request envelope names the agent/role, the frontmatter SSoT
    # resolves the model, the redirect SSoT resolves the provider, and a
    # drain can key its circuit on that route without claiming work. The
    # provider/model fallback policy itself stays owned by claude_runtime.
    _dispatch_route = _dispatch_route_for(
        {**(request_envelope if isinstance(request_envelope, dict) else {}), "role": role},
        target_agent=subagent_type,
    )
    _summary_emitted = False

    def _emit_dispatch_summary(
        *, outcome: str, failure: DispatchFailure | None, exit_code: int | None,
    ) -> None:
        """Exactly one sanitized classified summary per terminal path."""
        nonlocal _summary_emitted
        if _summary_emitted:
            return
        _summary_emitted = True
        _write_dispatch_summary(
            route=_dispatch_route, request_id=request_id, outcome=outcome,
            failure=failure, exit_code=exit_code,
        )
    # ARIA-HIGH-124 — NO delivery credential enters the spawn. The scoped
    # GitHub token (`delivery_credentials`) used to be minted here and
    # exported into this spawn's environment so the agent could push and
    # open its PR from inside the sandbox; the push, the apply gate and the
    # PR are the EXECUTOR's now, after the spawn, outside the sandbox, and
    # the token is minted there too (round 6: `implementation_delivery`
    # enters `hold_delivery_credentials` after the gate, for the push and
    # the PR alone), so it has no reader inside, rides nothing the agent
    # can see, and does not exist while the agent runs.
    # ARIA_REQUEST_ID / ARIA_CLAIM_ID still ride along: the hooks and the
    # MCP relay name the request by them.
    spawn_extra_env: dict[str, str] = {"ARIA_REQUEST_ID": str(request_id)}
    if claim_id:
        spawn_extra_env["ARIA_CLAIM_ID"] = str(claim_id)
    try:
        # Model dispatch through the claude_runtime SSoT helper: a credit
        # exhaustion is terminal for the attempt (ClaudeCreditExhausted,
        # handled by main()'s requeue arm), a refusal rides the result and is
        # escalated below, and only an AUTH failure of a read-only role is
        # retried — once, on the other vendor. The executor supplies the
        # attempt closure and its governance-audit callback; the helper owns
        # the single-retry-bounded control flow.
        def _dispatch_attempt(model: str, effort: str) -> ClaudeRunResult:
            # The auth failover is written in tier names; the runtime that
            # serves a tier is the fleet's decision. A Z.ai tier (its own HTTP
            # transport since the 2026-09-11 policy) never reaches the claude
            # binary — run_claude_exec refuses it by name if asked.
            if _provider_for_model(model) == "zai":
                return _run_zai_as_claude_result(
                    prompt_text=prompt_text, model=model, timeout_seconds=timeout_seconds,
                    usage_recording=(
                        UsageRecording(request_id=request_id, role=role,
                                       target_agent=subagent_type, base_dir=tools_dir)
                        if tools_dir is not None else None
                    ),
                )
            return run_claude_exec(
                prompt_text=prompt_text,
                timeout_seconds=timeout_seconds,
                model=model,
                effort=effort,
                # ARIA-HIGH-162 — a read-contained profile never carries the
                # bypass flag: `read_contained_profile` is the one rule.
                skip_permissions=not read_containment,
                read_containment=read_containment,
                # Plan 032 Faz 032b — the workspace is EXPLICIT: the sandbox
                # binds it and the agent runs in it. Pre-fix no cwd was passed
                # and containment bound whatever Path.cwd() happened to be.
                cwd=_REPO_ROOT,
                agent_profile=agent_profile,
                # Plan 032 Faz 032c — the kernel's session decision.
                session_id=session_id,
                resume=resume,
                extra_env=spawn_extra_env,
                # Plan 032 Faz 032e — operator cancel polling + progress tail.
                spawn_control=spawn_control,
                # ARIA-HIGH-123 — the executor-held commit containment.
                git_containment=git_containment,
                # E17-d — per-spawn usage accounting. This callsite is the
                # seam where the full identity is in scope: request_id +
                # envelope role + subagent_type are REQUIRED parameters of
                # invoke_claude_cli (Plan 025 §B). tools_dir=None is the
                # legacy/mock-only shape — no tools root, nothing to record
                # into, same gate the cost_attribution row uses.
                usage_recording=(
                    UsageRecording(
                        request_id=request_id,
                        role=role,
                        target_agent=subagent_type,
                        base_dir=tools_dir,
                    )
                    if tools_dir is not None
                    else None
                ),
            )

        def _gov(event: str, payload: dict[str, Any]) -> None:
            if tools_dir is None:
                return
            try:
                from aria_kernel.tool_registry import (
                    append_tools_governance as _fb_gov,
                    ensure_tools_dir as _fb_ens,
                )
                _fb_gov(_fb_ens(tools_dir), event, payload)
            except Exception:
                pass

        # Operator decision 2026-09-12 — the detection is audited where it is
        # made; the DECISION (requeue under a provider cooldown, never a
        # weaker tier) is main()'s and is recorded there with the claim
        # identity. ORPHAN-HIGH-478 still applies: this row states what
        # happened (which marker, which model) and names no hop, because
        # there is none.
        def _on_credit(model: str, marker: dict[str, Any]) -> None:
            # `model` is the tier that ran out — the auth failover rung when
            # the primary's credential was dead — never assumed to be the
            # profile's own.
            _gov("model_credit_exhausted", {
                "request_id": request_id,
                "subagent_type": subagent_type,
                "model": model,
                "credit_exhaustion": marker,
            })
            _stage(
                f"model_credit_exhausted request_id={request_id} "
                f"marker={marker.get('matched_marker')!r} model={model}"
            )

        # ARIA-AUDIT-021: reserve BEFORE the external call. The budget
        # gate existed with zero production callers, so cost was only ever
        # evaluated AFTER the spend, on the success path, with unknown
        # models priced at $0 — fail-open in every direction. The
        # reservation uses a conservative notional ceiling for the model
        # family; a model with NO resolvable price refuses unless the
        # operator injects ARIA_COST_UNKNOWN_ACK (unknown-cost = deny,
        # never zero).
        # Under the managed-subscription policy the notional price is
        # telemetry the attempt row already carries (ORPHAN-HIGH-472: a
        # subscription session has no marginal per-run charge to cap), and
        # the native admission has already decided; the dollar reservation
        # below stays the rule for the metered policy only.
        from aria_kernel.genesis_policy import _adaptive_runtime_policy as _runtime_policy

        _policy = _runtime_policy(_operator_policy_root(tools_dir)) if tools_dir is not None else None
        _managed_subscription = _policy is not None and _policy.monetary_admission == "managed_subscription"
        if tools_dir is not None and _MOCK_MODE_AT_ENTRY is False and not _managed_subscription:
            from aria_kernel.budget import PRICING_SOURCE_UNKNOWN, price_spawn_reservation
            from aria_kernel.cost_budget import assert_within_budget
            from aria_kernel.tool_registry import GovernanceError as _BudgetRefusal

            # The profile names a CLI ALIAS ("opus"), and the pricing tables
            # are keyed by resolved id and family. This gate used to look the
            # alias up in those tables itself, found nothing for every
            # Anthropic profile, and refused the night as "unknown cost" —
            # 82 requests, 0 results, 2026-09-04. The ledger prices through
            # budget's alias map; the reservation now takes the same road,
            # so the gate cannot price a model the ledger prices differently.
            _reservation = price_spawn_reservation(model=agent_profile.model)
            if _reservation.source == PRICING_SOURCE_UNKNOWN and not os.environ.get("ARIA_COST_UNKNOWN_ACK", "").strip():
                # A typed failure, not a string: the summary writer reads
                # .failure_class, and a str here crashed the refusal path.
                _emit_dispatch_summary(
                    outcome="failed",
                    failure=DispatchFailure(
                        failure_class="policy_violation", retryable=False,
                        detail_code="cost_reservation_refused_pricing_unknown", phase="preflight", exit_code=1,
                    ),
                    exit_code=1,
                )
                return 1
            # The ceiling (SPAWN_RESERVATION_CEILING_TOKENS) is budget's; an
            # acknowledged unknown model reserves $0 exactly as before.
            _estimate = _reservation.usd
            try:
                assert_within_budget(tools_dir, estimated_run_usd=_estimate)
            except _BudgetRefusal:
                _emit_dispatch_summary(
                    outcome="failed",
                    failure=DispatchFailure(
                        failure_class="policy_violation", retryable=False,
                        detail_code="cost_reservation_refused", phase="preflight", exit_code=1,
                    ),
                    exit_code=1,
                )
                return 1

        # Plan 032 Faz 032i — the token-economy governor may lower the effort
        # one rung while a fresh downgrade recommendation stands (governance
        # row per application); the profile's effort is the ceiling.
        from aria_kernel.token_economy import effective_effort

        _effort = effective_effort(agent_profile.effort, target_agent=subagent_type, role=role, base_dir=tools_dir, request_id=request_id)
        completed = run_with_model_fallback(
            run=_dispatch_attempt,
            model=agent_profile.model,
            effort=_effort,
            # The role condition of the auth failover, from the profile SSoT:
            # a write-scope profile is never handed to a read-only runtime.
            write_capable=agent_profile.write_capable,
            on_credit=_on_credit,
        )
        if completed.refusal is not None:
            _unresolved_payload = {
                "request_id": request_id,
                "subagent_type": subagent_type,
                "model": agent_profile.model,
                "refusal": completed.refusal,
            }
            if tools_dir is not None:
                try:
                    from aria_kernel.tool_registry import (
                        append_tools_governance as _ru_gov,
                        ensure_tools_dir as _ru_ens,
                    )
                    _ru_gov(_ru_ens(tools_dir), "model_refusal_unresolved", _unresolved_payload)
                except Exception:
                    pass
                # One recorder (round 3): in-process, the category in the
                # record's context. The caller's arm releases this spawn
                # harness-class (`claude_spawn_refused`) whatever happens
                # here; a recorder that does not answer is a job error
                # with its whole cause, so the operator learns the
                # escalation did not land.
                _hr_category = str(completed.refusal.get("category") or "uncategorized")
                try:
                    _record_human_required(
                        tools_dir=tools_dir, request_id=request_id, severity="HIGH",
                        reason=f"model_safety_refusal:{_hr_category}: the model refused the request",
                        context={"code": f"model_safety_refusal:{_hr_category}", "stage": "model_refusal",
                                 "claim_id": claim_id, "category": _hr_category, "model": agent_profile.model},
                    )
                except HumanRequiredRecordUnavailable as _hr_exc:
                    sys.stderr.write(
                        f"::error::aria executor could not record HUMAN_REQUIRED for request {request_id} "
                        f"(model_safety_refusal:{_hr_category}): {_hr_exc}\n"
                    )
            # ARIA-HIGH-002 — a model refusal is not a build failure: the
            # summary says "refused", the escalation path stays as-is.
            _emit_dispatch_summary(
                outcome="refused", failure=None, exit_code=completed.returncode,
            )
            raise ClaudeCliUnavailable(
                "model_safety_refusal_unresolved: request "
                f"{request_id} refused by {agent_profile.model} "
                f"(category={completed.refusal.get('category')!r}); "
                "escalated to HUMAN_REQUIRED"
            )
    except (
        ClaudeAuthUnavailable,
        ClaudeCliUnavailable,
        ClaudePolicyViolation,
        ClaudeUsageUnavailable,
        ClaudeAuthFailure,
        ClaudeCreditExhausted,
        subprocess.TimeoutExpired,
    ) as exc:
        # ARIA-HIGH-002 — every terminal perimeter path writes exactly one
        # sanitized classified summary before the exception travels on. The
        # classification names the ORIGINAL condition; the translation below
        # preserves the existing contract-reference wrapping unchanged.
        _emit_dispatch_summary(
            outcome="failed",
            failure=classify_dispatch_failure(exception=exc, phase="spawn"),
            exit_code=None,
        )
        if isinstance(
            exc,
            (ClaudeAuthUnavailable, ClaudeCliUnavailable, ClaudePolicyViolation, ClaudeUsageUnavailable),
        ):
            contract = "tools/aria-poc/ci_executor_contract_proven.md"
            raise ClaudeCliUnavailable(f"{exc}; see {contract}") from exc
        raise
    # Plan ARIA-V7 §2g v2 + V7.10 envelope-extraction fix.
    #
    # WHY: claude -p stream-json emits JSONL events
    # ({"result": "...", "total_cost_usd": ..., ...}) where the agent's final message may contain the
    # actual aria/agent-response/v1 envelope as fenced ```json``` block
    # or as final JSON block. Writing raw JSONL to output_path means
    # kernel submit-result reads runtime telemetry instead of the envelope,
    # which fails:
    #   response_schema: missing required fields:
    #     ['$schema', 'request_id', 'claim_id', 'agent_id', 'role',
    #      'status', 'satisfaction_matrix']
    #
    # HOW: parse JSONL, extract the final message, find the embedded
    # envelope JSON, INJECT mandatory identity fields ($schema,
    # request_id, claim_id, agent_id, role, status) from the known
    # ci_executor context (these aren't the agent's job — the agent
    # only knows its plan content), synthesize a satisfaction_matrix
    # from must_satisfy with verdict=satisfied when the agent omitted
    # it, then write the corrected envelope to output_path.
    #
    # Tier hierarchy: Tier-2 (Make it automatic) — the envelope shape
    # is now produced correctly by default; agents don't have to know
    # internal kernel identity fields.
    if completed.stdout:
        envelope = _build_envelope_from_claude_output(
            raw_stdout=completed.stdout,
            request_id=request_id,
            claim_id=claim_id or "",
            agent_id=agent_id or "",
            role=role,
            subagent_type=subagent_type,
            must_satisfy=must_satisfy or [],
            # ARIA-MEDIUM-171 — the rung that answered, not the frontmatter.
            dispatch_model=completed.model or agent_profile.model,
            usage=completed.usage,
        )
        envelope["details"]["agent_contract_hash"] = agent_contract.contract_hash
        output_path.parent.mkdir(parents=True, exist_ok=True)
        _write_sanitized_envelope(output_path, envelope)
        resolved_transcript_path.parent.mkdir(parents=True, exist_ok=True)
        resolved_transcript_path.write_text(completed.stdout, encoding="utf-8")
        # Plan ARIA-V3.1-D3 — per-LLM-call cost attribution. Gated on
        # _MOCK_MODE_AT_ENTRY frozen sentinel (V3.1-D2) so a mid-run
        # CLAUDE_CLI_MOCK flip cannot rewrite mock-mode classification
        # between mint + record sites. request_envelope + tools_dir
        # MUST both be supplied for the record to fire — None defaults
        # preserve V8 backward-compat for callers that haven't migrated.
        if (
            completed.returncode == 0
            and _MOCK_MODE_AT_ENTRY is False
            and request_envelope is not None
            and tools_dir is not None
        ):
            _record_claude_cli_usage(
                raw_stdout=completed.stdout,
                request_envelope=request_envelope,
                tools_dir=tools_dir,
                role=role,
                request_id=request_id,
                signer_key_fp=signer_key_fp,
                usage=completed.usage,
            )
    _emit_dispatch_summary(
        outcome="succeeded" if completed.returncode == 0 else "failed",
        failure=classify_dispatch_failure(result=completed, phase="runtime"),
        exit_code=completed.returncode,
    )
    if completed.returncode != 0 and completed.stderr:
        # The child's own last words, bounded and lease-redacted: a non-zero
        # exit with no cause is the operator reading four ledgers to learn
        # that the limiter could not reach a bus.
        sys.stderr.write("claude_stderr_tail: " + _redact_lease_in_message(completed.stderr[-2000:], None) + "\n")
    return completed.returncode


def _cost_identity(request_envelope: Mapping[str, Any], request_id: str | None) -> tuple[str, str]:
    """(cycle_id, plan_id) a cost row is attributed to — ONE derivation for
    every runtime path (ARIA-HIGH-180).

    A judge request is minted by the fan-out with no convergence: the
    Claude path always fell back to ``plan-<request tail>`` for it, while
    the Z.ai and Codex paths passed ``request["convergence_id"]`` — ``None``
    — straight to ``record_cost_attribution``, whose ``GovernanceError`` the
    attempt caught as ``control_or_transport_unavailable`` AFTER the verdict
    had been written: the first Z.ai adversarial judgment after the
    declared-provider fix (run 35485712865, 2026-09-20 03:32Z) was paid,
    parsed, written to its envelope and then released as a harness fault,
    with the request requeued to be judged and discarded again.
    """
    short_rid = (request_id or "")[-12:] or "unknown"
    cycle_id = request_envelope.get("cycle_id") or f"cyc-no-id-{short_rid}"
    plan_id = (
        request_envelope.get("convergence_id")
        or request_envelope.get("plan_id")
        or f"plan-{short_rid}"
    )
    if not isinstance(cycle_id, str) or not cycle_id:
        cycle_id = f"cyc-no-id-{short_rid}"
    if not isinstance(plan_id, str) or not plan_id:
        plan_id = f"plan-{short_rid}"
    return cycle_id, plan_id


def _record_claude_cli_usage(
    *,
    raw_stdout: str,
    request_envelope: dict[str, Any],
    tools_dir: Path,
    role: str,
    request_id: str,
    signer_key_fp: str | None = None,
    usage: dict[str, Any] | None = None,
) -> None:
    """Record Claude usage with a TRUTHFUL USD attribution.

    ``usage`` is the run result's own block when the caller holds one
    (ARIA-HIGH-161, same seam as ``_build_envelope_from_claude_output``);
    the stream parse of ``raw_stdout`` is the fallback.

    ``signer_key_fp`` is the fingerprint of the signing identity this
    executor holds for the request (ARIA-HIGH-115: minted in the request
    worktree by `implementation_identity`), passed by the one holder rather
    than read from an environment variable nothing exported; a role that
    holds no key records the ledger's `SHA256:no-key` sentinel.

    Cost resolution order (ORPHAN-HIGH-311 — the previous hardcoded
    ``estimated_usd=0.0`` made the operator's USD budget caps toothless
    and the ROI metric read $0 on real dispatches):

    1. The CLI's own ``total_cost_usd`` from the terminal result event
       (authoritative when the account bills per call).
    2. Notional token pricing (``budget.MODEL_PRICING_USD_PER_MTOK``) —
       managed-session auth has no per-call bill, but subscription
       capacity is rate-limited, not free; caps bind on economic value.
    3. Unknown model → 0.0 recorded PLUS a ``cost_pricing_unknown_model``
       governance event so the zero is visible, never silent.

    If Claude stream-json omits usage, real mode has already failed
    closed in ``claude_runtime.run_claude_exec`` before submit.
    """
    events = parse_claude_jsonl(raw_stdout)
    if usage is None:
        usage = extract_usage(events)
    if not isinstance(usage, dict):
        return
    input_tokens = usage.get("input_tokens") or usage.get("prompt_tokens") or 0
    output_tokens = usage.get("output_tokens") or usage.get("completion_tokens") or 0
    try:
        input_tokens = int(input_tokens)
        output_tokens = int(output_tokens)
    except (TypeError, ValueError):
        return
    model = "claude-cli"
    for event in reversed(events):
        candidate = event.get("model")
        if isinstance(candidate, str) and candidate.strip():
            model = candidate.strip()
            break
    if not isinstance(role, str) or not role.strip():
        return

    cycle_id, plan_id = _cost_identity(request_envelope, request_id)

    pressure_source_type = request_envelope.get("pressure_source_type")
    if not isinstance(pressure_source_type, str):
        pressure_source_type = None

    if not isinstance(signer_key_fp, str) or not signer_key_fp.startswith("SHA256:"):
        signer_key_fp = "SHA256:no-key"

    # Cost resolution — see the docstring's 3-step order.
    actual_cost_usd: float | None = None
    for event in reversed(events):
        if event.get("type") != "result":
            continue
        candidate_cost = event.get("total_cost_usd")
        if isinstance(candidate_cost, (int, float)) and candidate_cost > 0:
            actual_cost_usd = float(candidate_cost)
        break
    try:
        from aria_kernel.budget import (
            PRICING_SOURCE_FAMILY,
            price_tokens,
            record_cost_attribution,
        )
        # ORPHAN-HIGH-476 — price_tokens, not estimate_tokens_usd: the bare
        # float discards HOW the price was derived, so a family estimate would
        # be filed as though it were a measured rate.
        priced = price_tokens(
            model=model, input_tokens=input_tokens, output_tokens=output_tokens,
        )
        estimated_usd = actual_cost_usd if actual_cost_usd is not None else priced.usd
        if (
            actual_cost_usd is None
            and priced.source == PRICING_SOURCE_FAMILY
            and (input_tokens or output_tokens)
        ):
            # A new model generation the exact table has not caught up with.
            # The charge is real enough to keep the caps binding, but the
            # operator needs to know it is inferred so the rate can be
            # corrected — silence here is how an estimate becomes "the number".
            try:
                from aria_kernel.tool_registry import append_tools_governance
                append_tools_governance(
                    tools_dir,
                    "cost_pricing_inferred_from_family",
                    {
                        "model": model,
                        "matched_family": priced.matched_key,
                        "estimated_usd": priced.usd,
                        "request_id": request_id,
                    },
                )
            except Exception:
                pass
        if estimated_usd == 0.0 and (input_tokens or output_tokens):
            # Tokens were consumed but no price resolved — make the zero
            # loud instead of silently under-counting the caps.
            try:
                from aria_kernel.tool_registry import append_tools_governance
                append_tools_governance(
                    tools_dir,
                    "cost_pricing_unknown_model",
                    {
                        "model": model,
                        "input_tokens": input_tokens,
                        "output_tokens": output_tokens,
                        "request_id": request_id,
                    },
                )
            except Exception:
                pass
        record_cost_attribution(
            cycle_id=cycle_id,
            plan_id=plan_id,
            agent_role=role,
            model=model,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            estimated_usd=estimated_usd,
            pressure_source_type=pressure_source_type,
            signer_key_fp=signer_key_fp,
            base_dir=tools_dir,
        )
    except Exception:
        return


# Regex tuned for ```json ... ``` fenced blocks anywhere in the agent
# text. Re-used by _extract_envelope_json to find the envelope payload.
_FENCED_JSON_RE = re.compile(r"```(?:json)?\s*(\{.*?\})\s*```", re.DOTALL)


def _extract_envelope_json(text: str) -> dict[str, Any] | None:
    """Find the agent's embedded envelope JSON in a natural-language reply.

    Scan order (first match wins):
      1. Fenced ```json``` blocks containing a JSON object.
      2. Last balanced top-level {...} block in the text.

    Returns the parsed dict or None when no JSON is recoverable.
    """
    # Pass 1: fenced JSON blocks — prefer the LAST one (agents typically
    # narrate first then close with the envelope).
    matches = _FENCED_JSON_RE.findall(text)
    for body in reversed(matches):
        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            continue
        if isinstance(data, dict):
            return data
    # Pass 2: balanced-brace scan from end-of-text for the last {...} block.
    depth = 0
    end_idx = -1
    for i in range(len(text) - 1, -1, -1):
        ch = text[i]
        if ch == "}":
            if depth == 0:
                end_idx = i
            depth += 1
        elif ch == "{":
            depth -= 1
            if depth == 0 and end_idx > 0:
                candidate = text[i : end_idx + 1]
                try:
                    data = json.loads(candidate)
                except json.JSONDecodeError:
                    end_idx = -1
                    continue
                if isinstance(data, dict):
                    return data
    return None


def _build_envelope_from_claude_output(
    *,
    raw_stdout: str,
    request_id: str,
    claim_id: str,
    agent_id: str,
    role: str,
    subagent_type: str,
    must_satisfy: list[dict[str, Any]],
    dispatch_model: str | None = None,
    usage: dict[str, Any] | None = None,
    confidence_source: str = "self_reported",
) -> dict[str, Any]:
    """Convert ``claude -p stream-json`` JSONL into a kernel-valid envelope.

    ``confidence_source`` is the ROUTE's word on where a judge's confidence
    came from (typed-judgment plan, ARIA-HIGH-167): every CLI and chat
    completion in the fleet reports the model's own number
    (``self_reported``); a typed decision transport that returns
    probabilities natively stamps ``provider_reported``. Stamped
    unconditionally, like the dispatch model: the bridge reads the stamp and
    ignores any spelling the model wrote inside its payload.

    ``usage`` is the run result's own usage block when the caller holds one
    (ARIA-HIGH-161): the Z.ai transport reports usage on the result, not as
    a stream-json event, so parsing ``raw_stdout`` alone left the
    cross-vendor rung's envelope without ``claude_cli_usage`` and the native
    wrapper released a finished verdict as ``usage_unavailable``. The stream
    parse stays the fallback for a caller that has only the bytes.

    Claude Code emits JSONL events. ARIA keeps those raw events out of
    artifacts, extracts the final agent message, and injects the
    lease-bound identity fields that the agent cannot know.
    """
    events = parse_claude_jsonl(raw_stdout)
    agent_text = extract_final_message(events)
    if not agent_text:
        agent_text = raw_stdout
    extracted = _extract_envelope_json(agent_text) or {}

    envelope: dict[str, Any] = {
        "$schema": "aria/agent-response/v1",
        "request_id": request_id,
        "claim_id": claim_id,
        "agent_id": agent_id,
        "role": role,
        "status": str(extracted.get("status") or "submitted"),
    }

    matrix_in = extracted.get("satisfaction_matrix")
    if isinstance(matrix_in, list) and matrix_in:
        envelope["satisfaction_matrix"] = matrix_in
    else:
        # Synthesize from must_satisfy so the kernel's non-empty-matrix
        # check passes — as UNVERIFIED rows (ARIA-AUDIT-024). The agent
        # being invoked and replying is transport evidence, not a
        # satisfaction judgment; the verdict belongs to an independent
        # judge reading this matrix, never to the executor that carried
        # the reply.
        synthesized: list[dict[str, Any]] = []
        excerpt = (agent_text or "<agent produced no text>").strip()
        excerpt_short = excerpt[:240] + ("..." if len(excerpt) > 240 else "")
        if must_satisfy:
            for item in must_satisfy:
                if not isinstance(item, dict):
                    continue
                cid = item.get("id")
                if not cid:
                    continue
                synthesized.append({
                    "id": cid,
                    "verdict": "unverified",
                    "evidence_refs": [],
                    "evidence": excerpt_short,
                })
        if not synthesized:
            # Last-resort single-row matrix; agent_text is the only
            # truthful evidence. Without this, the kernel rejects with
            # evidence_satisfaction_matrix_must_be_non_empty.
            synthesized.append({
                "id": f"agent-text-{request_id[-8:]}",
                "verdict": "unverified",
                "evidence_refs": [],
                "evidence": excerpt_short,
            })
        envelope["satisfaction_matrix"] = synthesized

    # Carry through any agent-supplied evidence_refs / details / notes.
    for passthrough in ("evidence_refs", "details", "notes", "plan_content"):
        if passthrough in extracted and extracted[passthrough] is not None:
            envelope[passthrough] = extracted[passthrough]
    if "evidence_refs" not in envelope:
        envelope["evidence_refs"] = []

    # Embed the raw agent text under details so operators have full
    # forensic context post-submission.
    details = envelope.get("details")
    if not isinstance(details, dict):
        details = {}
    # D1 (Kapalı Döngü) — FORCE-set, not setdefault: this field is now the
    # judge's calibration identity (judgment_bridge reads it as judge_id),
    # and a setdefault would let the agent's own payload spoof another
    # judge's identity into the per-judge precision ledger.
    details["agent_subagent_type"] = subagent_type
    # ORPHAN-HIGH-781 — the dispatch-resolved model, same doctrine as
    # agent_subagent_type above: FORCE-set from the runtime profile the
    # executor resolved at invocation time. The judge's own
    # verdict.model self-report remains in the payload as data, but the
    # kernel's anchor distinct-model count must not trust a string the
    # judged agent wrote about itself — a misreported model silently
    # satisfies or violates ANCHOR_MIN_DISTINCT_MODELS, which is exactly
    # the guarantee that field exists to provide.
    # ARIA-MEDIUM-171 — the route's word, never the agent's: a named model
    # overwrites whatever the agent wrote under the key, and a route that
    # named nothing REMOVES the key rather than leaving the agent's spelling
    # in place (ORPHAN-HIGH-781 pinned "no stale stamp" for the absent case).
    if dispatch_model:
        details["agent_dispatch_model"] = dispatch_model
    else:
        details.pop("agent_dispatch_model", None)
    details["agent_confidence_source"] = confidence_source
    details.setdefault("agent_text", _safe_agent_text_excerpt(agent_text))
    if usage is None:
        usage = extract_usage(parse_claude_jsonl(raw_stdout))
    if usage is not None:
        details.setdefault("claude_cli_usage", usage)
    envelope["details"] = details

    return envelope


def _rejected_result_recorded(submit_stdout: str) -> bool:
    """True when the submit step's answer is a kernel-recorded REJECTED result row.

    `aria_kernel agent submit-result` prints its result document on stdout and
    exits 1 for anything but `accepted`. When that document carries a result
    row with status `rejected`, the kernel has already appended the row: the
    claim is terminal (`_assert_lifecycle_mutation_allowed`) and the request
    derives REJECTED (`derive_request_state`, results dominate). Anything else
    on a non-zero exit is a refusal before the row and leaves the claim live.
    """
    text = submit_stdout or ""
    start = text.find("{")
    if start < 0:
        return False
    try:
        payload = json.loads(text[start:])
    except ValueError:
        return False
    row = payload.get("row") if isinstance(payload, dict) else None
    return (isinstance(payload, dict) and payload.get("status") == "rejected"
            and isinstance(row, dict) and row.get("row_type") == "result" and row.get("status") == "rejected")


def _held_request_state(request_id: str, base_dir: Path) -> str | None:
    """The lease guard's question to the kernel: what state is the request in?

    None when the kernel has no such request — nothing can be held, so the
    guard has nothing to hand back (the mocked executor fixtures claim a
    request that was never minted). `derive_request_state` refuses an
    unknown id, and a refusal the guard could not tell from an unreadable
    ledger would make it release on every mocked run.
    """
    from aria_kernel.agent_invocations import list_agent_invocation_requests

    if not list_agent_invocation_requests(request_id=request_id, base_dir=base_dir):
        return None
    return _derive_request_state(request_id=request_id, base_dir=base_dir)


def _rejected_only_for_verification_unavailable(submit_stdout: str) -> bool:
    """Did the kernel reject the submission SOLELY because it could not verify?

    The kernel CLI prints its verdict as JSON on stdout: on a rejection,
    ``reasons`` (prose, for the ledger and the operator) and
    ``rejection_codes`` (one machine code per reason). This reads the codes
    — never the prose — and answers True only when every code says the
    kernel's evidence probe could not run (git did not answer inside its
    bound on a loaded host). That is the harness's gap, not the work's: the
    same envelope resubmitted on a quiet host usually verifies, and it must
    not burn the request's requeue budget the way `submit_rejected` does
    (the 2026-08-09 `baseline_unavailable` class, at the acceptance seam).

    Anything else — unparseable output, a kernel exception, no codes, or
    ONE code that is about the work — is the request's fault: fail toward
    the human, never toward silent infinite retry.
    """
    try:
        payload = json.loads(submit_stdout or "")
    except ValueError:
        return False
    if not isinstance(payload, dict) or payload.get("status") != "rejected":
        return False
    codes = payload.get("rejection_codes")
    if not isinstance(codes, list) or not codes:
        return False
    return all(
        isinstance(code, str) and code in _EVIDENCE_VERIFICATION_UNAVAILABLE_CODES
        for code in codes
    )


def _release_claim(
    *,
    tools_dir: Path,
    repo: Path,
    claim_id: str,
    agent_id: str,
    lease_token: str,
    reason: str,
) -> bool:
    """Release a leased claim with a structured reason code.

    Plan 025 §B — extracted from the cost-cap path so every fail-fast
    branch in ``main()`` releases the lease deterministically. Without
    this helper a fail-fast branch could leak a claim row in the
    CLAIMED state until lease expiry, blocking re-attempts by the
    kernel reaper for the configured lease window. The reason code is
    surfaced verbatim to ``aria-kernel agent release --reason`` so
    operators reading governance.jsonl see the precise fail-mode.

    Plan 026R §B.1 — REAL CI BUG fix. Pre-§B.1 the argv was missing
    ``--agent-id`` (the kernel CLI requires it) AND the CLI did not
    accept ``--lease-token-from-env`` (the parser had no such flag).
    Today's CI fail-fast branches that call this helper FAILED at
    argparse and silently leaked the claim until reaper sweep. The
    fix adds ``--agent-id`` to the argv + the matching CLI flag
    registration in §B.1's cli.py change.
    """
    released = subprocess.run(
        _kernel_cli_argv(
            "agent", "release",
            "--claim-id", claim_id,
            "--agent-id", agent_id,
            "--lease-token-from-env", LEASE_TOKEN_ENV_VAR,
            "--reason", reason,
            "--tools-dir", str(tools_dir),
        ),
        env={
            **os.environ,
            "PYTHONPATH": _KERNEL_PYTHONPATH,
            LEASE_TOKEN_ENV_VAR: lease_token,
        },
        capture_output=True,
        text=True,
    )
    if released.returncode != 0:
        # A release that FAILED used to be indistinguishable from a release
        # that happened: the return code was never read, so a governance
        # refusal, an expired lease or an agent-id mismatch left the claim in
        # CLAIMED while the executor walked away reporting only its original
        # error.
        #
        # That is a permanent queue leak, not a transient one. `PENDING` is
        # reachable from `CLAIMED` ONLY through an explicit released/requeued
        # event (agent_invocations.derive_request_state), and once the 30-minute
        # lease expires the state derives `STALE`, which `next_pending_request`
        # skips and `claim_request` refuses. Both exits are closed; the row is
        # dead. Measured 2026-08-09: ten of twelve requests in that state.
        detail = "\n".join(
            part for part in (released.stdout or "", released.stderr or "") if part.strip()
        ) or "(the release produced no output)"
        sys.stderr.write(
            f"::error::aria executor could not release claim {claim_id} "
            f"(reason={reason}): "
            + _redact_lease_in_message(detail, lease_token)
            + ". The request stays CLAIMED and no later run can pick it up.\n"
        )
    return released.returncode == 0


def _read_claim_metadata_file(path: str | None) -> str | None:
    """The serialised claim metadata the planner hook wrote for this child.

    None when no file is named (the executor then claims for itself). A
    named file that cannot be read is a refusal, not a silent fall-through
    to a second claim: the planner already holds the lease.
    """
    if not path:
        return None
    try:
        return Path(path).read_text(encoding="utf-8")
    except OSError as exc:
        raise SystemExit(f"single_claim_mode_metadata_unreadable: {type(exc).__name__}") from exc


def _deserialise_inherited_claim_metadata(
    raw_payload: str,
    *,
    agent_id: str | None,
    request_id: str,
    tools_dir: Path,
) -> tuple[dict[str, Any], str | None]:
    """Plan 026R §B.5 — deserialise the claim metadata + verify integrity.

    Returns ``(claim_dict, error_message)`` where ``error_message`` is
    None on success. The error_message is printed verbatim by main() so
    the operator audit trail captures the exact tamper / mismatch
    reason.

    Three invariants enforced:

    1. **Schema reject of forbidden keys** — the metadata payload MUST
       NOT contain ``lease_token`` or ``lease_token_hash``. Mirrors the
       sender-side reject in planner_dispatch_hook so a tamper at
       either boundary surfaces immediately.
    2. **agent_id binding** — if an expected agent_id is supplied,
       metadata's agent_id MUST equal it. Single-claim mode supplies
       None and adopts the planner hook's claim owner from metadata
       because that hook already performed the kernel claim.
    3. **Ledger-hash integrity** — ``claim_ledger_hash`` and
       ``request_ledger_hash`` are re-derived from on-disk
       claims.jsonl + requests.jsonl rows by claim_id / request_id and
       compared against the metadata anchors. A mismatch means the
       envelope was tampered between planner-claim time and executor-
       consume time (or the disk state diverged from what the planner
       observed under its lock window — the §B.3 lock-bound fusion
       prevents this in correct operation, so a mismatch is a real
       integrity signal).
    """
    try:
        metadata = json.loads(raw_payload)
    except json.JSONDecodeError as exc:
        return {}, f"single_claim_metadata_invalid_json: {exc}"
    if not isinstance(metadata, dict):
        return {}, "single_claim_metadata_not_object"

    leaked = CLAIM_METADATA_FORBIDDEN_KEYS & set(metadata.keys())
    if leaked:
        return (
            {},
            f"single_claim_metadata_forbidden_key: {sorted(leaked)} "
            f"— lease_token MUST transit only via {LEASE_TOKEN_ENV_VAR}",
        )

    if agent_id is not None and metadata.get("agent_id") != agent_id:
        return (
            {},
            f"single_claim_metadata_agent_id_mismatch: "
            f"metadata={metadata.get('agent_id')!r} executor={agent_id!r}",
        )
    if metadata.get("request_id") != request_id:
        return (
            {},
            f"single_claim_metadata_request_id_mismatch: "
            f"metadata={metadata.get('request_id')!r} "
            f"argv={request_id!r}",
        )

    claim_id = metadata.get("claim_id")
    expected_claim_hash = metadata.get("claim_ledger_hash")
    expected_request_hash = metadata.get("request_ledger_hash")
    if not (claim_id and expected_claim_hash and expected_request_hash):
        return (
            {},
            f"single_claim_metadata_missing_anchors: claim_id={claim_id!r} "
            f"claim_ledger_hash={expected_claim_hash!r} "
            f"request_ledger_hash={expected_request_hash!r}",
        )

    actual_claim_hash, actual_request_hash = _on_disk_anchors(
        tools_dir=tools_dir, claim_id=str(claim_id), request_id=request_id,
    )
    if actual_claim_hash != expected_claim_hash:
        return (
            {},
            f"single_claim_metadata_tampered_claim_ledger_hash: "
            f"expected={expected_claim_hash!r} actual={actual_claim_hash!r}",
        )
    if actual_request_hash != expected_request_hash:
        return (
            {},
            f"single_claim_metadata_tampered_request_ledger_hash: "
            f"expected={expected_request_hash!r} "
            f"actual={actual_request_hash!r}",
        )
    return metadata, None


def _on_disk_anchors(
    *, tools_dir: Path, claim_id: str, request_id: str,
) -> tuple[str | None, str | None]:
    """Read the on-disk ledger_hash for the named claim + request rows."""
    claims_path = tools_dir / "agent-invocations" / "claims.jsonl"
    requests_path = tools_dir / "agent-invocations" / "requests.jsonl"
    claim_hash: str | None = None
    request_hash: str | None = None
    # Late import keeps standalone/mock executor startup behavior unchanged.
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "aria-kernel"))
    from aria_kernel.ledger import load_declared_jsonl

    if claims_path.exists():
        for row in load_declared_jsonl(
            claims_path,
            expected_surface="agent_invocation_claims",
        ):
            if (
                row.get("claim_id") == claim_id
                and row.get("event") == "claimed"
            ):
                claim_hash = row.get("ledger_hash")
    if requests_path.exists():
        for row in load_declared_jsonl(
            requests_path,
            expected_surface="agent_invocation_requests",
        ):
            if row.get("request_id") == request_id:
                request_hash = row.get("ledger_hash")
    return claim_hash, request_hash


def _record_mock_mode_audit(tools_dir: Path) -> None:
    """Plan ARIA-V3 §B1 AUDITTRAIL-HIGH-009 — record which layer
    decided the CLAUDE_CLI_MOCK value at executor entry.

    The workflow's pre-flight step computes ``effective_mock`` +
    ``mock_source`` (kill_switch / workflow_dispatch_input /
    workflow_default_claude) and exports both via the env. This
    function appends one ``claude_mock_mode_resolved`` governance
    row per executor invocation so an audit reviewer can replay the
    decision chain. Invariant I-V3-23a locks this contract.
    """
    try:
        # Late import — keeps the executor module importable when the
        # kernel package isn't on sys.path (mock-mode unit tests).
        sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "aria-kernel"))
        from aria_kernel.tool_registry import append_tools_governance, ensure_tools_dir
    except ImportError:
        return
    root = ensure_tools_dir(tools_dir)
    append_tools_governance(
        root,
        "claude_mock_mode_resolved",
        {
            "effective_mock": os.environ.get(MOCK_MODE_ENV_VAR, "unset"),
            "mock_source": os.environ.get("CLAUDE_CLI_MOCK_SOURCE", "unset"),
            "workflow_run_id": os.environ.get("GITHUB_RUN_ID", "local"),
            "workflow_run_attempt": os.environ.get("GITHUB_RUN_ATTEMPT", "local"),
        },
    )


def _provider_for_model(model: str | None) -> str:
    from aria_kernel.model_fleet import dispatching_provider_for_model

    return dispatching_provider_for_model(model)


def _run_zai_as_claude_result(
    *, prompt_text: str, model: str, timeout_seconds: int,
    usage_recording: UsageRecording | None,
) -> ClaudeRunResult:
    """One Z.ai call, reported in the shape the shared auth failover reads.

    The helper (claude_runtime.run_with_model_fallback) decides on
    ``auth_failure`` / ``credit_exhaustion`` / ``refusal`` and the executor
    reads ``stdout`` and ``usage``; those are filled from the transport's own
    classification. The vendor's response id stands in for a stream event
    so the transcript keeps a session reference; the auth remedy names the
    credential BOUNDARY, never a value.
    """
    from claude_runtime import _record_usage_best_effort
    from zai_runtime import (
        ZaiCredentialUnavailable, ZaiTransportUnavailable, prepare_zai_context, resolve_zai_max_tokens,
        run_zai_chat,
    )

    try:
        context = prepare_zai_context(dict(os.environ), default_model=model)
    except ZaiCredentialUnavailable as exc:
        raise ClaudeAuthUnavailable(f"zai_{exc.reason}: {exc}") from exc
    try:
        completed = run_zai_chat(
            context.credential, base_url=context.base_url, model=model,
            system=_ZAI_SYSTEM_PROMPT, user=prompt_text, timeout_seconds=timeout_seconds,
            max_tokens=resolve_zai_max_tokens(dict(os.environ)),
        )
    except ZaiTransportUnavailable as exc:
        raise ClaudeCliUnavailable(f"zai_transport_unavailable: {exc}") from exc
    auth_failure = None
    credit_exhaustion = None
    failure_class = None
    if completed.auth_failure is not None:
        auth_failure = {
            "marker": completed.auth_failure, "matched_marker": completed.auth_failure,
            "vendor_error_code": completed.error_code, "vendor_error_message": completed.error_message,
            "remedy": f"re-provision the Z.ai subscription key at its boundary ({context.credential.location})",
        }
        failure_class = "auth_failed"
    elif completed.credit_exhaustion is not None:
        credit_exhaustion = {
            "marker": completed.credit_exhaustion, "matched_marker": completed.credit_exhaustion,
            "vendor_error_code": completed.error_code, "vendor_error_message": completed.error_message,
        }
        failure_class = "credit_exhausted"
    elif completed.returncode != 0:
        failure_class = "process_exit"
    if usage_recording is not None and completed.usage is not None:
        _record_usage_best_effort(recording=usage_recording, model=model, usage=completed.usage)
    return ClaudeRunResult(
        returncode=completed.returncode, stdout=completed.final_message,
        stderr="" if completed.error_message is None else f"{completed.error_code}: {completed.error_message}",
        final_message=completed.final_message, usage=completed.usage,
        events=(({"type": "zai.response", "id": completed.response_id, "model": completed.model,
                  "finish_reason": completed.finish_reason, "http_status": completed.http_status},)
                if completed.response_id else ()),
        auth_failure=auth_failure, credit_exhaustion=credit_exhaustion,
        failure_class=failure_class, retryable=False if failure_class else None,
        failure_detail_code=(completed.auth_failure or completed.credit_exhaustion
                             or (None if completed.returncode == 0 else f"http_{completed.http_status}")),
        model=model,
    )


def _deliver_agent_contract(target_agent: str, repo: Path) -> Any:
    """The agent's contract, rendered for the model (ARIA-HIGH-073).

    Raised, never skipped: a run without its contract is the run that returns
    `plan` for `plan_content` and is refused after spending its tokens.
    ARIA-HIGH-146 — rendered from the KERNEL's checkout, not the workspace
    (``repo`` is kept for the call shape; the root is the kernel's).
    """
    from aria_kernel.agent_contract_delivery import AgentContractUnavailable, render_agent_contract

    try:
        return render_agent_contract(target_agent, repo_root=_kernel_checkout_root())
    except AgentContractUnavailable as exc:
        raise ClaudeCliUnavailable(f"agent_contract_unavailable: {exc}") from exc


# The Z.ai transport has no agent harness of its own: the system turn names
# the contract the executor validates, and the kernel-rendered prompt (agent
# body + envelope + inline evidence) is the user turn. Same prompt bytes as
# the CLI runtimes receive, so prompt_hash binds identically.
_ZAI_SYSTEM_PROMPT = (
    "You are an ARIA agent executed through the Z.ai transport. Follow the agent "
    "instructions in the message exactly. Your entire reply must be the single "
    "JSON object the instructions require (schema aria/agent-response/v1), with "
    "no prose before or after it."
)
_ZAI_AUTH_METHOD = "subscription_api_key"


@_dataclass(frozen=True)
class _NativeRuntimePlan:
    policy: Any
    request: dict[str, Any]
    route: dict[str, str]
    observation: dict[str, Any]
    context: Any
    admission: dict[str, Any]
    """The whole fleet decision (`_NativeRuntimeAdmission`, as a row) — every
    candidate's observation, not only the chosen route's — recorded on the
    attempt row so a skipped preferred provider is explained in the ledger."""


def _invoke_native_codex(
    *, native_runtime: _NativeRuntimePlan, repo: Path, tools_dir: Path,
    request: dict[str, Any], request_id: str, claim_id: str, agent_id: str,
    lease_token: str,
    target_agent: str, session_id: str, prompt: str, output_path: Path,
    transcript_path: Path, timeout_seconds: int, spawn_control: Any,
    signer_key_fp: str | None = None,
) -> int:
    """Use the existing CI claim/result lane with the selected Codex callback.

    ``signer_key_fp`` is the executor-held implementation identity
    (ARIA-HIGH-115), recorded on the usage row; None for a role without one.
    """
    from aria_kernel.budget import _reserve_native_runtime_attempt, price_tokens, record_cost_attribution
    from aria_kernel.tool_registry import GovernanceError, append_tools_governance
    from codex_runtime import _run_managed_codex_exec

    route = native_runtime.route
    contract = _deliver_agent_contract(target_agent, repo)
    try:
        attempt = _reserve_native_runtime_attempt(
            repo_root=repo, base_dir=tools_dir, request_id=request_id,
            request_ledger_hash=request["request_ledger_hash"], claim_id=claim_id,
            claim_ledger_hash=request["claim_ledger_hash"], session_id=session_id,
            agent_id=agent_id, lease_token=lease_token,
            attempt_id=str(_uuid.uuid4()), provider=route["provider"], runtime=route["runtime"],
            model=route["model"], requested_effort=route["effort"],
            auth_method=native_runtime.observation["auth_method"],
            expected_policy_digest=native_runtime.policy.policy_digest,
            settings_hash=native_runtime.context.settings_hash, pricing=native_runtime.observation["pricing"],
            admission=native_runtime.admission,
        )
    except GovernanceError as exc:
        raise ClaudeCliUnavailable("native_runtime_reservation_unavailable:" + str(exc)) from exc
    completed = None
    usage_row = None
    result_admission = "execution_unavailable"
    try:
        # `codex exec` takes one prompt: the contract precedes the request it
        # governs. The request bytes stay bound to prompt_hash; the contract is
        # bound to this attempt by its own hash on the finished row and envelope.
        completed = _run_managed_codex_exec(
            native_runtime.context, contract.text + "\n\n" + prompt, model=route["model"], effort=route["effort"],
            timeout_seconds=timeout_seconds, control=spawn_control,
        )
        transcript_path.parent.mkdir(parents=True, exist_ok=True)
        transcript_path.write_text(completed.stdout, encoding="utf-8")
        if completed.auth_failure is not None:
            result_admission = "auth_unavailable"
            raise ClaudeAuthFailure("Codex managed authentication unavailable")
        if completed.credit_exhaustion is not None:
            result_admission = "quota_unavailable"
            raise ClaudeCreditExhausted(
                "Codex subscription capacity unavailable", provider=route["provider"],
                model=route["model"], detail=dict(completed.credit_exhaustion),
            )
        if completed.returncode != 0:
            result_admission = "provider_nonzero"
            return completed.returncode
        envelope = _build_envelope_from_claude_output(
            raw_stdout=completed.final_message, request_id=request_id, claim_id=claim_id,
            agent_id=agent_id, role=request["role"], subagent_type=target_agent,
            must_satisfy=request.get("must_satisfy") or [], dispatch_model=route["model"],
        )
        envelope["details"]["runtime_attempt_ledger_hash"] = attempt["ledger_hash"]
        envelope["details"]["agent_contract_hash"] = contract.contract_hash
        output_path.parent.mkdir(parents=True, exist_ok=True)
        _write_sanitized_envelope(output_path, envelope)
        usage_events = [event["usage"] for event in completed.events
                        if event.get("type") == "turn.completed" and isinstance(event.get("usage"), dict)]
        if not usage_events or any(type(event.get(name)) is not int or event[name] < 0
                                   for event in usage_events for name in ("input_tokens", "output_tokens")):
            result_admission = "usage_unavailable"
            raise ClaudeCliUnavailable("codex_native_usage_unavailable")
        input_tokens = sum(event["input_tokens"] for event in usage_events)
        output_tokens = sum(event["output_tokens"] for event in usage_events)
        price = price_tokens(model=route["model"], input_tokens=input_tokens, output_tokens=output_tokens)
        if price.source == "unknown":
            # Unknown is retained as an explicit gap, never a zero cost row.
            append_tools_governance(tools_dir, "runtime_usage_pricing_unavailable", {
                "attempt_ledger_hash": attempt["ledger_hash"], "request_id": request_id,
                "model": route["model"], "input_tokens": input_tokens, "output_tokens": output_tokens,
            })
        else:
            cost_cycle_id, cost_plan_id = _cost_identity(request, request_id)
            usage_row = record_cost_attribution(
                cycle_id=cost_cycle_id, plan_id=cost_plan_id,
                agent_role=request["role"], model=route["model"], input_tokens=input_tokens,
                output_tokens=output_tokens, estimated_usd=price.usd, base_dir=tools_dir,
                signer_key_fp=signer_key_fp,
            )
        result_admission = "pending_native_submit"
        return 0
    except subprocess.TimeoutExpired as exc:
        result_admission = "timeout"
        raise ClaudeCliUnavailable("codex_native_execution_unavailable:TimeoutExpired") from exc
    except (OSError, GovernanceError) as exc:
        result_admission = "control_or_transport_unavailable"
        raise ClaudeCliUnavailable("codex_native_execution_unavailable:" + type(exc).__name__) from exc
    finally:
        thread_ids = ([] if completed is None else
                      [event["thread_id"] for event in completed.events
                       if event.get("type") == "thread.started" and isinstance(event.get("thread_id"), str)])
        append_tools_governance(tools_dir, "runtime_attempt_finished", {
            "schema_version": 1, "attempt_ledger_hash": attempt["ledger_hash"],
            "request_id": request_id, "claim_id": claim_id, "session_id": session_id,
            "provider_session_ids": thread_ids, "provider_session_provenance": "cli_thread_started",
            "exit_code": completed.returncode if completed is not None else None,
            "observed_effort": None,
            "usage_ledger_hash": usage_row["ledger_hash"] if usage_row is not None else None,
            "result_admission": result_admission,
            "agent_contract": contract.as_row(),
        })


def _invoke_native_zai(
    *, native_runtime: _NativeRuntimePlan, repo: Path, tools_dir: Path,
    request: dict[str, Any], request_id: str, claim_id: str, agent_id: str,
    lease_token: str,
    target_agent: str, session_id: str, prompt: str, output_path: Path,
    transcript_path: Path, timeout_seconds: int, spawn_control: Any,
    signer_key_fp: str | None = None,
) -> int:
    """The same CI claim/result lane, with the Z.ai HTTP transport as the callback.

    Mirrors ``_invoke_native_codex`` row for row so the attempt, transcript,
    envelope, usage and ``runtime_attempt_finished`` evidence read the same
    for every provider. Differences are the transport's: there is no process
    exit code (the HTTP status stands in), no CLI thread ids (the vendor's
    response id stands in), and no usage-events stream (the vendor's usage
    block is the one measurement). A completion whose usage the vendor did
    not report is ``usage_unavailable`` — never priced as zero.
    """
    from aria_kernel.budget import _reserve_native_runtime_attempt, price_tokens, record_cost_attribution
    from aria_kernel.tool_registry import GovernanceError, append_tools_governance
    from zai_runtime import ZaiTransportUnavailable, resolve_zai_json_object, resolve_zai_max_tokens, run_zai_chat

    route = native_runtime.route
    context = native_runtime.context
    contract = _deliver_agent_contract(target_agent, repo)
    try:
        attempt = _reserve_native_runtime_attempt(
            repo_root=repo, base_dir=tools_dir, request_id=request_id,
            request_ledger_hash=request["request_ledger_hash"], claim_id=claim_id,
            claim_ledger_hash=request["claim_ledger_hash"], session_id=session_id,
            agent_id=agent_id, lease_token=lease_token,
            attempt_id=str(_uuid.uuid4()), provider=route["provider"], runtime=route["runtime"],
            model=route["model"], requested_effort=route["effort"],
            auth_method=native_runtime.observation["auth_method"],
            expected_policy_digest=native_runtime.policy.policy_digest,
            settings_hash=context.settings_hash, pricing=native_runtime.observation["pricing"],
            admission=native_runtime.admission,
        )
    except GovernanceError as exc:
        raise ClaudeCliUnavailable("native_runtime_reservation_unavailable:" + str(exc)) from exc
    completed = None
    usage_row = None
    result_admission = "execution_unavailable"
    try:
        if spawn_control is not None and spawn_control.should_cancel():
            result_admission = "operator_cancelled_before_call"
            return 1
        completed = run_zai_chat(
            context.credential, base_url=context.base_url, model=route["model"],
            system=_ZAI_SYSTEM_PROMPT + "\n\n" + contract.text, user=prompt, timeout_seconds=timeout_seconds,
            max_tokens=resolve_zai_max_tokens(dict(os.environ)), reasoning_effort=route["effort"],
            json_object=resolve_zai_json_object(dict(os.environ)),
        )
        transcript_path.parent.mkdir(parents=True, exist_ok=True)
        transcript_path.write_text(completed.raw_body.decode("utf-8", errors="replace"), encoding="utf-8")
        if completed.auth_failure is not None:
            result_admission = "auth_unavailable"
            raise ClaudeAuthFailure("Z.ai subscription authentication unavailable")
        if completed.credit_exhaustion is not None:
            result_admission = "quota_unavailable"
            raise ClaudeCreditExhausted(
                "Z.ai subscription capacity unavailable", provider=route["provider"],
                model=route["model"],
                detail={"marker": completed.credit_exhaustion, "vendor_error_code": completed.error_code,
                        "vendor_error_message": completed.error_message, "http_status": completed.http_status},
            )
        if completed.returncode != 0:
            result_admission = ("output_budget_exhausted" if completed.finish_reason == "length"
                                else "provider_nonzero")
            return completed.returncode
        envelope = _build_envelope_from_claude_output(
            raw_stdout=completed.final_message, request_id=request_id, claim_id=claim_id,
            agent_id=agent_id, role=request["role"], subagent_type=target_agent,
            must_satisfy=request.get("must_satisfy") or [], dispatch_model=route["model"],
        )
        envelope["details"]["runtime_attempt_ledger_hash"] = attempt["ledger_hash"]
        envelope["details"]["agent_contract_hash"] = contract.contract_hash
        output_path.parent.mkdir(parents=True, exist_ok=True)
        _write_sanitized_envelope(output_path, envelope)
        if completed.usage is None:
            result_admission = "usage_unavailable"
            raise ClaudeCliUnavailable("zai_native_usage_unavailable")
        input_tokens = completed.usage["input_tokens"]
        output_tokens = completed.usage["output_tokens"]
        price = price_tokens(model=route["model"], input_tokens=input_tokens, output_tokens=output_tokens)
        if price.source == "unknown":
            append_tools_governance(tools_dir, "runtime_usage_pricing_unavailable", {
                "attempt_ledger_hash": attempt["ledger_hash"], "request_id": request_id,
                "model": route["model"], "input_tokens": input_tokens, "output_tokens": output_tokens,
            })
        else:
            cost_cycle_id, cost_plan_id = _cost_identity(request, request_id)
            usage_row = record_cost_attribution(
                cycle_id=cost_cycle_id, plan_id=cost_plan_id,
                agent_role=request["role"], model=route["model"], input_tokens=input_tokens,
                output_tokens=output_tokens, estimated_usd=price.usd, base_dir=tools_dir,
                signer_key_fp=signer_key_fp,
            )
        result_admission = "pending_native_submit"
        return 0
    except ZaiTransportUnavailable as exc:
        result_admission = "transport_unavailable"
        raise ClaudeCliUnavailable("zai_native_execution_unavailable:" + str(exc)) from exc
    except (OSError, GovernanceError) as exc:
        result_admission = "control_or_transport_unavailable"
        # The kernel's own refusal text is a named reason, never vendor or
        # credential material; carry it so the operator sees the cause.
        raise ClaudeCliUnavailable(f"zai_native_execution_unavailable:{type(exc).__name__}:{exc}") from exc
    finally:
        append_tools_governance(tools_dir, "runtime_attempt_finished", {
            "schema_version": 1, "attempt_ledger_hash": attempt["ledger_hash"],
            "request_id": request_id, "claim_id": claim_id, "session_id": session_id,
            "provider_session_ids": ([] if completed is None or completed.response_id is None
                                     else [completed.response_id]),
            "provider_session_provenance": "http_response_id",
            "exit_code": completed.http_status if completed is not None else None,
            "observed_effort": None,
            "usage_ledger_hash": usage_row["ledger_hash"] if usage_row is not None else None,
            "result_admission": result_admission,
            "agent_contract": contract.as_row(),
        })


_NATIVE_CLAUDE_ADMISSION_UNNAMED = "execution_unavailable"


def _result_admission_for(exc: BaseException, current: str) -> str:
    """The attempt row's ``result_admission`` after ``exc`` ended the run.

    ARIA-HIGH-161 — the wrapper names ``usage_unavailable`` (a finished run
    whose envelope carries no usage) BEFORE it raises, and the handler used
    to overwrite that name with the exception family's generic
    ``control_or_transport_unavailable``: the attempt row read "transport"
    for a run whose transport had answered. A name the wrapper already gave
    stands; only the unnamed default is classified by exception type.
    """
    if current != _NATIVE_CLAUDE_ADMISSION_UNNAMED:
        return current
    return {
        ClaudeAuthFailure: "auth_unavailable", ClaudeCreditExhausted: "quota_unavailable",
        subprocess.TimeoutExpired: "timeout",
    }.get(type(exc), "control_or_transport_unavailable")


def _invoke_native_claude(
    *, native_runtime: _NativeRuntimePlan, repo: Path, tools_dir: Path,
    request: dict[str, Any], request_id: str, claim_id: str, agent_id: str,
    lease_token: str,
    target_agent: str, session_id: str, prompt: str, output_path: Path,
    transcript_path: Path, timeout_seconds: int, spawn_control: Any,
    prompt_file: Path, resume: bool, signer_key_fp: str | None = None,
    git_containment: Any | None = None,
) -> int:
    """The managed Anthropic session on the native lane.

    The spawn is the existing `invoke_claude_cli` — agent_env build, bwrap
    containment, cancel polling, contract prefix, sealed envelope, per-call
    usage attribution — so nothing about how a Claude agent runs changes.
    What this adds is the native evidence the other routes carry: a reserved
    attempt bound to the admission's settings identity, and a finished row
    naming the session, the exit, the usage row and the contract hash.
    """
    from aria_kernel.budget import _reserve_native_runtime_attempt, read_cost_attribution
    from aria_kernel.tool_registry import GovernanceError, append_tools_governance

    route = native_runtime.route
    try:
        attempt = _reserve_native_runtime_attempt(
            repo_root=repo, base_dir=tools_dir, request_id=request_id,
            request_ledger_hash=request["request_ledger_hash"], claim_id=claim_id,
            claim_ledger_hash=request["claim_ledger_hash"], session_id=session_id,
            agent_id=agent_id, lease_token=lease_token,
            attempt_id=str(_uuid.uuid4()), provider=route["provider"], runtime=route["runtime"],
            model=route["model"], requested_effort=route["effort"],
            auth_method=native_runtime.observation["auth_method"],
            expected_policy_digest=native_runtime.policy.policy_digest,
            settings_hash=native_runtime.context.settings_hash, pricing=native_runtime.observation["pricing"],
            admission=native_runtime.admission,
        )
    except GovernanceError as exc:
        raise ClaudeCliUnavailable("native_runtime_reservation_unavailable:" + str(exc)) from exc
    cli_exit: int | None = None
    result_admission = _NATIVE_CLAUDE_ADMISSION_UNNAMED
    usage_row_hash: str | None = None
    contract_row: dict[str, Any] | None = None
    try:
        cli_exit = invoke_claude_cli(
            request_id=request_id, subagent_type=target_agent, session_id=session_id, resume=resume,
            prompt_file=prompt_file, output_path=output_path, transcript_path=transcript_path,
            timeout_seconds=timeout_seconds, claim_id=claim_id, agent_id=agent_id,
            role=request["role"], must_satisfy=request.get("must_satisfy") or [],
            request_envelope=request, tools_dir=tools_dir, spawn_control=spawn_control,
            signer_key_fp=signer_key_fp, git_containment=git_containment,
        )
        if cli_exit != 0:
            result_admission = "provider_nonzero"
            return cli_exit
        if output_path.is_file():
            envelope = json.loads(output_path.read_text(encoding="utf-8"))
            details = envelope.get("details") if isinstance(envelope, dict) else None
            if isinstance(details, dict):
                envelope.setdefault("details", {})["runtime_attempt_ledger_hash"] = attempt["ledger_hash"]
                _write_sanitized_envelope(output_path, envelope)
                contract_hash = details.get("agent_contract_hash")
                contract_row = {"agent_contract_hash": contract_hash} if contract_hash else None
                if not isinstance(details.get("claude_cli_usage"), dict):
                    result_admission = "usage_unavailable"
                    raise ClaudeCliUnavailable("claude_native_usage_unavailable")
        cycle_id = request.get("cycle_id")
        for row in reversed(read_cost_attribution(base_dir=tools_dir)):
            if row.get("cycle_id") == cycle_id and row.get("agent_role") == request.get("role"):
                usage_row_hash = row.get("ledger_hash")
                break
        result_admission = "pending_native_submit"
        return 0
    except Exception as exc:
        # Classification only, by type: the ONE handler that releases the
        # claim on an auth failure lives in the executor's main body and
        # stays the only `except ClaudeAuthFailure` in this module.
        result_admission = _result_admission_for(exc, result_admission)
        raise
    finally:
        append_tools_governance(tools_dir, "runtime_attempt_finished", {
            "schema_version": 1, "attempt_ledger_hash": attempt["ledger_hash"],
            "request_id": request_id, "claim_id": claim_id, "session_id": session_id,
            "provider_session_ids": [session_id], "provider_session_provenance": "claude_session_id",
            "exit_code": cli_exit, "observed_effort": None,
            "usage_ledger_hash": usage_row_hash, "result_admission": result_admission,
            **({"agent_contract": contract_row} if contract_row else {}),
        })


def _accepted_native_runtime_result(
    *, tools_dir: Path, request_id: str, claim_id: str, agent_id: str,
    session_id: str, policy_digest: str,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Join native acceptance to the sealed output and original attempt rows."""
    from aria_kernel import agent_invocations as invocations
    from aria_kernel.ledger import load_declared_jsonl
    from aria_kernel.tool_registry import GovernanceError

    requests = invocations.list_agent_invocation_requests(request_id=request_id, base_dir=tools_dir)
    if len(requests) != 1:
        raise GovernanceError("native_runtime_result_request_unavailable")
    request = requests[0]
    accepted = invocations.accepted_result_for_request(
        request_id=request_id, role=request["role"], base_dir=tools_dir,
    )
    if accepted is None or accepted.get("claim_id") != claim_id or accepted.get("agent_id") != agent_id:
        raise GovernanceError("native_runtime_result_acceptance_unavailable")
    if any(accepted.get(name) != request.get(name) for name in ("target_sha", "context_hash", "prompt_hash")):
        raise GovernanceError("native_runtime_result_request_evidence_unavailable")
    sealed_path = invocations.resolve_output_artifact_path(tools_dir, accepted["output_path"])
    invocations._assert_submission_artifact_path_safe(tools_dir, sealed_path)
    content = invocations._read_stable_submission_artifact(sealed_path)
    digest = "sha256:" + hashlib.sha256(content).hexdigest()
    if digest != accepted.get("output_hash") or digest != accepted.get("content_hash"):
        raise GovernanceError("native_runtime_result_sealed_hash_unavailable")
    envelope = json.loads(content)
    if (not isinstance(envelope, dict) or envelope.get("request_id") != request_id
            or envelope.get("claim_id") != claim_id or envelope.get("agent_id") != agent_id
            or envelope.get("role") != request["role"] or not isinstance(envelope.get("details"), dict)):
        raise GovernanceError("native_runtime_result_envelope_binding_unavailable")
    claims = load_declared_jsonl(tools_dir / "agent-invocations/claims.jsonl",
                                expected_surface="agent_invocation_claims")
    original_claims = [row for row in claims if row.get("event") == "claimed"
                       and row.get("claim_id") == claim_id and row.get("agent_id") == agent_id
                       and row.get("request_id") == request_id]
    if len(original_claims) != 1:
        raise GovernanceError("native_runtime_result_claim_unavailable")
    governance = load_declared_jsonl(tools_dir / "governance.jsonl", expected_surface="tools_governance")
    attempts = [row for row in governance if row.get("kind") == "runtime_attempt_started"
                and row.get("ledger_hash") == envelope["details"].get("runtime_attempt_ledger_hash")]
    if len(attempts) != 1:
        raise GovernanceError("native_runtime_result_attempt_unavailable")
    attempt = attempts[0]
    required = {"request_id": request_id, "request_ledger_hash": request["ledger_hash"],
                "claim_id": claim_id, "claim_ledger_hash": original_claims[0]["ledger_hash"],
                "agent_id": agent_id, "session_id": session_id, "policy_digest": policy_digest}
    if any(attempt["details"].get(name) != value for name, value in required.items()):
        raise GovernanceError("native_runtime_result_attempt_binding_unavailable")
    return accepted, attempt


def _native_task_binding_refusal(*, repo_root: Path, tools_dir: Path, request: dict[str, Any]) -> str | None:
    """Observe the actual checkout through existing binding and Git owners.

    None when the checkout IS the request's task root at its anchor;
    otherwise the named reason (``task_root_binding_unavailable`` /
    ``target_revision_unavailable`` / ``target_revision_mismatch``), recorded
    as a governance row and carried into the child's summary by the caller.
    A worktree of the bound repository passes the identity check (the
    binding compares git common directories), which is what lets the drain
    serve each request in a worktree at its own anchor.

    ARIA-HIGH-144 — the anchor is the kernel's ``request_anchor_sha``:
    ``target_sha``, or the staged ``implementation_ids.base_sha`` for an
    implementation envelope, which carried no ``target_sha``. This binding
    read ``target_sha`` alone, so under the operator's adaptive policy (B8)
    every implementation request was ``target_revision_unavailable`` — the
    drain had already added its worktree at ``base_sha`` (ARIA-HIGH-124)
    and the child refused the tree it was standing in.
    """
    from aria_kernel.agent_invocations import _git_probe, request_anchor_sha
    from aria_kernel.evidence_probe import GitProbeSession
    from aria_kernel.state_store import _valid_host_identity
    from aria_kernel.tool_registry import append_tools_governance
    from aria_kernel.workspace import canonical_identity

    reason = None
    observed_head = None
    anchor = request_anchor_sha(request)
    if not _valid_host_identity(tools_dir, canonical_identity(repo_root), repo_root):
        reason = "task_root_binding_unavailable"
    else:
        # The kernel's own bounded, retried probe (ARIA-HIGH-109): a git that
        # does not answer is `target_revision_unavailable` by name with the
        # probe's reason, never a 5 s guess read as "no HEAD".
        head = _git_probe(repo_root, "rev-parse", "HEAD", probes=GitProbeSession())
        observed_head = head.stdout or None
        if head.ok is None:
            reason = f"target_revision_unavailable:{head.unavailable_reason}"
        elif not head.ok or not anchor:
            reason = "target_revision_unavailable"
        elif observed_head != anchor:
            reason = "target_revision_mismatch"
    if reason is None:
        return None
    append_tools_governance(tools_dir, "runtime_task_binding_unavailable", {
        "schema_version": 1, "request_id": request["request_id"],
        "request_ledger_hash": request["ledger_hash"], "target_sha": anchor,
        "anchor_source": ("target_sha" if request.get("target_sha") else
                          "implementation_ids.base_sha" if anchor else None),
        "observed_head_sha": observed_head, "reason": reason,
    })
    return reason


@_dataclass(frozen=True)
class _AdmissionRefusalKind:
    """Everything one kind of pre-spawn refusal says about itself, in one
    record: the claims-ledger reason the claim is released under, and the
    summary class/retryability the child writes. One record per kind so
    the two vocabularies cannot be declared apart and disagree (a stalled
    host released as a harness fault but summarised as a non-retryable
    policy violation was the shape the verifier found — twice: the fleet's
    halted admissions, ARIA-HIGH-107, and the identity refusal,
    ARIA-HIGH-115). Every record is a module-level literal the release-site
    invariant reads (`tests/_helpers/release_sites.REFUSAL_TABLE_NAMES`)."""

    release_reason: str
    failure_class: str
    retryable: bool


# The refusal each fleet outcome hands back, keyed by the fleet's own closed
# vocabulary so a new outcome cannot reach `_main` without naming its
# release AND its summary shape (a missing key is a KeyError at refusal
# time; `test_native_admission_undecided` pins keys == non-admitted
# outcomes). Every release reason here is harness-class (`release_reason`,
# `agent_invocations`): none says anything about the request, so its
# requeue budget stands. The two halted admissions — `provider_undecided`
# (a stalled probe) and `provider_control_unavailable` (this host could not
# bind the route's controls) — are their own reasons, not the fleet
# declining, so a reader of the claims ledger can tell the three apart
# (ARIA-HIGH-107); their summaries are `harness_unavailable` and retryable,
# because the daemon retries them after a back-off and the drain must not
# read them as a policy the dispatch violated.
ADMISSION_REFUSALS: dict[str, _AdmissionRefusalKind] = {
    "provider_undecided": _AdmissionRefusalKind(
        release_reason="native_runtime_provider_undecided",
        failure_class="harness_unavailable", retryable=True,
    ),
    "provider_control_unavailable": _AdmissionRefusalKind(
        release_reason="native_runtime_control_unavailable",
        failure_class="harness_unavailable", retryable=True,
    ),
    "no_eligible_provider": _AdmissionRefusalKind(
        release_reason="native_runtime_admission_unavailable",
        failure_class="policy_violation", retryable=False,
    ),
}
# A task-binding refusal (`_native_task_binding_refusal`) is not a fleet
# outcome; it releases under the admission's general reason as before and
# summarises as the executor's own policy.
TASK_BINDING_REFUSAL = _AdmissionRefusalKind(
    release_reason="native_runtime_admission_unavailable",
    failure_class="policy_violation", retryable=False,
)
# ARIA-HIGH-115 — the implementer's signing identity could not be held in
# the tree this child runs in (`aria_kernel.implementation_identity`): the
# shared checkout instead of a per-request worktree, an unwirable git, no
# ssh-keygen, a refused registry write. Every cause is the lane's or the
# host's, so the release is harness-class (the request returns to PENDING
# with its requeue budget intact) AND the summary says so — a harness
# refusal summarised as a non-retryable policy violation is the
# two-vocabularies defect `_AdmissionRefusalKind` exists to prevent. The
# literal is the kernel's `release_reason.IMPLEMENTATION_SIGNING_UNAVAILABLE`
# (pinned equal in `tests/test_implementation_identity_hold.py`), spelled
# here so the release-site invariant reads it from this module's AST like
# the tables above (`tests/_helpers/release_sites.REFUSAL_TABLE_NAMES`).
IMPLEMENTATION_IDENTITY_REFUSAL = _AdmissionRefusalKind(
    release_reason="implementation_signing_unavailable",
    failure_class="harness_unavailable", retryable=True,
)
# ARIA-HIGH-124 — the executor delivers the implementation itself (gate,
# push, PR) after the spawn; three refusals belong to that, each spelled
# by the kernel's `release_reason` (pinned equal in
# `tests/test_implementation_delivery.py`) and read from this module's AST
# by the release-site invariant like the tables above:
# * the delivery credential could not be minted — the lane's state (no GH
#   App, no PAT, a refused installation), harness-class, retried after a
#   back-off: decided before the spawn by the credential ADMISSION (one
#   lease minted and revoked, no turn spent) and again where the lease is
#   consumed (round 6: the delivery's `credential` stage, after the gate);
# * the shared repository already holds this request's `aria-impl-*`
#   branch (an earlier attempt published it) — refused before a turn,
#   request-class: a retry cannot stand on it, a person decides;
# * the delivery refused (the gate blocked, the push failed, the PR
#   opener refused) — request-class; the published branch makes a retry
#   collide, so the request is escalated;
# * (round 2) the request row carries no usable `implementation_ids` — no
#   `aria-impl-*` branch name, no object id for `base_sha` — the REQUEST's
#   facts, request-class: released harness-class it was re-claimed after
#   every back-off without bound and never spent a turn or escalated.
DELIVERY_CREDENTIAL_REFUSAL = _AdmissionRefusalKind(
    release_reason="implementation_delivery_unavailable",
    failure_class="harness_unavailable", retryable=True,
)
# (round 3) the same harness-class release for the delivery's ADMISSION:
# the job's remaining window (`ARIA_JOB_DEADLINE_EPOCH`) cannot hold the
# delivery's worst case, or the validation sandbox cannot be built for the
# staged suite on this host (`implementation_delivery.delivery_admission_refusal`).
# Decided before the spawn (no turn spent) and again before the quarantine
# is published (the agent's commit is discarded rather than published as
# a branch its retry would collide with); the request keeps its budget and
# the governance row of the release's name carries the cause.
DELIVERY_WINDOW_REFUSAL = _AdmissionRefusalKind(
    release_reason="implementation_delivery_unavailable",
    failure_class="harness_unavailable", retryable=True,
)
IMPLEMENTATION_BRANCH_COLLISION_REFUSAL = _AdmissionRefusalKind(
    release_reason="implementation_branch_collision",
    failure_class="policy_violation", retryable=False,
)
IMPLEMENTATION_REQUEST_INVALID_REFUSAL = _AdmissionRefusalKind(
    release_reason="implementation_request_invalid",
    failure_class="policy_violation", retryable=False,
)
# The `stand_on_implementation_branch` refusals that are the REQUEST's facts
# (the row's branch name / base sha), read by the branch step below to pick
# `IMPLEMENTATION_REQUEST_INVALID_REFUSAL`; every other refusal of that step
# but the collision is the containment's shape (harness-class).
IMPLEMENTATION_REQUEST_INVALID_CONTAINMENT_REASONS: frozenset[str] = frozenset({
    "implementation_branch_name_invalid", "base_sha_not_an_object_id",
})


@_dataclass(frozen=True)
class _NativeAdmissionRefusal:
    """The native admission declined to dispatch, by name.

    Built only by ``_refuse_native_admission``, which has already written the
    child's ``refused`` summary carrying ``reason`` in the shape its
    ``kind`` declares; ``_main`` returns ``exit_code`` and nothing else, so
    no admission refusal can leave the child without a summary (the
    2026-09-04 → 2026-09-12 false-green class). ``release_reason`` is the
    claims-ledger reason ``_main`` releases an inherited claim under — set
    by the constructor from the refusal's own kind, never chosen at the
    release site.
    """

    reason: str
    exit_code: int
    release_reason: str


def _refuse_native_admission(
    *, request: dict[str, Any], reason: str, kind: _AdmissionRefusalKind,
) -> _NativeAdmissionRefusal:
    return _NativeAdmissionRefusal(
        reason=reason,
        exit_code=_refuse_dispatch(
            request=request, request_id=str(request["request_id"]),
            target_agent=str(request["target_agent"]), reason=reason,
            failure_class=kind.failure_class, retryable=kind.retryable,
        ),
        release_reason=kind.release_reason,
    )


def _admit_native_route(
    *, repo_root: Path, tools_dir: Path, request_id: str, request: dict[str, Any], target_agent: str,
    policy: Any, policy_root: Path, _runtime_stack: _ExitStack | None,
) -> tuple[Any, dict[str, Any]]:
    """Probe the fleet ONCE for this profile and return ``(admission, contexts)``.

    Typed-judgment plan Phase 4a (ARIA-MEDIUM-163) — the fleet probe, the
    managed contexts and the admission row are a property of the profile
    and the host, not of one request: a batch child admits its route once
    and binds K requests to it (`_bind_request_to_route`). ``request`` and
    ``request_id`` name the identity the managed Claude context records
    usage under; for a batch the caller passes the batch's own identity.
    """
    from aria_kernel.agent_runtime_profile import read_agent_runtime_profile
    from aria_kernel.model_fleet import Provider
    from aria_kernel.native_admission import _native_runtime_admission
    from aria_kernel.status_probe import StatusDecision, _RuntimeStatusObservation
    from aria_kernel.tool_registry import GovernanceError

    profile = read_agent_runtime_profile(target_agent, repo_root=_kernel_checkout_root())
    environment = dict(os.environ)
    contexts: dict[str, Any] = {}

    def observe_status(provider: Provider, timeout_seconds: float) -> _RuntimeStatusObservation:
        if provider.runtime_hint == "codex":
            from codex_runtime import _probe_codex_auth_status

            if policy.monetary_admission == "managed_subscription":
                from codex_runtime import ManagedCodexRouteUnavailable, _prepare_managed_codex_context
                from aria_kernel.implementation_safety import SandboxUnavailable, ResourceLimitsUnavailable

                if _runtime_stack is None:
                    raise GovernanceError("native_runtime_lifetime_owner_unavailable")
                status_deadline = time.monotonic() + timeout_seconds
                directory = _runtime_stack.enter_context(_tempfile.TemporaryDirectory(prefix="aria-native-codex-"))
                try:
                    context = _prepare_managed_codex_context(
                        workspace=repo_root, runtime_directory=Path(directory), environment=environment, profile=profile,
                    )
                except ManagedCodexRouteUnavailable as exc:
                    # DECIDED before any probe: the route cannot serve this
                    # dispatch — no managed session credential on this
                    # host (the CLI would answer "Not logged in"), no CLI,
                    # or a profile that needs controls the native Codex
                    # route does not grant. A fleet/auth fact the ladder
                    # may pass, by name, exactly as `cli_unavailable` and
                    # `provider_readonly_runtime` are.
                    return _RuntimeStatusObservation(exc.auth_observation, reason=exc.reason,
                                                     control_status="unavailable", control_reason=exc.reason,
                                                     decision=StatusDecision.UNAVAILABLE)
                except (OSError, SandboxUnavailable, ResourceLimitsUnavailable) as exc:
                    # This host could not bind the managed context (no
                    # usable containment, no limiter, an EAGAIN under a
                    # fork storm), so the vendor was never asked: auth
                    # UNDECIDED, controls UNAVAILABLE. The fleet retries
                    # within its bound (the transient shape heals) and
                    # otherwise halts the ladder as
                    # `provider_control_unavailable` — the same host fault
                    # the Claude arm names `sandbox_unavailable`, answered
                    # the same way: never a later vendor.
                    return _RuntimeStatusObservation("unknown", reason=type(exc).__name__,
                                                     control_status="unavailable", control_reason=str(exc),
                                                     decision=StatusDecision.UNDECIDED)
                observed = _probe_codex_auth_status(
                    environ=context.environment, timeout_seconds=status_deadline - time.monotonic(),
                    _wrap_command=lambda argv: context.wrap(argv, max(1, int(status_deadline - time.monotonic()))),
                )
                contexts[provider.key] = context
                if observed.control_status == "unavailable":
                    return observed
                return _replace(observed, control_status="available", control_reason="native_readonly_runtime_prepared")
            return _probe_codex_auth_status(environ=environment, timeout_seconds=timeout_seconds)
        if provider.runtime_hint == "claude":
            # The managed Anthropic session: `claude auth status --json` is the
            # non-model status the CLI itself reports (authMethod claude.ai =
            # subscription); control is the existing bwrap containment that
            # every Claude spawn already runs under. The spawn stays
            # run_claude_exec; this only admits it natively and binds the
            # attempt to the same settings identity the session fingerprint uses.
            from aria_kernel.implementation_safety import sandbox_backend as _sandbox_backend_probe
            from claude_runtime import ManagedClaudeContext, _probe_claude_auth_status

            observed = _probe_claude_auth_status(environ=environment, timeout_seconds=timeout_seconds)
            if observed.decision is not StatusDecision.AVAILABLE:
                return observed
            if _sandbox_backend_probe() is None:
                # The vendor said yes; THIS host cannot contain the spawn.
                # Controls unavailable on a decided-available auth: the
                # ladder halts here as `provider_control_unavailable`
                # (never a later vendor — a missing sandbox is not an auth
                # reason), and the row says which host fact stopped it.
                return _replace(observed, control_status="unavailable", control_reason="sandbox_unavailable")
            recording = UsageRecording(request_id=request_id, role=str(request.get("role") or ""),
                                       target_agent=target_agent, base_dir=tools_dir)
            contexts[provider.key] = ManagedClaudeContext(
                auth_method=observed.auth_method, subscription_type=None,
                config_dir=environment.get("CLAUDE_CONFIG_DIR"),
                settings_hash=spawn_settings_hash(agent_profile=profile, usage_recording=recording,
                                                  workspace_root=repo_root),
            )
            return _replace(observed, control_status="available", control_reason="native_write_containment_prepared")
        if provider.runtime_hint == "zai":
            # The kernel's own HTTP transport (operator policy 2026-09-11):
            # the credential is read from its boundary here, held in the
            # context, and the status is what ONE minimal completion against
            # the operator-selected endpoint actually returned. No CLI, no
            # redirect, no value in any row.
            from zai_runtime import ZaiCredentialUnavailable, ZaiTransportUnavailable, prepare_zai_context, probe_zai_status

            try:
                context = prepare_zai_context(environment, default_model=provider.default_model)
            except ZaiCredentialUnavailable as exc:
                # The credential boundary refused (absent, unreadable,
                # wrong mode, ambiguous): a host fact, DECIDED.
                return _RuntimeStatusObservation("unavailable", reason=exc.reason,
                                                 control_status="unavailable", control_reason=str(exc),
                                                 auth_method=_ZAI_AUTH_METHOD, decision=StatusDecision.UNAVAILABLE)
            try:
                observed = probe_zai_status(
                    context.credential, endpoint=context.endpoint, base_url=context.base_url,
                    model=context.model, timeout_seconds=timeout_seconds,
                )
            except ZaiTransportUnavailable as exc:
                # The request did not complete (timeout, DNS, connection):
                # the vendor was not heard — the stall class, UNDECIDED and
                # retried within the bound. The transport WAS prepared
                # (credential read, endpoint chosen); what this attempt
                # established about it is nothing, so controls stay
                # "unknown" with the transport error as the reason — not
                # "unavailable", which names a host that could not bind
                # its controls and halts the ladder by that name.
                return _RuntimeStatusObservation("unknown", reason=str(exc), control_status="unknown",
                                                 control_reason=str(exc),
                                                 auth_method=_ZAI_AUTH_METHOD,
                                                 credential_source=context.credential.source,
                                                 decision=StatusDecision.UNDECIDED)
            contexts[provider.key] = context
            return _RuntimeStatusObservation(
                observed.auth_observation, quota_observation=observed.quota_observation,
                reason=observed.reason, command=(), exit_code=observed.http_status,
                control_status="available", control_reason="native_http_transport_prepared",
                auth_method=_ZAI_AUTH_METHOD, credential_source=context.credential.source,
                decision=observed.decision,
            )
        # The legacy version/file preflight is not supported native auth proof.
        # Its unchanged caller remains the omitted-policy path below.
        return _RuntimeStatusObservation("unknown", reason="supported_auth_status_unavailable",
                                         decision=StatusDecision.UNDECIDED)

    from aria_kernel.provider_cooldown import active_provider_cooldowns

    admission = _native_runtime_admission(
        repo_root=policy_root, profile=profile, policy=policy, environ=environment,
        observe_status=observe_status,
        # The exhausted-provider memory: a provider cooled by a previous
        # attempt's ClaudeCreditExhausted is refused here without a probe.
        cooled_providers=active_provider_cooldowns(tools_dir),
    )
    return admission, contexts


def _bind_request_to_route(
    *, tools_dir: Path, request_id: str, request: dict[str, Any], policy: Any,
    admission: Any, contexts: dict[str, Any],
) -> _NativeRuntimePlan | _NativeAdmissionRefusal:
    """One request against an admission: the plan on its route, or the
    NAMED refusal (row + summary) when nothing was admitted."""
    from aria_kernel.native_admission import AdmissionOutcome
    from aria_kernel.tool_registry import append_tools_governance

    if admission.outcome is AdmissionOutcome.ADMITTED:
        route = admission.eligible_routes[0]
        observation = next(row for row in admission.candidate_observations if row["provider"] == route["provider"])
        return _NativeRuntimePlan(policy, request, route, observation, contexts[route["provider"]],
                                  admission.as_row())
    # Not admitted: `no_eligible_provider` (every provider decided, none
    # eligible), `provider_undecided` (the first provider in contention
    # never answered) or `provider_control_unavailable` (it was not refused
    # but this host could not bind its controls) — ARIA-HIGH-107: for the
    # two halts no attempt is burned, nothing behind the halting provider
    # runs, the request waits for a later tick. The row names which and
    # whom, and the refusal releases an inherited claim under the matching
    # harness-class reason with the summary shape its kind declares.
    append_tools_governance(tools_dir, "runtime_admission_unavailable", {
        "schema_version": 1, "policy_id": policy.policy_id,
        "policy_digest": policy.policy_digest,
        "configuration_digest": admission.configuration_digest,
        "policy_sources": {"default_sha256": policy.default_sha256,
                           "override_sha256": policy.override_sha256},
        "profile_source_bytes": {"status": "unknown", "reason": "resolved_profile_has_no_source_byte_receipt"},
        "request_id": request_id, "request_ledger_hash": request["ledger_hash"],
        "role": request["role"], "target_agent": request["target_agent"],
        "context_hash": request["context_hash"], "prompt_hash": request["prompt_hash"],
        "reason": admission.outcome.value, "halting_provider": admission.halting_provider,
        "eligible_routes": [],
        "candidate_observations": list(admission.candidate_observations),
    })
    return _refuse_native_admission(
        request=request, reason=admission.outcome.value, kind=ADMISSION_REFUSALS[admission.outcome.value],
    )




def _adaptive_pre_claim_admission(
    *, repo_root: Path, tools_dir: Path, request_id: str, target_agent: str,
    _runtime_stack: _ExitStack | None = None,
    _inherited_claim: dict[str, Any] | None = None, _lease_token: str | None = None,
) -> _NativeRuntimePlan | _NativeAdmissionRefusal | None:
    """Record opt-in native unavailability before any lease is consumed.

    None when no adaptive policy is declared (the legacy spawn path); a plan
    when a route is admitted; a NAMED refusal — summary already written —
    when the task binding or the fleet declines. Never a bare exit code.
    """
    from aria_kernel.agent_invocations import derive_request_state, list_agent_invocation_requests
    from aria_kernel.genesis_policy import _adaptive_runtime_policy
    from aria_kernel.tool_registry import GovernanceError

    policy_root = _operator_policy_root(tools_dir)
    policy = _adaptive_runtime_policy(policy_root)
    if policy is None:
        return None
    requests = list_agent_invocation_requests(request_id=request_id, base_dir=tools_dir)
    if len(requests) != 1 or requests[0].get("target_agent") != target_agent:
        raise GovernanceError("adaptive_runtime_request_binding_unavailable")
    request = requests[0]
    if _inherited_claim is not None:
        from aria_kernel import agent_invocations as invocations
        from aria_kernel.ledger import state_transaction

        request_path = tools_dir / "agent-invocations/requests.jsonl"
        claims_path = tools_dir / "agent-invocations/claims.jsonl"
        results_path = tools_dir / "agent-invocations/results.jsonl"
        with state_transaction([request_path, claims_path, results_path]) as transaction:
            invocations._validate_claim_dispatch_authority(
                requests=transaction.load_declared_jsonl(request_path, expected_surface="agent_invocation_requests"),
                claims=transaction.load_declared_jsonl(claims_path, expected_surface="agent_invocation_claims"),
                results=transaction.load_declared_jsonl(results_path, expected_surface="agent_invocation_results"),
                request_id=request_id, request_ledger_hash=_inherited_claim["request_ledger_hash"],
                claim_id=_inherited_claim["claim_id"], claim_ledger_hash=_inherited_claim["claim_ledger_hash"],
                agent_id=_inherited_claim["agent_id"], lease_token=_lease_token or "",
                now=invocations._utc_now_dt(),
            )
    elif derive_request_state(request_id=request_id, base_dir=tools_dir) not in ("PENDING", "REQUEUED"):
        raise GovernanceError("adaptive_runtime_request_not_pending")
    if policy.monetary_admission == "managed_subscription":
        binding_refusal = _native_task_binding_refusal(repo_root=repo_root, tools_dir=tools_dir, request=request)
        if binding_refusal is not None:
            return _refuse_native_admission(request=request, reason=binding_refusal, kind=TASK_BINDING_REFUSAL)
    admission, contexts = _admit_native_route(
        repo_root=repo_root, tools_dir=tools_dir, request_id=request_id, request=request,
        target_agent=target_agent, policy=policy, policy_root=policy_root, _runtime_stack=_runtime_stack,
    )
    return _bind_request_to_route(
        tools_dir=tools_dir, request_id=request_id, request=request, policy=policy,
        admission=admission, contexts=contexts,
    )


def _node_modules_resolvable_from(workspace: Path) -> bool:
    """Can a validation command run from ``workspace`` find its modules?

    Node resolves a bare import by walking UP from the cwd, so the question
    is "does any ancestor carry node_modules", not "does the cwd". A drain
    child in a per-request worktree (B8: `<checkout>/aria-worktrees/req-x`)
    has none of its own and resolves the checkout's — measured with
    require.resolve and `npx --no-install` from a nested worktree.
    """
    return any((ancestor / "node_modules").is_dir() for ancestor in (workspace.resolve(), *workspace.resolve().parents))


def _git_availability_gap(session: Any, *, workspace: Path) -> str | None:
    """``None`` when git answers `rev-parse HEAD` in ``workspace`` through
    the kernel's own probe session (its attempt bound and retry), else a
    one-line reason: the probe that did not answer, or the non-zero exit
    that says this is not a repository with a readable HEAD."""
    outcome = session.run(
        ["git", "rev-parse", "--verify", "HEAD^{commit}"], cwd=workspace,
    )
    if not outcome.answered:
        return (
            f"git rev-parse HEAD did not answer in {workspace}: "
            f"{outcome.unavailable_reason} after {outcome.attempts} attempt(s)"
        )
    if outcome.returncode != 0:
        first_line = outcome.stderr.strip().splitlines()[0] if outcome.stderr.strip() else ""
        return (
            f"git rev-parse HEAD exited {outcome.returncode} in {workspace}: "
            f"{first_line or 'no readable HEAD'}"
        )
    return None


def _pre_claim_environment_gate(*, tools_dir: Path) -> str | None:
    """Refuse to CLAIM a request the environment cannot host (FAZ 5b).

    The correct shape existed in the dead `--consume` loop: preflight the
    Claude auth BEFORE touching the queue. The CI path claimed first and
    discovered the broken environment after, so a night with no auth or no
    sandbox burned a claim (and a requeue) per request — environment faults
    priced as request failures, the same M-2.5 class as ORPHAN-HIGH-605/610.

    Returns None when the dispatch can proceed, else the governance kind
    recorded (`claude_auth_unavailable` / `sandbox_unavailable` /
    `egress_boundary_unavailable` / `git_unavailable` / `env_deps_missing`). On refusal the
    request is NEVER claimed: it stays
    PENDING for a healthy host instead of consuming a lease + requeue here.
    Mock mode skips the gate — a mock dispatch needs none of the surfaces.
    """
    if _MOCK_MODE_AT_ENTRY:
        return None

    kind: str | None = None
    detail = ""
    try:
        preflight_claude_auth()
    except (ClaudeAuthUnavailable, ClaudeCliUnavailable, ClaudePolicyViolation) as exc:
        kind, detail = "claude_auth_unavailable", str(exc)
    if kind is None and _sandbox_backend is not None and _sandbox_backend() is None:
        # ARIA-HIGH-123 — the detail names WHY (the git containment probe's
        # refusal when that is what failed): an operator reading the row
        # must tell "no bwrap" from "bwrap cannot host a commit".
        why = _sandbox_unavailable_detail() if _sandbox_unavailable_detail is not None else "no detail"
        kind, detail = "sandbox_unavailable", (
            f"sandbox_backend() returned None ({why}); write-capable spawns would be refused"
        )
    if kind is None and _egress_boundary_probe is not None:
        # ARIA-HIGH-143 — the spawn shares the host's network; its boundary
        # is the allowlist proxy it is handed. No proxy, a silent one or a
        # permissive one means a prompt-injected agent has the whole
        # network, so the request stays PENDING until the host has one.
        egress_gap = _egress_boundary_probe()
        if egress_gap is not None:
            kind, detail = "egress_boundary_unavailable", egress_gap
    if kind is None and _GitProbeSession is not None:
        # The kernel verifies every evidence ref of the result with git
        # probes in this workspace. A git that cannot answer `rev-parse
        # HEAD` here — not spawnable, stalled past the probe's retries, or
        # no repository at all — would reject the finished result as
        # `verification_unavailable` (a harness fault, uncounted against
        # the request) and re-run the same paid work every night with only
        # cost caps as the bound. Refusing to claim keeps the request
        # PENDING for a host whose git answers.
        git_detail = _git_availability_gap(_GitProbeSession(), workspace=Path.cwd())
        if git_detail is not None:
            kind, detail = "git_unavailable", git_detail
    if kind is None and not _node_modules_resolvable_from(Path.cwd()):
        kind, detail = "env_deps_missing", (
            "no node_modules on the walk up from the workspace; agent validation commands cannot run"
        )
    if kind is None:
        return None

    sys.stderr.write(f"::error::pre_claim_environment_gate: {kind}: {detail}\n")
    if _append_tools_governance is not None:
        try:
            _append_tools_governance(
                tools_dir,
                kind,
                {
                    "source": "ci_executor_pre_claim_gate",
                    "detail": detail,
                    "run_id": os.environ.get("GITHUB_RUN_ID", "local"),
                },
            )
        except Exception as exc:  # noqa: BLE001 — a governance-write failure
            # must not mask the environment refusal it is trying to record.
            sys.stderr.write(f"governance_write_failed: {exc}\n")
    return kind


def _claim_request_via_cli(
    *, request_id: str, agent_id: str, lease_seconds: int, tools_dir: Path,
) -> dict[str, Any] | None:
    """`agent claim` through the kernel CLI: the fused claim response, or None
    after the refusal was written to stderr (the caller exits 1).

    Typed-judgment plan Phase 4a — the block `_main` ran inline, moved
    verbatim so a batch child can claim K requests through the same call.
    The lease guard (`if not lease_token or not claim_id`) stays with the
    caller: it is the positional anchor the lease-leak invariant reads to
    know from which line a claim is HELD.
    """
    claim_proc = subprocess.run(
        _kernel_cli_argv(
            "agent", "claim",
            "--request-id", request_id,
            "--agent-id", agent_id,
            "--lease-seconds", str(lease_seconds),
            "--tools-dir", str(tools_dir),
        ),
        capture_output=True,
        text=True,
        env={**os.environ, "PYTHONPATH": _KERNEL_PYTHONPATH},
    )
    if claim_proc.returncode != 0:
        sys.stderr.write(_redact_lease_in_message(claim_proc.stderr, None) + "\n")
        return None
    try:
        claim = json.loads(claim_proc.stdout)
    except json.JSONDecodeError:
        sys.stderr.write(f"claim output not JSON: {claim_proc.stdout[:200]}\n")
        return None
    return claim


def _render_and_bind_prompt(*, request_envelope: dict[str, Any], request_id: str) -> tuple[str, str] | None:
    """Render the request's prompt and prove it is the one the mint sealed.

    Returns ``(payload, prompt_hash)``, or None after writing
    ``prompt_hash_binding_mismatch`` to stderr (the caller releases under
    that reason). Requires `_render_invocation_prompt`; the caller checks
    the renderer's availability first, as it did inline.
    """
    payload = _render_invocation_prompt(request_envelope)
    computed = "sha256:" + hashlib.sha256(payload.encode("utf-8")).hexdigest()
    if request_envelope.get("prompt_hash") != computed:
        sys.stderr.write(
            f"prompt_hash_binding_mismatch: request_id={request_id} "
            f"expected={request_envelope.get('prompt_hash')!r} "
            f"actual={computed!r}\n"
        )
        return None
    return payload, computed


def _submit_via_cli(
    *, claim_id: str, agent_id: str, lease_token: str, expected_output_path: Path, repo: Path,
    tools_dir: Path, request_envelope: dict[str, Any], transcript_hash: str, transcript_output_path: Path,
) -> subprocess.CompletedProcess[str]:
    """`agent submit-result` through the kernel CLI, bounded by
    SUBMIT_RESULT_TIMEOUT_SECONDS; `subprocess.TimeoutExpired` propagates to
    the caller, whose release reason names the bound.

    ARIA-HIGH-022 — "auto": the kernel CLI resolves the workspace HEAD and
    grounds the evidence check there when it has moved past the request
    base — one flag, no extra subprocess on this side (the fused-envelope
    smoke contract counts subprocess calls).
    """
    submit_argv = _kernel_cli_argv(
        "agent", "submit-result",
        "--claim-id", claim_id,
        "--agent-id", agent_id,
        "--lease-token-from-env", LEASE_TOKEN_ENV_VAR,
        "--output-path", str(expected_output_path),
        "--workspace-root", str(repo),
        "--tools-dir", str(tools_dir),
        "--context-hash", str(request_envelope.get("context_hash") or ""),
        "--prompt-hash", str(request_envelope.get("prompt_hash") or ""),
        "--transcript-hash", transcript_hash,
        "--transcript-artifact-ref", transcript_output_path.resolve().as_posix(),
    )
    submit_argv += ["--evidence-target-sha", "auto"]
    return subprocess.run(
        submit_argv,
        capture_output=True,
        text=True,
        env={
            **os.environ,
            "PYTHONPATH": _KERNEL_PYTHONPATH,
            LEASE_TOKEN_ENV_VAR: lease_token,
        },
        timeout=SUBMIT_RESULT_TIMEOUT_SECONDS,
    )


def _reconcile_native_result(
    *, tools_dir: Path, request_id: str, claim_id: str, agent_id: str, session_id: str | None,
    policy_digest: str, request_envelope: dict[str, Any],
) -> bool:
    """After a native-route submit: prove the accepted row is this attempt's
    and record `runtime_attempt_reconciled`. False after the unavailability
    was written to stderr (the caller exits 1)."""
    from aria_kernel.tool_registry import GovernanceError, append_tools_governance

    try:
        accepted, attempt = _accepted_native_runtime_result(
            tools_dir=tools_dir, request_id=request_id, claim_id=claim_id, agent_id=agent_id,
            session_id=session_id, policy_digest=policy_digest,
        )
    except (GovernanceError, OSError, ValueError) as exc:
        sys.stderr.write("native_runtime_result_reconciliation_unavailable:" + type(exc).__name__ + "\n")
        return False
    append_tools_governance(tools_dir, "runtime_attempt_reconciled", {
        "schema_version": 1, "request_id": request_id, "claim_id": claim_id,
        "request_ledger_hash": request_envelope["request_ledger_hash"],
        "claim_ledger_hash": request_envelope["claim_ledger_hash"],
        "attempt_ledger_hash": attempt["ledger_hash"],
        "result_ledger_hash": accepted["ledger_hash"], "result_status": accepted["status"],
        "agent_id": agent_id, "session_id": session_id,
        "policy_digest": policy_digest,
    })
    return True


def _native_route_for_summary(native_runtime: "_NativeRuntimePlan", request: dict[str, Any], *, target_agent: str) -> DispatchRoute:
    """The route the native attempt actually RAN on (ARIA-HIGH-182) — the
    admitted provider and model, never the profile's declared pair: the
    evidence judge declares anthropic/opus and is admitted on zai/glm-5.3
    when the ladder says so, and the drain keys its circuits by the pair
    that answered."""
    return DispatchRoute(
        provider=str(native_runtime.route["provider"]), model=str(native_runtime.route["model"]),
        role=str(request.get("role") or ""), target_agent=str(request.get("target_agent") or target_agent),
    )


def _main(argv: list[str] | None, *, _runtime_stack: _ExitStack) -> int:
    """Entry point — runs one cycle. Designed to be called by GHA step."""
    global _MOCK_MODE_AT_ENTRY
    args = argv if argv is not None else sys.argv[1:]
    if len(args) < 1:
        print(
            "usage: ci_executor.py <request_id> [subagent_type] | --drain | "
            "--judge-batch <role> <target_agent> <request_id>...",
            file=sys.stderr,
        )
        return 2

    if args[0] == "--judge-batch":
        # Typed-judgment plan Phase 4b (ARIA-MEDIUM-163) — K judge requests
        # that share a role, an agent and an anchor, served by ONE typed
        # model call. The drain selected them; this child claims, asks,
        # seals and submits each one through the same seams as the
        # single-request path (`ci_executor_judge_batch`).
        if len(args) < 4:
            print("usage: ci_executor.py --judge-batch <role> <target_agent> <request_id>...", file=sys.stderr)
            return 2
        from ci_executor_judge_batch import run_judge_batch

        _MOCK_MODE_AT_ENTRY = _is_mock_mode()
        batch_repo = Path.cwd().resolve()
        batch_env_tools = os.environ.get("ARIA_TOOLS_DIR")
        batch_tools_dir = Path(batch_env_tools).resolve() if batch_env_tools else batch_repo / "aria-tools"
        _record_mock_mode_audit(batch_tools_dir)
        return run_judge_batch(
            tools_dir=batch_tools_dir, repo=batch_repo, role=args[1], target_agent=args[2],
            request_ids=list(args[3:]), _runtime_stack=_runtime_stack,
        )

    if args[0] == "--drain":
        # Batch consumption for the scheduled lane. The loop lives in its own
        # module (ci_executor_drain) so this engine file stops growing; the
        # import is local because drain imports THIS module for its stage
        # logger and governance binding.
        from ci_executor_drain import drain_pending

        repo_root = Path.cwd().resolve()
        env_tools = os.environ.get("ARIA_TOOLS_DIR")
        drain_tools_dir = (
            Path(env_tools).resolve() if env_tools else repo_root / "aria-tools"
        )
        return drain_pending(tools_dir=drain_tools_dir, repo_root=repo_root)

    # ARIA-HIGH-142 — a targeted run (`ci_executor.py <request_id>`) that was
    # not handed ARIA_WORKSPACE_ROOT publishes into the kernel's own checkout.
    # The drain always exports it; an operator invocation may not, and the
    # log must say which tree the run is about to treat as the request's.
    root_note = repo_root_provenance_note()
    if root_note is not None:
        sys.stderr.write(root_note + "\n")

    # Plan ARIA-V3.1-D2 — frozen mock-mode sentinel at main() entry
    # (closes ai-safety HIGH-007). Pre-V3.1-D2 every cost-attribution
    # callsite re-read `os.environ.get(MOCK_MODE_ENV_VAR)` so a
    # mid-run env mutation by a downstream subprocess could flip the
    # mock decision between mint + record. The sentinel captures the
    # mock state ONCE at entry; every subsequent cost-attribution
    # call gates on this frozen value, NOT the live env.
    #
    # Tier-1 anchor: the variable is computed exactly once and never
    # re-read. The sentinel is intentionally module-attached (NOT a
    # function-local) so cost-attribution callers in nested helper
    # frames can read the same frozen decision (declared `global` at the
    # top of this function, once, for both entry arms).
    _MOCK_MODE_AT_ENTRY = _is_mock_mode()

    request_id = args[0]
    subagent_type = args[1] if len(args) > 1 else "aria-evidence-judge"

    repo = Path.cwd().resolve()
    # Plan ARIA-V7 §2g v2 — honor ARIA_TOOLS_DIR env var so the
    # consumer can run against a non-default tools directory (e.g.
    # the operator-side ./aria-tools-v7-30cycle verification dir).
    # Pre-V7 hardcoded `repo / "aria-tools"`; that broke the V7
    # parallel-consumer workflow where autonomy run + consumer
    # share a non-default tools_dir.
    _env_tools = os.environ.get("ARIA_TOOLS_DIR")
    if _env_tools:
        tools_dir = Path(_env_tools).resolve()
    else:
        tools_dir = repo / "aria-tools"

    # Plan ARIA-V3 §B1 AUDITTRAIL-HIGH-009 — single governance row
    # per executor invocation recording the effective mock state +
    # source. Runs BEFORE any kernel-side work so even an early
    # crash leaves the mock-mode decision in the audit log.
    _record_mock_mode_audit(tools_dir)

    # Plan 026R §B.1 — agent_id is computed once + reused for every
    # subsequent kernel CLI call (claim + release fail-fast branches +
    # submit-result). Pre-§B.1 release_claim did not need agent_id;
    # post-§B.1 it does, and lease-bound release requires the SAME
    # agent_id that claimed the request (kernel enforces).
    agent_id = f"ci-executor:gha-{os.environ.get('GITHUB_RUN_ID', 'local')}"

    # Plan 026R §B.5 — single-claim mode. When the planner has already
    # claimed the request and exported ARIA_CLAIM_METADATA_FILE + ARIA_LEASE_
    # TOKEN, this executor SKIPS its own ``agent claim`` step and uses
    # the inherited envelope + ledger-hash anchors directly. Pre-§B.5
    # the subprocess re-claimed (double-claim) and the defensive reject
    # was noisy + tagged every planner-driven cycle as a failure.
    native_runtime = None
    metadata_env = _read_claim_metadata_file(os.environ.get(CLAIM_METADATA_FILE_ENV_VAR))
    if metadata_env:
        claim, single_claim_error = _deserialise_inherited_claim_metadata(
            metadata_env,
            agent_id=None,
            request_id=request_id,
            tools_dir=tools_dir,
        )
        if single_claim_error is not None:
            sys.stderr.write(single_claim_error + "\n")
            return 1
        lease_token = os.environ.get(LEASE_TOKEN_ENV_VAR)
        if not lease_token:
            sys.stderr.write(
                f"single_claim_mode missing {LEASE_TOKEN_ENV_VAR} env var\n"
            )
            return 1
        claim_id = claim["claim_id"]
        agent_id = str(claim["agent_id"])
        if not _MOCK_MODE_AT_ENTRY:
            from aria_kernel.tool_registry import GovernanceError as _AdmissionRefusal

            try:
                admission_exit = _adaptive_pre_claim_admission(
                    repo_root=repo, tools_dir=tools_dir, request_id=request_id,
                    target_agent=subagent_type, _runtime_stack=_runtime_stack,
                    _inherited_claim=claim, _lease_token=lease_token,
                )
            except _AdmissionRefusal as exc:
                sys.stderr.write(f"adaptive_runtime_admission_failed: {exc}\n")
                return 1
            if isinstance(admission_exit, _NativeRuntimePlan):
                native_runtime = admission_exit
            elif isinstance(admission_exit, _NativeAdmissionRefusal):
                # The reason is the refusal's own (`ADMISSION_REFUSALS` /
                # `TASK_BINDING_REFUSAL`), never picked here.
                released = _release_claim(
                    tools_dir=tools_dir, repo=repo, claim_id=claim_id,
                    agent_id=agent_id, lease_token=lease_token,
                    reason=admission_exit.release_reason,
                )
                return admission_exit.exit_code if released else 1
    else:
        # FAZ 5b — environment gate BEFORE the claim. Single-claim mode skips
        # it deliberately: the claim already exists there (the planner made
        # it), so the request is already spent from the queue's perspective
        # and refusing here would strand a held lease instead of saving one.
        if not _MOCK_MODE_AT_ENTRY:
            from aria_kernel.tool_registry import GovernanceError as _AdmissionRefusal

            try:
                admission_exit = _adaptive_pre_claim_admission(
                    repo_root=repo, tools_dir=tools_dir, request_id=request_id,
                    target_agent=subagent_type,
                    _runtime_stack=_runtime_stack,
                )
            except _AdmissionRefusal as exc:
                sys.stderr.write(f"adaptive_runtime_admission_failed: {exc}\n")
                return 1
            if isinstance(admission_exit, _NativeRuntimePlan):
                native_runtime = admission_exit
            elif isinstance(admission_exit, _NativeAdmissionRefusal):
                return admission_exit.exit_code
        gate_kind = _pre_claim_environment_gate(tools_dir=tools_dir) if native_runtime is None else None
        if gate_kind is not None:
            return 1
        # Step 1 — claim the request through the kernel CLI. The lease is
        # this child's own priced worst case (ARIA-HIGH-124 round 3): the
        # kernel's 30-minute default did not cover a CLI at its cap plus
        # the submit, and could not cover an implementation's delivery at
        # all — `submit_claim_result` refuses an expired lease by
        # construction (`lease_expired`), so a healthy run that outlived
        # its lease was refused after the work was done.
        # (The drain's worktree bracket runs outside the claim; the lease
        # covers the claim to the release.)
        _lease_seconds = _child_worst_case_seconds(
            implementation_delivery_seconds=_request_delivery_seconds(tools_dir=tools_dir, request_id=request_id),
        )
        claim = _claim_request_via_cli(
            request_id=request_id, agent_id=agent_id, lease_seconds=_lease_seconds, tools_dir=tools_dir,
        )
        if claim is None:
            return 1

        lease_token = claim.get("lease_token")
        claim_id = claim.get("claim_id")

        if not lease_token or not claim_id:
            sys.stderr.write("claim missing lease_token or claim_id\n")
            return 1

    # From here on a lease is HELD. Every explicit `_release_claim` below
    # keeps its precise reason; this guard is the floor beneath them: when
    # the runtime stack unwinds — return or uncaught exception — a request
    # the kernel still derives CLAIMED/RUNNING is released with a reason
    # naming the exit, so no path can leak a lease again (seven did on
    # 2026-09-04, when the spawn gate's refusal crashed before its release).
    _runtime_stack.enter_context(HeldClaim(
        tools_dir=tools_dir, repo=repo, request_id=request_id, claim_id=claim_id,
        agent_id=agent_id, lease_token=lease_token, release=_release_claim,
        derive_state=_held_request_state if _derive_request_state is not None else None,
        log=_stage,
    ))

    # Step 2 — read the fused request envelope from the claim response.
    # Plan 026R §B.3 — ``agent claim`` now returns the request envelope
    # (expected_output_path / role / must_satisfy / allowed_scope /
    # evidence_refs) PLUS the §B.5 ledger-hash anchors
    # (claim_ledger_hash / request_ledger_hash) inside the same
    # exclusive-lock window that performed the claim CAS. The pre-§B.3
    # second-fetch via ``agent-invocations list --request-id`` opened a
    # race window: between claim-success and the list-fetch, a release
    # or reaper sweep could mutate the request row and the executor
    # would operate on a stale envelope. Reading from the fused
    # response closes the race AND eliminates one subprocess hop per
    # cycle (lower latency).
    # The envelope is the kernel's OWN projection of the claim response, not a
    # copy maintained here. This function used to hand-build the dict —
    # `claim.get("forbidden_scope") or []`, no `repository_map` — which is the
    # same defect the kernel-side fusion fix closed, one layer up: `or []`
    # turns absence into an empty value, the renderer distinguishes the two,
    # and the dropped map deleted the whole `## Repository map` section from
    # the re-render. Net effect, measured on run 31330288849: the binding
    # check compared the hash of the row against the hash of this copy and
    # failed for every request that carried a map — after the kernel fix had
    # already landed. One projection, owned by the kernel, ends the class.
    if _fuse_prompt_envelope is None:
        sys.stderr.write("kernel_prompt_renderer_unavailable\n")
        _release_claim(
            tools_dir=tools_dir, repo=repo, claim_id=claim_id,
            agent_id=agent_id, lease_token=lease_token,
            reason="kernel_prompt_renderer_unavailable",
        )
        return 1
    request_envelope = _fuse_prompt_envelope(claim)
    if native_runtime is not None:
        if native_runtime.request["ledger_hash"] != claim["request_ledger_hash"]:
            sys.stderr.write("native_runtime_request_hash_changed\n")
            _release_claim(tools_dir=tools_dir, repo=repo, claim_id=claim_id,
                           agent_id=agent_id, lease_token=lease_token,
                           reason="native_runtime_task_binding_unavailable")
            return 1
        request_envelope["target_sha"] = native_runtime.request["target_sha"]
    request_envelope.setdefault("request_id", request_id)
    # Operational anchors, NOT prompt material: the renderer never reads
    # these, so carrying them cannot perturb the binding. claim/request
    # ledger hashes feed the §B.5 metadata-tamper check.
    for anchor in ("claim_ledger_hash", "request_ledger_hash"):
        if claim.get(anchor) is not None:
            request_envelope[anchor] = claim[anchor]
    if not request_envelope.get("expected_output_path"):
        sys.stderr.write(
            f"request_envelope_missing_expected_output_path: "
            f"request_id={request_id}\n"
        )
        _release_claim(
            tools_dir=tools_dir, repo=repo, claim_id=claim_id,
            agent_id=agent_id, lease_token=lease_token,
            reason="request_envelope_missing_expected_output_path",
        )
        return 1
    if not request_envelope.get("role"):
        sys.stderr.write(
            f"request_envelope_missing_role: request_id={request_id}\n"
        )
        _release_claim(
            tools_dir=tools_dir, repo=repo, claim_id=claim_id,
            agent_id=agent_id, lease_token=lease_token,
            reason="request_envelope_missing_role",
        )
        return 1
    expected_output_path = Path(request_envelope["expected_output_path"])

    from aria_kernel.budget import WallClockExhausted

    try:
        _validate_dispatch_budget(
            request=request_envelope,
            tools_dir=tools_dir,
            timeout_seconds=_max_timeout_seconds(),
        )
    except (CostCapExceeded, WallClockExhausted) as exc:
        sys.stderr.write(f"dispatch_budget_refused: {exc}\n")
        # Plan 025 §B — release via the shared helper so every fail-
        # fast branch in ``main()`` releases the lease deterministically
        # (no claim row leaked in CLAIMED state until lease expiry).
        #
        # ORPHAN-HIGH-472 — releasing is what makes the wall-clock refusal
        # worth having. The request goes back on the queue for the next
        # cycle instead of being started with less time left than its own
        # timeout, which is the case that would have been killed mid-flight
        # by the runner with the lease still held.
        _release_claim(
            tools_dir=tools_dir, repo=repo, claim_id=claim_id,
            agent_id=agent_id, lease_token=lease_token,
            reason="dispatch_budget_refused",
        )
        # A budget signal, NOT a build failure — and NOT a success: the
        # summary names which budget refused, so the drain counts it as
        # refused rather than reading a bare exit 0 as drained.
        return _refuse_dispatch(
            request=request_envelope, request_id=request_id, target_agent=subagent_type,
            reason="dispatch_budget_refused:" + ("wall_clock" if isinstance(exc, WallClockExhausted) else "cost_cap"),
        )

    # Plan ARIA-V7 §2g v2 — write the request's suggested_prompt to
    # the canonical prompts/ path BEFORE invoking the CLI. Pre-V7
    # this was assumed pre-staged by the workflow; V7's parallel-
    # consumer mode mints requests directly via
    # create_agent_invocation_request which writes ONLY to
    # requests.jsonl (no prompt file). Without this write, the
    # modernized invoke_claude_cli reads an empty prompt and the
    # claude CLI subprocess receives an empty prompt.
    prompt_file = tools_dir / "agent-invocations" / "prompts" / f"{request_id}.md"
    prompt_file.parent.mkdir(parents=True, exist_ok=True)
    if _render_invocation_prompt is None:
        sys.stderr.write("kernel_prompt_renderer_unavailable\n")
        _release_claim(
            tools_dir=tools_dir, repo=repo, claim_id=claim_id,
            agent_id=agent_id, lease_token=lease_token,
            reason="kernel_prompt_renderer_unavailable",
        )
        return 1
    bound = _render_and_bind_prompt(request_envelope=request_envelope, request_id=request_id)
    if bound is None:
        _release_claim(
            tools_dir=tools_dir, repo=repo, claim_id=claim_id,
            agent_id=agent_id, lease_token=lease_token,
            reason="prompt_hash_binding_mismatch",
        )
        return 1
    _prompt_payload, _computed_prompt_hash = bound
    prompt_file.write_text(_prompt_payload, encoding="utf-8")

    timeout = _max_timeout_seconds()
    transcript_output_path = expected_output_path.with_suffix(".transcript.jsonl")
    _publish_artifact_paths(expected_output_path, transcript_output_path)
    # Plan 032 Faz 032c — recovery FIRST: a request whose previous attempt
    # left an external intent without a receipt is not re-run blind. Then
    # the session decision (fresh vs resume, fingerprint-bound) and, for a
    # write-capable envelope, a pre-spawn checkpoint of the workspace.
    _session_id, _resume = _decide_session_and_recovery(
        tools_dir=tools_dir, repo=repo, request_id=request_id, claim_id=claim_id,
        agent_id=agent_id, lease_token=lease_token, subagent_type=subagent_type,
        request_envelope=request_envelope, prompt_hash=_computed_prompt_hash,
        **({"native_runtime": native_runtime} if native_runtime is not None else {}),
    )
    if _session_id is None:
        # Released to HUMAN_REQUIRED by the recovery classifier: an
        # escalation, named as such in the summary — never a drained success.
        return _refuse_dispatch(
            request=request_envelope, request_id=request_id, target_agent=subagent_type,
            reason="recovery_unresolved_external_effect",
        )
    # Plan 032 Faz 032e — operator control. A cancel recorded after the claim
    # is honoured BEFORE the spawn (release with the operator fault domain);
    # during the spawn the runtime polls the same ledger and stops the
    # process group; every stream-json event feeds the sanitized progress
    # file the operator tails.
    from aria_kernel.control import OPERATOR_CANCELLED_RELEASE_REASON, is_cancelled, record_cancel_outcome
    from aria_kernel.progress import ProgressWriter
    from claude_runtime import SpawnControl

    if is_cancelled(request_id, tools_dir):
        record_cancel_outcome(request_id, outcome="before_spawn", base_dir=tools_dir, detail={"claim_id": claim_id})
        _release_claim(
            tools_dir=tools_dir, repo=repo, claim_id=claim_id,
            agent_id=agent_id, lease_token=lease_token,
            reason=OPERATOR_CANCELLED_RELEASE_REASON,
        )
        return _refuse_dispatch(
            request=request_envelope, request_id=request_id, target_agent=subagent_type,
            reason=OPERATOR_CANCELLED_RELEASE_REASON,
        )
    # ARIA-HIGH-115 — the implementer's signing identity is minted HERE, in
    # the tree the agent will commit in (`_REPO_ROOT`: the per-request
    # worktree the drain added, or whatever the lane handed this child), as
    # the LAST step before the spawn — after the budget, renderer, recovery
    # and operator-cancel refusals, each of which would otherwise have cost
    # an ssh-keygen and left a `kg_signers` row for a key that never signed
    # — and held on the runtime stack so it is revoked (config restored) on
    # every exit after the submit or the release. The mint wires the
    # worktree's git config, so the agent's plain `git commit` signs; the
    # public half is on `kg_signers` before the agent starts, so the bridge
    # can verify against it after the worktree is gone. A tree the identity
    # cannot be held in (the shared checkout, an unwirable git, no
    # ssh-keygen) is refused by name before any turn is spent, under
    # `IMPLEMENTATION_IDENTITY_REFUSAL` (harness-class release, retryable
    # `harness_unavailable` summary); the request stays PENDING.
    implementation_identity = None
    _delivery_profile = None
    # ARIA-HIGH-124 (round 5) — the identity's OWN stack, nested on the
    # runtime stack: the private key and the kernel-held ssh-agent serve
    # exactly the agent's commit, so the executor retires them
    # (`_identity_stack.close()`: the agent stopped, the key unlinked, the
    # config restored) right after the quarantine's publication and BEFORE
    # the delivery — the verification reads the registered PUBLIC key
    # (`plan_convergence_bridge.verify_implementation_commit`), the push
    # and the PR need no key at all. Until round 5 the private key stayed
    # under `<worktree>/aria-debts/keys/` through the delivery, where the
    # validation sandbox (no keys mask then) exposed it to the agent's
    # committed suite. The runtime stack's own exit still closes an
    # identity a pre-spawn refusal left held.
    _identity_stack = _runtime_stack.enter_context(_ExitStack())
    if request_envelope["role"] == "implementation":
        from aria_kernel.gh_token_factory import signing_keys_dir as _signing_keys_dir
        from aria_kernel.implementation_identity import (
            ImplementationIdentityRefusal,
            hold_implementation_identity,
        )
        from aria_kernel.tool_registry import append_tools_governance as _identity_governance

        _identity_cycle_id = str(request_envelope.get("cycle_id") or "")
        try:
            implementation_identity = _identity_stack.enter_context(hold_implementation_identity(
                cycle_id=_identity_cycle_id, workspace_root=_REPO_ROOT, base_dir=tools_dir,
            ))
        except ImplementationIdentityRefusal as exc:
            _identity_governance(tools_dir, IMPLEMENTATION_IDENTITY_REFUSAL.release_reason, {
                "request_id": request_id, "claim_id": claim_id, "cycle_id": _identity_cycle_id,
                "workspace_root": str(_REPO_ROOT), "reason": exc.reason,
            })
            sys.stderr.write(
                f"{IMPLEMENTATION_IDENTITY_REFUSAL.release_reason}: {exc.reason} workspace_root={_REPO_ROOT}\n"
            )
            _release_claim(
                tools_dir=tools_dir, repo=repo, claim_id=claim_id,
                agent_id=agent_id, lease_token=lease_token,
                reason=IMPLEMENTATION_IDENTITY_REFUSAL.release_reason,
            )
            return _refuse_dispatch(
                request=request_envelope, request_id=request_id, target_agent=subagent_type,
                reason=IMPLEMENTATION_IDENTITY_REFUSAL.release_reason,
                failure_class=IMPLEMENTATION_IDENTITY_REFUSAL.failure_class,
                retryable=IMPLEMENTATION_IDENTITY_REFUSAL.retryable,
            )
        _stage(f"implementation_identity_held cycle_id={_identity_cycle_id} scope={implementation_identity.scope}")
        # ARIA-HIGH-124 (round 6) — the DELIVERY credential is minted WHERE
        # IT IS CONSUMED: by the delivery, after the contained gate, for
        # exactly the push and the PR (`implementation_delivery`, stage
        # `credential`). Here, before any turn is spent, the lane's ability
        # to mint is ADMITTED — one lease minted and revoked at once,
        # recorded as such (`consumer: executor_admission`) — so a lane that
        # cannot mint is released harness-class, like the identity. Until
        # round 6 the ONE lease was minted here and first consumed after the
        # spawn, the publication, the decisions and the contained gate —
        # up to `IMPLEMENTATION_DELIVERY_WORST_CASE_SECONDS` later — while a
        # GitHub App installation token lives one hour: in Mode A every
        # implementation whose spawn and suite ran past ~55 minutes pushed
        # with a dead token and was escalated as the request's fault.
        from aria_kernel.agent_runtime_profile import read_agent_runtime_profile as _read_profile
        from aria_kernel.delivery_credentials import DeliveryCredentialError, admit_delivery_credentials

        _delivery_profile = _read_profile(subagent_type)
        _deadline_epoch = os.environ.get("ARIA_JOB_DEADLINE_EPOCH")
        try:
            _credential_admission = admit_delivery_credentials(
                profile=_delivery_profile, request_id=request_id,
                cycle_id=request_envelope.get("cycle_id"), workspace_root=_REPO_ROOT, base_dir=tools_dir,
                deadline_epoch=float(_deadline_epoch) if _deadline_epoch else None,
            )
        except DeliveryCredentialError as exc:
            sys.stderr.write(f"{DELIVERY_CREDENTIAL_REFUSAL.release_reason}: {exc}\n")
            _release_claim(
                tools_dir=tools_dir, repo=repo, claim_id=claim_id,
                agent_id=agent_id, lease_token=lease_token,
                reason=DELIVERY_CREDENTIAL_REFUSAL.release_reason,
            )
            return _refuse_dispatch(
                request=request_envelope, request_id=request_id, target_agent=subagent_type,
                reason=DELIVERY_CREDENTIAL_REFUSAL.release_reason,
                failure_class=DELIVERY_CREDENTIAL_REFUSAL.failure_class,
                retryable=DELIVERY_CREDENTIAL_REFUSAL.retryable,
            )
        _stage(
            "delivery_credential_admitted mode="
            + (str(_credential_admission.mode) if _credential_admission is not None else "none")
        )
        # ARIA-HIGH-124 — the implementation branch is the kernel's to
        # make: the sandbox starts ON `implementation_ids.branch` at
        # `base_sha`, in the replica only (`stand_on_implementation_branch`)
        # — the agent's `git switch -c` was never admitted by the command
        # policy. A branch the shared repository already holds (an earlier
        # attempt published it) is a collision a retry cannot resolve:
        # refused before a turn, escalated for a person. A row whose ids
        # cannot stand a sandbox at all (no `aria-impl-*` name, no object
        # id) is the REQUEST's fault: escalated the same way (round 2 — a
        # harness-class release had it re-claimed without bound). Any other
        # refusal is the containment's shape, released like the identity.
        from aria_kernel.git_containment import GitContainmentRefusal, stand_on_implementation_branch

        _implementation_ids = _staged_implementation_ids(tools_dir=tools_dir, request_id=request_id)
        try:
            # The seeded containment (round 2): the publication after the
            # spawn discards the seed unless the agent advanced it, so a
            # failed spawn leaves no branch and its retry stands here again.
            _seeded_containment = stand_on_implementation_branch(
                implementation_identity.containment,
                branch=str(_implementation_ids.get("branch") or ""),
                base_sha=str(_implementation_ids.get("base_sha") or ""),
            )
        except GitContainmentRefusal as exc:
            # The three kinds are spelled at the release site itself (a
            # conditional over the refusal tables), the shape the
            # release-site invariant reads.
            _collision = exc.reason == "implementation_branch_exists"
            _request_invalid = exc.reason in IMPLEMENTATION_REQUEST_INVALID_CONTAINMENT_REASONS
            _branch_refusal_reason = (
                IMPLEMENTATION_BRANCH_COLLISION_REFUSAL.release_reason if _collision
                else IMPLEMENTATION_REQUEST_INVALID_REFUSAL.release_reason if _request_invalid
                else IMPLEMENTATION_IDENTITY_REFUSAL.release_reason
            )
            _identity_governance(
                tools_dir, _branch_refusal_reason,
                {
                    "request_id": request_id, "claim_id": claim_id, "cycle_id": _identity_cycle_id,
                    "workspace_root": str(_REPO_ROOT), "reason": f"git_containment_refused:{exc.reason}",
                    "branch": _implementation_ids.get("branch"), "base_sha": _implementation_ids.get("base_sha"),
                },
            )
            sys.stderr.write(f"{_branch_refusal_reason}: git_containment_refused:{exc.reason}\n")
            if _collision or _request_invalid:
                # The ids (the branch name, the sha) travel in the record's
                # structured context, never in the reason's prose (round 3).
                try:
                    _record_human_required(
                        tools_dir=tools_dir, request_id=request_id, severity="HIGH",
                        reason=(
                            f"{IMPLEMENTATION_BRANCH_COLLISION_REFUSAL.release_reason}: the shared repository "
                            "already holds this request's implementation branch (an earlier attempt published "
                            "it); deliver or delete it, then requeue"
                            if _collision else
                            f"{IMPLEMENTATION_REQUEST_INVALID_REFUSAL.release_reason}: the request row's "
                            "implementation_ids cannot stand a sandbox; re-stage the plan, then requeue"
                        ),
                        context={
                            "code": _branch_refusal_reason, "stage": "branch_preparation",
                            "containment_refusal": exc.reason, "claim_id": claim_id, "cycle_id": _identity_cycle_id,
                            "branch": _implementation_ids.get("branch"), "base_sha": _implementation_ids.get("base_sha"),
                        },
                    )
                except HumanRequiredRecordUnavailable as record_error:
                    return _release_unescalated(
                        tools_dir=tools_dir, repo=repo, request=request_envelope, request_id=request_id,
                        target_agent=subagent_type, claim_id=claim_id, agent_id=agent_id, lease_token=lease_token,
                        escalation_reason=_branch_refusal_reason, phase="preflight", error=record_error,
                    )
            _release_claim(
                tools_dir=tools_dir, repo=repo, claim_id=claim_id,
                agent_id=agent_id, lease_token=lease_token,
                reason=(IMPLEMENTATION_BRANCH_COLLISION_REFUSAL.release_reason if _collision
                        else IMPLEMENTATION_REQUEST_INVALID_REFUSAL.release_reason if _request_invalid
                        else IMPLEMENTATION_IDENTITY_REFUSAL.release_reason),
            )
            return _refuse_dispatch(
                request=request_envelope, request_id=request_id, target_agent=subagent_type,
                reason=_branch_refusal_reason,
                failure_class=(IMPLEMENTATION_BRANCH_COLLISION_REFUSAL.failure_class if _collision
                               else IMPLEMENTATION_REQUEST_INVALID_REFUSAL.failure_class if _request_invalid
                               else IMPLEMENTATION_IDENTITY_REFUSAL.failure_class),
                retryable=(IMPLEMENTATION_BRANCH_COLLISION_REFUSAL.retryable if _collision
                           else IMPLEMENTATION_REQUEST_INVALID_REFUSAL.retryable if _request_invalid
                           else IMPLEMENTATION_IDENTITY_REFUSAL.retryable),
            )
        _stage(f"implementation_branch_prepared branch={_implementation_ids.get('branch')} base_sha={_implementation_ids.get('base_sha')}")
        # ARIA-HIGH-124 (round 3) — the window: the job's remaining wall
        # clock must hold the CLI at its cap AND everything this child runs
        # after it (the publication, the contained gate at up to the staged
        # ceiling per command, the push, the PR, the terminal writer, the
        # release). Decided BEFORE the spawn, so a delivery that could not
        # finish is never started — a job reaped mid-delivery left a
        # published branch with no PR, a lease to expire, and a retry that
        # collided into HUMAN_REQUIRED. The sandbox the gate needs is
        # proven buildable for every staged command at the same time.
        # Harness-class: the window and the host say nothing about the
        # request, which stays queued with its budget intact.
        from aria_kernel.git_containment import QUARANTINE_PUBLICATION_WORST_CASE_SECONDS
        from aria_kernel.implementation_delivery import delivery_admission_refusal

        _delivery_seconds = _request_delivery_seconds(tools_dir=tools_dir, request_id=request_id)
        # What this child runs after the delivery — and, before the spawn,
        # the CLI at its cap and the publication in between.
        _after_delivery_seconds = TERMINAL_WRITER_TIMEOUT_SECONDS + STATE_WRITE_CHILD_WORST_CASE_SECONDS
        _window_refusal = delivery_admission_refusal(
            workspace_root=_REPO_ROOT, base_dir=tools_dir, proposal_id=str(_implementation_ids.get("proposal_id") or ""),
            job_deadline_epoch=float(_deadline_epoch) if _deadline_epoch else None,
            extra_seconds=timeout + QUARANTINE_PUBLICATION_WORST_CASE_SECONDS + _after_delivery_seconds,
        )
        if _window_refusal is not None:
            _identity_governance(
                tools_dir, DELIVERY_WINDOW_REFUSAL.release_reason,
                {
                    "request_id": request_id, "claim_id": claim_id, "cycle_id": _identity_cycle_id,
                    "workspace_root": str(_REPO_ROOT), "reason": _window_refusal, "decided": "before_spawn",
                    "delivery_worst_case_seconds": _delivery_seconds,
                },
            )
            sys.stderr.write(f"{DELIVERY_WINDOW_REFUSAL.release_reason}: {_window_refusal} (before the spawn)\n")
            _release_claim(
                tools_dir=tools_dir, repo=repo, claim_id=claim_id,
                agent_id=agent_id, lease_token=lease_token,
                reason=DELIVERY_WINDOW_REFUSAL.release_reason,
            )
            return _refuse_dispatch(
                request=request_envelope, request_id=request_id, target_agent=subagent_type,
                reason=DELIVERY_WINDOW_REFUSAL.release_reason,
                failure_class=DELIVERY_WINDOW_REFUSAL.failure_class,
                retryable=DELIVERY_WINDOW_REFUSAL.retryable,
            )
    _signer_key_fp = implementation_identity.fingerprint if implementation_identity is not None else None
    # ARIA-HIGH-123 — the same holder's sandbox shape: the request worktree's
    # git dirs bound the way a commit needs, the key masked, the agent socket
    # bound. Only the Claude route can carry it (the native Codex and Z.ai
    # routes prepare read-only runtimes and never host an implementation).
    _git_containment = _seeded_containment if implementation_identity is not None else None
    _spawn_control = SpawnControl(
        should_cancel=lambda: is_cancelled(request_id, tools_dir),
        on_event=ProgressWriter(request_id, base_dir=tools_dir, claim_id=claim_id).write,
    )
    _run_started_at = time.monotonic()
    try:
        # ARIA-HIGH-123 — whatever the spawn's exit, what the agent committed
        # inside the sandbox is in the worktree's quarantine, never in the
        # shared repository: the kernel publishes it here, from outside, with
        # git's own checks (objects re-hashed, packs unpacked, only this
        # request's `aria-impl-*` branch published, the rest discarded by
        # name), BEFORE the result is read — the bridge verifies the commit
        # in the shared checkout. A killed executor never reaches this line,
        # and the quarantine dies with its worktree.
        try:
            # Plan 024 v3 §B-8 — pass real lease identity + role from
            # request row into the mock envelope writer. claim_id +
            # agent_id come from the kernel CLI's claim output (line 209-
            # 211); role + must_satisfy come from the request_envelope
            # we already loaded for cost-cap evaluation.
            if native_runtime is not None:
                _invoke_native = {
                    "codex": _invoke_native_codex, "zai": _invoke_native_zai,
                    "claude": _functools.partial(_invoke_native_claude, prompt_file=prompt_file, resume=_resume,
                                                 git_containment=_git_containment),
                }[native_runtime.route["runtime"]]
                cli_exit = _invoke_native(
                    native_runtime=native_runtime, repo=repo, tools_dir=tools_dir,
                    request=request_envelope, request_id=request_id, claim_id=claim_id, agent_id=agent_id,
                    lease_token=lease_token,
                    target_agent=subagent_type, session_id=_session_id, prompt=_prompt_payload,
                    output_path=expected_output_path, transcript_path=transcript_output_path,
                    timeout_seconds=timeout, spawn_control=_spawn_control,
                    signer_key_fp=_signer_key_fp,
                )
            else:
                cli_exit = invoke_claude_cli(
                request_id=request_id,
                subagent_type=subagent_type,
                session_id=_session_id,
                resume=_resume,
                prompt_file=prompt_file,
                output_path=expected_output_path,
                transcript_path=transcript_output_path,
                timeout_seconds=timeout,
                claim_id=claim_id,
                agent_id=agent_id,
                # Plan 025 §B — request_envelope["role"] is now guaranteed
                # populated (validated above); direct subscript surfaces a
                # KeyError if a future regression skips the validation.
                role=request_envelope["role"],
                must_satisfy=request_envelope.get("must_satisfy") or [],
                # Plan ARIA-V3.1-D3 — per-LLM-call cost attribution wire.
                # Pass the request_envelope (provides cycle_id +
                # pressure_source_type + convergence_id) + tools_dir so
                # invoke_claude_cli can mint a V10.4 cost row gated on
                # the V3.1-D2 _MOCK_MODE_AT_ENTRY frozen sentinel.
                request_envelope=request_envelope,
                tools_dir=tools_dir,
                spawn_control=_spawn_control,
                # ARIA-HIGH-115 — the executor-held identity, for the cost row.
                signer_key_fp=_signer_key_fp,
                # ARIA-HIGH-123 — and its sandbox shape, for the spawn.
                git_containment=_git_containment,
            )
        finally:
            _quarantine_publication = None
            _publication_window_refusal = None
            if _git_containment is not None:
                # ARIA-HIGH-124 (round 3) — the window again, now that the
                # CLI has spent what it spent: what remains must hold the
                # delivery, the terminal writer and the release. A window
                # that cannot is refused BEFORE the quarantine is
                # published, so nothing becomes a branch the retry would
                # collide with; the agent's commit is discarded by name.
                _publication_window_refusal = delivery_admission_refusal(
                    workspace_root=_REPO_ROOT, base_dir=tools_dir,
                    proposal_id=str(_implementation_ids.get("proposal_id") or ""),
                    job_deadline_epoch=float(_deadline_epoch) if _deadline_epoch else None,
                    extra_seconds=QUARANTINE_PUBLICATION_WORST_CASE_SECONDS + _after_delivery_seconds,
                )
                if _publication_window_refusal is None:
                    _quarantine_publication = _publish_sandbox_commits(
                        tools_dir=tools_dir, request_id=request_id, claim_id=claim_id, containment=_git_containment,
                    )
                else:
                    _identity_governance(
                        tools_dir, IMPLEMENTATION_QUARANTINE_DISCARDED_EVENT,
                        {
                            "request_id": request_id, "claim_id": claim_id, "workspace_root": str(_REPO_ROOT),
                            "reason": _publication_window_refusal, "decided": "before_publication",
                        },
                    )
                    _stage(f"implementation_quarantine_discarded reason={_publication_window_refusal}")
                # ARIA-HIGH-124 (round 5) — the agent's commit is over and
                # the quarantine is published (or discarded): the private
                # key and the signing agent have nothing left to sign.
                # Retired HERE, before the result is read and before the
                # delivery, on every exit of the spawn; the keys dir holds
                # only the directory from now on.
                _identity_stack.close()
                _identity_governance(
                    tools_dir, IMPLEMENTATION_IDENTITY_RETIRED_EVENT,
                    {
                        "request_id": request_id, "claim_id": claim_id, "workspace_root": str(_REPO_ROOT),
                        "cycle_id": _identity_cycle_id, "retired": "after_publication",
                        "keys_dir_entries": sorted(
                            path.name for path in _signing_keys_dir(_REPO_ROOT).iterdir()
                        ),
                    },
                )
                _stage("implementation_identity_retired after_publication")
        if cli_exit != 0:
            # Plan 032 Faz 032c — a write-capable spawn that ended non-zero has
            # its LOCAL edits put back from the pre-spawn checkpoint (hand
            # edits preserved). External effects are the recovery classifier's.
            _rollback_after_blocked_spawn(
                tools_dir=tools_dir, request_id=request_id, subagent_type=subagent_type,
                why=f"cli_exit_{cli_exit}",
            )
    except ClaudeAuthFailure as exc:
        # An expired session is not "the agent ran and failed" — nothing ran.
        # It was released as a generic `claude_cli_exit_1` for five consecutive
        # nights (2026-08-04 → 08) while the whole judgment → consensus →
        # calibration → gold-corpus chain stayed empty, because no signal named
        # the cause. The `::error::` is deliberate: this is the one failure a
        # human must clear, and the remedy travels with it.
        sys.stderr.write(
            "::error::aria executor cannot authenticate the agent runtime: "
            + _redact_lease_in_message(str(exc), lease_token)
            + ". No agent ran, so no result was submitted.\n"
        )
        _release_claim(
            tools_dir=tools_dir, repo=repo, claim_id=claim_id,
            agent_id=agent_id, lease_token=lease_token,
            reason=("native_runtime_execution_unavailable" if native_runtime is not None else "claude_cli_auth_failure"),
        )
        return 1
    except ClaudeCreditExhausted as exc:
        # Operator decision 2026-09-12 — a quota exhaustion is a PROVIDER
        # fact, answered by the queue, never by a weaker tier. Three things
        # happen here and nowhere else: (1) on the native lane the provider
        # is cooled for `provider_cooldown_seconds` so the next admission
        # skips it and admits the next vendor for the roles it can serve
        # (`claude auth status` cannot see quota; the ledger row is the only
        # evidence); (2) the claim is released under a reason that NAMES the
        # provider, classified as a harness fault so the request's requeue
        # budget does not burn for a billing event — the request derives
        # REQUEUED and is retried when the provider is back; (3) nothing is
        # submitted, because a usage-limit notice is not an answer
        # (ORPHAN-HIGH-475). ORPHAN-HIGH-489 remains the reason this arm
        # exists at all: a raise with no handler left the claim CLAIMED for
        # the full lease window.
        sys.stderr.write(_redact_lease_in_message(str(exc), lease_token) + "\n")
        if native_runtime is not None:
            from aria_kernel.provider_cooldown import record_provider_cooldown

            record_provider_cooldown(
                tools_dir, provider=exc.provider, model=exc.model,
                cooldown_seconds=native_runtime.policy.provider_cooldown_seconds,
                request_id=request_id, claim_id=claim_id, detection=exc.detail,
            )
        _release_claim(
            tools_dir=tools_dir, repo=repo, claim_id=claim_id,
            agent_id=agent_id, lease_token=lease_token,
            reason=f"provider_quota_unavailable:{exc.provider}",
        )
        return 1
    except ClaudeCliUnavailable as exc:
        sys.stderr.write(_redact_lease_in_message(str(exc), lease_token) + "\n")
        # ORPHAN-HIGH-470 follow-through — this arm is the landing site for
        # every refused spawn: `invoke_claude_cli` re-raises the whole
        # perimeter family (auth / CLI / policy / usage — policy now including
        # the translated `ResourceLimitsUnavailable`) as ClaudeCliUnavailable.
        # It used to `return 1` with the claim still CLAIMED, so a refusal
        # caused by a missing limiter or sandbox blocked the request for the
        # full lease window and the next cycle found nothing to do — strictly
        # worse than the crash it replaced. The CLI-exit and submit-failure arms
        # below both release; this arm now matches them. (An earlier draft of
        # this comment claimed EVERY fail-fast branch in main() releases — a
        # reviewer flagged that as unverified, and it is narrowed here rather
        # than left as a claim nobody checked.) ClaudeCreditExhausted had its
        # own arm carved out above (ORPHAN-HIGH-489 put it here first).
        _release_claim(
            tools_dir=tools_dir, repo=repo, claim_id=claim_id,
            agent_id=agent_id, lease_token=lease_token,
            reason=("native_runtime_execution_unavailable" if native_runtime is not None else "claude_spawn_refused"),
        )
        return 1
    finally:
        # ORPHAN-HIGH-472 — in `finally`, so a run that timed out or was
        # refused still books the time it burned. Recording only successful
        # runs would under-count precisely in the case the ceiling exists to
        # catch: a cycle whose runs keep dying slowly.
        _record_run_wall_clock(
            request=request_envelope,
            tools_dir=tools_dir,
            request_id=request_id,
            seconds=time.monotonic() - _run_started_at,
        )

    if cli_exit != 0:
        sys.stderr.write(f"claude exec exited {cli_exit}\n")
        # Plan ARIA-V7 §2g v2 — release the lease on CLI failure so
        # the claim doesn't sit in CLAIMED state until expiry; the
        # convergence_drainer's poll sees the requeue and either
        # routes to primary_silent verdict OR a later consumer
        # attempts a fresh claim. Pre-V7 leak: CLI exit != 0 kept
        # the claim active, blocking re-claims for the lease window.
        if _spawn_control.cancelled:
            # Plan 032 Faz 032e — the operator stopped it: operator fault
            # domain, terminal state, requeue budget untouched.
            record_cancel_outcome(request_id, outcome=_spawn_control.cancel_signal or "sigterm", base_dir=tools_dir,
                                  detail={"claim_id": claim_id, "cli_exit": cli_exit, "events_seen": _spawn_control.events_seen})
        _release_claim(
            tools_dir=tools_dir, repo=repo, claim_id=claim_id,
            agent_id=agent_id, lease_token=lease_token,
            reason=(OPERATOR_CANCELLED_RELEASE_REASON if _spawn_control.cancelled else
                    "native_runtime_execution_unavailable" if native_runtime is not None else f"claude_cli_exit_{cli_exit}"),
        )
        if native_runtime is not None:
            # ARIA-HIGH-182 — named, not silent: the harness's condition,
            # retryable, so the drain reads a `failed` summary of the host's
            # class instead of a child that said nothing.
            _write_dispatch_summary(
                route=_native_route_for_summary(native_runtime, request_envelope, target_agent=subagent_type),
                request_id=request_id, outcome="failed",
                failure=DispatchFailure(failure_class="harness_unavailable", retryable=True,
                                        detail_code="native_runtime_execution_unavailable",
                                        phase="runtime", exit_code=cli_exit),
                exit_code=cli_exit,
            )
        return 1

    _stage(f"claude_returned_exit={cli_exit} request_id={request_id} role={request_envelope.get('role')}")
    if _publication_window_refusal is not None:
        # (round 3) the quarantine was discarded above: no branch exists,
        # the retry stands on it again. Released harness-class, the
        # summary says the host's window refused, no result is read.
        sys.stderr.write(f"{DELIVERY_WINDOW_REFUSAL.release_reason}: {_publication_window_refusal} (before the publication)\n")
        _release_claim(
            tools_dir=tools_dir, repo=repo, claim_id=claim_id,
            agent_id=agent_id, lease_token=lease_token,
            reason=DELIVERY_WINDOW_REFUSAL.release_reason,
        )
        return _refuse_dispatch(
            request=request_envelope, request_id=request_id, target_agent=subagent_type,
            reason=DELIVERY_WINDOW_REFUSAL.release_reason,
            failure_class=DELIVERY_WINDOW_REFUSAL.failure_class,
            retryable=DELIVERY_WINDOW_REFUSAL.retryable,
        )

    # Plan ARIA-V8.13 — agent refusal as first-class terminal outcome.
    # When the agent emits `aria/agent-refusal/v1` (legitimate refusal
    # for insufficient evidence, scope conflict, content_hash mismatch,
    # etc.), pre-V8.13 ci_executor treated the refusal envelope as a
    # normal submit attempt: the canonical schema check failed
    # (`plan_content:absent_or_not_object`), the consumer requeued,
    # the agent refused again, and after N retries the request landed
    # in HUMAN_REQUIRED — burning ~3× $0.35 Opus tokens per refusal.
    #
    # V8.13 detects the refusal envelope in agent_text + dispatches
    # `aria_kernel human-required record` immediately, releases the
    # claim with `reason=agent_refused:<class>`, and returns 0 so the
    # consumer does NOT retry. The kernel state machine recognizes
    # the human_required event as terminal (line 596 of
    # agent_invocations.py). The drainer's poll observes no state
    # transition and times out as usual — verdict=challenger_unavailable
    # — but Opus cost stays at 1× per refusal instead of N×.
    try:
        _envelope_for_validation = json.loads(expected_output_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as _exc:
        _envelope_for_validation = None
    # Refusal detection: look at the agent's raw text body, NOT the
    # ci_executor-built outer wrapper. The agent's refusal JSON is
    # nested inside `details.agent_text`. We parse the embedded JSON
    # block ourselves to spot the `$schema = aria/agent-refusal/v1`
    # marker independently of the outer envelope's claimed schema.
    if isinstance(_envelope_for_validation, dict):
        _agent_text = (_envelope_for_validation.get("details") or {}).get("agent_text") or ""
        _inner_refusal = _extract_envelope_json(_agent_text) if isinstance(_agent_text, str) else None
        if isinstance(_inner_refusal, dict) and (
            _inner_refusal.get("$schema") == "aria/agent-refusal/v1"
            or _inner_refusal.get("envelope") == "aria/agent-refusal/v1"
            or _inner_refusal.get("schema") == "aria/agent-refusal/v1"
        ):
            _reason_class = str(_inner_refusal.get("reason_class") or "unspecified")
            _reason_summary = str(
                _inner_refusal.get("reason_summary")
                or _inner_refusal.get("reason")
                or "agent refused without summary"
            )[:500]
            _stage(f"agent_refusal_detected class={_reason_class!r} request_id={request_id}")
            # Persist HUMAN_REQUIRED through the kernel's recorder (one
            # recorder, shared with the delivery refusals — ARIA-HIGH-124)
            # so the operator sees the structured triage row and the state
            # machine marks the request terminal from the release below.
            # The agent's own summary is free text of the agent's: it rides
            # the record's structured context, never the reason the
            # notification channels carry (data minimisation, the CLI
            # validator's purpose, kept without the validator).
            try:
                _record_human_required(
                    tools_dir=tools_dir, request_id=request_id, severity="MEDIUM",
                    reason=f"agent_refused:{_reason_class}: the agent refused the request; its summary is on the record",
                    context={"code": f"agent_refused:{_reason_class}", "stage": "agent_refusal",
                             "claim_id": claim_id, "reason_class": _reason_class, "reason_summary": _reason_summary},
                )
            except HumanRequiredRecordUnavailable as record_error:
                return _release_unescalated(
                    tools_dir=tools_dir, repo=repo, request=request_envelope, request_id=request_id,
                    target_agent=subagent_type, claim_id=claim_id, agent_id=agent_id, lease_token=lease_token,
                    escalation_reason=f"agent_refused:{_reason_class}", phase="submit", error=record_error,
                )
            # Release the claim so downstream observers see the
            # explicit `agent_refused:<class>` reason rather than the
            # generic `plan_content_invalid` rejection that pre-V8.13
            # surfaced. The release_claim helper also takes care of
            # lease-token discipline + governance attribution.
            _release_claim(
                tools_dir=tools_dir, repo=repo, claim_id=claim_id,
                agent_id=agent_id, lease_token=lease_token,
                reason=f"agent_refused:{_reason_class}",
            )
            # Refusal is a legitimate terminal — not a build failure, and not
            # a success either: invoke_claude_cli's summary said "succeeded"
            # (the CLI ran to completion); this later terminal supersedes it
            # so the drain never counts a refused envelope as drained. The
            # agent-supplied class stays out of the summary (it is sanitized
            # by construction); the release reason and the HUMAN_REQUIRED
            # row carry it.
            return _refuse_dispatch(
                request=request_envelope, request_id=request_id, target_agent=subagent_type,
                reason="agent_refused",
            )
    if isinstance(_envelope_for_validation, dict):
        # Plan ARIA-V8.4 — auto-fill missing canonical plan_content
        # fields from compatible sources within the envelope before
        # validation runs. The agent's substantive output stays
        # untouched; only bookkeeping fields the agent dropped get
        # populated (e.g. evidence_refs copied from top-level when
        # plan_content omitted it). The normalizer never fabricates
        # evidence — it only mirrors values already present.
        _mutated = _canonicalize_plan_content(_envelope_for_validation)
        # V8.7 + V8.19 — same canonicalization pattern for cross_review.
        # V8.19: pass request_envelope so reviewer_agent fallback uses
        # request.target_agent (kernel-trustworthy "aria-cross-reviewer")
        # instead of the outer envelope's executor identity.
        _mutated_cr = _canonicalize_cross_review(
            _envelope_for_validation,
            request_envelope=request_envelope,
        )
        # V8.8 + V8.15 — auto-fill missing satisfaction_matrix verdicts
        # AND missing entry ids (position-match against must_satisfy).
        _mutated_sm = _canonicalize_satisfaction_matrix(
            _envelope_for_validation,
            must_satisfy=request_envelope.get("must_satisfy") or [],
        )
        # ARIA-HIGH-115 — the signer fingerprint is a kernel fact stamped by
        # the executor that holds the key; a value the agent wrote is
        # replaced, and a differing one recorded, never trusted.
        _mutated_signer = False
        if implementation_identity is not None:
            from aria_kernel.implementation_identity import stamp_implementation_signer

            _mutated_signer = stamp_implementation_signer(
                _envelope_for_validation, fingerprint=implementation_identity.fingerprint,
                request_id=request_id, claim_id=claim_id, base_dir=tools_dir,
            )
        # ARIA-HIGH-124 — the implementation is DELIVERED here, by this
        # process, outside the sandbox: the apply gate at the published
        # branch's HEAD in the request worktree, the push with the held
        # credential, the PR through the one sanctioned opener — and the
        # kernel's facts (pr_url, pr_number, branch_tip_sha, base_branch_sha,
        # diff_hash, the gate ref, the recorded runs) stamped on the record
        # the bridge reads; a value the agent wrote is replaced and a
        # differing one recorded. A refusal at any stage is by name,
        # escalated for a person and released request-class: the published
        # branch makes a retry collide, so nothing is gained by one.
        _mutated_delivery = False
        if implementation_identity is not None:
            from aria_kernel.implementation_delivery import (
                HOST_STAGES,
                IMPLEMENTATION_DELIVERED_EVENT,
                IMPLEMENTATION_DELIVERY_REFUSED_EVENT,
                ImplementationDeliveryRefusal,
                deliver_implementation,
                stamp_implementation_delivery,
            )
            from aria_kernel.tool_registry import append_tools_governance as _delivery_governance

            try:
                _delivery = deliver_implementation(
                    request_id=request_id, claim_id=claim_id, agent_id=agent_id,
                    cycle_id=str(request_envelope.get("cycle_id") or ""),
                    # ARIA-HIGH-124 (round 4) — the identity this process
                    # HOLDS for the request: the delivery verifies the
                    # published tip against it before it pushes anything,
                    # with the same verifier the submit's bridge runs. The
                    # push and the PR used to happen first and the bridge
                    # refuse the same commit afterwards, leaving a live PR
                    # on a plan that stayed IMPLEMENTATION_REQUESTED.
                    signer_key_fp=implementation_identity.fingerprint,
                    implementation_ids=_staged_implementation_ids(tools_dir=tools_dir, request_id=request_id),
                    workspace_root=_REPO_ROOT, base_dir=tools_dir, publication=_quarantine_publication,
                    # (round 6) the profile whose grant the delivery mints
                    # its credential under — INSIDE the delivery, after
                    # the gate, for the push and the PR alone; this
                    # process holds no lease across the spawn.
                    profile=_delivery_profile,
                    # (round 5) the envelope this process will SUBMIT, as
                    # it stands — canonicalized, the signer stamped — and
                    # its path: the delivery decides it the way the submit
                    # will BEFORE it spends the credential, and reads the
                    # one delivery fact the agent contributes (its
                    # dispositions for intended files it left untouched)
                    # off the same record.
                    envelope=_envelope_for_validation, output_path=expected_output_path,
                    # (round 3) the delivery's own admission reads the job
                    # window; the executor decided it before the publication.
                    job_deadline_epoch=float(_deadline_epoch) if _deadline_epoch else None,
                )
            except ImplementationDeliveryRefusal as exc:
                _delivery_governance(tools_dir, IMPLEMENTATION_DELIVERY_REFUSED_EVENT, {
                    "request_id": request_id, "claim_id": claim_id, "stage": exc.stage, "reason": exc.reason[:500],
                    "workspace_root": str(_REPO_ROOT),
                })
                _stage(f"implementation_delivery_refused stage={exc.stage} reason={exc.reason[:200]!r}")
                if exc.stage in HOST_STAGES:
                    # (round 3) the host's window or sandbox, decided after
                    # the publication, and (round 6) the lane's credential
                    # source at the moment of the push: harness-class, no
                    # escalation — the request keeps its budget; the
                    # published branch makes the retry collide, which IS
                    # escalated, by name.
                    _release_claim(
                        tools_dir=tools_dir, repo=repo, claim_id=claim_id,
                        agent_id=agent_id, lease_token=lease_token,
                        reason=DELIVERY_WINDOW_REFUSAL.release_reason,
                    )
                    return _refuse_dispatch(
                        request=request_envelope, request_id=request_id, target_agent=subagent_type,
                        reason=DELIVERY_WINDOW_REFUSAL.release_reason,
                        failure_class=DELIVERY_WINDOW_REFUSAL.failure_class,
                        retryable=DELIVERY_WINDOW_REFUSAL.retryable,
                    )
                try:
                    _record_human_required(
                        tools_dir=tools_dir, request_id=request_id, severity="HIGH",
                        reason=f"implementation_delivery_refused:{exc.stage}: {exc.reason[:400]}",
                        context={
                            "code": f"implementation_delivery_refused:{exc.stage}", "stage": exc.stage,
                            "detail": exc.reason[:1000], "claim_id": claim_id,
                            "branch": _staged_implementation_ids(tools_dir=tools_dir, request_id=request_id).get("branch"),
                            "base_sha": _staged_implementation_ids(tools_dir=tools_dir, request_id=request_id).get("base_sha"),
                        },
                    )
                except HumanRequiredRecordUnavailable as record_error:
                    return _release_unescalated(
                        tools_dir=tools_dir, repo=repo, request=request_envelope, request_id=request_id,
                        target_agent=subagent_type, claim_id=claim_id, agent_id=agent_id, lease_token=lease_token,
                        escalation_reason=f"implementation_delivery_refused:{exc.stage}", phase="submit", error=record_error,
                    )
                _release_claim(
                    tools_dir=tools_dir, repo=repo, claim_id=claim_id,
                    agent_id=agent_id, lease_token=lease_token,
                    reason=f"implementation_delivery_refused:{exc.stage}",
                )
                return _refuse_dispatch(
                    request=request_envelope, request_id=request_id, target_agent=subagent_type,
                    reason="implementation_delivery_refused",
                )
            _mutated_delivery = stamp_implementation_delivery(
                _envelope_for_validation, delivery=_delivery, request_id=request_id, claim_id=claim_id,
                base_dir=tools_dir,
            )
            _delivery_governance(tools_dir, IMPLEMENTATION_DELIVERED_EVENT, {
                "request_id": request_id, "claim_id": claim_id, "branch": _delivery.branch,
                "branch_tip_sha": _delivery.branch_tip_sha, "base_branch_sha": _delivery.base_branch_sha,
                "pr_number": _delivery.pr_number, "pr_url": _delivery.pr_url,
                "validation_gate_ref": _delivery.validation_gate_ref,
                "validation_runs": len(_delivery.validation_results),
            })
            _stage(f"implementation_delivered branch={_delivery.branch} pr={_delivery.pr_number} tip={_delivery.branch_tip_sha}")
        if _mutated or _mutated_cr or _mutated_sm or _mutated_signer or _mutated_delivery:
            _stage(
                f"canonicalize auto-filled plan_content={_mutated} "
                f"cross_review={_mutated_cr} satisfaction_matrix={_mutated_sm} "
                f"implementation_signer={_mutated_signer} implementation_delivery={_mutated_delivery}"
            )
            try:
                _write_sanitized_envelope(expected_output_path, _envelope_for_validation)
            except OSError as _exc:
                _stage(f"canonicalize_write_failed: {_exc}")
        _role_for_validation = str(request_envelope.get("role") or "")
        validation_errors = _pre_submit_validate_envelope(
            _envelope_for_validation,
            role=_role_for_validation,
            request=request_envelope,
            tools_dir=tools_dir,
        )
        if validation_errors:
            _stage(f"pre_submit_validation_FAILED errors={validation_errors}")
            sys.stderr.write(
                f"plan_content_pre_submit_rejected: {','.join(validation_errors)}\n"
            )
            # Y5 (ORPHAN-706) — a judge contract violation is a HARNESS-class
            # release (the malformed output says nothing about the request;
            # re-judging usually succeeds), with the field-level errors in
            # the log line above so the operator sees WHICH field was wrong.
            # Plan-content violations keep their request-fault pricing.
            from aria_kernel.self_change_bridge import (
                SELF_CHANGE_CONTRACT_RELEASE_REASON,
                is_self_change_request as _is_self_change_request,
            )

            from aria_kernel.agent_surface import JUDGE_ROLES as _gated_judge_roles
            if _role_for_validation in _gated_judge_roles:
                # ARIA-MEDIUM-166 — the arbiter is gated with the judges and
                # released under the same harness-class reason.
                _release_reason = "judge_verdict_contract_violation"
            elif _is_self_change_request(request_envelope):
                # B6 — same harness-class pricing as the judge contract: a
                # missing `details.problem` says nothing about the mission.
                _release_reason = SELF_CHANGE_CONTRACT_RELEASE_REASON
            else:
                _release_reason = f"plan_content_invalid:{','.join(validation_errors)[:160]}"
            _release_claim(
                tools_dir=tools_dir, repo=repo, claim_id=claim_id,
                agent_id=agent_id, lease_token=lease_token,
                reason=_release_reason,
            )
            # ORPHAN-HIGH-737 — a REFUSED envelope is this executor doing its
            # job, not failing it: the contract caught a malformed agent
            # output, the claim is released above, the request stays pending
            # with its Y1 retry budget, and the reason is in the ledger. The
            # two sibling refusal arms already say so in their own comments
            # ("refusal is a legitimate terminal — not a build failure",
            # "a budget signal, NOT a build failure"); this one returned 1
            # and, through the drain's `0 if failed == 0 else 1`, painted a
            # 10-of-11 night RED — the honest-partial-red class ORPHAN-716
            # closed for the meta-watchdog, still open here.
            # B8 — and not a SUCCESS: the CLI's own summary said "succeeded";
            # this later terminal supersedes it with the refusal, named by
            # the same code family as the release reason (the field-level
            # errors are in the stage line above, not in the summary).
            return _refuse_dispatch(
                request=request_envelope, request_id=request_id, target_agent=subagent_type,
                reason=_release_reason.split(":", 1)[0],
            )
        _stage("pre_submit_validation_passed")

    _stage("submit_step_begin claim=" + claim_id)
    # Step 4 — submit through the kernel CLI; lease-token via env var.
    # ORPHAN-HIGH-081 — bounded timeout + survivable claim release on hang.
    if not transcript_output_path.exists():
        transcript_output_path.parent.mkdir(parents=True, exist_ok=True)
        transcript_output_path.write_text(
            json.dumps(
                {
                    "schema_version": "aria/ci-executor-transcript/v1",
                    "mode": "fallback-empty-transcript",
                    "request_id": request_id,
                    "claim_id": claim_id,
                    "agent_id": agent_id,
                },
                sort_keys=True,
            )
            + "\n",
            encoding="utf-8",
        )
    _transcript_hash = "sha256:" + hashlib.sha256(transcript_output_path.read_bytes()).hexdigest()
    # ARIA-HIGH-022 — implementer agents cite the POST-FIX lines of files
    # they changed; graded against the request's base SHA every genuine fix
    # was worktree_candidate and the submit died. Ground the evidence check
    # at this worktree's committed HEAD when it has moved past the request
    # base — submit_claim_result proves the descent fail-closed.
    try:
        submit_proc = _submit_via_cli(
            claim_id=claim_id, agent_id=agent_id, lease_token=lease_token,
            expected_output_path=expected_output_path, repo=repo, tools_dir=tools_dir,
            request_envelope=request_envelope, transcript_hash=_transcript_hash,
            transcript_output_path=transcript_output_path,
        )
    except subprocess.TimeoutExpired as exc:
        _stage(f"submit_TIMEOUT after={SUBMIT_RESULT_TIMEOUT_SECONDS}s — releasing claim survivably")
        sys.stderr.write(
            f"submit-result hung past {SUBMIT_RESULT_TIMEOUT_SECONDS}s; "
            f"partial stdout={(exc.stdout or '')[:200]!r} "
            f"partial stderr={_redact_lease_in_message(exc.stderr or '', lease_token)[:200]!r}\n"
        )
        _release_claim(
            tools_dir=tools_dir, repo=repo, claim_id=claim_id,
            agent_id=agent_id, lease_token=lease_token,
            reason=f"submit_timeout_{SUBMIT_RESULT_TIMEOUT_SECONDS}s",
        )
        return _fail_submit_dispatch(
            request=request_envelope, request_id=request_id, target_agent=subagent_type,
            failure_class="timeout", retryable=True, detail_code="submit_timeout",
        )
    _stage(f"submit_step_done rc={submit_proc.returncode}")
    if submit_proc.returncode != 0:
        # STDOUT as well as stderr, and this is the whole point: the kernel CLI
        # prints a refusal as JSON on STDOUT and returns nonzero, leaving
        # stderr EMPTY. Forwarding only stderr produced a log that said
        # `submit_step_done rc=1` and nothing else — on 2026-08-09 the actual
        # reason (44 evidence refs rejected) was only readable by pulling the
        # result row out of the aria/state branch afterwards.
        #
        # Same defect class as the swallowed CLI error one step earlier: a
        # failure that reports its existence but not its cause costs a full
        # round trip every time, and it cost days here.
        detail = "\n".join(
            part
            for part in (submit_proc.stdout or "", submit_proc.stderr or "")
            if part.strip()
        ) or "(the submit step produced no output on either stream)"
        sys.stderr.write(
            "::error::aria executor could not submit the agent result: "
            + _redact_lease_in_message(detail, lease_token)
            + "\n"
        )
        # Three refusals arrive here, and WHICH one decides both whether the
        # claim is still live and whether the request's requeue budget is
        # charged. A rejection the kernel issued only because its own evidence
        # probes could not run says nothing about the work: the kernel appends
        # no result row for that class (`_prepared_claim_rejection`), the claim
        # is live, and it is released as the harness's fault so the request
        # goes back to PENDING without spending its budget on the host's load.
        # A REJECTED result row is the kernel's own terminal effect on the
        # claim: the request derives REJECTED from it and `release_claim`
        # refuses with `result already terminal` — measured on the first live
        # managed-Claude cross-review (2026-09-11, ARIA-HIGH-078), where the
        # release failed after every rejection and reported a CLAIMED leak that
        # did not exist. A refusal BEFORE any row (lease, transport, argparse)
        # leaves a live claim, released like every other failure path here.
        if _rejected_only_for_verification_unavailable(submit_proc.stdout or ""):
            _stage("submit_rejected_for_verification_unavailable — releasing as harness fault")
            _release_claim(
                tools_dir=tools_dir, repo=repo, claim_id=claim_id,
                agent_id=agent_id, lease_token=lease_token,
                reason="evidence_verification_unavailable",
            )
            return _fail_submit_dispatch(
                request=request_envelope, request_id=request_id, target_agent=subagent_type,
                failure_class="harness_unavailable", retryable=True, detail_code="evidence_verification_unavailable",
            )
        if _rejected_result_recorded(submit_proc.stdout):
            _stage("submit_rejected_recorded: the kernel appended the rejected result row; "
                   "the claim is terminal and the request derives REJECTED")
            return _fail_submit_dispatch(
                request=request_envelope, request_id=request_id, target_agent=subagent_type,
                failure_class="response_schema_rejected", retryable=False, detail_code="agent_result_rejected",
            )
        else:
            _release_claim(
                tools_dir=tools_dir, repo=repo, claim_id=claim_id,
                agent_id=agent_id, lease_token=lease_token,
                reason="submit_rejected",
            )
            return _fail_submit_dispatch(
                request=request_envelope, request_id=request_id, target_agent=subagent_type,
                failure_class="response_schema_rejected", retryable=False, detail_code="submit_rejected",
            )
    if native_runtime is not None:
        if not _reconcile_native_result(
            tools_dir=tools_dir, request_id=request_id, claim_id=claim_id, agent_id=agent_id,
            session_id=_session_id, policy_digest=native_runtime.policy.policy_digest,
            request_envelope=request_envelope,
        ):
            return 1
        # ARIA-HIGH-182 — the native paths' one success summary. The Claude
        # CLI path emits its `succeeded` summary inside invoke_claude_cli;
        # the native runtimes (Z.ai, Codex, native Claude) returned 0 here
        # with none, and the drain — whose ONLY evidence of success is the
        # summary (B8) — counted every accepted native verdict as
        # `child_without_summary`: the first drain after ARIA-HIGH-180
        # (run 35509466473) folded 26 adversarial judgments and reported
        # attempted=30 succeeded=1 failed=26 harness_failed=26, red.
        _write_dispatch_summary(
            route=_native_route_for_summary(native_runtime, request_envelope, target_agent=subagent_type),
            request_id=request_id, outcome="succeeded", failure=None, exit_code=0,
        )
    return 0


def main(argv: list[str] | None = None) -> int:
    with _ExitStack() as runtime_stack:
        return _main(argv, _runtime_stack=runtime_stack)


if __name__ == "__main__":
    raise SystemExit(main())
