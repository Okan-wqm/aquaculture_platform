import { registerOwnerModuleEnum } from '@aquaculture/backend-common/graphql';

/**
 * The GraphQL enum of the platform module an alarm originates in (`AlertModule`).
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
 * (FeedingWindowReadiness) come from sensor-service → sensor; water quality,
 * mortality, FCR, feeding execution, feed coverage and low stock come from
 * farm-service → farm. Its values are the module dictionary's owner modules
 * (`OWNER_MODULE`, shared-contracts; RBAC-MEDIUM-023): hydroponics is the
 * greenhouse workspace's module and hr's alarms come from CertificationExpired,
 * but no hydroponics-service or hr-service signal reaches alert-engine yet, so
 * a filter on either is valid and answers with no alarms rather than an error.
 * Code that holds a value types it `OwnerModuleCode`; this reference only names
 * the GraphQL type.
 */
export const ALERT_MODULE_ENUM = registerOwnerModuleEnum(
  'AlertModule',
  'The platform module an alarm originates in',
);
