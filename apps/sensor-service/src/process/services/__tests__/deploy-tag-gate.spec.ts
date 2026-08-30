import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { Process, ProcessStatus } from '../../entities/process.entity';
import { ProcessService } from '../process.service';
import { TagResolutionService } from '../tag-resolution.service';
import { MqttClientService } from '../../../shared-mqtt/mqtt-client.service';
import { EdgeDeviceService } from '../../../edge-device/edge-device.service';

/**
 * SENSOR-HIGH-051 — the deploy tag-gate (WF-003).
 *
 * Resolution was warn-only on every deploy path: a package/process whose tag
 * bindings did not resolve (unregistered or RETIRED) still shipped to the
 * device with only a log line. With SCADA_DEPLOY_TAG_GATE=enforce the deploy
 * is BLOCKED, each unresolved ref named; the default stays `warn` so tenants
 * with an unpopulated registry keep deploying until ops flips the flag.
 */

const TENANT = 'tenant-uuid-1';

function processRow(): Partial<Process> {
  return {
    id: 'proc-1',
    tenantId: TENANT,
    name: 'P1',
    status: ProcessStatus.ACTIVE,
    version: 2,
    nodes: [
      {
        id: 'n1',
        type: 'equipment',
        position: { x: 0, y: 0 },
        data: {
          equipmentId: 'eq-1',
          equipmentName: 'Tank 1 Pump',
          sensorMappings: [
            {
              sensorId: 'sensor-1',
              sensorName: 'Tank 1 DO Probe',
              channelId: 'chan-1',
              channelName: 'tank1.do',
              dataPath: 'tank1.do',
              dataType: 'REAL',
              unit: 'mg/L',
            },
          ],
        },
      },
    ],
    edges: [],
  };
}

describe('deploy tag-gate (SENSOR-HIGH-051)', () => {
  let service: ProcessService;
  let repo: { findOne: jest.Mock };
  let resolve: jest.Mock;
  let publish: jest.Mock;
  const originalGate = process.env.SCADA_DEPLOY_TAG_GATE;

  beforeEach(async () => {
    repo = { findOne: jest.fn().mockResolvedValue(processRow()) };
    resolve = jest.fn();
    publish = jest.fn().mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProcessService,
        { provide: getRepositoryToken(Process), useValue: repo },
        {
          provide: MqttClientService,
          useValue: { isConnectedToBroker: () => true, publish },
        },
        {
          provide: EdgeDeviceService,
          useValue: {
            findByIdOrFail: jest.fn().mockResolvedValue({
              id: 'dev-1',
              deviceCode: 'EDGE-AABB1122',
              isOnline: true,
            }),
          },
        },
        { provide: TagResolutionService, useValue: { resolve } },
        {
          // The gate reads its mode via ConfigService (config-env-access-
          // ratchet); the tests keep driving it through process.env.
          provide: ConfigService,
          useValue: { get: (key: string) => process.env[key] },
        },
      ],
    }).compile();
    service = module.get(ProcessService);
  });

  afterEach(() => {
    if (originalGate === undefined) delete process.env.SCADA_DEPLOY_TAG_GATE;
    else process.env.SCADA_DEPLOY_TAG_GATE = originalGate;
  });

  it('enforce mode BLOCKS a deploy with unresolved tag mappings before the broker', async () => {
    process.env.SCADA_DEPLOY_TAG_GATE = 'enforce';
    resolve.mockResolvedValue({
      resolved: [],
      unresolved: [{ ref: 'EDGE-AABB1122/tank1.do', reason: 'NOT_FOUND' }],
    });

    await expect(service.deployProcessToEdge('proc-1', 'dev-1', TENANT, 'user-1')).rejects.toThrow(
      BadRequestException,
    );
    expect(publish).not.toHaveBeenCalled();
  });

  it('warn mode (default) lets the same deploy proceed', async () => {
    delete process.env.SCADA_DEPLOY_TAG_GATE;
    resolve.mockResolvedValue({
      resolved: [],
      unresolved: [{ ref: 'EDGE-AABB1122/tank1.do', reason: 'NOT_FOUND' }],
    });

    const result = await service.deployProcessToEdge('proc-1', 'dev-1', TENANT, 'user-1');
    expect(result.success).toBe(true);
    expect(publish).toHaveBeenCalled();
  });

  it('enforce mode passes when every mapping resolves', async () => {
    process.env.SCADA_DEPLOY_TAG_GATE = 'enforce';
    resolve.mockResolvedValue({
      resolved: [{ ref: 'EDGE-AABB1122/tank1.do' }],
      unresolved: [],
    });

    const result = await service.deployProcessToEdge('proc-1', 'dev-1', TENANT, 'user-1');
    expect(result.success).toBe(true);
    expect(publish).toHaveBeenCalled();
  });
});
