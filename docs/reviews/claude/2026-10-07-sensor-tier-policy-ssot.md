# Sensor-reading tier policy — one owner (2026-10-07)

Phase 1 of the sensor-history plan, raised by the plan's architecture
red-team.

## SENSOR-MEDIUM-149 — tier facts written by hand in many places

The facts that decide how far back a reading can be asked for, which store
answers it, at what resolution, and how long each store keeps it, lived as
separate literals:

- the 365-day series cap: `sensor-query.service.ts` and
  `channel-reading-query.service.ts`;
- the store thresholds (1 h / 24 h / 720 h): `metric-source.ts`;
- the display ladder: `getOptimalInterval` in `sensor-query.service.ts`;
- the interval whitelist: `input-sanitizer.ts`, beside the GraphQL
  `AggregationInterval` enum;
- the rollup refresh windows, 1-year / 5-year retention, bucket widths and
  table names: SQL literals in `sensor-continuous-aggregate-definition.ts`;
- the manual-refresh horizons: `continuous-aggregate.service.ts`;
- the as-of lookback: `metric-source.ts`.

A retention change made in the rollup SQL would not reach the store choice,
and charts would read a store that no longer holds the data.

Fix: `libs/shared-contracts/src/sensor-readings/tier-policy.ts` holds them all
as `as const` tables (shared-contracts declares no enums). Every reader
derives from it:

- the series queries take the cap and the ladder;
- `metric-source` takes the tables and the store choice;
- the sanitizer whitelist is the policy's list;
- the GraphQL enum is checked against the list in both directions at compile
  time;
- the rollup DDL interpolates every interval, bucket width and table name;
- the refresh horizons come from the minute tier's retention.

Behaviour is unchanged:

- the generated rollup SQL and aggregate names are byte-identical to the
  previous literals (compared before and after);
- golden tables in `libs/shared-contracts/src/__tests__/sensor-tier-policy.spec.ts`
  pin the old ladder and store boundaries;
- that spec also pins a property the code only claimed in a comment: the
  display interval is never finer than the native bucket of the store it is
  read from.

`tests/invariants/sensor-tier-policy-ssot.spec.ts` fails on the shapes the
copies took: SQL literals in the rollup DDL, the cap expression, the
threshold comparisons and the whitelist array in sensor-service.

Not in this change: the browser's range presets (`readingsModel.ts`, the
widget and heatmap maps). They move onto this module with the date-range UI
phase, whose picker needs the cap and retention from the same table.

## SENSOR-HIGH-159 — the shared library did not load under CommonJS

`libs/shared-contracts/package.json` exported only the ESM `import`
condition. The browser bundlers and the service build were unaffected:
Vite takes `import`, and `tsc-alias` rewrites the path to a relative one.
CommonJS resolvers could not load the package (`require.resolve` gives
`ERR_PACKAGE_PATH_NOT_EXPORTED`). That covers the e2e jest suite and
backend-common's jest config. Once the rollup DDL imported the tier policy,
the `schema-invariants` and `tenant-clone-parity` gates failed to load
before testing anything. This pull request did not trigger that workflow;
the next one that did, #1823, showed it.

Fix:

- The package exports `require` and `default` beside `import`.
- The tier policy is exported from the package root, and every importer uses
  the root. A subpath like `@aquaculture/shared-contracts/sensor-readings/...`
  is not in `exports`, and the e2e TypeScript resolution cannot follow it.
- `shared-contracts-no-enum-drift.spec.ts` allows the tier-policy module in
  the barrel.

Proof: the e2e `schema-invariants.spec.ts` now loads and reaches its database
connection locally, where before it failed on the module.
