# Console live check (2026-10-17)

Defects found by checking the tenant console against production. Code changes only: no
production container, Redis or droplet runtime state was touched.

Owner: claude (implementation), okan (review).

## FE-MEDIUM-345

**State:** OPEN. Resolved by the PR whose commit carries `Closes:` for this ID. Deadline
2026-10-24.

### Symptom (FE-MEDIUM-345)

On production `/tenant` (Company dashboard, dark theme) the Module Status list showed the words
"users" beside Human Resources and "sprout" beside Hydroponics Management, overflowing their icon
tiles. Fish Farm Management and Sensor Monitoring showed the emoji 🐟 and 📊.

### Root cause (FE-MEDIUM-345)

Line references are to `main` before this fix.

A module record names its icon in Lucide's kebab-case (`auth.modules.icon`: `fish`, `users`,
`activity`, `sprout`, `bell`, `brain`;
`apps/auth-service/src/modules/system-module/entities/module.entity.ts:175`, `:218`). Nothing in
tenant-admin resolved that name to a component:

- `TenantDashboard` guessed a module code from the display name (`farm`, `hr`/`insan`,
  `sensor`/`sens`), mapped the three guessed codes to emoji and fell back to the record's icon
  name for every other module (`web/modules/tenant-admin/src/pages/TenantDashboard.tsx:73-77`,
  `:161-176`). "Human Resources" contains no `hr`, and hydroponics had no guess, so both rows
  printed the raw name, which the row rendered as text (`:469-471`).
- `TenantModules` kept a second code-to-emoji map
  (`web/modules/tenant-admin/src/pages/TenantModules.tsx:18-23`), and `ModuleCard` and
  `ModuleDetailsModal` rendered the icon field as text
  (`web/modules/tenant-admin/src/components/modules/ModuleCard.tsx:115-117`,
  `ModuleDetailsModal.tsx:24-26`).

The console already owns a typed map from Lucide names to components for the rail
(`web/shared-ui/src/components/Layout/console/railIcons.ts`), which covered four of the six
catalogue names.

### Evidence (FE-MEDIUM-345)

- Screenshot of production `/tenant`: the Human Resources and Hydroponics Management rows show
  the text "users" and "sprout" where the other rows show an emoji.
- Before the fix, `TenantDashboard.spec.tsx` renders the list from records named `users`,
  `sprout`, `fish`, an unknown name and `null`, and finds no `svg` in any icon tile.

### Fix (FE-MEDIUM-345)

- `railIcons.ts` is now the console's single icon vocabulary. It adds `bell` and `brain`, so
  every catalogue name resolves. `consoleIconFor(name: string | null)` returns the name's
  component, or `CONSOLE_ICON_FALLBACK` (`Package`) for `null`, an unknown name or a name off the
  object prototype.
- `ModuleIcon` (`web/modules/tenant-admin/src/components/modules/ModuleIcon.tsx`) draws a
  record's icon through `consoleIconFor`, `aria-hidden`, since the module name sits beside it.
  The dashboard list, `ModuleCard` and `ModuleDetailsModal` render through it. Both emoji maps
  and the name-based code guess are gone.
- `MyModule.icon` is `string | null`, as the GraphQL contract declares. The modules page has no
  icon in the login payload, so the refs query (`MyModuleRefs`, formerly `MyModulesWithIds`) also
  selects `icon`. `useModuleRefs` returns each module's id and icon by code.

### Tests (FE-MEDIUM-345)

- `web/shared-ui/src/components/Layout/console/__tests__/railIcons.spec.ts`: known names
  resolve to their Lucide component; unknown, `null` and prototype names resolve to `Package`.
- `web/modules/tenant-admin/src/pages/__tests__/TenantDashboard.spec.tsx`: the `users`, `sprout`
  and `fish` rows each draw `svg.lucide-<name>` with an empty text content, and no element has
  the text "users" or "sprout". The unknown-name and `null` rows draw `svg.lucide-package`.
- `web/modules/tenant-admin/src/pages/__tests__/TenantModules.spec.tsx`: each card draws its
  record's icon from the refs query and the neutral glyph for a module without a record.

## INFRA-HIGH-230

**State:** OPEN. Resolved by the PR whose commit carries `Closes:` for this ID. Deadline
2026-10-24.

### Symptom (INFRA-HIGH-230)

