# Plan ARIA-V9.5 — Safety Contracts Policy

**Branch:** `snowball`
**Phase:** Plan ARIA-V9 + V10 v3 — V9.5 (policy documentation of the 15 hard-fail checks)
**Status:** RESOLVED — V9.0-D `implementation_safety.HARD_FAIL_CHECKS` registry ships the canonical list; this file documents semantics for operator + future-maintainer review.

## Why this file exists

V9.0-D landed the `HARD_FAIL_CHECKS` registry — a 15-tuple of `HardFailCheck(name, description, closes_findings)` records. The registry is the kernel-side single-source-of-truth (orchestrator iterates over it pre-PR-open + pre-merge). This doc records the **operator-readable semantics** of each check: what fires it, what state is recorded, how a failure routes (refusal vs. governance event vs. HUMAN_REQUIRED).

V9.6 (auto_merge runner) consumes the registry via a sequential loop pre-merge. V9.3 (envelope minter) consumes a subset pre-mint. The semantics below pin the routing rules so future maintainers don't drift from the v3 audit closure.

## The 15 hard-fail checks (canonical order)

### 1. `no_force_push`
- **Closes:** sec CRIT-002
- **Tier:** 1 (make impossible)
- **Fires when:** any Bash invocation matches DENIED regex `--force\b`, `--force-with-lease\b`, OR the push target ref is not `refs/heads/aria-impl-<hex16>`.
- **Routing:** Refusal envelope `reason_class=bash_command_denylist_hit` for the force-flag variant; `branch_collision` if pushing to a different branch shape.
- **Defense:** Tier-1 — refspec-aware regex in V9.0-D `DENIED_BASH_COMMANDS` line `git\s+push\s+(?:\+|.+:refs/heads/main\b|origin\s+\+)`; bwrap doesn't enforce this so the regex is the load-bearing guard.

### 2. `no_no_verify`
- **Closes:** sec CRIT-002
- **Tier:** 1
- **Fires when:** Bash invocation matches `--no-verify\b`, `--no-gpg-sign\b`, OR `core\.hooksPath` (config bypass).
- **Routing:** `bash_command_denylist_hit`.
- **Defense:** Tier-1 — three regex patterns in `DENIED_BASH_COMMANDS`.

### 3. `no_main_branch_write`
- **Closes:** sec CRIT-002 + CRIT-003
- **Tier:** 1
- **Fires when:** Bash matches `gh api -X DELETE/PATCH/PUT` OR push target = `refs/heads/main` OR push uses `+` refspec.
- **Routing:** `bash_command_denylist_hit` OR `gh_api_scope_violation` depending on argv shape.
- **Defense:** Tier-1 — explicit deny regex + `FORBIDDEN_GH_API_PATHS` redundant check at dispatcher.

### 4. `forbidden_scope_normalized`
- **Closes:** arb HIGH-004 + ai HIGH-006
- **Tier:** 1
- **Fires when:** Edit/Write target path, after `Path.resolve()` + symlink resolution, lands inside `READONLY_PATHS` glob set.
- **Routing:** Refusal `reason_class=forbidden_scope_violation` (or `kernel_self_modification_attempted` for the .claude/agents/ + aria-kernel/ subset).
- **Defense:** Tier-1 — `verify_no_path_escape` + `READONLY_PATHS` ro-bind under bwrap (EROFS at syscall layer).

### 5. `kernel_self_modification_blocked_at_envelope_mint`
- **Closes:** ai CRIT-005 + arb CRIT-005
- **Tier:** 1
- **Fires when:** Plan's `affected_surfaces` intersects READONLY_PATHS (e.g. plan_synthesizer surfaces a CONVERGED plan touching kernel code).
- **Routing:** `issue_implementation_envelope` REFUSES to mint; emits HUMAN_REQUIRED governance event with Plan 009 lane routing pointer.
- **Defense:** Tier-1 — the envelope is never created, so the agent never gets a chance to attempt the edit. Operator routes the change through the Plan 009 kernel-self-change PR lane (operator-authored).

### 6. `test_gate_canonical_suite`
- **Closes:** ai HIGH-008
- **Tier:** 1
- **Fires when:** `validation_commands[]` MISSING any of canonical suite (`nx affected --target=test`, `nx affected --target=lint`, `npm run type-check`). Agent MAY ADD; MUST NOT subtract/replace.
- **Routing:** Refusal `reason_class=validation_failed` if any canonical command exited non-zero OR if the suite is incomplete.
- **Defense:** Tier-1 — the orchestrator pre-validates `validation_commands[]` shape AGAINST canonical set before agent dispatch.

