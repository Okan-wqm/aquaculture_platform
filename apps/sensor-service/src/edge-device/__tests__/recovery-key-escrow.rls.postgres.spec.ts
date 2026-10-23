import {
  constants,
  createHash,
  generateKeyPairSync,
  type KeyObject,
  privateDecrypt,
  publicEncrypt,
} from 'crypto';

import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { type DataSource } from 'typeorm';

import {
  bootSensorRlsHarness,
  type SensorRlsHarness,
} from '../../__tests__/support/sensor-rls-postgres.harness';
import { EdgeDeviceDirectory } from '../entities/edge-device-directory.entity';
import {
  DeviceLifecycleState,
  DeviceModel,
  EdgeAgentChannel,
  EdgeDevice,
} from '../entities/edge-device.entity';
import { RecoveryKeyEscrowRetrieval } from '../entities/recovery-key-escrow-retrieval.entity';
import { RecoveryKeyEscrow } from '../entities/recovery-key-escrow.entity';
import {
  ESCROW_ALGORITHM,
  ESCROW_ENVELOPE_TYPE,
  type EscrowEnvelope,
  EscrowRefusedError,
  RecoveryKeyEscrowService,
} from '../recovery-key-escrow.service';
import { SuderraEdgeConfig } from '../suderra-edge.config';

import { channelEnvironment } from './support/edge-channel-env';

/**
 * The recovery-key escrow on real Postgres (ADR-048 DEC-14.3): what the cloud accepts, how
 * it keeps it, and what it never lets out except through the audited retrieval.
 */

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const VOLUME_1 = '3f1c7a52-9d2e-4b60-8f0a-5c2b7d1e9a41';
const VOLUME_2 = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const BINDING = { method: 'tpm-ek-sha256', sha256: '7d'.repeat(32) } as const;

interface Seed {
  readonly code: string;
  readonly tenantId: string;
  readonly channel?: EdgeAgentChannel;
  readonly state?: DeviceLifecycleState;
}
const SEED: readonly Seed[] = [
  { code: 'ES-MAIN', tenantId: TENANT_A },
  { code: 'ES-DUP', tenantId: TENANT_A },
  { code: 'ES-SUPERSEDE', tenantId: TENANT_A },
  { code: 'ES-VOLUMES', tenantId: TENANT_A },
  { code: 'ES-LOG', tenantId: TENANT_A },
  { code: 'ES-GET', tenantId: TENANT_A },
  { code: 'ES-NONE', tenantId: TENANT_A },
  { code: 'ES-REFUSED', tenantId: TENANT_A },
  { code: 'ES-PROVISIONING', tenantId: TENANT_A, state: DeviceLifecycleState.PROVISIONING },
  { code: 'ES-GENERIC', tenantId: TENANT_A, channel: EdgeAgentChannel.GENERIC_LINUX },
  { code: 'ES-REVOKED', tenantId: TENANT_A, state: DeviceLifecycleState.REVOKED },
  { code: 'ES-DECOM', tenantId: TENANT_A, state: DeviceLifecycleState.DECOMMISSIONED },
  { code: 'ES-OTHER', tenantId: TENANT_B },
];

const spkiSha256 = (key: KeyObject): string =>
  createHash('sha256')
    .update(key.export({ type: 'spki', format: 'der' }))
    .digest('hex');

jest.setTimeout(240_000);

