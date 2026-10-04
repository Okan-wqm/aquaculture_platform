# Runbook — bootstrapping the `aria/state` branch

**Audience:** repository operator (admin rights required for step 1).
**Frequency:** exactly once per repository. If you are running this a
second time, stop and read "When the branch already exists" below.

## Why this is an operator action and not an automatic one

ARIA can create this branch itself in seconds. It deliberately will not.

`aria/state` holds every ledger ARIA accumulates. A process that can
create the branch when it is missing is a process that can replace an
existing history with an empty one whenever it fails to SEE the branch —
a network blip, a wrong remote, a token without read scope. That is
ORPHAN-CRITICAL-484, which cost ARIA its queue once already through the
artifact transport.

So `checkout_state_store` refuses when the branch is absent, and the
refusal names the value you must set to authorise a first bootstrap. The
acknowledgement carries the repository's own `owner/repo`, which is what
keeps it single-use in practice: an ack left behind in a workflow does
not travel to a fork or a renamed repository, and it cannot be a bare
`1` pasted forward by someone who did not read it.

## Step 1 — protect the branch (do this FIRST)

The store's compare-and-swap IS git's fast-forward rule: two lanes
racing both push, and the server rejects the loser. That guarantee holds
only while nothing can force-push. Add a ruleset before there is
anything to lose:

- Repository → Settings → Rules → Rulesets → New branch ruleset
- Target: `aria/state`, `aria/state-cold` (the content-addressed store
  every publish evicts old cycles into, ARIA-HIGH-274; the first eviction
  creates it, so it must be covered before that publish) and
  `aria/state-lease` (the writer lease, ARIA-HIGH-342: every publish pushes a
  fast-forward fence onto it atomically with the state, so a force-push there
  would void the one-writer guarantee exactly as one on `aria/state` would)
- Enable: **Restrict deletions**, **Block force pushes**; no bypass actors
- Do NOT require a pull request — ARIA's lanes push directly, and the
  branch carries no code.

Verify the ruleset is active before continuing:

```bash
PYTHONPATH=aria-kernel python3 -m aria_kernel readiness probe-state-branch-protection \
  --repo Okan-wqm/aquaculture_platform
```

Expected `"valid": true`; each uncovered branch is named as
`state_branch_unprotected:<branch>:<rule>`. Doing this after the
branch exists leaves a window in which a mistaken force-push silently
discards published state, and a discarded publish is not recoverable
from the artifact cache once it has expired.

## Step 2 — bootstrap

From a checkout of the repository, on a machine whose `origin` points at
the real remote. aria/state has one writer at a time (ARIA-HIGH-342): the
operator lane takes the writer lease BEFORE the checkout, presents its token
to the publish, and gives it back afterwards — the same turn every workflow
takes. `state publish` refuses without it (`state_writer_lease_required`).

```bash
export ARIA_STATE_BOOTSTRAP_ACK="Okan-wqm/aquaculture_platform"

# 1. Take the writer lease. Exit 3 means another writer holds it; the JSON
#    names the holder, its run and its expiry. Do not work around it.
PYTHONPATH=aria-kernel python3 -m aria_kernel state lease acquire \
  --repo-root . --ttl-minutes 60 --token-file "$HOME/.aria-state-lease-token"

# 2. Present its capability to the publish (the token is a secret; it is
#    never printed, and lease.json stores only its SHA-256).
export ARIA_STATE_WRITER_LEASE_TOKEN="$(cat "$HOME/.aria-state-lease-token")"

PYTHONPATH=aria-kernel python3 -m aria_kernel state checkout --repo-root .
```

`--repo-hash` is derived from the repository and is not something to
supply by hand; the output echoes the value it used.

Expected output includes `"bootstrapped": true` and a
`published_snapshot_id` of `null` — the branch now exists locally with a
`GENESIS` commit and nothing published yet.

Then publish the first snapshot:

