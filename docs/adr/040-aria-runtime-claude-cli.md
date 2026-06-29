# ADR-040: ARIA Live Runtime is the Claude Code CLI

## Status

Accepted (2026-06-29). Reverses the 2026-05-25 Codex CLI runtime decision
(`DEBT-2026-05-25-CODEX-MIGRATION`, `tools/aria-poc/ci_executor_contract_proven.md`
pre-migration). Tracking finding: `docs/reviews/orphan-findings.md#ORPHAN-MEDIUM-253`.

## Context

ARIA's autonomous executor runs its agents through an external LLM CLI on a
trusted/private runner. The 2026-05-25 decision made that CLI the **Codex CLI**
(`codex exec --json -c model_reasoning_effort="xhigh"`, ChatGPT-managed Codex
auth) and explicitly demoted the earlier Anthropic API-key/OAuth paths to
legacy.

The operator has reversed that decision: ARIA must run on the **Claude Code
CLI** — the same `claude` binary an operator drives interactively — using a
managed Claude Code login session, not Codex and not a raw model API key. The
rationale is operational consistency (the runtime is the same tool the operators
and reviewers already use) and alignment with the platform's Claude-first
agent roster (every `.claude/agents/aria-*.md` is Opus).

This is not a return to the pre-2026-05-25 Anthropic-API path: the runtime is
the Claude Code **CLI** with a managed session, not `ANTHROPIC_API_KEY` billing.

## Decision

ARIA's live LLM runtime is the Claude Code CLI. The executor-side contract is
`tools/aria-poc/ci_executor_contract_proven.md`:

- Invocation: `claude -p --output-format stream-json --verbose --model <model>
  --dangerously-skip-permissions`, prompt on stdin; stream-json parsed to the
  final message + token usage. The per-agent `--model` resolves from the agent
  frontmatter via `aria_kernel.agent_runtime_profile.resolve_claude_model`
  (fail-safe `opus`).
- Auth: a managed Claude Code login session on a trusted/private runner is the
  default. `ANTHROPIC_API_KEY` / `CLAUDE_API_KEY` / `ANTHROPIC_AUTH_TOKEN` /
  `ANTHROPIC_BASE_URL` (proxy billing) are fail-closed unless an operator opts
  in via `ARIA_ALLOW_CLAUDE_API_KEY_MODE=1` under a future ADR.
- `--dangerously-skip-permissions` is required so the autonomous executor can
  edit its assigned worktree without per-tool human approval (the autonomy the
  Codex `exec` path previously provided), and is acceptable only on the trusted
  runner.

The runner attestation contract (`aria_kernel.runner_attestation`) requires a
`claude_auth` field in the approved set; the GH `aria-agent-executor.yml`
preflights `claude --version` + the managed-auth credential surface before
claiming any request. Codex auth probes are removed.

The machine-checked authority for this decision is
`tests/invariants/aria-doc-runtime-ssot.spec.ts` (it now pins Claude-as-runtime
in `CURRENT_STATE.md`, `ARCHITECTURE.md`, the contract, and the workflow, and
treats Codex runtime terms as stale) plus the V3 phase invariants
(`I-V3-21` argv, `I-V3-22b/c` preflight, `I-V3-23/23a` contract + mock audit).

## Consequences

- `tools/aria-poc/codex_runtime.py` and its contract test are deleted; the
  executors call `tools/aria-poc/claude_runtime.py`.
- `CURRENT_STATE.md` / `ARCHITECTURE.md` declare the Claude Code CLI runtime;
  the ARIA authority hash is regenerated accordingly.
- ADR-035 (runtime v2 artifact-backed promotion) is unaffected as a ledger-format
  decision; only its surrounding runtime prose now reads Claude.
- Historical Codex plan/review/runbook docs (e.g. the 2026-05-25 plan,
  `docs/runbooks/aria-codex-runtime-observability.md`) are retained as
  superseded design-history evidence per the ARIA authority chain; they are not
  runtime authority.
- Secret-scrub breadth (`artifact_safety.py`) keeps the Codex/OpenAI env-var
  patterns: redacting a superset of provider secrets is strictly safer and is
  not a runtime authority statement.
- A single operator-supervised live invocation must populate the
  `verified_at_commit` field in the proven-contract doc before the live lane is
  trusted (it currently holds `PENDING-OPERATOR-LIVE-INVOCATION`).
