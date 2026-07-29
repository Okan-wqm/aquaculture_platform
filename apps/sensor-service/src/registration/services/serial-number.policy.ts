import { ConflictException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

/**
 * SENSOR-MEDIUM-072: one serial-number policy for every sensor registration path.
 *
 * `sensors.serial_number` is NOT NULL + UNIQUE (Baseline: IDX_sensors_serial_number),
 * yet RegisterSensorInput.serialNumber is @IsOptional. The parent-with-children
 * path auto-generated a placeholder when the operator omitted one, but the single
 * path passed `undefined` straight through — so an omitted serial failed at INSERT
 * with a raw `null value in column "serial_number"` driver message, and a duplicate
 * serial leaked `duplicate key value violates unique constraint`. This module is
 * the single owner of both behaviours so the two paths can no longer disagree.
 */

/** Prefix that keeps an auto-generated placeholder visually distinct from an
 *  operator-entered serial. Kept as a closed union so a new caller must classify. */
export type SerialNumberKind = 'SENSOR' | 'PARENT';

/** The unique index guarding `sensors.serial_number` (see Baseline migration). */
export const SENSOR_SERIAL_UNIQUE_INDEX = 'IDX_sensors_serial_number';

/**
 * Generate a collision-free placeholder serial. The UUID suffix (not a timestamp)
 * makes two registrations in the same millisecond safe, so a generated serial can
 * never trip the unique index.
 */
export function generateSerialNumber(kind: SerialNumberKind): string {
  return `${kind}-${randomUUID()}`;
}

/**
 * Resolve the serial to persist: honour an operator-provided value, otherwise
 * generate one. The return type is a non-optional `string`, so a persist site that
 * routes through this function structurally cannot null the NOT NULL column
 * (the defect class SENSOR-MEDIUM-072 closes).
 */
export function resolveSerialNumber(provided: string | undefined, kind: SerialNumberKind): string {
  const trimmed = provided?.trim();
  return trimmed ? trimmed : generateSerialNumber(kind);
}

/**
 * Map a Postgres unique-violation on the serial index to a domain
 * ConflictException instead of leaking the raw driver message to the operator.
 * A no-op for any other error, so the caller keeps its existing handling for
 * non-serial failures (e.g. a duplicate channelKey).
 */
export function throwIfSerialNumberConflict(err: unknown, serialNumber: string): void {
  const e = err as { code?: string; constraint?: string };
  if (e?.code === '23505' && e.constraint === SENSOR_SERIAL_UNIQUE_INDEX) {
    throw new ConflictException(`A sensor with serial number "${serialNumber}" already exists`);
  }
}
