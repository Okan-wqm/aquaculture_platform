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
  stdin: "<contents of aria-tools/agent-invocations/prompts/${REQUEST_ID}.md>"
  persisted_output: "<sanitized aria/agent-response/v1 envelope at expected_output_path>"
  raw_jsonl_persisted: false
  subprocess_timeout_seconds: "${MAX_TIMEOUT_SECONDS}"
  env_transit:
    - ARIA_LEASE_TOKEN
    - CLAUDE_CLI_MOCK
    - CLAUDE_CLI_MOCK_SOURCE
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
  stdin: "<contents of aria-tools/dispatch/prompts/${ASSIGNMENT_ID}.md>"
  cwd: "<assigned worktree path>"
  raw_jsonl_persisted: false
  env_transit:
    - ARIA_LEASE_TOKEN
    - CLAUDE_CLI_MOCK
```

The per-agent `--model` and `--effort` values are resolved from the dispatched
agent's frontmatter `model:`/`effort:` tiers by
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
claude_cli_version_minimum: claude-code 2.1.197
verified_by_operator_handle: github-actions:self-hosted-claude-runner
verified_at_iso8601: workflow-run-time
finding_closed: DEBT-2026-06-29-CLAUDE-CLI-MIGRATION
```

The workflow enforces the minimum Claude Code CLI version and managed-auth at
run time before any request is claimed. Static prose is not accepted as
authority when the pre-flight fails.

The contract is code-owned. Any runtime argv/config/auth change must update this
document and the matching invariant tests in the same commit.