### 7. `secret_scan_diff_clean`
- **Closes:** ai CRIT-004 + sec HIGH-005
- **Tier:** 1
- **Fires when:** `verify_no_secret_in_diff(git diff --staged)` finds ANY `SECRET_SCAN_PATTERNS` match (AWS key, GitHub PAT, Anthropic key, RSA private key, JWT_SECRET=, etc.).
- **Routing:** Refusal `reason_class=secret_leak_detected`. PR is NEVER opened. Operator notified via governance event with redacted pattern names (counts only — values never logged).
- **Defense:** Tier-1 — runs BEFORE `gh pr create`; secret never lands on remote git history.

### 8. `bash_command_allowlist`
- **Closes:** ai CRIT-002 + sec CRIT-002
- **Tier:** 1
- **Fires when:** Bash argv joined as a line matches no `ALLOWED_BASH_COMMANDS` pattern, OR matches any `DENIED_BASH_COMMANDS` pattern (deny wins).
- **Routing:** Refusal `reason_class=bash_command_denylist_hit` (deny) or `bash_command_allowlist_miss` (allow miss — wrapped under same class for operator simplicity).
- **Defense:** Tier-1 — runtime tool dispatch guard. Single-line regex match; no possibility of allow-set drift since the matcher is allowlist not blocklist.

### 9. `path_escape_guard`
- **Closes:** ai HIGH-006
- **Tier:** 1
- **Fires when:** Edit/Write path, after `Path(p).resolve().relative_to(workspace)` resolution, is outside workspace root. Relative paths interpreted relative to workspace (CWD-independent).
- **Routing:** Refusal `reason_class=path_escape_outside_workspace`.
- **Defense:** Tier-1 — mirror of agent_compliance:168-178 pattern.

### 10. `branch_tip_lock_and_recheck`
- **Closes:** ai HIGH-007 + sec HIGH-002
- **Tier:** 1
- **Fires when:** Pre-merge `gh pr view --json headRefOid` no longer matches `state.implementation.branch_tip_sha` recorded at IMPLEMENTATION_RECORDED time.
- **Routing:** `record_implementation_rejected(rejection_class="branch_tip_drift")`. Merge aborted.
- **Defense:** Tier-1 — recorded at outcome time; rechecked at merge time; mid-window drift surfaces every time.

### 11. `per_file_mutual_exclusion`
- **Closes:** ai HIGH-009
- **Tier:** 1
- **Fires when:** `_validate_implementation_request` finds any `affected_surfaces[]` entry locked by another `IMPLEMENTATION_*` plan (REQUESTED / IN_FLIGHT / RECORDED state for a DIFFERENT plan_id).
- **Routing:** Refusal `reason_class=file_lock_conflict`. Implementer waits for the other plan to terminate.
- **Defense:** Tier-1 — kernel-side check on every `request_implementation` call.

