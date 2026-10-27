import type { NonEmptyReadonlyArray } from '@aquaculture/shared-contracts';
import { collaborator } from '@aquaculture/testing';
import type { Server, Socket } from 'socket.io';

import {
  InvalidRoomSegmentError,
  emitToModuleRooms,
  joinModuleRooms,
  leaveModuleRooms,
  moduleRoom,
  registryRoom,
  type ModuleSocketRoom,
} from '../module-socket-rooms';
import {
  eventModuleRooms,
  memberModuleRooms,
  memberRegistryRooms,
  moduleSocketScope,
  scopeAdmitsSite,
} from '../module-socket-scope';
import { socketMemberOf, type SocketMember } from '../socket-member';

const T = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const S1 = '33333333-3333-4333-8333-333333333331';
const S2 = '33333333-3333-4333-8333-333333333332';
const S9 = '33333333-3333-4333-8333-333333333339';
const SENSOR = '55555555-5555-4555-8555-555555555555';

/** True when A and B are the same type: the type-level half of these tests. */
type Equals<A, B> =
  (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false;

/** The ADR-051 §4 viewers, as the claims of their access tokens. */
const VIEWERS = {
  /** Role A: {farm: MODULE_MANAGER}, no company:view. */
  roleA: { roles: ['MODULE_USER'], moduleAccess: { farm: 'MODULE_MANAGER' } },
  /** A′: role A plus today's global MODULE_MANAGER, which changes none of its cells. */
  roleAPrime: { roles: ['MODULE_MANAGER'], moduleAccess: { farm: 'MODULE_MANAGER' } },
  /** Role B: the Company Viewer role and no grants. */
  roleB: { roles: ['MODULE_USER'], moduleAccess: {}, resourcePermissions: ['company:view'] },
  /** B′: role B plus the global MODULE_MANAGER. */
  roleBPrime: {
    roles: ['MODULE_MANAGER'],
    moduleAccess: {},
    resourcePermissions: ['company:view'],
  },
  farmOperatorS1: {
    roles: ['MODULE_USER'],
    moduleAccess: { farm: 'MODULE_USER' },
    assignedSiteIds: [S1],
  },
  farmOperatorWithoutSites: { roles: ['MODULE_USER'], moduleAccess: { farm: 'MODULE_USER' } },
  hrManager: { roles: ['MODULE_USER'], moduleAccess: { hr: 'MODULE_MANAGER' } },
  sensorManagerS9: {
    roles: ['MODULE_USER'],
    moduleAccess: { sensor: 'MODULE_MANAGER' },
    assignedSiteIds: [S9],
  },
  sensorOperatorS9: {
    roles: ['MODULE_USER'],
    moduleAccess: { sensor: 'MODULE_USER' },
    assignedSiteIds: [S9, S9],
  },
  tenantAdmin: {
    roles: ['TENANT_ADMIN'],
    moduleAccess: { farm: 'MODULE_MANAGER', hr: 'MODULE_MANAGER', sensor: 'MODULE_MANAGER' },
  },
  tenantAdminWithoutHr: {
    roles: ['TENANT_ADMIN'],
    moduleAccess: { farm: 'MODULE_MANAGER', sensor: 'MODULE_MANAGER' },
  },
} as const;

type Viewer = keyof typeof VIEWERS;

function member(viewer: Viewer): SocketMember {
  const built = socketMemberOf({
    sub: USER,
    tenantId: T,
    type: 'access',
    jti: 'j1',
    ...VIEWERS[viewer],
  });
  if (built === null) throw new Error(`the ${viewer} fixture must describe a member`);
  return built;
}

/** Socket.IO delivers an emit to a socket that joined any one of its rooms, once. */
function receives(
  joined: readonly ModuleSocketRoom[],
  emittedTo: readonly ModuleSocketRoom[],
): boolean {
  return emittedTo.some((room) => joined.includes(room));
}

describe('module socket rooms (SEC-CRITICAL-206, SEC-CRITICAL-207; ADR-051 §3 step 1)', () => {
  describe('the room vocabulary', () => {
    it('names module, site, resource and registry rooms under the tenant', () => {
      expect(moduleRoom(T, 'farm')).toBe(`t:${T}:m:farm`);
      expect(moduleRoom(T, 'farm', { siteId: S1 })).toBe(`t:${T}:m:farm:site:${S1}`);
      expect(moduleRoom(T, 'sensor', { resource: { kind: 'sensor', id: SENSOR } })).toBe(
        `t:${T}:m:sensor:sensor:${SENSOR}`,
      );
      expect(
        moduleRoom(T, 'sensor', { siteId: S9, resource: { kind: 'edge-io', id: 'PLC-01' } }),
      ).toBe(`t:${T}:m:sensor:site:${S9}:edge-io:PLC-01`);
      expect(registryRoom(T, 'farm')).toBe(`t:${T}:registry:farm`);
    });

    it.each([
      ['a tenant holding a separator', (): ModuleSocketRoom => moduleRoom(`${T}:m`, 'farm')],
      ['an empty tenant', (): ModuleSocketRoom => moduleRoom('', 'farm')],
      [
        'a site holding a separator',
        (): ModuleSocketRoom => moduleRoom(T, 'farm', { siteId: 'a:b' }),
      ],
      [
        'a resource id holding a separator',
        (): ModuleSocketRoom =>
          moduleRoom(T, 'sensor', { resource: { kind: 'sensor', id: `${SENSOR}:x` } }),
      ],
      ['a registry tenant holding a separator', (): ModuleSocketRoom => registryRoom('a:b', 'hr')],
    ])('refuses %s, so no segment can forge another room', (_case, build) => {
      expect(build).toThrow(InvalidRoomSegmentError);
    });

    it('accepts only rooms the builders made: a free string is no room', () => {
      const stringIsARoom: Equals<string extends ModuleSocketRoom ? true : false, false> = true;
      const emitTakesRooms: Equals<
        Parameters<typeof emitToModuleRooms>[1],
        NonEmptyReadonlyArray<ModuleSocketRoom>
      > = true;
      expect([stringIsARoom, emitTakesRooms]).toEqual([true, true]);
    });
  });

  describe('the module scope a socket holds (decideAccess, module(m), read)', () => {
    it.each<[Viewer, 'farm' | 'hr' | 'sensor', ReturnType<typeof moduleSocketScope>]>([
      ['roleA', 'farm', { kind: 'module' }],
      ['roleAPrime', 'farm', { kind: 'module' }],
      ['roleA', 'sensor', null],
      ['roleA', 'hr', null],
      ['roleB', 'farm', null],
      ['roleBPrime', 'farm', null],
      ['roleBPrime', 'sensor', null],
      ['farmOperatorS1', 'farm', { kind: 'sites', siteIds: [S1] }],
      ['farmOperatorWithoutSites', 'farm', null],
      ['hrManager', 'farm', null],
      ['sensorManagerS9', 'sensor', { kind: 'module' }],
      ['sensorOperatorS9', 'sensor', { kind: 'sites', siteIds: [S9] }],
      ['sensorOperatorS9', 'farm', null],
      ['tenantAdmin', 'farm', { kind: 'module' }],
      ['tenantAdmin', 'hr', { kind: 'module' }],
      ['tenantAdminWithoutHr', 'hr', null],
    ])('%s in %s', (viewer, module, expected) => {
      expect(moduleSocketScope(member(viewer), module)).toEqual(expected);
    });

    it('admits a site only inside the scope; a module-wide scope admits rows without a site', () => {
      expect(scopeAdmitsSite({ kind: 'module' }, null)).toBe(true);
      expect(scopeAdmitsSite({ kind: 'module' }, S2)).toBe(true);
      expect(scopeAdmitsSite({ kind: 'sites', siteIds: [S1] }, S1)).toBe(true);
      expect(scopeAdmitsSite({ kind: 'sites', siteIds: [S1] }, S2)).toBe(false);
      expect(scopeAdmitsSite({ kind: 'sites', siteIds: [S1] }, null)).toBe(false);
    });
  });

  describe('the rooms a socket joins and the rooms an event reaches', () => {
    it('joins a module-wide member to the module room and a site-bound one to its site rooms', () => {
      expect(memberModuleRooms(member('roleA'), 'farm')).toEqual([`t:${T}:m:farm`]);
      expect(memberModuleRooms(member('farmOperatorS1'), 'farm')).toEqual([
        `t:${T}:m:farm:site:${S1}`,
      ]);
      expect(memberModuleRooms(member('roleB'), 'farm')).toEqual([]);
      expect(memberModuleRooms(member('hrManager'), 'farm')).toEqual([]);
    });

    it('qualifies a resource room by the same scope', () => {
      const sensor = { kind: 'sensor', id: SENSOR } as const;
      expect(memberModuleRooms(member('sensorManagerS9'), 'sensor', sensor)).toEqual([
        `t:${T}:m:sensor:sensor:${SENSOR}`,
      ]);
      expect(memberModuleRooms(member('sensorOperatorS9'), 'sensor', sensor)).toEqual([
        `t:${T}:m:sensor:site:${S9}:sensor:${SENSOR}`,
      ]);
      expect(memberModuleRooms(member('roleA'), 'sensor', sensor)).toEqual([]);
    });

    it('joins the registry rooms of the common-registry scope only', () => {
      expect(memberRegistryRooms(member('roleA'))).toEqual([`t:${T}:registry:farm`]);
      expect(memberRegistryRooms(member('farmOperatorS1'))).toEqual([`t:${T}:registry:farm`]);
      expect(memberRegistryRooms(member('hrManager'))).toEqual([`t:${T}:registry:hr`]);
      expect(memberRegistryRooms(member('roleB'))).toEqual([]);
      expect(memberRegistryRooms(member('roleBPrime'))).toEqual([]);
      expect(memberRegistryRooms(member('tenantAdmin'))).toEqual([
        `t:${T}:registry:farm`,
        `t:${T}:registry:hr`,
        `t:${T}:registry:sensor`,
        `t:${T}:registry:hydroponics`,
      ]);
    });

    it('sends a site event to the module room and its site room, a siteless one to the module room', () => {
      expect(eventModuleRooms(T, 'farm', S1)).toEqual([
        `t:${T}:m:farm`,
        `t:${T}:m:farm:site:${S1}`,
      ]);
      expect(eventModuleRooms(T, 'farm', null)).toEqual([`t:${T}:m:farm`]);
      expect(eventModuleRooms(T, 'sensor', S9, { kind: 'sensor', id: SENSOR })).toEqual([
        `t:${T}:m:sensor:sensor:${SENSOR}`,
        `t:${T}:m:sensor:site:${S9}:sensor:${SENSOR}`,
      ]);
    });

    it('delivers a site event to role A and the S1 operator on S1, never to role B', () => {
      const s1Event = eventModuleRooms(T, 'farm', S1);
      const s2Event = eventModuleRooms(T, 'farm', S2);
      const siteless = eventModuleRooms(T, 'farm', null);
      const roleA = memberModuleRooms(member('roleA'), 'farm');
      const operator = memberModuleRooms(member('farmOperatorS1'), 'farm');
      const roleB = memberModuleRooms(member('roleB'), 'farm');

      expect([
        receives(roleA, s1Event),
        receives(roleA, s2Event),
        receives(roleA, siteless),
      ]).toEqual([true, true, true]);
      expect([
        receives(operator, s1Event),
        receives(operator, s2Event),
        receives(operator, siteless),
      ]).toEqual([true, false, false]);
      expect([receives(roleB, s1Event), receives(roleB, siteless)]).toEqual([false, false]);
    });
  });

  describe('joining and emitting through the vocabulary', () => {
    it('joins, leaves and emits exactly the rooms it is given', async () => {
      const rooms = memberModuleRooms(member('farmOperatorS1'), 'farm');
      const join = jest.fn().mockResolvedValue(undefined);
      const leave = jest.fn().mockResolvedValue(undefined);
      const socket = collaborator<Socket>({ join, leave }, 'Socket');
      const emit = jest.fn().mockReturnValue(true);
      const to = jest.fn().mockReturnValue({ emit });
      const server = collaborator<Server>({ to }, 'Server');

      await joinModuleRooms(socket, rooms);
      await leaveModuleRooms(socket, rooms);
      emitToModuleRooms(server, eventModuleRooms(T, 'farm', S1), 'batchClosed', { id: 'b1' });

      expect(join).toHaveBeenCalledWith([`t:${T}:m:farm:site:${S1}`]);
      expect(leave).toHaveBeenCalledWith(`t:${T}:m:farm:site:${S1}`);
      expect(to).toHaveBeenCalledWith([`t:${T}:m:farm`, `t:${T}:m:farm:site:${S1}`]);
      expect(emit).toHaveBeenCalledWith('batchClosed', { id: 'b1' });
    });
  });
});
