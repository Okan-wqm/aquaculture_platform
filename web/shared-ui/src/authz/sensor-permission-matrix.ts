/**
 * Sensor-service mutations the frontend gates on — the mirror of each
 * resolver's `@Roles(...)` (sensor-service keeps no central matrix; the
 * resolver decorator is its source of truth). Drift is locked by
 * `__tests__/sensor-permission-matrix.parity.spec.ts`, which reads the
 * decorator above each named mutation in the resolver source.
 */
import type { UserRole } from '../types';

export type SensorMutationName = 'declareChannelQuantity' | 'clearChannelQuantity';

/** Where each mirrored mutation's resolver lives (relative to the repo root). */
export const SENSOR_MUTATION_RESOLVERS: Readonly<Record<SensorMutationName, string>> = {
  declareChannelQuantity: 'apps/sensor-service/src/registration/resolvers/channel.resolver.ts',
  clearChannelQuantity: 'apps/sensor-service/src/registration/resolvers/channel.resolver.ts',
};

export const SENSOR_MUTATION_ROLES: Readonly<Record<SensorMutationName, readonly UserRole[]>> =
  Object.freeze({
    declareChannelQuantity: ['MODULE_MANAGER', 'TENANT_ADMIN'],
    clearChannelQuantity: ['MODULE_MANAGER', 'TENANT_ADMIN'],
  });