### 12. `operator_feedback_signature`
- **Closes:** ai HIGH-010
- **Tier:** 1
- **Fires when:** `operator_feedback_ingestion.ingest_operator_feedback` (the plan synthesizer's scan of `aria-tools/operator-feedback.jsonl`) reads a row whose keyed HMAC-SHA256 `signature` / `signer_kid` is missing, malformed, minted under a `signer_kid` the store's rolling key list never held, or does not recompute over the canonical row (`operator_feedback_signature.verify_operator_feedback_row`, closed reason vocabulary `signature_missing | signer_kid_missing | signer_kid_unknown | signature_malformed | signature_invalid`, plus `schema_invalid` for a signed row that is not a request row).
- **Routing:** Row dropped + governance event `unsigned_operator_feedback` (one per drop: id, line, reason, kid — never the body). Synthesizer continues with the remaining valid rows; the scan is recorded as an `ingestion` row on `operator-feedback-ingestion.jsonl` (admitted rows by `ledger_hash` + `signer_kid`, dropped rows by reason) and the selected synthesis is bound to that scan by a `synthesis_bound` row carrying the plan_content hash.
- **Defense:** Tier-1 — the kernel is both signer and verifier. Every kernel writer of the ledger (`feedback_store` verdict rows, `calibration_bootstrap` corpus fixtures, `record_operator_request` behind `aria-kernel feedback request`) appends through `append_signed_operator_feedback_row`; key material lives at `aria-tools/secrets/operator-feedback-hmac.key` (0600, rolling five-entry list shared with the ack ledger's custody via `hmac_keyring`; `aria-kernel feedback rotate-signing-key` retires a head key without orphaning historical rows). A hand-appended row is therefore not a code path to authority. At merge time `merge_authority._capture_pre_merge_context` walks `plan_started.content_hash → synthesis_bound → ingestion → consumed rows` and re-verifies every consumed signature; the predicate refuses on any named gap (`operator_feedback_synthesis_binding_unavailable`, `…_ingestion_unavailable`, `…_consumption_mismatch`, `…_consumed_row_unavailable`, `…_consumed_row_unsigned:<reason>`).

### 13. `pr_body_templating`
- **Closes:** ai HIGH-012 + sec HIGH-008
- **Tier:** 2 (make automatic)
- **Fires when:** PR body would contain Unicode bidi codepoints (CVE-2021-42574), HTML comments (`<!--`), OR is not generated by `render_pr_body(plan_id, verdict, changed_files)` template.
- **Routing:** PR body re-rendered via canonical template — embedded plan prose is stripped, replaced with structured fields. No refusal (Tier-2 automatic correction).
- **Defense:** Tier-2 — `render_pr_body` strips dangerous codepoints + comments; template is the only path to PR body authorship.

### 14. `cycle_and_turn_budget_cap`
- **Closes:** ai HIGH-013 + perf CRIT-001
- **Tier:** 1
- **Fires when:** at the next Edit/Write/Bash turn boundary the run's wall clock is inside the close-out margin of the job deadline (`ARIA_JOB_DEADLINE_EPOCH`, bound by `cycle.job_deadline_epoch`; margin `turn_budget.JOB_DEADLINE_CLOSE_OUT_MARGIN_SECONDS` = 120 s); OR the implementer request has already been admitted `turn_budget.IMPLEMENTER_TURN_BUDGET` = 10 budgeted turns (Edit + Write + Bash + MultiEdit + NotebookEdit combined, `BUDGETED_TOOL_NAMES`). Dollars are not admission here: under the managed-subscription policy they are telemetry (`cost_budget.assert_within_budget`, ARIA-HIGH-074/079) and under the metered policy they remain `cost_budget`'s own caps (ORPHAN-HIGH-472 retired the USD dispatch gate).
- **Routing:** Refusal `reason_class=cycle_budget_exhausted` OR `implementer_turn_budget_exhausted`, always at the turn boundary (the spawn is not killed mid-turn; the implementer can still write its final report). A policy-denied turn never counts; a budget refusal consumes nothing, so every later attempt is refused at the boundary too.
- **Defense:** Tier-1 — the kernel compiles `--turn-budget 10` into the PreToolUse hook command of write-scope profiles (implementer, worker) via `claude_settings.build_settings`; `hooks.admit_budgeted_turn` counts the request's admitted turns from `hooks/decisions.jsonl` and appends its verdict inside ONE state transaction, so parallel tool calls cannot both be admitted as the tenth; every budgeted verdict carries a `turn_budget` observation (cap, used_before, deadline_epoch, remaining_seconds, margin). At merge time `merge_authority._capture_pre_merge_turn_budget` reduces the request's rows (`turn_budget.turn_budget_evidence`) and the predicate refuses on absent/malformed evidence, another cap, either refusal class, or more admitted turns than the cap (`implementer_turn_budget_exceeded_unrefused`); it passes only as `native_cycle_and_turn_budget_respected`.

### 15. `content_hash_recheck`
- **Closes:** ai MED-019
- **Tier:** 1
- **Fires when:** Implementer recomputes SHA256 of CONVERGED plan content (via `must_satisfy[].evidence_refs[N].content_hash` cross-check) and finds drift between envelope mint time + implementation start.
- **Routing:** Refusal `reason_class=content_hash_mismatch`. TOCTOU defense — the kernel state may have been mutated between envelope mint + implementation claim.
- **Defense:** Tier-1 — mirror of aria-cross-reviewer step 1 discipline.

## Soft-warn rules (governance event, no block)

- **Aggregate diff size:** >5000 lines/24h triggers operator notification (not refusal).
- **Lockfile drift:** `package.json` / `package-lock.json` / `requirements.txt` / `Cargo.toml` / `Cargo.lock` / `go.sum` touches were PROMOTED to HARD-FAIL in V9.0-D — operator review required (per sec HIGH-004 + auto_merge.DEFAULT_POLICY.config_forbidden_globs).

## Cross-references

- `aria-kernel/aria_kernel/implementation_safety.HARD_FAIL_CHECKS` — kernel SSoT
- `aria-kernel/aria_kernel/implementation_safety.py` — V9.0-D module
- `aria-kernel/tests/invariants/v9/test_phase_v9_0_d_implementation_safety.py` — 42 invariants pin the contract
- `.claude/agents/aria-implementer.md` — agent-side mirror of the refusal classes
- `docs/runbooks/aria-github-app-setup.md` — operator runbook for the V9.0-C Mode A precondition

## V9.6 auto-merge integration

The V9.6 auto_merge_runner iterates `HARD_FAIL_CHECKS` in a sequential loop pre-merge. Each check returns `(passed, reason)`. Any non-pass → `record_implementation_rejected(rejection_class=<class>)` + merge aborted.