```bash
PYTHONPATH=aria-kernel python3 -m aria_kernel state publish \
  --repo-root . \
  --snapshot-id "bootstrap-$(date -u +%Y%m%dT%H%M%SZ)" \
  --cycle-id "operator-bootstrap"
```

Expected: `"published": true`, `"pushed": true`,
`"continuity": {"status": "genesis"}`.

Then give the lease back:

```bash
PYTHONPATH=aria-kernel python3 -m aria_kernel state lease release --repo-root .
unset ARIA_STATE_WRITER_LEASE_TOKEN && rm -f "$HOME/.aria-state-lease-token"
```

A publish that finds the branch moved under its lease, or the lease taken over
after its expiry, refuses as `state_writer_lease_lost` and keeps its rows in the
store; it never replays them onto someone else's turn.

**Unset `ARIA_STATE_BOOTSTRAP_ACK` afterwards.** It is not needed again,
and leaving it exported in a shell profile or a workflow re-arms the
exact failure this runbook exists to prevent.

## Step 3 — confirm

```bash
git fetch origin aria/state
git log --oneline origin/aria/state
```

Two commits: `chore(aria-state): genesis for aria/state` and the
bootstrap snapshot. Then:

```bash
PYTHONPATH=aria-kernel python3 -m aria_kernel state verify-store --repo-root .
```

Expected `"valid": true`, `"drifted_surfaces": []`.

## When the branch already exists

`checkout_state_store` will not bootstrap over it — it checks the remote
before it looks at the acknowledgement. If you believe the branch is
missing but ARIA reports it present, the fetch is succeeding and your
local view is stale; run `git fetch origin aria/state` and look again.

If the branch is genuinely gone (deleted by mistake), **do not
re-bootstrap to make the error go away.** A fresh bootstrap publishes an
empty tree that every later snapshot will chain to, and the accumulated
state is then unreferenced. Recover the branch from the most recent
`aria-state-cache-<run_id>` artifact — the run-scoped forensic copy each
lane uploads — or from a runner's local worktree first, and only bootstrap
if you have confirmed there is nothing to recover. (Before the lane cutover
this named the `aria-tools-state` artifact, which no longer exists; the
retention window is the same 30 days, but you now pick the run rather than
trusting "the latest".)

## When the writer lease is wedged

- **A holder died without releasing.** `state lease status --repo-root .` names
  it. Its lease frees itself at the recorded expiry (job timeout plus the
  35-minute publish margin). To free it sooner, after confirming its run is
  gone:
  `state lease release --repo-root . --force-foreign --reason "<run id> died at <time>"`.
  The release is a commit on `aria/state-lease` that records who and why.
- **The record cannot be parsed** (`state_writer_lease_record_invalid` or
  `_record_missing` — every reader fails closed on it):
  `state lease repair --repo-root . --reason "<what happened>"`. It pushes a
  released record as a fast-forward child, so the broken one stays in history.
  It refuses a valid, held lease; use the force-foreign release for that.
- Never force-push or delete `aria/state-lease`; the ruleset forbids both.

## Exit codes

| Code | Meaning                                           | Retry?                    |
| ---- | ------------------------------------------------- | ------------------------- |
| 0    | Published, or store verified clean                | —                         |
| 1    | Verification failed (drift), or a transport error | Yes, for transport        |
| 3    | Refusal: the state does not permit this write     | **No** — read the message |

Exit 3 is a verdict, not a fault. `state_publish_ancestry_unproven` means
the tree you are publishing does not descend from what is published;
retrying cannot change that, and forcing it past would bury state.

## Related

- `aria-kernel/aria_kernel/state_store.py` — the module docstring records
  which finding each refusal answers.
- `docs/plans/2026-08-02-aria-full-autonomy-program/PLAN.md` — Wave 1.
- `docs/runbooks/aria-github-app-setup.md` — the token the lanes push with.
