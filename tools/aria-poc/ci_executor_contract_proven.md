# Codex CLI CI Invocation Contract — Proven Target

> **Plan 2026-05-25** — supersedes the Claude/Anthropic executor contract.
> `tools/aria-poc/ci_executor.py`, `tools/aria-poc/worker_executor.py`, and
> `.github/workflows/aria-agent-executor.yml` must use this Codex-first
> contract. Claude argv, OAuth-token, and Anthropic API-key paths are legacy
> and must not be live execution authorities.

## Runtime Contract

```yaml
ci_executor:
  binary: codex
  argv:
    - codex
    - exec
    - --json
    - -c
    - 'model_reasoning_effort="xhigh"'
  stdin: "<contents of aria-tools/agent-invocations/prompts/${REQUEST_ID}.md>"
  persisted_output: "<sanitized aria/agent-response/v1 envelope at expected_output_path>"
  raw_jsonl_persisted: false
  subprocess_timeout_seconds: "${MAX_TIMEOUT_SECONDS}"
  env_transit:
    - ARIA_LEASE_TOKEN
    - CODEX_CLI_MOCK
    - CODEX_CLI_MOCK_SOURCE
worker_executor:
  binary: codex
  argv:
    - codex
    - exec
    - --json
    - -c
    - 'model_reasoning_effort="xhigh"'
  stdin: "<contents of aria-tools/dispatch/prompts/${ASSIGNMENT_ID}.md>"
  cwd: "<assigned worktree path>"
  raw_jsonl_persisted: false
  env_transit:
    - ARIA_LEASE_TOKEN
    - CODEX_CLI_MOCK
```

## Auth And Billing Policy

* Default auth is ChatGPT-managed Codex CLI login on a trusted/private runner.
* API-key mode is disallowed: `OPENAI_API_KEY` and `CODEX_API_KEY` must be absent unless a future ADR explicitly permits API billing.
* `CODEX_OSS_DEBUG=1` is forbidden in real mode because it can expose raw prompts or model output.
* Real mode must fail closed if `codex --version`, Codex auth/session preflight, JSONL event parsing, or usage extraction cannot be verified.
* Budget enforcement in this mode tracks account/session/rate-limit headroom and token usage, not API-dollar spend.

## Artifact Policy

* Persist only the sanitized `aria/agent-response/v1` envelope expected by the kernel.
* Do not upload raw Codex JSONL, raw prompts, raw responses, claims ledgers, runs ledgers, lease tokens, session tokens, or API keys.
* GitHub Actions upload path must be exact per-request output, with short retention and `if-no-files-found: error`.

## Workflow Policy

* Scheduled workflows run from the repository default branch and checkout the `main` target ref.
* The executor job runs on a trusted self-hosted runner labelled `codex`; GitHub-hosted runners must not carry persisted ChatGPT-managed Codex auth.
* `CODEX_CLI_MOCK` kill switch remains available for dry-runs.
* Claude/Anthropic workflow secrets are not part of the live executor contract.

## Verification Fields

```yaml
verification_mode: runtime-preflight
verified_at_commit: ffdef128aee928ba09f8fceb847fa56ab6caa334
codex_cli_version_minimum: codex-cli 0.135.0
verified_by_operator_handle: github-actions:self-hosted-codex-runner
verified_at_iso8601: workflow-run-time
finding_closed: DEBT-2026-05-25-CODEX-MIGRATION
```

The workflow enforces the minimum Codex CLI version and ChatGPT-managed auth at run time before any request is claimed. Static prose is not accepted as authority when the pre-flight fails.

The contract is code-owned. Any runtime argv/config/auth change must update this document and the matching invariant tests in the same commit.
