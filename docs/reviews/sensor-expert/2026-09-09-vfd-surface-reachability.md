# VFD surface reachability — verified against code, 2026-09-09

The 2026-07-17 industrial-protocol audit registered five findings against the VFD and
channel surfaces. All five were re-read against current code before any of them was
acted on, because a finding this session already proved stale once (Faz 4's
`transferBatch.skipCapacityCheck`). **All five still hold**, and the re-read produced
two further defects the audit did not name. This file records the re-verification and
carries the two new findings.

## Re-verification of the 2026-07-17 findings

| Finding         | Claim                                                       | Verified at                                                                                                                             | Verdict                      |
| --------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| SENSOR-HIGH-062 | `VfdProgrammingPage` ships a hardcoded mock device selector | `VfdProgrammingPage.tsx:37` (`MOCK_DEVICES`), selected on mount at `:73-74`, rendered at `:154`                                         | STILL TRUE                   |
| SENSOR-HIGH-063 | Channels tab CRUD is 100% broken                            | `ChannelManagerPanel.tsx` `toCreateInput`/`toUpdateInput` vs `data-channel.dto.ts`                                                      | STILL TRUE — mechanism below |
| SENSOR-HIGH-065 | No UI can activate a DRAFT drive                            | `useVfdRegistration.ts:350` `activateDevice` exists; zero callers in `web/modules`                                                      | STILL TRUE                   |
| SENSOR-HIGH-066 | `VfdPanel` is unreachable                                   | `DeviceDetailPage.tsx:721` gates on `device.type?.toLowerCase().includes('vfd')`; `SensorType` has 15 values, none containing `vfd`     | STILL TRUE                   |
| SENSOR-HIGH-067 | VFD "realtime" readings are fake-live                       | three `@ScheduledJob` in sensor-service, none reads a drive; `readCriticalParameters` reachable only from `vfd-reading.resolver.ts:166` | STILL TRUE                   |

Line numbers in the original audit had drifted; every claim held.

### SENSOR-063 — the exact mechanism

GraphQL variable coercion rejects an input object carrying a field the type does not
define, so a single unknown key fails the whole request.

- **Create** sends `unitSymbol`, `operationalMin`, `operationalMax` and
  `discoverySource` — none exists on `CreateDataChannelInput`. `discoverySource: 'manual'`
  is a literal, so it is present on **every** request: every create fails. It is also
  redundant — `channel-management.service.ts:119` already stamps
  `discoverySource: DiscoverySource.MANUAL` server-side.

  Those names are not invented. `unitSymbol` (`unit_symbol`), `operationalMin` and
  `operationalMax` are real columns on `SensorDataChannel`
  (`sensor-data-channel.entity.ts:239,243`, read by `validateValue` at `:408-411`).
  The panel was written against the **entity**, not the **contract** — which is the
  root cause worth naming, because it is what a hand-written client with no codegen
  drifts into.

- **Update** sends the same three phantoms plus `dataType`, which
  `UpdateDataChannelInput` does not define. `DataChannelConfig.dataType` is
  non-optional, so it is present on **every** request: every update fails.
- The range never arrives even in principle: the contract's fields are
  `minValue`/`maxValue` and the panel sends `operationalMin`/`operationalMax`. These
  are two different ranges — physical versus the operational band `validateValue`
  checks — so the panel was also sending the editor's physical range under the
  operational name. See SENSOR-MEDIUM-115 for the operational pair, which no input
  exposes at all.

The read path was corrected at some point and its comment states the truth —
"minValue/maxValue (not operationalMin/Max) … unitSymbol does not exist on
DataChannelType" — directly above the input interfaces that still declare the
phantom fields. The write path was never brought along.

Nothing catches this class: `codegen.ts` does not scan `web/modules/**`,
`validate-graphql-operations.mjs` checks document text rather than variable shape, and
while `farm-graphql-fe-be-parity` and `hr-graphql-fe-be-parity` exist, there is no
sensor equivalent. `sensor-enum-fe-be-parity.spec.ts` is the nearest precedent and
covers enum members only, not input-object field names.

