"""Lane-A validation command runner.

E21-a — this module no longer writes the ``validation_runs`` surface.

``_run_one`` used to append its own row shape to
``validation/validation-runs.jsonl``, in parallel with
``validation_runs_ledger.record_validation_run``. One declared surface,
two writers, two schemas: the merge gate read ``change_id`` (absent from
Lane-A rows) and the observability dashboard read ``status`` (absent from
Lane-B rows), so each reader was blind to half the surface. Lane A now
records THROUGH the ledger, which is the single writer, and this module
REFUSES the runs path outright so the second writer cannot come back.

That fold is why ``run_validation_commands`` demands ``change_id``,
``commit_sha`` and ``runner_identity``: a validation run that cannot say
which change and which commit it validated is not evidence, which is
exactly why the merge gate ignored Lane A's rows.
"""
from __future__ import annotations

import os
import json as _json
import math as _math
import secrets
import shlex
import signal
import subprocess
import time
from pathlib import Path
from typing import Any, Callable, Mapping

from .ledger import (
    append_declared_jsonl,
    load_declared_jsonl,
)
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now
from .validation_env import build_validation_env
from .validation_runs_ledger import (
    VALIDATION_RUNS_FILENAME,
    record_validation_run,
    validation_run_log_dir,
)
from .snapshot import _capture_scoped_files, _read_scoped_working_file, _scoped_input_path, _scoped_input_digest, _sha256 as _input_digest
from .workspace import _canonical_identity_observation


# ARIA-HIGH-124 (round 3) — what a caller may put around the argv of every
# command this module spawns: a function from (the argv about to execute,
# the environment it is spawned with) to the argv that executes instead (a
# bwrap prefix, the way `implementation_safety.wrap_validation_in_sandbox`
# shapes one; the environment is read for the PATH the executable resolves
# on, never copied — the child still gets the built environment).
SpawnWrapper = Callable[[list[str], Mapping[str, str]], list[str]]

ALLOWED_COMMANDS = (
    ("npm", "run"),
    ("npx", "nx"),
    ("npx", "ts-node"),
    ("python3", "-m", "aria_kernel"),
    ("python3", "-m", "unittest"),
    ("cargo",),
)

# E21-b — the Rust lane, opened narrowly.
#
# The experiment bench claims to be domain-agnostic, and until E21-b that
# claim rested on an AST check alone: the kernel does not NAME a language,
# but this lane could only execute JavaScript and Python, so a Rust recipe
# was unrunnable and "portable" was an assertion rather than a result.
#
# Only non-mutating verbs are admitted. ``check`` and ``test`` read the
# tree and report; ``install``, ``publish``, ``run``, ``add``, ``clean``
# and every subcommand nobody thought about mutate the machine, the
# registry, or the network, and none of them answers a hypothesis about
# this repository. This is not a new privilege on this host — the
# implementer lane's ``implementation_safety.ALLOWED_BASH_COMMANDS``
# already admits ``cargo test``/``cargo check``; one repo, one posture.
ALLOWED_CARGO_SUBCOMMANDS: tuple[str, ...] = ("check", "test")

# ``--config`` is refused because it re-opens arbitrary execution behind an
# allowed verb: ``cargo test --config target.<triple>.runner='<argv>'``
# makes cargo launch a program of the caller's choosing, and a toolchain
# selector (``cargo +nightly ...``) is likewise not a subcommand. Narrowing
# the verb while leaving that flag open would allowlist the word and not
# the behaviour.
_REFUSED_CARGO_FLAG = "--config"


_VALIDATION_SURFACE_BY_FILENAME: dict[str, str] = {
    "validation-plans.jsonl": "validation_plans",
    "validation-comparisons.jsonl": "validation_comparisons",
    "validation-gates.jsonl": "validation_gates",
}

# E21-a — the surfaces this module must NOT touch, and the module that
# owns each. Kept as data rather than a comment so the refusal below and
# the invariant test read the same list.
_LEDGER_OWNED_SURFACE_FILENAMES: dict[str, str] = {
    VALIDATION_RUNS_FILENAME: "aria_kernel.validation_runs_ledger",
}


def _validation_surface_name(path: str | Path) -> str | None:
    concrete = Path(path)
    if concrete.parent.name != "validation":
        return None
    owner = _LEDGER_OWNED_SURFACE_FILENAMES.get(concrete.name)
    if owner is not None:
        raise GovernanceError(
            f"validation_surface_owned_elsewhere:{concrete.name}: this "
            f"surface has exactly one writer, {owner}; route the write "
            f"through record_validation_run() instead of re-opening a "
            f"second schema on it"
        )
    return _VALIDATION_SURFACE_BY_FILENAME.get(concrete.name)


def append_jsonl(path: Path, record: dict[str, Any]) -> dict[str, Any]:
    surface = _validation_surface_name(path)
    if surface is not None:
        return append_declared_jsonl(path, record, expected_surface=surface)
    raise GovernanceError(f"validation_append_unknown_surface:{path.as_posix()}")


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    surface = _validation_surface_name(path)
    if surface is not None:
        return load_declared_jsonl(path, expected_surface=surface)
    raise GovernanceError(f"validation_load_unknown_surface:{path.as_posix()}")


