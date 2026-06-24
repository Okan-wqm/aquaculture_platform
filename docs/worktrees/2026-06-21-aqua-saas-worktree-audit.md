# Aqua-SaaS Worktree Audit

Date: 2026-06-21

Machine ledger: `docs/worktrees/2026-06-21-aqua-saas-worktree-inventory.jsonl`

## Executive Decision

This repository currently has 42 registered worktrees. The audit found 14 dirty worktrees, 4 staged-heavy worktrees, 5 detached worktrees, and 32 worktrees under `/tmp`. After fixing routing-table coverage gaps, every dirty path in the regenerated ledger maps to a primary owner; `TOTAL_GAPS=0`.

No destructive cleanup was performed. Remove/reset/drop actions remain approval-gated.

The enterprise-grade decision is:

- Do not commit from `/var/aqua-saas`: it is detached at `d549a8d49f57d881ce9ca3090d5a42f03c5683ae` and has a broad mixed dirty set.
- Do not commit the staged batches in `wave3`, `b1-metrics`, `c0-federation`, or `rust-cve-001` as-is. Specialist audits found security, schema, event-contract, migration, and Rust CVE regressions in those staged sets.
- Migrate live work onto fresh named branches under `/var/aqua-saas/.worktrees/<purpose-slug>` with explicit-path commits only.
- Clean `/tmp` worktrees only after owner approval, or relocate them under `.worktrees/` when an owner confirms they are active.

## Evidence

Read and applied:

- `CLAUDE.md`
- `.claude/shared/orchestrator-routing-table.md`
- generated inventory from `tools/worktree-audit/worktree-audit.ts`
- GitHub PR metadata via `gh pr list`
- specialist read-only audits: context-manager, architectural-arbiter, infra-expert, prompt-writer, ARIA, frontend, sensor, auth-security, data, edge

Verification performed for the new audit tooling:

- `npx ts-node --project tools/worktree-audit/tsconfig.json tools/worktree-audit/worktree-audit.spec.ts`
- `npx tsc -p tools/worktree-audit/tsconfig.json --noEmit`

## Inventory Summary

| Metric | Count |
|---|---:|
| Registered worktrees | 42 |
| Dirty worktrees | 14 |
| Staged-heavy worktrees | 4 |
| Detached worktrees | 5 |
| `/tmp` worktrees | 32 |
| Remaining ownership gaps | 0 |

Decision counts from the regenerated ledger:

| Decision | Count |
|---|---:|
| `DIRTY_NEEDS_OWNER` | 10 |
| `STAGED_NEEDS_COMMIT_DECISION` | 4 |
| `PASSIVE_REMOVE_AFTER_APPROVAL` | 25 |
| `DETACHED_TEMP` | 1 |
| `PASSIVE_KEEP` | 2 |

## Critical Stop List

These worktrees are not commit candidates in their current state.

| Worktree | Branch | Dirty state | Risk | Decision |
|---|---|---:|---|---|
| `/var/aqua-saas-wave3` | `fix/auth-audit-wave3-tenancy-data` | 73 staged | Reintroduces HS256/dev-secret auth fallback, deletes RS256 invariant, deletes `messages.embedding` migration, rewrites registry rows. | `drop-needs-approval`; salvage registry prose only after context-manager review. |
| `/var/aqua-saas/.claude/worktrees/b1-metrics` | `remediation/b1-metrics-completeness` | 117 staged | Deletes tenant-membership NATS contract and handler; Rust paths appear to undo CVE hardening and reintroduce old TLS/advisory ignores. | `drop-needs-approval`; do not land staged snapshot. |
| `/var/aqua-saas/.claude/worktrees/c0-federation` | `remediation/c0-federation-invariants` | 250 staged | Cross-domain deletion batch; reverses DB-migrate authority, RLS/schema hardening, durable idempotency, lint configs, and sensor DDL gate. | `drop-needs-approval`; split only if an owner extracts a non-regressive subpatch. |
| `/var/aqua-saas/.claude/worktrees/rust-cve-001` | `remediation/rust-cve-001-rumqttc-fork` | 160 staged | Stale mixed branch after merged PR; includes event-contract, messaging migration, lint/config, and non-edge deletes. | `drop-needs-approval`; any real Rust CVE work must be recut on fresh main. |

## Dirty Worktrees

