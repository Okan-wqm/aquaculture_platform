# clippy-affected gate — merge-from-main scope (2026-09-05)

**Reviewer:** infra-expert · **Cycle:** 2026-09-05-pr1420-merge-from-main ·
**Surface:** `tools/gates/clippy-affected.ts`, `.husky/pre-push`

## Context

PR #1420 (`claude/platform-eksiklikler-bug-fix-0jj9jg`) merged `origin/main` to resolve conflicts
with PRs #1423/#1428/#1429. The pre-push hook then refused the merge commit: `clippy-affected`
scanned `<remote_sha>...<local_sha>` (33fd434…3ce3a5b), found 4 624 new Rust lines, and reported
two crate-level deny-list errors — `expect()` on a `Result` and `eprintln!` in
`sens-api-gateway/src/main.rs` (5905, 5911). Both lines arrived from main (the shutdown watchdog
added by #1423); the branch never touched them and cannot honestly change them, and the repository
forbids `--no-verify`.

## Findings

### PROC-MEDIUM-027 — the pre-push range gates lines the push did not write

**Severity:** MEDIUM · **Owner:** @okan-wqm · **Deadline:** 2026-09-30

The gate's stdin semantic ("what is new in THIS push", ORPHAN-LOW-035) is right for ordinary
pushes and wrong for a push carrying a merge from the integration base: every Rust line main added
since the branch's last push is "new on the branch" and is gated as if the branch wrote it. That
turns a conflict-resolution merge — the one operation the merge-conflict rule requires — into a
push nobody can make without bypassing the hook.

**Fix (this cycle):** the branch-side line set is intersected with `<integration base>...<head>`,
where the integration base is `origin/main` or, for a stacked branch, `SUDERRA_PREPUSH_BASE_REF`
(the override `rangeForPrePushRef` already honours). A line is gated only when it is new relative
to the remote tip AND new relative to the integration base. The three-dot form measures from the
merge-base, so the exclusion holds whether the branch merged main's tip or an older main, and when
the two ranges share a base the intersection is the identity. The gate logs how many lines it
excluded and why. `intersectAffectedLines` is a pure function under `clippy-affected.spec.ts`.

**Not changed:** the crate deny-list and the per-line semantic for lines the branch writes. The two
diagnostics above remain main's to judge; they are not silenced here.
