# Reading a water-chemistry input from its sources (2026-10-08)

PR-4 of the water-chemistry channel-binding plan (rev2 decisions D2, D3, D12). It builds on
PR-3.1/3.2 (`2026-10-08-wq-channel-binding.md`): sources at measurement points, the binding rule
(`channelProblems` + farm placement) and `SensorChannelDirectory`. Backend only; the UI switch
is PR-5.

## What was missing

### FARM-HIGH-379 — bound sources fed nothing

A channel bound to a parameter at a point was listed with its problems, and nothing read a value
from it. No reader applied the inheritance rule (D2) or the coherence windows (D3), and the
calculators took hand-typed values or the sensor-module mock `READINGS` table.

## The reading resolver

One reader answers "the value of parameter P at location L, now": `ParameterReadingResolver`
gathers the facts and `resolveReading` (pure, `services/reading-resolution.ts`) decides.

### Precedence

At each level the first candidate that yields a value answers: the primary channel, the backup
channel, then the latest sample a person took there (`manual`, `lab_analysis`, `calibration`;
`MACHINE_MEASUREMENT_SOURCES` is now the one list the create input's `IsHumanMeasurementSource`
and the resolver share). Levels are the location itself, then — only for a quantity the registry
marks `loopHomogeneous` — the system it belongs to and its site, labelled inherited
(`inheritedFrom`). DO, pH, CO2, the nitrogen species and sulfide never inherit. The chain is
read from farm's topology now (`loadFarmArrangement`, the read placement uses too, which now
also returns each system's type). After review (FARM-HIGH-381):

- a recirculating loop (RAS, aquaponics, biofloc — `isRecirculating`, the set DOSING refuses by)
  and its units never inherit from the site;
- a unit in a non-recirculating system inherits from the system, then the site; a unit in no
  system from the site;
- a unit in two or more live systems inherits nothing.

A site has no manual samples (a sample names a tank, equipment or system), and an inlet/outlet
or depth location has none either.

### Read-time placement (D12)

Each channel is judged by the bind's own rule at the read (`bindingProblems`: the shared
`channelProblems` plus farm placement from the sensor's location now). A sensor moved away, a
channel disabled or re-declared since it was bound is skipped with its `ChannelBindingProblem`
codes. This is the "now" half of FARM-MEDIUM-378.

### Conversion and freshness

A channel's sample is carried from its unit into the asked unit through the registry (new
`fromCanonicalUnit` and `convertUnit` beside `toCanonicalUnit`). A manual value is in its
parameter's unit (fixed once values exist, D7). A channel with no sample is `NO_SAMPLE`, a BAD
sample `SAMPLE_QUALITY_BAD`; UNCERTAIN is used and labelled. Every answer carries `asOf`,
`observedAt` and its age. The resolver applies no window of its own: a caller that needs a
recent value passes `maxAgeMs`, and an older candidate is skipped (`OLDER_THAN_WINDOW`) so the
next one can answer.

## The input sets (D3)

`data/water-chemistry-input-sets.ts` says what the engine (`computeWaterChemistryOutputs` over
`@platform/aquaculture-engines`) needs measured and where; no second calculator.

- DOSING at a system point: pH, alkalinity, temperature, salinity, calcium, and the loop's
  volume (`System.totalVolumeM3`).
- TOXICITY at a tank point: pH, temperature, salinity, TAN, H2S. H2S is paired with its pH
  (`pairedWith`): read at the same point and observed within `PAIRING_TOLERANCE_MS` (15 min) of
  it, else `NOT_AT_SAME_POINT` / `NOT_SAME_SAMPLE` (FARM-MEDIUM-382).
- Each input is handed over in its quantity's canonical unit, which is the engine's (a spec pins
  °C, pH, ppt, mg/L CaCO3, mg/L as N, µg/L, mg/L as Ca).
- Windows: SHORT 4 h for pH, temperature, TAN, H2S; DAILY 24 h for DOSING's alkalinity (a dose
  applied after the last sample is invisible to the recipe); LONG 48 h for salinity, calcium.
  The set passes each input's window to the resolver, measured back from one `asOf`.
- Verdict: `REFUSED` for a loop that is not RAS, aquaponics or biofloc
  (`SYSTEM_NOT_RECIRCULATING`), whose volume is null or not positive (`VOLUME_MISSING`) or
  smaller than the water its active tanks hold (`VOLUME_BELOW_TANK_WATER`); `INCOMPLETE` when an
  input has `NO_PARAMETER`, `NO_VALUE`, `NOT_AT_SAME_POINT` or `NOT_SAME_SAMPLE`; else `READY`.

The input set's parameter for a quantity is the one active config recording it (the
`effectiveQuantity` unique). `System.totalVolumeM3` and `Tank.waterVolume` are typed
`number | null` now: the decimal transformer reads a NULL column as null, which the old types
hid.