describe('the recovery-key escrow under FORCE RLS (ADR-048 DEC-14.3)', () => {
  let stage: SensorRlsHarness | undefined;
  let admin: DataSource;
  let service: RecoveryKeyEscrowService;
  let unconfigured: RecoveryKeyEscrowService;
  let publicKey: KeyObject;
  let privateKey: KeyObject;
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
  const rows = async (code: string): Promise<Array<Record<string, any>>> =>
    admin.query(
      `SELECT * FROM ${stage?.schemaOf(tenantOf(code))}.recovery_key_escrows
        WHERE device_id = $1 ORDER BY received_at, id`,
      [id(code)],
    );
  const retrievals = async (code: string): Promise<Array<Record<string, any>>> =>
    admin.query(
      `SELECT * FROM ${stage?.schemaOf(tenantOf(code))}.recovery_key_escrow_retrievals
        WHERE device_id = $1 ORDER BY retrieved_at, id`,
      [id(code)],
    );
  const KEY = '3a'.repeat(32);
  const envelopeFor = (volume: string, plaintext = KEY): EscrowEnvelope => ({
    _type: ESCROW_ENVELOPE_TYPE,
    volume_uuid: volume,
    algorithm: ESCROW_ALGORITHM,
    recipient_spki_sha256: spkiSha256(publicKey),
    ciphertext: publicEncrypt(
      { key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      Buffer.from(plaintext, 'utf8'),
    ).toString('base64'),
  });
  /** An envelope with members changed, as a hostile or broken device might send it. */
  const tampered = (volume: string, over: Record<string, unknown>): Record<string, unknown> => ({
    ...envelopeFor(volume),
    ...over,
  });

  beforeAll(async () => {
    const pair = generateKeyPairSync('rsa', { modulusLength: 3072 });
    publicKey = pair.publicKey;
    privateKey = pair.privateKey;
    stage = await bootSensorRlsHarness({
      name: 'recovery_key_escrow',
      tenants: [TENANT_A, TENANT_B],
      entities: [EdgeDevice, RecoveryKeyEscrow, RecoveryKeyEscrowRetrieval],
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
              deviceBindingMethod: BINDING.method,
              deviceBindingSha256: BINDING.sha256,
              isOnline: true,
            }),
          );
          ids.set(seed.code, saved.id);
        }
      },
    });
    admin = stage.admin;
    const config = (env: Record<string, string>): SuderraEdgeConfig =>
      new SuderraEdgeConfig(new ConfigService(channelEnvironment(env)));
    service = new RecoveryKeyEscrowService(
      stage.runtime,
      config({ SUDERRA_EDGE_RECOVERY_ESCROW_SPKI_SHA256: spkiSha256(publicKey) }),
    );
    unconfigured = new RecoveryKeyEscrowService(stage.runtime, config({}));
  });

  afterAll(async () => {
    await stage?.shutdown();
  });

  describe('recording', () => {
    it('stores the envelope exactly as the device wrote it, ACTIVE, once per envelope', async () => {
      const envelope = envelopeFor(VOLUME_1);
      const outcome = await service.record(ref('ES-MAIN'), envelope);
      expect(outcome).toMatchObject({ status: 'stored', superseded: 0 });
      const [row] = await rows('ES-MAIN');
      expect(row).toMatchObject({
        volume_uuid: VOLUME_1,
        algorithm: 'RSA-OAEP-SHA256',
        recipient_spki_sha256: envelope.recipient_spki_sha256,
        ciphertext: envelope.ciphertext,
        state: 'active',
        superseded_at: null,
      });
      expect(row?.['envelope_sha256']).toMatch(/^[0-9a-f]{64}$/);
    });

    it('the same envelope delivered again is one row', async () => {
      const envelope = envelopeFor(VOLUME_1);
      const first = await service.record(ref('ES-DUP'), envelope);
      const again = await service.record(ref('ES-DUP'), { ...envelope });
      expect(again).toEqual({
        status: 'duplicate',
        escrowId: (first as { escrowId: string }).escrowId,
      });
      expect(await rows('ES-DUP')).toHaveLength(1);
    });

    it('a newer envelope of the volume supersedes the older, and the older never comes back', async () => {
      const old = envelopeFor(VOLUME_1);
      const next = envelopeFor(VOLUME_1);
      const first = await service.record(ref('ES-SUPERSEDE'), old);
      const second = await service.record(ref('ES-SUPERSEDE'), next);
      expect(second).toMatchObject({ status: 'stored', superseded: 1 });
      const [before, after] = await rows('ES-SUPERSEDE');
      expect(before).toMatchObject({
        id: (first as { escrowId: string }).escrowId,
        state: 'superseded',
        superseded_by: after?.['id'],
      });
      expect(before?.['superseded_at']).not.toBeNull();
      expect(after).toMatchObject({ state: 'active', superseded_by: null });
      // The device’s agent republishes the old envelope after a reconnect.
      expect(await service.record(ref('ES-SUPERSEDE'), old)).toMatchObject({ status: 'duplicate' });
      expect((await rows('ES-SUPERSEDE')).map((r) => r['state'])).toEqual(['superseded', 'active']);
    });

    it('an envelope of another volume is another active envelope', async () => {
      await service.record(ref('ES-VOLUMES'), envelopeFor(VOLUME_1));
      await service.record(ref('ES-VOLUMES'), envelopeFor(VOLUME_2));
      expect((await rows('ES-VOLUMES')).map((r) => r['state'])).toEqual(['active', 'active']);
    });

    it('takes an envelope from a device still being provisioned: the volume is formatted before activation', async () => {
      await expect(
        service.record(ref('ES-PROVISIONING'), envelopeFor(VOLUME_1)),
      ).resolves.toMatchObject({ status: 'stored' });
    });

    it.each([
      ['a document that is not an object', () => 'text'],
      ['an array', () => []],
      ['an extra member', () => ({ ...envelopeFor(VOLUME_1), note: 'x' })],
      [
        'a missing member',
        () => {
          const { ciphertext: _ciphertext, ...rest } = envelopeFor(VOLUME_1);
          return rest;
        },
      ],
      ['another type', () => tampered(VOLUME_1, { _type: 'suderra.data-recovery-escrow.v2' })],
      ['an uppercase volume uuid', () => tampered(VOLUME_1.toUpperCase(), {})],
      ['a volume that is not a uuid', () => tampered('not-a-uuid', {})],
      ['another algorithm', () => tampered(VOLUME_1, { algorithm: 'RSA-PKCS1' })],
      [
        'a recipient that is not a digest',
        () => tampered(VOLUME_1, { recipient_spki_sha256: 'abc' }),
      ],
      ['a ciphertext that is not base64', () => tampered(VOLUME_1, { ciphertext: 'not base64!' })],
      [
        'a ciphertext of the wrong length',
        () => tampered(VOLUME_1, { ciphertext: Buffer.alloc(100).toString('base64') }),
      ],
      [
        'an unpadded ciphertext',
        () =>
          tampered(VOLUME_1, {
            ciphertext: Buffer.alloc(384).toString('base64').replace(/=+$/, '') + 'AA',
          }),
      ],
    ])('refuses %s and stores nothing', async (_name, document) => {
      const before = (await rows('ES-REFUSED')).length;
      await expect(service.record(ref('ES-REFUSED'), document())).rejects.toMatchObject({
        reason: 'invalid-envelope',
      });
      expect((await rows('ES-REFUSED')).length).toBe(before);
    });

    it('refuses an envelope encrypted to a key the cloud was not configured with', async () => {
      await expect(
        service.record(
          ref('ES-REFUSED'),
          tampered(VOLUME_1, { recipient_spki_sha256: 'cd'.repeat(32) }),
        ),
      ).rejects.toMatchObject({ reason: 'unknown-recipient' });
      expect(await rows('ES-REFUSED')).toEqual([]);
    });

    it('accepts nothing while no escrow key is configured', async () => {
      await expect(
        unconfigured.record(ref('ES-REFUSED'), envelopeFor(VOLUME_1)),
      ).rejects.toMatchObject({
        reason: 'recipient-not-configured',
      });
      expect(await rows('ES-REFUSED')).toEqual([]);
    });

    it.each([
      ['a generic-Linux device', 'ES-GENERIC'],
      ['a revoked device', 'ES-REVOKED'],
      ['a decommissioned device', 'ES-DECOM'],
    ])('refuses %s', async (_name, code) => {
      await expect(service.record(ref(code), envelopeFor(VOLUME_1))).rejects.toMatchObject({
        reason: 'device-not-eligible',
      });
      expect(await rows(code)).toEqual([]);
    });

    it("refuses another tenant's device and an unknown one", async () => {
      await expect(
        service.record({ id: id('ES-OTHER'), tenantId: TENANT_A }, envelopeFor(VOLUME_1)),
      ).rejects.toBeInstanceOf(EscrowRefusedError);
      await expect(
        service.record(
          { id: '00000000-0000-4000-8000-0000000000ff', tenantId: TENANT_A },
          envelopeFor(VOLUME_1),
        ),
      ).rejects.toMatchObject({ reason: 'device-not-eligible' });
    });
  });

  describe('listing', () => {
    it('says what is escrowed and by which key, never the ciphertext, and only for the tenant’s own device', async () => {
      const envelope = envelopeFor(VOLUME_1);
      await service.record(ref('ES-GET'), envelope);
      const listed = await service.status(TENANT_A, id('ES-GET'));
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({
        volumeUuid: VOLUME_1,
        recipientSpkiSha256: envelope.recipient_spki_sha256,
        state: 'active',
        retrievals: 0,
      });
      expect(JSON.stringify(listed)).not.toContain(envelope.ciphertext);
      expect(Object.keys(listed[0] ?? {})).not.toContain('ciphertext');
      expect(await service.status(TENANT_B, id('ES-GET'))).toEqual([]);
    });
  });

  describe('retrieving', () => {
    it('hands out the envelope the device wrote, which the offline key opens, and records who took it and why', async () => {
      const envelope = envelopeFor(VOLUME_1);
      await service.record(ref('ES-LOG'), envelope);
      const [got] = await service.retrieve(
        TENANT_A,
        id('ES-LOG'),
        'user-admin-1',
        'Device reports tpm-unseal-failed after the BIOS update',
      );
      expect(got?.envelope).toEqual(envelope);
      // What the HSM does: RSA-OAEP, SHA-256 for the digest and for MGF1, empty label.
      expect(
        privateDecrypt(
          { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
          Buffer.from(got?.envelope.ciphertext ?? '', 'base64'),
        ).toString('utf8'),
      ).toBe(KEY);
      const [record] = await retrievals('ES-LOG');
      expect(record).toMatchObject({
        escrow_id: got?.escrowId,
        retrieved_by: 'user-admin-1',
        reason: 'Device reports tpm-unseal-failed after the BIOS update',
      });
      expect((await service.status(TENANT_A, id('ES-LOG')))[0]?.retrievals).toBe(1);
    });

    it('records every retrieval, once for each envelope taken out', async () => {
      const [a, b] = await service.retrieve(
        TENANT_A,
        id('ES-VOLUMES'),
        'user-admin-2',
        'Both volumes of the device need recovery',
      );
      expect(a?.escrowId).not.toBe(b?.escrowId);
      expect(await retrievals('ES-VOLUMES')).toHaveLength(2);
      await service.retrieve(
        TENANT_A,
        id('ES-VOLUMES'),
        'user-admin-2',
        'Second look by the custodians',
      );
      expect(await retrievals('ES-VOLUMES')).toHaveLength(4);
    });

    it('hands out only the current envelope, not a superseded one', async () => {
      const [current] = await service.retrieve(
        TENANT_A,
        id('ES-SUPERSEDE'),
        'user-admin-3',
        'Recovery after the second format of the volume',
      );
      const active = (await rows('ES-SUPERSEDE')).find((r) => r['state'] === 'active');
      expect(current?.escrowId).toBe(active?.['id']);
    });

    it('needs a reason of its own and an authenticated user, and records nothing otherwise', async () => {
      for (const reason of ['', '   ', 'short', 'x'.repeat(257)]) {
        await expect(
          service.retrieve(TENANT_A, id('ES-GET'), 'user-admin-1', reason),
        ).rejects.toThrow(/states its reason/);
      }
      await expect(
        service.retrieve(TENANT_A, id('ES-GET'), '', 'A perfectly good reason here'),
      ).rejects.toThrow(/authenticated user/);
      expect(await retrievals('ES-GET')).toEqual([]);
    });

    it('answers a device without an escrow, and another tenant’s device, with not found', async () => {
      await expect(
        service.retrieve(TENANT_A, id('ES-NONE'), 'user-admin-1', 'No envelope was ever escrowed'),
      ).rejects.toThrow(/no escrowed recovery key/);
      await expect(
        service.retrieve(TENANT_B, id('ES-GET'), 'user-admin-1', 'Asking from the wrong tenant'),
      ).rejects.toThrow(/no escrowed recovery key/);
      expect(await retrievals('ES-GET')).toEqual([]);
    });
  });

  describe('confidentiality', () => {
    it('the ciphertext is in no log line and no error message, through every path', async () => {
      const lines: string[] = [];
      const capture = (...args: unknown[]): void => {
        lines.push(JSON.stringify(args));
      };
      const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((level) =>
        jest.spyOn(Logger.prototype, level).mockImplementation(capture),
      );
      try {
        const envelope = envelopeFor(VOLUME_1);
        const secrets = [
          envelope.ciphertext,
          envelope.ciphertext.slice(0, 48),
          JSON.stringify(envelope),
        ];
        const messages: string[] = [];
        await service.record(ref('ES-LOG'), envelope);
        await service.record(ref('ES-LOG'), { ...envelope });
        await service
          .record(ref('ES-LOG'), { ...envelope, volume_uuid: 'nope' })
          .catch((error: Error) => messages.push(error.message));
        await service
          .record(ref('ES-REVOKED'), envelope)
          .catch((error: Error) => messages.push(error.message));
        await unconfigured
          .record(ref('ES-LOG'), envelope)
          .catch((error: Error) => messages.push(error.message));
        await service
          .record(ref('ES-LOG'), { ...envelope, recipient_spki_sha256: 'ef'.repeat(32) })
          .catch((error: Error) => messages.push(error.message));
        await service.retrieve(
          TENANT_A,
          id('ES-LOG'),
          'user-admin-1',
          'Logging must never hold the key',
        );
        expect(lines.length).toBeGreaterThan(0);
        for (const secret of secrets) {
          expect(lines.some((line) => line.includes(secret))).toBe(false);
          expect(messages.some((message) => message.includes(secret))).toBe(false);
        }
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    });
  });
});