CI - Affected run 38990686731 (`ffd6aa2f4`, `deploy-development / deploy`) ended with
`status=rollback_failed`. Afterwards `ghcr.io/okan-wqm/aquaculture_platform/<svc>:ffd6aa2f4...`
named the pre-release image for every app service (`shell` → `ebc6d366dea1`, the same image as
`rollback-ffd6aa2f4-*` and `:latest`). The release image pulled from GHCR by digest
(`shell@sha256:e2dcd102...`) was left untagged. Compose resolves app images as `<svc>:${TAG}`,
so any later `TAG=ffd6aa2f4... docker compose up` started old code against a schema two
migrations ahead of it.

### Root cause (INFRA-HIGH-230)

The job logs of attempts 3 and 4 (release ids `ffd6aa2f4...-20261017T<time>`) show two defects
in the same rollback path, plus a compose recreate that cannot survive its own failure.

| Attempt        | db-migrate | Compose failure                       | Rollback              |
| -------------- | ---------- | ------------------------------------- | --------------------- |
| 3 (`T083603Z`) | 2 applied  | `/aqua-mobile` held by `740006e18d09` | refused, no tag moved |
| 4 (`T085545Z`) | 0 applied  | rename onto `/aqua-dashboard`         | retagged, then failed |

1. **The release tag was the rollback mechanism.** `rollback_deployed_services`
   (`scripts/deploy/droplet-up.sh:573-574` before the fix) ran
   `docker tag <pre-release id> <svc>:latest` and `docker tag <pre-release id> <svc>:<DEPLOY_SHA>`
   so that compose, which resolves `<svc>:${TAG}`, would pick the old image. The retag ran
   before `docker compose up` (`:583`). When compose failed, the tags stayed on old code. The
   release pin in `pull_deploy_image_required` also swallowed a failed `docker tag` with
   `|| true` (`:446`). This is the ORPHAN-HIGH-381 mechanism: that fix added guards but kept
   the release-tag rewrite.
2. **The migration guard counted one attempt.** `MIGRATIONS_APPLIED_THIS_RELEASE` comes from
   this attempt's `aqua-db-migrate` log (`:331-333`). Attempt 3 applied the release's two
   migrations and was refused correctly. Attempt 4 of the same release applied none, passed the
   guard (`:529-538`) and restored images captured from containers that had booted days before
   those migrations (`capture_rollback_manifest`, `:487-498`, checks health only). Its own
   compose run failed, so nothing crash-looped. Had it succeeded, every restored service would
   have cold-started against the forward schema: the 2026-07-12 farm-service outage class.
3. **Compose recreate could not recover.** `docker compose up --force-recreate` creates the new
   container as `<old-id12>_<name>`, removes the old one and renames the new one. In attempt 3
   a container compose did not own already held `aqua-mobile`. Compose aborted mid-run and left
   `<id12>_aqua-*` temp containers next to the originals. In attempt 4 compose took each temp
   container as the one to replace and could not rename onto the name the original still held.
   The rollback's own `compose up` hit the same wall (`f33602842a24_aqua-auth`). The selective
   path (`:1612`) ran compose with no check for either state.

### Fix (INFRA-HIGH-230)

- **Release tags have one writer.** `pull_deploy_image_required` pins `<svc>:<DEPLOY_SHA>` and
  `<svc>:latest` from the release digest and fails the deploy if either pin fails. The rollback
  writes no tag. Capture tags the running images as `<svc>:rollback-<DEPLOY_RELEASE_ID>`, and
  restore runs compose with `TAG=rollback-<DEPLOY_RELEASE_ID>`. Compose picks the rollback
  generation by name, and `TAG=<release-sha>` keeps naming the release whatever the rollback
  does. Restore recreates only services whose rollback tag still resolves to the captured image.
- **The schema boundary spans attempts.** Every release-ledger write now carries
  `deploy_metadata.migrationsApplied` and `deploy_metadata.schemaAdvancedAt`. The latter is the
  epoch at which db-migrate stopped whenever it did not prove zero migrations, including
  failures and timeouts. `schema_advanced_at` reads the latest advance from the ledger. Rows
  written before this change count at `created_at`. A db-migrate container that is still
  running or exited non-zero also counts. Capture keeps only healthy containers that started
  after that moment. An unreadable ledger leaves no rollback point. Restore still refuses unless
  this attempt's count is a proven `0`. Attempt 4 now captures nothing and refuses.
