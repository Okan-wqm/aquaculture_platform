import { randomBytes } from 'node:crypto';

import { collaborator } from '@aquaculture/testing';
import { type DataSource } from 'typeorm';

import {
  bootSensorRlsHarness,
  type SensorRlsHarness,
} from '../../__tests__/support/sensor-rls-postgres.harness';
import { ActivationReceiptService, buildActivationReceipt } from '../activation-receipt.service';
import {
  contractTimestamp,
  type DeviceBinding,
  type SignedStatement,
  STATEMENT,
} from '../edge-contract';
import {
  DeviceLifecycleState,
  DeviceModel,
  EdgeAgentChannel,
  EdgeDevice,
  provisioningPhaseOf,
  ProvisioningPhase,
} from '../entities/edge-device.entity';
import { Ed25519SigningKey, ManifestSigner } from '../manifest-signer';
import {
  hashProvisioningToken,
  ProvisioningReservationService,
  type Reservation,
} from '../provisioning-reservation.service';
import { type SuderraEdgeConfig } from '../suderra-edge.config';

/**
 * The two-phase provisioning token on real Postgres (ADR-048 DEC-5.7, DEC-5.8):
 * every transition is one conditional UPDATE … RETURNING under the runtime
 * role and FORCE RLS, so the guards are proven by the database that enforces
 * them — first binding wins, a re-fetch by the same binding is idempotent,
 * activation issues without spending the token, the first authenticated
 * session commits exactly once, and racing requests cannot both pass a guard.
 */

const TENANT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TTL_MS = 30 * 60 * 1000;
const NOW = new Date('2026-10-20T12:00:00Z');
const BINDING_A: DeviceBinding = { method: 'tpm-ek-sha256', digest: { sha256: 'a1'.repeat(32) } };
const BINDING_B: DeviceBinding = { method: 'tpm-ek-sha256', digest: { sha256: 'b2'.repeat(32) } };
const token = (code: string): string => hashProvisioningToken(code).slice(0, 64);

/** Signs real receipts with a throwaway key; the transition logic is what is under test. */
class ThrowawayReceipts extends ActivationReceiptService {
  private readonly signer = new ManifestSigner(
    Ed25519SigningKey.fromSeed('edge-provisioning', 1, randomBytes(32)),
  );

  constructor() {
    super(collaborator<SuderraEdgeConfig>({}, 'SuderraEdgeConfig'));
  }

  override issue(
    commit: Parameters<ActivationReceiptService['issue']>[0],
  ): SignedStatement<typeof STATEMENT.activationReceipt> {
    const at = contractTimestamp(commit.activatedAt);
    return this.signer.sign(
      STATEMENT.activationReceipt,
      buildActivationReceipt({
        tenantId: commit.tenantId,
        deviceId: commit.deviceId,
        binding: commit.binding,
        manifestDigest: commit.manifestDigest,
        activationId: commit.activationId,
        activatedAt: at,
        notBefore: at,
        expiresAt: contractTimestamp(new Date(commit.activatedAt.getTime() + 86_400_000)),
      }),
    );
  }
}

const CODES = [
  'RES-FIRSTWIN',
  'RES-REFETCH',
  'RES-EXPIRY',
  'RES-REFUSE',
  'RES-ACTIVATE',
  'RES-GENERIC',
  'RES-COMMIT',
  'RES-RACE',
  'RES-REISSUE',
  'RES-SPENT',
] as const;
type Code = (typeof CODES)[number];

