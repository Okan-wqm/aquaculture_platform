# Claude Code CLI CI Invocation Contract — Proven Target

> **ARIA runtime = Claude Code CLI.** `tools/aria-poc/ci_executor.py`,
> `tools/aria-poc/worker_executor.py`, and
> `.github/workflows/aria-agent-executor.yml` must use this Claude-first
> contract. The earlier Codex `codex exec` argv, the legacy Anthropic
> API-key/OAuth-token paths, and ChatGPT-managed Codex auth are retired and
> must not be live execution authorities.

## Runtime Contract

```yaml
ci_executor:
  binary: claude
  argv:
    - claude
    - -p
    - --output-format
    - stream-json
    - --verbose
    - --model
    - fable
    - --effort
    - max
    - --dangerously-skip-permissions
    - --disallowedTools
    - "<derived from the agent's kernel runtime profile: ungranted tools + external-write rules + mcp__<server> for servers the profile does not name>"
    - --strict-mcp-config
    - --mcp-config
    - "<per-spawn document written by aria_kernel.mcp_client from data/mcp_registry.json: only the profile's mcp_servers, minus quarantined; empty without a profile>"
  stdin: "<contents of aria-tools/agent-invocations/prompts/${REQUEST_ID}.md>"
  persisted_output: "<sanitized aria/agent-response/v1 envelope at expected_output_path>"
  raw_jsonl_persisted: false
  subprocess_timeout_seconds: "${MAX_TIMEOUT_SECONDS}"
  env_transit:
    - ARIA_LEASE_TOKEN
    - CLAUDE_CLI_MOCK
    - CLAUDE_CLI_MOCK_SOURCE
ci_executor_read_contained:
  # ARIA-HIGH-162 — the READ shape: profiles judge_opus, judge_glm, arbiter
  # (claude_runtime.read_contained_profile: pinned id, tools inside Read/Grep/Glob,
  # no MCP server, not write-capable). Same sandbox as the write shape with the
  # workspace bound read-only and nothing writable under it; no bypass flag.
  binary: claude
  argv:
    - claude
    - -p
    - --output-format
    - stream-json
    - --verbose
    - --model
    - "<the profile's model; the fleet rung that answered is stamped on the envelope>"
    - --effort
    - max
    - --restricted
    - --permission-prompts
    - none
    - --tools
    - "<the profile's grant, comma-joined: Read,Grep,Glob for the judges, Read for the arbiter>"
    - --disallowedTools
    - "<derived from the agent's kernel runtime profile: ungranted tools + external-write rules + mcp__<server> for servers the profile does not name>"
    - --strict-mcp-config
    - --mcp-config
    - "<per-spawn document: empty — no read profile names an MCP server>"
  stdin: "<contents of aria-tools/agent-invocations/prompts/${REQUEST_ID}.md>"
  persisted_output: "<sanitized aria/agent-response/v1 envelope at expected_output_path>"
  governance: claude_spawn_read_contained {request_id, subagent_type, profile_id, tools}
  raw_jsonl_persisted: false
  subprocess_timeout_seconds: "${MAX_TIMEOUT_SECONDS}"
ci_executor_judge_batch:
  # Typed-judgment plan Phase 4b (ARIA-MEDIUM-163) — K judge requests that share a
  # role, an agent and an anchor, served by ONE typed model call on a process-less
  # route (`judgment_pipeline.judge_batch_runtimes`, default ["zai"]; opt-in via
  # `judge_batch_size` > 1). No binary: the kernel's own HTTP transport.
  entry: "ci_executor.py --judge-batch <role> <target_agent> <request_id>..."
  admission: "_admit_native_route once per child; _bind_request_to_route per member"
  lease_seconds: "batch_worst_case_seconds(K) for every member's claim"
  call: "run_zai_chat(system=render_batch_system_turn(contract), user=render_batch_user_turn(batch), json_object=true)"
  per_member: "attempt reservation, typed envelope (build_envelope_from_typed_answer), transcript {batch_id, payload_hash, answer, usage_share}, pre-submit gate, submit-result, reconcile, dispatch summary"
  cost: "one cost row per call; every runtime_attempt_finished row carries batch_id and usage_apportioned"
  release_reasons:
    - "judge_batch_call_failed:<code> (harness-class: transport, auth, credit, input_budget, payload_*, http_<status>, usage_unavailable)"
    - "judge_batch_item_unanswered:<typed_judgment reason code> (request-class: this member's item refused while siblings folded)"
worker_executor:
  binary: claude
  argv:
    - claude
    - -p
    - --output-format
    - stream-json
    - --verbose
    - --model
    - fable
    - --effort
    - max
    - --dangerously-skip-permissions
    - --disallowedTools
    - "<derived from the agent's kernel runtime profile: ungranted tools + external-write rules + mcp__<server> for servers the profile does not name>"
    - --strict-mcp-config
    - --mcp-config
    - "<per-spawn document written by aria_kernel.mcp_client from data/mcp_registry.json: only the profile's mcp_servers, minus quarantined; empty without a profile>"
  stdin: "<contents of aria-tools/dispatch/prompts/${ASSIGNMENT_ID}.md>"
  cwd: "<assigned worktree path>"
  raw_jsonl_persisted: false
  env_transit:
    - ARIA_LEASE_TOKEN
    - CLAUDE_CLI_MOCK
```

