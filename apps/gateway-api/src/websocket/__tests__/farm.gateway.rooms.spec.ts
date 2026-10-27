import { collaborator, stub } from '@aquaculture/testing';
import type { ConfigService } from '@nestjs/config';
import type { JwtService } from '@nestjs/jwt';
import type { Server, Socket } from 'socket.io';
import { TenantConnectionLimiter, WsTokenRevalidator } from '@aquaculture/backend-common/websocket';

import { FarmGateway } from '../farm.gateway';
import type { FarmWsEventType } from '../farm-ws-event-access';

const T = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const S1 = '33333333-3333-4333-8333-333333333331';
const S2 = '33333333-3333-4333-8333-333333333332';

/** The ADR-051 §4 viewers, as the claims of their access tokens. */
const ROLE_A = { roles: ['MODULE_USER'], moduleAccess: { farm: 'MODULE_MANAGER' } };
const ROLE_A_PRIME = { roles: ['MODULE_MANAGER'], moduleAccess: { farm: 'MODULE_MANAGER' } };
const ROLE_B = { roles: ['MODULE_USER'], moduleAccess: {}, resourcePermissions: ['company:view'] };
const ROLE_B_PRIME = {
  roles: ['MODULE_MANAGER'],
  moduleAccess: {},
  resourcePermissions: ['company:view'],
};
const OPERATOR_S1 = {
  roles: ['MODULE_USER'],
  moduleAccess: { farm: 'MODULE_USER' },
  assignedSiteIds: [S1],
};
const HR_MANAGER = { roles: ['MODULE_USER'], moduleAccess: { hr: 'MODULE_MANAGER' } };
const TENANT_ADMIN = {
  roles: ['TENANT_ADMIN'],
  moduleAccess: { farm: 'MODULE_MANAGER', hr: 'MODULE_MANAGER', sensor: 'MODULE_MANAGER' },
};

interface Harness {
  gateway: FarmGateway;
  revalidator: WsTokenRevalidator;
  verifyAsync: jest.Mock;
  emitTo: jest.Mock;
}

interface Connected {
  client: Socket;
  joined: string[];
  emit: jest.Mock;
  disconnect: jest.Mock;
}

function harness(isStillValid: () => Promise<boolean> = async () => true): Harness {
  const configService = stub<ConfigService>({ get: jest.fn().mockReturnValue('test') });
  const revalidator = new WsTokenRevalidator({ intervalMs: 60_000, isStillValid });
  const verifyAsync = jest.fn();
  const gateway = new FarmGateway(
    stub<JwtService>({ verifyAsync }),
    configService,
    new TenantConnectionLimiter(),
    revalidator,
  );
  const emitTo = jest.fn().mockReturnValue(true);
  gateway.server = collaborator<Server>(
    {
      to: jest.fn().mockImplementation((rooms: string[]) => ({
        emit: (...args: unknown[]) => emitTo(rooms, ...args),
      })),
    },
    'Server',
  );
  return { gateway, revalidator, verifyAsync, emitTo };
}

async function connect(
  h: Harness,
  claims: Record<string, unknown>,
  socketId = 'sock-1',
): Promise<Connected> {
  const joined: string[] = [];
  const emit = jest.fn();
  const disconnect = jest.fn();
  const join = jest.fn(async (rooms: string[]) => {
    joined.push(...rooms);
  });
  h.verifyAsync.mockResolvedValueOnce({
    sub: USER,
    tenantId: T,
    type: 'access',
    jti: 'j1',
    iat: 1_800_000_000,
    ...claims,
  });
  const client = collaborator<Socket>(
    {
      id: socketId,
      emit,
      disconnect,
      join,
      handshake: stub<Socket['handshake']>({ auth: { token: 't' }, headers: {}, query: {} }),
    },
    'Socket',
  );
  await h.gateway.handleConnection(client);
  return { client, joined, emit, disconnect };
}

/** The rooms each farm event of `cases` was emitted to. */
function emittedRooms(
  h: Harness,
  cases: ReadonlyArray<[FarmWsEventType, Record<string, unknown>]>,
): string[][] {
  h.emitTo.mockClear();
  for (const [type, event] of cases) h.gateway.broadcastFarmEvent(T, type, event);
  return h.emitTo.mock.calls.map(([rooms]) => rooms as string[]);
}

/** Socket.IO delivers an emit to a socket that joined any one of its rooms. */
function receives(joined: readonly string[], rooms: readonly string[]): boolean {
  return rooms.some((room) => joined.includes(room));
}

const EVENTS: ReadonlyArray<[FarmWsEventType, Record<string, unknown>]> = [
  ['MortalityRecorded', { eventType: 'MortalityRecorded', siteId: S1 }],
  ['MortalityRecorded', { eventType: 'MortalityRecorded', siteId: S2 }],
  ['MealFed', { eventType: 'MealFed' }],
  ['SiteCreated', { eventType: 'SiteCreated', siteId: S2 }],
];

/**
 * SEC-CRITICAL-206 room specs (ADR-051 §3 step 1, §4): /farms joins a socket only to the rooms
 * decideAccess allows from the token's moduleAccess and assigned sites, and every farm event is
 * emitted only to the rooms its access entry derives.
 */
