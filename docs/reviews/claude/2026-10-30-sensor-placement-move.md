# Sensor placement after registration — 2026-10-30

Found while answering Okan on 2026-10-30. A sensor publishing pH and temperature over MQTT could
not be bound to a tank on `/sites/water-chemistry`: the Sources tab said "No sensor at this site".

## SENSOR-MEDIUM-206

Defect. Nothing can change where a sensor stands once it is registered, so a sensor registered
at a site cannot later be placed in a tank, and the binding cannot reach it.

Severity MEDIUM. Owner Okan-wqm, deadline 2026-11-13.

Where.

- `updateSensorInfo` takes the site, department, system, tank and equipment ids, but no page
  calls it, and it writes them unchecked: SENSOR-MEDIUM-161 for the registration path.
  `batchUpdateSensors` writes them unchecked too.
- The device page's "Düzenle" button links to `/sensor/devices/:id/edit`, a route that does
  not exist.
- The device page shows the site as a raw id.
- The water-chemistry bind dialog lists a site's sensors by the sensor's own `siteId`, and
  farm places a channel at a tank only when the sensor names that tank.

Failure. The production tenant's only sensor stands at a site with no system or tank. Its five
channels report every ten seconds, but none of them can be bound to a tank or a system.

Fix. One owner writes a sensor's placement: `SensorPlacementService`.

- Farm answers `request.farm.resolveDevicePlacement`: every level named is live and belongs to
  the level above, a system or unit comes with its department, and the unit is a tank or other
  water equipment by the rule a channel bind uses (`unitKindOf`).
- Registration (closing SENSOR-MEDIUM-161) and the new `relocateSensor` mutation store
  placement only through that answer. The placement leaves `updateSensorInfo` and
  `batchUpdateSensors`, and the registration inputs take one `unitId` in place of `tankId` or
  `equipmentId`.
- The place columns, the legacy farm and pond included, are `update: false` on the entity: no
  ORM update writes them, so a copy loaded before a move cannot put the sensor back. The move
  is the one SQL UPDATE, pinned by `sensor-placement-single-writer.spec.ts`.
- A parent device moves with its child sensors; a child is never moved alone. A move ends the
  legacy farm and pond and stamps the new `sensors.placed_at`: the channel description and the
  feeding-window oxygen gate never read a sample taken before the move as the new place's.
  The legacy ingestion path reads the current place per message, and the move's
  `SensorConfigurationUpdated` event drops cached copies.
- Refusals carry stable codes, so the device page words them in the user's language.
- The device page shows the place by name and opens a "Change location" dialog. It shares one
  location picker with the registration wizard. The browser-side tank or equipment classifier
  (`devicePlacement.ts`) is gone: farm decides.

Not covered here: the sensor is still DRAFT and inactive, so the bind refuses it
(SENSOR_INACTIVE). Data-driven activation is part of ADR-047 (SENSOR-CRITICAL-173), which is
implemented separately.

## FARM-LOW-494

Defect, found in review of the placement authority above. A tank can live in two farm tables
under one id, `equipment` (flagged `isTank`) and `tanks`. Farm writes and reads them in
opposite order.

Severity LOW: latent. On 2026-10-30 the production tenant has 16 tanks, all in `tanks` only,
and no id in both tables. Owner Okan-wqm, deadline 2026-11-27.

Where.

- `updateEquipment` and `deleteEquipment` look in `tanks` first and change only that row.
- `findTankOrEquipmentWithManager` reads `equipment` first.
- `resolveUnitSiteIds` takes either row's department (`DISTINCT ON` by unit only, liveness not
  checked).
- The tank-or-equipment rule is written again in `measurement-point-lookup.ts`, beside
  `unitKindOf`.

Failure. Once an id is in both tables, a tank moved to another department through
`updateEquipment` is refused at its new department, and a deleted tank stays placeable and
bindable, because the read sees the untouched `equipment` row.

Not fixed here: one owner row per unit is a farm data-model change of its own.
