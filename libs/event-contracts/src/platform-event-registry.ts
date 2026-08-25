import { BILLING_ADMIN_COMMAND_SUBJECTS } from './billing-admin-commands';
import { NOTIFICATION_COMMAND_SUBJECTS } from './notification-commands';
import { TENANT_COMMAND_SUBJECTS } from './tenant-commands';

export type PlatformRegistryKind = 'event' | 'command';
export type PlatformPiiClass = 'none' | 'low' | 'contact-ref' | 'operational' | 'financial';
export type PlatformDurability = 'outbox' | 'request-reply-receipt' | 'jetstream';

export interface PlatformEventRegistryEntry {
  type: string;
  kind: PlatformRegistryKind;
  subject: string;
  producer: string;
  consumers: readonly string[];
  schema: string;
  fixture: string;
  acl: {
    publish: readonly string[];
    subscribe: readonly string[];
  };
  piiClass: PlatformPiiClass;
  durability: PlatformDurability;
  backendOnly: boolean;
  aliasExpiresAt?: string;
  retention: string;
}

export const PLATFORM_EVENT_REGISTRY = {
  TelemetryCapacityEntitlementChanged: {
    type: 'TelemetryCapacityEntitlementChanged',
    kind: 'event',
    subject: 'events.{tenantId}.TelemetryCapacityEntitlementChanged',
    producer: 'admin-api-service',
    consumers: ['billing-service'],
    schema:
      'libs/event-contracts/src/telemetry-capacity-events.ts#TelemetryCapacityEntitlementChangedEvent',
    fixture: 'libs/event-contracts/fixtures/telemetry-capacity-entitlement-changed.json',
    acl: {
      publish: ['admin-api-service'],
      subscribe: ['billing-service'],
    },
    piiClass: 'none',
    durability: 'outbox',
    backendOnly: true,
    retention: 'capacity-entitlement-ledger',
  },
  TenantProvisioningRequested: {
    type: 'TenantProvisioningRequested',
    kind: 'event',
    subject: 'events.{tenantId}.TenantProvisioningRequested',
    producer: 'admin-api-service',
    consumers: ['db-migrate'],
    schema: 'libs/event-contracts/src/tenant-events.ts#TenantProvisioningRequestedEvent',
    fixture: 'libs/event-contracts/fixtures/tenant-provisioning-requested.json',
    acl: { publish: ['admin-api-service'], subscribe: ['db-migrate'] },
    piiClass: 'operational',
    durability: 'outbox',
    backendOnly: true,
    retention: 'tenant-provisioning-ledger',
  },
  TenantOnboardingRequested: {
    type: 'TenantOnboardingRequested',
    kind: 'event',
    subject: 'events.{tenantId}.TenantOnboardingRequested',
    producer: 'admin-api-service',
    consumers: ['farm-service'],
    schema: 'libs/event-contracts/src/tenant-events.ts#TenantOnboardingRequestedEvent',
    fixture: 'libs/event-contracts/fixtures/tenant-onboarding-requested.json',
    acl: { publish: ['admin-api-service'], subscribe: ['farm-service'] },
    piiClass: 'operational',
    durability: 'outbox',
    backendOnly: true,
    retention: 'tenant-provisioning-ledger',
  },
  TenantOnboardingAck: {
    type: 'TenantOnboardingAck',
    kind: 'event',
    subject: 'events.{tenantId}.TenantOnboardingAck',
    producer: 'farm-service',
    consumers: ['admin-api-service'],
    schema: 'libs/event-contracts/src/tenant-events.ts#TenantOnboardingAckEvent',
    fixture: 'libs/event-contracts/fixtures/tenant-onboarding-ack.json',
    acl: { publish: ['farm-service'], subscribe: ['admin-api-service'] },
    piiClass: 'none',
    durability: 'outbox',
    backendOnly: true,
    retention: 'tenant-provisioning-ledger',
  },
  TenantOnboardingFailed: {
    type: 'TenantOnboardingFailed',
    kind: 'event',
    subject: 'events.{tenantId}.TenantOnboardingFailed',
    producer: 'farm-service',
    consumers: ['admin-api-service'],
    schema: 'libs/event-contracts/src/tenant-events.ts#TenantOnboardingFailedEvent',
    fixture: 'libs/event-contracts/fixtures/tenant-onboarding-failed.json',
    acl: { publish: ['farm-service'], subscribe: ['admin-api-service'] },
    piiClass: 'operational',
    durability: 'outbox',
    backendOnly: true,
    retention: 'tenant-provisioning-ledger',
  },
  TenantProvisioned: {
    type: 'TenantProvisioned',
    kind: 'event',
    subject: 'events.{tenantId}.TenantProvisioned',
    producer: 'admin-api-service',
    consumers: ['messaging-service', 'gateway-api'],
    schema: 'libs/event-contracts/src/tenant-events.ts#TenantProvisionedEvent',
    fixture: 'libs/event-contracts/fixtures/tenant-provisioned.json',
    acl: { publish: ['admin-api-service'], subscribe: ['messaging-service', 'gateway-api'] },
    piiClass: 'operational',
    durability: 'outbox',
    backendOnly: true,
    retention: 'tenant-lifecycle-ledger',
  },
  TenantCreated: {
    type: 'TenantCreated',
    kind: 'event',
    subject: 'events.{tenantId}.TenantCreated',
    producer: 'admin-api-service',
    consumers: ['legacy-consumers'],
    schema: 'libs/event-contracts/src/tenant-events.ts#TenantCreatedEvent',
    fixture: 'libs/event-contracts/fixtures/tenant-created-legacy.json',
    acl: { publish: ['admin-api-service'], subscribe: ['legacy-consumers'] },
    piiClass: 'operational',
    durability: 'outbox',
    backendOnly: true,
    aliasExpiresAt: '2026-12-31',
    retention: 'tenant-lifecycle-ledger',
  },
  ReserveTenant: {
    type: 'ReserveTenant',
    kind: 'command',
    subject: TENANT_COMMAND_SUBJECTS.RESERVE_TENANT,
    producer: 'admin-api-service',
    consumers: ['auth-service'],
    schema: 'libs/event-contracts/src/tenant-commands.ts#ReserveTenantCommand',
    fixture: 'libs/event-contracts/fixtures/auth-reserve-tenant-command.json',
    acl: { publish: ['admin-api-service'], subscribe: ['auth-service'] },
    piiClass: 'contact-ref',
    durability: 'request-reply-receipt',
    backendOnly: true,
    retention: 'auth-command-receipts',
  },
  ActivateTenant: {
    type: 'ActivateTenant',
    kind: 'command',
    subject: TENANT_COMMAND_SUBJECTS.ACTIVATE_TENANT,
    producer: 'admin-api-service',
    consumers: ['auth-service'],
    schema: 'libs/event-contracts/src/tenant-commands.ts#ActivateTenantCommand',
    fixture: 'libs/event-contracts/fixtures/auth-activate-tenant-command.json',
    acl: { publish: ['admin-api-service'], subscribe: ['auth-service'] },
    piiClass: 'none',
    durability: 'request-reply-receipt',
    backendOnly: true,
    retention: 'auth-command-receipts',
  },
  FailProvisioning: {
    type: 'FailProvisioning',
    kind: 'command',
    subject: TENANT_COMMAND_SUBJECTS.FAIL_PROVISIONING,
    producer: 'admin-api-service',
    consumers: ['auth-service'],
    schema: 'libs/event-contracts/src/tenant-commands.ts#FailProvisioningCommand',
    fixture: 'libs/event-contracts/fixtures/auth-fail-provisioning-command.json',
    acl: { publish: ['admin-api-service'], subscribe: ['auth-service'] },
    piiClass: 'operational',
    durability: 'request-reply-receipt',
    backendOnly: true,
    retention: 'auth-command-receipts',
  },
  ProvisionTenantSubscription: {
    type: 'ProvisionTenantSubscription',
    kind: 'command',
    subject: BILLING_ADMIN_COMMAND_SUBJECTS.PROVISION_TENANT_SUBSCRIPTION,
    producer: 'admin-api-service',
    consumers: ['billing-service'],
    schema: 'libs/event-contracts/src/billing-admin-commands.ts#BillingTenantProvisioningCommand',
    fixture: 'libs/event-contracts/fixtures/billing-provision-tenant-subscription-command.json',
    acl: { publish: ['admin-api-service'], subscribe: ['billing-service'] },
    piiClass: 'financial',
    durability: 'request-reply-receipt',
    backendOnly: true,
    retention: 'billing-command-receipts',
  },
  NotificationSendEmail: {
    type: 'NotificationSendEmail',
    kind: 'command',
    subject: NOTIFICATION_COMMAND_SUBJECTS.SEND_EMAIL,
    producer: 'hr-service',
    consumers: ['notification-service'],
    schema: 'libs/event-contracts/src/notification-commands.ts#NotificationSendEmailCommand',
    fixture: 'libs/event-contracts/fixtures/notification-send-email-command.json',
    acl: { publish: ['hr-service'], subscribe: ['notification-service'] },
    piiClass: 'contact-ref',
    durability: 'request-reply-receipt',
    backendOnly: true,
    retention: 'notification-command-receipts',
  },
  NotificationSendPush: {
    type: 'NotificationSendPush',
    kind: 'command',
    subject: NOTIFICATION_COMMAND_SUBJECTS.SEND_PUSH,
    producer: 'messaging-service',
    consumers: ['notification-service'],
    schema: 'libs/event-contracts/src/notification-commands.ts#NotificationSendPushCommand',
    fixture: 'libs/event-contracts/fixtures/notification-send-push-command.json',
    acl: { publish: ['messaging-service'], subscribe: ['notification-service'] },
    piiClass: 'contact-ref',
    durability: 'request-reply-receipt',
    backendOnly: true,
    retention: 'notification-command-receipts',
  },
  WaterQualityCritical: {
    type: 'WaterQualityCritical',
    kind: 'event',
    subject: 'events.{tenantId}.WaterQualityCritical',
    producer: 'farm-service',
    // Sole consumer is alert-engine: it records the CRITICAL AlertHistory row and
    // creates the escalatable AlertIncident, whose escalation ladder fans out to
    // notification-service. There is no direct notification-service subscriber for
    // this subject (none in infrastructure/nats/services.yaml), so declaring it as a
    // consumer was drift. Route critical-WQ notifications through the alert escalation
    // path, not a second parallel consumer.
    consumers: ['alert-engine'],
    schema: 'libs/event-contracts/src/water-quality-events.ts#WaterQualityCriticalEvent',
    fixture: 'libs/event-contracts/fixtures/water-quality-critical.json',
    acl: { publish: ['farm-service'], subscribe: ['alert-engine'] },
    piiClass: 'operational',
    durability: 'outbox',
    backendOnly: true,
    retention: 'alert-retention',
  },
  SensorDeleted: {
    type: 'SensorDeleted',
    kind: 'event',
    subject: 'events.{tenantId}.SensorDeleted',
    producer: 'sensor-service',
    consumers: ['gateway-api', 'sensor-ingestion'],
    schema: 'libs/event-contracts/src/sensor-events.ts#SensorDeletedEvent',
    fixture: 'libs/event-contracts/fixtures/sensor-deleted.json',
    acl: { publish: ['sensor-service'], subscribe: ['gateway-api', 'sensor-ingestion'] },
    piiClass: 'operational',
    durability: 'outbox',
    backendOnly: true,
    retention: 'sensor-lifecycle-ledger',
  },
  FinanceSettingsUpdated: {
    // Tenant currency SSoT propagation: farm-service owns finance_settings
    // (the per-tenant default currency); hr-service projects defaultCurrency
    // into hr_payroll_cost_settings so both finance tabs report in one
    // currency without a second tenant-editable source. Other Finance*
    // events (entry/category lifecycle in finance-events.ts) are not
    // registered here until a consumer exists — same posture as the other
    // single-service domain events (FeedingRecorded, PayrollProcessed, …).
    type: 'FinanceSettingsUpdated',
    kind: 'event',
    subject: 'events.{tenantId}.FinanceSettingsUpdated',
    producer: 'farm-service',
    consumers: ['hr-service'],
    schema: 'libs/event-contracts/src/finance-events.ts#FinanceSettingsUpdatedEvent',
    fixture: 'libs/event-contracts/fixtures/finance-settings-updated.json',
    acl: { publish: ['farm-service'], subscribe: ['hr-service'] },
    piiClass: 'financial',
    durability: 'outbox',
    backendOnly: true,
    retention: 'finance-settings-ledger',
  },
  SensorDeprovisioned: {
    type: 'SensorDeprovisioned',
    kind: 'event',
    subject: 'events.{tenantId}.SensorDeprovisioned',
    producer: 'sensor-service',
    consumers: ['gateway-api', 'sensor-ingestion'],
    schema: 'libs/event-contracts/src/sensor-events.ts#SensorDeprovisionedEvent',
    fixture: 'libs/event-contracts/fixtures/sensor-deprovisioned.json',
    acl: { publish: ['sensor-service'], subscribe: ['gateway-api', 'sensor-ingestion'] },
    piiClass: 'operational',
    durability: 'outbox',
    backendOnly: true,
    retention: 'sensor-lifecycle-ledger',
  },
} as const satisfies Record<string, PlatformEventRegistryEntry>;

export type PlatformEventRegistryKey = keyof typeof PLATFORM_EVENT_REGISTRY;
