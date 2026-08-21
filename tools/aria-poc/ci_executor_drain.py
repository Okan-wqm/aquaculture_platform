"""Batch (drain) mode for the scheduled ARIA executor lane — ORPHAN-HIGH-637.

Separate module by design: `ci_executor.py` is the single-request engine
(~2500 lines, argv contract locked by I-V3-21); the loop that decides WHAT
to run next is an independent concern and lives here so neither file grows
past readability. Each request is still dispatched through the locked
single-request argv as a subprocess — claim/lease/submit semantics are
byte-identical to a targeted dispatch.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

# The single-request engine owns the stage logger and the optional
# governance-append binding; reuse them so drain rows land in the same
# audit stream with the same formatting.
_POC_DIR = Path(__file__).resolve().parent
if str(_POC_DIR) not in sys.path:
    sys.path.insert(0, str(_POC_DIR))
import ci_executor as _engine


# Drain-mode wall-clock budget: the time window the WHOLE loop must fit in,
# including the last child's worst case. The first live night (run
# 31542485896) proved elapsed-only accounting wrong: the loop started its
# third request at t=1987s — inside the 2100s budget — but that child could
# legally run MAX_TIMEOUT_SECONDS=1800s more, sailed past the job's
# 45-minute reaper, and the whole run was CANCELLED before the state
# publish: two submitted results died with the runner (the
# ORPHAN-CRITICAL-484 class). A child is now started only if its WORST
# CASE still fits inside the budget, and the workflow sizes the budget so
# publish always has its reserve.
DEFAULT_DRAIN_BUDGET_SECONDS = 2100


# E3/D10b + Y4 (ORPHAN-705) — the full arc order, planning lane first.
# The four-role priority prefix fixed oldest-first starvation for the
# planning roles and created it for everyone it omitted: the second sealed
# night showed maintenance_utility and the adjudication roles queued behind
# 64 judge envelopes at ~9 drains/night — structurally never reached. Every
# dispatchable-or-minted role now has a place in the arc; the quota round
# below guarantees each WAITING role one slot per run before any role gets
# a second, and the fallback spends the remaining budget in this same order.
#
# ORPHAN-HIGH-786 — judges sit directly after the planning core, not last.
# The anti-starvation property is the QUOTA ROUND (one guaranteed slot per
# waiting role), never the arc order — the fallback only distributes
# SURPLUS. Judges were last "by design" and that design starved exactly the
# readiness-critical lane: anchor promotion needs `ANCHOR_PROMOTION_MIN_JUDGMENTS`
# verdict pairs, and the 2100s fallback budget was routinely spent before
# reaching positions 13-14, leaving judges their single quota slot against
# a 60-envelope nightly mint. Judges also precede arbitration deliberately:
# arbiter demand is DERIVED from judge verdicts (split groups exist only
# after judges return), so draining judges first matches the same-night
# data dependency.
_ROLE_QUOTA_ORDER: tuple[str, ...] = (
    "implementation",
    "cross_review",
    "challenger_plan",
    "primary_plan",
    "evidence_judgment",
    "adversarial_judgment",
    "consensus_arbitration",
    "human_required_adjudication",
    "completeness_critique",
    "verification",
    "change_intelligence",
    "goldset_curation",
    "specialist_domain_review",
    "maintenance_utility",
)


def _drain_budget_seconds() -> int:
    return int(
        os.environ.get("ARIA_DRAIN_BUDGET_SECONDS", DEFAULT_DRAIN_BUDGET_SECONDS)
    )


def _next_pending_for_role(
    *,
    tools_dir: Path,
    repo_root: Path,
    role_filter: str | None,
    attempted: set[str],
) -> tuple[dict | None, str | None]:
    """One kernel next-pending query. Returns (candidate, error_reason)."""
    argv = [
        "python3", "-m", "aria_kernel", "agent", "next-pending",
        "--tools-dir", str(tools_dir),
    ]
    if role_filter is not None:
        argv += ["--role", role_filter]
    for excluded in sorted(attempted):
        argv += ["--exclude", excluded]
    pending_proc = subprocess.run(
        argv,
        capture_output=True,
        text=True,
        env={**os.environ, "PYTHONPATH": str(repo_root / "aria-kernel")},
    )
    if pending_proc.returncode != 0:
        _engine._stage(f"drain_next_pending_failed rc={pending_proc.returncode}")
        sys.stderr.write(pending_proc.stderr[-1000:] + "\n")
        return None, "next_pending_failed"
    try:
        candidate = json.loads(pending_proc.stdout or "null")
    except json.JSONDecodeError:
        _engine._stage("drain_next_pending_not_json")
        return None, "next_pending_not_json"
    if candidate and candidate.get("request_id"):
        return candidate, None
    return None, None


def drain_pending(*, tools_dir: Path, repo_root: Path) -> int:
    """Consume pending agent requests until the queue, cap, or clock runs out.

    Why this exists: the nightly executor claimed exactly ONE request per run
    while the producer mints many per cycle, so the queue only ever grew —
    162 pending judge requests against a 1/day consumer is a lane that can
    never catch up. `MAX_REQUESTS_PER_RUN` was exported by the workflow and
    read by nothing, the exact "tunable that gates nothing" class this file
    already condemns (ORPHAN-HIGH-472). This loop makes it real.

    Each request still runs through the SINGLE-REQUEST path as a subprocess
    (`ci_executor.py <request_id> <target_agent>` — the argv shape locked by
    invariant I-V3-21), so claim/lease/submit semantics are byte-identical
    to a targeted dispatch. The loop only decides WHAT to run next:

    * queue empty → clean stop;
    * `MAX_REQUESTS_PER_RUN` reached → stop, the rest keeps until tomorrow;
    * wall-clock budget spent → stop starting new work;
    * next-pending returns a request this run already attempted → stop.
      A failed child releases its claim, so the same request surfaces again
      immediately; retrying it in the same environment would burn its whole
      requeue budget in one night pricing an environment fault as N request
      failures (the M-2.5 class the pre-claim gate exists to prevent).

    `target_agent` is passed through from the request row — the workflow's
    single-shot path passed only the request id, so every drained request
    would otherwise run under the `aria-evidence-judge` default profile even
    when the kernel minted it for a different agent.

    Exit code: 0 when every attempted dispatch succeeded (or none were
    pending); 1 when any child failed — the work that DID succeed is already
    submitted by the children, so a red run reports the failure without
    discarding the night's progress.
    """
    started = time.monotonic()
    attempted: set[str] = set()
    # Y4 (ORPHAN-705) — roles still owed their guaranteed slot this run.
    quota_pending: list[str] = list(_ROLE_QUOTA_ORDER)
    succeeded = 0
    failed = 0
    stop_reason = "queue_empty"
    envelope_paths: list[str] = []
    transcript_paths: list[str] = []
    parent_github_output = os.environ.get("GITHUB_OUTPUT")

    while True:
        if len(attempted) >= _engine._max_requests():
            stop_reason = "max_requests_reached"
            break
        # A child may legally run MAX_TIMEOUT_SECONDS; start it only if that
        # worst case still fits inside the budget. Elapsed-only accounting
        # let the first live night start a request at t=1987s of a 2100s
        # budget and get the whole run reaped mid-child (run 31542485896).
        elapsed = time.monotonic() - started
        if elapsed + _engine._max_timeout_seconds() > _drain_budget_seconds():
            stop_reason = "budget_exhausted"
            break
        # Smoke-run 31653106474 — the JOB deadline is a drain-level stop,
        # not a per-request failure: the refused-spawn error was treated as
        # one request failing, so the loop kept iterating request after
        # request (each burning preflight seconds) into the job wall while
        # the night's state went unterminated → quarantined. Same env
        # contract as the spawn clamp (ORPHAN-661); no env → never stops.
        raw_deadline = os.environ.get("ARIA_JOB_DEADLINE_EPOCH")
        if raw_deadline:
            try:
                if time.time() >= float(raw_deadline):
                    stop_reason = "job_deadline_reached"
                    break
            except ValueError:
                pass  # the spawn clamp already refuses garbage loudly

        # E3/F10 + D10b + Y4 (ORPHAN-705) — quota round, then arc-order
        # fallback, with tonight's attempted set EXCLUDED at the kernel.
        # Three defects have died here: (a) a released claim used to come
        # straight back as the oldest row and END the night; (b) strict
        # oldest-first starved the planning lane behind judge volume;
        # (c) the four-role priority prefix starved every role it omitted —
        # maintenance_utility and the adjudication roles sat behind 64
        # judge envelopes at ~9 drains/night, structurally unreachable.
        # The quota round guarantees each WAITING role one slot per run
        # (arc order); only then does the fallback hand out seconds, in the
        # same arc order, with role=None as the final catch-all.
        request = None
        selection_error = None
        while quota_pending and request is None and selection_error is None:
            role_filter = quota_pending.pop(0)
            candidate, selection_error = _next_pending_for_role(
                tools_dir=tools_dir, repo_root=repo_root,
                role_filter=role_filter, attempted=attempted,
            )
            if candidate is not None:
                request = candidate
        if request is None and selection_error is None:
            for role_filter in _ROLE_QUOTA_ORDER + (None,):
                candidate, selection_error = _next_pending_for_role(
                    tools_dir=tools_dir, repo_root=repo_root,
                    role_filter=role_filter, attempted=attempted,
                )
                if selection_error is not None or candidate is not None:
                    request = candidate
                    break
        if selection_error is not None:
            # Infrastructure: the drain could not even choose work. This IS a
            # drain failure (ORPHAN-HIGH-737 keeps this arm red on purpose).
            stop_reason = selection_error
            failed += 1
            break
        request_id = (request or {}).get("request_id")
        if not request_id:
            # Nothing pending outside tonight's attempted set — the queue
            # is exhausted for this run (clean stop, not a failure).
            break
        attempted.add(request_id)

        target_agent = str(request.get("target_agent") or "").strip()
        child_argv = ["python3", str(_POC_DIR / "ci_executor.py"), request_id]
        if target_agent:
            child_argv.append(target_agent)

        # The child announces its envelope/transcript paths via GITHUB_OUTPUT
        # (_publish_artifact_paths). Point each child at its own scratch file
        # so the parent can AGGREGATE them — children appending to the real
        # GITHUB_OUTPUT would each overwrite the step output key, and the
        # artifact upload would only ever see the LAST request of the night.
        child_output = (
            Path(os.environ.get("RUNNER_TEMP", "/tmp"))
            / f"aria-drain-output-{request_id}.txt"
        )
        child_env = {**os.environ, "GITHUB_OUTPUT": str(child_output)}
        _engine._stage(f"drain_dispatch request_id={request_id} target={target_agent or '-'}")
        child = subprocess.run(child_argv, env=child_env, cwd=str(repo_root))
        if child.returncode == 0:
            succeeded += 1
        else:
            failed += 1
        if child_output.exists():
            for line in child_output.read_text(encoding="utf-8").splitlines():
                if line.startswith("envelope_path="):
                    envelope_paths.append(line.split("=", 1)[1])
                elif line.startswith("transcript_path="):
                    transcript_paths.append(line.split("=", 1)[1])
            child_output.unlink()

    _engine._stage(
        f"drain_done attempted={len(attempted)} succeeded={succeeded} "
        f"failed={failed} stop={stop_reason}"
    )
    if _engine._append_tools_governance is not None:
        try:
            _engine._append_tools_governance(
                tools_dir,
                "executor_drain_completed",
                {
                    "attempted": len(attempted),
                    "succeeded": succeeded,
                    "failed": failed,
                    "stop_reason": stop_reason,
                    "run_id": os.environ.get("GITHUB_RUN_ID", "local"),
                },
            )
        except Exception as exc:  # noqa: BLE001 — governance-write failure
            # must not mask the drain result it is trying to record.
            sys.stderr.write(f"governance_write_failed: {exc}\n")

    if parent_github_output:
        with open(parent_github_output, "a", encoding="utf-8") as handle:
            handle.write("envelope_path<<ARIA_DRAIN_EOF\n")
            handle.write("".join(f"{path}\n" for path in envelope_paths))
            handle.write("ARIA_DRAIN_EOF\n")
            handle.write("transcript_path<<ARIA_DRAIN_EOF\n")
            handle.write("".join(f"{path}\n" for path in transcript_paths))
            handle.write("ARIA_DRAIN_EOF\n")
            handle.write(f"drained={succeeded}\n")
            handle.write(f"drain_failed={failed}\n")
    return 0 if failed == 0 else 1
