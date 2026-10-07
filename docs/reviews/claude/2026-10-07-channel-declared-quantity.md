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
  registry quantity id. It is NULL for every existing row, so today's channels
  keep their key's meaning.
  - Migration `1820000000000` runs once per schema, like the orchestrator does,
    and skips a schema without the table.
  - No SQL CHECK lists the ids: a migration cannot follow the registry as it
    grows. The one write path checks them.
- **`declareChannelQuantity(channelId, quantity, unit?)`** (TENANT_ADMIN or
  MODULE_MANAGER) stores or clears a declaration. It refuses:
  - an unknown id;
  - a quantity the key does not allow. The key's alternates and family
    members are allowed, and any quantity is allowed for an unknown key.
  - a unit that is not a spelling of the quantity's unit.
  - The optional unit is written in the same step. So `do` declared as
    % saturation moves its unit to `%` atomically, rather than after a
    mismatched edit.
- **`updateDataChannel`.** On a declared channel, a unit change must stay a
  spelling of the declared quantity's unit. Undeclared channels keep their
  old, unchecked unit edits, so existing flows are unchanged. Binding (PR-3)
  checks the unit of an undeclared channel.
- **Read fields on a channel.**
  - `declaredQuantity`.
  - `quantity`: declared, else named by the key, else null.
  - `quantityFamily`.
  - `declarableQuantities`: what the picker may offer.
  - A stored value that is not a registry id reads as no declaration.

Not changed: the flat reading event still projects by key. A declaration
reaches it when the event carries the quantity (SENSOR-MEDIUM-169).

Proof:

- `channel-quantity.spec.ts`:
  - quantity and family views;
  - each refusal reason;
  - store, clear, refuse without writing, and another tenant's channel
    reads as not found;
  - an alternate declared with its unit in one write;
  - a declared channel's unit kept compatible, while undeclared edits are
    untouched.
- `add-channel-declared-quantity.migration.postgres.spec.ts` on real Postgres:
  the nullable column is added idempotently, existing rows stay NULL, a
  schema without the table is skipped, and down drops the column.
