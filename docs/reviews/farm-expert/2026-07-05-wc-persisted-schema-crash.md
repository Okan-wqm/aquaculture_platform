# Sensor — water-chemistry page crash: persisted localStorage cards trusted without schema validation — 2026-07-05

## SENSOR-HIGH-016 — "Cannot read properties of undefined (reading 'temperature')": stale localStorage cards crash WaterChemistryMonitoringPage — RESOLVED

**Prod symptom.** Operator hits a hard React render crash
(`TypeError: Cannot read properties of undefined (reading 'temperature')` in the
`WaterChemistryMonitoringPage` chunk). Permanent for that browser — the bad data
lives in localStorage, so every revisit crashes again.

**Root cause.** The page's card/system stores persist to localStorage
(`wc-cards-v1` / `wc-systems-v1`) and `load()` did
`JSON.parse(raw) as WcCard[]` — trusting whatever an OLDER build wrote as if it
had today's schema. A card saved before `paramSources` existed reaches
`sourceValue(card.paramSources, 'temperature')` → `undefined['temperature']` →
the exact prod TypeError. Class: persisted-schema drift; the cast hid it from the
compiler.

**Fix (make it impossible — validate at the single load boundary).**
- `normalizeCard(raw)`: every persisted card is FORWARD-MIGRATED on load. A card
  with a recognizable scope keeps the user's id/title/limits/layout/chart and
  every valid per-param source, and has every missing/invalid section rebuilt
  from the current template (`createCard`). Unrecognizable entries are dropped.
  Stale data upgrades instead of being trusted; the page can no longer be crashed
  by old persisted shapes.
- `normalizeSystem(raw)`: same guard for the system store — a system whose every
  stage carries the current shape passes through untouched (with its
  active/dosing stage pointers re-validated against real stage ids); stale
  systems are rebuilt from `createSystemCard(systemId)` keeping the user-visible
  bits.
- `load()` in both stores now parses to `unknown` and maps through the
  normalizers — the `as WcCard[]` / `as WcSystemCard[]` trust-casts are gone.

**Why not defensive `?.` at the read sites:** that silences the symptom in one
spot and leaves every other consumer of the persisted shape exposed; the load
boundary is the single choke point where the type claim is actually made true.

## Verification
`persisted-schema-migration.spec` 5 green (legacy card without `paramSources`
upgrades and the exact crashing read now works; garbage drops; current shapes
pass through intact; legacy system stages rebuilt with valid stage pointers);
sensor-module suite 54 files / 1266 tests green; tsc + eslint clean.
