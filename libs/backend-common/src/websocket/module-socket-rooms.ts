import type { NonEmptyReadonlyArray, OwnerModuleCode } from '@aquaculture/shared-contracts';
import type { Server, Socket } from 'socket.io';

/**
 * The socket room vocabulary (ADR-051 §3 step 1; SEC-CRITICAL-206, SEC-CRITICAL-207).
 *
 * WHY: the farm, sensor and ST-language gateways put every socket in `tenant:{id}` and emitted
 * farm-private and sensor-private events there, so any tenant member received them. A room was a
 * free string, so nothing stopped a tenant-wide one. A room is now a branded value only the
 * builders below make, and the join, leave and emit helpers take nothing else: a gateway that
 * emits through them cannot name a tenant-wide room, because no builder makes one.
 *
 * WHAT:
 *   - `t:{tenant}:m:{module}` — the module room, joined by members tenant-wide in the module;
 *   - `t:{tenant}:m:{module}:site:{site}` — a site room, joined by site-bound members;
 *   - either one followed by `:{kind}:{id}` — the room of one resource (a sensor, a device);
 *   - `t:{tenant}:registry:{module}` — the common-registry room of a module (ADR-052).
 * Which rooms a member may join, and which rooms an event reaches, is decided in
 * `module-socket-scope.ts` through `decideAccess`.
 *
 * Every segment must be letters, digits, `_` or `-`: tenant, site and sensor ids are UUIDs,
 * device codes match DEVICE_CODE_REGEX, so a value carrying the separator is refused rather than
 * allowed to spell another room.
 */
declare const MODULE_SOCKET_ROOM: unique symbol;

/** A room a builder of this file made; a plain string is not one. */
export type ModuleSocketRoom = string & { readonly [MODULE_SOCKET_ROOM]: true };

/** The resources a member subscribes to one at a time. */
export type ModuleResourceKind = 'sensor' | 'edge-io';

export interface ModuleResource {
  readonly kind: ModuleResourceKind;
  readonly id: string;
}

export interface ModuleRoomPlace {
  readonly siteId?: string;
  readonly resource?: ModuleResource;
}

/** A room segment carried something other than letters, digits, `_` or `-`. */
export class InvalidRoomSegmentError extends Error {
  constructor(readonly segment: 'tenant' | 'site' | 'resource') {
    // The message names the segment only: ids stay out of logs.
    super(`The ${segment} segment of a socket room is malformed`);
    this.name = 'InvalidRoomSegmentError';
  }
}

const ROOM_SEGMENT = /^[A-Za-z0-9_-]+$/;

function segment(value: string, name: InvalidRoomSegmentError['segment']): string {
  if (!ROOM_SEGMENT.test(value)) throw new InvalidRoomSegmentError(name);
  return value;
}

function room(name: string): ModuleSocketRoom {
  return name as ModuleSocketRoom;
}

/** `t:{tenant}:m:{module}[:site:{site}][:{kind}:{id}]`. */
export function moduleRoom(
  tenantId: string,
  module: OwnerModuleCode,
  place: ModuleRoomPlace = {},
): ModuleSocketRoom {
  const parts = [`t:${segment(tenantId, 'tenant')}:m:${module}`];
  if (place.siteId !== undefined) parts.push(`site:${segment(place.siteId, 'site')}`);
  if (place.resource !== undefined) {
    parts.push(`${place.resource.kind}:${segment(place.resource.id, 'resource')}`);
  }
  return room(parts.join(':'));
}

/** `t:{tenant}:registry:{module}`: the common-registry room of the module that owns the rows. */
export function registryRoom(tenantId: string, module: OwnerModuleCode): ModuleSocketRoom {
  return room(`t:${segment(tenantId, 'tenant')}:registry:${module}`);
}

/** Joins `socket` to exactly these rooms. */
export async function joinModuleRooms(
  socket: Pick<Socket, 'join'>,
  rooms: readonly ModuleSocketRoom[],
): Promise<void> {
  await socket.join([...rooms]);
}

/** Takes `socket` out of these rooms. */
export async function leaveModuleRooms(
  socket: Pick<Socket, 'leave'>,
  rooms: readonly ModuleSocketRoom[],
): Promise<void> {
  for (const joined of rooms) await socket.leave(joined);
}

/** Emits `event` once to every socket in any of these rooms. */
export function emitToModuleRooms(
  server: Pick<Server, 'to'>,
  rooms: NonEmptyReadonlyArray<ModuleSocketRoom>,
  event: string,
  payload: unknown,
): void {
  server.to([...rooms]).emit(event, payload);
}
