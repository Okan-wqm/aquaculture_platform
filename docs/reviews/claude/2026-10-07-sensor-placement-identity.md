# Where a sensor stands (2026-10-07)

PR-3a of the water-chemistry channel-binding plan. It is the sensor side of
binding placement, and must land before farm's binding owner (PR-3).

## SENSOR-MEDIUM-172 — a tank sensor did not record its tank

Farm binds a water-chemistry input to a channel at a measurement point: the
site, a system, a tank or a non-tank piece of water equipment. To accept the
binding, farm checks that the sensor stands at that point. That check could
not work for tanks:

- **The wizard recorded a tank as equipment.** Farm's equipment list presents
  tanks (tanks, ponds, cages) beside water equipment, with `isTank` set, and a
  tank's identity is its `tanks.id`. The registration wizard saved whatever
  was picked as `equipment_id` and never set `tank_id`. Every
  wizard-registered tank sensor therefore had no tank.
- **The channel description did not say where a non-tank device stands.** It
  carried site, system and tank, but not equipment.

### Fix

- **Wizard.** `devicePlacement` records a picked tank as `tankId` and any other
  water equipment as `equipmentId`. Changing site, department or system clears
  both. The parent sends both, and child sensors already inherit the parent's
  location.
  - The parent's wire input is built in one place, `toRegisterParentInput`.
  - A picked system narrows the units on the server. Farm's list filter covers
    tanks and system-linked equipment alike. The old client-side filter read
    system links the query never selected, so a system pick offered no tank
    at all: the main RAS flow could not record a tank.
- **Description.** `equipmentId` is added to the description (contract field
  and validator, SQL, GraphQL). Location is the device that owns the channel.
- **Registry.** Quantities that are uniform across a recirculating loop are
  marked `loopHomogeneous`: temperature, salinity, conductivity, specific
  conductance, alkalinity, calcium, hardness and TDS. Farm's reading resolver
  (PR-4) lets a tank inherit these from its system's source, labelled as
  inherited. Dissolved oxygen, pH, CO2, the nitrogen species and sulfide are
  never inherited.

No backfill is needed. On 2026-10-08 the only deployment (prod, one tenant)
held one sensor, with neither `tank_id` nor `equipment_id` set. No sensor
carries a tank's id as `equipment_id`, so the description's `equipmentId`
means non-tank equipment for every row, and farm's placement check (PR-3) has
no legacy shape to accept.

Proof:

- `devicePlacement.test.ts`;
- `ParentDeviceInfoStep.placement.test.tsx`:
  - the step asks the server for the picked system's units and offers them;
  - a tank pick is sent as `tankId` and a biofilter pick as `equipmentId`;
  - the registration input carries the step's choice.
  - Reverting any of the three wizard lines fails it.
- the RLS Postgres spec: a biofilter-placed sensor reads `equipmentId`, a
  tank-placed one `tankId`;
- contract and DTO specs;
- the registry spec pins the inheritable set.

### Independent review → fixes

A sensor review found no critical or high defect, and three medium and one
low:

- **Medium: a system pick offered no tank.** Fixed by the server-side filter
  above.
- **Medium: tank sensors registered before this keep a tank id as equipment.**
  Checked against prod: there are none (above).
- **Medium: the tests did not prove the wizard change.** The step test above
  fails on a revert.
- **Low: `tankId` was still labelled a deprecated legacy field.** It is
  documented as the tank placement now.

It also confirmed that a newer description validator refuses a reply without
`equipmentId`. Sensor-service must therefore deploy before farm's PR-3 caller,
which is the order of the plan.