- **One recreate path.** `compose_recreate_services` (`scripts/deploy/lib/compose-recreate.sh`)
  serves the selective rollout and the restore. It first runs
  `scripts/deploy/compose-container-preflight.ts`, which reads the target container names from
  `docker compose config` and the host from `docker ps -a`. A target name held by a container
  that is not this project's service fails the deploy before anything is stopped, naming the
  container, its id and its compose owner. Temp containers `<12 hex>_<name>` labelled as this
  project's service are removed. Anonymous volumes are kept.
- The rollback and image-reference code moved from `droplet-up.sh` into
  `scripts/deploy/lib/release-rollback.sh`, so the specs can source it.

### Tests (INFRA-HIGH-230)

- `tests/invariants/deploy-rollback-release-tag.spec.ts` runs capture and restore against a
  fake Docker daemon (`tests/invariants/helpers/fake-deploy-docker.ts`). Attempt 4 is refused
  with no release-tag write and no compose run. Attempt 3 is refused untouched. Unknown counts
  are refused. A permitted rollback removes the leftover temp container and runs
  `TAG=rollback-<id> compose up` while both release tags stay on the release image. A
  re-pointed rollback tag is not restored. An unreadable ledger and an unclean db-migrate run
  are treated as advances. A static check pins the three `docker tag` writers. Against the
  `origin/main` logic, the attempt-4, permitted-rollback and writer checks fail.
- `tests/invariants/compose-recreate-preflight.spec.ts` covers removal of the temp container
  before `compose up` with the caller's `TAG`. A foreign, unlabeled or other-service holder of
  the name fails with no `rm`, `stop` or `up`. Temp names of other projects are left alone and
  undefined services are refused.

### Not changed (INFRA-HIGH-230)

- The full-stack path runs `compose down` and force-removes every `aqua-*` container before
  `compose up`, so no leftover can block it. Its rollback goes through the same
  `compose_recreate_services`.
- No container, image tag or ledger row on the droplet was changed. Attempt 5 re-pinned the
  `ffd6aa2f4` tags from the digests and was promoted at 09:27:36Z. A read-only check on the host
  shows `shell:ffd6aa2f4...`, `shell:latest` and the running `aqua-shell` on `e2dcd102bd52`.

## SEC-HIGH-202

**State:** OPEN. Resolved by the PR whose commit carries `Closes:` for this ID. Deadline
2026-10-24.

### Symptom (SEC-HIGH-202)

Tenant users were sent back to `/login` while their sessions were still valid. auth-service
logged `Rate limit exceeded for bucket 'refresh'`, and the only refresh key in Redis was
`ratelimit:refresh:ip:::ffff:172.20.0.30`. That address is the `aqua-gateway` container on
`aqua-saas_aqua-internal`, not a client.

### Root cause (SEC-HIGH-202)

`RateLimitGuard` (`libs/backend-common`) builds the IP dimension of a `@RateLimit` bucket from
`request.ip` (`libs/backend-common/src/rate-limit/rate-limit.guard.ts:301` before the fix).
auth-service is internal only and runs without `TRUST_PROXY` by design. Every pre-auth mutation
reaches it from one socket peer, the gateway, so `request.ip` is the gateway container for every
user.

A bucket with no custom identifier and no authenticated user is keyed `<name>:ip:<ip>`
(`rate-limit.guard.ts:308`). Four auth-service limits key on IP alone, so each was one bucket for
the whole platform:

| Operation             | Bucket                  | Limit         | Declared at                |
| --------------------- | ----------------------- | ------------- | -------------------------- |
| `refreshToken`        | `refresh`               | 10 per 5 min  | `auth.resolver.ts:140`     |
| `resetPassword`       | `password-reset`        | 3 per hour    | `auth.resolver.ts:229`     |
| `validateInvitation`  | `invitation-validation` | 10 per 5 min  | `auth.resolver.ts:257`     |
| `verifyWebAuthnLogin` | `webauthn-verify`       | 10 per 15 min | `webauthn.resolver.ts:187` |

Ten refreshes in five minutes across all tenants exhausted `refresh`, and every later refresh
failed until the window expired. Any anonymous caller could do the same on purpose. Three
`resetPassword` calls an hour blocked password reset for everyone.

