"""ARIA-HIGH-124 — the implementation is delivered by the executor, outside the agent's sandbox.

WHY this module exists
----------------------
The implementer's contract had the AGENT push its branch, run
``python3 -m aria_kernel apply gate`` and ``python3 -m aria_kernel pr
create`` inside its own sandbox. All three read and write the durable
state store, which is not mounted in the sandbox (ARIA-HIGH-123, on
purpose): each command bootstrapped a phantom store and failed to find its
proposal. None of them ever worked in the production sandbox; the end-to-end
pins carried ``pr_url`` as a fixture constant; the executor lane could not
open a PR. Kernel authority exercised inside the agent's sandbox is unsound
regardless of the mount — ``python3 -m aria_kernel`` resolves the package
from the agent's cwd first, and the delivery token had to ride the spawn's
environment for the push to work at all.

WHAT this module does
---------------------
It gives the executor child — the process that holds the store, the
request, the identity and the delivery credential as its own facts — the
whole delivery, after the spawn and after the quarantine's publication
(``git_containment.publish_quarantine``), against the PUBLISHED branch in
the request worktree:

0a. the commit's identity (round 4): the published tip must verify
   against the key THIS request's executor minted and registered
   (``plan_convergence_bridge.verify_implementation_commit`` — the one
   verifier the submit's bridge runs, here BEFORE anything external).
   The delivery used to push the branch to ``origin`` under the App's
   identity and open the ``[ARIA-AUTO]`` PR, and only then did the
   bridge refuse the same commit ``commit_signature_unverified``: the
   request derived a non-terminal state, the plan stayed
   ``IMPLEMENTATION_REQUESTED``, and a live PR nobody owned stood on a
   branch a later cycle could duplicate. A commit signed with a key the
   agent made (``git commit -m x --gpg-sign=<its own key>`` passed the
   command policy until round 4) is now refused
   ``commit_identity:commit_unverified``, escalated, with nothing
   pushed and no ``gh``;
0b. the admission (round 3): the job's remaining wall clock
   (``ARIA_JOB_DEADLINE_EPOCH``) must hold the delivery's worst case
   (``delivery_worst_case_seconds`` off the staged action's suite — the
   ONE derivation the drain's start check and the executor's pre-spawn
   reservation read), and the validation sandbox must be buildable for
   every staged command — refused by name (``deadline_insufficient``,
   ``sandbox_unavailable:…``) before a command runs, a row is written or
   anything is pushed;
1. the change ledger's scope verdict (``change_ledger.verify_change_scope``,
   round 3 — BEFORE the suite executes): the files the diff
   ``base_sha..tip`` actually touched against the plan's intended surfaces,
   the agent's declared dispositions for intended files it left untouched
   (``details.implementation.uncovered_intended_dispositions``, the one
   thing the agent contributes here). A file outside the planned scope
   (``scope_drift_requires_human``) or an undeclared shortfall
   (``implementation_incomplete_undeclared``) refuses the delivery by name
   before the tip's own code is ever executed;
1a. the patch's secret scan (round 6): the branch's whole diff through
   ``implementation_safety.verify_no_secret_in_diff`` — the check the
   contract used to ask the AGENT to run (a Python function it cannot
   execute) and that no production path ran on a diff, so a committed
   secret reached GitHub; refused ``result_admissible:diff_secret_shaped``
   by name before the suite, the push and the PR;
1b. the RESULT's admissibility (round 5): the kernel's own decision on the
   envelope — ``agent_invocations.judge_claim_submission``, the ONE chain
   ``submit_claim_result`` applies (the schema and the matrix against the
   request, separation of duties, the secret scan, the evidence refs
   graded at the worktree's HEAD the publication adopted — the reading
   ``--evidence-target-sha auto`` takes —, the declared route, the
   compliance grade), asked here against the published tip BEFORE the
   suite runs and before any authority is spent. Until round 5 nothing
   before the delivery decided the envelope: a commit signed by the held
   key, in scope and gate-green, whose evidence cited a line the file does
   not have, got the push and the ``[ARIA-AUTO]`` PR and was then
   rejected by the submit (``agent_evidence_line_missing``; the
   2026-08-09 run rejected 44 refs the same way) — a terminal REJECTED
   request, a plan left ``IMPLEMENTATION_REQUESTED``, a live PR nobody
   owned. Refused ``result_admissible:result_rejected:<codes>`` by name,
   escalated request-class, nothing pushed, no ``gh``; a decision the
   kernel could not reach (every code a verification-unavailable one) is
   the host's and refuses at the ``admission`` stage;
2. the apply gate (``apply_engine.run_apply_gate``): the canonical suite
   and the plan's declared recipes run at the branch HEAD in the worktree,
   CONTAINED (round 3: every command through
   ``implementation_safety.wrap_validation_in_sandbox`` — the same bwrap
   builder the containment probe and the agent's spawn use — with the
   READONLY_PATHS read-only, the git dirs read-only, no network, no broker,
   the store and the code root not mounted; the suite is the AGENT's
   committed code and used to run unconfined as the executor's uid, with
   the store, the shared repository, the code root and ``$HOME`` writable
   to it), recorded on the validation-runs ledger by this process from the
   contained child's output, compared against the staged baseline, and the
   action promoted to ``ready_for_pr`` with the ``validation_gate_ref`` the
   PR opener demands. The recorded runs — the agent's own output,
   hash-bound on the validation-runs ledger and carried by the stamp — are
   then scanned with the submit's own scanner (round 5,
   ``implementation_safety.verify_no_secret_in_envelope`` over the
   ``validation_results`` the stamp will carry): a secret-shaped string in
   the suite's output refuses ``apply_gate:gate_output_secret_shaped``
   here, before the push. Until round 5 the executor's artifact scrub hid
   such a string from the SUBMITTED envelope while the ledger's log kept
   it raw, so the submit's scan never saw what the ledger carried and the
   PR landed;
3. the change ledger's commit row (``change_ledger.emit_change_committed``,
   round 2; the same verdict as step 1, now written with the claim id).
   The contract used to tell the AGENT to call ``emit_change_committed(...)``
   — a Python function of the kernel it cannot execute — so no
   executor-lane implementation ever had a ``change_committed`` row and
   the merge gate refused every one of them
   (``triple_gate_change_committed_missing``);
4. the credential (round 6): the delivery lease is minted HERE — after
   the gate, inside the window it is consumed in
   (``delivery_credentials.hold_delivery_credentials``, ``covers_seconds``
   = the push and the PR opener at their bounds) — and revoked the moment
   the PR is open. Until round 6 the ONE lease was minted by the executor
   BEFORE the spawn and first consumed here, after the spawn, the
   publication, the decisions and the contained gate — up to
   ``IMPLEMENTATION_DELIVERY_WORST_CASE_SECONDS`` later — while a GitHub
   App installation token lives exactly one hour whatever the mint asks:
   in Mode A (the mode the runbook requires) every implementation whose
   spawn and suite ran past ~55 minutes pushed with a dead token,
   ``push_failed:rc=128``, and was escalated as the REQUEST's fault. A
   lease the lane cannot mint now, or whose provider horizon cannot cover
   the window, refuses ``credential:credential_unavailable:…`` by name —
   the HOST's (``HOST_STAGES``), released harness-class like the
   admission; the pre-spawn admission (``admit_delivery_credentials``)
   already refused a lane that cannot mint before any turn;
5. the push of the ``aria-impl-*`` branch to ``origin``, with the delivery
   credential's environment applied to that ONE git subprocess (the token
   never enters the sandbox; the agent has no push to make);
6. the PR, through ``pr_manager.open_pr_for_action`` (base guard,
   GATE_PRE_PR_OPEN, the change-id anchor, intent + receipt keyed on the
   request), the credential applied to that ONE ``gh`` subprocess, bounded
   at ``pr_manager.GH_PR_CREATE_TIMEOUT_SECONDS``;
7. the stamp: ``pr_url``, ``pr_number``, ``branch``, ``branch_tip_sha``,
   ``base_branch_sha``, ``diff_hash``, ``validation_gate_ref`` and
   ``validation_results`` are written on the result's outcome record by
   the KERNEL (``stamp_implementation_delivery``, the way ARIA-HIGH-115
   stamps ``signer_key_fp``); a value the agent supplied is overwritten and
   a differing one recorded (``implementation_delivery_overridden``), never
   trusted.

A refusal at any stage is by name (``ImplementationDeliveryRefusal``:
``stage`` ∈ ``DELIVERY_STAGES``, ``reason``) and leaves the plan where the
envelope mint left it; the executor records it, escalates to
HUMAN_REQUIRED and releases the claim under a request-class reason — a
retry cannot deliver the same branch again (``implementation_branch_exists``
refuses the next attempt before a turn is spent), so a person decides. The
``admission`` and ``credential`` stages (``HOST_STAGES``) are the
exception: they say nothing about the request (the host's window, the
host's sandbox, the lane's credential source), so the executor releases
them harness-class (``implementation_delivery_unavailable``) — and decides
the window BEFORE it publishes the quarantine, so a spawn whose delivery
could not fit leaves no branch and its retry stands on the branch again.

The executor's own git subprocesses here and in the publication run with
git's hooks OFF (``git_containment.KERNEL_GIT_NO_HOOKS_ARGS``): the push
runs in the request worktree, whose hooks resolve through the shared
checkout's config — a ``core.hooksPath`` a runner install could set
(`npm run hooks:install`, an `npm ci` without `--ignore-scripts`) would run
a `.husky/pre-push` from the AGENT's tree as the executor, with the
delivery credential in its environment.
"""
from __future__ import annotations

