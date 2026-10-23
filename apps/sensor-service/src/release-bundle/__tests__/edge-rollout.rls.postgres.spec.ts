import { ScheduledJobExecutor } from '@aquaculture/backend-common/scheduling';
import { collaborator } from '@aquaculture/testing';
import { ConfigService } from '@nestjs/config';
import { type DataSource } from 'typeorm';

import { DeviceDirectoryService } from '../../edge-device/device-directory.service';
import { type EdgeCommandPublisher } from '../../edge-device/edge-command-publisher.service';
import {
  type AdmittedRelease,
  type EdgeReleaseCatalog,
} from '../../edge-device/edge-release-catalog.service';
import { EdgeResultTelemetryService } from '../../edge-device/edge-result-telemetry.service';
import { EdgeUpdateManifestService } from '../../edge-device/edge-update-manifest.service';
import { EdgeUpdateRequestService } from '../../edge-device/edge-update-request.service';
import { EdgeDeviceDirectory } from '../../edge-device/entities/edge-device-directory.entity';
import { EdgeDeviceResult } from '../../edge-device/entities/edge-device-result.entity';
import { EdgeUpdateRequest } from '../../edge-device/entities/edge-update-request.entity';
import {
  DeviceLifecycleState,
  DeviceModel,
  EdgeAgentChannel,
  EdgeDevice,
} from '../../edge-device/entities/edge-device.entity';
import { StatementAdmissionError } from '../../edge-device/manifest-signer';
import { SuderraEdgeConfig } from '../../edge-device/suderra-edge.config';
import { channelEnvironment } from '../../edge-device/__tests__/support/edge-channel-env';
import { fixtureRelease } from '../../edge-device/__tests__/support/fixture-release';
import {
  bootSensorRlsHarness,
  type SensorRlsHarness,
} from '../../__tests__/support/sensor-rls-postgres.harness';
import { EdgeRolloutService } from '../edge-rollout.service';
import { type EdgeRolloutPlan, type OsRolloutPlan, planDigest } from '../edge-rollout-plan';
import { EdgeRolloutApproval } from '../entities/edge-rollout-approval.entity';
import { EdgeRolloutDevice } from '../entities/edge-rollout-device.entity';
import { EdgeRollout, EdgeRolloutKind } from '../entities/edge-rollout.entity';

/**
 * Cohort rollouts and their two-person approval on real Postgres (ADR-048 DEC-2.4,
 * DEC-23): what is stored, who may start it, which devices are signed for and when,
 * and when a rollout stops.
 */

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BINDING = { method: 'tpm-ek-sha256', sha256: '7d'.repeat(32) } as const;
const NOW = new Date('2026-10-20T12:00:00Z');
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

const CODES = Array.from({ length: 80 }, (_, i) => `RO-${String(i + 1).padStart(3, '0')}`);
interface Seed {
  readonly code: string;
  readonly tenantId: string;
  readonly channel?: EdgeAgentChannel;
  readonly state?: DeviceLifecycleState;
  readonly bound?: boolean;
}
const SEED: readonly Seed[] = [
  ...CODES.map((code) => ({ code, tenantId: TENANT_A })),
  { code: 'RO-GENERIC', tenantId: TENANT_A, channel: EdgeAgentChannel.GENERIC_LINUX },
  { code: 'RO-UNBOUND', tenantId: TENANT_A, bound: false },
  { code: 'RO-REVOKED', tenantId: TENANT_A, state: DeviceLifecycleState.REVOKED },
  { code: 'RB-01', tenantId: TENANT_B },
];

jest.setTimeout(240_000);

