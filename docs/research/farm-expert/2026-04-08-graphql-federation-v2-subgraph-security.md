# Research: GraphQL Federation v2 Subgraph Security + N+1 Prevention

**Topic:** How to secure subgraphs in a federated supergraph and how to eliminate the N+1 problem that DataLoader-less federation introduces.
**Date:** 2026-04-08
**Agent:** farm-expert

## Sources
- [Apollo GraphQL: Securing Subgraphs — Context and Best Practices](https://www.apollographql.com/blog/securing-apollo-federation-subgraphs-context-and-best-practices)
- [Grafbase: Security considerations in GraphQL Federation](https://grafbase.com/blog/security-considerations-in-graphql-federation)
- [Apollo Docs: Handling the N+1 Problem](https://www.apollographql.com/docs/graphos/schema-design/guides/handling-n-plus-one)
- [Graph Security — Apollo GraphQL Docs](https://www.apollographql.com/docs/graphos/platform/security/overview)
- [Sunken Eyes: GraphQL Federation DataLoader (2025)](https://sunkeneyes.dev/2025/graphql-federation-data-loader/)
- [GraphQL Federation in Production: Md Sanwar Hossain (2026)](https://mdsanwarhossain.me/blog-graphql-federation.html)
- [WunderGraph: DataLoader 3.0 — breadth-first data loading](https://wundergraph.com/blog/dataloader_3_0_breadth_first_data_loading)

## Key Findings

1. **Subgraphs must NEVER be publicly reachable.** They must only accept traffic from the router (gateway). Exposing a subgraph publicly bypasses the router's authorization, query complexity, rate limiting, and schema validation. Enforce via network policy, mTLS, or API gateway deny rules.
2. **Authenticate once at the supergraph; propagate identity via trusted headers to subgraphs.** Every subgraph resolver must still verify permissions against the forwarded identity — never trust that the caller is authorized just because the request came from the router.
3. **DataLoader is mandatory in `__resolveReference`.** Without DataLoader, federated entity resolution becomes an N+1 avalanche: for each reference the router sends, the subgraph executes a separate DB query. DataLoader batches these into a single query.
4. **Query complexity and depth limits** must be enforced at the router AND replicated at the subgraph level (defense in depth), because a compromised router or a direct subgraph reach would bypass the router-only enforcement.
5. **Alias-based enumeration attacks** — attackers use GraphQL aliases to call the same expensive resolver many times in a single request. Mitigate with an alias limit plugin.
6. **Introspection must be disabled in production.** Schema leakage exposes attack surface.
7. **`@requires` directive** can be used to minimize network waterfalls by declaring which fields a subgraph needs to compute a field, letting the query planner batch upstream dependencies.

## Security Concerns
- Direct public subgraph access = **CRITICAL** — bypasses all router-level controls.
- Missing auth check on a subgraph resolver that trusts the router header blindly = **CRITICAL** — privilege escalation via forged header.
- GraphQL introspection enabled in production = **HIGH** — schema leakage enables targeted attacks.
- Missing alias limit plugin on sensitive mutations (login, password reset, MFA verify) = **HIGH** — enables brute-force amplification.
- Missing query complexity limit = **HIGH** — enables DoS via deeply nested queries.
- Missing query depth limit = **HIGH** — same DoS class.
- Error messages leaking stack traces = **MEDIUM** — information disclosure.

## Performance Concerns
- N+1 in `__resolveReference` without DataLoader = **HIGH** — every federated entity lookup becomes O(N) DB queries.
- N+1 in nested `@ResolveField` without DataLoader = **HIGH** — same class, different surface.
- DataLoader cache scope must match request scope — sharing a DataLoader across requests leaks data between tenants. `@Injectable({ scope: Scope.REQUEST })` is mandatory.
- Missing pagination on list resolvers = **HIGH** — unbounded result sets exhaust memory.

## Architectural Implications for farm-expert reviews
- Any subgraph resolver that does not verify authorization based on the forwarded identity = CRITICAL.
- Any `__resolveReference` resolver without DataLoader = HIGH.
- Any `@ResolveField` with DB access and no DataLoader = HIGH (N+1 risk).
- Request-scoped DataLoader providers must be explicit — singleton DataLoaders = CRITICAL tenant isolation breach.
- Subgraph ports must be on an internal network; verify firewall / network policy configuration.

## Domain Rule Additions for farm-expert

Add to `## Domain Rules` as a new subsection `### GraphQL Federation v2`:
- Subgraphs MUST NOT be directly reachable from the public internet — router-only access via network policy or mTLS. Direct reachability = CRITICAL.
- Every subgraph resolver MUST independently verify authorization against the forwarded identity header — trusting the router blindly = CRITICAL.
- `__resolveReference` handlers MUST use request-scoped DataLoader for batched entity lookups. Missing DataLoader = HIGH (N+1).
- `@ResolveField()` decorators that access the database MUST use DataLoader. Missing DataLoader on DB-accessing resolvers = HIGH.
- DataLoader instances MUST be request-scoped (`Scope.REQUEST`) to prevent cross-tenant cache leakage. Singleton DataLoader on tenant data = CRITICAL.
- GraphQL introspection MUST be disabled in production environments. Enabled introspection = HIGH.
- Query complexity and depth limits MUST be enforced at both router and subgraph levels (defense in depth). Missing either = HIGH.
- Alias limit plugin MUST be active on sensitive mutations (login, refresh, reset, MFA verify). Missing = HIGH.
