# A channel says what it measures (2026-10-07)

PR-2a of the water-chemistry channel-binding plan, on top of the
measured-quantity registry (#1844).

## SENSOR-MEDIUM-170 — a channel cannot say what it measures

The registry knows what most channel keys measure. Some keys do not say:

- `ammonia`/`nh3` could be TAN, NH3-N, NH4-N or the NH4+ ion;
- `nitrite`/`nitrate` could be reported as N or as the ion;
- an optode may report `do` in % saturation;
- a vendor's `probe_7_ch2` says nothing at all.

The plan binds water-chemistry inputs to channels. Without a way to record a
channel's quantity, such a channel either cannot be bound, or is bound on a
guess.

### Fix

- **Column.** `sensor_data_channels.declared_quantity` is nullable and holds a
  registry quantity id.
  - It is NULL for every existing row, so today's channels keep their key's
    meaning.
  - A column transformer reads it through the registry. A stored value that is
    no longer an id reads as no declaration, the same way on every path.
- **History.** `channel_quantity_declarations` is append-only and records who
  declared or cleared what, when, with which unit. A declaration reinterprets
  every value the channel has reported, so its changes must be on record, as
  calibration's are (`calibration_events`).
  - It is written in the same transaction as the channel.
  - It is keyed by (sensor_id, channel_key) as well as the channel id, because
    rediscovery re-creates channels under new ids.
  - Query: `channelQuantityDeclarations(sensorId, channelKey)`.
- **Migration `1820000000000`** runs once per schema, like the orchestrator does,
  and skips a schema without the channel table.
  - No SQL CHECK lists the ids: a migration cannot follow the registry as it
    grows. The one write path checks them.
  - Tenant RLS picks up the ledger by its `tenant_id` column. It is listed in
    MODULE_SCHEMAS sensor tables.
- **`declareChannelQuantity(channelId, quantity, unit?)`** and
  **`clearChannelQuantity(channelId)`** (TENANT_ADMIN or MODULE_MANAGER)
  record the caller (`sub`) as actor.
  - A declaration is refused for an unknown id; a quantity the key does not
    allow (alternates and family members are allowed, any quantity for an
    unknown key); or a unit that is neither a spelling of the quantity's unit
    nor one it converts from.
  - The optional unit is written in the same step. A declared channel without a
    unit gets the canonical one.
  - Clearing is its own mutation, so a client that omits the quantity cannot
    clear a declaration.
- **One row lock for every channel read-check-write.** Configuration edits,
  declarations, clears, calibration and discovery sample updates all load the
  row `FOR UPDATE` inside their transaction (`lockChannel`). No writer can save
  a stale copy over another's change. Before this, a configuration edit that
  loaded the row a moment earlier could write NULL over a fresh declaration.
- **`updateDataChannel`.** On a declared channel, a unit change must stay a
  unit of the declared quantity. Undeclared channels keep their old, unchecked
  unit edits, so existing flows are unchanged. Binding (PR-3) checks the unit
  of an undeclared channel.
- **Rediscovery that replaces channels** carries each key's declaration to the
  re-created channel when the rediscovered unit still fits. Otherwise it ends
  the declaration on record (`rediscovery_cleared`, actor
  `system:rediscovery`). Calibration and thresholds are still reset by a
  replace, as before.
- **Read fields on DataChannelType.**
  - `declaredQuantity`.
  - `quantity`: declared, else named by the key, else null.
  - `quantityFamily`.
  - `declarableQuantities`: what the picker may offer.
  - The entity's own GraphQL type no longer exposes the column. One channel
    type carries all of these.

Units now convert as well as spell. The registry gives each quantity the other
units devices use and their linear map to the canonical unit:

- °F and K to °C;
- mS/cm and S/m to µS/cm;
- m and mm to cm;
- mg/L to µg/L for H2S and sulfide;
- kPa and psi to bar, kPa to hPa;
- m3/h and L/s to L/min.

PR-4 converts at read time (`toCanonicalUnit`). A seawater EC probe in mS/cm
is declared as it is, not relabelled as µS/cm without rescaling.

Not changed: the flat reading event still projects by key (SENSOR-MEDIUM-169).
No declaration can move a value onto another reading parameter: the registry
spec requires every alternate to land on its key's own parameter.

Proof:

- `channel-quantity.spec.ts`:
  - the row lock;
  - declare with a ledger row naming the actor;
  - a convertible unit, and a unitless channel getting the canonical one;
  - refusals write nothing;
  - another tenant's channel reads as not found;
  - clear on record, and a no-op clear;
  - the unit check on declared channels only;
  - rediscovery carrying a declaration, or ending it on record.
  - Mutation check: dropping the ledger write fails it.
- `channel-resolver-quantity.spec.ts`: the mutation wiring (actor, quantity,
  unit) and the field resolvers.
- `calibration.service.spec.ts`: calibration reads under the row lock.
- The registry spec:
  - quantity ids are pinned append-only and ≤32 characters, because they are
    persisted;
  - alternates keep the key's reading parameter. Mutation check: putting % saturation back on `do` fails it.
  - conversions (°F, K, mS/cm, m, mg/L→µg/L).
- `add-channel-quantity-declarations.migration.postgres.spec.ts` on real
  Postgres: the column and ledger, idempotence, a skipped schema, down.

### Independent review → fixes

A sensor review of the first version (and of the registry fixes under it)
found one high, three medium and twelve low problems.

- **High: a declared alternate was published under the wrong parameter.** `do`
  declared as % saturation would still reach the flat event, and the alert
  engine, as dissolved oxygen in mg/L. The event projects by key.
  - % saturation is no longer a declarable alternate of `do`.
  - The registry spec forbids any alternate that lands elsewhere until the
    event carries the quantity (SENSOR-MEDIUM-169).
  - The reviewer also noted that the "95 % as 95 mg/L" catalog risk fixed in
    #1844 was reachable only through `ingestParentReading`, which has no
    production caller. The live wire projects by channel key.
- **Medium: declarations were mutable, unversioned and unaudited.** Fixed by
  the ledger, with the actor.
- **Medium: no unit conversions**, so a mS/cm probe could only be mislabelled.
  Fixed by the registry conversions.
- **Medium: lost update between channel writers.** Fixed by the row lock across
  every writer.
- **Low:**
  - two readings of a stored non-id: one transformer now;
  - a declared channel without a unit: it gets the canonical one;
  - omitting the quantity cleared a declaration: there is a separate clear
    mutation now;
  - replace-rediscovery lost declarations: carried over, or ended on record;
  - persisted ids unpinned: pinned;
  - a down migration without a lock timeout;
  - an untested resolver: spec added;
  - two GraphQL types for one channel: the entity no longer exposes the column;
  - a stale FE subgraph fixture: refreshed.
- **Left as recorded:**
  - generic keys `level`, `flow` and `signal` cannot be re-declared. They are
    part of the 25 wire keys, and the reading-parameter rule would refuse a
    re-declaration anyway. That is SENSOR-MEDIUM-169's work.
  - the vocabulary invariant's remaining blind shapes (`||` chains, Map-tuple
    tables in `mcp/farm-management`). These are part of SENSOR-MEDIUM-168.
