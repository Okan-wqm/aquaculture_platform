import { ScadaRuntimeGateway } from '../scada-runtime.gateway';
import { ScadaSocketEvent } from '../scada-types';
import {
  TagDataType,
  TagDirection,
  TagIoType,
} from '../../process/entities/unified-tag.entity';

/**
 * TAG_WRITE tenant + registry ownership gate (SENSOR-CRITICAL-005).
 *
 * A control write must resolve STRICTLY against the connecting tenant's
 * registry — no legacy-key grandfathering, and only writable (non-INPUT)
 * tags — so a tenant-A socket can never actuate a tenant-B device by a
 * predictable deviceCode/localName, and the emitted write carries the tenant.
 */

interface ResolvedBinding {
  ref: string;
  unifiedTagId: string;
  ioType: TagIoType;
  dataType: TagDataType;
  direction: TagDirection;
  source: Record<string, unknown>;
  revision: number;
}

function binding(direction: TagDirection): ResolvedBinding {
  return {
    ref: 'EDGE-01/pump.cmd',
    unifiedTagId: 't1',
    ioType: TagIoType.DO,
    dataType: TagDataType.BOOL,
    direction,
    source: {},
    revision: 1,
  };
}

function makeGateway(
  resolveResult: { resolved: ResolvedBinding[]; unresolved: unknown[] },
  opts?: { pinProtectedKeys?: string[]; pinValid?: boolean },
) {
  const tagManager = { writeTagValue: jest.fn() };
  const tagResolution = { resolve: jest.fn().mockResolvedValue(resolveResult) };
  const eventEmitter = { emit: jest.fn() };
  const scadaPackages = {
    getPinProtectedTagKeys: jest.fn().mockResolvedValue(new Set(opts?.pinProtectedKeys ?? [])),
    verifyPackagePin: jest.fn().mockResolvedValue(opts?.pinValid ?? false),
  };
  const gateway = new ScadaRuntimeGateway(
    {} as never,
    tagManager as never,
    { get: () => '' } as never,
    tagResolution as never,
    eventEmitter as never,
    { queryChunked: jest.fn() } as never,
    scadaPackages as never,
  );
  return { gateway, tagManager, tagResolution, eventEmitter, scadaPackages };
}

function seedClient(gateway: ScadaRuntimeGateway, socket: { id: string; emit: jest.Mock }) {
  // The clients registry is private; seed it directly for the handler test.
  const internals: unknown = gateway;
  (internals as { clients: Map<string, unknown> }).clients.set(socket.id, {
    socket,
    tenantId: 'tenant-A',
    userId: 'u1',
    role: 'operator',
  });
}

function makeSocket() {
  return { id: 'sock1', emit: jest.fn() };
}

describe('TAG_WRITE tenant + registry gate', () => {
  it('rejects a write to a tag not registered for the connecting tenant', async () => {
    const { gateway, tagManager, tagResolution } = makeGateway({ resolved: [], unresolved: [{ ref: 'EDGE-01/pump.cmd', reason: 'NOT_FOUND' }] });
    const socket = makeSocket();
    seedClient(gateway, socket);

    await gateway.handleTagWrite(socket as never, { tagId: 'EDGE-01/pump.cmd', value: 1 } as never);

    expect(tagResolution.resolve).toHaveBeenCalledWith('tenant-A', ['EDGE-01/pump.cmd']);
    expect(tagManager.writeTagValue).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith('scada:error', expect.objectContaining({ code: 'FORBIDDEN' }));
  });

  it('rejects a write to a read-only (INPUT) tag', async () => {
    const { gateway, tagManager } = makeGateway({ resolved: [binding(TagDirection.INPUT)], unresolved: [] });
    const socket = makeSocket();
    seedClient(gateway, socket);

    await gateway.handleTagWrite(socket as never, { tagId: 'EDGE-01/pump.cmd', value: 1 } as never);

    expect(tagManager.writeTagValue).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith('scada:error', expect.objectContaining({ code: 'FORBIDDEN' }));
  });

  it('writes a registered OUTPUT tag with the tenant and ACKs queued (not accepted)', async () => {
    const { gateway, tagManager } = makeGateway({ resolved: [binding(TagDirection.OUTPUT)], unresolved: [] });
    const socket = makeSocket();
    seedClient(gateway, socket);

    await gateway.handleTagWrite(socket as never, { tagId: 'EDGE-01/pump.cmd', value: 1 } as never);

    expect(tagManager.writeTagValue).toHaveBeenCalledWith('EDGE-01/pump.cmd', 1, 'u1', 'tenant-A', 'set');
    expect(socket.emit).toHaveBeenCalledWith(
      ScadaSocketEvent.TAG_WRITE_ACK,
      expect.objectContaining({ status: 'queued' }),
    );
  });
});