describe('two-phase provisioning token on real Postgres (ADR-048 DEC-5.7)', () => {
  let stage: SensorRlsHarness | undefined;
  let admin: DataSource;
  let schema: string;
  let reservations: ProvisioningReservationService;
  const stageOrFail = (): SensorRlsHarness => {
    if (stage === undefined) throw new Error('harness not booted');
    return stage;
  };
  const ids = new Map<Code, string>();

  const device = (code: Code): Pick<EdgeDevice, 'id' | 'tenantId'> => {
    const id = ids.get(code);
    if (id === undefined) throw new Error(`no device ${code}`);
    return { id, tenantId: TENANT };
  };

  /** The row as the owner sees it, mapped onto the entity's properties. */
  const row = async (code: Code): Promise<EdgeDevice> => {
    const [raw] = (await admin.query(`SELECT * FROM ${schema}.edge_devices WHERE id = $1`, [
      device(code).id,
    ])) as Array<Record<string, unknown>>;
    if (raw === undefined) throw new Error(`row ${code} vanished`);
    const entity = new EdgeDevice();
    for (const column of stageOrFail().runtime.getMetadata(EdgeDevice).columns) {
      const value = raw[column.databaseName];
      const transformer = column.transformer;
      column.setEntityValue(
        entity,
        transformer !== undefined && !Array.isArray(transformer) ? transformer.from(value) : value,
      );
    }
    return entity;
  };

  const issue = (
    reservation: Reservation,
  ): { result: Reservation; manifestDigest: { sha256: string } } => ({
    result: reservation,
    manifestDigest: { sha256: `${reservation.manifestSeq}`.padStart(64, '0') },
  });

  beforeAll(async () => {
    stage = await bootSensorRlsHarness({
      name: 'provisioning_reservation',
      tenants: [TENANT],
      entities: [EdgeDevice],
      beforeRls: async ({ ddl, tenantId }) => {
        for (const code of CODES) {
          const saved = await ddl.manager.save(
            ddl.manager.create(EdgeDevice, {
              tenantId,
              deviceCode: code,
              deviceName: code,
              deviceModel: DeviceModel.REVOLUTION_PI_CONNECT_4,
              lifecycleState: DeviceLifecycleState.REGISTERED,
              mqttClientId: `edge-cccccccc-${code.toLowerCase()}`,
              provisioningToken: hashProvisioningToken(token(code)),
              tokenExpiresAt: new Date('2026-10-21T00:00:00Z'),
              isOnline: false,
            }),
          );
          ids.set(code, saved.id);
        }
      },
    });
    admin = stage.admin;
    schema = stage.schemaOf(TENANT);
    reservations = new ProvisioningReservationService(stage.runtime, new ThrowawayReceipts());
  });

  afterAll(async () => {
    await stage?.shutdown();
  });

  it('the first binding to present the token reserves it; another binding is refused while it holds', async () => {
    const first = await reservations.reserve(
      device('RES-FIRSTWIN'),
      token('RES-FIRSTWIN'),
      BINDING_A,
      TTL_MS,
      NOW,
      issue,
    );
    expect(first).toMatchObject({
      manifestSeq: 1,
      siteConfigSeq: 2,
      binding: BINDING_A,
      deviceCode: 'RES-FIRSTWIN',
    });
    expect(first?.window.expiresAt).toEqual(new Date(NOW.getTime() + TTL_MS));

    const other = await reservations.reserve(
      device('RES-FIRSTWIN'),
      token('RES-FIRSTWIN'),
      BINDING_B,
      TTL_MS,
      NOW,
      issue,
    );
    expect(other).toBeNull();

    const persisted = await row('RES-FIRSTWIN');
    expect(persisted).toMatchObject({
      agentChannel: EdgeAgentChannel.SUDERRA_OS,
      reservedBindingSha256: BINDING_A.digest.sha256,
      issuedManifestSha256: '1'.padStart(64, '0'),
      edgeStatementSeq: 2,
    });
    expect(provisioningPhaseOf(persisted, NOW)).toBe(ProvisioningPhase.MANIFEST_RESERVED);
  });

  it('the same binding re-fetches under fresh, higher sequences', async () => {
    await reservations.reserve(
      device('RES-REFETCH'),
      token('RES-REFETCH'),
      BINDING_A,
      TTL_MS,
      NOW,
      issue,
    );
    const again = await reservations.reserve(
      device('RES-REFETCH'),
      token('RES-REFETCH'),
      BINDING_A,
      TTL_MS,
      NOW,
      issue,
    );
    expect(again).toMatchObject({ manifestSeq: 3, siteConfigSeq: 4 });
    expect((await row('RES-REFETCH')).issuedManifestSha256).toBe('3'.padStart(64, '0'));
  });

  it('a lapsed reservation without issued credentials frees the token for another binding', async () => {
    await reservations.reserve(
      device('RES-EXPIRY'),
      token('RES-EXPIRY'),
      BINDING_A,
      TTL_MS,
      NOW,
      issue,
    );
    const later = new Date(NOW.getTime() + TTL_MS + 1000);
    const taken = await reservations.reserve(
      device('RES-EXPIRY'),
      token('RES-EXPIRY'),
      BINDING_B,
      TTL_MS,
      later,
      issue,
    );
    expect(taken).toMatchObject({ binding: BINDING_B });
  });

  it('refuses a wrong token, an expired token and a terminal device', async () => {
    expect(
      await reservations.reserve(
        device('RES-REFUSE'),
        'f'.repeat(64),
        BINDING_A,
        TTL_MS,
        NOW,
        issue,
      ),
    ).toBeNull();
    expect(
      await reservations.reserve(
        device('RES-REFUSE'),
        token('RES-REFUSE'),
        BINDING_A,
        TTL_MS,
        new Date('2026-10-22T00:00:00Z'),
        issue,
      ),
    ).toBeNull();
    await admin.query(
      `UPDATE ${schema}.edge_devices SET lifecycle_state = 'revoked' WHERE id = $1`,
      [device('RES-REFUSE').id],
    );
    expect(
      await reservations.reserve(
        device('RES-REFUSE'),
        token('RES-REFUSE'),
        BINDING_A,
        TTL_MS,
        NOW,
        issue,
      ),
    ).toBeNull();
  });

  it('a Suderra OS device activates only under its reservation, repeatably, without spending the token', async () => {
    const credentials = { fingerprint: null, agentVersion: '1.6.0', mqttPasswordHash: 'hash-1' };
    // Not reserved yet, but already on the Suderra OS channel: refused.
    await admin.query(
      `UPDATE ${schema}.edge_devices SET agent_channel = 'suderra_os' WHERE id = $1`,
      [device('RES-ACTIVATE').id],
    );
    expect(
      await reservations.issueCredentials(
        device('RES-ACTIVATE'),
        token('RES-ACTIVATE'),
        credentials,
        NOW,
      ),
    ).toBe(false);

    await reservations.reserve(
      device('RES-ACTIVATE'),
      token('RES-ACTIVATE'),
      BINDING_A,
      TTL_MS,
      NOW,
      issue,
    );
    expect(
      await reservations.issueCredentials(
        device('RES-ACTIVATE'),
        token('RES-ACTIVATE'),
        credentials,
        NOW,
      ),
    ).toBe(true);
    // Re-issued after the reservation lapsed: credentials already pending.
    const later = new Date(NOW.getTime() + TTL_MS + 1000);
    expect(
      await reservations.issueCredentials(
        device('RES-ACTIVATE'),
        token('RES-ACTIVATE'),
        { ...credentials, mqttPasswordHash: 'hash-2' },
        later,
      ),
    ).toBe(true);

    const persisted = await row('RES-ACTIVATE');
    expect(persisted.tokenUsedAt).toBeNull();
    expect(persisted.provisioningToken).toBe(hashProvisioningToken(token('RES-ACTIVATE')));
    expect(persisted.mqttPasswordHash).toBe('hash-2');
    expect(persisted.lifecycleState).toBe(DeviceLifecycleState.ACTIVE);
    expect(provisioningPhaseOf(persisted, later)).toBe(ProvisioningPhase.ACTIVATION_PENDING);
  });

  it('a generic-Linux device activates straight from TOKEN_ISSUED and commits without a receipt', async () => {
    const credentials = {
      fingerprint: { hostname: 'pond' },
      agentVersion: '1.6.0',
      mqttPasswordHash: 'hash',
    };
    expect(
      await reservations.issueCredentials(
        device('RES-GENERIC'),
        token('RES-GENERIC'),
        credentials,
        NOW,
      ),
    ).toBe(true);
    const commit = await reservations.commitFirstSession(device('RES-GENERIC'), NOW);
    expect(commit).toEqual({
      tenantId: TENANT,
      deviceId: device('RES-GENERIC').id,
      channel: EdgeAgentChannel.GENERIC_LINUX,
      activationReceipt: null,
    });
    const persisted = await row('RES-GENERIC');
    expect(persisted.provisioningToken).toBeNull();
    expect(persisted.tokenUsedAt).toEqual(NOW);
    expect(persisted.fingerprint).toEqual({ hostname: 'pond' });
  });

  it('the first session commits once: the token is spent, the binding becomes the identity, the receipt names the manifest', async () => {
    await reservations.reserve(
      device('RES-COMMIT'),
      token('RES-COMMIT'),
      BINDING_A,
      TTL_MS,
      NOW,
      issue,
    );
    await reservations.issueCredentials(
      device('RES-COMMIT'),
      token('RES-COMMIT'),
      { fingerprint: null, agentVersion: '1.6.0', mqttPasswordHash: 'hash' },
      NOW,
    );
    const commit = await reservations.commitFirstSession(
      device('RES-COMMIT'),
      new Date('2026-10-20T12:05:00.700Z'),
    );
    expect(commit?.channel).toBe(EdgeAgentChannel.SUDERRA_OS);
    const receipt = JSON.parse(commit?.activationReceipt ?? 'null') as { payload: string };
    const body = JSON.parse(Buffer.from(receipt.payload, 'base64').toString('utf8')) as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({
      _type: STATEMENT.activationReceipt,
      tenant_id: TENANT,
      device_id: device('RES-COMMIT').id,
      device_binding: BINDING_A,
      manifest_digest: { sha256: '1'.padStart(64, '0') },
      activated_at: '2026-10-20T12:05:00Z',
    });

    expect(await reservations.commitFirstSession(device('RES-COMMIT'), NOW)).toBeNull();
    const persisted = await row('RES-COMMIT');
    expect(persisted).toMatchObject({
      provisioningToken: null,
      deviceBindingMethod: BINDING_A.method,
      deviceBindingSha256: BINDING_A.digest.sha256,
      reservedBindingSha256: null,
      activationReceiptHandedAt: null,
    });
    expect(provisioningPhaseOf(persisted, NOW)).toBe(ProvisioningPhase.COMMITTED);

    await reservations.markReceiptHanded(device('RES-COMMIT'), NOW);
    expect((await row('RES-COMMIT')).activationReceiptHandedAt).toEqual(NOW);
  });

  it('racing requests cannot both pass a guard: one reservation and one commit win', async () => {
    const reserved = await Promise.all([
      reservations.reserve(device('RES-RACE'), token('RES-RACE'), BINDING_A, TTL_MS, NOW, issue),
      reservations.reserve(device('RES-RACE'), token('RES-RACE'), BINDING_B, TTL_MS, NOW, issue),
    ]);
    expect(reserved.filter((r) => r !== null)).toHaveLength(1);
    const winner = reserved.find((r) => r !== null);
    await reservations.issueCredentials(
      device('RES-RACE'),
      token('RES-RACE'),
      { fingerprint: null, agentVersion: '1.6.0', mqttPasswordHash: 'hash' },
      NOW,
    );
    const commits = await Promise.all([
      reservations.commitFirstSession(device('RES-RACE'), NOW),
      reservations.commitFirstSession(device('RES-RACE'), NOW),
    ]);
    expect(commits.filter((c) => c !== null)).toHaveLength(1);
    expect((await row('RES-RACE')).deviceBindingSha256).toBe(winner?.binding.digest.sha256);
  });

  it('re-provisioning re-issues the token, keeps the identity and the running credential, and only that binding may reserve', async () => {
    await reservations.reserve(
      device('RES-REISSUE'),
      token('RES-REISSUE'),
      BINDING_A,
      TTL_MS,
      NOW,
      issue,
    );
    await reservations.issueCredentials(
      device('RES-REISSUE'),
      token('RES-REISSUE'),
      { fingerprint: null, agentVersion: '1.6.0', mqttPasswordHash: 'running' },
      NOW,
    );
    await reservations.commitFirstSession(device('RES-REISSUE'), NOW);
    const seqBefore = (await row('RES-REISSUE')).edgeStatementSeq;

    const fresh = 'e'.repeat(64);
    const reissued = await reservations.reissueToken(device('RES-REISSUE'), {
      tokenHash: hashProvisioningToken(fresh),
      tokenExpiresAt: new Date('2026-10-21T00:00:00Z'),
      lifecycleState: DeviceLifecycleState.MAINTENANCE,
      revokeCredentials: false,
    });
    expect(reissued).toEqual({ lifecycleSeq: seqBefore + 1 });
    const persisted = await row('RES-REISSUE');
    expect(persisted).toMatchObject({
      mqttPasswordHash: 'running',
      deviceBindingSha256: BINDING_A.digest.sha256,
      activationReceipt: null,
      lifecycleState: DeviceLifecycleState.MAINTENANCE,
    });
    expect(provisioningPhaseOf(persisted, NOW)).toBe(ProvisioningPhase.TOKEN_ISSUED);

    expect(
      await reservations.reserve(device('RES-REISSUE'), fresh, BINDING_B, TTL_MS, NOW, issue),
    ).toBeNull();
    expect(
      await reservations.reserve(device('RES-REISSUE'), fresh, BINDING_A, TTL_MS, NOW, issue),
    ).toMatchObject({
      manifestSeq: seqBefore + 2,
    });
  });

  it('a spent token reserves nothing and activates nothing', async () => {
    await reservations.issueCredentials(
      device('RES-SPENT'),
      token('RES-SPENT'),
      { fingerprint: null, agentVersion: '1.6.0', mqttPasswordHash: 'hash' },
      NOW,
    );
    await reservations.commitFirstSession(device('RES-SPENT'), NOW);
    expect(
      await reservations.reserve(
        device('RES-SPENT'),
        token('RES-SPENT'),
        BINDING_A,
        TTL_MS,
        NOW,
        issue,
      ),
    ).toBeNull();
    expect(
      await reservations.issueCredentials(
        device('RES-SPENT'),
        token('RES-SPENT'),
        { fingerprint: null, agentVersion: '1.6.0', mqttPasswordHash: 'other' },
        NOW,
      ),
    ).toBe(false);
  });
});
