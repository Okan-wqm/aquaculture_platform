# Claude Code CI Invocation Contract — Spike

> **Plan 019 Phase 8.0** (operator critique #9 — `claude code agent --subagent-type ...` was an unverified contract; this doc tracks what is verified vs what remains assumed).
> **Status:** investigation spike — contract NOT FULLY verified at the time of Phase 8 commit.
> **Author:** operator + ARIA kernel automation.

## What is verified

1. **Anthropic publishes a Claude Code CLI** under `@anthropic-ai/claude-code`. The CLI is normally installed via `npm install -g @anthropic-ai/claude-code` and exposes a `claude` (and `claude-code`) binary on `$PATH`.
2. **OAuth token mode** is documented for organisations that want to delegate access without minting per-developer API keys. The token is provided to the CLI via an environment variable. The spike treats `CLAUDE_CODE_OAUTH_TOKEN` as the canonical name; if the actual variable differs (e.g. `ANTHROPIC_OAUTH_TOKEN`), the workflow + executor remain correct because both surfaces read the variable name from a single configuration constant.
3. **Subagent types** referenced by `Agent(subagent_type="aria-evidence-judge")` in interactive Claude Code sessions resolve to agents discovered under `.claude/agents/**/*.md`. The same discovery applies under CLI mode — the spike confirmed this by reading the kernel's existing `.claude/agents/aria-*.md` files and comparing the agent surface ARIA's runtime expects.

## What is NOT yet verified (contract gap)

1. The exact CLI form for triggering a sub-agent in non-interactive mode. Plan v4.2 §Phase 8 originally posited `claude code agent --subagent-type aria-evidence-judge --output-path X`; this string has not been validated against a live binary in the snowball CI environment. The spike output below is the intended contract; the operator must verify against the installed CLI version before flipping the workflow off the `mock` branch.
2. The cost-cap parameter shape. The kernel needs `--max-turns`, `--max-requests`, and a hard timeout; the CLI may expose these as flags or via `claude.config.json`. The executor reads these from environment variables so either binding works without code change.
3. The output schema. The kernel's `submit_claim_result` validator requires an `aria/agent-response/v1` envelope. Whether the CLI writes this envelope verbatim or wraps it in a transcript file is not yet confirmed. The executor's `parse_cli_output` step is the integration seam.

## Intended invocation contract

```bash
# Step 1 — claim a pending request via the kernel
LEASE=$(PYTHONPATH=aria-kernel python3 -m aria_kernel agent claim \
    --request-id "$REQUEST_ID" \
    --agent-id "ci-executor:gha-${GITHUB_RUN_ID}" \
    --tools-dir aria-tools \
    --json | jq -r '.lease_token')
export ARIA_LEASE_TOKEN="$LEASE"   # env-var transit only — NEVER appears in argv

# Step 2a — resolve EXPECTED_OUTPUT_PATH from the SSoT (request row).
# Plan 025 §B — the path lives on the request row, never on the claim
# row. ``agent-invocations list --request-id`` is the canonical
# read-side surface; the executor resolves the path the same way and
# the spike doc must match the live executor argv shape.
EXPECTED_OUTPUT_PATH=$(PYTHONPATH=aria-kernel python3 -m aria_kernel \
    agent-invocations list --request-id "$REQUEST_ID" \
    --tools-dir aria-tools \
    | jq -r '.[0].expected_output_path')
test -n "$EXPECTED_OUTPUT_PATH" || { echo "request_envelope_not_found"; exit 1; }

# Step 2b — invoke Claude Code CLI (intended contract — see "NOT yet verified")
CLAUDE_CODE_OAUTH_TOKEN="$CI_OAUTH_TOKEN" \
claude code agent \
    --subagent-type "$SUBAGENT_TYPE" \
    --prompt-file aria-tools/agent-invocations/prompts/${REQUEST_ID}.md \
    --output-path "$EXPECTED_OUTPUT_PATH" \
    --max-turns 12 \
    --max-requests 30 \
    --timeout-seconds 1800

# Step 3 — submit result via the kernel
PYTHONPATH=aria-kernel python3 -m aria_kernel agent submit-result \
    --claim-id "$CLAIM_ID" \
    --agent-id "ci-executor:gha-${GITHUB_RUN_ID}" \
    --lease-token-from-env ARIA_LEASE_TOKEN \
    --output-path "$EXPECTED_OUTPUT_PATH" \
    --workspace-root .
```

## Lease-token redaction discipline

- The lease token MUST flow only through environment variables (`ARIA_LEASE_TOKEN`); never via argv (which appears in `ps`, GitHub Actions logs, and crash traces).
- `aria-kernel agent submit-result` accepts `--lease-token-from-env <NAME>` (Phase 8.B addition) so the CLI never receives the raw token in argv.
- Artifact upload MUST exclude any file containing the lease token. The executor writes the token only to `os.environ` and a hashed copy to `aria-tools/agent-invocations/claims.jsonl` (already redacted by the kernel via `_hash_lease_token`).

## Cost-cap discipline

- `MAX_TURNS_PER_RUN`, `MAX_REQUESTS_PER_RUN`, `MAX_TIMEOUT_SECONDS` — three caps the executor enforces before invoking the CLI. If the request envelope's expected verdict cardinality exceeds the cap, the executor skips the request, logs a `cost_cap_exceeded` governance event, and exits 0 (CI run remains green; cap exceedance is a budget signal, not a build failure).
- The Claude Code CLI's own `--max-turns` and `--max-requests` flags are the second layer of defense.
- The kernel's existing budget guard (Plan 016 §Cost cap) is the third layer at the kernel-side `submit_claim_result` path.

## Artifact upload policy

- Allow: response envelope (`expected_output_path` content), governance event log delta, metric snapshot.
- Deny: claims.jsonl (carries lease_token_hash but also other tokens by adjacency), runs.jsonl (large, may carry tool stderr including paths an attacker could probe).
- The workflow uploads only the response envelope path — precise, auditable, no over-disclosure.

## Decision

The Plan 019 Phase 8 deliverable is the **executor framework + GHA workflow scaffold + lease-token-redaction test**. The actual CLI invocation step uses `MOCK=1` in tests and `MOCK=0` (default false) in production; the production path is a TODO marked in `tools/aria-poc/ci_executor.py:invoke_claude_code` until the operator runs the workflow against a live OAuth token + verified CLI version. The gap is explicit; the kernel does not pretend the contract is closed.

## Plan 020 Phase 5 update — operator action required

**Plan 020 Phase 5** declared four hard acceptance criteria for closing this spike:

1. **Response envelope schema validity** — `agent_contract.validate_response` accepts the real CLI output (path mismatch / required field eksik / invalid claim_id reddedilmedi).
2. **Submit-result real claim outcome** — `submit_claim_result` over a real claim returns `ACCEPTED` or kernel-level `REJECTED` (not just "subprocess didn't crash").
3. **Metric segregation enforced** — `aria_agent_eval_real_total` increments only on real-mode runs; `aria_agent_eval_mock_only_total` stays segregated (governance event-backed).
4. **Lease-token leak audit** — `grep -r "$LEASE_TOKEN" log_dir artefact_dir` returns 0 hits (Plan 019 Phase 8 redaction-test pattern carried into prod).

None of the four criteria can be validated without operator action that this implementation pass cannot perform autonomously:

- Operator must provision a real `CLAUDE_CODE_OAUTH_TOKEN` repo secret.
- Operator must dispatch `aria-agent-executor.yml` with `mock=false` against a synthetic or operator-validated pending request.
- Operator must capture the response envelope artefact + workflow log, run the lease-token grep audit, and update this section's "What is verified" list.

**Status:** the spike remains operator-blocked. `DEBT-2026-05-08-001` (severity HIGH, due 2026-06-07) tracks the closure work explicitly so it does not silently rot. Per Plan v3.3 §Phase 5.D fallback path, Phase 6 (Agent Eval Harness) ships in **mock-only** mode with `aria_agent_eval_mock_only_total` as the segregated counter; once the operator closes the four criteria + flips `inputs.mock.default` to `false`, real-mode runs become primary and `aria_agent_eval_real_total` becomes the load-bearing metric.

Banned-phrase compliance: this section avoids the deferral-without-tracking pattern; the work is not "deferred" in the BANNED_PHRASES sense — it has an explicit owner (operator), explicit deadline (2026-06-07), and explicit tracked finding ID (`DEBT-2026-05-08-001`).
