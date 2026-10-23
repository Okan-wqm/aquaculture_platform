import { randomBytes } from 'node:crypto';

import { collaborator } from '@aquaculture/testing';
import { ConfigService } from '@nestjs/config';
import { type DataSource } from 'typeorm';

import {
  bootSensorRlsHarness,
  type SensorRlsHarness,
} from '../../__tests__/support/sensor-rls-postgres.harness';
import { DeviceDirectoryService } from '../device-directory.service';
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
import { EdgeDeviceDirectory } from '../entities/edge-device-directory.entity';
import {
  DeviceLifecycleState,
  DeviceModel,
  EdgeAgentChannel,
  EdgeDevice,
  provisioningPhaseOf,
  ProvisioningPhase,
} from '../entities/edge-device.entity';
import { Ed25519SigningKey, ManifestSigner } from '../manifest-signer';
import { MqttAuthService } from '../mqtt-auth.service';
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
/** The broker username the fixtures give a device. */
const clientIdOf = (code: string): string => `edge-cccccccc-${code.toLowerCase()}`;

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
  'RES-CHANNEL',
  'RES-SPENT',
  'RES-KEEP',
  'RES-ABANDON',
  'RES-CHECK',
  'RES-REVOKE',
  'RES-BROKER-KEEP',
  'RES-BROKER-LOST',
] as const;
type Code = (typeof CODES)[number];

