import { BadRequestException } from '@nestjs/common';

import { VfdDevice } from '../../entities/vfd-device.entity';
import { VfdEdgeWriteService } from '../vfd-edge-write.service';

/**
 * SENSOR-CRITICAL-007 — the edge-delegated write primitive must never report
 * success unless the edge gateway actually acknowledged the write. These tests
 * pin: real ack → success; edge failure/timeout → honest failure; unbound
 * drive / out-of-range → fail-closed; and no cross-talk with other commands.
 */
describe('VfdEdgeWriteService (SENSOR-CRITICAL-007)', () => {
  let publishMock: jest.Mock;
  let mqtt: { isConnectedToBroker: jest.Mock; publish: jest.Mock };
  let service: VfdEdgeWriteService;

  const boundDevice = (): VfdDevice =>
    ({
      id: 'vfd-1',
      tenantId: 'tenant-1',
      edgeDeviceId: 'edge-1',
      edgeModbusDeviceName: 'vfd-pump-1',
    }) as VfdDevice;

  const flushPublish = () => new Promise((resolve) => setImmediate(resolve));

  beforeEach(() => {
    publishMock = jest.fn().mockResolvedValue(undefined);
    mqtt = { isConnectedToBroker: jest.fn().mockReturnValue(true), publish: publishMock };
    service = new VfdEdgeWriteService(mqtt as never);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('publishes a write_modbus envelope to the drive’s edge gateway topic', async () => {
    const promise = service.writeRegister(boundDevice(), 100, 0x0006, 'STOP');
    await flushPublish();

    expect(publishMock).toHaveBeenCalledTimes(1);
    const [topic, envelope] = publishMock.mock.calls[0];
    expect(topic).toBe('tenants/tenant-1/devices/edge-1/commands');
    expect(envelope).toMatchObject({
      command: 'write_modbus',
      params: { device: 'vfd-pump-1', address: 100, value: 0x0006 },
    });
    expect(typeof envelope.commandId).toBe('string');

    // Resolve so the promise/timeout does not dangle.
    service.handleWriteResponse({ commandId: envelope.commandId, success: true });
    await promise;
  });

  it('resolves success only when the edge acknowledges success', async () => {
    const promise = service.writeRegister(boundDevice(), 100, 1, 'START');
    await flushPublish();
    const { commandId } = publishMock.mock.calls[0][1];

    service.handleWriteResponse({ commandId, success: true, result: { ok: true } });

    const result = await promise;
    expect(result.success).toBe(true);
    expect(result.commandId).toBe(commandId);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('resolves an honest failure when the edge reports the write failed', async () => {
    const promise = service.writeRegister(boundDevice(), 100, 1, 'START');
    await flushPublish();
    const { commandId } = publishMock.mock.calls[0][1];

    service.handleWriteResponse({ commandId, success: false, error: 'No Modbus devices configured' });

    const result = await promise;
    expect(result.success).toBe(false);
    expect(result.error).toBe('No Modbus devices configured');
  });

  it('fails closed when the drive is not bound to an edge gateway', async () => {
    const unbound = { id: 'vfd-2', tenantId: 'tenant-1' } as VfdDevice;
    await expect(service.writeRegister(unbound, 100, 1, 'START')).rejects.toThrow(BadRequestException);
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('rejects an out-of-range Modbus address or value', async () => {
    await expect(service.writeRegister(boundDevice(), 70000, 1, 'X')).rejects.toThrow(BadRequestException);
    await expect(service.writeRegister(boundDevice(), 100, -1, 'X')).rejects.toThrow(BadRequestException);
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('resolves a failure when the publish itself fails', async () => {
    publishMock.mockRejectedValueOnce(new Error('broker down'));
    const result = await service.writeRegister(boundDevice(), 100, 1, 'START');
    expect(result.success).toBe(false);
    expect(result.error).toContain('broker down');
  });

  it('resolves a timeout failure when no ack arrives', async () => {
    jest.useFakeTimers();
    const promise = service.writeRegister(boundDevice(), 100, 1, 'START');
    // Let the publish microtask settle before advancing the timeout clock.
    await Promise.resolve();
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(10000);
    const result = await promise;
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/did not acknowledge/i);
  });

  it('ignores a response whose commandId is not a pending write', () => {
    // No pending writes — a ping/scan ack must not throw or mis-resolve.
    expect(() => service.handleWriteResponse({ commandId: 'someone-elses-uuid', success: true })).not.toThrow();
  });

  it('throws when the MQTT broker is not connected', async () => {
    mqtt.isConnectedToBroker.mockReturnValue(false);
    await expect(service.writeRegister(boundDevice(), 100, 1, 'START')).rejects.toThrow(BadRequestException);
  });
});
