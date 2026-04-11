# Security Reviewer Audit
**Date:** 2026-04-10  
**Scope:** Full-repo security audit  
**Decision:** **BLOCK**

## Summary
| Severity | Count |
|---|---:|
| CRITICAL | 2 |
| HIGH | 1 |
| MEDIUM | 0 |
| LOW | 0 |

## Findings

### CRITICAL-001 - Platform JWTs are still HS256/shared-secret across multiple services
**Evidence:**
- [`/var/aqua-saas/libs/backend-common/src/auth/jwt-verification.utils.ts:104`](/var/aqua-saas/libs/backend-common/src/auth/jwt-verification.utils.ts#L104)
- [`/var/aqua-saas/libs/backend-common/src/auth/jwt-verification.utils.ts:109`](/var/aqua-saas/libs/backend-common/src/auth/jwt-verification.utils.ts#L109)
- [`/var/aqua-saas/apps/auth-service/src/app.module.ts:127`](/var/aqua-saas/apps/auth-service/src/app.module.ts#L127)
- [`/var/aqua-saas/apps/auth-service/src/app.module.ts:187`](/var/aqua-saas/apps/auth-service/src/app.module.ts#L187)
- [`/var/aqua-saas/apps/ai-service/src/app.module.ts:178`](/var/aqua-saas/apps/ai-service/src/app.module.ts#L178)
- [`/var/aqua-saas/apps/farm-service/src/app.module.ts:323`](/var/aqua-saas/apps/farm-service/src/app.module.ts#L323)
- [`/var/aqua-saas/apps/messaging-service/src/app.module.ts:281`](/var/aqua-saas/apps/messaging-service/src/app.module.ts#L281)

`getJwtVerifyOptions()` hard-codes `algorithms: ['HS256']`, and several services load the same `JWT_SECRET` into their local `JwtModule`. Auth-service also signs tokens with `HS256`. In a multi-service platform, that makes any compromised service, CI artifact, or runtime foothold capable of forging valid platform tokens for every other service that trusts the same secret.

Remediation: move token signing to auth-service only, rotate to asymmetric signing with a private key in auth-service and public-key/JWKS verification in consumers, and reject HS256 for production access tokens.

### CRITICAL-002 - PII and reset URLs are published on the immutable event bus with no enforced crypto-shred path
**Evidence:**
- [`/var/aqua-saas/libs/event-contracts/src/auth-events.ts:39`](/var/aqua-saas/libs/event-contracts/src/auth-events.ts#L39)
- [`/var/aqua-saas/libs/event-contracts/src/auth-events.ts:46`](/var/aqua-saas/libs/event-contracts/src/auth-events.ts#L46)
- [`/var/aqua-saas/libs/event-contracts/src/auth-events.ts:49`](/var/aqua-saas/libs/event-contracts/src/auth-events.ts#L49)
- [`/var/aqua-saas/libs/event-contracts/src/notification-events.ts:6`](/var/aqua-saas/libs/event-contracts/src/notification-events.ts#L6)
- [`/var/aqua-saas/libs/event-contracts/src/notification-events.ts:20`](/var/aqua-saas/libs/event-contracts/src/notification-events.ts#L20)
- [`/var/aqua-saas/libs/event-contracts/src/base-event.ts:103`](/var/aqua-saas/libs/event-contracts/src/base-event.ts#L103)
- [`/var/aqua-saas/libs/event-contracts/src/base-event.ts:115`](/var/aqua-saas/libs/event-contracts/src/base-event.ts#L115)
- [`/var/aqua-saas/apps/auth-service/src/modules/tenant/services/tenant.service.ts:288`](/var/aqua-saas/apps/auth-service/src/modules/tenant/services/tenant.service.ts#L288)
- [`/var/aqua-saas/apps/auth-service/src/modules/tenant/services/tenant.service.ts:297`](/var/aqua-saas/apps/auth-service/src/modules/tenant/services/tenant.service.ts#L297)
- [`/var/aqua-saas/apps/auth-service/src/modules/tenant/services/user-lifecycle.service.ts:412`](/var/aqua-saas/apps/auth-service/src/modules/tenant/services/user-lifecycle.service.ts#L412)
- [`/var/aqua-saas/apps/auth-service/src/modules/tenant/services/user-lifecycle.service.ts:421`](/var/aqua-saas/apps/auth-service/src/modules/tenant/services/user-lifecycle.service.ts#L421)

`PasswordResetRequestedEvent` and `UserInvitedEvent` both carry email/name data and full `actionUrl` values containing short-lived credentials. `BaseEvent.cryptoShredKeyId` exists, but it is optional and there is no producer-side enforcement here. That makes the event bus and its persistence path a durable archive of sensitive identity and reset material.

Remediation: stop publishing raw PII and credential-bearing URLs on the bus, replace them with opaque references, and make crypto-shredded payload handling mandatory for any event that still carries sensitive fields.

### HIGH-003 - Build/runtime supply-chain entry points still rely on mutable tags and unverified downloads
**Evidence:**
- [`/var/aqua-saas/infrastructure/docker/Dockerfile.backend:16`](/var/aqua-saas/infrastructure/docker/Dockerfile.backend#L16)
- [`/var/aqua-saas/infrastructure/docker/Dockerfile.backend:73`](/var/aqua-saas/infrastructure/docker/Dockerfile.backend#L73)
- [`/var/aqua-saas/infrastructure/docker/Dockerfile.frontend:11`](/var/aqua-saas/infrastructure/docker/Dockerfile.frontend#L11)
- [`/var/aqua-saas/infrastructure/docker/Dockerfile.frontend:48`](/var/aqua-saas/infrastructure/docker/Dockerfile.frontend#L48)
- [`/var/aqua-saas/infrastructure/docker/Dockerfile.shell:9`](/var/aqua-saas/infrastructure/docker/Dockerfile.shell#L9)
- [`/var/aqua-saas/infrastructure/mosquitto/Dockerfile:16`](/var/aqua-saas/infrastructure/mosquitto/Dockerfile#L16)
- [`/var/aqua-saas/infrastructure/mosquitto/Dockerfile:31`](/var/aqua-saas/infrastructure/mosquitto/Dockerfile#L31)
- [`/var/aqua-saas/.github/actions/setup-node-env/action.yml:48`](/var/aqua-saas/.github/actions/setup-node-env/action.yml#L48)
- [`/var/aqua-saas/.github/actions/docker-build-push/action.yml:90`](/var/aqua-saas/.github/actions/docker-build-push/action.yml#L90)
- [`/var/aqua-saas/.github/workflows/e2e-tests.yml:104`](/var/aqua-saas/.github/workflows/e2e-tests.yml#L104)

Production Dockerfiles still use mutable upstream tags, the Mosquitto image downloads a GitHub release artifact without checksum verification, and repo-owned GitHub Actions still consume mutable tags instead of immutable SHAs. That leaves the build and deploy pipeline exposed to tag swaps, upstream compromise, and dependency substitution.

Remediation: pin all third-party actions to full commit SHAs, pin production base images by digest, and require checksum or signature verification for every external binary downloaded during image builds.

## Cross-Domain Dependencies
- `auth-security-expert` for the JWT contract and gateway token handling.
- `data-expert` and `notification-service` owners for the event-bus payload redesign.
- `infra-expert` for image/action pinning and build pipeline policy enforcement.

## Verification
Static review only. No tests were run.
