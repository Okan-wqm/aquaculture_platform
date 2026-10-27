import { collaborator, stub } from '@aquaculture/testing';
import type { ConfigService } from '@nestjs/config';
import type { JwtService } from '@nestjs/jwt';
import type { Server, Socket } from 'socket.io';
import { WsTokenRevalidator } from '@aquaculture/backend-common/websocket';

import { STLanguageGateway } from '../st-language.gateway';

const T = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const S1 = '33333333-3333-4333-8333-333333333331';
const S9 = '33333333-3333-4333-8333-333333333339';

const ROLE_A = { roles: ['MODULE_USER'], moduleAccess: { farm: 'MODULE_MANAGER' } };
const ROLE_B = { roles: ['MODULE_USER'], moduleAccess: {}, resourcePermissions: ['company:view'] };
const FARM_OPERATOR_S1 = {
  roles: ['MODULE_USER'],
  moduleAccess: { farm: 'MODULE_USER' },
  assignedSiteIds: [S1],
};
const SENSOR_MANAGER = { roles: ['MODULE_USER'], moduleAccess: { sensor: 'MODULE_MANAGER' } };
const SENSOR_OPERATOR_S9 = {
  roles: ['MODULE_USER'],
  moduleAccess: { sensor: 'MODULE_USER' },
  assignedSiteIds: [S9],
};

interface Harness {
  gateway: STLanguageGateway;
  revalidator: WsTokenRevalidator;
  verifyAsync: jest.Mock;
  delegate: jest.Mock;
  emitTo: jest.Mock;
}

interface Connected {
  client: Socket;
  joined: string[];
  emit: jest.Mock;
  disconnect: jest.Mock;
}

function harness(): Harness {
  const verifyAsync = jest.fn();
  const revalidator = new WsTokenRevalidator({
    intervalMs: 60_000,
    isStillValid: async () => true,
  });
  const gateway = new STLanguageGateway(
    stub<JwtService>({ verifyAsync }),
    stub<ConfigService>({ get: jest.fn().mockReturnValue('test') }),
    revalidator,
  );
  const delegate = jest.fn().mockResolvedValue({ success: true, data: [] });
  gateway.setNatsDelegate(delegate);
  const emitTo = jest.fn().mockReturnValue(true);
  gateway.server = collaborator<Server>(
    {
      to: jest.fn().mockImplementation((rooms: string[]) => ({
        emit: (...args: unknown[]) => emitTo(rooms, ...args),
      })),
    },
    'Server',
  );
  return { gateway, revalidator, verifyAsync, delegate, emitTo };
}

async function connect(h: Harness, claims: Record<string, unknown>): Promise<Connected> {
  const joined: string[] = [];
  const emit = jest.fn();
  const disconnect = jest.fn();
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
      id: 'sock-1',
      emit,
      disconnect,
      join: jest.fn(async (rooms: string[]) => {
        joined.push(...rooms);
      }),
      handshake: stub<Socket['handshake']>({ auth: { token: 't' }, headers: {}, query: {} }),
    },
    'Socket',
  );
  await h.gateway.handleConnection(client);
  return { client, joined, emit, disconnect };
}

function close(h: Harness, socket: Connected): void {
  h.gateway.handleDisconnect(socket.client);
  h.revalidator.onModuleDestroy();
}

/**
 * SEC-CRITICAL-207 room specs for /st-language (ADR-051 §3 step 1): the ST language socket
 * requires a sensor grant at the handshake, and automation pushes reach the sensor module rooms,
 * never a tenant-wide room.
 */
describe('STLanguageGateway rooms (SEC-CRITICAL-207)', () => {
  it.each([
    ['role A (farm only)', ROLE_A],
    ['role B (Company Viewer, no grants)', ROLE_B],
    ['the farm operator on S1', FARM_OPERATOR_S1],
  ])('refuses %s, and its ST requests never reach sensor-service', async (_viewer, claims) => {
    const h = harness();
    const socket = await connect(h, claims);

    expect(socket.emit).toHaveBeenCalledWith('error', { message: 'Forbidden' });
    expect(socket.disconnect).toHaveBeenCalled();
    expect(socket.joined).toEqual([]);
    const response = await h.gateway.handleStRequest(socket.client, {
      type: 'analyze',
      requestId: 'r1',
      code: 'PROGRAM P END_PROGRAM',
    });
    expect(response.type).toBe('error');
    expect(h.delegate).not.toHaveBeenCalled();
    close(h, socket);
  });

  it('joins a sensor manager to the sensor module room and serves its requests', async () => {
    const h = harness();
    const socket = await connect(h, SENSOR_MANAGER);

    const response = await h.gateway.handleStRequest(socket.client, {
      type: 'analyze',
      requestId: 'r1',
      code: 'PROGRAM P END_PROGRAM',
    });

    expect(socket.joined).toEqual([`t:${T}:m:sensor`]);
    expect(response.type).toBe('diagnostics');
    expect(h.delegate).toHaveBeenCalledWith(T, expect.objectContaining({ requestId: 'r1' }));
    close(h, socket);
  });

  it('joins a site-bound sensor operator to the room of its site', async () => {
    const h = harness();
    const socket = await connect(h, SENSOR_OPERATOR_S9);

    expect(socket.joined).toEqual([`t:${T}:m:sensor:site:${S9}`]);
    close(h, socket);
  });

  it('pushes an automation event to the sensor module room only', () => {
    const h = harness();
    const push = { type: 'tags_changed' as const, data: { programId: 'p1' }, timestamp: 't0' };

    h.gateway.pushAutomationEvent(T, push);

    expect(h.emitTo).toHaveBeenCalledWith([`t:${T}:m:sensor`], 'st:push', push);
    h.revalidator.onModuleDestroy();
  });
});