import hashlib
import math
import os
import subprocess
import time
from contextlib import ExitStack
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence

from .delivery_credentials import (
    DELIVERY_CREDENTIAL_CONSUMPTION_SECONDS,
    DELIVERY_CREDENTIAL_WORST_CASE_SECONDS,
    DeliveryCredentialError,
    hold_delivery_credentials,
)
from .git_containment import (
    KERNEL_GIT_NO_HOOKS_ARGS,
    QUARANTINE_PUBLICATION_WORST_CASE_SECONDS,
    GitContainmentRefusal,
    QuarantinePublication,
    _publish_environment,
    derive_git_containment,
)
from .evidence_probe import EVIDENCE_VERIFICATION_LIVENESS_SECONDS
from .implementation_safety import (
    CANONICAL_VALIDATION_TIMEOUT_MS,
    COMMIT_SIGNATURE_VERIFY_TIMEOUT_SECONDS,
    SandboxUnavailable,
    SecretLeakDetected,
    verify_no_secret_in_diff,
    verify_no_secret_in_envelope,
    wrap_validation_in_sandbox,
)
from .pr_manager import GH_PR_CREATE_TIMEOUT_SECONDS
from .state_store import GIT_TIMEOUT_SECONDS as _GIT_TIMEOUT_SECONDS
from .validation import SpawnWrapper, parse_allowed_command
from .validation_env import build_validation_env
from .tool_registry import GovernanceError as GovernanceErrorType
from .validation_suite import CANONICAL_VALIDATION_COMMANDS_EXECUTABLE

