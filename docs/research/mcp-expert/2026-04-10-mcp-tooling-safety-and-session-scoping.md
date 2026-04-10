# MCP Tooling Safety and Session Scoping

## Topic

Why `mcp/**` needs a dedicated reviewer focused on tool safety, session scoping, backend-access boundaries, and graceful degradation.

## Sources

- Code inspection on 2026-04-10:
  - `mcp/farm-management/README.md`
  - `mcp/farm-management/src/server.ts`
  - `mcp/farm-management/src/index.ts`
  - `mcp/farm-management/src/config.ts`
  - `mcp/farm-management/src/auth/session-context.ts`
  - `mcp/farm-management/src/graphql/client.ts`
  - `mcp/farm-management/src/tools/index.ts`
  - `mcp/farm-management/src/prompts/index.ts`
  - `mcp/farm-management/src/knowledge/thresholds.ts`
  - `mcp/farm-management/src/utils/formulas.ts`
  - `mcp/farm-management/src/__tests__/formulas.test.ts`
  - `mcp/farm-management/src/__tests__/water-treatment-scenario.test.ts`
- Review context:
  - `docs/reviews/orchestrator/2026-04-10-agent-review.md`

## Key Findings

- The MCP server mixes several distinct concerns: runtime startup, tool/prompt registration, local analytics, trusted-session extraction, and optional live backend access.
- `src/server.ts` and `src/tools/index.ts` indicate a design where some capabilities can work offline while others depend on GraphQL or session context. That makes graceful degradation a real architecture concern, not a hypothetical one.
- `src/auth/session-context.ts` shows a trusted-boundary model where claims may be decoded locally after an upstream gateway authenticates the request. That is acceptable only if the trust boundary remains explicit.
- `src/graphql/client.ts` introduces tenant/user-scoped backend access and caching concerns. Without dedicated review, this surface can easily leak cross-session data or hang tool execution.
- Prompts, knowledge files, and deterministic analytics under `src/prompts`, `src/knowledge`, `src/analytics`, and `src/utils` form a capability surface of their own. They are not well covered by farm-domain review alone.

## Security Concerns

- Allowing tenant or user identity to come from arbitrary tool arguments instead of trusted session context would create an immediate cross-tenant leak risk.
- Local JWT decode is only safe when the gateway trust boundary is explicit. If deployment mode changes to allow direct access, the auth model must harden with full verification.
- Prompt and knowledge files can leak privileged operational detail if treated as harmless content instead of executable capability context.

## Performance Concerns

- Tool execution that waits indefinitely on GraphQL or retries without bounds will stall client sessions and degrade the whole MCP process.
- Session-scoped caching needs explicit keys and invalidation rules; otherwise stale or cross-user responses become both correctness and performance problems.
- Offline analytics should stay available even when live backend access fails; otherwise every transient backend issue collapses the whole MCP experience.

## Architectural Implications

- A dedicated `mcp-expert` is justified because `mcp/**` combines auth, tool safety, prompt safety, and backend adapter behavior in one deployable surface.
- Orchestrator routing should send `mcp/**` to a primary MCP reviewer and notify domain/security owners as needed.
- Farm-domain expertise remains necessary for business correctness, but it is not sufficient for MCP runtime and capability-boundary review.

## Domain Rule Additions

- Separate optional live-backend capabilities from deterministic offline tools and review degraded-mode behavior explicitly.
- Keep session and tenant context request-scoped and trusted-boundary-driven; never let tool arguments override authenticated context.
- Require bounded timeout/retry behavior and tenant-safe cache keys for GraphQL-backed tools.
- Treat prompts, knowledge files, and tool descriptions as a security-relevant capability surface, not as harmless content.
