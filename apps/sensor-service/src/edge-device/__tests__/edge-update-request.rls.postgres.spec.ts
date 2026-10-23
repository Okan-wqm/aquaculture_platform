import { ConfigService } from '@nestjs/config';
import { collaborator } from '@aquaculture/testing';
import { type DataSource } from 'typeorm';

import {
  bootSensorRlsHarness,
  type SensorRlsHarness,
} from '../../__tests__/support/sensor-rls-postgres.harness';
import { DeviceDirectoryService } from '../device-directory.service';
import { type EdgeCommandPublisher } from '../edge-command-publisher.service';
import { type AdmittedRelease } from '../edge-release-catalog.service';
import { EdgeResultTelemetryService } from '../edge-result-telemetry.service';
import { UPDATE_CHANNEL } from '../edge-update-channel';
import { EdgeUpdateManifestService, UpdateRefusedError } from '../edge-update-manifest.service';
import {
  type EdgeUpdateIssue,
  EdgeUpdateRequestService,
  type OsUpdateIssue,
  UpdateTargetUnavailableError,
} from '../edge-update-request.service';
import { EdgeDeviceDirectory } from '../entities/edge-device-directory.entity';
import { EdgeDeviceResult } from '../entities/edge-device-result.entity';
import { EdgeUpdateRequest } from '../entities/edge-update-request.entity';
import {
  DeviceLifecycleState,
  DeviceModel,
  EdgeAgentChannel,
  EdgeDevice,
} from '../entities/edge-device.entity';
import { SuderraEdgeConfig } from '../suderra-edge.config';

import { channelEnvironment } from './support/edge-channel-env';
import { fixtureRelease } from './support/fixture-release';

/**
 * Update requests on real Postgres (ADR-048 DEC-2.12): what the service stores,
 * allocates, delivers and settles under the runtime role and FORCE RLS — update_seq
 * allocated by one conditional UPDATE inside the signing transaction, a statement
 * delivered only inside its window with the margin left and at most once per
 * interval, the hand-over only stopping the delivery, and only a result of the
 * request's kind that names its digest concluding it.
 */

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BINDING = { method: 'tpm-ek-sha256', sha256: '7d'.repeat(32) } as const;
const NOW = new Date('2026-10-20T12:00:00Z');
const INTERVAL = 120_000;
const WINDOW = {
  notBefore: new Date('2026-10-20T11:00:00Z'),
  expiresAt: new Date('2026-10-20T13:00:00Z'),
};
const TERMS = { localApproval: false, blockersOverride: false, maxOutageSeconds: 120 };
const BUNDLE = {
  version: '1.1.0',
  rollbackFloor: '1.0.0',
  minCurrentVersion: '1.0.0',
  supportedAgentAbi: '1-2',
  url: 'https://edge-releases.example.com/os/1.1.0/suderra-os-revpi-connect4-1.1.0.raucb',
  sha256: '33'.repeat(32),
  sizeBytes: 201326592,
};

interface Seed {
  readonly code: string;
  readonly tenantId: string;
  readonly channel?: EdgeAgentChannel;
  readonly state?: DeviceLifecycleState;
  readonly bound?: boolean;
  readonly seq?: number;
}
const SEED: readonly Seed[] = [
  { code: 'UR-MAIN', tenantId: TENANT_A, seq: 10 },
  { code: 'UR-RACE', tenantId: TENANT_A, seq: 0 },
  { code: 'UR-DELIVER', tenantId: TENANT_A, seq: 0 },
  { code: 'UR-SETTLE', tenantId: TENANT_A, seq: 0 },
  { code: 'UR-SPOOL', tenantId: TENANT_A, seq: 0 },
  { code: 'UR-OLDOS', tenantId: TENANT_A, seq: 0 },
  { code: 'UR-REFUSE', tenantId: TENANT_A, seq: 0 },
  { code: 'UR-UNBOUND', tenantId: TENANT_A, bound: false },
  { code: 'UR-GENERIC', tenantId: TENANT_A, channel: EdgeAgentChannel.GENERIC_LINUX },
  { code: 'UR-MAINT', tenantId: TENANT_A, state: DeviceLifecycleState.MAINTENANCE },
  { code: 'UR-REVOKED', tenantId: TENANT_A, state: DeviceLifecycleState.REVOKED },
  { code: 'UR-OTHER', tenantId: TENANT_B, seq: 5 },
];