# The closed vocabulary of where a delivery can be refused, in the order the
# stages run: the publication's facts (reads), the tip's IDENTITY (round 4:
# the one verifier the bridge runs, before any external effect), then the
# `admission` (round 3: the window and the sandbox, decided before anything
# executes), the scope verdict, the RESULT's admissibility (round 5: the
# submit's own decision on the envelope, before the suite runs and before
# any authority is spent), the contained gate, the credential (round 6:
# minted after the gate, for the push and the PR), the push, the PR.
DELIVERY_STAGES: tuple[str, ...] = (
    "branch_publication", "commit_identity", "admission", "change_ledger", "result_admissible",
    "apply_gate", "credential", "push", "pr_open",
)
# The stage that decides whether the tip is the kernel's own commit — the
# gate every external effect below it stands on (round 4).
COMMIT_IDENTITY_STAGE = "commit_identity"
# The stage that decides whether the kernel WILL ACCEPT the envelope
# (round 5): the submit's decision chain, run in-process against the
# published tip. A refusal here is the request's (the agent's evidence,
# its matrix, its body) and is escalated like every stage but `admission`.
RESULT_ADMISSIBLE_STAGE = "result_admissible"
# The stage whose refusals are the HOST's (the window, the sandbox), never
# the request's: the executor releases them harness-class.
ADMISSION_STAGE = "admission"
# The stage that mints the delivery credential where it is consumed (round
# 6): a lane that cannot mint, or a provider horizon that cannot cover the
# push and the PR, is the HOST's too.
CREDENTIAL_STAGE = "credential"
HOST_STAGES: tuple[str, ...] = (ADMISSION_STAGE, CREDENTIAL_STAGE)
# The one field of the delivery the AGENT contributes (round 2): a sentence
# per intended file it deliberately left untouched, read off the outcome
# record and written on the change ledger's commit row by the executor.
AGENT_DISPOSITIONS_FIELD = "uncovered_intended_dispositions"
# Governance rows.
IMPLEMENTATION_DELIVERED_EVENT = "implementation_delivered"
IMPLEMENTATION_DELIVERY_REFUSED_EVENT = "implementation_delivery_refused"
IMPLEMENTATION_DELIVERY_OVERRIDDEN_EVENT = "implementation_delivery_overridden"
# The outcome-record fields the kernel stamps: the agent cannot know them
# (the PR, the gate) or is not trusted for them (the tip, the diff, the base).
KERNEL_STAMPED_DELIVERY_FIELDS: tuple[str, ...] = (
    "branch", "branch_tip_sha", "base_branch_sha", "diff_hash", "pr_url", "pr_number",
    "validation_gate_ref", "validation_results",
)
_PUSH_REMOTE = "origin"
# The git subprocesses `deliver_implementation` runs, each at the store's git
# cap: the tip's `rev-parse`, `diff --name-only` (the scope verdict), the
# push, and `diff` (the stamp's hash).
DELIVERY_GIT_CALLS = 4
# The `commit_identity` stage's own bounded subprocess: one `git
# verify-commit` (round 4). Its registry read and anchor write are work,
# charged to the allowance below.
DELIVERY_COMMIT_IDENTITY_SECONDS = COMMIT_SIGNATURE_VERIFY_TIMEOUT_SECONDS
# The `result_admissible` stage's own bound (round 5): ONE acceptance
# decision's probe wall clock (`evidence_probe.GitProbeSession` — the
# evidence target's resolution and descent proof, every ref's grade), the
# same term the executor's submit wall clock is derived from. The pure
# checks around it (the schema, the matrix, the secret scan, the grade)
# are work, charged to the allowance below.
DELIVERY_RESULT_ADMISSIBLE_SECONDS = int(EVIDENCE_VERIFICATION_LIVENESS_SECONDS)
# The delivery's own work beside its bounded subprocesses: the gate's ledger
# reads and appends, the comparison, the commit row, the intent/receipt rows,
# `pr_manager`'s local git reads (the perimeter's diff and log) and PR body.
# Seconds on any host; the same allowance the executor prices every kernel
# child's work with (`ci_executor.KERNEL_CHILD_WORK_SECONDS`).
DELIVERY_WORK_ALLOWANCE_SECONDS = 120


def delivery_worst_case_seconds(*, validation_commands: Sequence[str], validation_timeout_ms: int) -> int:
    """How long ``deliver_implementation`` may legitimately run for a staged
    action whose suite is ``validation_commands`` at ``validation_timeout_ms``
    per command — the ONE derivation every consumer of "how long can the
    delivery take" reads (ARIA-HIGH-124, round 3):

    * the executor's ``child_worst_case_seconds`` for an implementation
      child (the drain starts one only while it fits the window; the
      workflow pin holds the canonical shape);
    * the executor's pre-spawn reservation out of ``ARIA_JOB_DEADLINE_EPOCH``
      and its pre-publication admission;
    * ``deliver_implementation``'s own admission.

    Every command at its full ceiling (the gate stops at the first failure
    only by exit code — a timed-out command is a recorded run, and the next
    one still executes), every git subprocess at the store's cap, the
    ``commit_identity`` verification at its own, the ``result_admissible``
    decision's probe clock (round 5), the delivery credential's mint and
    revoke at their bounds (round 6: the lease is minted here, after the
    gate), the ONE ``gh`` call at its bound, and the work allowance.
    """
    if validation_timeout_ms <= 0:
        raise ValueError("validation_timeout_ms must be positive")
    per_command = int(math.ceil(validation_timeout_ms / 1000))
    return int(
        len(validation_commands) * per_command
        + DELIVERY_GIT_CALLS * _GIT_TIMEOUT_SECONDS
        + DELIVERY_COMMIT_IDENTITY_SECONDS
        + DELIVERY_RESULT_ADMISSIBLE_SECONDS
        + DELIVERY_CREDENTIAL_WORST_CASE_SECONDS
        + GH_PR_CREATE_TIMEOUT_SECONDS
        + DELIVERY_WORK_ALLOWANCE_SECONDS
    )


# What an implementation child runs BEYOND a plain child's spawn, for ONE
# request: the credential admission before the spawn (round 6 — one lease
# minted and revoked to prove the lane can mint, `DELIVERY_CREDENTIAL_WORST_CASE_SECONDS`),
# the quarantine's publication after it, and the delivery.
IMPLEMENTATION_TERM_BESIDE_DELIVERY_SECONDS: int = (
    DELIVERY_CREDENTIAL_WORST_CASE_SECONDS + QUARANTINE_PUBLICATION_WORST_CASE_SECONDS
)

# The canonical shape — the suite every staged action carries, at the
# canonical ceiling, plus the credential admission and the quarantine's
# publication the executor runs around the spawn: what the workflow's
# drain window must hold for an implementation child
# (`tests/test_state_lock_liveness_bound.py`), and the executor's
# standalone mirror when the kernel cannot be imported. A plan's declared
# recipes make a request's own bound larger; the drain and the executor
# read that bound off the staged action
# (`staged_delivery_worst_case_seconds`), never this constant.
IMPLEMENTATION_DELIVERY_WORST_CASE_SECONDS: int = (
    delivery_worst_case_seconds(
        validation_commands=CANONICAL_VALIDATION_COMMANDS_EXECUTABLE,
        validation_timeout_ms=CANONICAL_VALIDATION_TIMEOUT_MS,
    )
    + IMPLEMENTATION_TERM_BESIDE_DELIVERY_SECONDS
)


