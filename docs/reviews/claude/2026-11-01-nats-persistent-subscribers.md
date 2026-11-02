# Long-lived NATS subscribers that connect once — 2026-11-01

Found on 2026-11-01 while checking production after the deploy of a6b3ad193. The gateway's farm
bridge had no NATS connection: it failed its first connect at 15:15:31Z, 19:01:24Z and 19:56:05Z
(after a manual restart) and never tried again, so live farm updates (batches, mortality,
feeding, stock, site and tank changes) stopped reaching browsers. The other three bridges
connected in the same boots.

## PLAT-HIGH-939

Defect. Six long-lived subscribers opened their NATS connection with one `connect()` at module
init and only logged a failure: the four gateway WebSocket bridges (farm, messaging, sensor, ST
language) and sensor-service's sensor lookup responder and ST language handler. The farm
bridge's comment said the status loop would reconnect, but that loop only starts once a
connection exists. Four of them also kept the factory's 50-attempt reconnect budget, so a
connected bridge closed for good after an outage of about 100 s.

Severity HIGH: a slow broker at boot silently disabled a live surface until the next restart.
Owner Okan-wqm, deadline 2026-11-03.

Where. `apps/gateway-api/src/websocket/farm-nats-bridge.service.ts:199`,
`messaging-nats-bridge.service.ts:114`, `nats-bridge.service.ts:130`,
`st-language-bridge.service.ts:126`, `apps/sensor-service/src/ingestion/sensor-lookup-responder.service.ts:278`,
`apps/sensor-service/src/automation/compiler/nats-handlers/st-language.handler.ts:68`, and the
budget at `libs/backend-common/src/nats/nats-connection.factory.ts:264`.

Fix. `PersistentNatsConnection` (`libs/backend-common/src/nats/`) owns the connection of a
long-lived subscriber. It connects in the background, so boot does not wait. A failed attempt is
retried with a growing delay (the factory's reconnect wait, doubling up to 30 s). Once
connected, the client reconnects without limit. If the broker closes the connection anyway, a
new one is made and the component's `onConnected` runs on it. Options come only from
`buildNatsConnectionOptions`. All six subscribers use it, and
`tests/invariants/nats-connection-owner.spec.ts` now fails when runtime code outside the four
connection owners imports `@nats-io/transport-node`.

Verified. `persistent-nats-connection.spec.ts` drives a real `@nats-io` client against a fake
broker on a local port: a broker that is away at the first attempt, an outage longer than a
reconnect budget of 1, a connection closed underneath, close while connecting, and close on a
live connection. Removing the retry, the unlimited reconnect or the replacement each turns one
test red.

## PLAT-MEDIUM-940

Defect. On every reconnect the gateway's sensor bridge and ST language bridge subscribed again
without unsubscribing. `@nats-io/nats-core` 3.4 resends every live subscription itself when a
connection is (re)established, so the old subscriptions kept delivering, and each reconnect
added one more delivery of every sensor reading, edge I/O, alarm and automation event to
WebSocket clients.

Severity MEDIUM. Owner Okan-wqm, deadline 2026-11-03.

Where. `apps/gateway-api/src/websocket/nats-bridge.service.ts:336-340` and
`st-language-bridge.service.ts:250-253`.

Fix. Components subscribe only in `onConnected`, once per connection; no component handles
`reconnect` any more. The farm and messaging bridges, which unsubscribed before subscribing
again, lose that redundant step too. The outage test above checks that a subscription made once
delivers once after the client reconnects.

## PLAT-MEDIUM-941 (registered, not fixed here)

The gateway composes its supergraph in-process at boot, and in the 19:01 and 19:55 boots every
bridge that had started connecting completed only after composition ended, while the broker
logged a TLS handshake timeout for the farm bridge. The likely cause is CPU-bound composition
holding the event loop for about 16 s; no event-loop lag measurement has been taken yet. With
PLAT-HIGH-939 fixed, a bridge caught by it retries and connects; the stall itself remains
tracked. Owner Okan-wqm, deadline 2026-11-30.

## Closed alongside

- INFRA-HIGH-238: the sensor and ST language bridges no longer read `NATS_AUTH_*` or `NATS_TLS_*`
  themselves; their options come from the factory through `PersistentNatsConnection`. The ARIA
  security-boundary adapter's real-tree baseline for these bridges is now empty.
- ORPHAN-MEDIUM-093: `libs/backend-common` and `platform/libs/event-bus` lint against their own
  `tsconfig.eslint.json` with `moduleResolution: Bundler`. `@nats-io/transport-node` re-exports
  `@nats-io/nats-core/internal`, a subpath that exists only in an `exports` map, so under the
  repo-wide node10 project `connect()` returned the error type. The event-bus exception is
  removed. The v3 transport files keep a narrower exception for Nest's `any`-typed packets. The
  e2e project still resolves with node10 and keeps its exception.
