import { type DataSource } from 'typeorm';

import {
  bootSensorRlsHarness,
  type SensorRlsHarness,
} from '../../__tests__/support/sensor-rls-postgres.harness';
import { DeviceDirectoryService } from '../device-directory.service';
import {
  EdgeResultTelemetryService,
  RESULT_RETENTION_PER_DEVICE,
} from '../edge-result-telemetry.service';
import { EdgeDeviceDirectory } from '../entities/edge-device-directory.entity';
import { EdgeDeviceResult } from '../entities/edge-device-result.entity';
import {
  DeviceLifecycleState,
  DeviceModel,
  EdgeAgentChannel,
  EdgeDevice,
} from '../entities/edge-device.entity';

/**
 * Result telemetry on real Postgres (ADR-048 DEC-27): what the consumer
 * stores under the runtime role and FORCE RLS — one row per (device_id, seq),
 * a republication stores nothing, a seq reused with other content is a
 * conflict that keeps the first document, retention bounds a device's rows,
 * and one tenant's results are invisible to another.
 */

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

interface SeedDevice {
  readonly tenantId: string;
  readonly code: string;
}
const SEED: readonly SeedDevice[] = [
  { tenantId: TENANT_A, code: 'RES-A1' },
  { tenantId: TENANT_A, code: 'RES-A2' },
  { tenantId: TENANT_B, code: 'RES-B1' },
];

function result(seq: number, overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(
    JSON.stringify({
      _type: 'suderra.result.v1',
      seq,
      kind: 'lockdown',
      outcome: 'ok',
      occurred_at: '2026-10-20T11:20:00Z',
      time_state: 'synced-nts',
      board_profile: 'revpi-connect4',
      os_version: '1.0.0',
      ...overrides,
    }),
  );
}

const updateResult = (seq: number, digest: string, outcome: 'ok' | 'rejected' = 'ok'): Buffer =>
  result(seq, {
    kind: 'edge-update',
    outcome,
    ...(outcome === 'rejected' ? { reason: 'maintenance-blocked' } : {}),
    subject: {
      statement_type: 'suderra.edge-update.v1',
      statement_digest: { sha256: digest },
    },
  });

jest.setTimeout(180_000);

