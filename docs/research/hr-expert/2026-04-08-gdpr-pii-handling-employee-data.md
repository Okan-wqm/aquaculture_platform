# Research: GDPR PII Handling for Employee Data

**Topic:** GDPR Articles 15-20 compliance patterns, PII field masking, right-to-erasure cascade, tenant isolation of employee PII
**Date:** 2026-04-08
**Agent:** hr-expert

## Sources
- [Art. 17 GDPR - Right to erasure ('right to be forgotten')](https://gdpr-info.eu/art-17-gdpr/)
- [Art. 15 GDPR - Right of access by the data subject](https://gdpr-info.eu/art-15-gdpr/)
- [Exabeam - What is GDPR Article 17 and 4 Ways to Achieve Compliance](https://www.exabeam.com/explainers/gdpr-compliance/what-is-gdpr-article-17-right-to-erasure-and-4-ways-to-achieve-compliance/)
- [Bird & Bird - The right of access under the GDPR](https://www.twobirds.com/en/hr-data-essentials/international-perspectives/articles/the-right-of-access-under-the-gdpr)
- [OWASP Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)
- [OWASP User Privacy Protection Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/User_Privacy_Protection_Cheat_Sheet.html)
- [AWS - Multi-tenant data isolation with PostgreSQL Row Level Security](https://aws.amazon.com/blogs/database/multi-tenant-data-isolation-with-postgresql-row-level-security/)
- [GDPRhub - Article 15 GDPR](https://gdprhub.eu/Article_15_GDPR)

## Key Findings

1. **Article 15 (Right of Access)** obligates controllers to provide employees, upon request, a free copy of all personal data being processed together with supplementary information (retention period, processing purpose, recipients, source if not collected directly, existence of automated decision-making). First copy must be free; reasonable fee only for additional copies or manifestly excessive requests.
2. **Response window is one calendar month**, extendable by two additional months for complex or numerous requests, but the data subject must be informed of the extension and its reason within the original month.
3. **Identity verification is mandatory** before disclosure (Art. 32), but the controller cannot demand excessive documentation. Access requests delivered electronically must be answered electronically in a commonly used format unless the subject requests otherwise.
4. **Article 17 (Right to Erasure)** requires deletion without undue delay when: data no longer necessary for original purpose, consent withdrawn with no other legal basis, unlawful processing, data subject objects, or legal obligation to erase. Not absolute — exceptions include legal claim defense, freedom of expression, legal obligations, and archiving in the public interest.
5. **Erasure cascade is mandatory across ALL copies** including workstations, backups, archives, cloud storage, search indexes, replicas, and downstream processors. Controllers who have made data public must also notify other controllers processing that data (Art. 17(2)).
6. **Tagging pattern (e.g., `erasure_requested_at`, `erasure_completed_at`) is a recognized compliance approach**, creating a verifiable audit trail of erasure requests that itself survives the deleted PII.
7. **Article 20 (Portability)** requires personal data provided by the subject to be returned in a structured, commonly used, machine-readable format (JSON/CSV) — and directly transmitted to another controller where technically feasible.
8. **OWASP Logging guidance:** Sensitive PII (SSN, health identifiers, government IDs, banking) MUST NOT be written to logs. Non-sensitive PII (names, phone, email) should be masked, scrambled, pseudonymized, or hashed before logging.
9. **OWASP User Privacy Protection:** De-identification applies end-to-end — end devices, intermediates, centralized stores, archives, backups. Privacy must be considered in log forwarders, SIEM pipelines, and error reporters.
10. **PostgreSQL RLS (Row-Level Security)** is the recommended isolation primitive for multi-tenant PII in shared tables. Combined with search_path schema-per-tenant, it is defense-in-depth: schema isolation prevents accidental cross-tenant queries, RLS enforces policy even if search_path is bypassed.

## Security Concerns

- **CRITICAL:** PII written to logs (even transiently via error stacks or command DTOs) constitutes a data breach under GDPR Art. 33 — reportable within 72 hours.
- **CRITICAL:** Cross-tenant employee data leak through a missing WHERE tenant_id clause is reportable as a personal data breach affecting the rights of data subjects.
- **CRITICAL:** Incomplete erasure cascade (row deleted in primary table but surviving in backups, read replicas, search indexes, event streams) is a GDPR Art. 17 violation exposing the controller to up to 4% global annual turnover fines.
- **HIGH:** Event sourcing + GDPR conflict — immutable event streams containing PII cannot comply with erasure without crypto-shredding (per-subject encryption keys that are destroyed on erasure).
- **HIGH:** Missing identity verification on Art. 15 access requests risks disclosing an employee's data to an impersonator.
- **HIGH:** Retention period exceeding stated purpose (over-retention) violates Art. 5(1)(e) storage limitation principle.
- **MEDIUM:** Access request response format not machine-readable for portability (Art. 20) violates the portability right.
- **MEDIUM:** No tenant-scoped `SENSITIVE_FIELDS` list leaves PII classification implicit and fragile.

## Performance Concerns

- Full-table scans for erasure cascade across many related tables must be indexed on `employee_id` (never on decrypted PII values).
- Pseudonymization via HMAC-SHA-256 adds latency proportional to fields processed — batch in one pass rather than per-field.
- RLS policies add a filter to every query — ensure indexes include the tenant_id column as the leading key for selective scans.
- Erasure jobs should run against read replicas snapshot + primary transaction, never block writes for long periods.

## Architectural Implications for hr-expert reviews

- Every Employee entity field must be classified in a tenant-scoped `SENSITIVE_FIELDS` registry with classification (`PUBLIC | INTERNAL | PII | SENSITIVE_PII | SPECIAL_CATEGORY`). Review any new `@Column` on Employee for a classification assignment.
- GraphQL field resolvers returning PII must assert the viewer is (a) the subject themselves, or (b) an authorized HR role bound to the same tenant. `@HideField()` alone is not sufficient because internal resolvers can still surface the field.
- A dedicated `EmployeeErasureCommand` must exist and be the ONLY authorized path to delete employee PII. Direct `DELETE` via repository is forbidden. The command must produce an immutable `EmployeeErased` event that the tombstone records (hashed employee_id, erasure_requested_at, erasure_completed_at) without the original PII.
- An `EmployeeAccessRequestCommand` must exist for Art. 15 and must emit a machine-readable JSON export covering: employee entity, attendance, leave ledger, payroll, performance reviews, training, certifications, rotations, audit log entries — all scoped to a single employee.
- Any service that projects PII into another store (search index, read model, event stream, analytics warehouse) must register an erasure-cascade handler that consumes `EmployeeErased` and removes/pseudonymizes the projection.
- Logs must go through a PII redaction interceptor BEFORE reaching the sink. Redaction must be based on the `SENSITIVE_FIELDS` registry, not string regexes, so new fields are automatically covered.
- NATS events published from HR must not contain raw PII payloads — use employee_id references only.
- Crypto-shredding pattern for event sourcing: encrypt per-employee PII with a key stored in a tenant keyring; erasure destroys the key, rendering archived/streamed events unreadable without touching the event log itself.

## Domain Rule Additions for hr-expert

- **[CRITICAL]** Every Employee entity column containing PII must be classified in `SENSITIVE_FIELDS` (levels: PUBLIC, INTERNAL, PII, SENSITIVE_PII, SPECIAL_CATEGORY). Adding a new PII `@Column` without classification is a blocking review failure.
- **[CRITICAL]** A `EmployeeErasureCommand` handler must be the sole path to delete employee PII; it must produce a tombstone row (hashed_employee_id, erasure_requested_at, erasure_completed_at, requester_id) and cascade to every downstream projection, read model, search index, and event-stream consumer BEFORE committing the tombstone.
- **[CRITICAL]** Cross-tenant access must be enforced by BOTH `search_path` isolation AND an explicit `tenantId` predicate or RLS policy — never one or the other. Removing either layer is a blocking review failure.
- **[CRITICAL]** Employee PII (SSN, bank, salary, medical, disciplinary notes, national ID) MUST NEVER appear in logs or error messages. PII redaction must occur through a typed interceptor reading from `SENSITIVE_FIELDS`, not ad-hoc `replace()` calls.
- **[HIGH]** An `EmployeeAccessRequestCommand` must exist for Art. 15 and must produce a machine-readable JSON export (Art. 20) covering employee + attendance + leave + payroll + performance + training + certifications + rotations within the same tenant scope.
- **[HIGH]** Art. 15 access requests must be served within 1 calendar month (configurable extension up to 2 months with written justification); the deadline must be tracked in a dedicated `data_subject_requests` table with SLA alerts.
- **[HIGH]** Event sourcing of employee PII requires crypto-shredding: PII fields in events must be encrypted with a per-employee key stored in a tenant keyring; erasure destroys the key. Plaintext PII inside `libs/event-contracts/src/hr-events.ts` payloads is forbidden.
- **[HIGH]** GraphQL resolvers returning PII must enforce viewer identity match OR authorized HR role within the same tenant. `@HideField()` alone does not satisfy access control.
- **[MEDIUM]** Backup retention of PII must be capped at the tenant retention policy; erasure jobs must re-run against retained snapshots when their hold expires.
- **[MEDIUM]** Identity verification must precede every Art. 15 response; log the verification method (no log of the credential itself).

Research: `docs/research/hr-expert/2026-04-08-gdpr-pii-handling-employee-data.md`
