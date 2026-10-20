import { randomBytes } from 'node:crypto';

import { collaborator } from '@aquaculture/testing';
import { type DataSource } from 'typeorm';

import {
  bootSensorRlsHarness,
  type SensorRlsHarness,
} from '../../__tests__/support/sensor-rls-postgres.harness';
import { buildEnterMaintenance } from '../device-lifecycle-statement.service';
import {
  ActivationReceiptService,
  buildActivationReceipt,
  type CommittedActivation,
  type IssuedReceipt,
} from '../activation-receipt.service';
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
  HANDOFF_REDELIVERY_INTERVAL_MS,
  hashProvisioningToken,
  ProvisioningReservationService,
  type Reservation,
  storedStatementDigest,
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

  override issue(activation: CommittedActivation, signedAt: Date): IssuedReceipt {
    const at = contractTimestamp(activation.activatedAt);
    const expiresAt = new Date(signedAt.getTime() + 86_400_000);
    const statement = this.signer.sign(
      STATEMENT.activationReceipt,
      buildActivationReceipt({
        tenantId: activation.tenantId,
        deviceId: activation.deviceId,
        binding: activation.binding,
        manifestDigest: activation.manifestDigest,
        activationId: activation.activationId,
        activatedAt: at,
        notBefore: at,
        expiresAt: contractTimestamp(expiresAt),
      }),
    );
    return { statement, envelope: JSON.stringify(statement.envelope), expiresAt };
  }
}

/** Signs real lifecycle statements with a throwaway key. */
const lifecycleSigner = new ManifestSigner(
  Ed25519SigningKey.fromSeed('device-lifecycle', 1, randomBytes(32)),
);

