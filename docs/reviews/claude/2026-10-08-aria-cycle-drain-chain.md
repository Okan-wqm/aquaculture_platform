# The drain never followed a chained cycle (2026-10-08)

Context: after #1861, the F-013 implementer was waiting for the next executor run.

- Cycle 37728223278 had been started at 04:35Z by the executor's own `chain-next-cycle` job.
- It finished at 05:55Z, and F-015's plan started inside it.
- No executor run followed. Ten minutes later the API still listed none, and no run had been
  skipped either. The executor had to be dispatched by hand (37735581293).

Owner: claude (implementation), okan (review). Deadline 2026-10-15.

## ARIA-HIGH-386

The loop has two edges.

- **Return edge** (drain → cycle): `aria-agent-executor.yml` `chain-next-cycle` dispatches the
  cycle with the job token when the rhythm allows it.
- **Forward edge** (cycle → drain): a `workflow_run` trigger on the executor
  (ORPHAN-724).

GitHub creates no `workflow_run` event for a run that was started with the job token. The one
event that token may create is `workflow_dispatch`. Two things start the cycle with the job
token:

- the return edge (`aria-agent-executor.yml:1041` on main);
- the dataflow watchdog (`dataflow-integrity-watchdog.yml:128`).

So every chained cycle ended with no drain after it. The loop ran one cycle and stopped until a
person or the 02:29Z cron dispatched the executor. In the run metadata:

- cycle 37692913055 (`schedule`, actor `Okan-wqm`) was followed by executor 37705018969
  (`workflow_run`);
- cycle 37728223278 (`workflow_dispatch`, actor `github-actions[bot]`) was followed by
  nothing.

Fix:

- The forward edge is now an explicit dispatch. `aria-auto-cycle.yml` gains a hosted
  `chain-executor` job: `needs: cycle`, `if: !cancelled()`, `actions: write` only. It runs
  `gh workflow run aria-agent-executor.yml`.
- The executor's `workflow_run` trigger is removed, so there is one mechanism, not two.
- Ordering is unchanged: the executor's run waits in the shared `aria-selfhosted-workspace`
  concurrency group until the cycle run has finished.
- A cycle an operator cancels chains nothing.
- The executor's inputs keep their defaults, so the drain runs real (`mock` defaults to
  `false`), as it did under `workflow_run`.

Detection (tier 3): `aria-kernel/tests/test_workflow_chain_edges.py`.

- I-CHAIN-01 fails when any workflow listens for `workflow_run` on a workflow that any workflow
  starts with the job token.
- I-CHAIN-02 and I-CHAIN-03 pin both edges of the loop.
- Against main it fails twice:
  - I-CHAIN-01 names `aria-agent-executor.yml:chain-next-cycle` and
    `dataflow-integrity-watchdog.yml:probe`;
  - I-CHAIN-02 finds no forward edge.
