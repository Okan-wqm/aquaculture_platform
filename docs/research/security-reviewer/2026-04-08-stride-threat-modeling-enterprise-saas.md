# Research: STRIDE Threat Modeling for Enterprise Multi-Tenant SaaS

**Topic:** STRIDE categories applied to multi-tenant SaaS, per-component threat catalog, mitigation checklist for each threat class
**Date:** 2026-04-08
**Agent:** security-reviewer

## Sources

- [Microsoft Threat Modeling Tool — STRIDE](https://learn.microsoft.com/en-us/azure/security/develop/threat-modeling-tool-threats)
- [OWASP Threat Modeling Process](https://owasp.org/www-community/Threat_Modeling_Process)
- [OWASP Application Threat Modeling Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Threat_Modeling_Cheat_Sheet.html)
- [NIST SP 800-154 — Guide to Data-Centric System Threat Modeling (Draft)](https://csrc.nist.gov/pubs/sp/800/154/ipd)
- [NIST SP 800-53 Rev 5 — Security and Privacy Controls](https://csrc.nist.gov/pubs/sp/800/53/r5/upd1/final)
- [MITRE ATT&CK Enterprise Matrix](https://attack.mitre.org/matrices/enterprise/)
- [MITRE ATT&CK for Cloud (IaaS / SaaS)](https://attack.mitre.org/matrices/enterprise/cloud/)
- [SANS Top 25 Software Errors (CWE)](https://www.sans.org/top25-software-errors/)
- [OWASP SAMM v2 — Threat Assessment](https://owaspsamm.org/model/design/threat-assessment/)
- [Microsoft SDL — Threat Modeling Practice](https://www.microsoft.com/en-us/securityengineering/sdl/practices/threat-modeling)
- [NCSC — Threat Modelling Guidance](https://www.ncsc.gov.uk/collection/risk-management/threat-modelling)
- [Shostack, Adam — Threat Modeling: Designing for Security (reference)](https://shostack.org/books/threat-modeling-book)

## Key Findings

### 1. STRIDE-per-element is the only useful granularity in microservice SaaS
Microsoft SDL and Adam Shostack converge: applying STRIDE at the *system* level produces a useless wall of text. STRIDE must be applied per data-flow-diagram (DFD) element: external entity, process, data store, data flow, trust boundary. In a federated SaaS like aqua-saas, the trust boundaries are: (a) browser/MFE -> nginx, (b) nginx -> Apollo router, (c) router -> subgraph, (d) subgraph -> service, (e) service -> NATS / Postgres / Redis, (f) edge agent -> ingress, (g) SUPER_ADMIN impersonation context. Each crossing demands its own STRIDE pass.

### 2. Spoofing is the dominant threat at trust-boundary crossings
Microsoft's STRIDE-per-element table maps Spoofing onto every external entity AND every process. In a federated GraphQL stack:
- Subgraphs trust the router (forwarded identity headers). If headers can be forged from the public internet (subgraph publicly reachable), spoofing -> total bypass.
- Service-to-service NATS publishes trust the publishing service. Without HMAC-signed `X-Service-Identity` (rotating timestamp + signature), any pod that joins the cluster can impersonate any service.
- Edge agents authenticate via long-lived device certificates. Without OCSP / short-lived certs, a stolen edge cert is equivalent to a permanent service identity.

Mitigation discipline: every cross-boundary call MUST be authenticated AND the receiving side MUST re-verify, never trust forwarded identity blindly. This is the federation equivalent of the OWASP "do not trust network position" rule.

### 3. Tampering at the data-store layer is catastrophic in multi-tenant DBs
NIST SP 800-154 stresses data-centric modeling: tampering with the schema (DDL injection, search_path poisoning) is far more damaging than tampering with a single row. Multi-tenant Postgres with `search_path` schema isolation has a unique tampering surface: an attacker who can flip the connection's `search_path` for the duration of one query reads/writes another tenant's tables. Mitigations:
- Bind every TypeORM connection to an explicit `search_path` *and* re-assert it before every query (the platform's recent farm-service migration runner fix is exactly this pattern).
- Enable Postgres Row-Level Security (RLS) as defense-in-depth even when search_path is correct, so a code path that forgets to set search_path still cannot leak across tenants.
- Database migrations MUST be the only writes that change schema; runtime DDL = CRITICAL.

### 4. Repudiation is solved by append-only audit logs with cryptographic chaining
NIST SP 800-53 control AU-9 (Protection of Audit Information) and AU-10 (Non-Repudiation) require that audit records be tamper-evident. The minimum viable design:
- Audit table is append-only (no UPDATE, no DELETE) enforced by Postgres triggers AND application-level write guards.
- Each audit row carries a hash of (previous_row_hash + this_row_payload), forming a hash chain. A single deletion or modification breaks the chain and is detectable.
- Audit writes happen on a privileged code path that user-reachable code cannot invoke directly with attacker-controlled payloads.
- Audit forwarder ships rows to a separate write-once storage (S3 with Object Lock, Cloudflare R2 with retention lock, or equivalent).

### 5. Information Disclosure has FIVE distinct surfaces in SaaS
Per Microsoft STRIDE-per-element and OWASP A01 + A02 + A09:
1. **Cross-tenant** — wrong tenant_id, missing TenantGuard, missing search_path. CRITICAL always.
2. **Cross-user within tenant** — IDOR, missing object-level authorization on `/orders/:id`. HIGH-CRITICAL.
3. **Error-based** — stack trace in production response, raw SQL error message echoing schema names. MEDIUM-HIGH.
4. **Logging-based** — PII (email, phone, name) written to logs without masking. HIGH (GDPR breach).
5. **Side-channel** — timing differences in login responses (account enumeration), error message variants ("invalid email" vs "invalid password"). MEDIUM-HIGH.

A complete review must hit all five — focusing only on (1) and (2) leaves three classes uncovered.

### 6. Denial of Service must be modeled at the resource that runs out, not at the endpoint
Microsoft and Cloudflare both push back on the naive "rate-limit the endpoint" approach. The right question is: *what resource exhausts first under attack?* In aqua-saas:
- **CPU** — GraphQL query complexity, regex catastrophic backtracking, JSON parser DoS. Mitigate with cost limits, regex hardening (no user-controlled regexes), parser hardening.
- **Memory** — unbounded list resolvers, missing pagination, large file uploads without streaming. Mitigate with mandatory pagination (max page size), streaming uploads with byte caps, max payload size at nginx.
- **Connections** — Slowloris, HTTP/2 RST flood, connection holding. Mitigate at nginx (timeouts) and at Apollo (request timeout middleware).
- **Database** — N+1 from federated subgraphs, unbounded queries, lock contention. Mitigate with DataLoader, statement timeouts, idle-in-transaction timeouts.
- **Outbound rate limits** — SMS / email providers, third-party APIs. An attacker triggering password reset spam can drain the SMS quota and cause a financial DoS. Mitigate with per-account rate limits.

### 7. Elevation of Privilege has horizontal AND vertical axes — both must be modeled
- **Horizontal:** user A reads user B's data within the same tenant. Mitigated by object-level authorization (every fetch checks `resource.userId === currentUserId` OR explicit role permission).
- **Vertical:** MODULE_USER becomes TENANT_ADMIN. Mitigated by role normalization in JWT issuance, no client-controlled role claims, RolesGuard hierarchy enforcement on every guard-decorated route.
- **Tenant elevation:** TENANT_ADMIN of tenant X gains access to tenant Y. Catastrophic. Mitigated by JWT-bound tenantId (never from header/body), MFA step-up for impersonation, dual-identity audit logs.

A common platform mistake: enforcing only vertical EoP (RolesGuard) and forgetting horizontal (no object-level auth on `/users/:id`). Both MUST be present.

## Security Concerns

- **Trust boundary not explicitly enumerated in code** — if the team cannot point to a single file that lists every trust boundary, threat modeling is informal and reviews will miss boundary crossings. Recommend: a `docs/architecture/trust-boundaries.md` listing every boundary, the auth mechanism that protects it, and the failure mode if bypassed.
- **STRIDE per element not run during PR review** — STRIDE is the *prevention* phase; without it, every PR is a re-discovery exercise. Reviews must include a 6-question STRIDE checklist as the first step, not the last.
- **No abuse cases in the spec** — feature specs that describe only happy paths cannot be reviewed for security. Every spec must include "abuse cases" (what an attacker would try to do with this feature).
- **Threat models that don't update with code** — a threat model that lives in a wiki and is updated quarterly is no model at all. Threat models must live next to the code they describe (per-bounded-context `THREAT-MODEL.md`).
- **Implicit cross-service trust** — if any service trusts another service's input without verification because "they're both internal", a single compromised service becomes a tenant-wide breach.
- **No "what if upstream is malicious" thinking** — each subgraph must assume the router is compromised. Each service must assume the calling service is compromised. Defense in depth requires this assumption at every layer.

## Performance Concerns

- DoS modeling at endpoint granularity misses cross-endpoint resource contention (one endpoint exhausts a connection pool used by another).
- Threat models that don't identify hot paths (login, token refresh, GraphQL `me` query) miss the highest-blast-radius surfaces.
- Rate limiting modeled per-IP fails behind shared NAT (mobile carriers, university networks); per-account rate limits are mandatory for auth flows.

## Architectural Implications for security-reviewer

When reviewing ANY change to aqua-saas, the agent MUST:
1. Identify which trust boundaries the change crosses (or creates).
2. Run STRIDE-per-element on each new or modified DFD element.
3. Confirm Spoofing is mitigated at every cross-boundary call (HMAC, mTLS, signed JWT).
4. Confirm Tampering is mitigated at every data store (RLS, search_path discipline, write guards).
5. Confirm Repudiation is mitigated for every state-changing operation (audit log row).
6. Confirm Information Disclosure is mitigated across all FIVE surfaces (cross-tenant, IDOR, error, log, timing).
7. Confirm Denial of Service is modeled at the *resource that runs out*, not at the endpoint.
8. Confirm Elevation of Privilege is mitigated on both horizontal and vertical axes.
9. Reject any feature spec that does not include explicit abuse cases.
10. Demand a `docs/architecture/trust-boundaries.md` update if a new trust boundary is introduced.

## Domain Rule Additions for security-reviewer

- Pre-Review STRIDE MUST be applied per DFD element, not at the system level. A single STRIDE table covering the whole change is insufficient.
- Every change that crosses a trust boundary MUST identify the boundary explicitly and the auth mechanism that protects it. If neither exists, the finding is CRITICAL.
- "Internal service trusts internal service" is NEVER an acceptable threat model. Every service MUST authenticate every caller, regardless of network position.
- Information Disclosure MUST be checked across five surfaces (cross-tenant, IDOR, error response, logs, timing). Reviewing only cross-tenant is incomplete.
- DoS findings MUST identify the exhausted resource (CPU, memory, connections, DB, outbound API) — not just "no rate limit".
- Elevation of Privilege MUST be checked on both horizontal (object-level auth) and vertical (role hierarchy) axes. Either missing = HIGH.
- Feature specifications that lack abuse cases MUST be rejected; the agent recommends abuse cases be added before merge.
- Any new trust boundary MUST be reflected in `docs/architecture/trust-boundaries.md` as part of the same PR; otherwise the finding is HIGH (architectural drift).
- Audit logs MUST be append-only, hash-chained, and forwarded to write-once storage. Missing any of these = HIGH.
