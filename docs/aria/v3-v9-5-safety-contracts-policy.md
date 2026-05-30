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
- **Fires when:** `plan_synthesizer` reads a row from `aria-tools/operator-feedback.jsonl` with missing OR invalid `signature` / `signer_kid` field.
- **Routing:** Row dropped + governance event `unsigned_operator_feedback` (one per drop). Synthesizer continues with remaining valid rows.
- **Defense:** Tier-1 — signature verification at source ingestion. V9.4 implements (lands later in the V9 arc).

### 13. `pr_body_templating`
- **Closes:** ai HIGH-012 + sec HIGH-008
- **Tier:** 2 (make automatic)
- **Fires when:** PR body would contain Unicode bidi codepoints (CVE-2021-42574), HTML comments (`<!--`), OR is not generated by `render_pr_body(plan_id, verdict, changed_files)` template.
- **Routing:** PR body re-rendered via canonical template — embedded plan prose is stripped, replaced with structured fields. No refusal (Tier-2 automatic correction).
- **Defense:** Tier-2 — `render_pr_body` strips dangerous codepoints + comments; template is the only path to PR body authorship.

### 14. `cycle_and_turn_budget_cap`
- **Closes:** ai HIGH-013 + perf CRIT-001
- **Tier:** 1
- **Fires when:** Per-cycle cost reservation would exceed `--max-budget-usd-per-cycle` (default $1.50) at next turn boundary; OR per-implementer-turn count exceeds N=10 Edit+Write+Bash.
- **Routing:** Refusal `reason_class=cycle_budget_exhausted` OR `implementer_turn_budget_exhausted`. Cycle terminates cleanly at turn boundary (not mid-turn — reservation/reconcile discipline holds).
- **Defense:** Tier-1 — reservation-then-reconcile pattern at every LLM call.

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
