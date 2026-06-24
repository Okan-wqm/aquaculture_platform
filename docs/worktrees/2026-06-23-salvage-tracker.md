# Worktree Salvage Tracker — 2026-06-23

Goal: per worktree, finish half-done work → commit uncommitted positive changes → push. Worktrees are KEPT, not deleted. Regressions are never committed/pushed. Source ledger: `2026-06-23-aqua-saas-worktree-audit.md` / `.jsonl`. origin/main = `a8ec4be52`.

Legend — Status: `pending` → `investigating` → `finishing` → `committed` → `pushed` / `superseded` / `nothing-to-salvage`.

## Salvage work-list (15 dirty + ahead worktrees)

| # | Worktree | Branch | Dirty / Ahead | Intent (half-done work) | Verdict | Owner | Status |
|---|---|---|---|---|---|---|---|
| W1 | (root, audit subset) `/var/aqua-saas` → `tools/worktree-audit/**`, `docs/worktrees/**` | (detached) | 55 untracked (subset) | The worktree-audit tool + reports this initiative produced | POSITIVE — not on main, additive | (mine) | pending |
| W2 | `/tmp/aqua-geospatial-gate` | codex/geospatial-browser-bundle-gate | 24 dirty, ahead 10/behind 4, no PR | tenant-erasure-proof-ledger across 11 services (1 commit + 11 uncommitted migrations + 3 invariant specs) + deploy-ssot + capacity preflight bound | MIXED — erasure-ledger+deploy-ssot POSITIVE & new; backup-encryption commits SUPERSEDED by merged #582/#583 | data-expert + auth-security + infra | pending |
| W3 | `/tmp/aqua-aria-itemA` | feat/aria-per-job-governance | 13 unstaged | ARIA per-job governance | TBD | aria-change-intelligence/infra | pending |
| W4 | `/var/aqua-saas/.claude/worktrees/r1-coprocessor` | remediation/r1-router-coprocessor | 9 dirty, ahead 3/behind 184 | R1 router coprocessor HMAC parity | TBD (live remote) | edge-expert | pending |
| W5 | `/var/aqua-saas/.worktrees/snowball` | codex/snowball-main-safe-20260530 | 68 untracked, ahead 1/behind 305 | ARIA snowball (superseded line) | likely SUPERSEDED (ARIA fully on main) | aria-change-intelligence | pending |
| W6 | `/var/aqua-saas/.claude/worktrees/c1-pr1b` | remediation/c2-react19-xyflow | 1 untracked (theme.css) | design-token/Tailwind theme | TBD | frontend-expert | pending |
| W7 | `/tmp/aqua-claude-md` | (detached) | 2 untracked | farm migrations | TBD | farm-expert | pending |
| W8 | `/tmp/aqua-pr531` | codex/close-infra-critical-014-registry | 4 unstaged, behind 91 | registry closure INFRA-CRITICAL-014 | TBD (stale, behind 91) | context-manager | pending |
| W9 | `/tmp/aqua-lint-base-jjazQU/repo` | (detached) | 3 | lint scratch (duplicate) | TBD | platform-kernel/infra | pending |
| W10 | `/tmp/aqua-lint-base-tJFSMB/repo` | (detached) | 3 | lint scratch (duplicate of W9) | TBD | platform-kernel/infra | pending |
| W11 | `/tmp/aqua-backup-encryption-remediation` | codex/deploy-migration-selection-ssot | 75 (15 staged, 61 unstaged) | deploy migration-selection SSOT; auth-security owns 42 | REGRESSION-SUSPECT (audit-gate before any commit) | auth-security-expert | pending |
| W12 | `/var/aqua-saas-wave3` | fix/auth-audit-wave3-tenancy-data | 73 staged | auth audit wave3 tenancy | REGRESSION (HS256 fallback, RS256 invariant deleted) — extract positive only | auth-security-expert | pending |
| W13 | `/var/aqua-saas/.claude/worktrees/b1-metrics` | remediation/b1-metrics-completeness | 117 staged | b1 metrics completeness | REGRESSION (deletes tenant-membership NATS contract; undoes Rust CVE) — extract positive only | sensor-expert | pending |
| W14 | `/var/aqua-saas/.claude/worktrees/rust-cve-001` | remediation/rust-cve-001-rumqttc-fork | 160 staged | rust CVE rumqttc fork | REGRESSION (stale mixed; event-contract/migration deletes) — recut clean | platform-kernel-expert | pending |
| W15 | `/var/aqua-saas/.claude/worktrees/c0-federation` | remediation/c0-federation-invariants | 250 staged | federation invariants | REGRESSION (reverses db-migrate authority, RLS/schema hardening) — extract positive only | edge-expert | pending |

Plus: detached root remainder (~50 untracked beyond the audit subset) — owner-split last.

## Notes / evidence
- W1: `tools/worktree-audit/worktree-audit.ts` absent from `origin/main` → confirmed new. Salvage = fresh branch off main, copy `tools/worktree-audit/**` + `docs/worktrees/**`, commit, push, PR.
- W2: ahead commits `9ae2ae0c9 2ea6e5c02 cf5a41e7d da6850177 bacee1e9e 523b5e2eb d70b3a2fa` all `+` under `git cherry origin/main` (no patch-id equivalent on main) → genuinely unpushed. No PR ever opened. behind-4 = #582/#583 backup-encryption merges (parallel/superseding). Erasure-proof-ledger migrations absent from main → new.