describe('two-phase provisioning token on real Postgres (ADR-048 DEC-5.7)', () => {
  let stage: SensorRlsHarness | undefined;
  let admin: DataSource;
  let schema: string;
  let reservations: ProvisioningReservationService;
  let auth: MqttAuthService;
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
      // The broker's lookup of a device by its client id goes through the directory.
      sourceEntities: [EdgeDeviceDirectory],
      beforeRls: async ({ ddl, tenantId }) => {
        for (const code of CODES) {
          const saved = await ddl.manager.save(
            ddl.manager.create(EdgeDevice, {
              tenantId,
              deviceCode: code,
              deviceName: code,
              deviceModel: DeviceModel.REVOLUTION_PI_CONNECT_4,
              lifecycleState: DeviceLifecycleState.REGISTERED,
              mqttClientId: clientIdOf(code),
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
    for (const code of CODES) {
      await admin.query(
        `INSERT INTO sensor.edge_device_directory (device_id, device_code, mqtt_client_id, tenant_id)
         VALUES ($1, $2, $3, $4)`,
        [device(code).id, code, clientIdOf(code), TENANT],
      );
    }
    auth = new MqttAuthService(
      new ConfigService({ NODE_ENV: 'production', MQTT_AUTH_MODE: 'http' }),
      new DeviceDirectoryService(stage.runtime),
      reservations,
    );
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
    // Nothing was committed before, so there is no credential to keep.
    expect(persisted.previousMqttPasswordHash).toBeNull();
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
    const commit = await reservations.commitFirstSession(device('RES-GENERIC'), NOW, 'hash');
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
      'hash',
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

    expect(await reservations.commitFirstSession(device('RES-COMMIT'), NOW, 'hash')).toBeNull();
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
    expect(await reservations.commitFirstSession(device('RES-NOCRED'), NOW, 'unissued')).toBeNull();
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
      reservations.commitFirstSession(device('RES-RACE'), NOW, 'hash'),
      reservations.commitFirstSession(device('RES-RACE'), NOW, 'hash'),
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
    const commit = await reservations.commitFirstSession(device(code), NOW, credential);
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
    // The running agent's credential is kept beside the issued one until it commits.
    expect(await row('RES-REPROVISION')).toMatchObject({
      mqttPasswordHash: 'reinstalled',
      previousMqttPasswordHash: 'running',
    });
    const recommit = await reservations.commitFirstSession(
      device('RES-REPROVISION'),
      NOW,
      'reinstalled',
    );
    expect(recommit?.activationReceipt).not.toBeNull();
    const after = await row('RES-REPROVISION');
    expect(after.activationId).not.toBe(committed.activationId);
    expect(after).toMatchObject({
      lifecycleState: DeviceLifecycleState.ACTIVE,
      mqttPasswordHash: 'reinstalled',
      previousMqttPasswordHash: null,
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

  /** An ACTIVE Suderra OS device with a re-provisioning window open and the reinstall reserved. */
  const reinstalling = async (code: Code, running: string, window = reprovisionWindow) => {
    await activeOnRoot(code, running);
    const fresh = hashProvisioningToken(`${code}-window`).slice(0, 64);
    await reservations.beginReprovisioning(
      device(code),
      BINDING_A,
      hashProvisioningToken(fresh),
      window,
      NOW,
      signLifecycle(code),
    );
    await reservations.reserve(device(code), fresh, BINDING_A, TTL_MS, NOW, issue);
    return {
      activate: (credential: string): Promise<boolean> =>
        reservations.issueCredentials(
          device(code),
          fresh,
          { fingerprint: null, agentVersion: '1.6.1', mqttPasswordHash: credential },
          NOW,
        ),
    };
  };

  it('an activation issued during re-provisioning keeps the running credential until the new one commits (SENSOR-MEDIUM-236)', async () => {
    const reinstall = await reinstalling('RES-KEEP', 'running');

    expect(await reinstall.activate('reinstalled-1')).toBe(true);
    const issued = await row('RES-KEEP');
    expect(issued).toMatchObject({
      mqttPasswordHash: 'reinstalled-1',
      previousMqttPasswordHash: 'running',
      tokenUsedAt: null,
    });
    expect(provisioningPhaseOf(issued, NOW)).toBe(ProvisioningPhase.ACTIVATION_PENDING);

    // The agent lost the response and activated again: only the pending
    // credential is replaced, the running one is still the one kept.
    expect(await reinstall.activate('reinstalled-2')).toBe(true);
    expect(await row('RES-KEEP')).toMatchObject({
      mqttPasswordHash: 'reinstalled-2',
      previousMqttPasswordHash: 'running',
    });

    // A CONNECT is committed only by the credential it proved: the superseded
    // one and the running agent's spend nothing.
    expect(
      await reservations.commitFirstSession(device('RES-KEEP'), NOW, 'reinstalled-1'),
    ).toBeNull();
    expect(await reservations.commitFirstSession(device('RES-KEEP'), NOW, 'running')).toBeNull();
    expect(await row('RES-KEEP')).toMatchObject({
      tokenUsedAt: null,
      mqttPasswordHash: 'reinstalled-2',
      previousMqttPasswordHash: 'running',
    });

    const commit = await reservations.commitFirstSession(device('RES-KEEP'), NOW, 'reinstalled-2');
    expect(commit?.activationReceipt).not.toBeNull();
    expect(await row('RES-KEEP')).toMatchObject({
      tokenUsedAt: NOW,
      mqttPasswordHash: 'reinstalled-2',
      previousMqttPasswordHash: null,
    });
  });

  it('a reinstall that never connects leaves the running credential in place, and a new window drops the uncommitted one', async () => {
    const reinstall = await reinstalling('RES-ABANDON', 'running');
    await reinstall.activate('lost');
    // Credentials were issued under this window's token: there is nothing to
    // settle as lapsed, and the running credential is still kept beside them.
    expect(await reservations.settleLapsedMaintenance(device('RES-ABANDON'), WINDOW_END)).toBe(
      false,
    );
    expect(await row('RES-ABANDON')).toMatchObject({
      mqttPasswordHash: 'lost',
      previousMqttPasswordHash: 'running',
    });

    const second = { notBefore: WINDOW_END, expiresAt: new Date(WINDOW_END.getTime() + 7_200_000) };
    expect(
      await reservations.beginReprovisioning(
        device('RES-ABANDON'),
        BINDING_A,
        hashProvisioningToken('6'.repeat(64)),
        second,
        WINDOW_END,
        signLifecycle('RES-ABANDON'),
      ),
    ).toMatchObject({ windowEndsAt: second.expiresAt });
    const reopened = await row('RES-ABANDON');
    expect(reopened).toMatchObject({
      mqttPasswordHash: 'running',
      previousMqttPasswordHash: null,
      credentialsIssuedAt: null,
      tokenUsedAt: null,
    });
    // The credential of the abandoned window commits nothing any more.
    expect(
      await reservations.commitFirstSession(device('RES-ABANDON'), WINDOW_END, 'lost'),
    ).toBeNull();
  });

  it('the row cannot hold a previous credential outside a pending activation', async () => {
    const id = device('RES-CHECK').id;
    const set = (assignments: string): Promise<unknown> =>
      admin.query(`UPDATE ${schema}.edge_devices SET ${assignments} WHERE id = $1`, [id]);
    // No credential issued under a token: nothing is pending.
    await expect(
      set(`mqtt_password_hash = 'a', previous_mqtt_password_hash = 'b'`),
    ).rejects.toThrow(/CHK_edge_devices_previous_credential/);
    // A previous credential without a current one.
    await expect(
      set(`credentials_issued_at = now(), previous_mqtt_password_hash = 'b'`),
    ).rejects.toThrow(/CHK_edge_devices_previous_credential/);
    // The token already spent: the activation is committed.
    await expect(
      set(
        `mqtt_password_hash = 'a', credentials_issued_at = now(), token_used_at = now(), previous_mqtt_password_hash = 'b'`,
      ),
    ).rejects.toThrow(/CHK_edge_devices_previous_credential/);
    // A pending activation may carry one.
    await set(
      `mqtt_password_hash = 'a', credentials_issued_at = now(), previous_mqtt_password_hash = 'b'`,
    );
    // And committing without retiring it is refused by the same check.
    await expect(set(`token_used_at = now()`)).rejects.toThrow(
      /CHK_edge_devices_previous_credential/,
    );
  });

  it('a from-scratch reissue revokes both credentials', async () => {
    await admin.query(
      `UPDATE ${schema}.edge_devices
          SET mqtt_password_hash = 'a', credentials_issued_at = now(), previous_mqtt_password_hash = 'b'
        WHERE id = $1`,
      [device('RES-REVOKE').id],
    );
    expect(
      await reservations.reissueToken(device('RES-REVOKE'), {
        tokenHash: hashProvisioningToken('5'.repeat(64)),
        tokenIssuedAt: NOW,
        tokenExpiresAt: new Date('2026-10-21T00:00:00Z'),
        lifecycleState: DeviceLifecycleState.REGISTERED,
      }),
    ).toBe(true);
    expect(await row('RES-REVOKE')).toMatchObject({
      mqttPasswordHash: null,
      previousMqttPasswordHash: null,
      credentialsIssuedAt: null,
    });
  });

  describe('through the broker authenticator on real credentials (SENSOR-MEDIUM-236)', () => {
    const connect = (code: Code, password: string): Promise<boolean> =>
      auth.verifyDeviceCredentials(clientIdOf(code), password, clientIdOf(code));

    /** A Suderra OS device that connected with its first credential and handed its receipt to root. */
    const connectedOnRoot = async (code: Code, password: string): Promise<void> => {
      expect(
        await reservations.reserve(device(code), token(code), BINDING_A, TTL_MS, NOW, issue),
      ).not.toBeNull();
      expect(
        await reservations.issueCredentials(
          device(code),
          token(code),
          {
            fingerprint: null,
            agentVersion: '1.6.0',
            mqttPasswordHash: await auth.hashPassword(password, 1_000),
          },
          NOW,
        ),
      ).toBe(true);
      expect(await connect(code, password)).toBe(true);
      const committed = await row(code);
      expect(committed.tokenUsedAt).not.toBeNull();
      await reservations.settleHandoff(
        device(code),
        storedStatementDigest(committed.activationReceipt ?? ''),
        NOW,
      );
    };

    /** The window is open, the reinstall reserved and activated, and it has not connected. */
    const reinstallActivated = async (
      code: Code,
      credential: string,
      window = reprovisionWindow,
    ): Promise<void> => {
      const fresh = hashProvisioningToken(`${code}-window`).slice(0, 64);
      await reservations.beginReprovisioning(
        device(code),
        BINDING_A,
        hashProvisioningToken(fresh),
        window,
        NOW,
        signLifecycle(code),
      );
      expect(
        await reservations.reserve(device(code), fresh, BINDING_A, TTL_MS, NOW, issue),
      ).not.toBeNull();
      expect(
        await reservations.issueCredentials(
          device(code),
          fresh,
          {
            fingerprint: null,
            agentVersion: '1.6.1',
            mqttPasswordHash: await auth.hashPassword(credential, 1_000),
          },
          NOW,
        ),
      ).toBe(true);
    };

    it('the running agent authenticates until the reinstalled one connects; that connect retires it', async () => {
      await connectedOnRoot('RES-BROKER-KEEP', 'running-secret');
      await reinstallActivated('RES-BROKER-KEEP', 'reinstalled-secret');

      // Activated, never connected: the previously working credential still works,
      // and nothing is spent by it.
      expect(await connect('RES-BROKER-KEEP', 'running-secret')).toBe(true);
      expect(await connect('RES-BROKER-KEEP', 'a-guess')).toBe(false);
      expect(await row('RES-BROKER-KEEP')).toMatchObject({ tokenUsedAt: null });

      // The reinstalled agent's own credential connects and commits the activation.
      expect(await connect('RES-BROKER-KEEP', 'reinstalled-secret')).toBe(true);
      expect(await row('RES-BROKER-KEEP')).toMatchObject({ previousMqttPasswordHash: null });
      expect((await row('RES-BROKER-KEEP')).tokenUsedAt).not.toBeNull();

      // The credential it replaced is retired in the same statement.
      expect(await connect('RES-BROKER-KEEP', 'running-secret')).toBe(false);
      expect(await connect('RES-BROKER-KEEP', 'reinstalled-secret')).toBe(true);
    });

    it('a reinstall that never connects strands nothing, and a new window revokes what it was issued', async () => {
      await connectedOnRoot('RES-BROKER-LOST', 'running-secret');
      await reinstallActivated('RES-BROKER-LOST', 'lost-secret');

      for (let attempt = 0; attempt < 3; attempt += 1) {
        expect(await connect('RES-BROKER-LOST', 'running-secret')).toBe(true);
      }
      expect((await row('RES-BROKER-LOST')).tokenUsedAt).toBeNull();

      // The window ends and the operator opens another: the abandoned credential is gone.
      const next = {
        notBefore: WINDOW_END,
        expiresAt: new Date(WINDOW_END.getTime() + 7_200_000),
      };
      expect(
        await reservations.beginReprovisioning(
          device('RES-BROKER-LOST'),
          BINDING_A,
          hashProvisioningToken('4'.repeat(64)),
          next,
          WINDOW_END,
          signLifecycle('RES-BROKER-LOST'),
        ),
      ).toMatchObject({ windowEndsAt: next.expiresAt });
      expect(await connect('RES-BROKER-LOST', 'running-secret')).toBe(true);
      expect(await connect('RES-BROKER-LOST', 'lost-secret')).toBe(false);
    });
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
    const commit = await reservations.commitFirstSession(device('RES-DELIVER'), NOW, 'hash');
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

  it('a from-scratch reissue returns an uncommitted device to the generic channel, a committed one stays', async () => {
    await reservations.reserve(
      device('RES-CHANNEL'),
      token('RES-CHANNEL'),
      BINDING_A,
      TTL_MS,
      NOW,
      issue,
    );
    expect((await row('RES-CHANNEL')).agentChannel).toBe(EdgeAgentChannel.SUDERRA_OS);
    const reissue = (hash: string): Promise<boolean> =>
      reservations.reissueToken(device('RES-CHANNEL'), {
        tokenHash: hashProvisioningToken(hash),
        tokenIssuedAt: NOW,
        tokenExpiresAt: new Date('2026-10-21T00:00:00Z'),
        lifecycleState: DeviceLifecycleState.REGISTERED,
      });
    expect(await reissue('1'.repeat(64))).toBe(true);
    expect(await row('RES-CHANNEL')).toMatchObject({
      agentChannel: EdgeAgentChannel.GENERIC_LINUX,
      reservedBindingSha256: null,
      issuedManifestSha256: null,
    });

    // Committed (binding set), but root never recorded the activation: the
    // channel stays, because the committed binding proves the hardware.
    const fresh = '2'.repeat(64);
    expect(await reissue(fresh)).toBe(true);
    await reservations.reserve(device('RES-CHANNEL'), fresh, BINDING_A, TTL_MS, NOW, issue);
    await reservations.issueCredentials(
      device('RES-CHANNEL'),
      fresh,
      { fingerprint: null, agentVersion: '1.6.0', mqttPasswordHash: 'hash' },
      NOW,
    );
    await reservations.commitFirstSession(device('RES-CHANNEL'), NOW, 'hash');
    expect(await reissue('3'.repeat(64))).toBe(true);
    expect(await row('RES-CHANNEL')).toMatchObject({
      agentChannel: EdgeAgentChannel.SUDERRA_OS,
      deviceBindingSha256: BINDING_A.digest.sha256,
      mqttPasswordHash: null,
      activationId: null,
    });
  });

  it('a spent token reserves nothing and activates nothing', async () => {
    await reservations.issueCredentials(
      device('RES-SPENT'),
      token('RES-SPENT'),
      { fingerprint: null, agentVersion: '1.6.0', mqttPasswordHash: 'hash' },
      NOW,
    );
    await reservations.commitFirstSession(device('RES-SPENT'), NOW, 'hash');
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
