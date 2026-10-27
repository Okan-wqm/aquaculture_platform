import { collaborator, stub } from '@aquaculture/testing';
import type { ConfigService } from '@nestjs/config';
import type { JwtService } from '@nestjs/jwt';
import type { DevicePlacement } from '@platform/event-contracts';
import type { Server, Socket } from 'socket.io';
import { TenantConnectionLimiter, WsTokenRevalidator } from '@aquaculture/backend-common/websocket';

import { SensorReadingsGateway } from '../sensor-readings.gateway';
import { DeviceOwnershipService } from '../services/device-ownership.service';

const T = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '99999999-9999-4999-8999-999999999999';
const USER = '22222222-2222-4222-8222-222222222222';
const S1 = '33333333-3333-4333-8333-333333333331';
const S9 = '33333333-3333-4333-8333-333333333339';
const SENSOR = '55555555-5555-4555-8555-555555555555';
const DEVICE = 'PLC-01';

const ROLE_A = { roles: ['MODULE_USER'], moduleAccess: { farm: 'MODULE_MANAGER' } };
const ROLE_B = { roles: ['MODULE_USER'], moduleAccess: {}, resourcePermissions: ['company:view'] };
const FARM_OPERATOR_S1 = {
  roles: ['MODULE_USER'],
  moduleAccess: { farm: 'MODULE_USER' },
  assignedSiteIds: [S1],
};
const SENSOR_MANAGER_S9 = {
  roles: ['MODULE_USER'],
  moduleAccess: { sensor: 'MODULE_MANAGER' },
  assignedSiteIds: [S9],
};
const SENSOR_OPERATOR_S9 = {
  roles: ['MODULE_USER'],
  moduleAccess: { sensor: 'MODULE_USER' },
  assignedSiteIds: [S9],
};

interface Harness {
  gateway: SensorReadingsGateway;
  revalidator: WsTokenRevalidator;
  verifyAsync: jest.Mock;
  devicePlacement: jest.Mock;
  emitTo: jest.Mock;
}

interface Connected {
  client: Socket;
  joined: string[];
  left: string[];
  emit: jest.Mock;
  disconnect: jest.Mock;
}

function harness(): Harness {
  const verifyAsync = jest.fn();
  const devicePlacement = jest.fn();
  const revalidator = new WsTokenRevalidator({
    intervalMs: 60_000,
    isStillValid: async () => true,
  });
  const gateway = new SensorReadingsGateway(
    stub<JwtService>({ verifyAsync }),
    collaborator<DeviceOwnershipService>({ devicePlacement }, 'DeviceOwnershipService'),
    stub<ConfigService>({ get: jest.fn().mockReturnValue('test') }),
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
  return { gateway, revalidator, verifyAsync, devicePlacement, emitTo };
}

async function connect(
  h: Harness,
  claims: Record<string, unknown>,
  socketId = 'sock-1',
): Promise<Connected> {
  const joined: string[] = [];
  const left: string[] = [];
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
      id: socketId,
      emit,
      disconnect,
      join: jest.fn(async (rooms: string[]) => {
        joined.push(...rooms);
      }),
      leave: jest.fn(async (room: string) => {
        left.push(room);
      }),
      handshake: stub<Socket['handshake']>({ auth: { token: 't' }, headers: {}, query: {} }),
    },
    'Socket',
  );
  await h.gateway.handleConnection(client);
  return { client, joined, left, emit, disconnect };
}

function reading(tenantId: string): Parameters<SensorReadingsGateway['broadcastSensorReading']>[0] {
  return {
    eventId: 'e1',
    sensorId: SENSOR,
    sensorName: 'DO probe',
    tenantId,
    readings: { dissolvedOxygen: 7.1 },
    timestamp: '2026-10-27T00:00:00.000Z',
  };
}

function receives(joined: readonly string[], rooms: readonly string[]): boolean {
  return rooms.some((room) => joined.includes(room));
}

/**
 * SEC-CRITICAL-207 room specs for /sensors (ADR-051 §3 step 1, §4): the handshake requires a
 * sensor grant, sensor rooms carry the tenant prefix, a site-bound sensor operator receives only
 * the readings and devices of its sites, and roles A and B are refused.
 */
