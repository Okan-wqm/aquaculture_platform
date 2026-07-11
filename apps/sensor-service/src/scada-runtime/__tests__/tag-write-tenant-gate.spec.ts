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

function makeGateway(resolveResult: { resolved: ResolvedBinding[]; unresolved: unknown[] }) {
  const tagManager = { writeTagValue: jest.fn() };
  const tagResolution = { resolve: jest.fn().mockResolvedValue(resolveResult) };
  const gateway = new ScadaRuntimeGateway(
    {} as never,
    tagManager as never,
    { get: () => '' } as never,
    tagResolution as never,
  );
  return { gateway, tagManager, tagResolution };
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