| Worktree | Branch | Dirty state | Owners | Decision |
|---|---|---:|---|---|
| `/var/aqua-saas` | detached `origin/main` | 0 staged, 116 unstaged, 31 untracked | test-runner, sensor-expert, data-expert, context-manager, infra-expert, others | Keep evidence, then split/migrate by owner. No commit from detached root. |
| `/tmp/aqua-aria-itemA` | `feat/aria-per-job-governance` | 13 unstaged | aria-change-intelligence, infra-expert | Migrate/split ARIA workflow/kernel payload onto fresh branch. |
| `/tmp/aqua-backup-encryption-remediation` | `codex/backup-encryption-remediation` | 3 unstaged, 3 untracked | context-manager, test-runner, admin-expert | New during audit; owner triage before any cleanup. |
| `/tmp/aqua-claude-md` | detached | 2 untracked | farm-expert | Farm migration files need owner decision; detached temp. |
| `/tmp/aqua-lint-base-jjazQU/repo` | detached | 1 unstaged, 2 untracked | platform-kernel-expert, infra-expert | Duplicate lint scratch; migrate one canonical patch or drop both after approval. |
| `/tmp/aqua-lint-base-tJFSMB/repo` | detached | 1 unstaged, 2 untracked | platform-kernel-expert, infra-expert | Duplicate lint scratch; migrate one canonical patch or drop both after approval. |
| `/tmp/aqua-pr531` | `codex/close-infra-critical-014-registry` | 4 unstaged | context-manager | Stale registry closure; regenerate/rechain on current main before commit. |
| `/var/aqua-saas/.claude/worktrees/c1-pr1b` | `remediation/c2-react19-xyflow` | 1 untracked | frontend-expert | Move `theme.css` only into a design-token/Tailwind branch with imports/exports, or drop after approval. |
| `/var/aqua-saas/.claude/worktrees/r1-coprocessor` | `remediation/r1-router-coprocessor` | 6 unstaged, 3 untracked | edge-expert, auth-security-expert, infra-expert, platform-kernel-expert | Coherent but stale; migrate to fresh branch and validate HMAC raw-body behavior. |
| `/var/aqua-saas/.worktrees/snowball` | `codex/snowball-main-safe-20260530` | 68 untracked | aria-change-intelligence, test-runner | Snowball is superseded by main; export runtime artifacts if needed, then remove after approval. |

## Clean Worktrees

Clean `/tmp` worktrees are not durable by policy. Default action is `PASSIVE_REMOVE_AFTER_APPROVAL` unless an owner confirms active use and relocates/recreates under `/var/aqua-saas/.worktrees/<slug>`.

Notable active/open PR exceptions:

- `/tmp/aqua-agents-main` -> PR #548 open draft; keep only if prompt-writer still owns it, otherwise remove after approval.
- `/tmp/aqua-close-capacity-preflight` -> PR #572 open; keep until PR owner confirms it is obsolete.
- `/tmp/aqua-salvage` -> PR #525 open; keep or relocate if the salvage branch is still active.
- `/tmp/aqua-snowball-audit` -> PR #551 open draft; keep only if ARIA owner confirms current relevance.

All merged clean `/tmp` worktrees are removal candidates after approval. Examples include the ARIA cleanup/autonomy/executor/runtime branches, capacity diagnostics branches, consent bootstrap, control-plane CSP, critical registry close, infra014 trace, plan waves, and SSOT critical implementation branches. Full branch/PR mapping is in the JSONL ledger.

Durable clean worktrees:

- `/var/aqua-saas/.claude/worktrees/rustcve-close`: `PASSIVE_KEEP` until context/edge owners decide whether the closed PR #421 evidence is still needed.
- `/var/aqua-saas/.codex-worktrees/maintanance`: `PASSIVE_KEEP`, but the misspelled durable path should be normalized in a separate approved maintenance pass.

## Ownership Coverage Fixes

The initial audit found ownerless paths. The routing table now explicitly covers:

- `docs/worktrees/**`
- `tools/worktree-audit/**`
- `apps/sensor-ingestion/**`
- `crates/**`, `.cargo/**`, `deny.toml`
- `.github/CODEOWNERS`
- root lint configs: `.eslintrc*`, `.eslintignore`, `eslint.config.*`
- `platform/libs/service-catalog/**`
- `libs/migration-harness/**` and its test helpers
- `libs/sensor-automation-types/**`
- `scripts/**`, `tools/scripts/**`
- `docs/aria/**`, `docs/plans/**`
- `types/**`
- `aria-kernel/**`, `aria-tools/**`
- `artifacts/ci-affected-policy/**`
- `tools/executors/**`, `tools/quality/**`, `tools/testing/**`, `tools/toolchain/**`

Regenerated ledger result: `TOTAL_GAPS=0`.

## Cleanup Protocol

1. For every dirty worktree, export evidence first: HEAD SHA, branch, PR state, `git status --porcelain`, and an explicit path list.
2. For salvage work, create a fresh named worktree under `/var/aqua-saas/.worktrees/<purpose-slug>` from current `origin/main`.
3. Apply only owner-approved paths. Never carry broad staged snapshots forward.
4. Before any commit: `git diff --cached --name-only` must list only the intended owner-approved paths.
5. Every fix commit must carry the relevant `Closes:` trailer and pass the required validation for that owner surface.
6. Remove/drop/reset worktrees only after explicit approval.

## Next Approval Gates

No approval needed:

- Keep the ledger/report/tooling as audit evidence.
- Re-run `tools/worktree-audit/worktree-audit.ts` whenever worktree state changes.

Approval required:

- Remove any `/tmp` or detached worktree.
- Drop staged snapshots in `wave3`, `b1-metrics`, `c0-federation`, or `rust-cve-001`.
- Adopt or migrate dirty root paths.
- Relocate active `/tmp` worktrees under `.worktrees/`.
- Normalize `.codex-worktrees/maintanance`.
