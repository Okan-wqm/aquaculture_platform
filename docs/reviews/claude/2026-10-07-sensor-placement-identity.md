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
- **Description.** `equipmentId` is added to the description (contract field
  and validator, SQL, GraphQL). Location is the device that owns the channel.
- **Registry.** Quantities that are uniform across a recirculating loop are
  marked `loopHomogeneous`: temperature, salinity, conductivity, specific
  conductance, alkalinity, calcium, hardness and TDS. Farm's reading resolver
  (PR-4) lets a tank inherit these from its system's source, labelled as
  inherited. Dissolved oxygen, pH, CO2, the nitrogen species and sulfide are
  never inherited.

Not changed: sensors registered before this keep `equipment_id` set to a tank
id. Farm's placement check (PR-3) also accepts that legacy shape for a tank
point.

Proof:

- `devicePlacement.test.ts`;
- the RLS Postgres spec: a biofilter-placed sensor reads `equipmentId`, a
  tank-placed one `tankId`;
- contract and DTO specs;
- the registry spec pins the inheritable set.
