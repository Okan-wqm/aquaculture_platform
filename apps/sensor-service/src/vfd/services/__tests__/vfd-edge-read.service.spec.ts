/**
 * VfdEdgeReadService — edge-delegated VFD read primitive (SENSOR-CRITICAL-007).
 *
 * Pins the guarantees the motor-state interlock + parameter read-back depend on:
 * a real edge round-trip (never a cloud fabrication), fail-closed on an unbound
 * drive, and `found:false` — NOT zero — when the register is absent from the
 * edge's response (a fail-open motor read is the SENSOR-HIGH-074 hazard).
 */
import { BadRequestException } from '@nestjs/common';

import { VfdEdgeReadService } from '../vfd-edge-read.service';
import { VfdDevice } from '../../entities/vfd-device.entity';
import { VfdBrand, VfdDeviceStatus, VfdProtocol } from '../../entities/vfd.enums';

function boundDevice(): VfdDevice {
  const device = new VfdDevice();
  device.id = 'vfd-1';
  device.tenantId = 'tenant-1';
  device.name = 'Pump VFD';
  device.brand = VfdBrand.DANFOSS;
  device.protocol = VfdProtocol.MODBUS_TCP;
  device.protocolConfiguration = { host: '10.0.0.5', port: 502, unitId: 1 } as never;
  device.status = VfdDeviceStatus.ACTIVE;
  device.pollIntervalMs = 1000;
  device.isPollingEnabled = true;
  device.edgeDeviceId = 'edge-1';
  device.edgeModbusDeviceName = 'vfd-pump-1';
  device.createdAt = new Date();
  device.updatedAt = new Date();
  return device;
}

function makeService(connected = true) {
  const mqtt = {
    isConnectedToBroker: jest.fn().mockReturnValue(connected),
    publish: jest.fn().mockResolvedValue(undefined),
  };
  const svc = new VfdEdgeReadService(mqtt as never);
  return { svc, mqtt };
}

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

interface PublishedEnvelope {
  commandId: string;
  command: string;
  params: { device: string };
}

function ackWith(commandId: string, deviceName: string, address: number, rawValue: number) {
  return {
    commandId,
    success: true,
    result: {
      devices: [
        {
          device: deviceName,
          values: [{ name: 'status_word', address, raw_value: rawValue, scaled_value: rawValue }],
        },
      ],
    },
  };
}

describe('VfdEdgeReadService', () => {
  it('publishes read_modbus and resolves with the register value on the ack', async () => {
    const { svc, mqtt } = makeService();
    const pending = svc.readRegister(boundDevice(), 8451, 'motor status word');
    await flush();

    expect(mqtt.publish).toHaveBeenCalledTimes(1);
    const [topic, envelope] = mqtt.publish.mock.calls[0] as [string, PublishedEnvelope];
    expect(topic).toBe('tenants/tenant-1/devices/edge-1/commands');
    expect(envelope.command).toBe('read_modbus');
    expect(envelope.params.device).toBe('vfd-pump-1');

    svc.handleReadResponse(ackWith(envelope.commandId, 'vfd-pump-1', 8451, 0x0007));
    const result = await pending;
    expect(result.success).toBe(true);
    expect(result.found).toBe(true);
    expect(result.rawValue).toBe(0x0007);
  });

  it('reports found:false (not zero) when the register is absent from the response', async () => {
    const { svc, mqtt } = makeService();
    const pending = svc.readRegister(boundDevice(), 9999, 'missing register');
    await flush();
    const envelope = mqtt.publish.mock.calls[0][1] as PublishedEnvelope;
    // Ack contains a different address only.
    svc.handleReadResponse(ackWith(envelope.commandId, 'vfd-pump-1', 8451, 3));
    const result = await pending;
    expect(result.success).toBe(true);
    expect(result.found).toBe(false);
    expect(result.rawValue).toBeUndefined();
  });

  it('reports found:false when the edge answered for a different device name', async () => {
    const { svc, mqtt } = makeService();
    const pending = svc.readRegister(boundDevice(), 8451, 'status word');
    await flush();
    const envelope = mqtt.publish.mock.calls[0][1] as PublishedEnvelope;
    svc.handleReadResponse(ackWith(envelope.commandId, 'some-other-drive', 8451, 5));
    const result = await pending;
    expect(result.found).toBe(false);
  });

  it('reports failure with the edge reason when the edge read fails', async () => {
    const { svc, mqtt } = makeService();
    const pending = svc.readRegister(boundDevice(), 8451, 'status word');
    await flush();
    const envelope = mqtt.publish.mock.calls[0][1] as PublishedEnvelope;
    svc.handleReadResponse({
      commandId: envelope.commandId,
      success: false,
      error: 'No Modbus devices configured',
    });
    const result = await pending;
    expect(result.success).toBe(false);
    expect(result.found).toBe(false);
    expect(result.error).toContain('No Modbus devices configured');
  });

  it('fails closed (throws) for a drive not bound to an edge gateway', async () => {
    const { svc, mqtt } = makeService();
    const unbound = boundDevice();
    unbound.edgeDeviceId = undefined;
    unbound.edgeModbusDeviceName = undefined;
    await expect(svc.readRegister(unbound, 8451, 'status word')).rejects.toThrow(
      BadRequestException,
    );
    expect(mqtt.publish).not.toHaveBeenCalled();
  });

  it('fails closed when the broker is disconnected', async () => {
    const { svc, mqtt } = makeService(false);
    await expect(svc.readRegister(boundDevice(), 8451, 'status word')).rejects.toThrow(
      BadRequestException,
    );
    expect(mqtt.publish).not.toHaveBeenCalled();
  });
});
