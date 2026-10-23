/**
 * What the result consumer refuses before it touches the database (ADR-048
 * DEC-27): a publication that is not a result document, from a device the
 * topic does not prove, or from a device that is not a Suderra OS device.
 * What it stores, deduplicates and prunes is proven on real Postgres in
 * edge-result-telemetry.rls.postgres.spec.ts.
 */
import { collaborator } from '@aquaculture/testing';
import type { DataSource } from 'typeorm';

import type { DeviceDirectoryService } from '../device-directory.service';
import { EdgeResultTelemetryService } from '../edge-result-telemetry.service';
import { EdgeAgentChannel, EdgeDevice } from '../entities/edge-device.entity';

const TENANT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const OTHER_TENANT = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const DEVICE_ID = '0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e';

const RESULT = Buffer.from(
  JSON.stringify({
    _type: 'suderra.result.v1',
    seq: 3,
    kind: 'lockdown',
    outcome: 'ok',
    occurred_at: '2026-10-20T11:20:00Z',
    time_state: 'synced-nts',
    board_profile: 'revpi-connect4',
    os_version: '1.0.0',
  }),
);

function harness(found: Partial<EdgeDevice> | null): {
  service: EdgeResultTelemetryService;
  createQueryRunner: jest.Mock;
  findDevice: jest.Mock;
} {
  const createQueryRunner = jest.fn();
  const findDevice = jest
    .fn()
    .mockResolvedValue(found === null ? null : Object.assign(new EdgeDevice(), found));
  const service = new EdgeResultTelemetryService(
    collaborator<DataSource>({ createQueryRunner }, 'DataSource'),
    collaborator<DeviceDirectoryService>({ findDevice }, 'DeviceDirectoryService'),
  );
  return { service, createQueryRunner, findDevice };
}

const suderraOs = {
  id: DEVICE_ID,
  tenantId: TENANT,
  agentChannel: EdgeAgentChannel.SUDERRA_OS,
};

describe('EdgeResultTelemetryService.ingest refusals', () => {
  it('refuses a message that is not a result document and never looks the device up', async () => {
    const { service, findDevice, createQueryRunner } = harness(suderraOs);
    await expect(
      service.ingest({ tenantId: TENANT, deviceIdentifier: DEVICE_ID }, Buffer.from('{"x":1}')),
    ).resolves.toEqual({ status: 'refused', reason: 'invalid' });
    expect(findDevice).not.toHaveBeenCalled();
    expect(createQueryRunner).not.toHaveBeenCalled();
  });

  it('refuses a device the directory does not know', async () => {
    const { service, createQueryRunner } = harness(null);
    await expect(
      service.ingest({ tenantId: TENANT, deviceIdentifier: DEVICE_ID }, RESULT),
    ).resolves.toEqual({ status: 'refused', reason: 'unknown-device' });
    expect(createQueryRunner).not.toHaveBeenCalled();
  });

  it("refuses a topic whose tenant is not the device row's tenant", async () => {
    const { service, createQueryRunner } = harness(suderraOs);
    await expect(
      service.ingest({ tenantId: OTHER_TENANT, deviceIdentifier: DEVICE_ID }, RESULT),
    ).resolves.toEqual({ status: 'refused', reason: 'tenant-mismatch' });
    expect(createQueryRunner).not.toHaveBeenCalled();
  });

  it('refuses a device that is not on the Suderra OS channel', async () => {
    const { service, createQueryRunner } = harness({
      ...suderraOs,
      agentChannel: EdgeAgentChannel.GENERIC_LINUX,
    });
    await expect(
      service.ingest({ tenantId: TENANT, deviceIdentifier: DEVICE_ID }, RESULT),
    ).resolves.toEqual({ status: 'refused', reason: 'not-suderra-os' });
    expect(createQueryRunner).not.toHaveBeenCalled();
  });

  it('resolves a UUID by id and anything else by device code', async () => {
    const byId = harness(suderraOs);
    await byId.service
      .ingest({ tenantId: TENANT, deviceIdentifier: DEVICE_ID }, RESULT)
      .catch(() => undefined);
    expect(byId.findDevice).toHaveBeenCalledWith('id', DEVICE_ID);
    const byCode = harness(suderraOs);
    await byCode.service
      .ingest({ tenantId: TENANT, deviceIdentifier: 'RPI-0E0E0E0E' }, RESULT)
      .catch(() => undefined);
    expect(byCode.findDevice).toHaveBeenCalledWith('device_code', 'RPI-0E0E0E0E');
  });

  it('a list of an unknown kind is empty without a query', async () => {
    const { service, createQueryRunner } = harness(suderraOs);
    await expect(service.list(TENANT, DEVICE_ID, { kind: 'no-such-kind' })).resolves.toEqual([]);
    expect(createQueryRunner).not.toHaveBeenCalled();
  });
});