def staged_delivery_worst_case_seconds(*, proposal_id: str, base_dir: str | Path | None) -> int:
    """The implementation child's bound beyond its spawn for ONE request:
    the credential admission before the spawn, the publication after it,
    and the delivery priced off the STAGED action's own suite and ceiling
    (``apply_engine.stage_converged_plan_for_pr`` recorded both), so a plan
    that declares recipes is priced with them. An action that cannot be
    found is priced at the canonical shape — the delivery itself then
    refuses ``apply_gate_no_action`` by name."""
    commands, timeout_ms = _staged_suite(proposal_id=proposal_id, base_dir=base_dir)
    return delivery_worst_case_seconds(validation_commands=commands, validation_timeout_ms=timeout_ms) + (
        IMPLEMENTATION_TERM_BESIDE_DELIVERY_SECONDS
    )


def deadline_refusal(*, job_deadline_epoch: float | None, worst_case_seconds: int, now: float | None = None) -> str | None:
    """Why the job's remaining window cannot hold ``worst_case_seconds``, or
    None. No deadline (a local run, the tests) binds nothing — the same
    contract as the spawn clamp (ORPHAN-661)."""
    if job_deadline_epoch is None:
        return None
    remaining = int(job_deadline_epoch - (time.time() if now is None else now))
    if remaining < worst_case_seconds:
        return f"deadline_insufficient:remaining={remaining}s:worst_case={worst_case_seconds}s"
    return None


class ImplementationDeliveryRefusal(Exception):
    """The delivery could not complete; ``stage`` and ``reason`` name why."""

    def __init__(self, stage: str, reason: str) -> None:
        if stage not in DELIVERY_STAGES:
            raise ValueError(f"unknown delivery stage {stage!r}")
        super().__init__(f"{stage}:{reason}")
        self.stage = stage
        self.reason = reason


@dataclass(frozen=True)
class ImplementationDelivery:
    """What the executor delivered: the kernel's facts for the stamp."""

    branch: str
    branch_tip_sha: str
    base_branch_sha: str
    diff_hash: str
    pr_url: str
    pr_number: int
    validation_gate_ref: str
    validation_results: tuple[dict[str, Any], ...] = field(default_factory=tuple)

    def record_fields(self) -> dict[str, Any]:
        return {
            "branch": self.branch,
            "branch_tip_sha": self.branch_tip_sha,
            "base_branch_sha": self.base_branch_sha,
            "diff_hash": self.diff_hash,
            "pr_url": self.pr_url,
            "pr_number": self.pr_number,
            "validation_gate_ref": self.validation_gate_ref,
            "validation_results": [dict(row) for row in self.validation_results],
        }


def _git(args: list[str], *, cwd: Path, env: Mapping[str, str]) -> subprocess.CompletedProcess[str]:
    """One git subprocess of the delivery's own, hooks off (see the module
    docstring): the push must never run a hook the agent's tree provides."""
    return subprocess.run(
        ["git", *KERNEL_GIT_NO_HOOKS_ARGS, *args], cwd=str(cwd), env=dict(env), capture_output=True, text=True,
        check=False, timeout=_GIT_TIMEOUT_SECONDS,
    )


def _first_line(text: str, *, limit: int = 160) -> str:
    return (text.strip().splitlines() or ["?"])[0][:limit]


def _gate_validation_results(action: Mapping[str, Any], *, base_dir: str | Path | None) -> tuple[dict[str, Any], ...]:
    """The candidate run group the gate compared: one entry per recorded
    command, read back through the ledger's own verifier (the log is
    re-hashed), bounded per the V9.0-D cap."""
    from .implementation_safety import truncate_validation_result
    from .validation import _find_comparison, _find_plan, list_validation_comparisons, list_validation_plans
    from .validation_runs_ledger import _validation_log_path, verify_validation_run

    comparison = _find_comparison(list_validation_comparisons(base_dir=base_dir), str(action.get("validation_comparison_ref") or ""))
    if comparison is None:
        return ()
    group = _find_plan(list_validation_plans(base_dir=base_dir), str(comparison.get("worktree_ref") or ""))
    if group is None:
        return ()
    results: list[dict[str, Any]] = []
    for run_id in group.get("validation_run_ids") or []:
        row = verify_validation_run(str(run_id), base_dir=base_dir)
        try:
            output = Path(_validation_log_path(row, base_dir=base_dir)).read_text(encoding="utf-8", errors="replace")
        except OSError:
            output = ""
        results.append({
            "command": row.get("cmd"),
            "exit_code": row.get("exit_code"),
            "timed_out": bool(row.get("timed_out")),
            "validation_run_id": row.get("validation_run_id"),
            "log_hash": row.get("log_hash"),
            "output_head_tail": truncate_validation_result(output),
        })
    return tuple(results)


def agent_dispositions(envelope: Mapping[str, Any]) -> dict[str, str]:
    """The agent's declared dispositions off the result envelope's outcome
    record (``implementation_record``): ``{path: sentence}``, strings only —
    anything else the agent wrote there is not a disposition and is dropped
    (the ledger then refuses an undeclared shortfall by name)."""
    from .implementation_identity import implementation_record

    details = envelope.get("details")
    record = implementation_record(details if isinstance(details, dict) else {})
    declared = record.get(AGENT_DISPOSITIONS_FIELD)
    if not isinstance(declared, Mapping):
        return {}
    return {str(path): str(sentence) for path, sentence in declared.items()
            if isinstance(path, str) and isinstance(sentence, str)}


# ARIA-HIGH-150 — what the room probe asks, one fact per line, each tool
# answering `absent` when it is not there (the admission already refused a
# DECLARED toolchain that does not resolve; this records what the suite
# actually saw). Read-only: versions, modes, presence, names of the rust
# homes — never their contents.
ROOM_PROBE_SCRIPT = (
    "echo tmp_mode=$(stat -c %a /tmp 2>/dev/null || echo absent); "
    "for d in /opt /var/log; do if [ -d \"$d\" ]; then echo dir=$d=present; else echo dir=$d=absent; fi; done; "
    "for t in node npm npx git cargo rustc python3; do "
    "v=$($t --version 2>/dev/null | head -n 1); echo tool=$t=${v:-absent}; done; "
    "for n in RUSTUP_HOME CARGO_HOME RUSTUP_TOOLCHAIN HOME; do eval \"v=\\$$n\"; echo env=$n=${v:-unset}; done; "
    "echo kernel=$(uname -r 2>/dev/null || echo unknown)"
)
ROOM_PROBE_TIMEOUT_SECONDS = 60