def run_validation_commands(
    *,
    commands: list[str],
    workspace_root: str | Path,
    change_id: str,
    commit_sha: str,
    runner_identity: str,
    change_author_identity: str | None = None,
    base_dir: str | Path | None = None,
    cycle_id: str | None = None,
    validation_plan_id: str | None = None,
    timeout_ms: int = 120_000,
    require_clean_worktree: bool = True,
    input_scope: dict[str, Any] | None = None,
    spawn_wrapper: SpawnWrapper | None = None,
) -> dict[str, Any]:
    """Execute allowlisted commands and record each through the ledger.

    ``spawn_wrapper`` (ARIA-HIGH-124, round 3) is the containment the
    caller puts around EVERY command's argv — the bwrap builder of
    ``implementation_safety.wrap_validation_in_sandbox`` when the commands
    are the suite of a tree an AGENT wrote (the executor's apply gate at
    the implementer's tip): the suite is repository code — jest specs, the
    nx/eslint configs, ``package.json`` scripts — and running it unconfined
    hands that code the executor's uid, the durable store, the shared
    repository and the code root the executor's own kernel resolves from.
    None runs the argv as given (the cycle job's baseline at the trusted
    checkout HEAD). The wrapper is applied at the ONE spawn seam
    (``_run_one``), after the observation child is composed and before the
    process starts, so no command can run around it.

    ``change_id``, ``commit_sha`` and ``runner_identity`` are REQUIRED and
    resolved, not merely non-empty: the change must exist in the change
    ledger and the commit must be the one the commands actually run at. A
    caller that cannot supply real provenance gets a named
    ``GovernanceError`` — never a placeholder row, because a placeholder
    row is evidence the merge gate would then honour.

    ORPHAN-CRITICAL-728 — ``commit_sha`` is VERIFIED against the workspace
    HEAD, not merely resolved. Resolving proved only that the sha named some
    commit in the repository, and the commands run in ``workspace_root`` at
    whatever is checked out: ``apply_engine.run_apply_gate`` passed the tip
    of the implementation branch while HEAD sat on main, so every row in the
    ``validation-runs`` ledger — the ledger the merge gate joins on — claimed
    provenance the run did not have, and the gate promoted the action to
    ``ready_for_pr`` on it. A caller still NAMES the commit it believes it is
    validating, because a wrong belief must be refused loudly rather than
    silently relabelled to HEAD.
    """
    if not commands or not all(isinstance(command, str) and command.strip() for command in commands):
        raise GovernanceError("validation commands must contain at least one non-empty command")
    if timeout_ms <= 0:
        raise GovernanceError("validation timeout_ms must be positive")
    root = Path(workspace_root).resolve()
    if not root.exists() or not root.is_dir():
        raise GovernanceError(f"workspace root does not exist: {workspace_root}")
    _assert_change_id_resolves(change_id, base_dir=base_dir)
    admitted_commit = _assert_commit_sha_is_workspace_head(root, commit_sha)
    if require_clean_worktree and _dirty_worktree(root):
        raise GovernanceError("validation requires a clean git worktree")
    scoped_files = _normalize_input_scope(input_scope) if input_scope is not None else None
    execution_profile = _normalize_execution_profile(input_scope) if input_scope is not None else None

    runs = []
    for index, command in enumerate(commands):
        runs.append(
            _run_one(
                command=command,
                workspace_root=root,
                base_dir=base_dir,
                cycle_id=cycle_id,
                validation_plan_id=validation_plan_id,
                change_id=change_id,
                commit_sha=commit_sha,
                runner_identity=runner_identity,
                change_author_identity=change_author_identity,
                ordinal=index,
                timeout_ms=timeout_ms,
                scoped_files=scoped_files,
                admitted_commit=admitted_commit,
                execution_profile=execution_profile,
                spawn_wrapper=spawn_wrapper,
            ),
        )
    payload = {
        "schema_version": 2,
        "recorded_at": utc_now(),
        "cycle_id": cycle_id,
        "validation_plan_id": validation_plan_id,
        "change_id": change_id,
        "commit_sha": commit_sha,
        "status": "ok" if all(run["status"] == "ok" for run in runs) else "failed",
        "command_count": len(runs),
        "run_refs": [run["ledger_hash"] for run in runs],
        "validation_run_ids": [run["validation_run_id"] for run in runs],
    }
    return append_jsonl(ensure_tools_dir(base_dir) / "validation" / "validation-plans.jsonl", payload)


def _assert_change_id_resolves(
    change_id: str, *, base_dir: str | Path | None,
) -> None:
    """Refuse to record evidence against a change that does not exist.

    The merge gate joins runs to changes on ``change_id``; a run whose
    change_id names nothing is a row that can never be read, and a row
    that can never be read is indistinguishable from a fabricated one.
    """
    if not isinstance(change_id, str) or not change_id.strip():
        raise GovernanceError("validation_change_id_required")
    from .change_ledger import get_change_chain

    chain = get_change_chain(change_id=change_id, base_dir=base_dir)
    if chain.get("planned") is None and chain.get("committed") is None:
        raise GovernanceError(
            f"validation_change_id_unknown: {change_id!r} has neither a "
            f"change_planned nor a change_committed row; emit the change "
            f"chain before recording validation evidence against it"
        )