The per-agent `--disallowedTools` list is derived by
`aria_kernel.runtime_profiles.disallowed_tools_for` from the agent's kernel-owned
runtime profile (Plan 032 Faz 032b): every Claude tool the profile does not grant,
plus the external-write rules (`Bash(git push*)`, `Bash(gh pr create*)`, `Bash(gh api*)`, …)
while the profile's `external_writes` is false. Deny rules bind in every permission
mode, so the envelope holds under `--dangerously-skip-permissions`.

The per-agent `--model` and `--effort` values are resolved from the dispatched
agent's frontmatter `model:`/`effort:` tiers (mirrors of the kernel profile) by
`aria_kernel.agent_runtime_profile.read_agent_runtime_profile` (fail-safe: the
most expensive tier). The `fable`/`xhigh` values above are the fail-safe
defaults; scout-tier agents may resolve to cheaper aliases/levels, and the CLI
accepts `--effort low|medium|high|xhigh|max` since 2.1.x.

`--dangerously-skip-permissions` is required because the autonomous executor
runs on a trusted/private runner and must edit its assigned worktree without a
human approving each tool call (the autonomy `codex exec` previously provided).

## Auth And Billing Policy

* Default auth is a managed Claude Code login session on a trusted/private runner.
* API-key / proxy-billing mode is disallowed: `ANTHROPIC_API_KEY`, `CLAUDE_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, and `ANTHROPIC_BASE_URL` must be absent unless a future ADR explicitly permits API billing (`ARIA_ALLOW_CLAUDE_API_KEY_MODE=1`).
* Real mode must fail closed if `claude --version`, the managed-auth credential surface, stream-json event parsing, or usage extraction cannot be verified.
* Budget enforcement in this mode tracks account/session headroom and token usage, not API-dollar spend.

## Artifact Policy

* Persist only the sanitized `aria/agent-response/v1` envelope expected by the kernel.
* Do not upload raw Claude stream-json, raw prompts, raw responses, claims ledgers, runs ledgers, lease tokens, session tokens, or API keys.
* GitHub Actions upload path must be exact per-request output, with short retention and `if-no-files-found: error`.

## Workflow Policy

* Scheduled workflows run from the repository default branch and checkout the `main` target ref.
* The executor job runs on a trusted self-hosted runner labelled `claude`; GitHub-hosted runners must not carry a persisted managed Claude Code session. The autonomous-WRITE executor runs as a **non-root** user (the Claude Code CLI refuses `--dangerously-skip-permissions` under root) or in an acknowledged sandbox (`ARIA_CLAUDE_SANDBOX=1`); `claude_runtime.assert_write_runner_ok` enforces this fail-closed (ADR-040, ORPHAN-MEDIUM-254).
* `CLAUDE_CLI_MOCK` kill switch remains available for dry-runs.
* Anthropic API-key / OAuth-token workflow secrets are not part of the live executor contract.

## Verification Fields

```yaml
verification_mode: runtime-preflight
verified_at_commit: PENDING-OPERATOR-LIVE-INVOCATION
claude_cli_version_minimum: claude-code 2.1.221
verified_by_operator_handle: github-actions:self-hosted-claude-runner
verified_at_iso8601: workflow-run-time
finding_closed: DEBT-2026-06-29-CLAUDE-CLI-MIGRATION
```

The workflow enforces the minimum Claude Code CLI version and managed-auth at
run time before any request is claimed. Static prose is not accepted as
authority when the pre-flight fails.

The contract is code-owned. Any runtime argv/config/auth change must update this
document and the matching invariant tests in the same commit.
