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

The hosted coordinator also exposed two fixture defects: an unavailable ripgrep binary stopped the
first assertion, and PostgreSQL created outside Compose could not be recreated by the real coordinator.
The fixture now uses baseline shell tools and the same Compose ownership contract as deployment.
Failure journals and bounded redacted diagnostics survive cleanup. Production recovery remains unproven.

## ORPHAN-HIGH-822

NATS reply subjects and JetStream initialization disagree with certificate authorization.

State: IN-PROGRESS. Owner: codex / okan. Deadline: 2026-09-07.

Run 34037290826 reports subscription denial for `_INBOXAQUACULTURE_CONFIG_SERVICE..*` while the
certificate ACL permits `_INBOXCONFIG_SERVICE.>`. The factory derives identity from the display name
and supplies a delimiter that the SDK adds again. The custom RPC client also ignores the factory's
resolved default. Derive the default from the mounted X509 certificate subject, keep display naming
separate and preserve explicit domain reply contracts.

Independent review found the next two contract gaps before another rollout: the SDK's initial
`$JS.API.INFO` request has no publish grant, and responder publish `_INBOX.>` cannot match a caller's
certificate-scoped inbox. These require explicit least-privilege JetStream capability and bounded
request-bound response permissions, with actual hosted mTLS broker proof. Universal inbox subscription
permissions must remain absent; SEC-HIGH-098's isolation boundary remains in force.

The bounded response policy supplies one terminal acknowledgement or two unary RPC frames, with a
finite lifetime. Configured RPC timeouts must be valid positive values below that same lifetime;
unsupported values fail configuration instead of promising a reply after authorization expires.

Existing SENSOR-CRITICAL-108 also blocks startup: the three unchanged stream allocations total
7.75 GiB while the broker permits 2 GiB. A shared declared storage policy supplies runtime allocations,
generated broker capacity, the 1.25 deployment reserve and the existing 75% storage alert threshold.
Memory, CPU and retention policy remain as declared. The measurement and 100-tenant sizing phase of
SENSOR-CRITICAL-108 stays OPEN (owner zcode / architectural-arbiter / okan, deadline 2026-09-17);
making current declarations consistent does not prove the workload fits those declarations.

Evidence:

- `libs/backend-common/src/nats/nats-connection.factory.ts`
- `libs/backend-common/src/nats/nats-v3-client.proxy.ts`
- `libs/backend-common/src/nats/nats-v3-server.strategy.ts`
- `infrastructure/nats/services.yaml`

## ORPHAN-HIGH-823

Sensor erasure duplicates the MQTT authentication provider outside its owning module.

State: IN-PROGRESS. Owner: codex / okan. Deadline: 2026-09-07.

Run 34037290826 aborts sensor-service startup because `SensorErasureModule` re-provides
`MqttAuthService` without its repository. `EdgeDeviceModule` owns and exports that service. Importing
the owner both fixes resolution and makes erasure invalidate the same cache used by the HTTP ACL
controller. The regression keeps those production modules, controller and cache real.

Evidence:

- `apps/sensor-service/src/compliance/erasure/erasure.module.ts`
- `apps/sensor-service/src/edge-device/edge-device.module.ts`
- `apps/sensor-service/src/compliance/erasure/__tests__/sensor-erasure-hooks.spec.ts`

## ORPHAN-MEDIUM-824

Three service throttlers select per-process storage despite production Redis configuration.

State: OPEN. Owner: platform-kernel-expert / okan. Deadline: 2026-09-20.

Run 34037290826 reports in-memory SlidingWindowStrategy storage in messaging, hydroponics and AI.
Source selects Redis only when an optional `REDIS_CLIENT` token is present. This is a separate phase
from login recovery: bind the canonical provider into the throttler's actual module scope, make
production storage selection explicit, and prove two isolated instances share one atomic counter in
GitHub Actions. It did not cause the observed mint or startup failure. No repair or closure is claimed.

Evidence: `libs/backend-common/src/security/throttler/sliding-window.strategy.ts` and the three service
app modules and `docker-compose.droplet.yml` listed in the registry.

## ORPHAN-HIGH-825

The DLQ replay CLI bypasses its documented production certificate connection contract.

State: OPEN. Owner: platform-kernel-expert / okan. Deadline: 2026-09-17.

`tools/scripts/telemetry-dlq-replay.ts` documents the shared factory and TLS inputs but calls
`connect({ servers: url })`. It supplies neither the required client certificate material nor the
declared replay inbox. The separate phase must use the certificate factory in the actual CLI and
prove replay admission and acknowledgement against committed production ACLs in GitHub Actions.
Related SENSOR-HIGH-093 covers the broader replay chain. The login E2E does not execute this CLI.

## ORPHAN-HIGH-826

The Rust ingest client uses request inboxes outside its certificate's subscription permissions.

State: OPEN. Owner: sensor-expert / okan. Deadline: 2026-09-17.

`crates/nats-client/src/lib.rs` configures TLS but leaves the pinned async-nats 0.49.1 inbox default
at `_INBOX`; `services.yaml` permits `_INBOXSENSOR_INGESTION.>`. The request/PubAck paths disagree.
The policy snapshot request also needs an explicit least-privilege capability review. TLS connection
failure or unconditional process exit is not inferred from these request-path defects.

The separate phase must bind the actual Rust wrapper's inbox identity, verify policy/PubAck against
production certificate ACLs, and execute the catalog-required sidecar in hosted readiness coverage.
The current image-derived login E2E omits that sidecar, and TypeScript clients do not prove its behavior.
No complete platform-readiness or repair claim is made for this path.

## Hosted evidence

Run 34038125618, source `1dd00da00ad6f538fa01a2059f8481cec74810e0`, tested merge
`82bf663ecd1e63fda3a6aec8f0b396f72cff8432`: auth unit 846/846, real PostgreSQL 61/61,
mobile 407/407 and shell 23/23 passed. Auth types, strict lint, GraphQL and release invariants passed.
The general types lane exposed two missing-value narrowings in the TPM workflow invariant, now
corrected in source. The policy lane identified three formatting drifts; its exact hosted generation
artifact was reviewed and applied without executing a local formatter.

Full-stack diagnostics also confirmed the isolated origin `https://localhost` violates production's
frontend URL contract and observability hardcodes database `aquaculture`. The harness now derives
its TLS certificate, ingress and browser/API origins from one reserved test hostname bound to loopback;
the production validator is unchanged. Observability consumes the same selected database as the
other services and db-migrate, retaining the production default. These changes require another hosted run.

Neither full-stack authenticated login nor the actual signed recovery coordinator has passed.
All new runtime findings remain open for proof. No local heavy validation or production mutation.
