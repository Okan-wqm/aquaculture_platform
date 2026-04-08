# Research: GraphQL Security — Introspection, Depth, Alias, Complexity, Field-Level Auth

**Topic:** Introspection disabled in production, depth limit, alias limit brute-force protection, query complexity limits, rate limiting, field-level authorization
**Date:** 2026-04-08
**Agent:** security-reviewer

## Sources

- [OWASP Cheat Sheet — GraphQL](https://cheatsheetseries.owasp.org/cheatsheets/GraphQL_Cheat_Sheet.html)
- [OWASP API Security Top 10 (2023) — A8 Lack of Protection from Automated Threats](https://owasp.org/API-Security/editions/2023/en/0xa8-lack-of-protection-from-automated-threats/)
- [OWASP API Security — A4 Unrestricted Resource Consumption](https://owasp.org/API-Security/editions/2023/en/0xa4-unrestricted-resource-consumption/)
- [OWASP Testing Guide — GraphQL Testing](https://owasp.org/www-project-web-security-testing-guide/v42/4-Web_Application_Security_Testing/12-API_Testing/01-Testing_GraphQL)
- [Apollo GraphQL — Securing Your Graph](https://www.apollographql.com/docs/graphos/platform/security/overview)
- [Apollo GraphQL — Operation Limits](https://www.apollographql.com/docs/graphos/routing/security/operation-limits)
- [Apollo GraphQL — Persisted Queries (Safelist)](https://www.apollographql.com/docs/graphos/routing/security/persisted-queries)
- [GraphQL Spec — Validation](https://spec.graphql.org/October2021/#sec-Validation)
- [PortSwigger Research — GraphQL API Vulnerabilities](https://portswigger.net/web-security/graphql)
- [PortSwigger Research — Hidden GraphQL Endpoints](https://portswigger.net/research/finding-graphql-endpoints)
- [The GraphQL Project — Production-Ready GraphQL Security Checklist](https://graphql.org/learn/security/)
- [Escape.tech — GraphQL Security Best Practices](https://escape.tech/blog/9-graphql-security-best-practices/)
- [Wundergraph — Hardening Federation](https://wundergraph.com/blog/securing_a_graphql_subgraph_in_a_distributed_graph)

## Key Findings

### 1. Introspection in production is a target acquisition tool, not a debugging convenience
Apollo's official guidance, OWASP, and PortSwigger all converge: introspection enabled in production gives an attacker a complete map of the schema (every type, field, argument, mutation). Without introspection an attacker must guess; with introspection the attack surface is enumerated in one query. Disable in production via Apollo Router config (`introspection: false`), AND verify by sending a `__schema` query to the production endpoint and confirming rejection. Verify also at every subgraph independently — introspection disabled at the router but enabled at the subgraph (which is internally reachable) means a compromised internal pod gets the schema.

### 2. Depth limit alone is insufficient — alias and complexity limits are equally critical
A naive depth-limit-only implementation is bypassed by:
- **Alias amplification:** `query { a: expensiveField b: expensiveField c: expensiveField ... }` — one request, N executions of the same resolver, depth = 1.
- **Field duplication:** repeating the same field at depth 1 hundreds of times.
- **Wide schemas:** width × depth grows exponentially even at low depth.

Apollo Router operation limits enforce all three:
- `max_depth` (recommend 10–15 for most schemas)
- `max_aliases` (recommend 30; sensitive mutations should be 1–2)
- `max_root_fields` (recommend 10)
- `max_height` (alternative tree-size cap)

Query complexity (cost analysis) is the catch-all: each field carries a cost, the total cost of a query is calculated, queries exceeding the cost budget are rejected. Recommend cost budgets per role (anonymous: 100, authenticated: 1000, admin: 10000).

### 3. Alias-based brute-force on auth mutations is the canonical OWASP API #8 attack
PortSwigger's GraphQL research and OWASP API #8 ("Lack of Protection from Automated Threats") document the same attack pattern:
```graphql
mutation {
  a: login(email: "x@y.com", password: "guess1") { token }
  b: login(email: "x@y.com", password: "guess2") { token }
  c: login(email: "x@y.com", password: "guess3") { token }
  ...
}
```
A single request executes 1000 password guesses against the same account. Per-IP rate limiting at nginx counts this as ONE request and lets it through. The mitigation is **per-mutation alias limit**: login, refresh, password reset, MFA verify must allow `max_aliases: 1` (or 2 for explicit retry semantics). This is NOT optional — it is the only effective mitigation.

### 4. Field-level authorization MUST reject the entire query, not return null
A common mistake: returning `null` for unauthorized fields. This:
1. Leaks the existence of the field (and indirectly the resource).
2. Allows enumeration via differential responses.
3. Violates ASVS V8 — partial authorization is broken authorization.

The correct behavior: when a query requests a field the principal is not authorized for, **reject the entire query** with an authorization error. Apollo's `@auth` directive and graphql-shield middleware both support this. Never return masked nulls.

### 5. Persisted query safelisting is the enterprise-grade DoS mitigation
Apollo's Persisted Queries feature lets the server pre-register every query the client sends, then reject any query whose hash is not in the safelist. Effects:
- Arbitrary query construction by attackers becomes impossible — they can only send queries the dev team has registered.
- Operation limits (depth, complexity, alias) become belt-and-suspenders.
- Cache hit rates improve (queries are deduplicated).

For internal-only or B2B SaaS, persisted queries are the preferred default. For public-facing playgrounds, operation limits remain mandatory.

### 6. CSRF protection on GraphQL — POST does NOT save you
The GraphQL specification allows GET for queries (with `query` as a URL param), and many clients use it for caching. GET requests are CSRF-vulnerable. Even POST is CSRF-vulnerable when `Content-Type: application/x-www-form-urlencoded` or `text/plain` is accepted (no preflight). Apollo Router's CSRF prevention enforces:
- Reject GET unless an explicit safe header is present.
- Require `Content-Type: application/json` or a non-standard header (which forces preflight).

Failing this = CSRF on every mutation = CRITICAL.

### 7. Field-level resolvers must enforce auth on the FORWARDED identity, not the network position
In federation, subgraphs receive identity via headers forwarded from the router. Two failure modes:
- **Trusting the header without verification:** any pod that can reach the subgraph (lateral movement) forges the header. Mitigation: HMAC-sign the forwarded identity, verify signature in subgraph.
- **Trusting the network position:** "subgraph is on internal network so any caller is trusted." Wrong — internal network compromise = full subgraph access. Mitigation: subgraphs MUST authenticate every caller, even internal ones.

### 8. Error messages MUST NOT echo internal context
GraphQL error responses include a `message`, `locations`, and `extensions` block. Default Apollo behavior in development surfaces stack traces, schema paths, and SQL fragments via `extensions.exception`. In production:
- Strip `extensions.exception` (Apollo `formatError` callback).
- Replace internal error messages with opaque IDs (`ERR_2024_xxxx`); log the detail server-side keyed on the ID.
- Never include schema names, table names, or hostnames in client-facing errors.

## Security Concerns

- **Introspection enabled at any subgraph in production = HIGH** — schema leak even if router blocks it.
- **Missing `max_aliases` on auth mutations = CRITICAL** — direct brute-force amplification of password guessing, MFA brute-force, and reset token guessing.
- **Field-level auth returning null instead of rejecting query = HIGH** — IDOR leak, ASVS V8 violation.
- **Missing query complexity limit = HIGH** — DoS via expensive resolver chains.
- **Missing depth limit = HIGH** — DoS via deeply nested queries.
- **Subgraph trusting forwarded identity header without HMAC verification = CRITICAL** — privilege escalation via header forgery.
- **GET enabled on mutation endpoint = CRITICAL** — CSRF on every mutation.
- **Stack traces in `extensions.exception` in production = MEDIUM** — information disclosure.
- **Missing persisted query safelist on B2B-only client surfaces = MEDIUM** — opportunistic mitigation, not strictly required if operation limits are tight.

## Performance Concerns

- Query complexity calculation that walks the entire AST per request adds CPU cost; cache the result per persisted query hash.
- DataLoader cache scoped to a request — sharing across requests = cross-tenant data leak (CRITICAL).
- N+1 in `__resolveReference` without DataLoader = HIGH (every federated entity lookup becomes O(N) DB queries).
- Field-level auth implemented as N policy lookups per query — collapse via request-scoped policy cache.

## Architectural Implications for security-reviewer

When reviewing GraphQL changes (router config, subgraph schema, resolver code), the agent MUST verify:
1. Introspection disabled in production at router AND every subgraph.
2. `max_depth`, `max_aliases`, `max_root_fields` set at router AND replicated at subgraph for defense in depth.
3. Auth mutations (login, refresh, password reset, MFA verify) have `max_aliases: 1` or 2.
4. Query complexity / cost analysis enabled with per-role budgets.
5. Field-level authorization rejects the entire query on unauthorized fields, never returns null.
6. Forwarded identity headers from router are HMAC-signed AND verified at subgraph.
7. CSRF prevention enabled on Apollo Router (reject GET, require preflight-forcing Content-Type).
8. Error responses sanitized in production (no `extensions.exception`, opaque error IDs).
9. DataLoader is request-scoped (`Scope.REQUEST`) on every nested resolver and `__resolveReference`.
10. Persisted queries enabled where client surface allows it.

## Domain Rule Additions for security-reviewer

- GraphQL introspection in production at router OR ANY subgraph = HIGH. Disable BOTH.
- Missing `max_aliases` cap on login/refresh/reset/MFA mutations = CRITICAL (alias-based brute-force).
- Missing `max_depth` OR `max_root_fields` OR query complexity limit at router = HIGH (DoS).
- Field-level authorization returning null instead of rejecting the whole query = HIGH (ASVS V8.2 violation).
- Subgraph trusting forwarded identity without HMAC verification = CRITICAL (privilege escalation).
- GET method allowed on mutation endpoints = CRITICAL (CSRF).
- Stack traces / SQL fragments / schema paths in production GraphQL error responses = MEDIUM (info disclosure).
- DataLoader instances NOT request-scoped on tenant data = CRITICAL (cross-tenant cache leak).
- Auth mutations without per-account rate limiting (in addition to per-IP) = HIGH (NAT-shared IP bypass).
- Persisted query safelisting recommended for B2B-only surfaces; absence is MEDIUM unless operation limits are very tight.