## New findings

### SENSOR-HIGH-113 — VFD automation rules are evaluated by nothing

`VfdAutomationRuleService.onSensorReading(event: SensorReadingEvent)`
(`vfd-automation-rule.service.ts:69`) is a complete implementation: it finds matching
rules, evaluates their conditions and creates change sets. It carries no `@OnEvent`, no
`@EventPattern` and no bus subscription, and a tree-wide grep finds zero callers outside
its own file.

A tenant can create an automation rule — "when dissolved oxygen drops below X, raise the
aerator to Y Hz" — see it listed as ACTIVE, and it will never fire.

This is not SENSOR-HIGH-067 restated. That one is about reading _from_ drives; this is
about reacting to sensor readings by writing _to_ them. Both are reachability holes on
the same surface, which is why the VFD module looks complete and does nothing.

**Fix direction:** subscribe the handler to the sensor-reading subject the alert engine
already consumes and return a `HandlerOutcome` (the PLAT-HIGH-902 contract), rather than
adding a second private dispatch path.

Deliberately outside the reachability PR that registered it: that PR fixes the surfaces
a human operates. Wiring an autonomous write path to live sensor readings is a separate
blast radius that needs its own review and its own tests.
Owner @okan-wqm, deadline 2026-11-15.

### SENSOR-MEDIUM-114 — the SCADA VFD drive widget is inert at runtime

Two independent halves.

1. **Binding.** `VfdDriveWidgetConfig.tsx:94-104` asks for the device through a plain
   `<input type="text">` labelled "VFD Device ID" with placeholder "Enter VFD device
   ID...", so binding a widget means pasting a UUID copied from elsewhere; a typo binds
   the widget to nothing and renders as an empty drive. Every other device-bound surface
   in the module selects from a device list.
2. **Commands.** `VfdDriveWidget.tsx:208-216` fires `onCommand('vfd:start')`,
   `('vfd:stop')` and `('vfd:program', id)`, enabled only when `!isEditing` — that is,
   only at runtime. `ScadaWidgetNode.handleCommand` (`:222-244`) branches on `navigate`
   and, in simulation mode only, `toggle`/`press`/`writeTag`. The three `vfd:` commands
   match no branch, there is no `else` and no warning: the click is swallowed. An
   operator presses Stop on a running drive and gets no error and no effect.

**Fix direction:** bind the device through the same device list the rest of the module
uses, and route the commands through the audited VFD command path. Registered rather
than fixed alongside the reachability work because issuing a drive command from a SCADA
runtime surface needs its command authorization and audit path reviewed on its own. A
silent no-op is safer than an unaudited write — but it must not stay silent: disabling
the buttons until the path exists is part of the fix, not a workaround.
Owner @okan-wqm, deadline 2026-11-15.

### SENSOR-MEDIUM-115 — the operational band gates readings and nothing can set it

Surfaced while fixing SENSOR-HIGH-063, and **not** asserted to be a live break — it may
be the intended design.

`operationalMin`/`operationalMax` are distinct from `minValue`/`maxValue`: the latter is
the physical range, the former the band `SensorDataChannel.validateValue` rejects
readings against (`:408-411`, with a reason string at `:433`). They are populated in
exactly one place — `sensor-type.service.ts:347-348`, from a sensor-type template's
channel definitions.

Neither `CreateDataChannelInput`, `UpdateDataChannelInput` nor the `DataChannelType`
output mentions them. A channel created through the channel manager — the only manual
path — is therefore born with no operational band and can never be given one, and its
readings skip that validation while a template-provisioned channel's do not.

Two readings are possible and this finding does not pick one. Either the band is
deliberately template-owned, in which case the gap is that nothing says so and a manual
channel silently opts out of a check; or it is user configuration that was never wired,
in which case three fields are missing from the input types. Deciding needs product
intent, which is why it is registered rather than settled inside a CRUD repair.

Note that the UI never wrote these anyway: the panel was sending the editor's _physical_
range under the operational names, so nothing reached them even before the request
started failing outright.
Owner @okan-wqm, deadline 2026-11-15.