describe('FarmGateway rooms (SEC-CRITICAL-206)', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('joins role A (farm MODULE_MANAGER) to the farm module room and the farm registry room', async () => {
    const h = harness();
    const socket = await connect(h, ROLE_A);

    expect(socket.joined).toEqual([`t:${T}:m:farm`, `t:${T}:registry:farm`]);
    expect(socket.disconnect).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith('connected', expect.objectContaining({ tenantId: T }));
    h.revalidator.onModuleDestroy();
  });

  it('gives A′ (role A plus the global MODULE_MANAGER) exactly the rooms of role A', async () => {
    const h = harness();
    const socket = await connect(h, ROLE_A_PRIME);

    expect(socket.joined).toEqual([`t:${T}:m:farm`, `t:${T}:registry:farm`]);
    h.revalidator.onModuleDestroy();
  });

  it.each([
    ['role B (Company Viewer, no grants)', ROLE_B],
    ['B′ (role B plus the global MODULE_MANAGER)', ROLE_B_PRIME],
  ])('refuses %s: no farm room is joined and the socket is dropped', async (_viewer, claims) => {
    const h = harness();
    const socket = await connect(h, claims);

    expect(socket.joined).toEqual([]);
    expect(socket.emit).toHaveBeenCalledWith('error', { message: 'Forbidden' });
    expect(socket.disconnect).toHaveBeenCalled();
    h.revalidator.onModuleDestroy();
  });

  it('joins the S1 operator (farm MODULE_USER on S1) to the S1 site room only', async () => {
    const h = harness();
    const socket = await connect(h, OPERATOR_S1);

    expect(socket.joined).toEqual([`t:${T}:m:farm:site:${S1}`, `t:${T}:registry:farm`]);
    h.revalidator.onModuleDestroy();
  });

  it('refuses a handshake whose moduleAccess claim is malformed', async () => {
    const h = harness();
    const socket = await connect(h, { roles: ['MODULE_USER'], moduleAccess: { farm: 'OWNER' } });

    expect(socket.joined).toEqual([]);
    expect(socket.emit).toHaveBeenCalledWith('error', { message: 'Invalid token' });
    expect(socket.disconnect).toHaveBeenCalled();
    h.revalidator.onModuleDestroy();
  });

  it('emits each event to the rooms of its entry, under its client name', () => {
    const h = harness();
    const event = { eventType: 'MortalityRecorded', siteId: S2 };

    h.gateway.broadcastFarmEvent(T, 'MortalityRecorded', event);

    expect(h.emitTo).toHaveBeenCalledWith(
      [`t:${T}:m:farm`, `t:${T}:m:farm:site:${S2}`],
      'mortalityRecorded',
      event,
    );
    h.revalidator.onModuleDestroy();
  });

  it('delivers farm-private events to role A and TENANT_ADMIN, never to role B', async () => {
    const h = harness();
    const roleA = await connect(h, ROLE_A, 'a');
    const admin = await connect(h, TENANT_ADMIN, 'admin');
    const roleB = await connect(h, ROLE_B, 'b');
    const rooms = emittedRooms(h, EVENTS);

    expect(rooms.map((r) => receives(roleA.joined, r))).toEqual([true, true, true, true]);
    expect(rooms.map((r) => receives(admin.joined, r))).toEqual([true, true, true, true]);
    expect(rooms.map((r) => receives(roleB.joined, r))).toEqual([false, false, false, false]);
    h.revalidator.onModuleDestroy();
  });

  it('delivers to the S1 operator the S1 event and the registry, not S2 or siteless farm events', async () => {
    const h = harness();
    const operator = await connect(h, OPERATOR_S1);
    const rooms = emittedRooms(h, EVENTS);

    expect(rooms.map((r) => receives(operator.joined, r))).toEqual([true, false, false, true]);
    h.revalidator.onModuleDestroy();
  });

  it('delivers no farm-private event to an HR manager, whose grant is not farm', async () => {
    const h = harness();
    const hr = await connect(h, HR_MANAGER);
    const rooms = emittedRooms(h, EVENTS);

    expect(hr.joined).toEqual([`t:${T}:registry:hr`]);
    expect(rooms.map((r) => receives(hr.joined, r))).toEqual([false, false, false, false]);
    h.revalidator.onModuleDestroy();
  });

  it('drops a socket within one 60 s revalidation once its access is revoked, and refuses the new token', async () => {
    jest.useFakeTimers();
    let valid = true;
    const h = harness(async () => valid);
    const roleA = await connect(h, ROLE_A);

    // PKG-06 revokes the user's tokens when a grant changes (user epoch, RBAC-HIGH-035).
    valid = false;
    await jest.advanceTimersByTimeAsync(60_000);

    expect(roleA.disconnect).toHaveBeenCalledWith(true);
    const reconnected = await connect(h, { roles: ['MODULE_USER'], moduleAccess: {} }, 'sock-2');
    expect(reconnected.joined).toEqual([]);
    expect(reconnected.disconnect).toHaveBeenCalled();
    h.revalidator.onModuleDestroy();
  });
});
