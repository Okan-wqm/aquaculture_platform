# Claude Code CI Invocation Contract — Proven

> **Plan ARIA-V3 Phase B1** — promotes the prior Phase 8 spike from
> investigation status to load-bearing contract status. The argv shape
> emitted by `tools/aria-poc/ci_executor.py` and
> `tools/aria-poc/worker_executor.py` is now LOCKED by invariant
> `I-V3-21` (`aria-kernel/tests/invariants/v3/test_phase_b1_argv_proven_workflow_hygiene.py`)
> and must match this document byte-for-byte. Any kernel-side argv
> change MUST update this document in the same commit; the invariant
> test refuses to pass otherwise.
>
> **Status:** kernel-side contract proven (argv shape, env transit,
> redaction discipline). Live `claude` CLI version confirmation is the
> operator's out-of-band action (single supervised invocation against
> the installed binary) and updates the `verified_at_commit` +
> `claude_cli_version_minimum` fields below.
>
> **Predecessor:** DEBT-2026-05-08-001 (HIGH, opened 2026-05-08, due
> 2026-06-07) — retired by this proven contract; B1 closes the
> traceability finding.

## Proof of argv contract

`proven_argv` (machine-parseable; I-V3-21 parses this YAML block and
asserts the executor code constructs the same argv tuple).

```yaml
ci_executor:
  binary: claude
  argv:
    - claude
    - --print
    - --agent
    - "<subagent_type from request envelope>"
    - --max-budget-usd
    - "${MAX_BUDGET_USD_PER_RUN}"
    - --output-format
    - json
  stdin: "<contents of aria-tools/agent-invocations/prompts/${REQUEST_ID}.md>"
  stdout: "<expected_output_path from request row>"
  subprocess_timeout_seconds: "${MAX_TIMEOUT_SECONDS}"
  env_transit:
    - CLAUDE_CODE_OAUTH_TOKEN
    - ARIA_LEASE_TOKEN
worker_executor:
  binary: claude
  argv:
    - claude
    - --print
    - --agent
    - "<target_agent from dispatch envelope>"
    - --add-dir
    - "<assigned worktree path>"
    - --max-budget-usd
    - "${MAX_BUDGET_USD_PER_RUN}"
  stdin: "<contents of aria-tools/dispatch/prompts/${ASSIGNMENT_ID}.md>"
  env_transit:
    - CLAUDE_CODE_OAUTH_TOKEN
    - ARIA_LEASE_TOKEN
```

## Verification fields

```yaml
verified_at_commit: V7-MODERNIZATION-COMMIT
claude_cli_version_minimum: "2.1.140"
verified_by_operator_handle: "@okan-wqm (V7 30-cycle parallel-consumer task)"
verified_at_iso8601: "2026-05-17T08:00:00Z"
finding_closed: DEBT-2026-05-08-001
```

> **V7 modernization note (2026-05-17):** The argv contract was
> migrated from the legacy `claude code agent --subagent-type X
> --prompt-file Y --output-path Z` shape to modern Claude Code CLI
> 2.1.140's `claude --print --agent X` + stdin/stdout shape because
> the `claude code` subcommand was REMOVED from the modern CLI. The
> ci_executor's parallel-consumer mode (V7.4 skill_genesis_drainer
> dispatch + V6.1 specialist_domain_review claims) is now exercisable
> against the installed claude CLI. The legacy contract was never
> live-verified (verification fields had carried PENDING-OPERATOR-
> LIVE-INVOCATION since Plan ARIA-V3 §B1 closure); V7's parallel-
> consumer requirement forced the modernization.

The kernel-side contract above is load-bearing AS OF this commit.
The verification fields are populated by the operator's single
supervised end-to-end live invocation:

1. Operator sets `secrets.CLAUDE_CODE_OAUTH_TOKEN` and unsets
   `vars.ARIA_MOCK_KILL_SWITCH` (or leaves unset — workflow default
   is now `'false'`).
2. Operator dispatches `aria-agent-executor.yml` against a synthetic
   pending request with `mock=false`.