## GraphQL API (for PR-5)

Queries, TENANT_ADMIN / MODULE_MANAGER / MODULE_USER; a MODULE_USER only at a point of an
assigned site (`assertPointReadable`, now shared with `parameterSourcesAtPoint`):

- `resolvedParameterValue(input: ResolvedParameterValueInput!): ParameterReading!`, the input
  `{ parameterConfigId, point: MeasurementPointInput, position?, depthM?, maxAgeSeconds? }`
  — `value`, `unit` (the parameter's), `sourceKind` (`CHANNEL_PRIMARY`, `CHANNEL_BACKUP`,
  `MANUAL`), `resolvedAt`, `inheritedFrom`, `sourceId`, `sensorId`, `channelKey`,
  `measurementId`, `observedAt`, `ageSeconds`, `quality`, `asOf`, `skipped[]`
  (`bindingProblems`, `readingProblems`), `unresolved` (`NO_SOURCE`, `NO_USABLE_SOURCE`).
- `waterChemistryInputs(point: MeasurementPointInput!, set: WaterChemistryInputSet!)`, a
  `WaterChemistryInputsResult!` — `verdict`, `problems`, `systemType`, `volumeM3`,
  `tankWaterM3`, `inputs[]` (`engineInput`, `quantity`, `unit`, `coherenceWindow`,
  `windowSeconds`, `parameterConfigId`, `reading`, `problems`). A set asked at the wrong kind
  of point is a 400.

`ReadingProblem`: `NO_SAMPLE`, `SAMPLE_QUALITY_BAD`, `OLDER_THAN_WINDOW`, `VALUE_NOT_NUMERIC`,
`UNIT_NOT_CONVERTIBLE`. Permission matrix, farm SDL and shared-ui codegen regenerated.

## Proof

- `reading-resolution.spec.ts`: precedence, conversion, binding and reading skips, the window,
  inheritance labels, manual units, NO_SOURCE vs NO_USABLE_SOURCE, a sample stamped ahead.
- `water-chemistry-input-set.spec.ts`: the engine's inputs and units pinned, inheritance from
  the registry, the windows, READY, every refusal, INCOMPLETE, H2S with its pH.
- `water-chemistry-reading.postgres.spec.ts` (real bind command, tenant schema as production):
  temperature inherited from a loop probe in °F; pH never inherited, a person's sample answers
  and a newer `sensor_auto` row does not; a primary whose sensor moved is skipped `NOT_AT_POINT`
  and the backup answers; TOXICITY READY with temperature from the system and salinity from a
  site probe; INCOMPLETE with a TAN sample older than its window; DOSING refused for unknown,
  too small and flow-through loops, READY otherwise; wrong point kind, unknown parameter and the
  MODULE_USER site gate. With read-time placement or the inheritance rule removed, 5 of its 7
  cases fail.
- Shared contracts: `fromCanonicalUnit` / `convertUnit` round trips for every unit.

## Open, tracked

- **FARM-MEDIUM-380:** no sensor-owned series contract, so no period read (deadline 2026-10-29).
  The resolver answers "now" only.
- **FARM-MEDIUM-378:** stays open for the period half: placement per period needs the series
  contract and the sensor's location history.
- **FARM-LOW-376:** still no writer files a sample at a system point; the resolver already reads
  `systemId` samples, so the writer (PR-5) needs no reader change.

## Farm review → fixes

### FARM-HIGH-381 — a recirculating loop took the site's water

The chain added the site for every loop-homogeneous quantity, so a RAS loop with only an intake
alkalinity probe was READY for DOSING on make-up water, scaled to the loop volume, and TOXICITY
read intake temperature and salinity. The rule above replaces it. Proof: a RAS loop and its tank
with only site sources resolve nothing and DOSING is INCOMPLETE; a flow-through loop's tank and
a tank in no loop still take the site temperature; equipment linked to two loops inherits
nothing. With the recirculation check removed the spec fails.

### FARM-MEDIUM-382 — H2S paired with its pH by place only

The engine converts H2S at the pH it is given; the set allowed the two 4 h apart. They must now
be observed within 15 minutes (unit spec at 15 and 16 minutes; postgres: 45 minutes apart is
INCOMPLETE with `NOT_SAME_SAMPLE`).

### Dosing alkalinity within a day

Accepted advisory: DOSING reads alkalinity within 24 h (`DAILY`); salinity and calcium keep 48
h. `CoherenceWindow` gains `DAILY` and `WaterChemistryInputProblem` gains `NOT_SAME_SAMPLE`
(additions only).

## Decisions to confirm

- The windows (4 h, 24 h, 48 h), the pairing tolerance (15 min) and the recirculating types
  (RAS, aquaponics, biofloc; hatchery, nursery and other refused for dosing until typed, and
  open water for inheritance) are one-line constants in the input-set table.
- "Too small" is a volume below the water the loop's own active tanks hold.