jest.setTimeout(240_000);

describe('update requests under FORCE RLS (ADR-048 DEC-2.12)', () => {
  let stage: SensorRlsHarness | undefined;
  let admin: DataSource;
  let service: EdgeUpdateRequestService;
  let telemetry: EdgeResultTelemetryService;
  let release: AdmittedRelease;
  let publish: jest.Mock;
  const ids = new Map<string, string>();
  const id = (code: string): string => {
    const found = ids.get(code);
    if (found === undefined) throw new Error(`no device ${code}`);
    return found;
  };
  const tenantOf = (code: string): string => SEED.find((s) => s.code === code)?.tenantId ?? '';
  const ref = (code: string): { id: string; tenantId: string } => ({
    id: id(code),
    tenantId: tenantOf(code),
  });
  const table = (code: string): string => `${stage?.schemaOf(tenantOf(code))}.edge_update_requests`;
  const rows = async (code: string): Promise<Array<Record<string, any>>> =>
    admin.query(`SELECT * FROM ${table(code)} WHERE device_id = $1 ORDER BY created_at, id`, [
      id(code),
    ]);
  const firstOf = async (code: string): Promise<Record<string, any>> => {
    const [row] = await rows(code);
    if (row === undefined) throw new Error(`${code} has no request`);
    return row;
  };
  const seqOf = async (code: string): Promise<number> => {
    const [row] = await admin.query(
      `SELECT edge_statement_seq::int AS seq FROM ${stage?.schemaOf(tenantOf(code))}.edge_devices WHERE id = $1`,
      [id(code)],
    );
    return row.seq;
  };
  const edge = (over: Partial<EdgeUpdateIssue> = {}): EdgeUpdateIssue => ({
    release,
    window: WINDOW,
    terms: TERMS,
    recipe: { kind: 'edge-update', version: release.version, terms: TERMS, windowSeconds: 7200 },
    ...over,
  });
  const os = (over: Partial<OsUpdateIssue> = {}): OsUpdateIssue => ({
    bundle: BUNDLE,
    window: WINDOW,
    terms: { ...TERMS, localApproval: true },
    recipe: {
      kind: 'os-update',
      bundle: BUNDLE,
      terms: { ...TERMS, localApproval: true },
      windowSeconds: 7200,
    },
    ...over,
  });
  const concluding = (digest: string, over: Record<string, unknown> = {}): Buffer =>
    Buffer.from(
      JSON.stringify({
        _type: 'suderra.result.v1',
        seq: Math.floor(Math.random() * 1e9) + 1,
        kind: 'edge-update',
        outcome: 'ok',
        occurred_at: '2026-10-20T12:05:00Z',
        time_state: 'synced-nts',
        board_profile: 'revpi-connect4',
        os_version: '1.0.0',
        subject: { statement_type: 'suderra.edge-update.v1', statement_digest: { sha256: digest } },
        ...over,
      }),
    );

  beforeAll(async () => {
    const config = new SuderraEdgeConfig(
      new ConfigService(channelEnvironment({ SUDERRA_EDGE_AGENT_VERSION: '1.7.0' })),
    );
    release = await fixtureRelease(config, '1.7.0');
    stage = await bootSensorRlsHarness({
      name: 'edge_update_request',
      tenants: [TENANT_A, TENANT_B],
      entities: [EdgeDevice, EdgeDeviceResult, EdgeUpdateRequest],
      sourceEntities: [EdgeDeviceDirectory],
      beforeRls: async ({ ddl, tenantId }) => {
        for (const seed of SEED.filter((candidate) => candidate.tenantId === tenantId)) {
          const saved = await ddl.manager.save(
            ddl.manager.create(EdgeDevice, {
              tenantId,
              deviceCode: seed.code,
              deviceName: seed.code,
              deviceModel: DeviceModel.REVOLUTION_PI_CONNECT_4,
              lifecycleState: seed.state ?? DeviceLifecycleState.ACTIVE,
              agentChannel: seed.channel ?? EdgeAgentChannel.SUDERRA_OS,
              mqttClientId: `edge-${tenantId.slice(0, 8)}-${seed.code.toLowerCase()}`,
              deviceBindingMethod: seed.bound === false ? null : BINDING.method,
              deviceBindingSha256: seed.bound === false ? null : BINDING.sha256,
              edgeStatementSeq: seed.seq ?? 0,
              isOnline: true,
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
    publish = jest.fn(async (): Promise<void> => undefined);
    telemetry = new EdgeResultTelemetryService(
      stage.runtime,
      new DeviceDirectoryService(stage.runtime),
    );
    service = new EdgeUpdateRequestService(
      stage.runtime,
      new EdgeUpdateManifestService(config),
      collaborator<EdgeCommandPublisher>({ publish }, 'EdgeCommandPublisher'),
      telemetry,
    );
    service.onModuleInit();
  });

  afterAll(async () => {
    await stage?.shutdown();
  });

  describe('issuing', () => {
    it('allocates the next update_seq in the signing transaction and stores the statement as signed', async () => {
      const first = await service.issueEdgeUpdate(ref('UR-MAIN'), edge());
      expect(first).toMatchObject({ updateSeq: 11, statementType: 'suderra.edge-update.v1' });
      const second = await service.issueOsUpdate(ref('UR-MAIN'), os());
      expect(second.updateSeq).toBe(12);
      expect(await seqOf('UR-MAIN')).toBe(12);
      const row = await firstOf('UR-MAIN');
      const envelope = JSON.parse(row['statement']) as { payload: string };
      const payload = Buffer.from(envelope.payload, 'base64');
      expect(row['statement_digest']).toBe(
        (await import('crypto')).createHash('sha256').update(payload).digest('hex'),
      );
      expect(JSON.parse(payload.toString('utf8'))).toMatchObject({
        update_seq: 11,
        device_id: id('UR-MAIN'),
        tenant_id: TENANT_A,
        version: '1.7.0',
      });
      expect(row).toMatchObject({ state: 'pending', handed_at: null, delivered_at: null });
      expect(row['recipe']).toMatchObject({ kind: 'edge-update', version: '1.7.0' });
    });

    it('a statement the manifest service refuses leaves no row and burns no sequence value', async () => {
      const before = await seqOf('UR-MAIN');
      const count = (await rows('UR-MAIN')).length;
      await expect(
        service.issueEdgeUpdate(
          ref('UR-MAIN'),
          edge({ terms: { localApproval: false, blockersOverride: true, maxOutageSeconds: 60 } }),
        ),
      ).rejects.toBeInstanceOf(UpdateRefusedError);
      expect(await seqOf('UR-MAIN')).toBe(before);
      expect((await rows('UR-MAIN')).length).toBe(count);
    });

    it('concurrent issues of one device take distinct, contiguous sequence values', async () => {
      const issued = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          service.issueOsUpdate(
            ref('UR-RACE'),
            os({ bundle: { ...BUNDLE, sha256: i.toString(16).padStart(64, '0') } }),
          ),
        ),
      );
      expect(issued.map((r) => r.updateSeq).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8,
      ]);
      expect(await seqOf('UR-RACE')).toBe(8);
    });

    it.each(['UR-UNBOUND', 'UR-GENERIC', 'UR-MAINT', 'UR-REVOKED'])(
      '%s cannot take an update statement',
      async (code) => {
        await expect(service.issueEdgeUpdate(ref(code), edge())).rejects.toBeInstanceOf(
          UpdateTargetUnavailableError,
        );
        expect(await rows(code)).toEqual([]);
      },
    );

    it('a device is only reachable through its own tenant', async () => {
      await expect(
        service.issueEdgeUpdate({ id: id('UR-OTHER'), tenantId: TENANT_A }, edge()),
      ).rejects.toBeInstanceOf(UpdateTargetUnavailableError);
      expect(await seqOf('UR-OTHER')).toBe(5);
    });

    it("the device's last reported OS version holds the cloud back from a statement root would refuse", async () => {
      await telemetry.ingest(
        { tenantId: TENANT_A, deviceIdentifier: id('UR-OLDOS') },
        Buffer.from(
          JSON.stringify({
            _type: 'suderra.result.v1',
            seq: 1,
            kind: 'lockdown',
            outcome: 'ok',
            occurred_at: '2026-10-20T11:00:00Z',
            time_state: 'synced-nts',
            board_profile: 'revpi-connect4',
            os_version: '0.9.0',
          }),
        ),
      );
      await expect(service.issueEdgeUpdate(ref('UR-OLDOS'), edge())).rejects.toMatchObject({
        reason: 'os-version-too-old',
      });
    });
  });

  describe('delivery', () => {
    const deliver = (code: string, now: Date): Promise<number> =>
      service.deliverDue(
        { ...ref(code), agentChannel: EdgeAgentChannel.SUDERRA_OS },
        now,
        INTERVAL,
      );
    const published = (): Array<{ commandId: string; command: string; statement: string }> =>
      publish.mock.calls.map(([, command]) => ({
        commandId: command.commandId,
        command: command.command,
        statement: command.params.statement,
      }));

    beforeEach(() => publish.mockClear());

    it('hands a request over as request_update with the statement exactly as stored', async () => {
      const issued = await service.issueEdgeUpdate(ref('UR-DELIVER'), edge());
      await expect(deliver('UR-DELIVER', NOW)).resolves.toBe(1);
      const row = await firstOf('UR-DELIVER');
      expect(published()).toEqual([
        {
          commandId: row['last_command_id'],
          command: 'request_update',
          statement: row['statement'],
        },
      ]);
      expect(publish.mock.calls[0]?.[0]).toEqual({
        tenantId: TENANT_A,
        deviceId: id('UR-DELIVER'),
      });
      expect(issued.statementDigest).toBe(row['statement_digest']);
      expect(row['delivered_at']).toEqual(NOW);
    });

    it('is paced: once per interval, then again, per statement', async () => {
      await expect(deliver('UR-DELIVER', new Date(NOW.getTime() + INTERVAL - 1))).resolves.toBe(0);
      await expect(deliver('UR-DELIVER', new Date(NOW.getTime() + INTERVAL))).resolves.toBe(1);
    });

    it('never delivers early, nor with less than the delivery margin left, nor after the window', async () => {
      const tight = await service.issueOsUpdate(
        ref('UR-DELIVER'),
        os({
          window: {
            notBefore: new Date('2026-10-20T14:00:00Z'),
            expiresAt: new Date('2026-10-20T15:00:00Z'),
          },
        }),
      );
      const at = (iso: string): Date => new Date(iso);
      await expect(deliver('UR-DELIVER', at('2026-10-20T13:59:59Z'))).resolves.toBe(0);
      // The first request (window to 13:00) is also out of its window by now.
      await expect(deliver('UR-DELIVER', at('2026-10-20T14:00:00Z'))).resolves.toBe(1);
      const second = (await rows('UR-DELIVER')).find(
        (r) => r['statement_digest'] === tight.statementDigest,
      );
      expect(published()[0]?.statement).toBe(second?.['statement']);
      const margin = UPDATE_CHANNEL.deliveryMarginSeconds * 1000;
      const lastMoment = new Date(at('2026-10-20T15:00:00Z').getTime() - margin);
      await expect(
        deliver('UR-DELIVER', new Date(lastMoment.getTime() - 1 + INTERVAL)),
      ).resolves.toBe(0);
    });

    it('a handed request is not delivered again; only its hand-over stops the delivery', async () => {
      const issued = await service.issueEdgeUpdate(ref('UR-SPOOL'), edge());
      await deliver('UR-SPOOL', NOW);
      expect(await service.markHanded(ref('UR-SPOOL'), issued.statementDigest, NOW)).toBe(true);
      expect(await service.markHanded(ref('UR-SPOOL'), issued.statementDigest, NOW)).toBe(false);
      publish.mockClear();
      await expect(deliver('UR-SPOOL', new Date(NOW.getTime() + 10 * INTERVAL))).resolves.toBe(0);
      expect(publish).not.toHaveBeenCalled();
      const row = await firstOf('UR-SPOOL');
      expect(row).toMatchObject({ state: 'pending', handed_at: NOW });
    });

    it('does not hand over while the spool holds as many unconcluded requests as it takes', async () => {
      // UR-SPOOL has one handed request; hand over three more, then a fifth owed one waits.
      for (let i = 0; i < UPDATE_CHANNEL.maxPendingEntries - 1; i += 1) {
        const issued = await service.issueOsUpdate(
          ref('UR-SPOOL'),
          os({ bundle: { ...BUNDLE, sha256: `a${i}`.padStart(64, '0') } }),
        );
        await service.markHanded(ref('UR-SPOOL'), issued.statementDigest, NOW);
      }
      await service.issueOsUpdate(
        ref('UR-SPOOL'),
        os({ bundle: { ...BUNDLE, sha256: 'f'.repeat(64) } }),
      );
      publish.mockClear();
      await expect(deliver('UR-SPOOL', new Date(NOW.getTime() + INTERVAL))).resolves.toBe(0);
      expect(publish).not.toHaveBeenCalled();
    });

    it('a failing publish is logged and the request is claimed for the next paced heartbeat', async () => {
      publish.mockRejectedValueOnce(new Error('broker down'));
      const [pending] = (await rows('UR-DELIVER')).filter((r) => r['state'] === 'pending');
      expect(pending).toBeDefined();
      await expect(deliver('UR-DELIVER', new Date('2026-10-20T14:02:00Z'))).resolves.toBe(0);
    });

    it('delivers nothing to a device that is not on the Suderra OS channel', async () => {
      await expect(
        service.deliverDue(
          { ...ref('UR-GENERIC'), agentChannel: EdgeAgentChannel.GENERIC_LINUX },
          NOW,
          INTERVAL,
        ),
      ).resolves.toBe(0);
    });

    it('a refusal the agent can recover from keeps the request owed; any other fails it loudly', async () => {
      const keep = await service.issueEdgeUpdate(ref('UR-REFUSE'), edge());
      const lose = await service.issueOsUpdate(
        ref('UR-REFUSE'),
        os({ bundle: { ...BUNDLE, sha256: 'e'.repeat(64) } }),
      );
      publish.mockClear();
      await deliver('UR-REFUSE', NOW);
      const sent = new Map(
        (await rows('UR-REFUSE')).map((r) => [
          r['statement_digest'] as string,
          r['last_command_id'] as string,
        ]),
      );
      const keepCommand = sent.get(keep.statementDigest);
      const loseCommand = sent.get(lose.statementDigest);
      if (keepCommand === undefined || loseCommand === undefined) throw new Error('not delivered');
      await expect(
        service.recordHandoffRefusal(
          ref('UR-REFUSE'),
          keepCommand,
          ['update-requests-backlog'],
          NOW,
        ),
      ).resolves.toBe(true);
      await expect(
        service.recordHandoffRefusal(ref('UR-REFUSE'), loseCommand, ['statement-too-large'], NOW),
      ).resolves.toBe(true);
      const after = new Map(
        (await rows('UR-REFUSE')).map((r) => [r['statement_digest'] as string, r]),
      );
      expect(after.get(keep.statementDigest)).toMatchObject({
        state: 'pending',
        handoff_refusal: 'update-requests-backlog',
      });
      expect(after.get(lose.statementDigest)).toMatchObject({
        state: 'failed',
        settled_outcome: 'handoff-refused',
        settled_reason: 'statement-too-large',
      });
      // Another device's command id names nothing here.
      await expect(
        service.recordHandoffRefusal(ref('UR-MAIN'), keepCommand, ['io-error'], NOW),
      ).resolves.toBe(false);
    });
  });

  describe('settlement', () => {
    const ingest = (
      code: string,
      digest: string,
      over: Record<string, unknown> = {},
    ): Promise<unknown> =>
      telemetry.ingest(
        { tenantId: tenantOf(code), deviceIdentifier: id(code) },
        concluding(digest, over),
      );
    const stateOf = async (
      code: string,
      digest: string,
    ): Promise<Record<string, any> | undefined> =>
      (await rows(code)).find((r) => r['statement_digest'] === digest);

    it.each([
      ['ok', {}, 'done'],
      ['a retryable refusal', { outcome: 'rejected', reason: 'maintenance-blocked' }, 'retry'],
      [
        'a refusal of the window',
        { outcome: 'rejected', reason: 'approval-missing' },
        'reschedule',
      ],
      ['a final refusal', { outcome: 'rejected', reason: 'sequence-replay' }, 'failed'],
      [
        'a final failure',
        { outcome: 'failed', reason: 'rauc-install-failed', kind: 'os-update' },
        'failed',
      ],
    ])(
      'a result of %s concludes the request as the contract classes it',
      async (_name, over, state) => {
        const issued =
          (over as { kind?: string }).kind === 'os-update'
            ? await service.issueOsUpdate(
                ref('UR-SETTLE'),
                os({ bundle: { ...BUNDLE, sha256: 'd'.repeat(64) } }),
              )
            : await service.issueEdgeUpdate(
                ref('UR-SETTLE'),
                edge({
                  terms: { ...TERMS, maxOutageSeconds: 100 + Math.floor(Math.random() * 1000) },
                }),
              );
        const seqBefore = (await stateOf('UR-SETTLE', issued.statementDigest))?.['state'];
        expect(seqBefore).toBe('pending');
        await ingest('UR-SETTLE', issued.statementDigest, {
          ...over,
          ...((over as { kind?: string }).kind === 'os-update'
            ? {
                subject: {
                  statement_type: 'suderra.os-update.v1',
                  statement_digest: { sha256: issued.statementDigest },
                },
              }
            : {}),
        });
        const row = await stateOf('UR-SETTLE', issued.statementDigest);
        expect(row?.['state']).toBe(state);
        expect(row?.['settled_at']).not.toBeNull();
      },
    );

    it('a result that names another request, another kind or no known statement settles nothing', async () => {
      const issued = await service.issueEdgeUpdate(
        ref('UR-SETTLE'),
        edge({ terms: { ...TERMS, maxOutageSeconds: 3000 } }),
      );
      // An os-update result naming an edge-update's digest: another kind.
      await ingest('UR-SETTLE', issued.statementDigest, {
        kind: 'os-update',
        subject: {
          statement_type: 'suderra.os-update.v1',
          statement_digest: { sha256: issued.statementDigest },
        },
      });
      // A result naming a digest the cloud never signed.
      await ingest('UR-SETTLE', '9'.repeat(64));
      expect((await stateOf('UR-SETTLE', issued.statementDigest))?.['state']).toBe('pending');
    });

    it("another device's result never settles this device's request", async () => {
      const issued = await service.issueEdgeUpdate(
        ref('UR-SETTLE'),
        edge({ terms: { ...TERMS, maxOutageSeconds: 3100 } }),
      );
      await ingest('UR-MAIN', issued.statementDigest);
      expect((await stateOf('UR-SETTLE', issued.statementDigest))?.['state']).toBe('pending');
    });

    it('a concluded request stays concluded; a republication of the same message re-settles an open one', async () => {
      const issued = await service.issueEdgeUpdate(
        ref('UR-SETTLE'),
        edge({ terms: { ...TERMS, maxOutageSeconds: 3200 } }),
      );
      const message = concluding(issued.statementDigest, { seq: 777_001 });
      const source = { tenantId: TENANT_A, deviceIdentifier: id('UR-SETTLE') };
      expect((await telemetry.ingest(source, message)) as { status: string }).toMatchObject({
        status: 'stored',
      });
      expect((await stateOf('UR-SETTLE', issued.statementDigest))?.['state']).toBe('done');
      // A later, different result for the same digest does not reopen or change it.
      await ingest('UR-SETTLE', issued.statementDigest, {
        outcome: 'rejected',
        reason: 'sequence-replay',
      });
      expect((await stateOf('UR-SETTLE', issued.statementDigest))?.['state']).toBe('done');
      // Settlement that failed after the result was stored is retried by the redelivery.
      await admin.query(
        `UPDATE ${table('UR-SETTLE')} SET state = 'pending', settled_at = NULL, settled_result_seq = NULL,
                settled_outcome = NULL WHERE statement_digest = $1`,
        [issued.statementDigest],
      );
      expect((await telemetry.ingest(source, message)) as { status: string }).toMatchObject({
        status: 'duplicate',
      });
      expect((await stateOf('UR-SETTLE', issued.statementDigest))?.['state']).toBe('done');
    });

    it('silence ends at the window: a lapsed request is concluded after all by a late result', async () => {
      const issued = await service.issueEdgeUpdate(
        ref('UR-SETTLE'),
        edge({ terms: { ...TERMS, maxOutageSeconds: 3300 } }),
      );
      expect(await service.lapseDue(TENANT_A, new Date(WINDOW.expiresAt.getTime() - 1))).toBe(0);
      expect(await service.lapseDue(TENANT_A, WINDOW.expiresAt)).toBeGreaterThanOrEqual(1);
      expect((await stateOf('UR-SETTLE', issued.statementDigest))?.['state']).toBe('lapsed');
      await ingest('UR-SETTLE', issued.statementDigest);
      expect((await stateOf('UR-SETTLE', issued.statementDigest))?.['state']).toBe('done');
    });

    it('lapsing touches only the tenant it is asked for', async () => {
      const other = await service.issueEdgeUpdate(ref('UR-OTHER'), edge());
      await service.lapseDue(TENANT_A, new Date('2027-01-01T00:00:00Z'));
      expect(
        (await rows('UR-OTHER')).find((r) => r['statement_digest'] === other.statementDigest)?.[
          'state'
        ],
      ).toBe('pending');
      expect(await service.lapseDue(TENANT_B, new Date('2027-01-01T00:00:00Z'))).toBe(1);
    });

    it("lists a device's requests, newest first, for the console, and only its own tenant's", async () => {
      const mine = await service.listForDevice(TENANT_A, id('UR-SETTLE'));
      expect(mine.length).toBeGreaterThanOrEqual(5);
      expect(mine[0]?.createdAt.getTime()).toBeGreaterThanOrEqual(
        mine[mine.length - 1]?.createdAt.getTime() ?? 0,
      );
      expect(mine[0]).not.toHaveProperty('statement');
      expect(await service.listForDevice(TENANT_B, id('UR-SETTLE'))).toEqual([]);
    });
  });
});
