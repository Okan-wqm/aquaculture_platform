// Base event contract and shared types
export * from './base-event';

// Domain events by module
export * from './tenant-events';
export * from './farm-events';
export * from './sensor-events';
export * from './alert-events';
export * from './notification-events';
export * from './hr-events';
export * from './billing-events';

// Re-export all domain union types for convenience
import type { TenantEvent } from './tenant-events';
import type { FarmEvent } from './farm-events';
import type { SensorEvent } from './sensor-events';
import type { AlertEvent } from './alert-events';
import type { NotificationEvent } from './notification-events';
import type { HREvent } from './hr-events';
import type { BillingEvent } from './billing-events';

/**
 * Union type for all platform events.
 * Useful for generic event handlers and middleware.
 */
export type AnyPlatformEvent =
  | TenantEvent
  | FarmEvent
  | SensorEvent
  | AlertEvent
  | NotificationEvent
  | HREvent
  | BillingEvent;
