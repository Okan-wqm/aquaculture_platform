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

- every quantity, with its canonical unit, the unit spellings accepted as input,
  its basis and, for the nine the flat event carries, its reading parameter;
- every channel-key spelling, naming either
  - a quantity, with the alternates devices also report under that key, which
    an operator may declare instead (`do` may be % saturation, `ec` specific
    conductance, `sulfide` total sulfide as S, `pressure` barometric hPa, `cl`
    chloride, `nh4` the NH4+ ion); or
  - a family whose member the operator declares: `ammonia`/`nh3` (TAN, NH3-N,
    NH4-N, NH4+), `nitrite`/`no2` and `nitrate`/`no3` (as N or as the ion,
    3.3× and 4.4× apart).

`effectiveQuantity(key, declared)` is the declared quantity when the key allows
it, else the key's quantity. A family key without a declaration has none, so it
cannot feed a calculation that depends on basis. PR-2 stores the declaration.

The other copies now derive from the registry:

- **event-contracts.** `parameterForChannelKey` is the registry's
  `readingParameterOfChannelKey`, and its own table is gone.
  - `SensorReadingParameter` is the registry's `ReadingParameter`.
  - A spec pins the exact 25 keys the event carried before, so nothing on the
    wire changes.
  - `constructor` and `__proto__` are not channel keys any more. Before, they
    returned `Object`, and a publish carrying them threw.
- **Sensor catalog.** One presentation per quantity or family (type, label,
  range), with units from the registry.
  - The keys are every registry spelling. `waterlevel` is now registrable, and
    there are new keys for H2S, sulfide, calcium, hardness, ozone and oxygen
    saturation.
  - A sensor type with a flat reading mapper goes only to a quantity whose
    reading parameter is that mapper's field. A spec checks every key against
    the mapper registry.
  - So `tan`, `total_ammonia` and `nh4` now register as MULTI_PARAMETER, not
    AMMONIA. A newly registered TAN child sensor stops publishing TAN as the
    event's `ammonia`. Existing sensors keep their stored type, see
    SENSOR-MEDIUM-169.
  - Two spellings of one quantity share a definition, so `water_temp` reads
    "Temperature".
- **AI sensor tool.** An exact channel key takes its registry unit. Name
  fragments that name a registry quantity take that quantity's unit.
  - `pressure` is `bar`. A weather station's hPa is the key's declarable
    alternate, which a name alone cannot tell apart.
- **Farm templates and seed.** `PARAMETER_CODE_QUANTITY` (farm-owned) says
  which quantity a farm code records, and its unit comes from the registry.
  - `ammonia`, `nitrite` and `nitrate` are not mapped. The farm records them
    without a basis: the labels say NH₃/NO₂/NO₃, and the thresholds fit either
    basis. An undeclared basis must not feed the chemistry, as the owner
    decided. Their configs get a declared quantity in PR-3.
  - New templates write pH as `pH` and alkalinity and hardness as
    `mg/L CaCO3`. Existing configs are not rewritten. The old spellings, and
    `NBS` for pH, stay accepted input.

Gate: `tests/invariants/measured-quantity-vocabulary-ssot.spec.ts` reads the
syntax tree of every source file and finds both shapes every earlier copy had:

- an alias table: one object, array or switch naming two spellings of one
  quantity, with the spellings read from the registry;
- a unit table: one object mapping three or more quantity names to unit
  strings.

Copies that predate the registry are listed with their finding. The list only
shrinks.

Proof:

- the registry spec: family units agree, alternates and family members are the
  only declarations accepted, and lookups use own keys only;
- the event-contracts 25-key pin, including `constructor` and `__proto__`;
- the catalog spec:
  - every spelling is in the registry unit;
  - spellings of one quantity share one definition;
  - sensor type and reading parameter agree. Mutation check: typing oxygen
    saturation as DISSOLVED_OXYGEN fails it.
- the farm spec: mapped codes are in registry units, and unmapped codes keep
  their own;
- the AI tool spec;
- the invariant's own probe of all four shapes.

The admin OpenAPI artifact was regenerated in this PR. See CONTRACT-LOW-011.

### Independent review → fixes

A data review of the first version found one high, four medium and five low
problems.

- **High: % saturation as dissolved oxygen.** The new `oxygen_saturation`
  catalog key was typed DISSOLVED_OXYGEN. A registered child sensor would have
  published 95 % as 95 mg/L dissolved oxygen. The type/mapper rule above fixes
  it and checks it.
- **Farm `ammonia` asserted as NH3-N.** The evidence did not support it. It is
  now unmapped, and so are `nitrite` and `nitrate`.
- **Nitrite and nitrate without a basis.** They are now families.
- **Declarations could not correct a key's common other meanings.** These are
  now alternates.
- **Unit and range copies not tracked.** They are now SENSOR-MEDIUM-168 and are
  listed in the gate.
- **Smaller fixes.**
  - The gate is now syntax-based and derived from the registry.
  - `parameterForChannelKey` follows own keys only.
  - The barometric fixture is restored.
  - The `ca` key is dropped: it is a generic field name.
  - The e2e lane maps shared-contracts.
  - shared-contracts may import no workspace library, which is enforced in
    `shared-contracts-no-enum-drift.spec.ts`.

## SENSOR-MEDIUM-168 — copies of the vocabulary outside the registry (open)

Several copies of the vocabulary disagree with the registry:

- frontend unit and alias tables: dashboard, sensor-module hooks, widget
  colours, the aggregated-reading field map and the water-chemistry mock. Water
  level is shown in m and alarmed in %, while channels store cm.
- a second reading-range table in sensor data quality: temperature −10..50
  against the catalog's 0..40.
- a second reading-field map in the gateway.

They are listed in the gate's `KNOWN_COPIES`. Removing them is PR-5's work: the
shared picker and readings read units from the catalog query.

Owner: claude. Deadline: 2026-10-21.

## SENSOR-MEDIUM-169 — the flat event ignores a declared quantity (open)

`parameterForChannelKey` reads the key alone. So a `do` channel declared as
% saturation would still be published as dissolved oxygen. Child sensors
registered before this PR also keep their AMMONIA type and publish TAN as
`ammonia`.

Fix: the reading event carries the channel's quantity before the alert engine
reads NH3 or H2S (plan Faz 8).

Owner: claude. Deadline: 2026-10-28.

## FARM-MEDIUM-363 — two services seed the default water-quality parameters (open)

Two services seed a new tenant's water-quality parameter configs, from separate
lists:

- admin-api-service provisioning inserts 12 parameter configs straight into
  farm's per-tenant `water_quality_parameter_configs`, with its own thresholds
  and spellings (`mg/L CaCO₃`);
- farm's onboarding handler then seeds its own 7 and skips the codes admin
  already wrote.

So a tenant's defaults come from whichever list ran first, and the farm table
has two writers.

Fix: farm owns the default set, built from the registry as the templates are.
Admin publishes the onboarding request and writes nothing into farm's schema.

Owner: claude. Deadline: 2026-10-14. This is the next PR of this program.

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
