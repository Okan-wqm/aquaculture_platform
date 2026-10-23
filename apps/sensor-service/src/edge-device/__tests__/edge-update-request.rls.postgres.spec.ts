import { ScheduledJobExecutor } from '@aquaculture/backend-common/scheduling';
import { ConfigService } from '@nestjs/config';
import { collaborator } from '@aquaculture/testing';
import { type DataSource } from 'typeorm';

import {
  bootSensorRlsHarness,
  type SensorRlsHarness,
} from '../../__tests__/support/sensor-rls-postgres.harness';
import { DeviceDirectoryService } from '../device-directory.service';
import { type EdgeCommandPublisher } from '../edge-command-publisher.service';
import { type AdmittedRelease, type EdgeReleaseCatalog } from '../edge-release-catalog.service';
import { EdgeResultTelemetryService } from '../edge-result-telemetry.service';
import { UPDATE_CHANNEL } from '../edge-update-channel';
import { EdgeUpdateManifestService, UpdateRefusedError } from '../edge-update-manifest.service';
import { EdgeUpdateReconciler } from '../edge-update-reconciler.service';
import {
  type EdgeUpdateIssue,
  EdgeUpdateRequestService,
  type OsUpdateIssue,
  type SiteConfigIssue,
  type SiteNetpolicyIssue,
  UpdateTargetUnavailableError,
} from '../edge-update-request.service';
import type { SiteConfigRecipe, TrustAnchorsRecipe } from '../edge-update-recipe';
import { EdgeDeviceDirectory } from '../entities/edge-device-directory.entity';
import { EdgeDeviceResult } from '../entities/edge-device-result.entity';
import { EdgeUpdateRequest } from '../entities/edge-update-request.entity';
import {
  DeviceLifecycleState,
  DeviceModel,
  EdgeAgentChannel,
  EdgeDevice,
} from '../entities/edge-device.entity';
import { StatementAdmissionError } from '../manifest-signer';
import { RbacManifestService } from '../rbac-manifest.service';
import { SiteConfigManifestService } from '../site-config-manifest.service';
import {
  type NetpolicyBody,
  SiteNetpolicyManifestService,
} from '../site-netpolicy-manifest.service';
import {
  TenantOutOfBundleScopeError,
  TrustAnchorBundleService,
} from '../trust-anchor-bundle.service';
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
/** The one tenant the contract's trust-anchors bundle serves (its tenant_scope). */
const TENANT_FIXTURE = '7e570000-0000-4000-8000-000000000001';
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
  { code: 'RC-EDGE', tenantId: TENANT_A },
  { code: 'RC-OS', tenantId: TENANT_A },
  { code: 'RC-WAIT', tenantId: TENANT_A },
  { code: 'RC-CAMP', tenantId: TENANT_A },
  { code: 'RC-REFUSED', tenantId: TENANT_A },
  { code: 'RC-DOWN', tenantId: TENANT_A },
  { code: 'RC-RACE', tenantId: TENANT_A },
  { code: 'RC-BAD', tenantId: TENANT_A },
  { code: 'RC-LAPSE', tenantId: TENANT_A },
  { code: 'RC-ROLL', tenantId: TENANT_A },
  { code: 'RC-GONE', tenantId: TENANT_A },
  { code: 'RC-FINAL', tenantId: TENANT_A },
  { code: 'RC-OTHER', tenantId: TENANT_B },
  { code: 'SC-CONFIG', tenantId: TENANT_A },
  { code: 'SC-NET', tenantId: TENANT_A },
  { code: 'SC-SETTLE', tenantId: TENANT_A },
  { code: 'SC-RETRY', tenantId: TENANT_A },
  { code: 'SC-RETRY-NET', tenantId: TENANT_A },
  { code: 'SC-REFUSED', tenantId: TENANT_A },
  { code: 'TA-ONE', tenantId: TENANT_FIXTURE },
  { code: 'TA-TWO', tenantId: TENANT_FIXTURE },
  { code: 'TA-LATE', tenantId: TENANT_FIXTURE },
  { code: 'TA-RETRY', tenantId: TENANT_FIXTURE },
  { code: 'TA-OUT', tenantId: TENANT_A },
];

jest.setTimeout(240_000);

