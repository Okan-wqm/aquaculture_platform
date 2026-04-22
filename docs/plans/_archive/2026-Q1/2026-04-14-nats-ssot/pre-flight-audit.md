# P0 Pre-Flight Audit: NATS Cert-Is-Identity SSoT Refactor

**Date:** 2026-04-14
**Plan:** `/root/.claude/plans/polished-brewing-knuth.md`
**Status:** P0 complete

## 1. Service name cross-matrix (5 sources must agree)

All 10 services have identical names across every configuration layer:

| # | `nats.conf` user var | Compose env default | Helm values.yaml | Cert CN (generate script) | Deploy workflow canonical |
|---|---|---|---|---|---|
| 1 | `$NATS_AUTH_USER`         | `auth_service`         | `authUser: auth_service`         | `auth_service`         | `set_canonical NATS_AUTH_USER auth_service` |
| 2 | `$NATS_FARM_USER`         | `farm_service`         | `farmUser: farm_service`         | `farm_service`         | `set_canonical NATS_FARM_USER farm_service` |
| 3 | `$NATS_SENSOR_USER`       | `sensor_service`       | `sensorUser: sensor_service`     | `sensor_service`       | ditto |
| 4 | `$NATS_GATEWAY_USER`      | `gateway_service`      | `gatewayUser: gateway_service`   | `gateway_service`      | ditto |
| 5 | `$NATS_NOTIFICATION_USER` | `notification_service` | `notificationUser: notification_service` | `notification_service` | ditto |
| 6 | `$NATS_BILLING_USER`      | `billing_service`      | `billingUser: billing_service`   | `billing_service`      | ditto |
| 7 | `$NATS_ALERT_USER`        | `alert_engine`         | `alertUser: alert_engine`        | `alert_engine`         | ditto |
| 8 | `$NATS_HR_USER`           | `hr_service`           | `hrUser: hr_service`             | `hr_service`           | ditto |
| 9 | `$NATS_MESSAGING_USER`    | `messaging_service`    | `messagingUser: messaging_service` | `messaging_service`  | ditto |
| 10 | `$NATS_HYDROPONICS_USER` | `hydroponics_service`  | `hydroponicsUser: hydroponics_service` | `hydroponics_service` | ditto |

**Verdict:** Five sources are currently in lockstep. services.yaml must preserve these 10 exact names.

**Source file references:**
- `infrastructure/docker/nats/nats.conf:28-239` (users[] array, 10 entries)
- `infrastructure/docker/scripts/generate-internal-certs.sh:97-101` (cert CN `for svc in ...`)
- `infrastructure/helm/aquaculture/values.yaml:444-463` (natsAuth block, 20 entries = 10 user+10 pass)
- `docker-compose.droplet.yml:395-401` (nats container env, 10 user+10 pass)
- `.github/workflows/deploy-digitalocean.yml:886-895` (set_canonical calls, 10 entries)

**One naming quirk:** `alert_engine` — NOT `alert_service`. Documented in ADR-014; preserved as-is (operational history, no reason to rename).

## 2. Complete ACL table per service

Source: `nats.conf:28-239`. This is the source data for P1's `services.yaml` content.

### 2.1 auth_service (lines 30-52)
**publish:**
- `AQUACULTURE_EVENTS.UserRegistered.>`
- `AQUACULTURE_EVENTS.UserLoggedIn.>`
- `AQUACULTURE_EVENTS.InvitationAccepted.>`
- `AQUACULTURE_EVENTS.PasswordResetRequested.>`
- `AQUACULTURE_EVENTS.PasswordResetCompleted.>`
- `AQUACULTURE_EVENTS.TenantCreated.>`
- `AQUACULTURE_EVENTS.TenantUpdated.>`
- `AQUACULTURE_EVENTS.TenantSuspended.>`
- `AQUACULTURE_EVENTS.TenantActivated.>`
- `AQUACULTURE_EVENTS.TenantStatusChanged.>`
- `AQUACULTURE_EVENTS.TenantModulesAssigned.>`
- `AQUACULTURE_EVENTS.UserInvited.>`
- `$JS.API.>`, `_INBOX.>`

**subscribe:** `AQUACULTURE_EVENTS.>`, `$JS.API.>`, `_INBOX.>`

### 2.2 farm_service (lines 54-74)
**publish:**
- `AQUACULTURE_EVENTS.Farm*.>`
- `AQUACULTURE_EVENTS.Batch*.>`
- `AQUACULTURE_EVENTS.Feeding*.>`
- `AQUACULTURE_EVENTS.WaterQuality*.>`
- `AQUACULTURE_EVENTS.Mortality*.>`
- `AQUACULTURE_EVENTS.Cull*.>`
- `AQUACULTURE_EVENTS.Pond*.>`
- `AQUACULTURE_EVENTS.Task*.>`
- `AQUACULTURE_EVENTS.Equipment*.>`
- `AQUACULTURE_EVENTS.FeedInventory*.>`
- `$JS.API.>`, `_INBOX.>`