def _rev_parse(root: Path, rev: str) -> str | None:
    completed = subprocess.run(
        ["git", "rev-parse", "--verify", "--quiet", f"{rev}^{{commit}}"],
        cwd=root,
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        return None
    return completed.stdout.strip() or None


def _assert_commit_sha_is_workspace_head(root: Path, commit_sha: str) -> str:
    """Refuse a commit_sha that is not the commit the commands will run at.

    ORPHAN-CRITICAL-728 — the check used to stop at "does this sha resolve".
    Resolving is not provenance: the runs execute in ``root`` at HEAD, so any
    other sha in the row is a claim about a tree that was never measured.
    """
    if not isinstance(commit_sha, str) or not commit_sha.strip():
        raise GovernanceError("validation_commit_sha_required")
    claimed = _rev_parse(root, commit_sha)
    if claimed is None:
        raise GovernanceError(
            f"validation_commit_sha_unresolvable: {commit_sha!r} does not "
            f"resolve to a commit in {root.as_posix()}; a validation run "
            f"must name the commit it actually ran against"
        )
    head = _rev_parse(root, "HEAD")
    if head is None:
        raise GovernanceError(
            f"validation_head_unresolvable: {root.as_posix()} has no HEAD "
            f"commit, so no run executed there can carry provenance"
        )
    if claimed != head:
        raise GovernanceError(
            f"validation_commit_sha_is_not_head: the run would execute at "
            f"HEAD={head} but the caller named {claimed}; check the intended "
            f"commit out before recording evidence against it"
        )
    return head


def compare_validation_groups(
    *,
    baseline_ref: str,
    worktree_ref: str,
    base_dir: str | Path | None = None,
    cycle_id: str | None = None,
) -> dict[str, Any]:
    if not baseline_ref.strip() or not worktree_ref.strip():
        raise GovernanceError("baseline_ref and worktree_ref are required")
    plans = list_validation_plans(base_dir=base_dir)
    baseline = _find_plan(plans, baseline_ref)
    worktree = _find_plan(plans, worktree_ref)
    if baseline is None:
        raise GovernanceError(f"baseline validation plan not found: {baseline_ref}")
    if worktree is None:
        raise GovernanceError(f"worktree validation plan not found: {worktree_ref}")
    regression_status = _regression_status(baseline, worktree)
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "cycle_id": cycle_id,
        "baseline_ref": baseline_ref,
        "worktree_ref": worktree_ref,
        "baseline_status": baseline.get("status"),
        "worktree_status": worktree.get("status"),
        "regression_status": regression_status,
        "blocked_by": [] if regression_status in ("no_regression", "improved") else ["validation_regression"],
    }
    return append_jsonl(ensure_tools_dir(base_dir) / "validation" / "validation-comparisons.jsonl", row)


def evaluate_validation_gate(
    *,
    comparison_ref: str,
    base_dir: str | Path | None = None,
    cycle_id: str | None = None,
    require_worktree_ok: bool = True,
) -> dict[str, Any]:
    if not comparison_ref.strip():
        raise GovernanceError("comparison_ref is required")
    comparison = _find_comparison(list_validation_comparisons(base_dir=base_dir), comparison_ref)
    if comparison is None:
        raise GovernanceError(f"validation comparison not found: {comparison_ref}")
    blockers: list[str] = []
    if comparison.get("regression_status") not in ("no_regression", "improved"):
        blockers.append("validation_regression")
    if require_worktree_ok and comparison.get("worktree_status") != "ok":
        blockers.append("candidate_validation_not_green")
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "cycle_id": cycle_id,
        "comparison_ref": comparison_ref,
        "baseline_ref": comparison.get("baseline_ref"),
        "worktree_ref": comparison.get("worktree_ref"),
        "baseline_status": comparison.get("baseline_status"),
        "worktree_status": comparison.get("worktree_status"),
        "regression_status": comparison.get("regression_status"),
        "status": "ready_for_pr" if not blockers else "blocked",
        "blocked_by": sorted(set(blockers)),
    }
    return append_jsonl(ensure_tools_dir(base_dir) / "validation" / "validation-gates.jsonl", row)


