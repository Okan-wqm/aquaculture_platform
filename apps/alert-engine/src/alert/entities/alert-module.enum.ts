import { registerEnumType } from '@nestjs/graphql';

/**
 * AlertModule — the platform module an alarm originates in.
 *
 * WHY: the tenant console groups its work into module workspaces (Production
 * on the farm module, Greenhouse on hydroponics, Control & sensors on the
 * sensor module) and each shows its own alarms: the workspace menu's counts
 * and every module dashboard's alarm panel. Without a module on the alarm the
 * only honest view was the tenant-wide one (ALERT-MEDIUM-010).
 *
 * WHAT: the module whose service produced the signal the alarm was raised
 * from — set by alert-engine's consumer of that signal, never guessed from its
 * text: rule evaluation over SensorReading and the pre-meal oxygen guard
 * (FeedingWindowReadiness) come from sensor-service → SENSOR; water quality,
 * mortality, FCR, feeding execution, feed coverage and low stock come from
 * farm-service → FARM. HYDROPONICS is the greenhouse workspace's module; no
 * hydroponics-service signal reaches alert-engine yet, so a filter on it is
 * valid and answers with no alarms rather than an error.
 */
export enum AlertModule {
  FARM = 'farm',
  SENSOR = 'sensor',
  HYDROPONICS = 'hydroponics',
}

registerEnumType(AlertModule, {
  name: 'AlertModule',
  description: 'The platform module an alarm originates in',
});