def probe_validation_room(
    spawn_wrapper: SpawnWrapper, *, workspace_root: str | Path, environment: Mapping[str, str],
) -> dict[str, Any]:
    """The validation room as the suite will see it: `/tmp`'s mode, the host
    roots present, each toolchain's version (or `absent`), the rust homes
    named, the kernel — observed by a probe run through the SAME wrapper
    and environment the commands get, recorded on the plan row by
    ``run_validation_commands(room=…)`` (ARIA-HIGH-150). A probe that cannot
    run is recorded as such (`probe_exit`, `error`), never guessed."""
    from .tool_registry import utc_now

    room: dict[str, Any] = {
        "schema_version": 1, "probed_at": utc_now(), "tmp_mode": None, "dirs": {}, "tools": {}, "env": {},
        "kernel": None, "probe_exit": None, "wrapped_argv_sha256": None,
    }
    try:
        argv = spawn_wrapper(["sh", "-c", ROOM_PROBE_SCRIPT], environment)
        room["wrapped_argv_sha256"] = "sha256:" + hashlib.sha256("\0".join(argv).encode("utf-8")).hexdigest()
        done = subprocess.run(argv, cwd=str(workspace_root), env=dict(environment), capture_output=True, text=True,
                              timeout=ROOM_PROBE_TIMEOUT_SECONDS, check=False)
    except (OSError, subprocess.SubprocessError, GovernanceErrorType, SandboxUnavailable) as exc:
        room["error"] = f"{type(exc).__name__}: {str(exc)[:200]}"
        return room
    room["probe_exit"] = done.returncode
    for line in done.stdout.splitlines():
        key, _, rest = line.strip().partition("=")
        if key == "tmp_mode":
            room["tmp_mode"] = rest
        elif key == "dir":
            name, _, state = rest.partition("=")
            room["dirs"][name] = state == "present"
        elif key == "tool":
            name, _, version = rest.partition("=")
            room["tools"][name] = version[:80]
        elif key == "env":
            name, _, value = rest.partition("=")
            room["env"][name] = value[:200]
        elif key == "kernel":
            room["kernel"] = rest[:80]
    if done.returncode != 0:
        room["error"] = (done.stderr.strip().splitlines() or ["probe_failed"])[-1][:200]
    return room


def validation_sandbox_for(workspace: Path, *, store: str | Path | None) -> SpawnWrapper:
    """The containment the gate puts around every command of the AGENT's
    suite in ``workspace`` (a request worktree): the read-only git shape
    of that checkout and the validation sandbox (see
    ``implementation_safety.wrap_validation_in_sandbox``). Raises
    :class:`SandboxUnavailable` by name when the workspace's git dirs
    cannot be derived."""
    try:
        containment = derive_git_containment(workspace, commit_capable=False)
    except GitContainmentRefusal as exc:
        raise SandboxUnavailable(f"git_containment_refused:{exc.reason}") from exc

    def wrap(argv: list[str], environment: Mapping[str, str]) -> list[str]:
        return wrap_validation_in_sandbox(
            argv, workspace_root=workspace, git=containment, environment=environment, store=store,
        )

    return wrap


def _staged_suite(*, proposal_id: str, base_dir: str | Path | None) -> tuple[list[str], int]:
    """The staged action's suite and ceiling; the canonical shape when no
    action is staged (the gate then refuses ``apply_gate_no_action`` by
    name)."""
    from .apply_engine import latest_apply_action

    action = latest_apply_action(proposal_id=proposal_id, base_dir=base_dir)
    if action is None:
        return list(CANONICAL_VALIDATION_COMMANDS_EXECUTABLE), CANONICAL_VALIDATION_TIMEOUT_MS
    commands = [str(command) for command in (action.get("validation_commands") or CANONICAL_VALIDATION_COMMANDS_EXECUTABLE)]
    return commands, int(action.get("validation_timeout_ms") or CANONICAL_VALIDATION_TIMEOUT_MS)


def delivery_admission_refusal(
    *,
    workspace_root: str | Path,
    base_dir: str | Path,
    proposal_id: str,
    job_deadline_epoch: float | None,
    extra_seconds: int = 0,
    now: float | None = None,
) -> str | None:
    """Why the delivery of ``proposal_id`` cannot be admitted on this host in
    this window, or None (ARIA-HIGH-124, round 3):

    * ``sandbox_unavailable:<why>`` — the validation sandbox cannot be
      built for every staged command (bwrap unusable, the workspace's git
      dirs underivable, an executable unresolvable on the validation
      environment's PATH, a bind that would reach the store);
    * ``staged_command_refused:<why>`` — a staged command the runner's
      own parser refuses;
    * ``deadline_insufficient:remaining=…:worst_case=…`` — the job's
      remaining wall clock (``job_deadline_epoch``) is below the delivery's
      worst case (`delivery_worst_case_seconds` off the staged suite) plus
      ``extra_seconds`` (what the caller must still run after the
      delivery: the executor adds its terminal writer and release).

    Decided WITHOUT executing a command or writing a row, so the executor
    can ask before it publishes the quarantine — a spawn whose delivery
    could not fit then leaves no branch, and its harness-class retry stands
    on the branch again — and ``deliver_implementation`` asks again at its
    own entry (stage ``admission``).
    """
    workspace = Path(workspace_root).resolve()
    commands, timeout_ms = _staged_suite(proposal_id=proposal_id, base_dir=base_dir)
    try:
        wrap = validation_sandbox_for(workspace, store=base_dir)
        for command in commands:
            argv, declared = parse_allowed_command(command)
            wrap(argv, build_validation_env(os.environ, declared=declared).env)
    except SandboxUnavailable as exc:
        return f"sandbox_unavailable:{exc}"
    except GovernanceErrorType as exc:
        return f"staged_command_refused:{str(exc)[:200]}"
    return deadline_refusal(
        job_deadline_epoch=job_deadline_epoch,
        worst_case_seconds=delivery_worst_case_seconds(validation_commands=commands, validation_timeout_ms=timeout_ms) + extra_seconds,
        now=now,
    )