describe('PIN control-security gate (SENSOR-CRITICAL-006)', () => {
  it('rejects a write to a PIN-protected tag when the socket is not elevated', async () => {
    const { gateway, tagManager } = makeGateway(
      { resolved: [binding(TagDirection.OUTPUT)], unresolved: [] },
      { pinProtectedKeys: ['EDGE-01/pump.cmd'] },
    );
    const socket = makeSocket();
    seedClient(gateway, socket);

    await gateway.handleTagWrite(socket as never, { tagId: 'EDGE-01/pump.cmd', value: 1 } as never);

    expect(tagManager.writeTagValue).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith('scada:error', expect.objectContaining({ code: 'FORBIDDEN' }));
  });

  it('allows the write after a successful PIN_VERIFY elevates the socket', async () => {
    const { gateway, tagManager } = makeGateway(
      { resolved: [binding(TagDirection.OUTPUT)], unresolved: [] },
      { pinProtectedKeys: ['EDGE-01/pump.cmd'], pinValid: true },
    );
    const socket = makeSocket();
    seedClient(gateway, socket);

    await gateway.handlePinVerify(socket as never, { packageId: 'pkg-1', pin: '1234' } as never);
    expect(socket.emit).toHaveBeenCalledWith(
      'scada:pin:result',
      expect.objectContaining({ valid: true, expiresAt: expect.any(Number) }),
    );

    await gateway.handleTagWrite(socket as never, { tagId: 'EDGE-01/pump.cmd', value: 1 } as never);
    expect(tagManager.writeTagValue).toHaveBeenCalled();
  });

  it('locks PIN verification after repeated failures (brute-force limit)', async () => {
    const { gateway, scadaPackages } = makeGateway(
      { resolved: [binding(TagDirection.OUTPUT)], unresolved: [] },
      { pinValid: false },
    );
    const socket = makeSocket();
    seedClient(gateway, socket);

    for (let i = 0; i < 5; i++) {
      await gateway.handlePinVerify(socket as never, { packageId: 'pkg-1', pin: 'wrong' } as never);
    }
    // The 5th failure returns a lockout...
    expect(socket.emit).toHaveBeenLastCalledWith(
      'scada:pin:result',
      expect.objectContaining({ valid: false, lockedUntil: expect.any(Number) }),
    );

    // ...and while locked, verification is short-circuited (no hash check).
    scadaPackages.verifyPackagePin.mockClear();
    await gateway.handlePinVerify(socket as never, { packageId: 'pkg-1', pin: 'wrong' } as never);
    expect(scadaPackages.verifyPackagePin).not.toHaveBeenCalled();
  });

  it('writes to unprotected tags never consult the PIN gate elevation', async () => {
    const { gateway, tagManager } = makeGateway(
      { resolved: [binding(TagDirection.OUTPUT)], unresolved: [] },
      { pinProtectedKeys: ['EDGE-01/other.tag'] },
    );
    const socket = makeSocket();
    seedClient(gateway, socket);

    await gateway.handleTagWrite(socket as never, { tagId: 'EDGE-01/pump.cmd', value: 1 } as never);
    expect(tagManager.writeTagValue).toHaveBeenCalled();
  });
});

describe('ALARM_ACK forwards to the alarm engine (SENSOR-HIGH-039)', () => {
  it('emits a tenant-scoped alarm-ack event instead of silently no-op', () => {
    const { gateway, eventEmitter } = makeGateway({ resolved: [], unresolved: [] });
    const socket = makeSocket();
    seedClient(gateway, socket);

    gateway.handleAlarmAck(socket as never, { alarmInstanceId: 'alm-1' } as never);

    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'scada.alarm.ack',
      expect.objectContaining({ alarmInstanceId: 'alm-1', userId: 'u1', tenantId: 'tenant-A' }),
    );
  });

  it('emits an alarm-ack-all event carrying the tenant', () => {
    const { gateway, eventEmitter } = makeGateway({ resolved: [], unresolved: [] });
    const socket = makeSocket();
    seedClient(gateway, socket);

    gateway.handleAlarmAckAll(socket as never, {} as never);

    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'scada.alarm.ack_all',
      expect.objectContaining({ userId: 'u1', tenantId: 'tenant-A' }),
    );
  });
});
