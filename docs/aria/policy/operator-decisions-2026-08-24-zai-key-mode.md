# Operator decision — 2026-08-24: API-key mode for zai routes only

**Scope:** `ARIA_PROVIDER_REDIRECT_POLICY_REF` names this file as the
operator policy that authorises provider-redirected dispatches to run on
their vendor API key (currently `zai` / `glm-5.3`, token
`ARIA_ZAI_API_KEY`) in the `aria-agent-executor` lane.

**Decision (repo owner, 2026-08-24):** the Claude Code subscription is
cancelled until further notice. While it is off:

- Redirected (zai) routes are **authorised to run on their API key.** The
  token is per-spawn child environment (`provider_redirect_env`) and never
  enters the ambient runner environment; `ARIA_ZAI_API_KEY` reaches only
  the executor step from the repository secret of the same name.
- Anthropic-routed models (opus/fable) have **no key path and may not gain
  one.** `ANTHROPIC_API_KEY` / `CLAUDE_API_KEY` remain banned
  unconditionally (`assert_claude_policy_environment`), and no workflow may
  wire a direct Anthropic key — pinned by the executor workflow contract
  tests. Those routes fail closed (classified auth failures open the
  per-route circuit from ARIA-HIGH-003) until the subscription returns.

**Rollback:** when the Claude subscription is restored, the operator may
retire this reference; the redirect machinery then requires a new policy
ref or the subscription session, exactly as before this decision.
