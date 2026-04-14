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
- [x] 05-rls-coverage-extension — merged 05a+05b, register RlsModule in 7 services [HIGH] [security-sensitive] (commit 995fad0a)
- [x] 06-pii-log-masking-central — maskPii value-pattern scanner wired into logger [HIGH] [security-sensitive] (commit e185edca)

### Phase 2 — Hygiene & secrets supply chain
- [x] 07-bootstrap-secrets-adoption — wire bootstrapSecrets() into every main.ts [MEDIUM] [security-sensitive] [blockedBy: 01] (commit 3111e126)
- [x] 08-cert-manager-internal-issuer — cert-manager Issuer + Certificate CRDs [MEDIUM] [blockedBy: 03] (commit cdce34da)
- [x] 09-dev-db-per-service-wiring — dev compose per-service roles [MEDIUM] (commit b14fc7a8)
- [x] 10-password-pepper-bcrypt — PASSWORD_PEPPER HMAC layer [MEDIUM] [security-sensitive] (commit b0ec61f0)

### Phase 3 — Policy & tooling
- [x] 11-secret-leak-prevention — gitleaks pre-commit hook + CI scan [MEDIUM] (commit 3e576623)
- [x] 12-k8s-pod-security-standards — restricted PSS labels [MEDIUM] (commit beaae93d)
- [x] 13-structured-json-logging — enforce via ESLint no-console=error [LOW] (commit 99094393)

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
Completed: 14 / 14 packages  — ALL CLOSED
Last Updated: 2026-04-14