**subscribe:** `AQUACULTURE_EVENTS.>`, `$JS.API.>`, `_INBOX.>`

### 2.3 sensor_service (lines 76-104)
**publish:**
- `AQUACULTURE_EVENTS.Sensor*.>`
- `AQUACULTURE_EVENTS.Device*.>`
- `AQUACULTURE_EVENTS.Edge*.>`
- `AQUACULTURE_EVENTS.IoConfig*.>`
- `AQUACULTURE_EVENTS.LoRa*.>`
- `AQUACULTURE_EVENTS.WaterQuality*.>`
- `AQUACULTURE_EVENTS.Automation*.>`
- `st.language.>` (ST Language response subjects)
- `$JS.API.>`, `_INBOX.>`

**subscribe:**
- `AQUACULTURE_EVENTS.>`
- `request.sensor.>` (NestJS microservice request-reply)
- `st.language.>` (WebSocket-to-NATS bridge for IDE)
- `$JS.API.>`, `_INBOX.>`

### 2.4 gateway_service (lines 106-136) — shared with admin-api
**publish:**
- `AQUACULTURE_EVENTS.Gateway*.>`
- `AQUACULTURE_EVENTS.Tenant*.>` (admin-api publishes tenant lifecycle via this account)
- `AQUACULTURE_EVENTS.Admin*.>`
- `st.language.>` (ST Language bridge forwarding)
- `request.>` (cross-service request-reply)
- `$JS.API.>`, `_INBOX.>`

**subscribe:**
- `AQUACULTURE_EVENTS.>`
- `events.>` (WebSocket real-time bridges)
- `st.language.>`
- `_INBOX.>`
- `$JS.API.>`

**Note:** This account is shared between gateway-api container AND admin-api-service container. services.yaml can model this as a single service with a note, OR split into two entries. Proposed: single entry with description noting dual use.

### 2.5 notification_service (lines 138-156)
**publish:**
- `AQUACULTURE_EVENTS.NotificationSent.>`
- `AQUACULTURE_EVENTS.NotificationDelivered.>`
- `AQUACULTURE_EVENTS.NotificationFailed.>`
- `$JS.API.>`, `_INBOX.>`

**subscribe:**
- `AQUACULTURE_EVENTS.PasswordResetRequested.>`
- `AQUACULTURE_EVENTS.UserInvited.>`
- `AQUACULTURE_EVENTS.Notification*.>`
- `$JS.API.>`, `_INBOX.>`

### 2.6 billing_service (lines 158-177)
**publish:**
- `AQUACULTURE_EVENTS.Subscription*.>`
- `AQUACULTURE_EVENTS.Invoice*.>`
- `AQUACULTURE_EVENTS.Payment*.>`
- `$JS.API.>`, `_INBOX.>`

**subscribe:**
- `AQUACULTURE_EVENTS.TenantCreated.>`
- `AQUACULTURE_EVENTS.TenantStatusChanged.>`
- `AQUACULTURE_EVENTS.Subscription*.>`
- `AQUACULTURE_EVENTS.Invoice*.>`
- `AQUACULTURE_EVENTS.Payment*.>`
- `$JS.API.>`, `_INBOX.>`

### 2.7 alert_engine (lines 179-187)
**publish:** `AQUACULTURE_EVENTS.Alert*.>`, `$JS.API.>`, `_INBOX.>`
**subscribe:** `AQUACULTURE_EVENTS.SensorReading.>`, `AQUACULTURE_EVENTS.Alert*.>`, `$JS.API.>`, `_INBOX.>`

### 2.8 hr_service (lines 189-205)
**publish:**
- `AQUACULTURE_EVENTS.Employee*.>`
- `AQUACULTURE_EVENTS.Leave*.>`
- `AQUACULTURE_EVENTS.Attendance*.>`
- `AQUACULTURE_EVENTS.Certification*.>`
- `AQUACULTURE_EVENTS.Payroll*.>`
- `AQUACULTURE_EVENTS.Schedule*.>`
- `$JS.API.>`, `_INBOX.>`

**subscribe:** `AQUACULTURE_EVENTS.>`, `$JS.API.>`, `_INBOX.>`

