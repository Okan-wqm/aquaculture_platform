<!-- ARIA-HISTORICAL: Historical plan document. Live authority is docs/aria/CURRENT_STATE.md plus executable contracts. -->

# ARIA Codex CLI xhigh Architecture Plan

Date: 2026-05-25
Branch: `snowball`
Status: Proposed implementation plan

## Summary

This plan moves ARIA from the current Claude/Anthropic-oriented execution model to a Codex CLI first architecture. It is an architecture and implementation direction document, not a patch note.

The plan was reviewed by independent validation agents. The initial draft was rejected because it was not strict enough around Codex migration, cross-runner leases, multi-ledger transactions, merge safety, documentation drift, and test reachability. This version includes those required corrections.

Code and executable contracts are the normative source of truth. Stale or contradictory documentation must be updated, generated, or explicitly marked as historical/superseded.

## Core Decisions

### Codex runtime

- Replace Claude-specific executor surfaces with one `AgentRuntime` abstraction and a Codex-first `CodexRunner`.
- The runtime contract must use non-interactive Codex execution with JSONL events, schema output where needed, final-message extraction, explicit sandbox/approval configuration, and an `xhigh` reasoning-effort target.
- The exact Codex CLI argv/config contract, including the `xhigh` config key and supported event fields, must be pinned by contract tests before real mode is enabled.
- The implementation must remove or quarantine active `claude`, `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, and `CLAUDE_CODE_*` assumptions so Claude and Codex lifecycles cannot both be live authorities.

### Auth and account budget

- Default auth is ChatGPT-managed Codex CLI auth on a trusted/private runner.
- API key mode, `OPENAI_API_KEY`, `CODEX_API_KEY`, and any extra API-billing path are disallowed unless a later explicit ADR changes this constraint.
- Budget management must enforce Codex account/session/rate-limit headroom, not API-dollar spend, for the default mode.
- Real mode must fail closed when auth status, quota/rate-limit state, Codex usage fields, or JSONL event shape cannot be verified.

### State and ledgers

- Introduce one ledger/state manifest covering every ledger, runtime state file, index, artifact, and generated state surface.
- Each manifest entry must declare path pattern, state class, lock group, index group, strict-read requirement, durability policy, and whether it may drive writes.
- Claims, results, bridge status, dispatch, implementation lifecycle, and ack consumption must go through one ordered transaction helper: verified read, global lock acquisition, reducer, append/rewrite, index refresh, and fsync durability.
- Ack consumption must become append-only state transition logging rather than in-place token mutation.
- Canonical path resolution must apply to every write-driving path, not only evidence paths.

### Lifecycle and leases

- Plan, agent invocation, bridge, dispatch, and implementation lifecycle state machines must have one authority each.
- Accepted agent results terminalize the claim. Bridge pending is non-terminal and must be recoverable by deterministic replay.
- Retry exhaustion must end in an explicit terminal state such as `human_required`, `rejected`, or another named terminal state.
- Local host lease files are only witnesses. Cross-runner exclusion requires a remote-visible CAS lease with at least `lease_id`, `epoch`, `owner`, `target_ref`, `head_sha`, `expires_at`, and `heartbeat_at` compare fields.
- Lease contention, stale reaping, epoch increments, and local-vs-GitHub runner behavior must be specified and tested before autonomous real mode.

### Merge safety

- `merge_if_green` is the only real merge executor.
- V9/direct merge routes must be deleted or demoted so they cannot perform real merges.
- Every real merge must require `--match-head-commit`, fresh diff, branch protection recheck, triple gate success, executable implementation safety gates, and an `implementation_merged` lifecycle record.
- Unsafe `gh pr merge` patterns without head matching must be blocked by tests.

### GitHub write policy

- Autonomous real mode requires a GitHub App or scoped installation token.
- PAT fallback is allowed only for supervised/dry-run paths unless a later explicit policy changes this.
- Branch protection, token permissions, and target ref must be rechecked at write and merge time.

### Security and artifacts

- A central `artifact_safety` boundary must own redaction, token scrubbing, PII pseudonymization, prompt/output encoding, JSONL scrubbing, artifact allowlisting, size caps, and retention.
- Raw prompts, raw Codex responses, raw JSONL, session tokens, account tokens, lease tokens, and GitHub tokens must not enter argv, logs, ledgers, or uploaded artifacts.
- `CODEX_OSS_DEBUG=1` and similar verbose unsafe modes are forbidden in real mode.
- Artifact uploads must be exact per-request sanitized outputs, not broad glob uploads.

### Tools, adapters, and findings

- Split tool root contract version, registry schema version, and tool manifest schema version into separate authoritative constants.
- Registry compilation must validate manifests deeply and apply explicit upcasters.
- Tool quarantine and status changes must use one transition matrix with operator approval requirements where needed.
- Findings have two lanes: raw findings may record all claims, while canonical findings may only be produced from clean, valid, evidence-complete runs.
- TypeScript and Python adapters must share one evidence/output schema and normalized path rules.

### Contracts, docs, and public API

- Create an executable role/target/schema/lifecycle single source of truth consumed by agent contracts, invocation queues, dispatchers, and generated/mechanically checked docs.
- Public API exports must be curated. Bulk exporting all callable or uppercase symbols from `aria_kernel.__init__` is not acceptable as a stable API boundary.
- Add `docs/aria/CURRENT_STATE.md` as the canonical human-readable state summary.
- Update or regenerate `CONTRACTS.md`, `IDENTITY.md`, workflow comments, executor contract docs, runbooks, ADR index, and Claude/Anthropic-era docs so they match the Codex-first architecture.
- Historical documents may remain, but must be clearly marked as historical, superseded, or non-normative.

## Test and Acceptance Criteria

- Codex contract tests cover exact CLI argv/config, `xhigh` reasoning config, `codex exec --json`, schema output, final-message extraction, auth preflight, API-key rejection, rate-limit/headroom failure, and unknown usage/event fields.
- State tests cover multi-process claim races, duplicate result submission idempotency, bridge replay after crash gaps, append-only ack transitions, remote CAS lease contention/reaping, and retry exhaustion terminalization.
- Merge tests prove V9/direct merge cannot merge, all real merges require match-head protection, and unsafe `gh pr merge` forms fail policy checks.
- Security tests prove argv/log/artifact/ledger token exclusion, JSONL scrubbing, raw prompt/response denial, artifact allowlisting, size caps, and short retention.
- Test reachability manifest maps every `aria-kernel/tests/test_*.py` and `tests/invariants/*.spec.ts` file to a required runner or an owned dormant entry with reason and expiry.
- `invariants:fast` is a required PR gate. `invariants:full` is required for nightly or pre-merge validation.
- Documentation tests ensure stale Claude/Anthropic execution docs cannot remain normative, `CURRENT_STATE.md` is current, ADR IDs are registered, and generated/mechanically checked docs match executable contracts.
- Public API tests fail if unlisted internal symbols become exported.

## Assumptions

- Target branch is `snowball`.
- Scheduled workflows should run from the repository default branch and dispatch the `snowball` target ref.
- Codex auth is managed on a trusted/private runner. Public runners must not use persisted ChatGPT-managed Codex auth.
- No API-key or extra paid-token path is allowed in this implementation.
- Dirty or untracked ARIA runtime state must be classified before real write or merge execution is enabled.
