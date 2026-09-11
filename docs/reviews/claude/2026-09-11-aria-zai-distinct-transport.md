# Z.ai gets its own transport; the claude binary serves Anthropic and nothing else

**Date:** 2026-09-11 · **Agent:** claude · **Cycle:** 2026-09-11 Codex handoff — Z.ai subscription route
**Findings:** ARIA-HIGH-067 — closed by this branch; ARIA-HIGH-068 — OPEN until the live exercise records vendor evidence. This document is the evidence for both.

## The policy, and what the code did instead

The operator policy in the 2026-09-11 handoff is explicit: the Codex and
Claude providers run only through their managed-subscription CLI sessions,
never through API keys; Z.ai alone may use its distinct subscription API; and
Z.ai credentials are never injected into Codex/Claude children.
`docs/aria/CURRENT_STATE.md` (Codex's uncommitted candidate) already said
the same — "Separate API transport … Never redirect either managed CLI to
Z.ai" — and named the gap: "the current legacy helper redirects it into
Claude-compatible environment fields, which does not satisfy the new
distinct-transport requirement."

The legacy helper was `claude_runtime.provider_redirect_env` (ORPHAN-HIGH-764):
for the `glm-5.3` tier it put `ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic`
and `ANTHROPIC_AUTH_TOKEN=<the Z.ai key>` into one spawn's environment and ran
the `claude` binary. That is precisely the forbidden shape. Two further facts
made Z.ai unusable on the native lane regardless: `model_fleet` listed Z.ai
with `runtime_hint="claude"`, so `_native_runtime_admission` demanded a
`claude` binary and `observe_status` returned `unknown`; and
`budget.COST_INVOCATION_ROLES` was a hand-copied seven-name subset of the
invocation-role SSoT, so a native run on an `evidence_judgment` request
completed at the vendor and then raised
`agent_role MUST be in COST_INVOCATION_ROLES` — tokens spent, result dropped,
request requeued.

## What was verified before writing

From the vendor's documentation (docs.z.ai/devpack/tool/others, the GLM-5.3
model page, api-reference/api-code): the Coding-Plan OpenAI-compatible base
URL is `https://api.z.ai/api/coding/paas/v4`, the general (prepaid) base URL
is `https://api.z.ai/api/paas/v4`, the Anthropic-protocol Coding-Plan route
is `https://api.z.ai/api/anthropic`; Coding-Plan subscribers "can currently
access the model API only through the OpenAI Chat Completion-compatible
protocol"; authentication is `Authorization: Bearer <key>`; errors are
`{"error": {"code": "<n>", "message": "…"}}` on an HTTP status (401 with
code 1001 for a missing header).

## Design

`tools/aria-poc/zai_runtime.py` — the transport, standard-library `urllib`,
no SDK, no shared binary:

- **Credential boundary.** `read_zai_credential` establishes the secret from
  exactly one source: a file named by `ARIA_ZAI_API_KEY_FILE` (absolute,
  regular, owner-only — any group/world bit is `credential_file_permissions`;
  empty or multi-line is `credential_file_empty`; missing is
  `credential_file_unreadable`), or the env value `ARIA_ZAI_API_KEY` for
  CI-secret injection; both at once is `credential_sources_ambiguous`. The
  value lives in a `ZaiCredential` whose `repr`, `str` and equality never
  expose it and is used only to build one `Authorization` header. The
  variable NAMES come from the fleet row (`model_fleet.zai_provider()`), so
  availability and transport cannot disagree about which variables exist.
- **Endpoint entitlement.** `ZAI_ENDPOINTS` names `coding` and `general`;
  the Anthropic-protocol route is deliberately absent (it exists for the
  redirected CLI this module replaces). `ARIA_ZAI_ENDPOINT` selects a name or
  an explicit base URL recorded as `custom`. Nothing is inferred from the
  key's shape: `probe_zai_status` makes one `max_tokens=1` completion against
  the selected endpoint and records HTTP status, vendor code/message and the
  (auth, quota, reason) classification — 200 → available/available;
  401/403 or auth codes → auth unavailable; 429/402 or balance codes →
  quota exhausted; other 4xx → authenticated but refused, named; 5xx and
  transport failures → unknown, never rounded to a verdict.
- **Execution.** `run_zai_chat` sends the kernel-rendered prompt as the user
  turn under a fixed system turn naming the `aria/agent-response/v1`
  contract, streaming off so the vendor's `usage` block arrives with the
  body, and returns the content, `{input_tokens, output_tokens}`, and the
  same `auth_failure` / `credit_exhaustion` fields the CLI runtimes report.

Fleet and policy (`aria_kernel`):

