# ARIA full-system audit — 2026-09-01

**Agent:** codex (report scaffold) + zcode (verification, remediation) · **Base:** `origin/main@d0afe46bd`
**Snapshot warning:** ARIA moved while this audit ran. Two remediation branches
(`fix/aria-ack-env-export` → PR #1385, `fix/aria-kernel-security-defects`) landed
fixes for findings below DURING the audit. Every claim names the evidence it was
verified against; re-verify against your own HEAD before relying on a number.

## Scope and method

Full-lane walk of ARIA as it runs today: the `aria/state` transport and its
continuity gates, the producer/consumer lanes (`aria-auto-cycle`,
`aria-agent-executor`, maintenance/watchdog lanes), the kernel's promotion and
dispatch authorities, and the operator tooling around them. Method: code-level
reading plus controlled reproduction — every CRITICAL/HIGH finding below was
reproduced before it was fixed, and each fix carries a regression test that
fails on pre-fix code.

## Execution map (as verified 2026-09-01)

```text
nightly  aria-auto-cycle ── restore ── autonomy run ── publish ──┐
~40min   aria-agent-executor ── restore ─ agent step ─ publish ──┤── aria/state (fast-forward-only)
daily    aria-state-maintenance ── compact JSONL + strip hot ────┤   (self-inconsistent since 08-31, see F1)
watchdogs (external/readiness/sweep) ── read tip freshness ──────┘
```

## Verified findings

### F1 — aria/state is self-inconsistent: the guard was right, the surgery was manual

The executor's `state_publish_continuity_surfaces_lost` refusals (exit 3, five
consecutive failures) were **ARIA behaving as designed**. Evidence:

