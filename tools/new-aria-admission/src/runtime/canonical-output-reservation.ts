import { createHash } from 'node:crypto';
import { basename, isAbsolute, normalize } from 'node:path';

import { canonicalJsonBytes } from '../kernel/canonical-json';

import {
  abortReservedCanonicalOutput,
  acquireCanonicalOutputReservation,
  publishReservedCanonicalOutput,
} from './canonical-output-reservation-io';

export interface CanonicalOutputReservation {
  readonly schema_version: '1.0.0';
  readonly contract_id: 'new-aria-canonical-output-reservation-v1';
  readonly expected_sha256: string;
}

interface ReservationState {
  phase: 'RESERVED' | 'PUBLISHED' | 'ABORTED';
  readonly path: string;
  readonly expected: Buffer;
  readonly reservation: Buffer;
}

const states = new WeakMap<object, ReservationState>();
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function canonicalPath(path: string): void {
  if (!isAbsolute(path) || normalize(path) !== path || basename(path).length === 0) {
    throw new TypeError('canonical output reservation path is invalid');
  }
}

function stateFor(value: CanonicalOutputReservation): ReservationState {
  const state = states.get(value);
  if (state === undefined) throw new TypeError('canonical output reservation was not issued');
  return state;
}

export function reserveCanonicalOutput(
  path: string,
  expectedBytes: Uint8Array,
): CanonicalOutputReservation {
  canonicalPath(path);
  const expected = Buffer.from(expectedBytes);
  if (expected.byteLength < 1) throw new TypeError('canonical output cannot be empty');
  const expectedSha256 = sha256(expected);
  const reservationBytes = Buffer.concat([
    canonicalJsonBytes({
      schema_version: '1.0.0',
      contract_id: 'new-aria-canonical-output-reservation-v1',
      status: 'PENDING',
      expected_sha256: expectedSha256,
    }),
    Buffer.from('\n'),
  ]);
  const phase = acquireCanonicalOutputReservation(path, reservationBytes, expected);
  const result: CanonicalOutputReservation = Object.freeze({
    schema_version: '1.0.0',
    contract_id: 'new-aria-canonical-output-reservation-v1',
    expected_sha256: expectedSha256,
  });
  states.set(result, { phase, path, expected, reservation: reservationBytes });
  return result;
}

export function publishCanonicalOutput(reservation: CanonicalOutputReservation): void {
  const state = stateFor(reservation);
  if (state.phase === 'ABORTED') throw new TypeError('canonical output reservation was aborted');
  if (state.phase === 'PUBLISHED') return;
  publishReservedCanonicalOutput(state.path, state.reservation, state.expected);
  state.phase = 'PUBLISHED';
}

export function abortCanonicalOutput(reservation: CanonicalOutputReservation): void {
  const state = stateFor(reservation);
  if (state.phase !== 'RESERVED') return;
  abortReservedCanonicalOutput(state.path, state.reservation);
  state.phase = 'ABORTED';
}