def _record_change_validated(
    *,
    change_id: str,
    base_dir: str | Path | None,
    workspace: Path,
    emit: Callable[..., dict[str, Any]],
    request_id: str,
    cycle_id: str | None,
) -> dict[str, Any] | None:
    """Write ``change_validated`` from the ledger's own refs, or record why not."""
    from .tool_registry import append_tools_governance
    from .validation_runs_ledger import refs_for_change

    refs = refs_for_change(change_id, base_dir=base_dir)
    try:
        return emit(change_id=change_id, validation_run_refs=refs, base_dir=base_dir, workspace_root=workspace)
    except GovernanceErrorType as exc:
        append_tools_governance(
            base_dir,
            "change_validated_refused",
            {
                "change_id": change_id,
                "request_id": request_id,
                "cycle_id": cycle_id,
                "validation_ref_count": len(refs),
                "reason": str(exc)[:500],
            },
        )
        return None


def deliver_implementation(
    *,
    request_id: str,
    claim_id: str,
    agent_id: str,
    cycle_id: str,
    signer_key_fp: str,
    implementation_ids: Mapping[str, Any],
    envelope: Mapping[str, Any],
    output_path: str | Path,
    workspace_root: str | Path,
    base_dir: str | Path,
    publication: QuarantinePublication | None,
    profile: Any,
    job_deadline_epoch: float | None = None,
) -> ImplementationDelivery:
    """Verify the tip's identity, admit, verify scope, decide the result, gate (contained), record, mint the credential, push and open the PR for a published implementation branch.

    ``implementation_ids`` is the request envelope's staged
    ``{proposal_id, change_id, branch, base_sha}``; ``publication`` is what
    the kernel published from the request's quarantine; ``workspace_root``
    is the request worktree whose HEAD the publication adopted;
    ``profile`` is the runtime profile whose ``external_writes`` grant the
    delivery credential is minted under (round 6 — minted HERE, after the
    gate, through ``delivery_credentials.hold_delivery_credentials``,
    applied to the push and the ``gh`` subprocess only and revoked once
    the PR is open) — None, or a profile without the grant, mints nothing:
    a lane whose remote needs no credential; ``signer_key_fp`` is the fingerprint of the key
    the executor holds for THIS request (``implementation_identity``), the
    only identity the tip may carry (round 4); ``envelope`` is the result
    envelope the executor will SUBMIT for this claim (canonicalized, the
    signer stamped; the delivery's own stamp comes after), decided here
    the way the submit decides it (round 5), with ``agent_id`` the lease's
    submitter and ``output_path`` the envelope's path; the agent's
    dispositions for intended files it left untouched are read off it
    (``agent_dispositions``) and go, with ``claim_id``, on the change
    ledger's commit row; ``job_deadline_epoch`` is the job's
    ``ARIA_JOB_DEADLINE_EPOCH`` (None binds nothing). Raises
    ``ImplementationDeliveryRefusal`` by name.
    """
    from .agent_invocations import EVIDENCE_TARGET_AUTO, find_request, judge_claim_submission
    from .apply_engine import run_apply_gate
    from .change_ledger import emit_change_committed, emit_change_validated, verify_change_scope
    from .plan_convergence_bridge import verify_implementation_commit
    from .pr_manager import open_pr_for_action
    from .recovery import record_intent, record_receipt

    workspace = Path(workspace_root).resolve()
    uncovered_intended_dispositions = agent_dispositions(envelope)
    proposal_id = str(implementation_ids.get("proposal_id") or "")
    change_id = str(implementation_ids.get("change_id") or "")
    branch = str(implementation_ids.get("branch") or "")
    base_sha = str(implementation_ids.get("base_sha") or "")
    if not (proposal_id and change_id and branch and base_sha):
        raise ImplementationDeliveryRefusal("branch_publication", "implementation_ids_incomplete")
    if publication is None:
        raise ImplementationDeliveryRefusal("branch_publication", "publication_missing")
    if publication.refusal is not None:
        raise ImplementationDeliveryRefusal("branch_publication", f"publication_refused:{publication.refusal}")
    if branch not in publication.refs_published or publication.head_adopted != branch:
        discarded = ",".join(f"{ref}={why}" for ref, why in publication.refs_discarded) or "none"
        raise ImplementationDeliveryRefusal(
            "branch_publication", f"branch_not_published:refs_published={list(publication.refs_published)}:discarded={discarded}",
        )
    git_env = _publish_environment()
    tip = _git(["rev-parse", "--verify", f"refs/heads/{branch}^{{commit}}"], cwd=workspace, env=git_env)
    if tip.returncode != 0:
        raise ImplementationDeliveryRefusal("branch_publication", f"branch_tip_unresolvable:{_first_line(tip.stderr)}")
    branch_tip_sha = tip.stdout.strip()
    if branch_tip_sha == base_sha:
        raise ImplementationDeliveryRefusal("branch_publication", "branch_has_no_commit")

    # 0a. The tip's IDENTITY, before ANY external effect (round 4): the
    #     same verifier the submit's bridge runs, against the key this
    #     request's executor minted and registered under its cycle, in the
    #     checkout that holds the commit. Until round 4 the delivery pushed
    #     the branch and opened the PR with the App's credential and only
    #     the LATER bridge asked whether the commit was the kernel's —
    #     leaving a live `[ARIA-AUTO]` PR on a plan that stayed
    #     IMPLEMENTATION_REQUESTED. `ARIA_DRY_RUN` does not excuse this
    #     one: the push it guards is real wherever it runs.
    try:
        verify_implementation_commit(
            branch_tip_sha=branch_tip_sha, signer_key_fp=signer_key_fp, cycle_id=cycle_id,
            plan_id=proposal_id, base_dir=base_dir, workspace_root=workspace, dry_run_skips_git=False,
        )
    except GovernanceErrorType as exc:
        raise ImplementationDeliveryRefusal(
            COMMIT_IDENTITY_STAGE, f"commit_unverified:{str(exc)[:300]}",
        ) from exc

    # 0b. The admission: the sandbox and the window, before anything runs.
    refused = delivery_admission_refusal(
        workspace_root=workspace, base_dir=base_dir, proposal_id=proposal_id, job_deadline_epoch=job_deadline_epoch,
    )
    if refused is not None:
        raise ImplementationDeliveryRefusal(ADMISSION_STAGE, refused)
    sandbox = validation_sandbox_for(workspace, store=base_dir)

    # 1. The scope verdict: the diff's own file list (never the agent's word
    #    for it) against the plan's intended surfaces, the agent's
    #    dispositions. Refused by name BEFORE the tip's suite executes.
    touched = _git(["diff", "--name-only", base_sha, branch_tip_sha], cwd=workspace, env=git_env)
    if touched.returncode != 0:
        raise ImplementationDeliveryRefusal("change_ledger", f"diff_unresolvable:{_first_line(touched.stderr)}")
    actual_affected_files = sorted(line.strip() for line in touched.stdout.splitlines() if line.strip())
    try:
        verify_change_scope(
            change_id=change_id, actual_affected_files=actual_affected_files,
            uncovered_intended_dispositions=dict(uncovered_intended_dispositions or {}), base_dir=base_dir,
        )
    except GovernanceErrorType as exc:
        raise ImplementationDeliveryRefusal("change_ledger", f"change_committed_refused:{str(exc)[:300]}") from exc
    # The stamp's diff hash: the same read as the file list, taken here so
    # a diff the store cannot produce refuses before anything external.
    diff = _git(["diff", base_sha, branch_tip_sha], cwd=workspace, env=git_env)
    if diff.returncode != 0:
        raise ImplementationDeliveryRefusal("change_ledger", f"diff_unresolvable:{_first_line(diff.stderr)}")
    diff_hash = "sha256:" + hashlib.sha256(diff.stdout.encode("utf-8")).hexdigest()

    # 1a. The patch's own secret scan (round 6): the branch's WHOLE diff,
    #     `base_sha..tip`, through the scanner whose docstring has promised
    #     since V9.0-D to run "before `gh pr create` so secrets never land
    #     on GitHub" — and which nothing called on a diff: the agent's
    #     contract told the AGENT to call it (a Python function it cannot
    #     execute, the round-2 `emit_change_committed` shape again), and the
    #     delivery scanned the gate's OUTPUT (round 5) but never the patch it
    #     pushed. A secret-shaped string in the commit is the REQUEST's:
    #     refused here by name, before the suite runs, escalated, nothing
    #     pushed. Counts only — the scanner never names the value.
    try:
        verify_no_secret_in_diff(diff.stdout)
    except SecretLeakDetected as exc:
        raise ImplementationDeliveryRefusal(RESULT_ADMISSIBLE_STAGE, f"diff_secret_shaped:{str(exc)[:300]}") from exc

    # 1b. The result's admissibility (round 5): the submit's decision, in
    #     process, on the envelope the executor will submit, with the
    #     evidence graded at this worktree's HEAD — the published tip. A
    #     rejection here is the request's; a decision the kernel could not
    #     reach (its probes did not answer) is the host's, refused at the
    #     admission stage so the executor releases it harness-class like
    #     the submit would.
    try:
        judgment = judge_claim_submission(
            root=Path(base_dir), claim_id=claim_id, agent_id=agent_id,
            request=find_request(Path(base_dir), request_id), envelope=dict(envelope), output=Path(output_path),
            # The worktree's HEAD, resolved and descent-proven by the
            # kernel: the reading the executor's submit passes as
            # `--evidence-target-sha auto`.
            workspace_root=workspace, evidence_target_sha=EVIDENCE_TARGET_AUTO,
        )
    except GovernanceErrorType as exc:
        raise ImplementationDeliveryRefusal(RESULT_ADMISSIBLE_STAGE, f"judgment_refused:{str(exc)[:300]}") from exc
    if judgment.undecided:
        raise ImplementationDeliveryRefusal(
            ADMISSION_STAGE, f"evidence_verification_unavailable:{','.join(judgment.rejection_codes)}",
        )
    if not judgment.admitted:
        codes = ",".join(sorted(set(judgment.rejection_codes)))
        raise ImplementationDeliveryRefusal(
            RESULT_ADMISSIBLE_STAGE,
            f"result_rejected:{codes}:reasons={len(judgment.reasons)}:{_first_line(judgment.reasons[0], limit=200)}",
        )

    # 2. The apply gate, contained: validation at the branch HEAD in this
    #    worktree (the publication adopted it), every command through the
    #    sandbox, the promotion to ready_for_pr outside.
    try:
        action = run_apply_gate(
            proposal_id=proposal_id, change_id=change_id, base_dir=base_dir,
            runner_identity=f"aria-executor:{request_id}", cycle_id=cycle_id or None, workspace_root=workspace,
            spawn_wrapper=sandbox,
        )
    except SandboxUnavailable as exc:
        raise ImplementationDeliveryRefusal(ADMISSION_STAGE, f"sandbox_unavailable:{exc}") from exc
    except GovernanceErrorType as exc:
        raise ImplementationDeliveryRefusal("apply_gate", f"gate_refused:{str(exc)[:300]}") from exc
    if action.get("status") != "ready_for_pr":
        blocked = ",".join(str(item) for item in (action.get("blocked_by") or [])) or "unknown"
        raise ImplementationDeliveryRefusal("apply_gate", f"gate_blocked:{blocked}")
    validation_gate_ref = str(action.get("validation_gate_ref") or "")
    validation_results = _gate_validation_results(action, base_dir=base_dir)
    # The recorded runs are the agent's output, on the ledger and in the
    # stamp (round 5): scanned HERE, before the push, on exactly the rows
    # the stamp carries, with the scanner the submit uses.
    try:
        verify_no_secret_in_envelope({"validation_results": [dict(row) for row in validation_results]})
    except SecretLeakDetected as exc:
        raise ImplementationDeliveryRefusal("apply_gate", f"gate_output_secret_shaped:{str(exc)[:300]}") from exc

    # 3. The change ledger's commit row: the same verdict, written with the
    #    claim; the ledger's immutability refusals are by name too.
    try:
        emit_change_committed(
            change_id=change_id, commit_sha=branch_tip_sha,
            actual_affected_files=actual_affected_files,
            claim_id=claim_id, uncovered_intended_dispositions=dict(uncovered_intended_dispositions or {}),
            base_dir=base_dir,
        )
    except GovernanceErrorType as exc:
        raise ImplementationDeliveryRefusal("change_ledger", f"change_committed_refused:{str(exc)[:300]}") from exc

    # 3b. ARIA-HIGH-196 — the validation row that closes the chain, from the
    #     runs the apply gate just recorded under this change id. Nothing
    #     else wrote it autonomously, so every ARIA change stopped at
    #     change_committed and the merge triple gate could never pass. A
    #     refusal (the matrix gate blocked, the profile froze) is recorded
    #     by name and the PR is still delivered for human review: the
    #     triple gate refuses to auto-merge a change without this row.
    _record_change_validated(
        change_id=change_id, base_dir=base_dir, workspace=workspace,
        emit=emit_change_validated, request_id=request_id, cycle_id=cycle_id,
    )

    # 4. The credential, minted HERE (round 6): the hold brackets exactly
    #    the push and the PR opener — the window the lease is asked to
    #    cover — and revokes the lease however they exit. Until round 6
    #    the executor minted the ONE lease before the spawn and this step
    #    consumed it hours later, past the provider's hour.
    with ExitStack() as credential_hold:
        try:
            credential = credential_hold.enter_context(hold_delivery_credentials(
                profile=profile, request_id=request_id, cycle_id=cycle_id, workspace_root=workspace,
                base_dir=base_dir, deadline_epoch=job_deadline_epoch,
                covers_seconds=DELIVERY_CREDENTIAL_CONSUMPTION_SECONDS,
            ))
        except DeliveryCredentialError as exc:
            raise ImplementationDeliveryRefusal(CREDENTIAL_STAGE, f"credential_unavailable:{str(exc)[:300]}") from exc
        credential_environment: dict[str, str] = dict(credential.env) if credential is not None else {}

        # 5. The push, with the credential on this ONE subprocess.
        push_env = {**git_env, **credential_environment}
        intent = record_intent(
            request_id=request_id, effect_kind="git_push", target=f"{_PUSH_REMOTE}/{branch}",
            intended_postcondition={"branch": branch, "remote": _PUSH_REMOTE, "head_sha": branch_tip_sha, "proposal_id": proposal_id},
            base_dir=base_dir,
        )
        pushed = _git(["push", _PUSH_REMOTE, f"refs/heads/{branch}:refs/heads/{branch}"], cwd=workspace, env=push_env)
        if pushed.returncode != 0:
            record_receipt(
                operation_id=str(intent["operation_id"]), request_id=request_id,
                observed={"returncode": pushed.returncode, "stderr": (pushed.stderr or "")[:400]},
                status="failed", base_dir=base_dir,
            )
            raise ImplementationDeliveryRefusal("push", f"push_failed:rc={pushed.returncode}:{_first_line(pushed.stderr)}")
        record_receipt(
            operation_id=str(intent["operation_id"]), request_id=request_id,
            observed={"branch": branch, "remote": _PUSH_REMOTE, "head_sha": branch_tip_sha},
            status="confirmed", base_dir=base_dir,
        )

        # 6. The PR, through the one sanctioned opener.
        try:
            opened = open_pr_for_action(
                proposal_id=proposal_id, workspace_root=workspace, base_dir=base_dir, dry_run=False,
                change_id=change_id, request_id=request_id,
                command_environment=credential_environment or None,
            )
        except GovernanceErrorType as exc:
            raise ImplementationDeliveryRefusal("pr_open", f"pr_open_refused:{str(exc)[:300]}") from exc
    return ImplementationDelivery(
        branch=branch, branch_tip_sha=branch_tip_sha, base_branch_sha=base_sha,
        diff_hash=diff_hash,
        pr_url=str(opened["url"]), pr_number=int(opened["pr_number"]),
        validation_gate_ref=validation_gate_ref, validation_results=validation_results,
    )