- `model_fleet`: the Z.ai row is `runtime_hint="zai"` with
  `credential_file_env` / `model_env`; `_RUNTIME_BINARIES` maps the hint to
  no binary; `_credential_named` is the cheap signal; `provider_model`
  honours the operator's model override; `_RuntimeStatusObservation` and the
  admission row carry `credential_source`. `provider_for_model` is the ONE
  binding of a model to its provider — `claude_runtime._model_provider` and
  `dispatch_failure.resolve_dispatch_route` read it instead of a redirect
  table, so the ladder's cross-provider rung (ARIA-HIGH-023) survives: an
  Anthropic auth failure still walks to `glm-5.3`, now served by the Z.ai
  transport.
- `genesis_policy._runtime_monetary_admission`: the managed-subscription
  binding table gains `("zai", "zai", "subscription_api_key")`.
- `budget.COST_INVOCATION_ROLES` is derived from
  `agent_surface.INVOCATION_ROLES` plus the two legacy labels, closed by
  construction (I-V10-COST-03 still pins membership).

Executor (`tools/aria-poc/ci_executor.py`):

- `observe_status` for `runtime_hint == "zai"` prepares a
  `ZaiExecutionContext` (credential handle, endpoint, base URL, model,
  `settings_hash` over endpoint/model/transport only), runs the probe, and
  returns the typed observation; a refused boundary is `unavailable` with
  the named reason and `controls.status = unavailable`, without any request
  leaving the host.
- `_invoke_native_zai` mirrors `_invoke_native_codex` row for row: attempt
  reservation, transcript (the raw response body), auth/quota classification
  into the existing exception family, sealed envelope, usage-or-refuse
  (`usage_unavailable` is never priced as zero), cost attribution,
  `runtime_attempt_finished` with `provider_session_provenance =
"http_response_id"` and the HTTP status as `exit_code`.
- The native dispatch selects the invoker by `route["runtime"]`; the legacy
  ladder's `_dispatch_attempt` routes a Z.ai tier to
  `_run_zai_as_claude_result`, which reports in `ClaudeRunResult` shape and
  records per-spawn usage through the existing `UsageRecording` seam.

Claude runtime (`tools/aria-poc/claude_runtime.py`): the redirect machinery
(`PROVIDER_REDIRECTS`, `provider_redirect_env`, `provider_redirect_disclosure`,
`ProviderRedirectUnavailable`, both env-var names) is deleted, not disabled;
`assert_model_served_by_claude_runtime` is the first statement of
`run_claude_exec` and refuses a foreign-provider model with
`ClaudePolicyViolation("model_not_served_by_claude_runtime: …")`.
`dispatch_failure` drops the `provider_redirect_unavailable` class from its
closed vocabulary (no writer can produce it; historical rows are never
reconstructed through the vocabulary check).

## Proof

- `tests/test_zai_runtime.py` (22): every credential refusal by name; the
  secret absent from `repr`/`str`/equality/settings hash; probe
  classification for 200 / 401 / 429 / balance code / authenticated refusal /
  5xx / dead endpoint, each against a local `http.server` through the real
  `urllib` path; the wire carrying `Bearer <secret>`, model and both
  messages; a 200 without usage leaving `usage=None`.
- `tests/test_ci_executor_native_zai.py` (3): the ACTUAL `ci_executor` child
  with the ACTUAL kernel claim/submit and a local stand-in vendor, no CLI on
  PATH — a 0600 key file plus an answering vendor admits the route, the
  kernel-rendered prompt reaches the vendor as the user turn under Bearer
  auth (byte-equal to `prompt_hash`'s input), the reply becomes the sealed
  result, attempt/usage/finished rows carry the Z.ai identity, the request is
  ACCEPTED, and the secret is absent from every file the kernel wrote; a 401
  probe leaves the request PENDING with the named observation and no run; a
  0640 key file is refused before any request leaves the host.
- `tests/test_claude_runtime_serves_anthropic_only.py` (7): the redirect
  names are gone, the refusal is the first statement of `run_claude_exec`,
  the ladder reads the fleet, the cross-provider rung survives.
- Fleet/policy/classification suites updated to the new contract:
  `test_model_fleet_and_codex` (Z.ai availability without any CLI; the
  managed-context fixture now supplies the `auth.json` the hardened context
  requires and expects the child's PRIVATE codex home — both Codex-era
  fixtures had drifted from the source they test), `test_executor_failure_
classification`, `test_executor_drain_breaker`, `test_credit_fallback`,
  `test_claude_auth_failure_classification` (the release reason is a
  conditional between two NAMED constants since the native lane; the
  AST-shape tests now read both).

## What stays open — ARIA-HIGH-068

The transport is proven against a stand-in, not against api.z.ai. Closing
ARIA-HIGH-068 requires the operator to place the key at a 0600 file named by
`ARIA_ZAI_API_KEY_FILE` (never in chat, argv, Git, logs or evidence), then:
`probe_zai_status` recorded against the vendor with its HTTP status and
code/message; one native request accepted through `_invoke_native_zai` with
the vendor's usage block; and the vendor dashboard confirming which quota the
call drew — the entitlement answer the docs give but the account must prove.
