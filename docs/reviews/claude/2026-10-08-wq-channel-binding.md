# Binding a water-chemistry input to a sensor channel (2026-10-08)

PR-3.1 and PR-3.2 of the water-chemistry channel-binding plan (rev2, decisions D1-D14). It
builds on PR-3.0a (`2026-10-08-wq-measurement-unit.md`): the unit classifier, the measurement
plan and the unit readers.

## What was missing

### FARM-HIGH-373 — no way to bind a water-chemistry input to a channel

The engine's bindable inputs (temperature, pH, salinity, alkalinity, TAN, H2S, calcium, DO)
had no source owner that could name a sensor channel:

- `water_quality_param_equipment` had one point column, `equipmentId`, looked up in the
  `equipment` table, so a tank (canonical id `tanks.id`) answered 404. No site or system point.
- It stored a `sensorId` nothing read, and no channel key: a sensor has many channels.
- A unique (tenant, parameter, equipment) over every row allowed neither a backup source nor
  history; a mapping was hard-deleted, so what fed a parameter on a past date was lost.
- Its handlers saved through injected repositories with no transaction, so two edits could
  interleave with nothing serializing them.

### FARM-MEDIUM-374 — a parameter could not say what it measures

`ammonia`, `nitrite` and `nitrate` name a family (TAN, NH3-N, NH4-N, ...), and a config had
nowhere to declare the member. Nothing kept two active configs from recording one quantity,
and a change of code or unit left no trace of when the meaning changed.

### FARM-MEDIUM-375 — a measurement could name two units and no system

No rule kept `tankId` and `equipmentId` exclusive (old writers filed one id in both), and a
sump or loop sample had no `systemId`.

### DATA-MEDIUM-020 — the drift validator is not expand-aware

An entity declaring NOT NULL over a nullable column is an error-class drift
(`schema-drift-validator.service.ts:439`), so an expand migration that relaxes NOT NULL fails
the boot of the release still running. Raised to the arbiter as systemic (plan D9).

## Release A: the entity relaxes first

`equipmentId`, `monitoringFrequency` and `alertEnabled` become nullable in the entity and the
GraphQL type, with no DDL. Deployed before the expand migration, the running release then
accepts the relaxed columns; deployed together, a pod restarted between the migration and the
rollout would refuse to boot. The reverse direction (DB NOT NULL, entity nullable) is not
drift, so Release A is safe on its own. The PR carries the migration as a separate commit;
ship Release A first.