- Branch tip `15413f2d` (2026-08-31T05:42) carries `snapshot.json` from the last
  successful executor publish declaring **158 `runtime_artifact_hot` surfaces**
  (first `cyc-20260810T063724Z-auto/2313ef70…`, last `cyc-20260822T153253Z-auto/ff550ef8…`
  — byte-identical to the refusal's `lost_surfaces` list).
- The tree at that tip contains **zero** of those files.
- Branch history: 04:08 `manual compaction 842MB→172MB` (deleted the files, did
  not update `snapshot.json`) → 05:13 ledger reset → 05:16 full reset → 05:42
  revert that restored pre-reset ledgers but not the deleted artifacts.
- The 20:48 `aria-state-maintenance` run was a no-op ("state already compact",
  saved=0, nothing pushed).

**Remediation path (operator-ACK, by design):** repo variable
`ARIA_STATE_BOOTSTRAP_ACK=operator-approved-fresh-start-20260831` + kernel ACK
bypasses (#1379/#1383). One ACK-blessed publish re-slims the declared manifest
and the branch heals; the ACK is single-shot, not a standing flag.

### F2 — the ACK never reached the gates that read it (PR #1385, commit `ee46835f5`)

The restore action passed `bootstrap-ack` only to the `state checkout` command's
env; `state publish` and the autonomy runner read `ARIA_STATE_BOOTSTRAP_ACK`
from their own process env and never saw it. PR #1382 — which claimed to export
it to the runner env — **landed empty** (its workflow diff was lost in a rebase
conflict; `git show 79b95dab2 --name-status` is empty). Fix: the restore action
exports the ACK into `GITHUB_ENV` on the success path, same as the store
binding — one plumbing point inherited by every lane.

### F3 — forged `panel_approval_token` promotes SHADOW → ACTIVE (CRITICAL)

Controlled reproduction confirmed; fixed on `fix/aria-kernel-security-defects`
(`3575e35c8`). Presence-only check at `tool_registry.py` consume site;
`promotion_veto.verify_panel_approval_token` now re-derives the mint and
compares MACs in constant time. I-V6.4-04 pin rewritten. Details:
`docs/reviews/zcode/2026-09-01-aria-kernel-security-defects.md` §1.

### F4 — `worktree-prune --acknowledge` deleted out-of-repo absolute paths (CRITICAL)

Dispatch-ledger rows are agent-driven state; the prune path ran
`git worktree remove --force` and an unconditional `shutil.rmtree` fallback on
whatever path a row named. Containment guard added (strictly-inside-repo-root or
refuse with `worktree_outside_repo`). Details: same doc §2. Record-time
validation of ledger paths remains open with the finding.

### F5 — the "lossless" compaction archive lost the stripped data (HIGH)

`_archive_stripped` serialized the same shallow-aliased row objects the live
ledger kept — 100 evidence envelopes unrecoverable, originals mutated. Fixed
with pre-mutation deep copies; archive contract is now "pristine stripped rows
only". Details: same doc §3.

### F6 — an overnight advisory turned every merge gate red (MEDIUM, SUPPLY-MEDIUM-004)

`GHSA-vcc3-ghjq-m6fr` (decode-uri-component DoS) reached the production graph
only via `minio@8.0.7 → query-string@7.1.3 → decode-uri-component@0.2.2`;
`npm audit --audit-level=moderate --omit=dev` failed, and `security-audit` /
`security-scan` / `merge-gate` blocked every PR including the ARIA recovery.
Upstream-blocked in every direction (minio latest pins query-string ^7; 9.x is
ESM-only; 0.5.0 changed its CJS export shape). Remedy: the repo's established
dependency-floor override (`^0.5.0`), runtime-proven on minio's only call path
(`stringify`; decode is parser-side, single-consumer graph). Jest needs the
package in its transform allowlist (see WIP).

### F7 — the runner host is the production droplet, and it OOM'd the lanes (ops, CRITICAL-in-context)

The self-hosted runner shares a 4-core / 7.8 GB box with the full production
stack. On 2026-09-01 morning, a dispatched cycle + a full PR-check matrix +
production exceeded memory: cycle #26 died exit 137, the runner service was
restarted, postgres/redis invoked the OOM killer, and three in-flight check
jobs died as casualties. The prior night the same box hit 100% disk
(154G/154G): the deploy lane's git operations truncated repo files
(`memory_gap.py`, `state_store.py` to 0 bytes — repaired via reset), and
`npm install` on the cycle failed ENOSPC. Heavy lanes must be serialized on
this host; two CI waves at once is what killed cycle #26.

## Incoming WIP fixes (external to this audit branch)

- `fix/aria-ack-env-export` (PR #1385): F2 ACK export, F6 override,
  debt-manifest/README repins after the registry append.
- `fix/aria-kernel-security-defects` (`3575e35c8`): F3/F4/F5 kernel fixes +
  regression tests + I-V6.4-04 pin rewrite. Registry findings + `Closes:`
  trailers are deliberately deferred until #1385 merges (hash-chained ledger,
  sequential-PR rule).

## Deliberate containment / product contradictions (not defects, recorded)

- The executor's API-key Claude mode refusal (`API-key Claude mode is
disallowed for ARIA`) is intentional and fail-closed.
- `settle_pending_promotions` minting and consuming its own token in-process
  needs no consume-time re-verification — it verified what it just derived.
- The `restore` action exporting secrets-free state binding into `GITHUB_ENV`
  is the designed single-source binding; the ACK export (F2 fix) follows it.
- Maintenance lane's hot-artifact stripping is operator-sanctioned state
  reduction; the correct companion is the ACK (F1/F2), not weakening the
  continuity gate.

## Unverified risks (open)

- WAL archive freshness lane was failing fail-closed at 06:35;
  `backup-production` succeeded 08:24 — the freshness lane should self-heal on
  its next pass; not yet observed green.
- External watchdog's "producer lane stale 298.5h (limit 50)" predates the
  outage; expected to clear after the first green publish, not yet observed.
- `/var` at 92G (docker ~43G, repo + ~60 worktrees the rest) — composition of
  the non-docker half not yet measured; disk pressure will recur without
  hygiene.
- Mimosa pre-push scanner reported `scanner_e2big` (incomplete scan) on this
  branch's pushes; a full audit pass is owed.
- PR #1384 ("mirror the governed required-checks manifest") still open, blocked
  earlier by F6 + OOM casualties; needs rerun after #1385 merges.

## Reuse / replace boundary for a portable ARIA

**Reuse as-is (repository-shaped, no repo identity baked in):** the kernel
modules with executable contracts — `state_store`, `ledger`, `memory_gap`,
`tool_registry`, `promotion_veto`, `worker_dispatch`, `state_compact`,
`runtime_profile` — plus the `restore-aria-state` action pattern (env-bound
store binding + ACK export) and the lane workflow shapes (restore → run →
publish, fast-forward-only transport).

**Replace per-repository (identity-bearing):** authority hash + `CURRENT_STATE.md`
anchors, `docs/reviews/_registry` findings ledger and its gates (hash chain is
workspace-keyed), CODEOWNERS + required-checks manifests, GitHub variables
(`ARIA_STATE_BOOTSTRAP_ACK`), the aria/state branch itself, and every
`scheduled-workflows.json` watchdog entry — these encode THIS repository's
operators and governance and must be re-minted, not copied.