3. Operator captures argv (via `ps` or workflow log diagnostic), CLI
   stdout, the response envelope artefact, and the workflow return
   code.
4. Operator commits an update to this document filling the four
   verification fields above; that commit closes the live-shakeout
   half of B1.

The kernel-side architectural prerequisites for that operator action
are landed and locked NOW:

* `claude` binary install step (pinned `@anthropic-ai/claude-code`
  npm package) at workflow startup — invariant I-V3-22c.
* `CLAUDE_CODE_OAUTH_TOKEN` presence pre-flight guard — invariant
  I-V3-22b.
* `vars.ARIA_MOCK_KILL_SWITCH` read AHEAD of the default — invariant
  I-V3-22a. Operator opt-out path stays open.
* `CLAUDE_CODE_MOCK` workflow default flipped `'true' → 'false'` —
  invariant I-V3-22.
* `mock_mode_default_flipped` audit event emitted on every workflow
  invocation (Audittrail-HIGH-009) — invariant I-V3-23a.
* `aria-agent-executor.yml` added to V2 I-25 `_GOVERNED_WORKFLOWS`
  set — invariant I-V3-22d.

## Lease-token redaction discipline (unchanged from spike)

* Lease token MUST flow only through `ARIA_LEASE_TOKEN` env var; never
  via argv (`ps`, GitHub Actions logs, crash traces).
* `aria-kernel agent submit-result` accepts
  `--lease-token-from-env <NAME>` so the CLI never receives the raw
  token in argv.
* Artifact upload excludes any file containing the lease token; the
  executor writes the token only to `os.environ` and a hashed copy to
  `aria-tools/agent-invocations/claims.jsonl`
  (`_hash_lease_token`).

## Cost-cap discipline (extended by Phase B0)

* `MAX_TURNS_PER_RUN`, `MAX_REQUESTS_PER_RUN`, `MAX_TIMEOUT_SECONDS`
  — three caps the executor enforces before invoking the CLI.
* The Claude Code CLI's own `--max-turns` and `--max-requests` flags
  are the second layer of defense.
* The kernel's existing budget guard
  (`aria_kernel.cost_budget.assert_within_budget`, Phase B0) is the
  third layer at the kernel-side `submit_claim_result` path — trips
  the cost circuit breaker on daily / monthly / per-run cap excess.

## Artifact upload policy (unchanged from spike)

* Allow: response envelope (`expected_output_path` content),
  governance event log delta, metric snapshot.
* Deny: `claims.jsonl` (carries `lease_token_hash` adjacent to other
  tokens), `runs.jsonl` (may carry tool stderr with paths an attacker
  could probe).
* The workflow uploads only the response envelope path — precise,
  auditable, no over-disclosure.

## Decision (Plan ARIA-V3 §B1)

The previous spike's "Phase 8 deliverable is the executor framework +
GHA workflow scaffold + lease-token-redaction test" is now extended
to **proven contract status**: the kernel side argv shape is locked
by I-V3-21; the workflow side is hardened (claude binary install,
OAuth preflight, kill-switch, mock-default-flip, audit event); the
governed workflow allowlist (V2 I-25) covers the executor.

What remains is the operator's single live invocation to populate
the four verification fields above. The DEBT finding tracks that
work explicitly; B1 retires the kernel-side half irrevocably.

## Plan ARIA-V3 §B1 closure mapping

| Finding | Closure mechanism |
|---|---|
| DEBT-2026-05-08-001 (argv contract unverified) | This doc + I-V3-21 |
| INFRA-CRITICAL-002 (OAuth rotation) | I-V3-22b preflight guard |
| INFRA-CRITICAL-003 (claude binary install) | I-V3-22c install step |
| INFRA-HIGH-007 (I-25 governed list) | I-V3-22d allowlist addition |
| INFRA-MEDIUM-011 (mock cron safeguard) | I-V3-22a kill switch |
| AUDITTRAIL-HIGH-009 (mock flip unlogged) | I-V3-23a audit event |
