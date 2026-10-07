# What a channel is, now, by its key (2026-10-07)

PR-2b of the water-chemistry channel-binding plan, on top of #1847.

## SENSOR-MEDIUM-171 — nothing answers "what is this bound channel now"

Farm binds water-chemistry inputs to sensor channels by their stable natural
key (sensorId, channelKey), because channel ids change when a device is
rediscovered. To validate a binding (PR-3) and to read its value (PR-4), farm
needs to know whether the channel still exists and is enabled, where its
sensor stands, what quantity it reports in which unit, and its last value.

No query gave that by key. The readings page asked per sensor and dropped
disabled channels. Without one answer, farm would either copy channel fields
into its own rows, where they go stale, or ask several sensor queries that
could disagree.

### Fix

- **One answer.** `ChannelDescriptionService.describe(tenantId, keys)` returns
  one description per asked key, in request order. Each description has:
  - `presence`: `FOUND`, `NO_SENSOR` or `NO_CHANNEL`;
  - the sensor's active flag and its site, system and tank;
  - the channel id and whether it is enabled;
  - the effective quantity and quantity family, from the registry;
  - the unit and the calibration due date;
  - the last value, time and quality code inside the readings page's
    freshness window.

  Disabled channels and inactive sensors are described, not dropped. A
  binding to a switched-off probe says so instead of vanishing.
  - It runs as one SQL statement in the tenant's RLS boundary:
    `unnest … WITH ORDINALITY`, left joins, and a per-channel `LIMIT 1`.
  - A non-uuid sensor id is answered as `NO_SENSOR` without a read.
  - The cap is 100 keys per request.

- **Two doors to it, both thin.**
  - NATS `request.sensor.describeChannels`, contract in
    `@platform/event-contracts` `sensor-channel-queries`:
    - the request is validated exactly;
    - the reply validator requires every documented field and tolerates
      unknown ones, so sensor can add a field without breaking farm.
  - GraphQL `channelsByKey(keys)`, the same service, for the picker.
  - farm-service gains publish permission on the subject (services.yaml,
    nats.conf regenerated). sensor-service already subscribes to
    `request.sensor.>`.
- **Responder** like farm's time-zone responder. A malformed request is
  refused before any read, and a failed read is reported as an unavailable
  authority, never as an empty answer.

How fresh is fresh enough for a calculation is the caller's decision (PR-4).
Values come in the channel's unit; `toCanonicalUnit` converts them.

Proof:

- `channel-description.rls.postgres.spec.ts`, real Postgres, FORCE RLS,
  non-owner role:
  - request order;
  - all three presences;
  - another tenant's sensor reads as `NO_SENSOR`;
  - a non-uuid id;
  - a declared family member (`ammonia` declared as TAN);
  - sensor location and the calibration due date;
  - a disabled channel described, whose sample is older than the window, so it
    has no latest value;
  - the 100-key cap.
  - Mutation check: shifting the ordinal mapping by one fails it.
- `sensor-channel-queries.spec.ts`: exact requests and tolerant replies.
- `describe-channels.responder.spec.ts`: queue, tenant pass-through, refusal
  before read, unavailable authority.
- `channel-description.dto.spec.ts`: the GraphQL date mapping.
