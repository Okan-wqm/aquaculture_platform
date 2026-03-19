// Base event contract and shared types
export * from './base-event';

// Domain events by module
export * from './auth-events';
export * from './tenant-events';
export * from './farm-events';
export * from './sensor-events';
export * from './alert-events';
export * from './notification-events';
export * from './hr-events';
export * from './billing-events';
export * from './ai-events';
export * from './task-events';
export * from './edge-device-events';

// Security events (auth failures, rate limit, CSP violations, etc.)
export * from './security';

// Re-export all domain union types for convenience
import type { AuthEvent } from './auth-events';
import type { TenantEvent } from './tenant-events';
import type { FarmEvent } from './farm-events';
import type { SensorEvent } from './sensor-events';
import type { AlertEvent } from './alert-events';
import type { NotificationEvent } from './notification-events';
import type { HREvent } from './hr-events';
import type { BillingEvent } from './billing-events';
import type { AIEvent } from './ai-events';
import type { TaskEvent } from './task-events';
import type { EdgeDeviceEvent } from './edge-device-events';

/**
 * Union type for all platform events.
 * Useful for generic event handlers and middleware.
 */
export type AnyPlatformEvent =
  | AuthEvent
  | TenantEvent
  | FarmEvent
  | SensorEvent
  | AlertEvent
  | NotificationEvent
  | HREvent
  | BillingEvent
  | AIEvent
  | TaskEvent
  | EdgeDeviceEvent;
