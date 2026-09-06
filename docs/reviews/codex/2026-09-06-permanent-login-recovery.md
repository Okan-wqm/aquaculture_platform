# Permanent login recovery implementation findings

Status: IN-PROGRESS. Integration with main `2efee0eb4` is underway; complete hosted validation is pending.

The approved design uses a database-owned credential version, one locked authentication context,
action-only password recovery/invitation completion, hosted validation, and an immutable production
delivery contract. Four independent reviews covered authentication transactions, MFA/WebAuthn,
delivery recovery, and CI enforcement.

The prior review remains intact in `/var/aqua-saas-auth-fence`. Its ORPHAN-808 and ORPHAN-810 through
ORPHAN-814 identifiers are reserved in that sibling workspace. This implementation allocates current
findings through the shared allocator and records their relationship below.

All tests, builds, type-checks, lint, code generation and dependency installation run in GitHub-hosted
Actions. Metadata edits and lightweight review remain local. Findings stay IN-PROGRESS until the
required closure evidence exists. No production mutation has been performed during implementation.

## ORPHAN-CRITICAL-815

Token issuance compares timestamp precision instead of authenticated credential state.

State: IN-PROGRESS. Owner: codex / okan. Deadline: 2026-09-07.

Prior ORPHAN-CRITICAL-808. The mint predicate conditionally compares updatedAt; PostgreSQL timestamp
precision and JavaScript Date precision differ, and bookkeeping is not credential identity. Replace
it with a database-owned version, mandatory immutable proof and migrated entity/schema contract.

Evidence in `apps/auth-service/src/modules/authentication/`:

- `services/token.service.ts:218`
- `entities/user.entity.ts`

## ORPHAN-HIGH-816

Detached authentication writes and post-commit mint split credential action outcomes.

State: IN-PROGRESS. Owner: codex / okan. Deadline: 2026-09-07.

Prior ORPHAN-HIGH-811/812 and ORPHAN-MEDIUM-813. Whole-entity writes can overwrite newer account state.
Reset/invitation must atomically complete the action and return success/loginRequired without mint
or synchronous Redis dependencies. Login success audit belongs to committed mint.

SEC-HIGH-158 is included: validation and acceptance must agree on opaque invitation references.
Main PR #1425 supplies SEC-HIGH-159's typed platform event scope, durable recovery-email outbox and
notification internal identity contract. The merge preserves these changes inside the credential
transaction, including explicit RLS context for platform action-token reads. Successful password
login alone does not prove recovery-email delivery; the integrated flows require hosted evidence.

Evidence in `apps/auth-service/src/modules/authentication/`:

- `services/authentication.service.ts`
- `resolvers/auth.resolver.ts`

## ORPHAN-HIGH-817

MFA and WebAuthn writers lose authenticated proof across concurrent credential changes.

State: IN-PROGRESS. Owner: codex / okan. Deadline: 2026-09-07.

Static review: registration can commit after reset deletes credentials; detached MFA changes race
factor consumption; step-up loses originating jti/iat/exp; admission needs current lockout checks.
Use the shared lock context, narrow writes, original signed proof and derivative step-up identity.

Hosted PostgreSQL evidence also caught WebAuthn audit inserts without the authenticated tenant id:
RLS rejected the audit row and rolled back successful token issuance. All WebAuthn audit paths now
require the observed or locked principal identity; the next hosted run must confirm both tenant and
platform behavior.

Evidence in `apps/auth-service/src/modules/authentication/`:

- `services/mfa.service.ts`
- `services/webauthn.service.ts`
- `resolvers/mfa.resolver.ts`

## ORPHAN-HIGH-818

Refresh family terminal state and delayed user invalidation can contradict newer sessions.

State: IN-PROGRESS. Owner: codex / okan. Deadline: 2026-09-07.

Rotation/grace must retain family and rememberMe. Terminal revocation must cover historical grace
rows. Old revoked NULL-family rows cannot recover lineage. Invalidation timestamps must be captured
inside their DB transaction and replayed unchanged, so delayed delivery does not reject later login.