def stamp_implementation_delivery(
    envelope: dict[str, Any],
    *,
    delivery: ImplementationDelivery,
    request_id: str,
    claim_id: str,
    base_dir: str | Path,
) -> bool:
    """Write the kernel's delivery facts on the envelope's outcome record.

    Returns True when the envelope changed. The fields land on the record
    ``implementation_record`` reads — the same reading the bridge dispatches
    on and the signer stamp uses. A value the agent supplied that differs
    from the kernel's is replaced and recorded on governance
    (``implementation_delivery_overridden``) with the field names and the
    agent's values — the agent's claim is data about the agent, never the
    identity of the delivery.
    """
    from .implementation_identity import implementation_record
    from .tool_registry import append_tools_governance

    details = envelope.get("details")
    if not isinstance(details, dict):
        details = {}
        envelope["details"] = details
    record = implementation_record(details)
    facts = delivery.record_fields()
    overridden: dict[str, Any] = {}
    changed = False
    for name in KERNEL_STAMPED_DELIVERY_FIELDS:
        supplied = record.get(name)
        if supplied == facts[name]:
            continue
        if supplied not in (None, "", [], {}):
            overridden[name] = str(supplied)[:200] if not isinstance(supplied, (list, dict)) else "<%s of %d>" % (type(supplied).__name__, len(supplied))
        record[name] = facts[name]
        changed = True
    if overridden:
        append_tools_governance(
            base_dir, IMPLEMENTATION_DELIVERY_OVERRIDDEN_EVENT,
            {
                "request_id": request_id, "claim_id": claim_id,
                "agent_supplied": overridden,
                "kernel": {name: facts[name] for name in overridden if name != "validation_results"},
            },
        )
    return changed


