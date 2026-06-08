<!-- ARIA-HISTORICAL: Historical plan document. Live authority is docs/aria/CURRENT_STATE.md plus executable contracts. -->

# ARIA Plan 009: Enterprise Verification Roadmap

## Summary

Plan 009 adds the first implementation slice for the missing verification and recommendation capabilities after Auto-PR foundation. It keeps ARIA fail-closed: validation is executed through an allowlisted runner, impact uses graph-backed downstream scope, research records sanitized fetched content, fitness reports stay separate from recommendations, performance comparisons require baselines, and kernel self-change uses a dedicated PR-only lane.

## Key Changes

- Validation execution records command runs in hash-chained ledgers with allowlisted argv parsing, timeout handling, stdout/stderr hashes, and clean-worktree protection.
- Impact planning can attach a downstream impact graph built from Nx graph JSON or local import scanning, then tightens validation commands for downstream runtime changes.
- Research execution can fetch or ingest text from approved source tiers, sanitize HTML/script content, hash the sanitized text, and store extracted claim snippets.
- Performance baseline support records measured metrics and compares later values against regression thresholds without inventing unavailable production metrics.
- Fitness reporting scores current repository evidence separately from recommendation candidates; recommendations remain blocked until local evidence, validation, research, impact, and repo-value refs are present.
- Kernel runtime changes remain blocked in normal apply and auto-merge paths; a kernel-change request only authorizes PR planning after explicit approval and full validation refs.

## Acceptance

- Validation runner rejects shell syntax and unknown commands, records passing and failing runs, and preserves integrity verification.
- Impact graph identifies direct and downstream projects from fixture imports and changes validation scope accordingly.
- Research fetch strips script/style content and records a stable `sha256:` content hash.
- Performance comparison emits `missing_baseline`, `ok`, or `regression` without claiming unmeasured p99 data.
- Fitness report generation is deterministic and does not emit actionable recommendations without complete evidence refs.
- Self-change proposals cannot use normal worktree apply; kernel-change requests record `auto_merge_allowed=false`.

## Assumptions

- Existing repo tools stay authoritative; ARIA orchestrates and records their evidence.
- Network research is source-tier gated and never becomes a recommendation by itself.
- Auto-merge policy remains stricter than apply policy, especially for `aria-kernel/aria_kernel/**`.
