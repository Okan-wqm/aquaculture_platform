# Measured-quantity registry (2026-10-07)

PR-1 of the water-chemistry channel-binding plan. Before an input on either
water-chemistry page can be bound to a sensor channel, the platform has to
agree on what a channel measures, in which unit and on which basis. It did not.

## SENSOR-MEDIUM-167 — one quantity, several vocabularies that disagreed

What a channel key means was written down in five places:

- the reading event's channel-key map (event-contracts);
- the sensor parameter catalog (units and ranges);
- the AI sensor tool's unit guesses;
- the farm water-quality templates and tenant seed;
- the farm measurement fields and the water-chemistry pages.

They disagreed:

- **Which keys exist.** `waterlevel` and `dissolvedoxygen` were readable by the
  ingest path but not registrable through the catalog.
- **Units.** The AI tool suggested `hPa` for a field named `pressure` and `ppt`
  for `tds`, while sensor discovery creates those channels in `bar` and `ppm`.
  The farm templates wrote pH's unit as `''` beside the seed's `pH`, and
  alkalinity as `mg/L CaCO₃` beside the catalog's `mg/L CaCO3`.
- **Basis.** A key like `ammonia` or `nh3` does not say whether the probe reports
  total ammonia nitrogen, un-ionized NH3-N or ammonium. Those differ by up to
  two orders of magnitude at farm pH. Hydrogen sulfide is µg/L in the chemistry
  engine.

### Fix

`libs/shared-contracts/src/measurement/quantities.ts` owns the vocabulary:

- every quantity, with its canonical unit, the unit spellings accepted as input
  and its basis;
- every channel-key spelling, with the quantity it names, or the family it
  names when the key does not say which member;
- for the nine keys the flat reading event carries, its reading parameter.

`ammonia` and `nh3` name the ammonia family. Until an operator declares the
member, `effectiveQuantity` has no quantity for them, so they cannot feed a
calculation that depends on basis. PR-2 stores the declaration.

The other copies now derive from the registry:

- **event-contracts.** `parameterForChannelKey` projects the registry's table.
  `SensorReadingParameter` is the registry's `ReadingParameter`. A spec pins
  the exact 25 keys the event carried before, so nothing on the wire changes.
- **Sensor catalog.** One presentation per quantity (type, label, range), with
  units from the registry. The keys are every registry spelling, so
  `waterlevel` is registrable, plus new keys for H2S, sulfide, calcium,
  hardness, ozone and oxygen saturation.
  - Two spellings of one quantity now share a definition, so their labels
    agree: `water_temp` reads "Temperature", not "Water Temperature".
  - `lookupParameter('constructor')` no longer returns `Object`.
- **AI sensor tool.** An exact channel key takes its registry unit. Name
  fragments that name a registry quantity (`temp`, `ph`, `oxygen`, `salinity`,
  `tds`, `pressure`, `hum`) take that quantity's unit. Others (wind, power,
  lux) keep their own.
- **Farm templates and seed.** `PARAMETER_CODE_QUANTITY` (farm-owned) says
  which quantity each farm parameter code records. Its unit comes from the
  registry. The farm's `ammonia` code is un-ionized ammonia: its thresholds,
  0.02–0.05 mg/L, are a toxicity limit. It is recorded as N, like the engine's
  NH3-N.
  - New templates write pH as `pH` and alkalinity and hardness as
    `mg/L CaCO3`.
  - Existing tenant configs are not rewritten. The old spellings stay accepted
    input for the same quantity (`isAcceptedUnit`).

Gate: `tests/invariants/measured-quantity-vocabulary-ssot.spec.ts` fails when
any file except the registry declares an object keyed by two or more alias
spellings, which is the shape every earlier copy had. It was mutation-checked
twice and caught both mutations:

- a probe file with two alias keys;
- event-contracts restored to its literal table.

Proof:

- the registry spec: family units agree, declarations are checked against the
  key's family, and lookups use own keys only;
- the event-contracts 25-key pin;
- the catalog spec: every spelling is in the registry unit, and spellings of
  one quantity share one definition;
- the farm spec: template and seed units equal the registry's;
- the AI tool spec: `pressure` is `bar`, `tds` is `ppm`, `pond_temp_c` is °C.

The admin OpenAPI artifact was regenerated in this PR. See CONTRACT-LOW-011.

## FARM-MEDIUM-363 — two services seed the default water-quality parameters

Two services seed a new tenant's water-quality parameter configs, from separate
lists:

- admin-api-service provisioning had a saga step that inserted 12 parameter
  configs straight into farm's per-tenant `water_quality_parameter_configs`,
  with its own thresholds and spellings (`mg/L CaCO₃`), and deleted them again
  on compensation;
- farm's onboarding handler seeds its own 7 when it receives
  `TenantOnboardingRequested`.

The finding first said admin's list wins. Reading the call sites corrected
that: the step ran only when `skipSchemaCreation` was false, and the one caller
(the provisioning workflow) passes true, which is also the default. So tenants
got farm's set, and admin's was a second writer kept in code, not in use.

Fix (closed):

- the admin step, its 12-entry list and the `skipSchemaCreation` option, which
  gated nothing else, are deleted;
- farm's seeder, whose units come from the registry, is the one owner;
- `tests/invariants/admin-no-tenant-table-writes.spec.ts` fails on any admin
  raw-SQL write to a named table in a runtime-built schema. Run against the old
  code, it reported both lines (the insert and the compensating delete).
- The database explorer's generic row editor names no table and is not matched.

No runtime behaviour changes. A new tenant still gets farm's set.

## FARM-MEDIUM-364 — manual-measurement and channel units outside the registry (open)

These units are still not read from the registry:

- the farm measurement entity documents `hydrogen_sulfide` in mg/L, while the
  engine and the templates use µg/L;
- the farm history table formats values with its own unit map;
- the channel editor offers its own unit list.

Fix:

- PR-4's reading resolver reads manual measurements through the registry, so a
  manual H2S value is in the engine's unit;
- PR-5's shared picker and history formatting take units from the catalog query.

Owner: claude. Deadline: 2026-10-21.

## CONTRACT-LOW-011 — admin OpenAPI enum order follows the compiler's type ids (open)

The admin OpenAPI generator writes a union's members in the TypeScript checker's
internal order, not the declaration's. Adding string literals anywhere in the
program can therefore reorder enums in unrelated DTOs, as this PR did for note
categories. That turns the artifact gate red on a PR that changed no admin
contract.

Fix: the runner writes each enum in declaration order, or sorted, so the
artifact changes only when a contract does.

Owner: claude. Deadline: 2026-10-28.
