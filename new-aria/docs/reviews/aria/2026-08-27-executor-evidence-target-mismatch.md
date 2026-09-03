# ARIA review — 2026-08-27: executor evidence cites post-edit files against the pre-edit target SHA

The `aria-agent-executor` lane dies at result submission with
`agent_evidence_not_repo_verified ... worktree_candidate` (runs 32800394101
et al.), plus occasional `satisfaction_matrix missing entries for
must_satisfy ids: ['verdict']`.

## Root cause

`evidence_trust.py` grades a ref `repo_verified` only when the file's
SHA-256 equals the git blob at the resolved `target_sha`. The executor's
agents fix files in their worktree and cite the POST-FIX lines as
evidence, while the submit verifies against the BASE sha the request
envelope carried (`agent_invocations.py` threads `target_sha` from the
request context). Modified content can never match the pre-edit blob, so
every genuine fix is graded `worktree_candidate` and the submit is
rejected — the lane's agents are structurally unable to satisfy the
contract they are judged by.

The `satisfaction_matrix` rejections are the same class at the response
layer: the request's `must_satisfy` ids do not match the ids the agent's
response matrix carries.

## ARIA-HIGH-022 — executor agents are judged against a baseline their own work invalidates

Evidence verification needs a target the agent's evidence can actually
match: either the agent's committed head (for refs inside its diff) or
the base sha (for untouched files), and the response contract must be
generated from the same `must_satisfy` set the validator enforces.

## Fix direction (deferred — challenger envelope lifecycle work)

- Executor submits with a per-ref target: agent-commit SHA for refs the
  agent touched, base SHA otherwise; or
- The claim carries the diff and cites pre-state lines.

Not implemented in this pass: it changes the request/response contract
surface shared with the consensus and anchor paths and needs its own
invariant coverage.