describe('SensorReadingsGateway rooms (SEC-CRITICAL-207)', () => {
  it.each([
    ['role A (farm only)', ROLE_A],
    ['role B (Company Viewer, no grants)', ROLE_B],
    ['the farm operator on S1', FARM_OPERATOR_S1],
  ])('refuses %s at the handshake', async (_viewer, claims) => {
    const h = harness();
    const socket = await connect(h, claims);

    expect(socket.emit).toHaveBeenCalledWith('error', { message: 'Forbidden' });
    expect(socket.disconnect).toHaveBeenCalled();
    const subscribed = await h.gateway.handleSubscribe(socket.client, { sensorIds: [SENSOR] });
    expect(subscribed.success).toBe(false);
    expect(socket.joined).toEqual([]);
    h.revalidator.onModuleDestroy();
  });

  it('joins a sensor manager to the tenant-prefixed room of each sensor it subscribes', async () => {
    const h = harness();
    const socket = await connect(h, SENSOR_MANAGER_S9);

    const result = await h.gateway.handleSubscribe(socket.client, { sensorIds: [SENSOR] });

    expect(result).toEqual({ success: true, subscribedTo: [SENSOR] });
    expect(socket.joined).toEqual([`t:${T}:m:sensor:sensor:${SENSOR}`]);
    h.revalidator.onModuleDestroy();
  });

  it('joins a site-bound sensor operator to the sensor room of its site only', async () => {
    const h = harness();
    const socket = await connect(h, SENSOR_OPERATOR_S9);

    await h.gateway.handleSubscribe(socket.client, { sensorIds: [SENSOR] });
    await h.gateway.handleUnsubscribe(socket.client, { sensorIds: [SENSOR] });

    expect(socket.joined).toEqual([`t:${T}:m:sensor:site:${S9}:sensor:${SENSOR}`]);
    expect(socket.left).toEqual([`t:${T}:m:sensor:site:${S9}:sensor:${SENSOR}`]);
    h.revalidator.onModuleDestroy();
  });

  it('emits a reading to the sensor room and the room of the site the reading names', () => {
    const h = harness();

    h.gateway.broadcastSensorReading(reading(T), S9);
    h.gateway.broadcastSensorReading(reading(T), null);

    expect(h.emitTo.mock.calls).toEqual([
      [
        [`t:${T}:m:sensor:sensor:${SENSOR}`, `t:${T}:m:sensor:site:${S9}:sensor:${SENSOR}`],
        'sensorReading',
        reading(T),
      ],
      [[`t:${T}:m:sensor:sensor:${SENSOR}`], 'sensorReading', reading(T)],
    ]);
    h.revalidator.onModuleDestroy();
  });

  it('delivers a reading to the S9 operator only from S9, and never across tenants', async () => {
    const h = harness();
    const manager = await connect(h, SENSOR_MANAGER_S9, 'manager');
    const operator = await connect(h, SENSOR_OPERATOR_S9, 'operator');
    await h.gateway.handleSubscribe(manager.client, { sensorIds: [SENSOR] });
    await h.gateway.handleSubscribe(operator.client, { sensorIds: [SENSOR] });

    h.gateway.broadcastSensorReading(reading(T), S9);
    h.gateway.broadcastSensorReading(reading(T), S1);
    h.gateway.broadcastSensorReading(reading(T), null);
    h.gateway.broadcastSensorReading(reading(OTHER_TENANT), S9);
    const rooms = h.emitTo.mock.calls.map(([emitted]) => emitted as string[]);

    expect(rooms.map((r) => receives(manager.joined, r))).toEqual([true, true, true, false]);
    expect(rooms.map((r) => receives(operator.joined, r))).toEqual([true, false, false, false]);
    h.revalidator.onModuleDestroy();
  });

  it.each<[string, Record<string, unknown>, DevicePlacement | null, boolean]>([
    ['a sensor manager to a device on another site', SENSOR_MANAGER_S9, { siteId: S1 }, true],
    ['a sensor manager to a device without a site', SENSOR_MANAGER_S9, { siteId: null }, true],
    ['the S9 operator to a device on S9', SENSOR_OPERATOR_S9, { siteId: S9 }, true],
    ['the S9 operator to a device on S1', SENSOR_OPERATOR_S9, { siteId: S1 }, false],
    ['the S9 operator to a device without a site', SENSOR_OPERATOR_S9, { siteId: null }, false],
    ['a sensor manager to a device of another tenant', SENSOR_MANAGER_S9, null, false],
  ])('subscribes %s to edge I/O', async (_case, claims, placement, admitted) => {
    const h = harness();
    h.devicePlacement.mockResolvedValue(placement);
    const socket = await connect(h, claims);

    const result = await h.gateway.handleSubscribeEdgeIo(socket.client, { deviceCode: DEVICE });

    expect(h.devicePlacement).toHaveBeenCalledWith(DEVICE, T);
    expect(result.success).toBe(admitted);
    expect(socket.joined).toEqual(admitted ? [`t:${T}:m:sensor:edge-io:${DEVICE}`] : []);
    h.revalidator.onModuleDestroy();
  });

  it('emits edge I/O and edge alarms to the tenant-prefixed device room', () => {
    const h = harness();

    h.gateway.broadcastEdgeIoData({ tenantId: T, deviceCode: DEVICE, tags: {}, timestamp: 't0' });
    h.gateway.broadcastEdgeAlarm({ tenantId: T, deviceCode: DEVICE, alarms: [], timestamp: 't0' });

    expect(h.emitTo.mock.calls.map(([rooms, event]) => [rooms, event])).toEqual([
      [[`t:${T}:m:sensor:edge-io:${DEVICE}`], 'edgeIoData'],
      [[`t:${T}:m:sensor:edge-io:${DEVICE}`], 'edgeAlarm'],
    ]);
    h.revalidator.onModuleDestroy();
  });
});