const CODES = [
  'RES-FIRSTWIN',
  'RES-REFETCH',
  'RES-EXPIRY',
  'RES-REFUSE',
  'RES-ACTIVATE',
  'RES-GENERIC',
  'RES-COMMIT',
  'RES-RACE',
  'RES-REPROVISION',
  'RES-LAPSE',
  'RES-DELIVER',
  'RES-NOCRED',
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
              tokenIssuedAt: new Date('2026-10-20T11:00:00Z'),
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
      activationId: body['activation_id'],
      activatedAt: new Date('2026-10-20T12:05:00Z'),
      activationReceipt: commit?.activationReceipt,
      activationReceiptExpiresAt: new Date('2026-10-21T12:05:00Z'),
      activationReceiptHandedAt: null,
    });
    expect(provisioningPhaseOf(persisted, NOW)).toBe(ProvisioningPhase.COMMITTED);

    // Only the digest of the statement stored on the row settles it.
    expect(
      await reservations.settleHandoff(device('RES-COMMIT'), { sha256: 'f'.repeat(64) }, NOW),
    ).toBeNull();
    expect(
      await reservations.settleHandoff(
        device('RES-COMMIT'),
        storedStatementDigest(commit?.activationReceipt ?? ''),
        NOW,
      ),
    ).toBe('activation_receipt');
    expect((await row('RES-COMMIT')).activationReceiptHandedAt).toEqual(NOW);
    expect(await reservations.claimReceiptDelivery(device('RES-COMMIT'), NOW)).toBeNull();
  });

  it('commits nothing for a row that holds no issued credential, and activates nothing on an expired token', async () => {
    expect(await reservations.commitFirstSession(device('RES-NOCRED'), NOW)).toBeNull();
    expect((await row('RES-NOCRED')).tokenUsedAt).toBeNull();
    expect(
      await reservations.issueCredentials(
        device('RES-NOCRED'),
        token('RES-NOCRED'),
        { fingerprint: null, agentVersion: '1.6.0', mqttPasswordHash: 'late' },
        new Date('2026-10-21T00:00:00Z'),
      ),
    ).toBe(false);
    expect((await row('RES-NOCRED')).mqttPasswordHash).toBeNull();
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

  /** Reserve, activate, commit and hand the receipt to root: an ACTIVE Suderra OS device. */
  const activeOnRoot = async (code: Code, credential: string): Promise<void> => {
    await reservations.reserve(device(code), token(code), BINDING_A, TTL_MS, NOW, issue);
    await reservations.issueCredentials(
      device(code),
      token(code),
      { fingerprint: null, agentVersion: '1.6.0', mqttPasswordHash: credential },
      NOW,
    );
    const commit = await reservations.commitFirstSession(device(code), NOW);
    if (commit === null || commit.activationReceipt === null) throw new Error(`${code} commit`);
    await reservations.settleHandoff(
      device(code),
      storedStatementDigest(commit.activationReceipt),
      NOW,
    );
  };

  const WINDOW_END = new Date(NOW.getTime() + 2 * 60 * 60 * 1000);
  const reprovisionWindow = { notBefore: new Date(NOW.getTime() - 300_000), expiresAt: WINDOW_END };
  const signLifecycle =
    (code: Code) =>
    (updateSeq: number): SignedStatement<typeof STATEMENT.deviceLifecycle> =>
      lifecycleSigner.sign(
        STATEMENT.deviceLifecycle,
        buildEnterMaintenance({
          tenantId: TENANT,
          deviceId: device(code).id,
          binding: BINDING_A,
          updateSeq,
          notBefore: contractTimestamp(reprovisionWindow.notBefore),
          expiresAt: contractTimestamp(reprovisionWindow.expiresAt),
        }),
      );

  it('re-provisioning keeps the committed activation and credential, stores the statement, and only that binding may reserve', async () => {
    await activeOnRoot('RES-REPROVISION', 'running');
    const committed = await row('RES-REPROVISION');
    const fresh = 'e'.repeat(64);
    const started = await reservations.beginReprovisioning(
      device('RES-REPROVISION'),
      BINDING_A,
      hashProvisioningToken(fresh),
      reprovisionWindow,
      NOW,
      signLifecycle('RES-REPROVISION'),
    );
    expect(started).toEqual({
      lifecycleSeq: committed.edgeStatementSeq + 1,
      windowEndsAt: WINDOW_END,
    });
    const persisted = await row('RES-REPROVISION');
    expect(persisted).toMatchObject({
      lifecycleState: DeviceLifecycleState.MAINTENANCE,
      mqttPasswordHash: 'running',
      deviceBindingSha256: BINDING_A.digest.sha256,
      activationId: committed.activationId,
      activatedAt: committed.activatedAt,
      activationReceiptHandedAt: committed.activationReceiptHandedAt,
      provisioningToken: hashProvisioningToken(fresh),
      tokenIssuedAt: NOW,
      tokenExpiresAt: WINDOW_END,
      tokenUsedAt: null,
      maintenanceExpiresAt: WINDOW_END,
      lifecycleRequestHandedAt: null,
    });
    expect(provisioningPhaseOf(persisted, NOW)).toBe(ProvisioningPhase.TOKEN_ISSUED);

    // A second window cannot open over this one.
    expect(
      await reservations.beginReprovisioning(
        device('RES-REPROVISION'),
        BINDING_A,
        hashProvisioningToken('d'.repeat(64)),
        reprovisionWindow,
        NOW,
        signLifecycle('RES-REPROVISION'),
      ),
    ).toBe('window-open');
    // Nor can a token reissue revoke the committed device.
    expect(
      await reservations.reissueToken(device('RES-REPROVISION'), {
        tokenHash: hashProvisioningToken('c'.repeat(64)),
        tokenIssuedAt: NOW,
        tokenExpiresAt: WINDOW_END,
        lifecycleState: DeviceLifecycleState.REGISTERED,
      }),
    ).toBe(false);
    expect((await row('RES-REPROVISION')).mqttPasswordHash).toBe('running');

    // The statement is delivered, paced, and settled by its digest.
    const statement = await reservations.claimLifecycleDelivery(device('RES-REPROVISION'), NOW);
    expect(statement).toBe(persisted.lifecycleRequest);
    expect(
      await reservations.claimLifecycleDelivery(
        device('RES-REPROVISION'),
        new Date(NOW.getTime() + HANDOFF_REDELIVERY_INTERVAL_MS - 1000),
      ),
    ).toBeNull();
    expect(
      await reservations.claimLifecycleDelivery(
        device('RES-REPROVISION'),
        new Date(NOW.getTime() + HANDOFF_REDELIVERY_INTERVAL_MS),
      ),
    ).toBe(statement);
    expect(
      await reservations.settleHandoff(
        device('RES-REPROVISION'),
        storedStatementDigest(statement ?? ''),
        NOW,
      ),
    ).toBe('lifecycle_request');
    expect(
      await reservations.claimLifecycleDelivery(device('RES-REPROVISION'), WINDOW_END),
    ).toBeNull();

    expect(
      await reservations.reserve(device('RES-REPROVISION'), fresh, BINDING_B, TTL_MS, NOW, issue),
    ).toBeNull();
    expect(
      await reservations.reserve(device('RES-REPROVISION'), fresh, BINDING_A, TTL_MS, NOW, issue),
    ).toMatchObject({ manifestSeq: committed.edgeStatementSeq + 2 });

    // The new activation commits: a new activation, the window closed.
    await reservations.issueCredentials(
      device('RES-REPROVISION'),
      fresh,
      { fingerprint: null, agentVersion: '1.6.1', mqttPasswordHash: 'reinstalled' },
      NOW,
    );
    const recommit = await reservations.commitFirstSession(device('RES-REPROVISION'), NOW);
    expect(recommit?.activationReceipt).not.toBeNull();
    const after = await row('RES-REPROVISION');
    expect(after.activationId).not.toBe(committed.activationId);
    expect(after).toMatchObject({
      lifecycleState: DeviceLifecycleState.ACTIVE,
      mqttPasswordHash: 'reinstalled',
      lifecycleRequest: null,
      maintenanceExpiresAt: null,
      activationReceiptHandedAt: null,
    });
  });

  it('an abandoned window lapses back to ACTIVE: the token dies, the activation and credential stay', async () => {
    await activeOnRoot('RES-LAPSE', 'running');
    const committed = await row('RES-LAPSE');
    await reservations.beginReprovisioning(
      device('RES-LAPSE'),
      BINDING_A,
      hashProvisioningToken('9'.repeat(64)),
      reprovisionWindow,
      NOW,
      signLifecycle('RES-LAPSE'),
    );
    // Still open: nothing to close.
    expect(
      await reservations.settleLapsedMaintenance(
        device('RES-LAPSE'),
        new Date(WINDOW_END.getTime() - 1000),
      ),
    ).toBe(false);
    expect(await reservations.settleLapsedMaintenance(device('RES-LAPSE'), WINDOW_END)).toBe(true);
    const lapsed = await row('RES-LAPSE');
    expect(lapsed).toMatchObject({
      lifecycleState: DeviceLifecycleState.ACTIVE,
      provisioningToken: null,
      tokenIssuedAt: null,
      lifecycleRequest: null,
      maintenanceExpiresAt: null,
      mqttPasswordHash: 'running',
      activationId: committed.activationId,
      deviceBindingSha256: BINDING_A.digest.sha256,
    });
    // The regenerate path cannot revoke it, and a fresh window opens again.
    expect(
      await reservations.reissueToken(device('RES-LAPSE'), {
        tokenHash: hashProvisioningToken('8'.repeat(64)),
        tokenIssuedAt: WINDOW_END,
        tokenExpiresAt: new Date(WINDOW_END.getTime() + 86_400_000),
        lifecycleState: lapsed.lifecycleState,
      }),
    ).toBe(false);
    expect((await row('RES-LAPSE')).mqttPasswordHash).toBe('running');
    expect(
      await reservations.beginReprovisioning(
        device('RES-LAPSE'),
        BINDING_A,
        hashProvisioningToken('7'.repeat(64)),
        { notBefore: WINDOW_END, expiresAt: new Date(WINDOW_END.getTime() + 7_200_000) },
        WINDOW_END,
        signLifecycle('RES-LAPSE'),
      ),
    ).toMatchObject({ lifecycleSeq: committed.edgeStatementSeq + 2 });
  });

  it('a pending receipt is delivered paced, re-signed under the same activation near its expiry, and settled only by its current digest', async () => {
    await reservations.reserve(
      device('RES-DELIVER'),
      token('RES-DELIVER'),
      BINDING_A,
      TTL_MS,
      NOW,
      issue,
    );
    await reservations.issueCredentials(
      device('RES-DELIVER'),
      token('RES-DELIVER'),
      { fingerprint: null, agentVersion: '1.6.0', mqttPasswordHash: 'hash' },
      NOW,
    );
    const commit = await reservations.commitFirstSession(device('RES-DELIVER'), NOW);
    const first = commit?.activationReceipt ?? null;
    expect(await reservations.claimReceiptDelivery(device('RES-DELIVER'), NOW)).toBe(first);
    // The first delivery was lost: nothing again within the pace, then the same bytes.
    expect(
      await reservations.claimReceiptDelivery(
        device('RES-DELIVER'),
        new Date(NOW.getTime() + 60_000),
      ),
    ).toBeNull();
    const later = new Date(NOW.getTime() + HANDOFF_REDELIVERY_INTERVAL_MS);
    expect(await reservations.claimReceiptDelivery(device('RES-DELIVER'), later)).toBe(first);

    // Thirteen hours on, less than the margin is left: re-signed.
    const nearExpiry = new Date(NOW.getTime() + 13 * 60 * 60 * 1000);
    const resigned = await reservations.claimReceiptDelivery(device('RES-DELIVER'), nearExpiry);
    expect(resigned).not.toBeNull();
    expect(resigned).not.toBe(first);
    const bodyOf = (envelope: string | null): Record<string, unknown> =>
      JSON.parse(
        Buffer.from(
          (JSON.parse(envelope ?? 'null') as { payload: string }).payload,
          'base64',
        ).toString('utf8'),
      ) as Record<string, unknown>;
    const { expires_at: oldUntil, ...oldRest } = bodyOf(first);
    const { expires_at: newUntil, ...newRest } = bodyOf(resigned);
    expect(newRest).toEqual(oldRest);
    expect([oldUntil, newUntil]).toEqual(['2026-10-21T12:00:00Z', '2026-10-22T01:00:00Z']);
    expect((await row('RES-DELIVER')).activationReceiptExpiresAt).toEqual(
      new Date('2026-10-22T01:00:00Z'),
    );

    // The agent reports the superseded receipt: nothing settles; the current one does.
    expect(
      await reservations.settleHandoff(
        device('RES-DELIVER'),
        storedStatementDigest(first ?? ''),
        nearExpiry,
      ),
    ).toBeNull();
    expect(
      await reservations.settleHandoff(
        device('RES-DELIVER'),
        storedStatementDigest(resigned ?? ''),
        nearExpiry,
      ),
    ).toBe('activation_receipt');
    expect(
      await reservations.claimReceiptDelivery(
        device('RES-DELIVER'),
        new Date(nearExpiry.getTime() + 600_000),
      ),
    ).toBeNull();
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