Serializable tenant lifecycle commands retry their whole transaction for PostgreSQL 40001/40P01 only,
with a bounded attempt count and stable command id. Aborted attempts neither write FAILED receipts
inside a failed transaction nor apply invalidation intents. Real PostgreSQL ordered races cover login
against reset/suspension and family admission against logout in both lock acquisition orders.

Evidence in `apps/auth-service/src/modules/`:

- `authentication/services/authentication.service.ts`
- `authentication/services/token.service.ts`
- `tenant/services/tenant-user-management.service.ts`

## ORPHAN-HIGH-819

Heavy local hooks and SSH-based E2E leave hosted enforcement and runner provenance incomplete.

State: IN-PROGRESS. Owner: codex / okan. Deadline: 2026-09-07.

Prior ORPHAN-MEDIUM-814 is partly stale: main already wires auth integration. Remaining work is real
ORM/populated migration coverage, unconditional required hosted hook parity, both gate directories,
explicit selection receipts, and removing droplet-side E2E execution. User selected lightweight local
hooks with mandatory hosted checks. Live main protection has all four expected contexts/app bindings,
strict checking and administrator enforcement enabled.

Evidence:

- `.husky/pre-commit`, `.husky/pre-push`
- `.github/workflows/e2e-tests.yml`
- `.github/workflows/ci-affected.yml`

## ORPHAN-CRITICAL-820

Development delivery can mix PostgreSQL mounts and certificate trust from different releases.

State: IN-PROGRESS. Owner: codex / okan. Deadline: 2026-09-07.

Prior ORPHAN-CRITICAL-810. Earlier runtime evidence showed image User=postgres with a root-only
entrypoint mounted from mutable checkout and exit 126. Static delivery permits shared checkout
publication before admission. Integrate immutable releases/config generations and shared host locking
before mutation.

Related source-confirmed defect: ordinary deploy calls certificate generation with `--force` when
Redis leaves approach expiry; this also replaces the CA. New apps and existing infrastructure can
then use different trust roots. Renew leaves while preserving a validated CA. Certificate helper
parse failures must return failure before any leaf is written.

Evidence:

- `.github/workflows/deploy-development.yml`
- `infrastructure/docker/scripts/postgres-ssl-entrypoint.sh`
- `docker-compose.droplet.yml`
- `scripts/deploy/droplet-up.sh`
- `infrastructure/docker/scripts/generate-internal-certs.sh`

## ORPHAN-HIGH-821

Recovery and rollback do not jointly bind executable configuration and database state.

State: IN-PROGRESS. Owner: codex / okan. Deadline: 2026-09-07.

Distinguish healthy upgrade from degraded legacy recovery, preserve a verified consistent recovery
point before mutation, bind all TLS/config/image/volume material, update every strict journal reader,
and retain fail-closed application rollback after migrations. Broken state is an observation, not a
proven rollback baseline.

Evidence:

- `scripts/deploy/production-host-control-plane.sh`
- `.github/manifests/postgres-dr-bootstrap-policy.json`

Recovery review confirmed a separate capacity defect: retained source data, the cold point, the probe
and a failed-forward generation can coexist during restore. Admission now reserves three additional
full copies; restore retries recheck free space before stopping or moving data. Hosted coordinator
proof includes initial scarcity and retry scarcity refusal before mutation.

Latest completed evidence before the main integration: run 34025030636 built all candidate images and
completed the authoritative migration. Auth unit tests reported 763 passed / 8 failed and PostgreSQL
35 passed / 2 failed; the reported defects have source corrections awaiting the integrated run.
Hosted full-stack startup stopped at config-service exit 1. Redacted service diagnostics now survive
cleanup so the next failure can be diagnosed from runtime evidence. Neither full-stack login nor the
actual signed recovery coordinator is yet proven. No local heavy validation or production mutation.