The gateway already sends the client address. `AuthenticatedDataSource` sets `x-client-ip` from
its `TRUST_PROXY`-resolved `req.ip` on every subgraph request
(`apps/gateway-api/src/federation/authenticated-data-source.ts:271`), and the REST proxy does the
same. `resolveClientNetworkContext` (`libs/backend-common/src/http/client-network-context.util.ts`)
reads it only when the request carries a verified `gateway-api` service identity, and
`StripInternalHeadersMiddleware` deletes it from any request without a verified identity.
ORPHAN-MEDIUM-319 moved the auth audit IPs onto that reader. The rate-limit guard kept
`request.ip`.

### Other pre-auth operations checked (SEC-HIGH-202)

These key on a custom identifier and were not affected while the identifier was present. Their
IP fallback had the same defect and is fixed by the same change.

- `login`, `forgotPassword`, `webAuthnLoginChallenge`: lowercased email.
- `verifyMfaLogin`: the MFA challenge token.
- `setupMfa`, `verifyMfaSetup`: the MFA setup token, or the user when a session exists.

There is no public `register` mutation (removed by SEC-CRITICAL-001). The gateway's own edge
tiers key on the client IP it resolves under `TRUST_PROXY` and were correct. sensor-service's
provisioning limiter is reached from nginx directly with `TRUST_PROXY=1`, so its `request.ip` is
the client.

### Fix (SEC-HIGH-202)

`RateLimitGuard.identityOf` takes the IP dimension from `resolveClientNetworkContext(request).ip`,
the one platform reader of the client IP. The guard's request type extends `ClientNetworkRequest`,
which is now a structural interface that Express requests, `TenantRequest` and the guard's request
all satisfy.

The trust model is unchanged:

- A client-supplied `x-client-ip` never picks a bucket. On a request without a verified service
  identity the middleware strips the header and the bucket is the socket peer.
- A forged signature verifies as nothing, so the header is stripped.
- The header is read only from `gateway-api`. A verified call from another service is keyed on
  that service's socket address.
- A gateway hop that carries no client IP stays in the gateway's shared bucket. It is
  restrictive, never unlimited.
- The guard's fail-closed handling of an unhealthy Redis store is untouched.

Keying `refresh` on the refresh-token family was considered and rejected. Before validation the
token is attacker-chosen, so every random string would get a fresh bucket. Validating the family
first would put a database lookup in front of the limiter it is meant to protect.

### Tests (SEC-HIGH-202)

`libs/backend-common/src/rate-limit/__tests__/gateway-client-bucket.spec.ts` runs the real hop:
an Express app with `StripInternalHeadersMiddleware` and the guard, a v2 signature built by
`buildSignedInternalHeaders` against a keyring, and supertest as the single gateway socket.

- Two clients behind one gateway socket get separate `refresh` buckets.
- A planted, rotated `x-client-ip` on an unsigned request is stripped, and every call counts
  against the sender's own bucket. The victim's bucket is untouched.
- A forged signature and a verified non-gateway caller cannot pick a bucket.
- A gateway hop without a client IP shares one bucket.

Against the guard before the fix, the first two cases fail with 429 for the second client.

## SEC-MEDIUM-203

**State:** OPEN. Owner claude, deadline 2026-10-24.

Found while checking the pre-auth operations for SEC-HIGH-202. Four audit IP sites in
auth-service still bypass `resolveClientNetworkContext`:

- `mfaStepUp` and `verifyMfaLogin` (`mfa.resolver.ts:220`, `:264`) and `verifyWebAuthnLogin`
  (`webauthn.resolver.ts:196`) prefer `request.ip`, then `X-Forwarded-For`. Behind the gateway
  they record the gateway container.
- The GDPR consent audit (`user-consent.resolver.ts:291`) takes the first `X-Forwarded-For` entry
  before `request.ip`. On a direct internal call the sender chooses it.

These feed audit rows and consent records, not rate-limit buckets, so they are not part of the
SEC-HIGH-202 change. ORPHAN-MEDIUM-319 migrated `login`, `acceptInvitation`, `forgotPassword` and
`resetPassword`. These four were not part of it. Fix direction: route them through
`resolveClientNetworkContext` and add an invariant that fails subgraph code reading `request.ip`
or `x-forwarded-for` for client identity outside that reader.
