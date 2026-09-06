# Permanent login recovery implementation findings

Status: IN-PROGRESS. Static review against `411c86835`; implementation and hosted validation are pending.

The approved design uses a database-owned credential version, one locked authentication context, action-only password recovery/invitation completion, hosted validation, and an immutable production delivery contract. Four independent reviews covered authentication transactions, MFA/WebAuthn, delivery recovery, and CI enforcement.

The uncommitted prior review remains intact in `/var/aqua-saas-auth-fence`. Its ORPHAN-808 and ORPHAN-810 through ORPHAN-814 identifiers are reserved in that sibling workspace. This implementation allocates current findings through the shared allocator and records the relationship below; it does not overwrite the previous registry or reuse its reserved identifiers.

No local test, build, type-check, lint, dependency installation, migration, or production mutation is authorized for validation. Tests and build artifacts must come from GitHub-hosted Actions. Metadata edits and lightweight review remain local. Findings stay open/in-progress until supported by the required closure evidence.

## ORPHAN-CRITICAL-815

**Token issuance compares timestamp precision instead of authenticated credential state**

State: IN-PROGRESS. Owner: codex / okan. Deadline: 2026-09-07.

Prior ORPHAN-CRITICAL-808. The mint predicate conditionally compares updatedAt; PostgreSQL timestamp precision and JavaScript Date precision differ, and bookkeeping is not credential identity. Replace it with a database-owned version, mandatory immutable proof and migrated entity/schema contract.

Evidence: `apps/auth-service/src/modules/authentication/services/token.service.ts:218`, `apps/auth-service/src/modules/authentication/entities/user.entity.ts`.

## ORPHAN-HIGH-816

**Detached authentication writes and post-commit mint split credential action outcomes**

State: IN-PROGRESS. Owner: codex / okan. Deadline: 2026-09-07.

Prior ORPHAN-HIGH-811/812 and ORPHAN-MEDIUM-813. Whole-entity writes can overwrite newer account state; reset/invitation must atomically complete the action and return success/loginRequired without mint dependencies. Login success audit belongs to committed mint. Current SEC-HIGH-158/159 remain separate related action-link/recovery findings.

Evidence: `apps/auth-service/src/modules/authentication/services/authentication.service.ts`, `apps/auth-service/src/modules/authentication/resolvers/auth.resolver.ts`.

## ORPHAN-HIGH-817

**MFA and WebAuthn writers do not preserve the authenticated proof through concurrent credential changes**

State: IN-PROGRESS. Owner: codex / okan. Deadline: 2026-09-07.

Static adversarial review: registration can commit after reset deletes credentials; detached MFA changes race factor consumption; step-up loses originating jti/iat/exp; lockout exclusions need current checks. Use the shared lock context, narrow writes, original signed proof and derivative step-up identity.

Evidence: `apps/auth-service/src/modules/authentication/services/mfa.service.ts`, `apps/auth-service/src/modules/authentication/services/webauthn.service.ts`, `apps/auth-service/src/modules/authentication/resolvers/mfa.resolver.ts`.

## ORPHAN-HIGH-818

**Refresh family terminal state and delayed user invalidation can contradict newer session state**

State: IN-PROGRESS. Owner: codex / okan. Deadline: 2026-09-07.

Rotation/grace must retain family and rememberMe. Terminal revocation must cover historical grace rows. Old revoked NULL-family rows cannot recover lineage. Mutation invalidation timestamps must be durably captured inside their DB transaction and replayed unchanged, so delayed delivery does not invalidate later login.

Evidence: `apps/auth-service/src/modules/authentication/services/authentication.service.ts`, `apps/auth-service/src/modules/tenant/services/tenant-user-management.service.ts`, `apps/auth-service/src/modules/authentication/services/token.service.ts`.

## ORPHAN-HIGH-819

**Heavy local hooks and SSH-based E2E leave hosted enforcement and runner provenance incomplete**

State: IN-PROGRESS. Owner: codex / okan. Deadline: 2026-09-07.

Prior ORPHAN-MEDIUM-814 is partly stale: current main already wires auth integration. Remaining work is real ORM/populated migration coverage, unconditional required hosted hook parity, both gate directories, explicit selection receipts, and removing droplet-side E2E execution. User selected lightweight local hooks with mandatory hosted checks; live main protection was read and has all four expected contexts/app bindings, strict and enforce_admins enabled.

Evidence: `.husky/pre-commit`, `.husky/pre-push`, `.github/workflows/e2e-tests.yml`, `.github/workflows/ci-affected.yml`.

## ORPHAN-CRITICAL-820

**Active development delivery can mix live PostgreSQL mounts with a different release contract**

State: IN-PROGRESS. Owner: codex / okan. Deadline: 2026-09-07.

Prior ORPHAN-CRITICAL-810. Time-bounded earlier runtime evidence showed base image User=postgres with a root-only entrypoint bind-mounted from mutable checkout and exit126. Static current delivery still permits shared checkout publication before admission. Integrate immutable releases/config generations and shared host control-plane locking before mutation.

Evidence: `.github/workflows/deploy-development.yml`, `infrastructure/docker/scripts/postgres-ssl-entrypoint.sh`, `docker-compose.droplet.yml`.

## ORPHAN-HIGH-821

**Recovery admission and rollback do not jointly bind complete executable configuration and database state**

State: IN-PROGRESS. Owner: codex / okan. Deadline: 2026-09-07.

The approved recovery protocol must distinguish healthy upgrade from degraded legacy recovery, preserve a verified consistent recovery point before mutation, bind all TLS/config/image/volume material, update every strict journal reader, and retain fail-closed application rollback after migrations. Existing broken state is observation, not a proven rollback baseline.

Evidence: `scripts/deploy/production-host-control-plane.sh`, `.github/manifests/postgres-dr-bootstrap-policy.json`.