describe('rollouts and their two-person approval under FORCE RLS (ADR-048 DEC-2.4)', () => {
  let stage: SensorRlsHarness | undefined;
  let admin: DataSource;
  let rollouts: EdgeRolloutService;
  let requests: EdgeUpdateRequestService;
  let telemetry: EdgeResultTelemetryService;
  let release: AdmittedRelease;
  let forVersion: jest.Mock;
  const ids = new Map<string, string>();
  let next = 0;

  const id = (code: string): string => {
    const found = ids.get(code);
    if (found === undefined) throw new Error(`no device ${code}`);
    return found;
  };
  /** The next `n` unused devices of tenant A: every test takes its own, a device is in one open rollout at most. */
  const take = (n: number): string[] => {
    const codes = CODES.slice(next, next + n);
    if (codes.length !== n) throw new Error('the seed is out of devices');
    next += n;
    return codes;
  };
  const schemaA = (): string => `${stage?.schemaOf(TENANT_A)}`;
  const edgePlan = (
    over: Partial<EdgeRolloutPlan> & { waves: readonly (readonly string[])[] },
  ): EdgeRolloutPlan => ({
    kind: EdgeRolloutKind.EDGE_UPDATE,
    version: '1.7.0',
    terms: TERMS,
    windowNotBefore: null,
    windowSeconds: 7200,
    maxFailures: 0,
    ...over,
  });
  const osPlan = (
    over: Partial<OsRolloutPlan> & { waves: readonly (readonly string[])[] },
  ): OsRolloutPlan => ({
    kind: EdgeRolloutKind.OS_UPDATE,
    bundle: BUNDLE,
    terms: { ...TERMS, localApproval: true },
    windowNotBefore: null,
    windowSeconds: 7200,
    maxFailures: 0,
    ...over,
  });
  const waves = (...groups: string[][]): string[][] => groups.map((g) => g.map(id));
  const rolloutRow = async (rolloutId: string): Promise<Record<string, any>> => {
    const [row] = await admin.query(`SELECT * FROM ${schemaA()}.edge_rollouts WHERE id = $1`, [
      rolloutId,
    ]);
    return row;
  };
  const requestsOf = async (code: string): Promise<Array<Record<string, any>>> =>
    admin.query(
      `SELECT * FROM ${schemaA()}.edge_update_requests WHERE device_id = $1 ORDER BY created_at, id`,
      [id(code)],
    );
  const approved = async (
    plan: EdgeRolloutPlan | OsRolloutPlan,
    name = 'rollout',
  ): Promise<EdgeRollout> => {
    const created = await rollouts.create(TENANT_A, 'user-creator', name, plan, NOW);
    await rollouts.approve(TENANT_A, 'user-1', created.id, created.planSha256);
    return rollouts.approve(TENANT_A, 'user-2', created.id, created.planSha256);
  };
  const report = (code: string, over: Record<string, unknown>): Promise<unknown> =>
    telemetry.ingest(
      { tenantId: TENANT_A, deviceIdentifier: id(code) },
      Buffer.from(
        JSON.stringify({
          _type: 'suderra.result.v1',
          seq: Math.floor(Math.random() * 1e9) + 1,
          occurred_at: '2026-10-20T12:05:00Z',
          time_state: 'synced-nts',
          board_profile: 'revpi-connect4',
          os_version: '1.0.0',
          ...over,
        }),
      ),
    );
  const conclude = async (
    code: string,
    over: Record<string, unknown> = {},
    statementType = 'suderra.edge-update.v1',
  ): Promise<void> => {
    const pending = (await requestsOf(code)).filter((r) => r['state'] === 'pending');
    const open = pending[pending.length - 1];
    if (open === undefined) throw new Error(`${code} has no open request`);
    await report(code, {
      kind: statementType === 'suderra.os-update.v1' ? 'os-update' : 'edge-update',
      outcome: 'ok',
      subject: {
        statement_type: statementType,
        statement_digest: { sha256: open['statement_digest'] },
      },
      ...over,
    });
  };
  const states = async (rolloutId: string): Promise<Record<string, string>> =>
    Object.fromEntries(
      (await rollouts.devices(TENANT_A, rolloutId)).map((d) => [d.deviceId, d.phase]),
    );

  beforeAll(async () => {
    const config = new SuderraEdgeConfig(
      new ConfigService(channelEnvironment({ SUDERRA_EDGE_AGENT_VERSION: '1.7.0' })),
    );
    release = await fixtureRelease(config, '1.7.0');
    stage = await bootSensorRlsHarness({
      name: 'edge_rollout',
      tenants: [TENANT_A, TENANT_B],
      entities: [
        EdgeDevice,
        EdgeDeviceResult,
        EdgeUpdateRequest,
        EdgeRollout,
        EdgeRolloutApproval,
        EdgeRolloutDevice,
      ],
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
              edgeStatementSeq: 0,
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
    telemetry = new EdgeResultTelemetryService(
      stage.runtime,
      new DeviceDirectoryService(stage.runtime),
    );
    requests = new EdgeUpdateRequestService(
      stage.runtime,
      new EdgeUpdateManifestService(config),
      collaborator<EdgeCommandPublisher>(
        { publish: jest.fn(async (): Promise<void> => undefined) },
        'EdgeCommandPublisher',
      ),
      telemetry,
    );
    requests.onModuleInit();
    forVersion = jest.fn(async (): Promise<AdmittedRelease> => release);
    rollouts = new EdgeRolloutService(
      stage.runtime,
      requests,
      collaborator<EdgeReleaseCatalog>({ forVersion }, 'EdgeReleaseCatalog'),
      collaborator<ScheduledJobExecutor>({}, 'ScheduledJobExecutor'),
    );
  });

  afterAll(async () => {
    await stage?.shutdown();
  });

  describe('creating', () => {
    it('stores the plan awaiting approval, its cohort in waves, and the digest of the plan', async () => {
      const [a, b, c] = take(3) as [string, string, string];
      const plan = edgePlan({ waves: waves([a], [b, c]), maxFailures: 1 });
      const created = await rollouts.create(TENANT_A, 'user-creator', '  Canary 1.7.0 ', plan, NOW);
      expect(created).toMatchObject({
        name: 'Canary 1.7.0',
        kind: 'edge-update',
        state: 'awaiting-approval',
        approvalsRequired: 2,
        maxFailures: 1,
        windowSeconds: 7200,
        createdBy: 'user-creator',
        target: { version: '1.7.0' },
        planSha256: planDigest(plan),
      });
      const devices = await admin.query(
        `SELECT device_id, wave, request_id, refusal FROM ${schemaA()}.edge_rollout_devices
          WHERE rollout_id = $1 ORDER BY wave, device_id`,
        [created.id],
      );
      expect(devices.map((d: Record<string, unknown>) => [d['device_id'], d['wave']])).toEqual(
        expect.arrayContaining([
          [id(a), 1],
          [id(b), 2],
          [id(c), 2],
        ]),
      );
      expect(devices.every((d: Record<string, unknown>) => d['request_id'] === null)).toBe(true);
      // Nothing is signed for anyone yet.
      expect(await requestsOf(a)).toEqual([]);
    });

    it('the digest names the plan: any change of it is another digest, wave order inside a wave is not', () => {
      const base = edgePlan({
        waves: [['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002']],
      });
      const swapped = edgePlan({
        waves: [['00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001']],
      });
      expect(planDigest(swapped)).toBe(planDigest(base));
      for (const changed of [
        { ...base, version: '1.7.1' },
        { ...base, terms: { ...TERMS, maxOutageSeconds: 121 } },
        { ...base, windowSeconds: 7201 },
        { ...base, maxFailures: 1 },
        { ...base, windowNotBefore: NOW },
        { ...base, waves: [[base.waves[0]?.[0] ?? ''], [base.waves[0]?.[1] ?? '']] },
      ]) {
        expect(planDigest(changed)).not.toBe(planDigest(base));
      }
    });

    it('the database itself refuses a rollout that needs fewer than two approvals', async () => {
      await expect(
        admin.query(
          `INSERT INTO ${schemaA()}.edge_rollouts
             (tenant_id, name, kind, target, terms, window_seconds, max_failures, approvals_required,
              plan_sha256, state, created_by)
           VALUES ($1, 'one-person', 'edge-update', '{"version":"1.7.0"}', '{}', 7200, 0, 1, $2,
                   'awaiting-approval', 'user-creator')`,
          [TENANT_A, 'a'.repeat(64)],
        ),
      ).rejects.toThrow(/CHK_edge_rollouts_approvals/);
    });

    it.each([
      [
        'an unknown device',
        () => [['00000000-0000-4000-8000-0000000000ff']],
        /not a device of this tenant/,
      ],
      ["another tenant's device", () => [[id('RB-01')]], /not a device of this tenant/],
      ['a generic-Linux device', () => [[id('RO-GENERIC')]], /not a committed Suderra OS device/],
      ['an unbound device', () => [[id('RO-UNBOUND')]], /not a committed Suderra OS device/],
      ['a revoked device', () => [[id('RO-REVOKED')]], /revoked, not in service/],
      ['an empty wave', () => [[]], /wave 1 has no device/],
      ['no wave', () => [], /between 1 and 10 are allowed/],
      [
        'a device twice',
        () => {
          const [a] = take(1) as [string];
          return [[id(a)], [id(a)]];
        },
        /in the cohort twice/,
      ],
    ])('refuses a plan with %s and stores nothing', async (_name, cohort, message) => {
      const before = await admin.query(`SELECT count(*)::int AS n FROM ${schemaA()}.edge_rollouts`);
      await expect(
        rollouts.create(TENANT_A, 'user-creator', 'bad', edgePlan({ waves: cohort() }), NOW),
      ).rejects.toThrow(message);
      const after = await admin.query(`SELECT count(*)::int AS n FROM ${schemaA()}.edge_rollouts`);
      expect(after[0].n).toBe(before[0].n);
    });

    it.each([
      ['a failure allowance above the cohort', { maxFailures: 5 }, /failure allowance/],
      ['a window the cloud could never deliver', { windowSeconds: 600 }, /cannot be delivered/],
      ['a window the agent would not keep', { windowSeconds: 90_000 }, /outlives/],
      [
        'a blockers override without a person on site',
        { terms: { localApproval: false, blockersOverride: true, maxOutageSeconds: 60 } },
        /blockers_override/,
      ],
      [
        'a fractional window start',
        { windowNotBefore: new Date(NOW.getTime() + 500) },
        /fractional second/,
      ],
    ])('refuses %s', async (_name, over, message) => {
      const [a] = take(1) as [string];
      await expect(
        rollouts.create(
          TENANT_A,
          'user-creator',
          'bad',
          edgePlan({ waves: waves([a]), ...(over as Partial<EdgeRolloutPlan>) }),
          NOW,
        ),
      ).rejects.toThrow(message);
    });

    it('refuses a release the catalog would not admit, before anyone is asked to approve it', async () => {
      const [a] = take(1) as [string];
      forVersion.mockRejectedValueOnce(
        new StatementAdmissionError('The release 9.9.9', 'its provenance names another tag'),
      );
      await expect(
        rollouts.create(
          TENANT_A,
          'user-creator',
          'bad',
          edgePlan({ waves: waves([a]), version: '9.9.9' }),
          NOW,
        ),
      ).rejects.toThrow(/provenance names another tag/);
    });

    it('refuses an OS bundle that installs below the floor it sets', async () => {
      const [a] = take(1) as [string];
      await expect(
        rollouts.create(
          TENANT_A,
          'user-creator',
          'bad',
          osPlan({ waves: waves([a]), bundle: { ...BUNDLE, rollbackFloor: '2.0.0' } }),
          NOW,
        ),
      ).rejects.toThrow(/rollback_floor/);
    });

    it('a device is in one open rollout at a time', async () => {
      const [a] = take(1) as [string];
      const first = await rollouts.create(
        TENANT_A,
        'user-creator',
        'first',
        edgePlan({ waves: waves([a]) }),
        NOW,
      );
      await expect(
        rollouts.create(TENANT_A, 'user-creator', 'second', edgePlan({ waves: waves([a]) }), NOW),
      ).rejects.toThrow(/in another rollout that has not ended/);
      await rollouts.cancel(TENANT_A, 'user-creator', first.id, 'wrong cohort');
      await expect(
        rollouts.create(TENANT_A, 'user-creator', 'second', edgePlan({ waves: waves([a]) }), NOW),
      ).resolves.toMatchObject({ state: 'awaiting-approval' });
    });

    it('refuses a name that is empty or too long', async () => {
      const [a] = take(1) as [string];
      for (const name of ['   ', 'x'.repeat(121)]) {
        await expect(
          rollouts.create(TENANT_A, 'user-creator', name, edgePlan({ waves: waves([a]) }), NOW),
        ).rejects.toThrow(/1 to 120 characters/);
      }
    });
  });

  describe('approving', () => {
    const planOf = (code: string): EdgeRolloutPlan => edgePlan({ waves: waves([code]) });

    it('starts only when two different people approved this plan', async () => {
      const [a] = take(1) as [string];
      const created = await rollouts.create(TENANT_A, 'user-creator', 'two people', planOf(a), NOW);
      const afterOne = await rollouts.approve(TENANT_A, 'user-1', created.id, created.planSha256);
      expect(afterOne.state).toBe('awaiting-approval');
      expect((await rolloutRow(created.id))['approved_at']).toBeNull();
      const afterTwo = await rollouts.approve(TENANT_A, 'user-2', created.id, created.planSha256);
      expect(afterTwo.state).toBe('running');
      expect((await rolloutRow(created.id))['approved_at']).not.toBeNull();
      const approvals = await rollouts.approvals(TENANT_A, created.id);
      expect(approvals.map((x) => x.approverId)).toEqual(['user-1', 'user-2']);
      expect(approvals.every((x) => x.planSha256 === created.planSha256)).toBe(true);
    });

    it('one person asking twice is one approval', async () => {
      const [a] = take(1) as [string];
      const created = await rollouts.create(
        TENANT_A,
        'user-creator',
        'same person',
        planOf(a),
        NOW,
      );
      await rollouts.approve(TENANT_A, 'user-1', created.id, created.planSha256);
      const again = await rollouts.approve(TENANT_A, 'user-1', created.id, created.planSha256);
      expect(again.state).toBe('awaiting-approval');
      expect(await rollouts.approvals(TENANT_A, created.id)).toHaveLength(1);
    });

    it('the creator may be one of the two, but cannot be both', async () => {
      const [a] = take(1) as [string];
      const created = await rollouts.create(TENANT_A, 'user-creator', 'creator', planOf(a), NOW);
      expect(
        (await rollouts.approve(TENANT_A, 'user-creator', created.id, created.planSha256)).state,
      ).toBe('awaiting-approval');
      expect(
        (await rollouts.approve(TENANT_A, 'user-1', created.id, created.planSha256)).state,
      ).toBe('running');
    });

    it('an approval of another plan than the rollout holds records nothing', async () => {
      const [a] = take(1) as [string];
      const created = await rollouts.create(TENANT_A, 'user-creator', 'digest', planOf(a), NOW);
      await expect(
        rollouts.approve(
          TENANT_A,
          'user-1',
          created.id,
          planDigest({ ...planOf(a), version: '1.7.1' }),
        ),
      ).rejects.toThrow(/another plan/);
      expect(await rollouts.approvals(TENANT_A, created.id)).toEqual([]);
    });

    it('two people approving at the same moment start it once, with both approvals', async () => {
      const [a] = take(1) as [string];
      const created = await rollouts.create(TENANT_A, 'user-creator', 'race', planOf(a), NOW);
      const both = await Promise.all([
        rollouts.approve(TENANT_A, 'user-1', created.id, created.planSha256),
        rollouts.approve(TENANT_A, 'user-2', created.id, created.planSha256),
      ]);
      expect(both.map((r) => r.state).sort()).toEqual(['awaiting-approval', 'running']);
      expect((await rolloutRow(created.id))['state']).toBe('running');
      expect(await rollouts.approvals(TENANT_A, created.id)).toHaveLength(2);
    });

    it('approves only a rollout that is waiting for it, and only in its own tenant', async () => {
      const [a] = take(1) as [string];
      const created = await rollouts.create(TENANT_A, 'user-creator', 'states', planOf(a), NOW);
      await expect(
        rollouts.approve(TENANT_B, 'user-1', created.id, created.planSha256),
      ).rejects.toThrow(/not found/);
      await rollouts.cancel(TENANT_A, 'user-creator', created.id, 'changed my mind');
      await expect(
        rollouts.approve(TENANT_A, 'user-1', created.id, created.planSha256),
      ).rejects.toThrow(/cancelled, not awaiting approval/);
    });

    it('signs nothing for any device until the second approval', async () => {
      const [a] = take(1) as [string];
      const created = await rollouts.create(TENANT_A, 'user-creator', 'unsigned', planOf(a), NOW);
      await rollouts.approve(TENANT_A, 'user-1', created.id, created.planSha256);
      await rollouts.advanceTenant(TENANT_A, NOW);
      expect(await requestsOf(a)).toEqual([]);
    });

    it('the approval record cannot be edited into another person or plan by the service paths', async () => {
      const [a] = take(1) as [string];
      const created = await rollouts.create(TENANT_A, 'user-creator', 'evidence', planOf(a), NOW);
      await rollouts.approve(TENANT_A, 'user-1', created.id, created.planSha256);
      await expect(
        admin.query(
          `INSERT INTO ${schemaA()}.edge_rollout_approvals (tenant_id, rollout_id, approver_id, plan_sha256)
           VALUES ($1, $2, 'user-1', $3)`,
          [TENANT_A, created.id, created.planSha256],
        ),
      ).rejects.toThrow(/uq_edge_rollout_approvals_rollout_approver/);
    });
  });

  describe('carrying it out', () => {
    it('signs the first wave only, bound to the rollout, each device once', async () => {
      const [a, b, c] = take(3) as [string, string, string];
      const rollout = await approved(edgePlan({ waves: waves([a], [b, c]) }));
      const summary = await rollouts.advanceTenant(TENANT_A, NOW);
      expect(summary.issued).toBeGreaterThanOrEqual(1);
      const mine = await requestsOf(a);
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({
        rollout_id: rollout.id,
        statement_type: 'suderra.edge-update.v1',
        state: 'pending',
        created_by: 'user-creator',
      });
      expect(new Date(mine[0]?.['not_before']).getTime()).toBe(NOW.getTime());
      expect(new Date(mine[0]?.['expires_at']).getTime()).toBe(NOW.getTime() + 7200 * 1000);
      expect(await requestsOf(b)).toEqual([]);
      expect(await requestsOf(c)).toEqual([]);
      const slot = await admin.query(
        `SELECT request_id FROM ${schemaA()}.edge_rollout_devices WHERE rollout_id = $1 AND device_id = $2`,
        [rollout.id, id(a)],
      );
      expect(slot[0].request_id).toBe(mine[0]?.['id']);
      expect(forVersion).toHaveBeenCalledWith(
        expect.objectContaining({ boardProfile: 'revpi-connect4' }),
        '1.7.0',
      );
    });

    it('goes wave by wave and completes when every device concluded', async () => {
      const [a, b, c] = take(3) as [string, string, string];
      const rollout = await approved(edgePlan({ waves: waves([a], [b, c]) }));
      await rollouts.advanceTenant(TENANT_A, NOW);
      // Wave 1 in flight: nothing of wave 2 is signed, however often the job runs.
      await rollouts.advanceTenant(TENANT_A, NOW);
      expect(await requestsOf(b)).toEqual([]);
      expect(await states(rollout.id)).toMatchObject({ [id(a)]: 'in-flight', [id(b)]: 'queued' });

      await conclude(a);
      expect((await states(rollout.id))[id(a)]).toBe('done');
      await rollouts.advanceTenant(TENANT_A, NOW);
      expect(await requestsOf(b)).toHaveLength(1);
      expect(await requestsOf(c)).toHaveLength(1);
      expect((await rolloutRow(rollout.id))['state']).toBe('running');

      await conclude(b);
      await conclude(c);
      const finished = await rollouts.advanceTenant(TENANT_A, NOW);
      expect(finished.completed).toBeGreaterThanOrEqual(1);
      expect(await rollouts.progress(TENANT_A, rollout.id)).toEqual({
        queued: 0,
        inFlight: 0,
        done: 3,
        failed: 0,
      });
      expect(await rolloutRow(rollout.id)).toMatchObject({ state: 'completed' });
      expect((await rolloutRow(rollout.id))['concluded_at']).not.toBeNull();
    });

    it('halts when more devices fail than the plan allows, and signs no further wave', async () => {
      const [a, b] = take(2) as [string, string];
      const rollout = await approved(edgePlan({ waves: waves([a], [b]), maxFailures: 0 }));
      await rollouts.advanceTenant(TENANT_A, NOW);
      await conclude(a, { outcome: 'rejected', reason: 'signature-invalid' });
      const step = await rollouts.advanceTenant(TENANT_A, NOW);
      expect(step.halted).toBeGreaterThanOrEqual(1);
      expect(await rolloutRow(rollout.id)).toMatchObject({
        state: 'halted',
        state_detail: '1 devices failed, the plan allows 0',
      });
      expect(await requestsOf(b)).toEqual([]);
      await rollouts.advanceTenant(TENANT_A, NOW);
      expect(await requestsOf(b)).toEqual([]);
    });

    it('a halt stops what the rest of the wave was owed and no root holds yet', async () => {
      const [a, b] = take(2) as [string, string];
      const rollout = await approved(edgePlan({ waves: waves([a, b]), maxFailures: 0 }));
      await rollouts.advanceTenant(TENANT_A, NOW);
      expect(await requestsOf(b)).toHaveLength(1);
      await conclude(a, { outcome: 'rejected', reason: 'signature-invalid' });
      await rollouts.advanceTenant(TENANT_A, NOW);
      expect(await rolloutRow(rollout.id)).toMatchObject({ state: 'halted' });
      expect((await requestsOf(b))[0]).toMatchObject({
        state: 'failed',
        failure_detail: 'rollout halted',
      });
    });

    it('goes on past failures the plan allows', async () => {
      const [a, b] = take(2) as [string, string];
      const rollout = await approved(edgePlan({ waves: waves([a], [b]), maxFailures: 1 }));
      await rollouts.advanceTenant(TENANT_A, NOW);
      await conclude(a, { outcome: 'rejected', reason: 'signature-invalid' });
      await rollouts.advanceTenant(TENANT_A, NOW);
      expect(await requestsOf(b)).toHaveLength(1);
      await conclude(b);
      await rollouts.advanceTenant(TENANT_A, NOW);
      expect(await rolloutRow(rollout.id)).toMatchObject({ state: 'completed' });
      expect(await rollouts.progress(TENANT_A, rollout.id)).toMatchObject({ done: 1, failed: 1 });
    });

    it('counts a device that rolled its installed update back as failed', async () => {
      const [a, b] = take(2) as [string, string];
      const rollout = await approved(edgePlan({ waves: waves([a], [b]) }));
      await rollouts.advanceTenant(TENANT_A, NOW);
      await conclude(a, { seq: 500 });
      expect((await states(rollout.id))[id(a)]).toBe('done');
      await report(a, {
        seq: 501,
        kind: 'edge-rollback',
        outcome: 'failed',
        reason: 'health-window-failed',
        subject: { version: '1.7.0', security_version: 7 },
      });
      expect((await states(rollout.id))[id(a)]).toBe('failed');
      await rollouts.advanceTenant(TENANT_A, NOW);
      expect(await rolloutRow(rollout.id)).toMatchObject({ state: 'halted' });
      expect(await requestsOf(b)).toEqual([]);
    });

    it('a retryable refusal the reconciler will re-issue is still in flight, not a failure', async () => {
      const [a] = take(1) as [string];
      const rollout = await approved(edgePlan({ waves: waves([a]), maxFailures: 0 }));
      await rollouts.advanceTenant(TENANT_A, NOW);
      await conclude(a, { outcome: 'rejected', reason: 'maintenance-blocked' });
      expect((await requestsOf(a))[0]).toMatchObject({ state: 'retry' });
      expect((await states(rollout.id))[id(a)]).toBe('in-flight');
      await rollouts.advanceTenant(TENANT_A, NOW);
      expect((await rolloutRow(rollout.id))['state']).toBe('running');
    });

    it('two replicas advancing at once sign each device once', async () => {
      const group = take(6);
      const rollout = await approved(edgePlan({ waves: waves(group) }));
      await Promise.all([
        rollouts.advanceTenant(TENANT_A, NOW),
        rollouts.advanceTenant(TENANT_A, NOW),
        rollouts.advanceTenant(TENANT_A, NOW),
      ]);
      for (const code of group) {
        const mine = await requestsOf(code);
        expect(mine).toHaveLength(1);
        expect(Number(mine[0]?.['update_seq'])).toBe(1);
      }
      expect(await rollouts.progress(TENANT_A, rollout.id)).toMatchObject({
        queued: 0,
        inFlight: 6,
      });
    });

    it('a device the cloud can no longer sign for fails the rollout once, with the reason', async () => {
      const [a, b] = take(2) as [string, string];
      const rollout = await approved(edgePlan({ waves: waves([a, b]), maxFailures: 1 }));
      await admin.query(
        `UPDATE ${schemaA()}.edge_devices SET lifecycle_state = 'revoked' WHERE id = $1`,
        [id(a)],
      );
      const step = await rollouts.advanceTenant(TENANT_A, NOW);
      expect(step.refused).toBeGreaterThanOrEqual(1);
      expect(await requestsOf(a)).toEqual([]);
      expect(await requestsOf(b)).toHaveLength(1);
      const status = (await rollouts.devices(TENANT_A, rollout.id)).find(
        (d) => d.deviceId === id(a),
      );
      expect(status).toMatchObject({ phase: 'failed' });
      expect(status?.detail).toContain('cannot take an update statement');
      // Asked again, the refusal stands and is not recorded twice.
      expect((await rollouts.advanceTenant(TENANT_A, NOW)).refused).toBe(0);
    });

    it('a dependency that is only down leaves the device queued for the next tick', async () => {
      const [a] = take(1) as [string];
      const rollout = await approved(edgePlan({ waves: waves([a]) }));
      forVersion.mockRejectedValueOnce(new Error('connect ECONNREFUSED releases.example.com:443'));
      const down = await rollouts.advanceTenant(TENANT_A, NOW);
      expect(down.issued).toBe(0);
      expect((await states(rollout.id))[id(a)]).toBe('queued');
      expect((await rollouts.advanceTenant(TENANT_A, NOW)).issued).toBeGreaterThanOrEqual(1);
      expect((await states(rollout.id))[id(a)]).toBe('in-flight');
    });

    it('a window that opens later is the window of every statement of the rollout', async () => {
      const [a] = take(1) as [string];
      const opens = new Date('2026-10-21T01:00:00Z');
      await approved(edgePlan({ waves: waves([a]), windowNotBefore: opens, windowSeconds: 3600 }));
      await rollouts.advanceTenant(TENANT_A, NOW);
      const [row] = await requestsOf(a);
      expect(new Date(row?.['not_before']).getTime()).toBe(opens.getTime());
      expect(new Date(row?.['expires_at']).getTime()).toBe(opens.getTime() + 3600 * 1000);
    });

    it('rolls an OS bundle out as os-update statements', async () => {
      const [a] = take(1) as [string];
      const rollout = await approved(osPlan({ waves: waves([a]) }));
      await rollouts.advanceTenant(TENANT_A, NOW);
      const [row] = await requestsOf(a);
      expect(row).toMatchObject({ rollout_id: rollout.id, statement_type: 'suderra.os-update.v1' });
      await conclude(a, {}, 'suderra.os-update.v1');
      await rollouts.advanceTenant(TENANT_A, NOW);
      expect(await rolloutRow(rollout.id)).toMatchObject({ state: 'completed' });
    });

    it("advancing one tenant never touches another tenant's rollouts", async () => {
      const [a] = take(1) as [string];
      const rollout = await approved(edgePlan({ waves: waves([a]) }));
      await rollouts.advanceTenant(TENANT_B, NOW);
      expect(await requestsOf(a)).toEqual([]);
      expect((await rolloutRow(rollout.id))['state']).toBe('running');
    });
  });

  describe('cancelling', () => {
    it('ends the rollout and stops what no root has been handed', async () => {
      const [a, b, c] = take(3) as [string, string, string];
      const rollout = await approved(edgePlan({ waves: waves([a, b], [c]) }));
      await rollouts.advanceTenant(TENANT_A, NOW);
      // b's statement is already in root's spool.
      await requests.markHanded(
        { id: id(b), tenantId: TENANT_A },
        (await requestsOf(b))[0]?.['statement_digest'],
        NOW,
      );
      const ended = await rollouts.cancel(TENANT_A, 'user-2', rollout.id, 'wrong release');
      expect(ended).toMatchObject({
        state: 'cancelled',
        stateDetail: 'cancelled by user-2: wrong release',
      });
      expect((await requestsOf(a))[0]).toMatchObject({
        state: 'failed',
        failure_detail: 'rollout cancelled',
      });
      expect((await requestsOf(b))[0]).toMatchObject({ state: 'pending' });
      await rollouts.advanceTenant(TENANT_A, NOW);
      expect(await requestsOf(c)).toEqual([]);
    });

    it('cannot end a rollout that already ended', async () => {
      const [a] = take(1) as [string];
      const rollout = await approved(edgePlan({ waves: waves([a]) }));
      await rollouts.cancel(TENANT_A, 'user-2', rollout.id, 'x');
      await expect(rollouts.cancel(TENANT_A, 'user-2', rollout.id, 'y')).rejects.toThrow(
        /cancelled and cannot be cancelled/,
      );
    });
  });

  describe('reading', () => {
    it('lists a tenant’s rollouts, newest first, filtered by state, and only its own', async () => {
      const mine = await rollouts.list(TENANT_A);
      expect(mine.length).toBeGreaterThan(3);
      expect(mine[0]?.createdAt.getTime()).toBeGreaterThanOrEqual(
        mine[mine.length - 1]?.createdAt.getTime() ?? 0,
      );
      const cancelled = await rollouts.list(TENANT_A, 'cancelled' as never);
      expect(cancelled.every((r) => r.state === 'cancelled')).toBe(true);
      expect(await rollouts.list(TENANT_B)).toEqual([]);
      const one = mine[0];
      await expect(rollouts.get(TENANT_B, one?.id ?? '')).rejects.toThrow(/not found/);
    });
  });
});