describe('result telemetry under FORCE RLS (ADR-048 DEC-27)', () => {
  let stage: SensorRlsHarness | undefined;
  let admin: DataSource;
  let service: EdgeResultTelemetryService;
  const ids = new Map<string, string>();
  const id = (code: string): string => {
    const found = ids.get(code);
    if (found === undefined) throw new Error(`no device ${code}`);
    return found;
  };

  const rows = async (code: string): Promise<Array<Record<string, unknown>>> =>
    admin.query(
      `SELECT seq::int AS seq, kind, outcome, reason FROM ${stage?.schemaOf(
        SEED.find((s) => s.code === code)?.tenantId ?? '',
      )}.edge_device_results WHERE device_id = $1 ORDER BY seq`,
      [id(code)],
    );

  beforeAll(async () => {
    stage = await bootSensorRlsHarness({
      name: 'edge_result_telemetry',
      tenants: [TENANT_A, TENANT_B],
      entities: [EdgeDevice, EdgeDeviceResult],
      sourceEntities: [EdgeDeviceDirectory],
      beforeRls: async ({ ddl, tenantId }) => {
        for (const seed of SEED.filter((candidate) => candidate.tenantId === tenantId)) {
          const saved = await ddl.manager.save(
            ddl.manager.create(EdgeDevice, {
              tenantId,
              deviceCode: seed.code,
              deviceName: seed.code,
              deviceModel: DeviceModel.REVOLUTION_PI_CONNECT_4,
              lifecycleState: DeviceLifecycleState.ACTIVE,
              agentChannel: EdgeAgentChannel.SUDERRA_OS,
              mqttClientId: `edge-${tenantId.slice(0, 8)}-${seed.code.toLowerCase()}`,
              isOnline: false,
            }),
          );
          ids.set(seed.code, saved.id);
        }
      },
    });
    admin = stage.admin;
    for (const seed of SEED) {
      await admin.query(
        `INSERT INTO sensor.edge_device_directory (device_id, device_code, mqtt_client_id, tenant_id)
         VALUES ($1, $2, $3, $4)`,
        [
          id(seed.code),
          seed.code,
          `edge-${seed.tenantId.slice(0, 8)}-${seed.code.toLowerCase()}`,
          seed.tenantId,
        ],
      );
    }
    service = new EdgeResultTelemetryService(
      stage.runtime,
      new DeviceDirectoryService(stage.runtime),
    );
  });

  afterAll(async () => {
    await stage?.shutdown();
  });

  it("stores a result under the topic's UUID and under the device code, and reads it back", async () => {
    const byUuid = await service.ingest(
      { tenantId: TENANT_A, deviceIdentifier: id('RES-A1') },
      result(1),
    );
    expect(byUuid).toMatchObject({ status: 'stored', deviceId: id('RES-A1'), tenantId: TENANT_A });
    const byCode = await service.ingest(
      { tenantId: TENANT_A, deviceIdentifier: 'RES-A1' },
      result(2, { kind: 'lifecycle', outcome: 'ok' }),
    );
    expect(byCode).toMatchObject({ status: 'stored', deviceId: id('RES-A1') });
    // A reason the schema does not allow for the kind is refused whole.
    const wrongReason = await service.ingest(
      { tenantId: TENANT_A, deviceIdentifier: id('RES-A1') },
      result(3, { kind: 'lockdown', outcome: 'rejected', reason: 'maintenance-blocked' }),
    );
    expect(wrongReason).toEqual({ status: 'refused', reason: 'invalid' });

    const listed = await service.list(TENANT_A, id('RES-A1'));
    expect(listed.map((r) => [r.seq, r.kind, r.outcome])).toEqual([
      [2, 'lifecycle', 'ok'],
      [1, 'lockdown', 'ok'],
    ]);
    expect(listed[1]).toMatchObject({
      deviceId: id('RES-A1'),
      timeState: 'synced-nts',
      reason: null,
    });
  });

  it('a republication of the same message stores nothing (QoS 1 redelivery, reconnect)', async () => {
    const message = result(10);
    const first = await service.ingest(
      { tenantId: TENANT_A, deviceIdentifier: id('RES-A2') },
      message,
    );
    const again = await service.ingest(
      { tenantId: TENANT_A, deviceIdentifier: id('RES-A2') },
      message,
    );
    expect(first.status).toBe('stored');
    expect(again).toEqual({ status: 'duplicate', deviceId: id('RES-A2'), seq: 10 });
    expect(await rows('RES-A2')).toHaveLength(1);
  });

  it('a seq reused with other content is a conflict and keeps the first document', async () => {
    await service.ingest({ tenantId: TENANT_A, deviceIdentifier: id('RES-A2') }, result(20));
    const reused = await service.ingest(
      { tenantId: TENANT_A, deviceIdentifier: id('RES-A2') },
      result(20, { kind: 'lifecycle', outcome: 'ok' }),
    );
    expect(reused).toEqual({ status: 'conflict', deviceId: id('RES-A2'), seq: 20 });
    const stored = (await rows('RES-A2')).filter((r) => r['seq'] === 20);
    expect(stored).toEqual([{ seq: 20, kind: 'lockdown', outcome: 'ok', reason: null }]);
  });

  it('dedupes per device: the same seq on two devices is two results', async () => {
    const a = await service.ingest(
      { tenantId: TENANT_A, deviceIdentifier: id('RES-A1') },
      result(30),
    );
    const b = await service.ingest(
      { tenantId: TENANT_A, deviceIdentifier: id('RES-A2') },
      result(30),
    );
    expect([a.status, b.status]).toEqual(['stored', 'stored']);
  });

  it('the newest result of every kind is the last known state', async () => {
    const device = { tenantId: TENANT_A, deviceIdentifier: id('RES-A1') };
    await service.ingest(device, updateResult(41, 'a1'.repeat(32), 'rejected'));
    await service.ingest(device, updateResult(42, 'a2'.repeat(32)));
    await service.ingest(device, result(43, { kind: 'lockdown', outcome: 'ok' }));
    const latest = await service.latestByKind(TENANT_A, id('RES-A1'));
    const byKind = new Map(latest.map((r) => [r.kind, r]));
    expect(byKind.get('edge-update')).toMatchObject({ seq: 42, outcome: 'ok' });
    expect(byKind.get('lockdown')).toMatchObject({ seq: 43 });
    const onlyUpdates = await service.list(TENANT_A, id('RES-A1'), { kind: 'edge-update' });
    expect(onlyUpdates.map((r) => r.seq)).toEqual([42, 41]);
    expect(onlyUpdates[1]).toMatchObject({ outcome: 'rejected', reason: 'maintenance-blocked' });
  });

  it("refuses a topic whose tenant is not the device's: nothing is stored", async () => {
    const before = await service.count(TENANT_B, id('RES-B1'));
    const refused = await service.ingest(
      { tenantId: TENANT_B, deviceIdentifier: id('RES-A1') },
      result(50),
    );
    expect(refused).toEqual({ status: 'refused', reason: 'tenant-mismatch' });
    expect(await service.count(TENANT_B, id('RES-B1'))).toBe(before);
    expect((await rows('RES-A1')).some((r) => r['seq'] === 50)).toBe(false);
  });

  it("one tenant never reads another tenant's results", async () => {
    await service.ingest({ tenantId: TENANT_B, deviceIdentifier: id('RES-B1') }, result(1));
    expect(await service.list(TENANT_B, id('RES-A1'))).toEqual([]);
    expect(await service.latestByKind(TENANT_B, id('RES-A1'))).toEqual([]);
    expect(await service.count(TENANT_B, id('RES-A1'))).toBe(0);
    expect((await service.list(TENANT_B, id('RES-B1'))).map((r) => r.seq)).toEqual([1]);
  });

  it('retention keeps the newest rows of a device and nothing of another device is touched', async () => {
    const schema = stage?.schemaOf(TENANT_A) ?? '';
    await admin.query(
      `INSERT INTO ${schema}.edge_device_results
         (tenant_id, device_id, seq, kind, outcome, occurred_at, time_state, board_profile,
          os_version, document, document_sha256, received_at)
       SELECT $1, $2, 1000 + n, 'lockdown', 'ok', now(), 'synced-nts', 'revpi-connect4', '1.0.0',
              '{}'::jsonb, md5(n::text) || md5(n::text), now() - ((${RESULT_RETENTION_PER_DEVICE} - n) || ' seconds')::interval
         FROM generate_series(1, ${RESULT_RETENTION_PER_DEVICE}) AS n`,
      [TENANT_A, id('RES-A1')],
    );
    const otherBefore = await service.count(TENANT_A, id('RES-A2'));
    const stored = await service.ingest(
      { tenantId: TENANT_A, deviceIdentifier: id('RES-A1') },
      result(9000),
    );
    expect(stored.status).toBe('stored');
    expect(await service.count(TENANT_A, id('RES-A1'))).toBe(RESULT_RETENTION_PER_DEVICE);
    expect((await service.list(TENANT_A, id('RES-A1'), { limit: 1 }))[0]?.seq).toBe(9000);
    expect(await service.count(TENANT_A, id('RES-A2'))).toBe(otherBefore);
  });

  it('a list is bounded and a kind outside the schema lists nothing', async () => {
    expect(
      (await service.list(TENANT_A, id('RES-A1'), { limit: 100_000 })).length,
    ).toBeLessThanOrEqual(200);
    expect(await service.list(TENANT_A, id('RES-A1'), { kind: 'not-a-kind' })).toEqual([]);
  });
});
