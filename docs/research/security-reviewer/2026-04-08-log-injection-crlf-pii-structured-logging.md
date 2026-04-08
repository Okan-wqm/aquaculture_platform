# Research: Log Injection, CRLF, PII, Structured Logging Discipline

**Topic:** CRLF injection in logs, structured logging discipline, PII masking via SENSITIVE_FIELDS, audit log append-only, log forwarder validation
**Date:** 2026-04-08
**Agent:** security-reviewer

## Sources

- [OWASP Top 10 — A09:2021 Security Logging and Monitoring Failures](https://owasp.org/Top10/A09_2021-Security_Logging_and_Monitoring_Failures/)
- [OWASP Cheat Sheet — Logging](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)
- [OWASP Cheat Sheet — Logging Vocabulary](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Vocabulary_Cheat_Sheet.html)
- [OWASP ASVS 5.0 — V16 Security Logging and Error Handling](https://github.com/OWASP/ASVS/tree/master/5.0/en)
- [NIST SP 800-92 — Guide to Computer Security Log Management](https://csrc.nist.gov/pubs/sp/800/92/final)
- [NIST SP 800-53 Rev 5 — AU family (Audit and Accountability)](https://csrc.nist.gov/pubs/sp/800/53/r5/upd1/final)
- [CWE-117 — Improper Output Neutralization for Logs](https://cwe.mitre.org/data/definitions/117.html)
- [CWE-93 — CRLF Injection](https://cwe.mitre.org/data/definitions/93.html)
- [CWE-532 — Insertion of Sensitive Information into Log File](https://cwe.mitre.org/data/definitions/532.html)
- [GDPR Article 5 — Principles relating to processing of personal data](https://gdpr-info.eu/art-5-gdpr/)
- [GDPR Article 32 — Security of processing](https://gdpr-info.eu/art-32-gdpr/)
- [PCI DSS v4.0 — Requirement 10 (Log and Monitor)](https://www.pcisecuritystandards.org/document_library/)
- [Mozilla — Logging Standard](https://infosec.mozilla.org/guidelines/iam/openssh.html)
- [PortSwigger — Log Injection](https://portswigger.net/kb/issues/00800200_loginjection)
- [Elastic Common Schema (ECS)](https://www.elastic.co/guide/en/ecs/current/index.html)

## Key Findings

### 1. CRLF injection in logs is the gateway to log forgery
CWE-117 / CWE-93: when user-controlled input is concatenated into a log line without sanitization, an attacker can inject `\r\n` to forge log entries:
```
Logger.log(`Failed login: ${username}`);
// attacker sets username = "alice\nINFO User admin logged in successfully"
// log file gains a fake "User admin logged in" entry
```
This poisons audit trails, creates false positives, and can be used to mask real attacks. Mitigations:
- **Structured (JSON) logging eliminates the class** — fields are encoded as JSON values, `\n` becomes `\\n` automatically.
- **Sanitize string concatenation if any** — replace `\r`, `\n`, control chars with `\\r`, `\\n`, `\\xXX` before logging.
- **NEVER use string concatenation in log calls** — `Logger.log(\`x: ${y}\`)` is the antipattern. Use the structured form: `Logger.log({ msg: 'x', y })`.

### 2. PII in logs is a GDPR violation, not just a "best practice" issue
GDPR Article 5(1)(c) (data minimization) and Article 32 (security of processing) make logging PII without justification a regulatory violation. Specific PII categories:
- **Direct identifiers:** name, email, phone, full address, government ID, IP address (in EU jurisprudence).
- **Indirect identifiers:** IBAN partial, license plate, date of birth, employee ID combined with department.
- **Special categories (Article 9):** health data, biometric, genetic, ethnicity, political opinion, sexual orientation — these are CRITICAL if logged at all.
- **Authentication secrets:** passwords, tokens, MFA codes, session IDs — never logged in any form, even hashed.

Mitigation pattern:
- **`SENSITIVE_FIELDS` allowlist of field names** that the logger automatically masks (`password`, `token`, `email`, `phone`, `ssn`, `mfa_code`, `refresh_token`, `recovery_code`, `iban`, `card_number`, `cvv`).
- **Field-level redaction** — the logger sees the field name and masks the value (`***` for partial reveal, full hash for correlation, complete removal for high-sensitivity).
- **Hash with salt for correlation** — if you need to correlate "the same user across log lines" without revealing identity, use HMAC-SHA256(field_value, per-deployment-salt) — deterministic but irreversible.
- **PII redaction is enforced at the logger level**, not at the call site. Call sites cannot opt out.

### 3. Structured logging is non-negotiable in microservice SaaS
NIST SP 800-92 + Elastic Common Schema (ECS) + cloud-native observability practice agree:
- **Logs MUST be JSON** (or another structured format like logfmt) — every line parses into key-value pairs.
- **Required ECS fields per log line:**
  - `@timestamp` (ISO 8601 with timezone)
  - `log.level` (debug, info, warn, error, critical)
  - `service.name` (which microservice)
  - `service.version` (build SHA or semver)
  - `trace.id` (OpenTelemetry trace ID for cross-service correlation)
  - `span.id`
  - `host.name` (pod / instance ID)
  - `event.category` (authentication, authorization, network, web, etc.)
  - `event.outcome` (success, failure)
  - `user.id` (hashed if PII)
  - `tenant.id`
  - `client.ip`
  - `http.request.method`, `url.path`, `http.response.status_code`
- **Message field** is human-readable, but structured fields are the source of truth — never put structured data only in the message string.

### 4. Audit logs are a separate concern from application logs
Application logs are diagnostic; audit logs are forensic. They MUST be separate streams with different retention, different access controls, different write paths.

NIST SP 800-53 AU controls:
- **AU-2:** Define what events are audited. For SaaS: login success/failure, MFA challenge, privilege escalation, role change, tenant context switch, password change, recovery action, data export, data deletion, security setting change.
- **AU-3:** Each audit record contains who, what, when, where, source.
- **AU-4:** Audit storage capacity managed (no rolling drop of audit data).
- **AU-9:** Audit information protected from unauthorized modification (append-only, RBAC-restricted reads).
- **AU-10:** Non-repudiation (audit row cannot be denied — hash chain or signature).
- **AU-12:** Audit generation at every relevant security event point.

For aqua-saas: `AuditLogService` is the only path that writes to the audit table. Application code calls `auditLog.record(...)`; the service writes via a privileged DB user with INSERT-only permission. No UPDATE, no DELETE — enforced by Postgres GRANTs AND a write guard at the application layer.

### 5. Audit log tampering is a CRITICAL finding
Tampering scenarios:
- **Direct DB write/delete:** the application user has UPDATE/DELETE on the audit table — REVOKE.
- **Indirect write via SQL injection:** raw SQL on audit table — parameterized only.
- **Log forwarder rewriting in transit:** if the forwarder accepts upstream-controlled fields, they can be used to overwrite legit fields. Forwarder MUST validate field types and reject unexpected keys.
- **Log forwarder buffer flush:** if the buffer is in memory and the pod crashes, audit rows are lost — use durable queue (NATS JetStream, Kafka, append-only file with fsync).
- **Hash chain break:** if any audit row is modified, the hash chain breaks at the next read. The reader MUST verify chain integrity AND alert on break.
- **Time skew:** audit rows with future timestamps or timestamps that go backwards — log forwarder MUST validate timestamps within a tolerance window.

### 6. Log forwarder validation — the most-overlooked attack surface
The pipeline `app -> log forwarder -> aggregator -> SIEM` is end-to-end trusted in most deployments. Each hop is a forgery surface:
- **App to forwarder:** if the forwarder runs as a sidecar reading from a shared volume / unix socket, anything that can write to that path can forge. Permissions must restrict to the app user.
- **Forwarder to aggregator:** if the connection is plain TCP (no TLS), any network actor can inject. Use TLS with client cert auth.
- **Aggregator to SIEM:** same — TLS, mutual auth.
- **SIEM normalization:** if the SIEM normalizes timestamps using log content (instead of receipt time) and the content is forged, the forgery wins. SIEM MUST capture both timestamps.

### 7. Sensitive event logging — the OWASP "must-log" list
OWASP Logging Cheat Sheet's mandatory event list:
- Authentication success and failure
- Authorization failure
- Application errors (exceptions, validation failures)
- Application and system startup, shutdown, and restart
- Higher-risk function use (data export, account deletion, role grant)
- Legal and other opt-ins (cookie acceptance, ToS acceptance)
- Session lifecycle (creation, expiration, revocation)
- Transaction integrity events (audit-relevant business operations)

Each MUST include: `event.outcome`, principal, source IP, user agent, requested resource, decision reason.

### 8. Logging level discipline — `debug` is NOT free in production
- `DEBUG` in production is a HIGH finding if it logs request bodies, query parameters, or response bodies — these inevitably contain PII / secrets.
- `INFO` is the right level for security events (login, auth decisions).
- `WARN` for recoverable security events (rate limit hit, partial auth failure).
- `ERROR` for unrecoverable security events.
- `CRITICAL` reserved for security alarms (cross-tenant access detected, audit chain break, KMS unreachable).

The platform's `Logger` MUST enforce a maximum verbosity level in production via config (`LOG_LEVEL=info` or higher).

## Security Concerns

- **String concatenation in log calls (`Logger.log(\`x: ${y}\`)`) = HIGH** (CRLF injection + risk of PII leak).
- **`console.log` instead of structured `Logger` = HIGH** (no field redaction, no structured output).
- **PII fields logged unmasked (email, phone, name, IBAN, card number) = HIGH** (GDPR violation).
- **Authentication secrets (passwords, tokens, MFA codes, session IDs) logged in any form = CRITICAL.**
- **Special category PII (health, biometric, genetic, ethnicity) logged = CRITICAL.**
- **Audit table with UPDATE/DELETE permissions for application user = CRITICAL** (audit tamper).
- **Audit rows missing hash chain or signature = HIGH** (no tamper evidence).
- **Audit log forwarder with TLS-less connection between hops = HIGH.**
- **Log forwarder accepting upstream-controlled fields without validation = HIGH** (forgery).
- **Application logs and audit logs sharing the same retention / access control = HIGH** (forensic blind spot).
- **Required security events not logged (login, auth failure, role change, data export) = HIGH** (ASVS V16.1 violation).
- **Error responses leaking stack traces / SQL fragments / hostnames in production = MEDIUM-HIGH.**
- **`DEBUG` log level in production = HIGH** (PII / secret leak).
- **Audit log retention < 90 days = MEDIUM** (HIGH for regulated workloads).
- **No alert on hash chain break = HIGH.**
- **No alert on log forwarder backpressure / buffer overflow = MEDIUM** (audit data loss).

## Performance Concerns

- Synchronous log writes on the request thread block under load; use buffered async writes with bounded queue.
- JSON serialization at high log volume is CPU-bound; sample debug logs (1% in production), log security events at 100%.
- Hash chain computation per insert is O(1) but adds ~100µs; acceptable.
- Forwarder backpressure must NOT block the application; use a bounded queue with overflow alerting.
- PII field redaction implemented as a regex pass over the entire log line is O(N) per line; field-level redaction at the structured-logger boundary is O(1) per field.

## Architectural Implications for security-reviewer

When reviewing any change touching logging or audit, the agent MUST verify:
1. All log calls use the structured `Logger` (no `console.log`, no string concatenation).
2. PII fields are redacted at the logger boundary via a centralized `SENSITIVE_FIELDS` allowlist; the call site cannot opt out.
3. Authentication secrets are NEVER logged, even hashed.
4. Audit log writes go through `AuditLogService` only; application user has INSERT-only on the audit table; no UPDATE / DELETE.
5. Audit rows include who, what, when, where, source — and an integrity field (hash of previous + this row).
6. Hash chain verification is run on read AND at scheduled intervals; chain breaks alert.
7. Log forwarder hops use TLS with mutual auth; the SIEM captures both content timestamp and receipt timestamp.
8. Required security events (OWASP "must-log" list) are emitted with `event.outcome`, principal, source IP, resource, decision.
9. Error responses to clients are sanitized — opaque error IDs, no stack traces, no SQL, no hostnames.
10. Production `LOG_LEVEL` is `info` or higher; debug is gated.
11. Audit retention is at least 1 year (longer for regulated workloads).

## Domain Rule Additions for security-reviewer

- String concatenation in log calls (`Logger.log(\`...${var}...\`)`) = HIGH (CRLF injection class).
- `console.log` anywhere in production code paths = HIGH (no redaction, no structure).
- PII (email, phone, name, IBAN, card number, full address, gov ID, IP in EU contexts) logged unmasked = HIGH (GDPR breach risk).
- Authentication secrets (passwords, tokens, MFA codes, session IDs) logged in any form = CRITICAL.
- Special-category PII (health, biometric, genetic, ethnicity, political, sexual orientation) logged = CRITICAL.
- Audit table with UPDATE/DELETE GRANTed to application user = CRITICAL.
- Audit rows missing hash chain / signature = HIGH (no tamper evidence).
- Hash chain break detection without alerting = HIGH.
- Audit log forwarder hop without TLS + mutual auth = HIGH.
- Log forwarder accepting upstream-controlled timestamp without bounds check = HIGH.
- Application and audit logs sharing retention / access controls = HIGH (forensic blind spot).
- OWASP "must-log" event missing (login success/failure, MFA, role change, data export, account delete) = HIGH.
- Error response to client leaking stack trace / SQL / hostname / schema name = MEDIUM-HIGH.
- Production `LOG_LEVEL` set to debug or trace = HIGH.
- Audit retention < 90 days = MEDIUM (HIGH for regulated workloads).
- `SENSITIVE_FIELDS` allowlist not enforced at logger boundary (call sites can bypass) = HIGH.
- PII field redaction implemented per-call instead of centrally = HIGH (will be missed on next call site).
