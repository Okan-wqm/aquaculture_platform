# Water-chemistry binding UI and live charts (2026-10-08)

PR-5 of the water-chemistry channel-binding plan. It puts a UI on the binding API (PR-3,
`2026-10-08-wq-channel-binding.md`) and the reading resolver (PR-4,
`2026-10-08-wq-reading-resolver.md`), and retires the sensor-module mock.

## What was missing

### FARM-HIGH-384 — nothing called the binding API, and the sensor page was a mock

No screen bound a water-quality parameter to a sensor channel, and no screen read a value through
`waterChemistryInputs`. The farm calculator ran on hand-typed values only. `/sensor/water-chemistry`
drew charts from a mock `READINGS` table, with cards and systems kept in `localStorage`
(`wc-cards-v1`, `wc-systems-v1`). Closed by this PR.

### FARM-LOW-370 — the history table named a unit from tankId only

Rows filed at water equipment or a system showed `-`. The unit column now names the one point a
measurement carries (`tankId`, `equipmentId` or `systemId`), by name. Closed by this PR.

## Ownership

- shared-ui `water-chemistry/sources/` (main barrel, no data hooks): the two read documents both
  remotes send (`parameterSourcesAtPoint`, `waterChemistryInputs`) and their result types derived
  from codegen; the problem vocabulary (`PROBLEM_FIX`, `problemText`, `bindingRefusal`); point
  refs; `applyResolved`; `problemFixPath`; `ProblemChips` and `ParameterSourceTile`.
  `DEFAULT_WATER_CHEMISTRY_INPUTS` moved here from the farm page.
- farm-module owns every binding write and the quantity declaration.
- sensor-module owns the live view and the channel-meaning fix (`ChannelQuantitySelect`).
- The `water-chemistry/components` subpath is unchanged (recharts, no shared-ui context).

## Problem vocabulary

`PROBLEM_FIX` is a `Record` over every code the API answers with: the channel-binding rule,
`ReadingProblem`, `ReadingUnresolved`, `WaterChemistryInputProblem` and
`WaterChemistrySetProblem`. Message keys are template literals over the same union
(`wqSource.problem.<CODE>`, `wqSource.error.<CODE>`). A code added to the API without an owner
or en/tr text fails `tsc` — PR-4's later `NOT_SAME_SAMPLE` and `CoherenceWindow.DAILY` were
caught that way, then worded. `bindingRefusal` reads `extensions.code` and `context.problems` from
the shared client's `graphqlErrors` (or graphql-request's `response.errors`).

## Farm module

### Sources tab

`?tab=sources&point=tank:<id>` (the URL form fix links use). A point picker (site filter, then a
system, tank, water equipment or the site), then one row per active parameter. The calculation's
inputs come first (DOSING at a system, TOXICITY at a tank), each with its input problems. Tiles
show the primary, the backup and the manual line. Writers bind, add a backup, replace and
unbind; unbinding a primary says which backup took over. `useCanMutate` gates every write;
MODULE_USER reads.

### Bind dialog

Sensor (narrowed to the site when known), then channel, then the debounced dry run
(`checkParameterChannelBinding`), its problems, then Bind. Channels measuring the parameter's
quantity are listed first; the rest stay visible, disabled, with the reason. Bind stays disabled
until the dry run passes. A refused write shows its stable code and problems. A 503
(`SENSOR_DIRECTORY_UNAVAILABLE`) says nothing was decided and offers Retry.

### Parameters tab

`MeasuredQuantityField` declares or clears the measured quantity on its own write. While
`liveChannelSourceCount > 0` the select and the unit are disabled, with the `PARAMETER_BOUND`
text. A refusal shows by its stable code.

### Calculator

`ValuesSourceBar`: Manual, or a system/tank. For a point, `applyResolved(manual, [set])` fills the
covered fields; each shows its value, kind, age, window and problems, and can be corrected for
the session. A covered field with no value is never filled: the charts are replaced by the list
of missing values.

### Cleanup

`useParamEquipmentMapping` no longer sends `sensorId` (the backend refuses it on a plan line) and
no longer passes `enabled` as a GraphQL variable.

## Sensor module

The mock store and everything that read it are deleted: `useWcCards`, `useWcSystems`,
`systemModel`, `mock/fixtures`, the canvas, both drawers, `engine-adapter` and their four specs.
`clearRetiredMockStorage` removes the two keys without reading them.

### Monitoring view

`WaterChemistryMonitoringPage` has one tab per active system (`systems` query). The routes
`water-chemistry/system/:id` and `water-chemistry/tank/:id` are kept, a tank opening its system.
`WcSystemView` overlays every point of the loop on one Deffeyes diagram:

- a tank reads `[TOXICITY at the tank, DOSING at its system]`;
- alkalinity, calcium and volume come from the loop's DOSING set and are shown as the system's;
- the system point has no TAN or H2S of its own, so it is listed as not drawn, with the reason.

Monitoring calls `applyResolved` with `uncovered: 'missing'`: no measured value is ever
defaulted. `WcPointPanel` shows the chart, `ResultsPanel` and a tile per source
(`parameterSourcesAtPoint`, 30 s). Each tile has a 24 h sparkline from `useChannelSeries`, narrowed
to its channel by the server. A tile opens `MultiParameterTrendCard`. Only the chart type is
stored (`useTenantScopedStorage`).

### Fix links

`problemFixPath` is the one map both views use. Channel problems open
`/sensor/devices/:id?tab=channels&channel=<key>`, where `DeviceDetailPage` opens the channel
manager and marks the channel; its new `ChannelQuantitySelect` declares or clears the channel's
quantity. Parameter and source problems open the farm Parameters and Sources tabs.

## Backend additions

- `channelSeries(channelKeys)`, validated in the service, with an RLS postgres case.
- `WaterQualityParameterConfig.liveChannelSourceCount`, through `CountLiveChannelSourcesQuery`,
  counted by the rule the writers refuse on.

## Tracked, not done here

- FARM-MEDIUM-385 — no `bindableChannels(parameterConfigId, point)` query. The dialog judges
  quantity fit client-side and learns placement only from the dry run.
- FARM-MEDIUM-386 — targets and toxic limits have no per-system or per-species configuration;
  the monitoring zones use `DEFAULT_WATER_CHEMISTRY_INPUTS`.
- FARM-LOW-387 — a source change made elsewhere shows up only on the 30 s refetch.

## Verification

- vitest: shared-ui, farm-module, sensor-module, aquamobil (`TZ=UTC`); `tsc` for each project.
- `node scripts/ci/validate-graphql-operations.mjs`: no drift. The fragment-assembled documents
  were also validated in full against the composed supergraph.
- sensor-service: `input-sanitizer.spec`, `channel-reading-query.rls.postgres.spec`.
- farm-service: `count-live-channel-sources.handler.spec`.
- The e2e smoke gained a Sources-tab case for MODULE_USER; it was not run here (no shell build).
