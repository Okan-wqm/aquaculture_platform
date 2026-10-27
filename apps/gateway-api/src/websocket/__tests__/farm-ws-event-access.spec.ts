import { socketMemberOf, type SocketMember } from '@aquaculture/backend-common/websocket';
import { FARM_EVENT_SCHEMAS, type FarmEventType } from '@platform/event-contracts';

import {
  FARM_WS_EVENT_ACCESS,
  FARM_WS_EVENT_TYPES,
  farmEventRooms,
  farmSocketEventName,
  farmSocketRooms,
  isFarmWsEventType,
  type FarmWsEventType,
} from '../farm-ws-event-access';
import type { FarmGateway } from '../farm.gateway';

const T = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const S1 = '33333333-3333-4333-8333-333333333331';

/** True when A and B are the same type: the type-level half of these tests. */
type Equals<A, B> =
  (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false;

/** The registry kinds of ADR-052 (sites, site departments, site contacts, supplier sites). */
const REGISTRY_EVENTS: readonly FarmWsEventType[] = [
  'SiteCreated',
  'SiteUpdated',
  'SiteDeleted',
  'DepartmentCreated',
  'DepartmentUpdated',
  'DepartmentDeleted',
  'SiteContactsChanged',
  'SupplierApprovedSitesChanged',
];

function member(claims: Record<string, unknown>): SocketMember {
  const built = socketMemberOf({ sub: USER, tenantId: T, type: 'access', jti: 'j1', ...claims });
  if (built === null) throw new Error('the fixture must describe a member');
  return built;
}

/** Whether the farm wire schema of `type` declares a `siteId` property. */
function schemaDeclaresSiteId(type: FarmEventType): boolean {
  const schema: unknown = FARM_EVENT_SCHEMAS[type];
  if (typeof schema !== 'object' || schema === null || !('properties' in schema)) return false;
  const properties: unknown = schema.properties;
  return typeof properties === 'object' && properties !== null && 'siteId' in properties;
}

/**
 * SEC-CRITICAL-206: every farm event the gateway pushes has one access entry, and the rooms of an
 * emit are derived from that entry, never from a free string. A farm-private event reaches only
 * the farm module room and the room of its site; a registry event reaches the registry room of
 * the module that owns the row; no event reaches a tenant-wide room (ADR-051 §3 step 1, D2).
 */
describe('FARM_WS_EVENT_ACCESS (SEC-CRITICAL-206)', () => {
  it('maps the 41 farm events the bridge forwards, and nothing else', () => {
    expect(FARM_WS_EVENT_TYPES).toHaveLength(41);
    expect(Object.keys(FARM_WS_EVENT_ACCESS)).toEqual(FARM_WS_EVENT_TYPES);
    expect(isFarmWsEventType('BatchCreated')).toBe(true);
    // The batched MealWindowUpcoming is an automation hook, not a UI signal.
    expect(isFarmWsEventType('MealWindowUpcoming')).toBe(false);
    expect(isFarmWsEventType('tenant')).toBe(false);
  });

  it('decides the registry kinds as common-registry of farm and every other event as module(farm)', () => {
    for (const type of FARM_WS_EVENT_TYPES) {
      const access = FARM_WS_EVENT_ACCESS[type];
      if (REGISTRY_EVENTS.includes(type)) {
        expect({ type, access }).toEqual({
          type,
          access: { spec: { kind: 'scoped', scope: 'common-registry' }, owner: 'farm' },
        });
      } else {
        expect({ type, spec: access.spec }).toEqual({
          type,
          spec: { kind: 'module', module: 'farm' },
        });
      }
    }
  });

  it('attributes a private event to a site exactly when its wire schema carries siteId', () => {
    for (const type of FARM_WS_EVENT_TYPES) {
      const access = FARM_WS_EVENT_ACCESS[type];
      if (access.spec.kind !== 'module') continue;
      expect({ type, site: 'site' in access ? access.site : undefined }).toEqual({
        type,
        site: schemaDeclaresSiteId(type) ? 'siteId' : null,
      });
    }
  });

  it('names each socket event as the clients listen for it', () => {
    expect(farmSocketEventName('BatchCreated')).toBe('batchCreated');
    expect(farmSocketEventName('FeedInventoryLow')).toBe('feedInventoryLow');
    expect(farmSocketEventName('SupplierApprovedSitesChanged')).toBe(
      'supplierApprovedSitesChanged',
    );
  });

  it('derives the rooms of an emit from the entry: module and site, module, or registry', () => {
    expect(farmEventRooms(T, 'MortalityRecorded', { siteId: S1 })).toEqual([
      `t:${T}:m:farm`,
      `t:${T}:m:farm:site:${S1}`,
    ]);
    expect(farmEventRooms(T, 'MortalityRecorded', {})).toEqual([`t:${T}:m:farm`]);
    expect(farmEventRooms(T, 'MealFed', { siteId: S1 })).toEqual([`t:${T}:m:farm`]);
    expect(farmEventRooms(T, 'SiteCreated', { siteId: S1 })).toEqual([`t:${T}:registry:farm`]);
  });

  it('never derives a tenant-wide room for any event', () => {
    for (const type of FARM_WS_EVENT_TYPES) {
      for (const room of farmEventRooms(T, type, { siteId: S1 })) {
        expect(room.startsWith(`t:${T}:m:farm`) || room === `t:${T}:registry:farm`).toBe(true);
      }
    }
  });

  it('joins a socket to the farm rooms of its scope and the registry rooms of its grants', () => {
    expect(
      farmSocketRooms(member({ roles: ['MODULE_USER'], moduleAccess: { farm: 'MODULE_MANAGER' } })),
    ).toEqual([`t:${T}:m:farm`, `t:${T}:registry:farm`]);
    expect(
      farmSocketRooms(
        member({
          roles: ['MODULE_USER'],
          moduleAccess: { farm: 'MODULE_USER' },
          assignedSiteIds: [S1],
        }),
      ),
    ).toEqual([`t:${T}:m:farm:site:${S1}`, `t:${T}:registry:farm`]);
    expect(
      farmSocketRooms(
        member({
          roles: ['MODULE_MANAGER'],
          moduleAccess: {},
          resourcePermissions: ['company:view'],
        }),
      ),
    ).toEqual([]);
    expect(
      farmSocketRooms(member({ roles: ['MODULE_USER'], moduleAccess: { hr: 'MODULE_MANAGER' } })),
    ).toEqual([`t:${T}:registry:hr`]);
  });

  it('types the emit by event: the gateway takes a mapped farm event, never a room or a free name', () => {
    const emitTakesEvent: Equals<
      Parameters<FarmGateway['broadcastFarmEvent']>[1],
      FarmWsEventType
    > = true;
    const onlyFarmEvents: Equals<Extract<FarmWsEventType, FarmEventType>, FarmWsEventType> = true;
    expect([emitTakesEvent, onlyFarmEvents]).toEqual([true, true]);
  });
});