__all__ = [
    "ADMISSION_STAGE",
    "COMMIT_IDENTITY_STAGE",
    "CREDENTIAL_STAGE",
    "DELIVERY_COMMIT_IDENTITY_SECONDS",
    "DELIVERY_RESULT_ADMISSIBLE_SECONDS",
    "HOST_STAGES",
    "RESULT_ADMISSIBLE_STAGE",
    "AGENT_DISPOSITIONS_FIELD",
    "DELIVERY_STAGES",
    "IMPLEMENTATION_DELIVERY_WORST_CASE_SECONDS",
    "IMPLEMENTATION_TERM_BESIDE_DELIVERY_SECONDS",
    "agent_dispositions",
    "deadline_refusal",
    "delivery_admission_refusal",
    "delivery_worst_case_seconds",
    "staged_delivery_worst_case_seconds",
    "validation_sandbox_for",
    "IMPLEMENTATION_DELIVERED_EVENT",
    "IMPLEMENTATION_DELIVERY_OVERRIDDEN_EVENT",
    "IMPLEMENTATION_DELIVERY_REFUSED_EVENT",
    "KERNEL_STAMPED_DELIVERY_FIELDS",
    "ImplementationDelivery",
    "ImplementationDeliveryRefusal",
    "deliver_implementation",
    "stamp_implementation_delivery",
]