describe('update requests under FORCE RLS (ADR-048 DEC-2.12)', () => {
  let stage: SensorRlsHarness | undefined;
  let admin: DataSource;
  let service: EdgeUpdateRequestService;
  let telemetry: EdgeResultTelemetryService;
  let release: AdmittedRelease;
  let publish: jest.Mock;
  let forVersion: jest.Mock;
  let reconciler: EdgeUpdateReconciler;
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
      tenants: [TENANT_A, TENANT_B, TENANT_FIXTURE],
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
      new SiteConfigManifestService(config),
      new SiteNetpolicyManifestService(config),
      new RbacManifestService(config),
      new TrustAnchorBundleService(config),
    );
    service.onModuleInit();
    forVersion = jest.fn(async (): Promise<AdmittedRelease> => release);
    reconciler = new EdgeUpdateReconciler(
      stage.runtime,
      service,
      collaborator<EdgeReleaseCatalog>({ forVersion }, 'EdgeReleaseCatalog'),
      collaborator<ScheduledJobExecutor>({}, 'ScheduledJobExecutor'),
    );
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

  describe('reconciliation', () => {
    const REFUSED_AT = new Date('2026-10-20T12:00:00Z');
    const CAMPAIGN = new Date('2026-10-20T11:00:00Z');
    const INTERVAL_MS = UPDATE_CHANNEL.reissueMinIntervalSeconds * 1000;
    const AFTER_INTERVAL = new Date(REFUSED_AT.getTime() + INTERVAL_MS);

    const report = (
      code: string,
      digest: string,
      over: Record<string, unknown>,
    ): Promise<unknown> =>
      telemetry.ingest(
        { tenantId: tenantOf(code), deviceIdentifier: id(code) },
        concluding(digest, over),
      );
    const byDigest = async (code: string, digest: string): Promise<Record<string, any>> => {
      const row = (await rows(code)).find((r) => r['statement_digest'] === digest);
      if (row === undefined) throw new Error(`${code} has no request ${digest}`);
      return row;
    };
    const bodyOf = (row: Record<string, any>): Record<string, any> =>
      JSON.parse(Buffer.from(JSON.parse(row['statement']).payload, 'base64').toString('utf8'));
    /** A request the device refused at REFUSED_AT, its campaign begun at CAMPAIGN. */
    const refused = async (
      code: string,
      reason = 'fetch-failed',
      issue: () => ReturnType<EdgeUpdateRequestService['issueEdgeUpdate']> = () =>
        service.issueEdgeUpdate(ref(code), edge()),
    ): Promise<Awaited<ReturnType<EdgeUpdateRequestService['issueEdgeUpdate']>>> => {
      const issued = await issue();
      const edgeKind = issued.statementType === 'suderra.edge-update.v1';
      await report(code, issued.statementDigest, {
        outcome: 'rejected',
        reason,
        kind: edgeKind ? 'edge-update' : 'os-update',
        subject: {
          statement_type: issued.statementType,
          statement_digest: { sha256: issued.statementDigest },
        },
      });
      await admin.query(
        `UPDATE ${table(code)} SET settled_at = $2, campaign_started_at = $3 WHERE id = $1`,
        [issued.id, REFUSED_AT, CAMPAIGN],
      );
      return issued;
    };

    it('issues a retryable refusal again as a new statement of the same intent and replaces the request', async () => {
      const old = await refused('RC-EDGE');
      expect((await byDigest('RC-EDGE', old.statementDigest))['state']).toBe('retry');
      const summary = await reconciler.reconcileTenant(TENANT_A, AFTER_INTERVAL);
      expect(summary.reissued).toBeGreaterThanOrEqual(1);

      const all = await rows('RC-EDGE');
      expect(all).toHaveLength(2);
      const [before, after] = all;
      expect(before).toMatchObject({ state: 'reissued', id: old.id });
      expect(after).toMatchObject({
        state: 'pending',
        intent_id: old.intentId,
        statement_type: 'suderra.edge-update.v1',
      });
      expect(before?.['superseded_by']).toBe(after?.['id']);
      // A new statement, never the old bytes: later sequence, later window, same campaign.
      expect(after?.['statement_digest']).not.toBe(old.statementDigest);
      expect(Number(after?.['update_seq'])).toBeGreaterThan(Number(before?.['update_seq']));
      expect(new Date(after?.['not_before']).getTime()).toBe(AFTER_INTERVAL.getTime());
      expect(new Date(after?.['expires_at']).getTime()).toBe(
        AFTER_INTERVAL.getTime() + 7200 * 1000,
      );
      expect(new Date(after?.['campaign_started_at']).getTime()).toBe(CAMPAIGN.getTime());
      expect(bodyOf(after ?? {})).toMatchObject({
        update_seq: Number(after?.['update_seq']),
        version: '1.7.0',
        not_before: '2026-10-20T12:15:00Z',
      });
      expect(await seqOf('RC-EDGE')).toBe(2);
      expect(forVersion).toHaveBeenCalledWith(
        expect.objectContaining({ boardProfile: 'revpi-connect4' }),
        '1.7.0',
      );
    });

    it('re-issues an os-update from the recipe it stored, a new statement of the same bundle', async () => {
      const old = await refused('RC-OS', 'clock-unsynced', () =>
        service.issueOsUpdate(ref('RC-OS'), os()),
      );
      await reconciler.reconcileTenant(TENANT_A, AFTER_INTERVAL);
      const [before, after] = await rows('RC-OS');
      expect(before).toMatchObject({ state: 'reissued', id: old.id });
      expect(after).toMatchObject({ state: 'pending', statement_type: 'suderra.os-update.v1' });
      expect(bodyOf(after ?? {})).toMatchObject({
        version: BUNDLE.version,
        bundle: { digest: { sha256: BUNDLE.sha256 }, size_bytes: BUNDLE.sizeBytes },
        update_seq: 2,
      });
    });

    it('waits the contract interval after the refusal: nothing a second early, one at the interval', async () => {
      const old = await refused('RC-WAIT');
      const early = new Date(AFTER_INTERVAL.getTime() - 1000);
      await reconciler.reconcileTenant(TENANT_A, early);
      expect((await rows('RC-WAIT')).map((r) => r['state'])).toEqual(['retry']);
      expect(await seqOf('RC-WAIT')).toBe(1);
      await reconciler.reconcileTenant(TENANT_A, AFTER_INTERVAL);
      expect((await rows('RC-WAIT')).map((r) => r['state'])).toEqual(['reissued', 'pending']);
      expect((await byDigest('RC-WAIT', old.statementDigest))['state']).toBe('reissued');
    });

    it('ends the campaign at its bound: FAILED, the refusal kept, nothing signed', async () => {
      const old = await refused('RC-CAMP', 'maintenance-blocked');
      const over = new Date(CAMPAIGN.getTime() + UPDATE_CHANNEL.campaignMaxSeconds * 1000);
      const summary = await reconciler.reconcileTenant(TENANT_A, over);
      expect(summary.failed).toBeGreaterThanOrEqual(1);
      const row = await byDigest('RC-CAMP', old.statementDigest);
      expect(row).toMatchObject({
        state: 'failed',
        settled_outcome: 'rejected',
        settled_reason: 'maintenance-blocked',
      });
      expect(row['failure_detail']).toContain('campaign over');
      expect(row['failure_detail']).toContain('maintenance-blocked');
      expect(await rows('RC-CAMP')).toHaveLength(1);
      expect(await seqOf('RC-CAMP')).toBe(1);
    });

    it('a re-issue the cloud would not sign ends the intent as FAILED and says why', async () => {
      const old = await refused('RC-REFUSED');
      forVersion.mockRejectedValueOnce(
        new StatementAdmissionError('The release 1.7.0', 'its provenance names another tag'),
      );
      await reconciler.reconcileTenant(TENANT_A, AFTER_INTERVAL);
      const row = await byDigest('RC-REFUSED', old.statementDigest);
      expect(row['state']).toBe('failed');
      expect(row['failure_detail']).toContain('re-issue refused');
      expect(row['failure_detail']).toContain('provenance names another tag');
      expect(await rows('RC-REFUSED')).toHaveLength(1);
      expect(await seqOf('RC-REFUSED')).toBe(1);
    });

    it('a dependency that is only down leaves the request waiting; the next tick re-issues it', async () => {
      const old = await refused('RC-DOWN');
      forVersion.mockRejectedValueOnce(new Error('connect ECONNREFUSED releases.example.com:443'));
      const summary = await reconciler.reconcileTenant(TENANT_A, AFTER_INTERVAL);
      expect(summary.waiting).toBeGreaterThanOrEqual(1);
      expect((await byDigest('RC-DOWN', old.statementDigest))['state']).toBe('retry');
      expect(await seqOf('RC-DOWN')).toBe(1);
      await reconciler.reconcileTenant(TENANT_A, AFTER_INTERVAL);
      expect((await byDigest('RC-DOWN', old.statementDigest))['state']).toBe('reissued');
      expect(await seqOf('RC-DOWN')).toBe(2);
    });

    it('two replicas reconciling at once re-issue it once and burn no sequence value', async () => {
      const old = await refused('RC-RACE');
      const [a, b] = await Promise.all([
        reconciler.reconcileTenant(TENANT_A, AFTER_INTERVAL),
        reconciler.reconcileTenant(TENANT_A, AFTER_INTERVAL),
      ]);
      expect(a.reissued + b.reissued).toBeGreaterThanOrEqual(1);
      const all = await rows('RC-RACE');
      expect(all.map((r) => r['state']).sort()).toEqual(['pending', 'reissued']);
      expect((await byDigest('RC-RACE', old.statementDigest))['state']).toBe('reissued');
      expect(await seqOf('RC-RACE')).toBe(2);
    });

    it('a device that left service ends the intent as FAILED, not re-signed', async () => {
      const old = await refused('RC-GONE');
      await admin.query(
        `UPDATE ${stage?.schemaOf(tenantOf('RC-GONE'))}.edge_devices SET lifecycle_state = 'revoked' WHERE id = $1`,
        [id('RC-GONE')],
      );
      await reconciler.reconcileTenant(TENANT_A, AFTER_INTERVAL);
      const row = await byDigest('RC-GONE', old.statementDigest);
      expect(row['state']).toBe('failed');
      expect(row['failure_detail']).toContain('cannot take an update statement');
      expect(await rows('RC-GONE')).toHaveLength(1);
    });

    it('a stored recipe the cloud did not write ends the intent as FAILED instead of being signed', async () => {
      const old = await refused('RC-BAD');
      await admin.query(
        `UPDATE ${table('RC-BAD')} SET recipe = '{"kind":"edge-update"}'::jsonb WHERE id = $1`,
        [old.id],
      );
      await reconciler.reconcileTenant(TENANT_A, AFTER_INTERVAL);
      const row = await byDigest('RC-BAD', old.statementDigest);
      expect(row['state']).toBe('failed');
      expect(row['failure_detail']).toContain('recipe');
      expect(await rows('RC-BAD')).toHaveLength(1);
    });

    it('a final refusal is never re-issued', async () => {
      const old = await refused('RC-FINAL', 'signature-invalid');
      await reconciler.reconcileTenant(TENANT_A, AFTER_INTERVAL);
      expect((await rows('RC-FINAL')).map((r) => r['state'])).toEqual(['failed']);
      expect((await byDigest('RC-FINAL', old.statementDigest))['failure_detail']).toBeNull();
    });

    it('lapses a silent request when its window closes, on the same tick', async () => {
      const silent = await service.issueEdgeUpdate(ref('RC-LAPSE'), edge());
      const before = await reconciler.reconcileTenant(TENANT_A, WINDOW.expiresAt);
      expect(before.lapsed).toBeGreaterThanOrEqual(1);
      expect((await byDigest('RC-LAPSE', silent.statementDigest))['state']).toBe('lapsed');
    });

    it("reconciling one tenant never touches another tenant's requests", async () => {
      const other = await refused('RC-OTHER');
      await reconciler.reconcileTenant(TENANT_A, AFTER_INTERVAL);
      expect((await byDigest('RC-OTHER', other.statementDigest))['state']).toBe('retry');
      await reconciler.reconcileTenant(TENANT_B, AFTER_INTERVAL);
      expect((await byDigest('RC-OTHER', other.statementDigest))['state']).toBe('reissued');
    });

    describe('rollback', () => {
      const rolledBack = (
        code: string,
        seq: number,
        version: string,
        reason = 'health-window-failed',
      ) =>
        telemetry.ingest(
          { tenantId: tenantOf(code), deviceIdentifier: id(code) },
          Buffer.from(
            JSON.stringify({
              _type: 'suderra.result.v1',
              seq,
              kind: 'edge-rollback',
              outcome: 'failed',
              reason,
              occurred_at: '2026-10-20T12:30:00Z',
              time_state: 'synced-nts',
              board_profile: 'revpi-connect4',
              os_version: '1.0.0',
              subject: { version, security_version: 7 },
            }),
          ),
        );
      const installed = async (code: string, seq: number): Promise<string> => {
        const issued = await service.issueEdgeUpdate(
          ref(code),
          edge({ terms: { ...TERMS, maxOutageSeconds: 200 + seq } }),
        );
        await report(code, issued.statementDigest, { seq });
        expect((await byDigest(code, issued.statementDigest))['state']).toBe('done');
        return issued.statementDigest;
      };

      it('the device rolling an installed update back fails the request that installed it', async () => {
        const digest = await installed('RC-ROLL', 100);
        await rolledBack('RC-ROLL', 101, '1.7.0');
        const row = await byDigest('RC-ROLL', digest);
        expect(row['state']).toBe('failed');
        expect(row['failure_detail']).toBe('rolled back by the device: health-window-failed');
        expect(row['settled_outcome']).toBe('ok');
      });

      it('a republished older rollback never fails a newer install of the same version', async () => {
        const newer = await installed('RC-ROLL', 200);
        await rolledBack('RC-ROLL', 101, '1.7.0');
        expect((await byDigest('RC-ROLL', newer))['state']).toBe('done');
      });

      it('a rollback naming another version fails nothing', async () => {
        const digest = await installed('RC-ROLL', 300);
        await rolledBack('RC-ROLL', 301, '1.6.0');
        expect((await byDigest('RC-ROLL', digest))['state']).toBe('done');
      });

      it("another device's rollback never fails this device's install", async () => {
        const digest = await installed('RC-ROLL', 400);
        await rolledBack('RC-EDGE', 401, '1.7.0');
        expect((await byDigest('RC-ROLL', digest))['state']).toBe('done');
      });
    });
  });

  describe('site statements and the trust-anchors bundle', () => {
    const anchors = (): TrustAnchorBundleService =>
      new TrustAnchorBundleService(
        new SuderraEdgeConfig(
          new ConfigService(channelEnvironment({ SUDERRA_EDGE_AGENT_VERSION: '1.7.0' })),
        ),
      );
    const siteRecipe = (files: Record<string, string> = {}): SiteConfigRecipe => ({
      kind: 'site-config',
      files,
      windowSeconds: 7200,
    });
    const siteIssue = (over: Partial<SiteConfigIssue> = {}): SiteConfigIssue => ({
      extraFiles: new Map(),
      window: WINDOW,
      recipe: siteRecipe(),
      ...over,
    });
    const POLICY: NetpolicyBody = {
      interfaces: [],
      ot_rules: [{ id: 'plc', proto: 'tcp', dst: '10.0.0.0/24', ports: [{ from: 502, to: 502 }] }],
      time_sources: [],
    };
    const netIssue = (over: Partial<SiteNetpolicyIssue> = {}): SiteNetpolicyIssue => ({
      policy: POLICY,
      window: WINDOW,
      recipe: { kind: 'site-netpolicy', policy: POLICY, windowSeconds: 7200 },
      ...over,
    });
    const taRecipe = (bundleDigest: string): TrustAnchorsRecipe => ({
      kind: 'trust-anchors',
      bundleDigest,
      windowSeconds: 7200,
    });
    const report = (
      code: string,
      kind: string,
      statementType: string,
      digest: string,
      over: Record<string, unknown> = {},
    ): Promise<unknown> =>
      telemetry.ingest(
        { tenantId: tenantOf(code), deviceIdentifier: id(code) },
        concluding(digest, {
          kind,
          subject: { statement_type: statementType, statement_digest: { sha256: digest } },
          ...over,
        }),
      );
    const bodyOf = (row: Record<string, any>): Record<string, any> =>
      JSON.parse(Buffer.from(JSON.parse(row['statement']).payload, 'base64').toString('utf8'));

    describe('a site config', () => {
      it('is stored with the bundle its URL names, allocated the next update_seq, config.yaml token-free', async () => {
        const issued = await service.issueSiteConfig(
          ref('SC-CONFIG'),
          siteIssue({
            extraFiles: new Map([['io-config.yaml', Buffer.from('tags: []\n', 'utf8')]]),
            recipe: siteRecipe({ 'io-config.yaml': Buffer.from('tags: []\n').toString('base64') }),
          }),
        );
        const [row] = await rows('SC-CONFIG');
        expect(issued).toMatchObject({ statementType: 'suderra.site-config.v1', updateSeq: 1 });
        const body = bodyOf(row ?? {});
        expect(body['site_bundle_url']).toBe(
          `https://api.example.com/api/devices/site-bundles/${TENANT_A}/${issued.id}`,
        );
        expect(row?.['id']).toBe(issued.id);
        expect(Object.keys(body['files']).sort()).toEqual(['config.yaml', 'io-config.yaml']);
        const bundle = JSON.parse(row?.['site_bundle']);
        expect(Object.keys(bundle['site_files']).sort()).toEqual(['config.yaml', 'io-config.yaml']);
        expect(
          Buffer.from(bundle['site_files']['config.yaml'], 'base64').toString('utf8'),
        ).not.toContain('provisioning_token');
        expect(row).toMatchObject({ state: 'pending', update_seq: '1' });
      });

      it('is served inside its window only, while it is open, and to nobody else', async () => {
        const issued = await service.issueSiteConfig(ref('SC-SETTLE'), siteIssue());
        const inside = new Date(WINDOW.notBefore.getTime() + 60_000);
        const bundle = await service.siteBundleOf(TENANT_A, issued.id, inside);
        expect(bundle).not.toBeNull();
        expect(JSON.parse(bundle ?? '')._type).toBe('suderra.site-bundle.v1');
        // Before the window, at its end, and after.
        expect(
          await service.siteBundleOf(TENANT_A, issued.id, new Date(WINDOW.notBefore.getTime() - 1)),
        ).toBeNull();
        expect(await service.siteBundleOf(TENANT_A, issued.id, WINDOW.expiresAt)).toBeNull();
        // Another tenant, an unknown id, and another statement type answer alike.
        expect(await service.siteBundleOf(TENANT_B, issued.id, inside)).toBeNull();
        expect(
          await service.siteBundleOf(TENANT_A, '11111111-1111-4111-8111-111111111111', inside),
        ).toBeNull();
        const other = await service.issueEdgeUpdate(ref('SC-NET'), edge());
        expect(await service.siteBundleOf(TENANT_A, other.id, inside)).toBeNull();
        // A concluded request is no longer served.
        await report('SC-SETTLE', 'site-config', 'suderra.site-config.v1', issued.statementDigest);
        expect(await service.siteBundleOf(TENANT_A, issued.id, inside)).toBeNull();
      });

      it('is concluded by its own kind of result: ok, a retryable refusal, a final one', async () => {
        const ok = await service.issueSiteConfig(ref('SC-SETTLE'), siteIssue());
        await report('SC-SETTLE', 'site-config', 'suderra.site-config.v1', ok.statementDigest);
        const retry = await service.issueSiteConfig(ref('SC-SETTLE'), siteIssue());
        await report('SC-SETTLE', 'site-config', 'suderra.site-config.v1', retry.statementDigest, {
          outcome: 'rejected',
          reason: 'fetch-failed',
        });
        const final = await service.issueSiteConfig(ref('SC-SETTLE'), siteIssue());
        await report('SC-SETTLE', 'site-config', 'suderra.site-config.v1', final.statementDigest, {
          outcome: 'rejected',
          reason: 'site-bundle-missing',
        });
        const byDigest = new Map(
          (await rows('SC-SETTLE')).map((r) => [r['statement_digest'], r['state']]),
        );
        expect(byDigest.get(ok.statementDigest)).toBe('done');
        expect(byDigest.get(retry.statementDigest)).toBe('retry');
        expect(byDigest.get(final.statementDigest)).toBe('failed');
      });

      it('refuses what SG-1 does not allow, and leaves no row and no spent sequence value', async () => {
        const before = await seqOf('SC-REFUSED');
        await expect(
          service.issueSiteConfig(
            ref('SC-REFUSED'),
            siteIssue({ extraFiles: new Map([['revpi/config.rsc', Buffer.from('{}')]]) }),
          ),
        ).rejects.toBeInstanceOf(UpdateRefusedError);
        expect(await seqOf('SC-REFUSED')).toBe(before);
        expect(await rows('SC-REFUSED')).toEqual([]);
      });
    });

    describe('a site policy', () => {
      it('is stored as signed with the next update_seq, and refused when the contract refuses it', async () => {
        const issued = await service.issueSiteNetpolicy(ref('SC-NET'), netIssue());
        expect(issued).toMatchObject({ statementType: 'suderra.site-netpolicy.v1' });
        const row = (await rows('SC-NET')).find((r) => r['id'] === issued.id);
        expect(bodyOf(row ?? {})).toMatchObject({
          ot_rules: [{ id: 'plc', dst: '10.0.0.0/24' }],
          update_seq: Number(row?.['update_seq']),
        });
        const before = await seqOf('SC-NET');
        await expect(
          service.issueSiteNetpolicy(
            ref('SC-NET'),
            netIssue({
              policy: { ...POLICY, ot_rules: [{ ...POLICY.ot_rules[0]!, dst: '10.0.0.5/24' }] },
            }),
          ),
        ).rejects.toBeInstanceOf(UpdateRefusedError);
        expect(await seqOf('SC-NET')).toBe(before);
      });
    });

    describe('the trust-anchors bundle', () => {
      const held = (): string => anchors().forTenant(TENANT_FIXTURE).digest.sha256;

      it('is stored exactly as the ceremony signed it, with no update_seq and no sequence value spent', async () => {
        const before = await seqOf('TA-ONE');
        const issued = await service.issueTrustAnchors(ref('TA-ONE'), {
          window: WINDOW,
          recipe: taRecipe(held()),
        });
        const [row] = await rows('TA-ONE');
        expect(issued).toMatchObject({
          statementType: 'suderra.trust-anchors.v1',
          updateSeq: null,
        });
        expect(JSON.parse(row?.['statement'])).toEqual(
          anchors().forTenant(TENANT_FIXTURE).envelope,
        );
        expect(row).toMatchObject({ update_seq: null, statement_digest: held(), state: 'pending' });
        expect(new Date(row?.['expires_at']).getTime()).toBe(WINDOW.expiresAt.getTime());
        expect(await seqOf('TA-ONE')).toBe(before);
      });

      it('is concluded by a trust-anchors result; pushed again it is a new request with the same digest', async () => {
        const first = await service.issueTrustAnchors(ref('TA-TWO'), {
          window: WINDOW,
          recipe: taRecipe(held()),
        });
        await report('TA-TWO', 'trust-anchors', 'suderra.trust-anchors.v1', first.statementDigest);
        expect((await rows('TA-TWO'))[0]).toMatchObject({ state: 'done' });
        const again = await service.issueTrustAnchors(ref('TA-TWO'), {
          window: WINDOW,
          recipe: taRecipe(held()),
        });
        expect(again.statementDigest).toBe(first.statementDigest);
        expect(again.id).not.toBe(first.id);
        // One open request per device and digest: a second push while the first is open is refused.
        await expect(
          service.issueTrustAnchors(ref('TA-TWO'), { window: WINDOW, recipe: taRecipe(held()) }),
        ).rejects.toThrow(/uq_edge_update_requests_device_digest/);
      });

      it('a result that arrived before a push cannot conclude it, however often it is offered again', async () => {
        const first = await service.issueTrustAnchors(ref('TA-LATE'), {
          window: WINDOW,
          recipe: taRecipe(held()),
        });
        const document = concluding(first.statementDigest, {
          seq: 777001,
          kind: 'trust-anchors',
          subject: {
            statement_type: 'suderra.trust-anchors.v1',
            statement_digest: { sha256: first.statementDigest },
          },
        });
        await telemetry.ingest(
          { tenantId: TENANT_FIXTURE, deviceIdentifier: id('TA-LATE') },
          document,
        );
        expect((await rows('TA-LATE')).find((r) => r['id'] === first.id)?.['state']).toBe('done');
        const second = await service.issueTrustAnchors(ref('TA-LATE'), {
          window: WINDOW,
          recipe: taRecipe(held()),
        });
        // The device's agent republishes the old message after a reconnect.
        await telemetry.ingest(
          { tenantId: TENANT_FIXTURE, deviceIdentifier: id('TA-LATE') },
          document,
        );
        expect((await rows('TA-LATE')).find((r) => r['id'] === second.id)?.['state']).toBe(
          'pending',
        );
      });

      it('is refused for a tenant outside the bundle’s scope, and when the approved digest is not the held bundle', async () => {
        await expect(
          service.issueTrustAnchors(ref('TA-OUT'), { window: WINDOW, recipe: taRecipe(held()) }),
        ).rejects.toBeInstanceOf(TenantOutOfBundleScopeError);
        expect(await rows('TA-OUT')).toEqual([]);
        await expect(
          service.issueTrustAnchors(ref('TA-RETRY'), {
            window: WINDOW,
            recipe: taRecipe('0'.repeat(64)),
          }),
        ).rejects.toMatchObject({ reason: 'bundle-invalid' });
        expect(await rows('TA-RETRY')).toEqual([]);
      });
    });

    describe('the reconciler re-issues them', () => {
      const REFUSED_AT = new Date('2026-10-20T12:00:00Z');
      const CAMPAIGN = new Date('2026-10-20T11:00:00Z');
      const AFTER = new Date(
        REFUSED_AT.getTime() + UPDATE_CHANNEL.reissueMinIntervalSeconds * 1000,
      );
      const refuse = async (
        code: string,
        kind: string,
        type: string,
        issued: { id: string; statementDigest: string },
        reason = 'fetch-failed',
      ): Promise<void> => {
        await report(code, kind, type, issued.statementDigest, {
          outcome: 'rejected',
          reason,
        });
        await admin.query(
          `UPDATE ${table(code)} SET settled_at = $2, campaign_started_at = $3 WHERE id = $1`,
          [issued.id, REFUSED_AT, CAMPAIGN],
        );
      };

      it('a site config: a new statement and bundle of the same intent, a new request id in its URL', async () => {
        const old = await service.issueSiteConfig(ref('SC-RETRY'), siteIssue());
        await refuse('SC-RETRY', 'site-config', 'suderra.site-config.v1', old);
        await reconciler.reconcileTenant(TENANT_A, AFTER);
        const [before, after] = await rows('SC-RETRY');
        expect(before).toMatchObject({ state: 'reissued', id: old.id });
        expect(after).toMatchObject({ state: 'pending', intent_id: old.intentId });
        expect(Number(after?.['update_seq'])).toBeGreaterThan(Number(before?.['update_seq']));
        expect(bodyOf(after ?? {})['site_bundle_url']).toContain(String(after?.['id']));
        expect(bodyOf(after ?? {})['site_bundle_url']).not.toContain(old.id);
        expect(after?.['site_bundle']).not.toBeNull();
      });

      it('a site policy', async () => {
        const old = await service.issueSiteNetpolicy(ref('SC-RETRY-NET'), netIssue());
        await refuse(
          'SC-RETRY-NET',
          'site-netpolicy',
          'suderra.site-netpolicy.v1',
          old,
          'clock-unsynced',
        );
        await reconciler.reconcileTenant(TENANT_A, AFTER);
        expect((await rows('SC-RETRY-NET')).map((r) => r['state'])).toEqual([
          'reissued',
          'pending',
        ]);
      });

      it('the trust-anchors bundle, the same approved one, and never a different one', async () => {
        const old = await service.issueTrustAnchors(ref('TA-RETRY'), {
          window: WINDOW,
          recipe: taRecipe(held()),
        });
        await refuse('TA-RETRY', 'trust-anchors', 'suderra.trust-anchors.v1', old, 'io-error');
        await reconciler.reconcileTenant(TENANT_FIXTURE, AFTER);
        expect((await rows('TA-RETRY')).map((r) => r['state'])).toEqual(['reissued', 'pending']);
      });

      const held = (): string => anchors().forTenant(TENANT_FIXTURE).digest.sha256;
    });
  });
});
