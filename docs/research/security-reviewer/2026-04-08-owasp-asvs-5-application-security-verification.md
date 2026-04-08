# Research: OWASP ASVS 5.0 — Application Security Verification Standard

**Topic:** ASVS L1/L2/L3 levels, verification requirements per category, what an auditor must check, test plan template
**Date:** 2026-04-08
**Agent:** security-reviewer

## Sources

- [OWASP ASVS 5.0 (Final)](https://owasp.org/www-project-application-security-verification-standard/)
- [OWASP ASVS GitHub — 5.0.0](https://github.com/OWASP/ASVS/tree/master/5.0/en)
- [OWASP ASVS Table of Contents](https://owasp.org/www-project-application-security-verification-standard/v5_0_0/en/0x01-Frontispiece)
- [OWASP Top 10 2025 (Release Candidate)](https://owasp.org/Top10/)
- [OWASP API Security Top 10 (2023)](https://owasp.org/API-Security/editions/2023/en/0x00-header/)
- [OWASP Testing Guide v4.2](https://owasp.org/www-project-web-security-testing-guide/v42/)
- [OWASP SAMM v2 — Verification](https://owaspsamm.org/model/verification/)
- [NIST SP 800-53 Rev 5 — Control Catalog](https://csrc.nist.gov/pubs/sp/800/53/r5/upd1/final)
- [NIST SP 800-218 — Secure Software Development Framework (SSDF)](https://csrc.nist.gov/pubs/sp/800/218/final)
- [PCI DSS v4.0 Requirements (cross-reference)](https://www.pcisecuritystandards.org/document_library/)
- [CWE/SANS Top 25 Most Dangerous Software Weaknesses (2024)](https://cwe.mitre.org/top25/)

## Key Findings

### 1. ASVS levels are cumulative — L3 includes everything in L1 and L2
- **L1 (Opportunistic):** Defenses against opportunistic attackers using common, low-effort techniques. Suitable for applications with no sensitive data — almost no SaaS qualifies for L1 only.
- **L2 (Standard):** Defenses against most application risks, suitable for applications handling significant business-to-business or business-to-consumer data. **This is the floor for any commercial SaaS.** Aqua-saas with multi-tenant data, edge SCADA control, GDPR/IEC 62443 obligations belongs in L2 minimum, with L3 controls for the impersonation, MFA, and edge-control surfaces.
- **L3 (Advanced):** Defenses for applications that process highly sensitive data or are critical to safety. Adds deeper crypto, formal review, threat modeling proof, and more aggressive abuse-case testing. Mandatory for SCADA write paths in IEC 62443 SL3+ deployments.

### 2. ASVS 5.0 reorganized chapters — old V1-V14 numbers are NOT compatible with 4.x
ASVS 5 chapters (final structure):
- V1 — Encoding and Sanitization (output encoding, SQLi prevention)
- V2 — Validation and Business Logic (input validation, business workflow)
- V3 — Web Frontend Security (CSP, frame, COOP/COEP/CORP, Trusted Types)
- V4 — API and Web Service (REST/GraphQL/gRPC requirements)
- V5 — File Handling
- V6 — Authentication
- V7 — Session Management
- V8 — Authorization
- V9 — Self-contained Tokens (JWT, PASETO)
- V10 — OAuth and OIDC
- V11 — Cryptography
- V12 — Secure Communication (TLS)
- V13 — Configuration
- V14 — Data Protection
- V15 — Secure Coding and Architecture
- V16 — Security Logging and Error Handling
- V17 — WebRTC

A reviewer using ASVS 4.x mentally must explicitly remap — the chapter numbers shifted.

### 3. V4 (API and Web Service) is the most relevant chapter for federated GraphQL platforms
ASVS V4 explicit GraphQL requirements:
- **V4.3.1** GraphQL queries MUST be limited by max depth, max complexity, and max alias count to prevent DoS.
- **V4.3.2** GraphQL introspection MUST be disabled in production (or restricted to authenticated/authorized requests).
- **V4.3.3** Field-level authorization MUST be enforced (a query returning a field the user is not authorized for must reject the entire query, not return null).
- **V4.1.x** REST APIs MUST validate Content-Type, reject unexpected verbs, and use strict input schemas.
- **V4.2.x** APIs MUST not accept user-supplied IDs without object-level authorization checks (IDOR).

### 4. V8 (Authorization) requires per-resource and per-field checks — not just per-endpoint
ASVS V8 reframes authorization away from "guard the route" toward "guard the resource":
- **V8.1.1** Authorization MUST be enforced at the trusted server side, not in the client.
- **V8.1.2** Authorization MUST use a centralized, well-tested mechanism (no ad-hoc role checks scattered across controllers).
- **V8.2.x** Object-level authorization MUST verify the requested resource belongs to the requesting principal OR the principal has a role granting access. This is the IDOR mitigation requirement.
- **V8.3.x** Function-level authorization MUST verify the principal's role allows the called function (RBAC).
- **V8.4.x** ABAC (attribute-based) controls MUST be evaluated server-side; client-supplied attributes are inputs only, not authorization decisions.

### 5. V9 (Self-contained Tokens) hardens JWT against the entire 2015–2024 vulnerability backlog
ASVS V9 + RFC 8725 (JWT BCP) requirements:
- **V9.1.1** JWT algorithm MUST be explicitly checked; `alg: none` and unexpected algorithms MUST be rejected.
- **V9.1.2** Symmetric (HS*) and asymmetric (RS*/ES*) algorithm confusion MUST be prevented (verifier rejects HS-signed tokens when expecting RS).
- **V9.2.1** All tokens MUST have explicit `iss`, `aud`, `exp`, `nbf`, `iat`, `jti` claims. Verifier MUST validate every one.
- **V9.2.2** Tokens MUST carry a `type` discriminator (access / refresh / mfa-step-up / impersonation). Verifier MUST reject mismatched types — a refresh token used as a bearer access token MUST fail.
- **V9.3.1** Token revocation MUST be supported (blacklist OR short TTL with refresh rotation).
- **V9.4.1** Sensitive claims MUST NOT be placed in the payload of unencrypted JWS — use JWE if confidentiality is required.

### 6. V11 (Cryptography) bans deprecated primitives outright
ASVS V11 final list:
- **V11.1** Random: `crypto.randomBytes()` (Node) / `secrets` (Python) / `/dev/urandom`. **`Math.random()` BANNED for any security-sensitive purpose.**
- **V11.2** Hashing: SHA-256/384/512, BLAKE2/3. MD5, SHA-1, SHA-3 (situational) — never for security uses.
- **V11.3** Password hashing: Argon2id (preferred), scrypt, bcrypt (cost ≥ 10). PBKDF2 only with high iteration count and SHA-256+. **MD5/SHA1 password hashes = CRITICAL.**
- **V11.4** Symmetric: AES-256-GCM (preferred), ChaCha20-Poly1305. **AES-CBC without HMAC, RC4, 3DES = BANNED.**
- **V11.5** Asymmetric: RSA ≥ 2048 (3072+ for L3), ECDSA P-256/384, Ed25519. **RSA < 2048 = BANNED.**
- **V11.6** Key management: keys MUST be rotatable, MUST be stored in a KMS or sealed file (never plaintext in env), MUST have explicit lifecycle (issue/rotate/revoke).

### 7. V14 (Data Protection) is where GDPR meets ASVS
ASVS V14 lines up with GDPR Articles 5, 17, 20, 25, 32:
- **V14.1.x** Data classification: every data element MUST have a sensitivity classification (public, internal, confidential, secret). PII = confidential minimum.
- **V14.2.x** PII at rest MUST be encrypted (column-level for sensitive fields, full-disk for everything else).
- **V14.3.x** PII in transit MUST be TLS 1.2+ (TLS 1.3 preferred).
- **V14.4.x** Data minimization: don't store what you don't need. Access logs containing PII MUST have a retention limit.
- **V14.5.x** Right to erasure: erasure paths MUST exist, MUST cascade across services (event-driven), MUST produce a verifiable receipt.

### 8. V16 (Logging and Error Handling) closes the audit trail
ASVS V16 hard requirements:
- **V16.1.1** Security-relevant events (login success/failure, privilege escalation, access denial, MFA challenge, password reset) MUST be logged with timestamp, principal, source IP, action, outcome.
- **V16.1.2** Logs MUST NOT contain sensitive data (passwords, full tokens, full PAN, full SSN). Use field-level redaction.
- **V16.2.1** Logs MUST be tamper-evident (append-only, hash-chained, or shipped to write-once storage).
- **V16.3.1** Errors returned to clients MUST NOT leak stack traces, internal hostnames, SQL fragments, or schema names. Use opaque error IDs and log the detail server-side.

### 9. ASVS testing model — every requirement is verifiable, not aspirational
ASVS is a *verification* standard, meaning each requirement is phrased so an auditor can prove it true or false from artifacts (code, configuration, test results, log samples). A reviewer using ASVS produces a verification report:
- For each requirement: PASS / FAIL / N/A (with justification) / DEFERRED.
- For each FAIL: severity (CRITICAL / HIGH / MEDIUM / LOW), evidence (file:line), remediation.
- The report itself is the audit deliverable.

## Security Concerns

- **ASVS-as-checklist anti-pattern:** treating ASVS as a one-time audit (run once, file the result) misses its value. ASVS must be re-verified per-PR for the affected categories — every code change touches at least one chapter.
- **Skipping V8 because "we have RolesGuard":** RolesGuard alone covers V8.3 (function-level), not V8.2 (object-level). Reviews must explicitly verify object-level authorization on every fetch-by-ID handler.
- **Skipping V9 because "we use a JWT library":** JWT libraries with default settings frequently fail V9.1 (algorithm confusion) and V9.2 (missing claim validation). Every issuer/verifier pair must be reviewed against ASVS V9 line by line.
- **V14 erasure paths assumed but not tested:** GDPR right-to-erasure failures are CRITICAL findings under ASVS V14.5. The reviewer must demand a working test that proves erasure cascades.
- **V16 redaction assumed but not enforced:** logging code that *intends* to redact PII but is bypassed by a `JSON.stringify(user)` call is the most common V16.1.2 failure. Redaction must be tested by emitting a known PII-bearing object and grepping the log output.
- **Mixing ASVS levels per service:** an L3 SCADA write path that runs through an L1 logging service inherits L1's weakness. ASVS level applies to the data flow, not the service.

## Performance Concerns

- ASVS verification runs that load every audit row to check the hash chain are O(N) and unbounded; chain verification must be incremental (verify on append, sample on read).
- ASVS V4.3.1 query complexity calculation is itself a CPU cost — naive implementations can become a DoS vector if not bounded.
- Field-level authorization (ASVS V8) implemented as N database lookups per field becomes the next N+1 problem; cache decisions per request via a request-scoped permission store.

## Architectural Implications for security-reviewer

The agent MUST treat ASVS 5.0 L2 as the floor for all aqua-saas reviews and L3 for: SCADA write paths, impersonation, MFA, KMS interactions, edge agent provisioning. For each PR:
1. Identify which ASVS chapters the change touches (most changes touch V2, V4, V8, V16 minimum).
2. For each touched chapter, list every L2 requirement and verify PASS/FAIL with evidence.
3. For changes touching SCADA, impersonation, MFA: include L3 requirements as well.
4. Output the verification table in the audit report.
5. Reject as INCOMPLETE any review that did not enumerate the touched chapters.

## Domain Rule Additions for security-reviewer

- ASVS 5.0 Level 2 is the FLOOR for every aqua-saas review. Level 3 is mandatory for SCADA writes, impersonation, MFA, and KMS interactions.
- Every audit report MUST include an explicit ASVS verification table listing requirements PASS/FAIL/N/A with file:line evidence for each FAIL.
- ASVS V4.3.1 (GraphQL depth/complexity/alias limits) MUST be verified at both router and subgraph. Missing either = HIGH.
- ASVS V8.2 (object-level authorization) MUST be verified on every fetch-by-ID handler. RolesGuard alone does NOT satisfy V8.2.
- ASVS V9.2.2 (token type discriminator) MUST be enforced — refresh/MFA tokens used as bearer access tokens = CRITICAL.
- ASVS V11.3 — password hashing weaker than bcrypt cost 10 / Argon2id default = CRITICAL.
- ASVS V14.5 — right-to-erasure paths MUST have a passing integration test. Untested erasure = HIGH.
- ASVS V16.1.2 — logged PII (unmasked email/phone/name) = HIGH (GDPR breach risk). Verified by sampling actual log output, not by code inspection alone.
- ASVS chapter remap (4.x → 5.0) MUST be respected — citing ASVS V2 from 4.x against V2 from 5.0 is incorrect. Use 5.0 numbering.
