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


def _drain_budget_seconds() -> int:
    return int(
        os.environ.get("ARIA_DRAIN_BUDGET_SECONDS", DEFAULT_DRAIN_BUDGET_SECONDS)
    )


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

        pending_proc = subprocess.run(
            [
                "python3", "-m", "aria_kernel", "agent", "next-pending",
                "--tools-dir", str(tools_dir),
            ],
            capture_output=True,
            text=True,
            env={**os.environ, "PYTHONPATH": str(repo_root / "aria-kernel")},
        )
        if pending_proc.returncode != 0:
            _engine._stage(f"drain_next_pending_failed rc={pending_proc.returncode}")
            sys.stderr.write(pending_proc.stderr[-1000:] + "\n")
            stop_reason = "next_pending_failed"
            failed += 1
            break
        try:
            request = json.loads(pending_proc.stdout or "null")
        except json.JSONDecodeError:
            _engine._stage("drain_next_pending_not_json")
            stop_reason = "next_pending_not_json"
            failed += 1
            break
        request_id = (request or {}).get("request_id")
        if not request_id:
            break
        if request_id in attempted:
            _engine._stage(f"drain_repeat_request request_id={request_id}")
            stop_reason = "repeat_request"
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
