# Implementation Plan: Security Hardening Remediation

## Context
Generated: 2026-04-14
Base Commit: 733c231d
Total Packages: 14
CRITICAL: 1 | HIGH: 7 | MEDIUM: 5 | LOW: 1

## Source Reports
- `/var/aqua-saas/docs/security/2026-04-12-hardening-gap-report.md` (primary)
- `/var/aqua-saas/docs/security/2026-04-12-enterprise-security-execution-plan.md`
- `/var/aqua-saas/docs/security/2026-04-12-enterprise-security-uplift-roadmap.md`
- `/var/aqua-saas/docs/security/2026-04-12-enterprise-security-plan-validation.md`
- `/root/.claude/plans/flickering-wibbling-rainbow.md` (merged planning decisions)

## Dropped / Already Resolved
| Original gap | Resolved in commit | Finding ID |
|---|---|---|
| JWT HS256 auth-service guard | `7c076361`, `4e5469ba` | Closed pre-plan |
| Per-service PostgreSQL role creation (init script) | `03e091da` | Closed pre-plan |
| NATS per-service ACL config in `nats.conf` | `4ba2a0c0` | Closed pre-plan |

## Package Index

### Phase 0 — Unbreak Production
- [x] 01-jwt-deployment-contract — distribute RS256 keypair, drop JWT_SECRET from non-auth services [CRITICAL] [security-sensitive] (commit 5b786e7f)

### Phase 1 — Silent-risk reduction
- [x] 02-nats-per-service-credentials — provision per-service NATS users in compose+helm [HIGH] [security-sensitive] (commit d7ecb9d6)
- [x] 03-nats-mtls-enforcement — flip verify:true, distribute client certs [HIGH] [security-sensitive] [blockedBy: 02] (commit a265eeef)
- [x] 04a-internal-http-signing-lib — shared signed-http-client + guard enhancement [HIGH] [security-sensitive] (commit 3ccca098)
- [x] 04b-internal-http-callsite-rollout — migrate every service HTTP caller [HIGH] [security-sensitive] [blockedBy: 04a] (commit 37bfddc1)
- [ ] 05a-rls-session-guc-wiring — tenant-scoped repo sets app.current_tenant_id GUC [HIGH] [security-sensitive]
- [ ] 05b-rls-policies-enable — migration enables RLS on tenant-scoped tables [HIGH] [security-sensitive] [blockedBy: 05a]
- [ ] 06-pii-log-masking-central — central masker lib + audit interceptor integration [HIGH] [security-sensitive]

### Phase 2 — Hygiene & secrets supply chain
- [ ] 07-bootstrap-secrets-adoption — wire bootstrapSecrets() into every main.ts [MEDIUM] [security-sensitive] [blockedBy: 01]
- [ ] 08-cert-manager-internal-issuer — cert-manager Issuer + Certificate CRDs [MEDIUM] [blockedBy: 03]
- [ ] 09-dev-db-per-service-wiring — dev compose per-service roles [MEDIUM]
- [ ] 10-password-pepper-bcrypt — PASSWORD_PEPPER HMAC layer [MEDIUM] [security-sensitive]

### Phase 3 — Policy & tooling
- [ ] 11-secret-leak-prevention — gitleaks pre-commit hook + CI scan [MEDIUM]
- [ ] 12-k8s-pod-security-standards — restricted PSS labels [MEDIUM]
- [ ] 13-structured-json-logging — JSON formatter in bootstrap [LOW]

## Dependency Graph
See: `docs/plans/2026-04-14-hardening-remediation/dependency-graph.md`

## Verification Log
See: `docs/plans/2026-04-14-hardening-remediation/verification-log.md` (append-only)

## Deferred to Security Roadmap (NOT in this plan)
- AppArmor / seccomp profiles
- DPA per-tenant tracking
- Break-glass emergency access workflow
- Edge device attestation / cert pinning
- Redis / NATS tenant key-space isolation (requires architectural-arbiter ADR)

## Progress Summary
Completed: 5 / 14 packages
Last Updated: 2026-04-14