def list_validation_plans(*, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    return load_jsonl(ensure_tools_dir(base_dir) / "validation" / "validation-plans.jsonl")


def list_validation_comparisons(*, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    return load_jsonl(ensure_tools_dir(base_dir) / "validation" / "validation-comparisons.jsonl")


def list_validation_gates(*, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    return load_jsonl(ensure_tools_dir(base_dir) / "validation" / "validation-gates.jsonl")


def _find_plan(plans: list[dict[str, Any]], plan_ref: str) -> dict[str, Any] | None:
    for plan in reversed(plans):
        if plan.get("ledger_hash") == plan_ref or plan.get("validation_plan_id") == plan_ref:
            return plan
    return None


def _find_comparison(comparisons: list[dict[str, Any]], comparison_ref: str) -> dict[str, Any] | None:
    for comparison in reversed(comparisons):
        if comparison.get("ledger_hash") == comparison_ref:
            return comparison
    return None


def _regression_status(baseline: dict[str, Any], worktree: dict[str, Any]) -> str:
    if baseline.get("status") == "ok" and worktree.get("status") != "ok":
        return "regression"
    if baseline.get("status") != "ok" and worktree.get("status") == "ok":
        return "improved"
    if baseline.get("status") == worktree.get("status"):
        return "no_regression"
    return "changed"


# How long a killed validation tree has to die before it is SIGKILLed: the
# group gets SIGKILL immediately (a validation command that hit its ceiling
# has had its whole window), and this is the wait for the reaped processes
# to leave — bounded so a wedged uninterruptible child cannot hold the
# delivery open.
VALIDATION_KILL_GRACE_SECONDS = 5


def _run_to_completion(
    argv: list[str],
    *,
    cwd: Path,
    env: Mapping[str, str],
    timeout_seconds: float,
    spawn_options: dict[str, Any],
) -> subprocess.CompletedProcess[str]:
    """``subprocess.run`` for ONE validation command, with the whole process
    TREE bound to the timeout (ARIA-HIGH-124 round 4).

    The child leads its own session, so a timeout signals the GROUP: with
    ``bwrap`` as the direct child (the contained gate) killing one pid left
    the sandboxed command running — bwrap without ``--unshare-pid`` does
    not take its children down, and `subprocess.run`'s own timeout path
    kills exactly the pid it spawned. Raises ``subprocess.TimeoutExpired``
    with whatever the streams carried, the way ``subprocess.run`` does, so
    the caller's recording is unchanged.
    """
    with subprocess.Popen(
        argv, cwd=str(cwd), env=dict(env), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, shell=False, start_new_session=True, **spawn_options,
    ) as process:
        try:
            stdout, stderr = process.communicate(timeout=timeout_seconds)
        except subprocess.TimeoutExpired:
            _kill_process_group(process)
            stdout, stderr = process.communicate()
            raise subprocess.TimeoutExpired(argv, timeout_seconds, output=stdout, stderr=stderr) from None
        except BaseException:
            _kill_process_group(process)
            raise
    return subprocess.CompletedProcess(argv, process.returncode, stdout, stderr)


def _kill_process_group(process: "subprocess.Popen[str]") -> None:
    """SIGKILL the child's whole process group, then the child itself if the
    group is already gone (a child that changed its own group), and reap
    within the grace."""
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError, OSError):
        process.kill()
    try:
        process.wait(timeout=VALIDATION_KILL_GRACE_SECONDS)
    except subprocess.TimeoutExpired:
        process.kill()


def _run_one(
    *,
    command: str,
    workspace_root: Path,
    base_dir: str | Path | None,
    cycle_id: str | None,
    validation_plan_id: str | None,
    change_id: str,
    commit_sha: str,
    runner_identity: str,
    change_author_identity: str | None,
    ordinal: int,
    timeout_ms: int,
    scoped_files: dict[str, list[str]] | None = None,
    admitted_commit: str | None = None,
    execution_profile: dict[str, Any] | None = None,
    spawn_wrapper: SpawnWrapper | None = None,
) -> dict[str, Any]:
    argv, env_updates = parse_allowed_command(command)
    # ARIA-MEDIUM-066 — the child's environment is BUILT from the runner's,
    # never copied: the durable store's bindings, the job deadline, hook and
    # credential names stay in this process. ``env_updates`` is what the
    # command itself declared, placed on top. The report goes into the
    # ledger row by name so the row says what the child saw.
    spawn_env = build_validation_env(os.environ, declared=env_updates)
    capture_started_at = utc_now()
    paths = sorted({p for group in scoped_files.values() for p in group}) if scoped_files is not None else []
    selected_profile = execution_profile is not None and bool(_unittest_selectors(argv))
    reserved_bytes = 4 * 1024 * 1024 if selected_profile else 0
    before = _capture_scoped_files(workspace_root, paths, byte_budget=16 * 1024 * 1024 - reserved_bytes) if scoped_files is not None else None
    observer_hash = None
    observer_bytes = 0
    observer_paths = 0
    child_path_limit = 0
    spawned_argv = argv
    receipt_read = receipt_write = None
    receipt_limit = 0
    receipt = None
    observation_diagnostics: list[str] = []
    observer_deadline = time.monotonic() + 0.250 if selected_profile else None
    child_time_budget = 0.0
    observed = None
    if selected_profile:
        if len(paths) < 256:
            observed, _body, observer_bytes = _read_scoped_working_file(
                Path(__file__).parent, "_validation_unittest_child.py",
                byte_budget=16 * 1024 * 1024 - reserved_bytes - before["bytes_read"],
                deadline_monotonic=observer_deadline,
            )
            observer_paths = 1
            observer_hash = observed.get("content_hash") if observed["status"] == "available" else None
        child_path_limit = min(16, 256 - len(paths) - observer_paths)
    started_at = utc_now()
    started = time.monotonic()
    stdout = ""
    stderr = ""
    exit_code: int | None = None
    timed_out = False
    try:
        spawn_options = {}
        if selected_profile:
            try:
                receipt_read, receipt_write = os.pipe()
                os.set_blocking(receipt_read, False)
                os.set_blocking(receipt_write, False)
                receipt_limit = min(4096, os.fpathconf(receipt_write, "PC_PIPE_BUF"))
                spawned_argv = [argv[0], str(Path(__file__).with_name("_validation_unittest_child.py")),
                                str(receipt_write), str(reserved_bytes), str(child_path_limit), str(receipt_limit),
                                _canonical_input_json(execution_profile["modules"]), "", "--", *argv[3:]]
                spawn_options["pass_fds"] = (receipt_write,)
                child_time_budget = max(0.0, observer_deadline - time.monotonic())
                if observed is not None and observed.get("reason") == "qualification_deadline":
                    child_time_budget = 0.0
                spawned_argv[7] = str(child_time_budget)
            except OSError:
                # The command has not started. Optional observation may fall
                # back here only; never re-execute after an attempted spawn.
                observation_diagnostics.append("receipt_setup_unavailable")
                _close_observation_fd(receipt_write, "write", observation_diagnostics)
                _close_observation_fd(receipt_read, "read", observation_diagnostics)
                receipt_read = receipt_write = None
                spawned_argv = argv
                spawn_options = {}
        if spawn_wrapper is not None:
            # ARIA-HIGH-124 (round 3) — the containment goes around the
            # argv that is about to execute (the observation child
            # included), at the one seam every command passes through.
            # The wrapped vector is what the hash-bound log records as
            # `argv`, so the evidence says the run was contained.
            spawned_argv = spawn_wrapper(list(spawned_argv), spawn_env.env)
        # ARIA-HIGH-124 (round 4) — the command is its own PROCESS GROUP
        # (`start_new_session`), so the timeout below kills the whole tree
        # and not just the direct child. `subprocess.run`'s timeout path
        # SIGKILLs one pid: with a wrapper that pid is `bwrap`, and the
        # sandboxed command — `npx nx affected --target=test`, whose jest
        # workers are the cost — kept running as an orphan on the shared
        # runner while the gate recorded `timed_out` and moved on to the
        # next command at its own 45-minute ceiling. Unwrapped (the cycle's
        # baseline) the same shape orphaned the suite's grandchildren.
        completed = _run_to_completion(
            spawned_argv,
            cwd=workspace_root,
            env=spawn_env.env,
            timeout_seconds=timeout_ms / 1000,
            spawn_options=spawn_options,
        )
        stdout = completed.stdout or ""
        stderr = completed.stderr or ""
        exit_code = completed.returncode
    except subprocess.TimeoutExpired as exc:
        timed_out = True
        stdout = _decode_timeout_stream(exc.stdout)
        stderr = _decode_timeout_stream(exc.stderr)
    finally:
        receipt_started = time.monotonic()
        _close_observation_fd(receipt_write, "write", observation_diagnostics)
        if receipt_read is not None:
            try:
                receipt = _read_unittest_receipt(receipt_read, receipt_limit, reserved_bytes, child_path_limit)
            finally:
                _close_observation_fd(receipt_read, "read", observation_diagnostics)
        receipt_elapsed = max(0.0, time.monotonic() - receipt_started)
    duration_ms = int(round((time.monotonic() - started) * 1000))
    binding = None
    manifest = None
    if scoped_files is not None:
        charged_child_bytes = receipt["work"]["bytes_read"] if receipt is not None else reserved_bytes
        after = _capture_scoped_files(workspace_root, paths, byte_budget=16 * 1024 * 1024 - before["bytes_read"] - observer_bytes - charged_child_bytes)
        binding, manifest = _executed_input_binding(
            workspace_root=workspace_root, admitted_commit=admitted_commit,
            roles=scoped_files, paths=paths, argv=argv, before=before, after=after,
            capture_started_at=capture_started_at,
        )
        if execution_profile is not None:
            _attach_environment_observation(
                binding, manifest, argv=argv, spawned_argv=spawned_argv, receipt=receipt,
                observer_hash=observer_hash, selected=selected_profile,
                reserved_bytes=reserved_bytes, charged_bytes=charged_child_bytes,
                observer_bytes=observer_bytes, observer_paths=observer_paths,
                child_path_limit=child_path_limit,
                diagnostics=observation_diagnostics, child_time_budget=child_time_budget,
                observer_source=observed,
                receipt_elapsed=receipt_elapsed,
            )
    log_path = _write_run_log(
        base_dir=base_dir,
        cycle_id=cycle_id,
        validation_plan_id=validation_plan_id,
        ordinal=ordinal,
        command=command,
        argv=spawned_argv,
        stdout=stdout,
        stderr=stderr,
        input_manifest=manifest,
    )
    # E21-a — ONE writer for the validation_runs surface. The argv that
    # actually executed lives in the hash-bound log rather than as a
    # second ledger column, so ``cmd`` and the executed vector cannot
    # drift apart without breaking log_hash verification.
    return record_validation_run(
        change_id=change_id,
        cmd=command,
        exit_code=exit_code,
        duration_ms=duration_ms,
        timed_out=timed_out,
        log_path=log_path,
        commit_sha=commit_sha,
        runner_identity=runner_identity,
        change_author_identity=change_author_identity,
        started_at=started_at,
        completed_at=utc_now(),
        base_dir=base_dir,
        spawn_environment=spawn_env.report.to_ledger(),
        **({"input_binding": binding} if binding is not None else {}),
    )


def _write_run_log(
    *,
    base_dir: str | Path | None,
    cycle_id: str | None,
    validation_plan_id: str | None,
    ordinal: int,
    command: str,
    argv: list[str],
    stdout: str,
    stderr: str,
    input_manifest: dict[str, Any] | None = None,
) -> Path:
    """Persist the run's output on the declared log artifact surface.

    ``verify_validation_run`` re-hashes this file at gate time, so the
    log is the content-addressed anchor of the run — not a convenience
    dump. The random suffix keeps two runs of the same command in the
    same plan from overwriting each other's evidence.
    """
    slug = _log_slug(validation_plan_id or cycle_id or "run")
    path = validation_run_log_dir(base_dir) / (
        f"{slug}-{ordinal:03d}-{secrets.token_hex(6)}.log"
    )
    path.write_text(
        "\n".join(
            [
                f"command: {command}",
                f"argv: {argv!r}",
                "--- stdout ---",
                stdout,
                "--- stderr ---",
                stderr,
                *(["input_manifest: " + _canonical_input_json(input_manifest)] if input_manifest is not None else []),
                "",
            ],
        ),
        encoding="utf-8",
    )
    return path


def _normalize_input_scope(scope: dict[str, Any]) -> dict[str, list[str]]:
    if not isinstance(scope, dict) or type(scope.get("schema_version")) is not int or scope["schema_version"] not in (1, 2):
        raise GovernanceError("validation_input_scope_invalid")
    expected = {"schema_version", "files"} if scope["schema_version"] == 1 else {"schema_version", "files", "execution_profile"}
    if set(scope) != expected:
        raise GovernanceError("validation_input_scope_invalid")
    files = scope["files"]
    if not isinstance(files, dict) or len(files) > 4 or not set(files) <= {"source", "test", "config", "dependency"}:
        raise GovernanceError("validation_input_scope_roles_invalid")
    result = {}
    for role in ("source", "test", "config", "dependency"):
        values = files.get(role, [])
        if not isinstance(values, list) or len(values) > 256:
            raise GovernanceError("validation_input_scope_path_limit")
        normalized = []
        for value in values:
            path = _scoped_input_path(value)
            if path is None:
                raise GovernanceError("validation_input_scope_path_invalid")
            normalized.append(path)
        result[role] = sorted(set(normalized))
    if len({p for values in result.values() for p in values}) > 256:
        raise GovernanceError("validation_input_scope_path_limit")
    return result


def _normalize_execution_profile(scope: dict[str, Any]) -> dict[str, Any] | None:
    if scope["schema_version"] == 1:
        return None
    profile = scope["execution_profile"]
    if type(profile) is not dict or set(profile) != {"kind", "modules"} or profile["kind"] != "python_unittest_public_v1":
        raise GovernanceError("validation_execution_profile_invalid")
    modules = profile["modules"]
    if type(modules) is not list or len(modules) > 8:
        raise GovernanceError("validation_execution_profile_invalid")
    for name in modules:
        if type(name) is not str or not 0 < len(name) <= 128 or len(name.encode("utf-8", errors="replace")) > 128 or not all(part.isidentifier() for part in name.split(".")):
            raise GovernanceError("validation_execution_profile_invalid")
    return {"kind": profile["kind"], "modules": sorted(set(modules))}


def _canonical_input_scope(scope: dict[str, Any]) -> dict[str, Any]:
    """Copy a descriptor through the existing execution-input owners."""
    files = _normalize_input_scope(scope)
    profile = _normalize_execution_profile(scope)
    result = {"schema_version": scope["schema_version"], "files": files}
    if profile is not None:
        result["execution_profile"] = profile
    return result


def _input_metadata_within_limit(value: dict[str, Any], *, limit: int = 65_536) -> bool:
    """Bound an optional carrier without retaining a full encoded string.

    Recipe/selection metadata uses this cap; direct validation descriptors
    keep their existing path/module limits and do not acquire this cap.
    """
    remaining = limit
    encoder = _json.JSONEncoder(sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    for chunk in encoder.iterencode(value):
        size = len(chunk.encode("utf-8"))
        if size > remaining:
            return False
        remaining -= size
    return True


def _unittest_selectors(argv: list[str]) -> list[str]:
    if argv[:3] == ["python3", "-m", "unittest"] and len(argv) <= 260:
        candidates = [part for part in argv[3:] if part not in ("-v", "-q", "--verbose", "--quiet")]
        if candidates and len(candidates) <= 256 and all(len(part) <= 512 and all(segment.isidentifier() for segment in part.split(".")) and part != "discover" for part in candidates):
            return candidates
    return []


def _close_observation_fd(fd: int | None, end: str, diagnostics: list[str]) -> None:
    if fd is None:
        return
    try:
        os.close(fd)
    except OSError:
        # No retry: an interrupted close may already have released the fd.
        diagnostics.append("receipt_" + end + "_close_unavailable")


def _read_unittest_receipt(fd: int, limit: int, byte_budget: int, path_budget: int) -> dict[str, Any] | None:
    try:
        raw = os.read(fd, limit)
        value = _json.loads(raw)
        if type(value) is not dict or value.get("schema_version") != 1 or value.get("status") not in ("available", "unknown"):
            return None
        work = value.get("work")
        if type(work) is not dict or type(work.get("bytes_read")) is not int or not 0 <= work["bytes_read"] <= byte_budget or type(work.get("content_paths")) is not int or not 0 <= work["content_paths"] <= path_budget:
            return None
        elapsed = work.get("observation_elapsed_seconds")
        if type(elapsed) not in (int, float) or not _math.isfinite(elapsed) or elapsed < 0:
            return None
        if value["status"] == "available" and (type(value.get("stable")) is not dict or type(value.get("observation")) is not dict):
            return None
        return value
    except (OSError, ValueError, UnicodeError):
        return None


def _attach_environment_observation(
    binding: dict[str, Any], manifest: dict[str, Any], *, argv: list[str], spawned_argv: list[str],
    receipt: dict[str, Any] | None, observer_hash: str | None, selected: bool,
    reserved_bytes: int, charged_bytes: int, observer_bytes: int, observer_paths: int, child_path_limit: int,
    diagnostics: list[str], child_time_budget: float, observer_source: dict[str, Any] | None,
    receipt_elapsed: float,
) -> None:
    child_elapsed = receipt["work"]["observation_elapsed_seconds"] if receipt is not None else child_time_budget
    remaining = max(0.0, child_time_budget - child_elapsed - receipt_elapsed)
    deadline = time.monotonic() + remaining
    available = receipt is not None and receipt["status"] == "available" and remaining > 0
    facts = receipt["stable"] if available else {"interpreter": None, "public_environment": {}, "modules": {}}
    stable = {
        "schema_version": 1, "profile_kind": "python_unittest_public_v1", "observer_source_hash": observer_hash,
        "interpreter": facts["interpreter"], "observation_phase": "post_run",
        "public_environment": facts["public_environment"], "modules": facts["modules"],
        "config_digest": binding["config_digest"],
        "control_profile": {"status": "unknown", "reason": "bounded_profile_observation_pending"},
        "availability": {"interpreter": "observed_same_child" if available else "unknown", "effective_environment": "unknown",
                         "installed_dependencies": "unknown", "effective_configuration": "unknown"},
    }
    reason = "unsupported_command_profile" if not selected else receipt.get("reason", "receipt_unavailable") if receipt is not None else "receipt_unavailable"
    if "receipt_setup_unavailable" in diagnostics:
        reason = "receipt_setup_unavailable"
    elif receipt is not None and receipt["status"] == "available" and not available:
        reason = "observation_deadline"
    manifest["environment"] = {
        "schema_version": 1, "requested_argv": argv, "spawned_argv": spawned_argv,
        "unittest_argv": argv[3:] if selected else None, "stable": stable,
        "observation": receipt["observation"] if available else {"status": "unknown", "reason": reason, "phase": "post_run"},
        "diagnostics": diagnostics, "observer_source": observer_source,
        "work": {"child_reserved_bytes": reserved_bytes, "child_charged_bytes": charged_bytes,
                 "child_actual_bytes": receipt["work"]["bytes_read"] if receipt is not None else None,
                 "child_path_limit": child_path_limit, "child_content_paths": receipt["work"]["content_paths"] if receipt is not None else None,
                 "observer_bytes": observer_bytes, "observer_content_paths": observer_paths,
                 "metadata_budget_ms": 250, "child_budget_ms": child_time_budget * 1000,
                 "child_observation_elapsed_ms": child_elapsed * 1000 if receipt is not None else None,
                 "child_charged_ms": child_elapsed * 1000,
                 "parent_receipt_elapsed_ms": receipt_elapsed * 1000,
                 "remaining_before_final_ms": remaining * 1000,
                 "timing_scope": "parent_identity_setup_child_post_run_preparation_parent_receipt_environment_finalization"},
    }
    environment = manifest["environment"]
    digest = _input_digest(_canonical_input_json(stable).encode())
    # Check the bounded detailed ENV object as well as its comparison digest.
    # Existing S2 capture/binding and later native log persistence are outside
    # this active observation allowance; test wall time never enters it.
    _canonical_input_json(environment)
    if available and time.monotonic() >= deadline:
        stable.update(interpreter=None, public_environment={}, modules={})
        stable["availability"]["interpreter"] = "unknown"
        environment["observation"] = {"status": "unknown", "reason": "observation_deadline", "phase": "post_run"}
        digest = _input_digest(_canonical_input_json(stable).encode())
    binding["runner_environment_digest"] = digest
    binding["availability"]["runner_environment"] = {"status": "unknown", "reason": "partial_child_observation_only"}


def _canonical_input_json(value: Any) -> str:
    return _json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def _executed_input_binding(
    *, workspace_root: Path, admitted_commit: str | None,
    roles: dict[str, list[str]], paths: list[str], argv: list[str],
    before: dict[str, Any], after: dict[str, Any],
    capture_started_at: str,
) -> tuple[dict[str, Any], dict[str, Any]]:
    availability = {}
    digests = {}
    before_by_path = {row["path"]: row for row in before["files"]}
    for role, dimension in (("source", "source"), ("test", "test_content"), ("config", "config"), ("dependency", "dependency")):
        rows = [before_by_path[p] for p in roles[role]]
        complete = bool(rows) and all(row["status"] == "available" for row in rows)
        digests[dimension + "_digest"] = _scoped_input_digest(rows)
        availability[dimension] = {"status": "available" if complete else "unknown", "reason": "explicit_scope_only" if complete else "inputs_missing_unreadable_or_unspecified"}
    availability["dependency"] = {"status": "unknown", "reason": "installed_dependency_closure_uncaptured"}
    selectors = _unittest_selectors(argv)
    selection = {"schema_version": 1, "argv": argv if selectors else None, "selectors": selectors}
    availability["test_selection"] = {"status": "available" if selectors else "unknown", "reason": "explicit_selector_request_observed" if selectors else "dynamic_selection_uncaptured"}
    availability["selection_closure"] = {"status": "unknown", "reason": "actual_collection_and_load_tests_uncaptured"}
    availability["configuration_closure"] = {"status": "unknown", "reason": "effective_configuration_uncaptured"}
    availability["runner_environment"] = {"status": "unknown", "reason": "inherited_environment_uncaptured"}
    availability["base_commit_sha"] = {"status": "available", "reason": "workspace_head_at_batch_admission"}
    repo_identity = None
    try:
        identity, identity_source = _canonical_identity_observation(workspace_root)
        if identity_source["source"] in ("remote_url", "root_commit_sha"):
            repo_identity = identity
        identity_reason = "canonical_identity_source:" + identity_source["source"]
    except OSError:
        identity_reason = "repository_identity_unavailable"
    availability["repo_identity"] = {"status": "available" if repo_identity is not None else "unknown", "reason": identity_reason}
    for dimension in ("snapshot_hash", "repo_state_id"):
        availability[dimension] = {"status": "unknown", "reason": "full_snapshot_not_observed"}
    all_available = bool(paths) and all(row["status"] == "available" for observation in (before, after) for row in observation["files"])
    stability = "unchanged" if before["files"] == after["files"] else "changed"
    if not all_available:
        stability = "unknown"
    binding = {
        "schema_version": 1, "repo_identity": repo_identity,
        "snapshot_mode": "working_tree", "base_commit_sha": admitted_commit,
        "repo_state_id": None, "snapshot_hash": None, "scope_paths": paths,
        **digests,
        "test_selection_digest": _input_digest(_canonical_input_json(selection).encode()) if selectors else None,
        "runner_environment_digest": None, "source_stability": stability,
        "capture_started_at": capture_started_at, "capture_completed_at": utc_now(),
        "availability": availability,
    }
    manifest = {"schema_version": 1, "roles": roles, "before": before, "after": after, "selection": selection}
    return binding, manifest


def _log_slug(value: str) -> str:
    cleaned = "".join(
        char if char.isalnum() or char in "-_" else "-" for char in value
    ).strip("-")
    return cleaned[:48] or "run"


def parse_allowed_command(command: str) -> tuple[list[str], dict[str, str]]:
    """Resolve a command string to the argv this lane would execute.

    Public because a declared recipe that this lane would refuse is a
    hypothesis nobody can ever test, and discovering that at run time
    turns a typo into a failed nightly. A recipe manifest can therefore
    prove its commands executable at test time through THIS function —
    the one the runner itself calls — rather than through a second copy
    of the allowlist that would drift away from it.

    Side-effect free: it parses and refuses, it never runs anything.
    """
    if any(token in command for token in (";", "|", "&&", "||", ">", "<", "`", "$(")):
        raise GovernanceError("validation command contains unsupported shell syntax")
    try:
        parts = shlex.split(command)
    except ValueError as exc:
        raise GovernanceError(f"validation command cannot be parsed: {exc}") from exc
    if not parts:
        raise GovernanceError("validation command must not be empty")
    env_updates: dict[str, str] = {}
    while parts and "=" in parts[0] and not parts[0].startswith("-"):
        key, value = parts.pop(0).split("=", 1)
        if key != "PYTHONPATH":
            raise GovernanceError(f"validation command environment override is not allowed: {key}")
        env_updates[key] = value
    if not any(tuple(parts[: len(prefix)]) == prefix for prefix in ALLOWED_COMMANDS):
        raise GovernanceError("validation command is not in the approved allowlist")
    _validate_command_details(parts)
    return parts, env_updates


def _validate_command_details(parts: list[str]) -> None:
    if parts[:2] == ["npm", "run"]:
        if len(parts) < 3 or not _allowed_npm_script(parts[2]):
            raise GovernanceError("npm validation script is not approved")
    elif parts[:2] == ["npx", "nx"]:
        if len(parts) < 3 or parts[2] not in ("affected", "run-many"):
            raise GovernanceError("nx validation command must use affected or run-many")
        joined = " ".join(parts[3:])
        if not any(f"--target={target}" in joined or f"-t={target}" in joined for target in ("test", "lint", "build", "type-check")):
            raise GovernanceError("nx validation target is not approved")
    elif parts[:2] == ["npx", "ts-node"]:
        if not any(part.startswith("tools/aria-adapters/") and part.endswith((".test.ts", ".spec.ts")) for part in parts):
            raise GovernanceError("ts-node validation is limited to ARIA adapter tests")
    elif parts[:3] == ["python3", "-m", "aria_kernel"]:
        if parts[3:] != ["integrity", "verify"]:
            raise GovernanceError("aria_kernel validation command is limited to integrity verify")
    elif parts[:3] == ["python3", "-m", "unittest"]:
        return
    elif parts[:1] == ["cargo"]:
        subcommand = parts[1] if len(parts) > 1 else None
        if subcommand not in ALLOWED_CARGO_SUBCOMMANDS:
            raise GovernanceError(
                f"cargo validation subcommand is not approved: "
                f"{subcommand!r} is not one of {ALLOWED_CARGO_SUBCOMMANDS}; "
                f"this lane admits non-mutating verbs only"
            )
        if any(
            part == _REFUSED_CARGO_FLAG or part.startswith(f"{_REFUSED_CARGO_FLAG}=")
            for part in parts[2:]
        ):
            raise GovernanceError(
                f"cargo validation flag is not approved: {_REFUSED_CARGO_FLAG} "
                f"can point cargo at a runner of the caller's choosing, which "
                f"would make an allowed verb execute an arbitrary program"
            )


def _allowed_npm_script(script: str) -> bool:
    allowed_exact = {
        "test",
        "test:all",
        "lint",
        "lint:all",
        "build",
        "build:all",
        "build:web",
        "type-check",
        "format:check",
    }
    return script in allowed_exact or script.startswith("gates:") or script.startswith("invariants:")


def _dirty_worktree(root: Path) -> bool:
    if not (root / ".git").exists():
        return False
    completed = subprocess.run(
        ["git", "status", "--porcelain"],
        cwd=root,
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        raise GovernanceError("unable to inspect git worktree before validation")
    return bool(completed.stdout.strip())


def _decode_timeout_stream(value: str | bytes | None) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return value