### 2.9 messaging_service (lines 207-229)
**publish:**
- `AQUACULTURE_EVENTS.Message*.>`
- `AQUACULTURE_EVENTS.Channel*.>`
- `AQUACULTURE_EVENTS.RetentionPolicy*.>`
- `$JS.API.>`, `_INBOX.>`

**subscribe:**
- `AQUACULTURE_EVENTS.>`
- `request.messaging.>` (NestJS request-reply)
- `events.>` (@EventPattern from auth/admin)
- `$JS.API.>`, `_INBOX.>`

### 2.10 hydroponics_service (lines 231-239)
**publish:** `AQUACULTURE_EVENTS.Hydroponics*.>`, `AQUACULTURE_EVENTS.GrowCycle*.>`, `$JS.API.>`, `_INBOX.>`
**subscribe:** `AQUACULTURE_EVENTS.>`, `$JS.API.>`, `_INBOX.>`

## 3. Wildcard vs explicit patterns

Two distinct patterns observed:

- **Wildcard aggregate in subscribe:** many services use `AQUACULTURE_EVENTS.>` as a catch-all subscribe. This is intentional (consumers self-filter at handler level). Generator must preserve exactly — no sorting/normalization that could drop wildcards.
- **Explicit event-family publish:** services publish only the event types they own. Lists are frozen at the protocol boundary; adding a new event class requires updating services.yaml.

**Implication for generator:** emit subject strings verbatim from YAML, preserve ordering, do not dedupe `$JS.API.>`/`_INBOX.>` (these are universal NATS JetStream + request-reply subjects, every service needs them).

## 4. event-bus library duplicate connection logic

Confirmed: `platform/libs/event-bus/src/nats/nats-event-bus.ts:126-154` re-implements auth config reading + production warning independently of `libs/backend-common/src/nats/nats-connection.factory.ts`.

**Line 126-136** — independent env var reads:
```typescript
this.tlsEnabled = this.configService.get<string>('NATS_TLS_ENABLED', 'false') === 'true';
this.tlsCaPath = this.configService.get<string>('NATS_TLS_CA');
// ... 5 more TLS reads
this.authToken = this.configService.get<string>('NATS_AUTH_TOKEN');
this.authUser = this.configService.get<string>('NATS_AUTH_USER');
this.authPass = this.configService.get<string>('NATS_AUTH_PASS');
```

**Line 147-150** — duplicate production warning:
```typescript
if (!this.authToken && !this.authUser) {
  this.logger.warn('⚠️  SECURITY WARNING: NATS authentication is not configured in production!');
}
```

This warning fires false-positive under cert-only mode (legitimate auth IS the cert, not user/pass). Must be updated in P5.

**Decision for P5:** refactor to use `buildNatsConnectionOptions(serviceName)` from the shared factory. Single code path, guaranteed identical behavior across event-bus consumers and ClientProxy consumers.

## 5. Client factory already supports cert-only

Confirmed: `libs/backend-common/src/nats/nats-connection.factory.ts:132-138`:

```typescript
if (authToken) { options.token = authToken; }
else if (authUser && authPass) { options.user = authUser; options.pass = authPass; }
// else: no auth fields populated — user/pass simply omitted from CONNECT frame
```

nats.js honors undefined user/pass → fields omitted from wire-level CONNECT → server's `verify_and_map` consumes cert CN alone. Cert-only works TODAY with zero client code changes. The factory just needs explicit dual-mode logging (P4) to make the behavior auditable.

## 6. Backward compat: dev mode

Development environments mount `nats-tls.conf` (TLS disabled) + `nats-auth.conf` (auth disabled) — no mTLS, no cert. Under cert-only production refactor, dev continues with no-auth for local convenience.

**Factory behavior in dev** (after P4):
- `NATS_URL=nats://...` (not `tls://`)
- `NATS_AUTH_USER` / `NATS_AUTH_PASS` / `NATS_AUTH_TOKEN` all unset
- Factory branches to "no-auth dev mode" — connects without any auth fields
- Server (dev) accepts all connections

No breaking change for local developers.

## 7. Outbox worker + NATS consumers

Confirmed: `platform/libs/outbox/src/outbox-worker.service.ts` uses `NatsEventBus` (event-bus lib) for publishing. After P5 refactor, outbox worker automatically gets new cert-only auth via shared factory. No worker code changes needed.

## 8. Final verdict

- services.yaml content is fully derivable from nats.conf (Section 2)
- All 5 sources currently in lockstep (Section 1); drift prevention is the goal
- Client-side cert-only already works (Section 5); P4 just formalizes
- event-bus duplicate logic must be refactored in P5 (Section 4)
- Dev mode unaffected (Section 6)

**Ready to proceed with P1 (create services.yaml).**
