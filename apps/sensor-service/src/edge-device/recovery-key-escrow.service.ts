import { createHash, randomUUID } from 'crypto';

import {
  runInTenantRead,
  runInTenantTransaction,
  SENSOR_SOURCE_SCHEMA,
} from '@aquaculture/backend-common/database';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { canonicalJsonBytes } from './edge-contract';
import { DeviceLifecycleState, EdgeAgentChannel } from './entities/edge-device.entity';
import { RecoveryEscrowState } from './entities/recovery-key-escrow.entity';
import { returningRows } from './returning-rows';
import { SuderraEdgeConfig } from './suderra-edge.config';

/**
 * The recovery-key escrow of a device's `/data` volume (ADR-048 DEC-14.3; Suderra-OS
 * docs/security/data-recovery.md, `suderra.data-recovery-escrow.v1`).
 *
 * A device seals `/data` to its TPM and keeps a recovery slot whose key it encrypts to an
 * offline escrow key (RSA-OAEP, SHA-256, at least 3072 bits). The cloud holds that
 * ciphertext so a Secure Boot or firmware change that moves the TPM measurements does not
 * lose the device's data; only the offline HSM, under a custodian quorum, can open it.
 *
 * What holds here, and where it is tested:
 *
 *   - The cloud accepts an envelope only if it is exactly the document the device writes
 *     and is encrypted to an escrow key the cloud was configured with (by the sha256 of its
 *     SubjectPublicKeyInfo): a rogue device cannot escrow to a key of its own, which would
 *     leave a recovery nobody can open. With no key configured (the production key waits
 *     for the key ceremony) it accepts nothing.
 *   - One ACTIVE envelope per device and volume. A newer one supersedes the older (after a
 *     recovery the old key is burned); the same envelope delivered again is stored once and
 *     never revives a superseded one.
 *   - The ciphertext is never logged, never in an error, never in a GraphQL type. It leaves
 *     this service only through {@link retrieve}, which writes the retrieval record in the
 *     transaction that reads the envelope.
 *
 * Not here: the transport that brings an envelope from a device to {@link record}. The
 * envelope and its delivery are not defined in `contracts/suderra-edge/v1`, and the cloud
 * does not invent an unauthenticated one; until the contract defines it nothing calls
 * `record` in production.
 */

export const ESCROW_ENVELOPE_TYPE = 'suderra.data-recovery-escrow.v1';
export const ESCROW_ALGORITHM = 'RSA-OAEP-SHA256';

/** The ciphertext of RSA-OAEP is as long as the modulus: 3072, 4096, 6144 or 8192 bits. */
const CIPHERTEXT_BYTES: ReadonlySet<number> = new Set([384, 512, 768, 1024]);

const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
/** common.schema.json `base64`: canonical RFC 4648 with padding. */
const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=)?$/;

/** The document `/data/suderra/os/recovery-escrow.json` holds. */
export interface EscrowEnvelope {
  readonly _type: typeof ESCROW_ENVELOPE_TYPE;
  readonly volume_uuid: string;
  readonly algorithm: typeof ESCROW_ALGORITHM;
  readonly recipient_spki_sha256: string;
  readonly ciphertext: string;
}

export type EscrowRefusal =
  | 'invalid-envelope'
  | 'recipient-not-configured'
  | 'unknown-recipient'
  | 'device-not-eligible';

/** An envelope the cloud will not hold; nothing was stored. The message never carries the envelope. */
export class EscrowRefusedError extends Error {
  constructor(
    readonly reason: EscrowRefusal,
    detail: string,
  ) {
    super(`The recovery escrow was refused (${reason}): ${detail}`);
    this.name = 'EscrowRefusedError';
  }
}

const MEMBERS: readonly string[] = [
  '_type',
  'volume_uuid',
  'algorithm',
  'recipient_spki_sha256',
  'ciphertext',
];

/** The envelope a value is, exactly as the device writes it, or an {@link EscrowRefusedError}. */
export function parseEscrowEnvelope(value: unknown): EscrowEnvelope {
  const refuse = (detail: string): never => {
    throw new EscrowRefusedError('invalid-envelope', detail);
  };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return refuse('it is not a JSON object');
  }
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== [...MEMBERS].sort().join(',')) {
    return refuse('it does not have exactly the members of suderra.data-recovery-escrow.v1');
  }
  const type = Reflect.get(value, '_type');
  const volume = Reflect.get(value, 'volume_uuid');
  const algorithm = Reflect.get(value, 'algorithm');
  const recipient = Reflect.get(value, 'recipient_spki_sha256');
  const ciphertext = Reflect.get(value, 'ciphertext');
  if (type !== ESCROW_ENVELOPE_TYPE) return refuse('_type is not suderra.data-recovery-escrow.v1');
  if (typeof volume !== 'string' || !LOWER_UUID.test(volume)) {
    return refuse('volume_uuid is not a lowercase UUID');
  }
  if (algorithm !== ESCROW_ALGORITHM) return refuse('algorithm is not RSA-OAEP-SHA256');
  if (typeof recipient !== 'string' || !SHA256_HEX.test(recipient)) {
    return refuse('recipient_spki_sha256 is not a sha256 hex digest');
  }
  if (typeof ciphertext !== 'string' || !BASE64.test(ciphertext)) {
    return refuse('ciphertext is not canonical base64');
  }
  if (!CIPHERTEXT_BYTES.has(Buffer.from(ciphertext, 'base64').length)) {
    return refuse('ciphertext is not the length of an RSA-OAEP block of a 3072..8192-bit key');
  }
  return {
    _type: ESCROW_ENVELOPE_TYPE,
    volume_uuid: volume,
    algorithm: ESCROW_ALGORITHM,
    recipient_spki_sha256: recipient,
    ciphertext,
  };
}

/** What {@link RecoveryKeyEscrowService.record} did. */
export type EscrowRecordOutcome =
  | { readonly status: 'stored'; readonly escrowId: string; readonly superseded: number }
  | { readonly status: 'duplicate'; readonly escrowId: string };

/** An escrowed envelope as the console lists it: never the ciphertext. */
export interface EscrowStatus {
  readonly id: string;
  readonly volumeUuid: string;
  readonly recipientSpkiSha256: string;
  readonly state: RecoveryEscrowState;
  readonly receivedAt: Date;
  readonly supersededAt: Date | null;
  readonly retrievals: number;
}

/** An envelope an administrator took out, with the record that says so already written. */
export interface RetrievedEscrow {
  readonly escrowId: string;
  readonly deviceId: string;
  readonly receivedAt: Date;
  readonly envelope: EscrowEnvelope;
}

/** A retrieval states why: a person asked, and the reason is part of the record. */
export const MIN_RETRIEVAL_REASON = 10;
export const MAX_RETRIEVAL_REASON = 256;

interface EscrowRow {
  readonly id: string;
  readonly volume_uuid: string;
  readonly algorithm: string;
  readonly recipient_spki_sha256: string;
  readonly ciphertext: string;
  readonly received_at: Date;
}

@Injectable()
export class RecoveryKeyEscrowService {
  private readonly logger = new Logger(RecoveryKeyEscrowService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly config: SuderraEdgeConfig,
  ) {}

  /**
   * Stores the envelope `device` delivered. The caller is whatever authenticated the
   * device (none exists yet, see the class comment); this method trusts nothing in the
   * document beyond what it checks: its shape, the escrow key it names, and that the
   * device is a Suderra OS device of the tenant that is not revoked.
   */
  async record(
    device: { readonly id: string; readonly tenantId: string },
    document: unknown,
  ): Promise<EscrowRecordOutcome> {
    const envelope = parseEscrowEnvelope(document);
    const recipients = this.config.settings.recoveryEscrow.recipientSpkiSha256;
    if (recipients.length === 0) {
      throw new EscrowRefusedError(
        'recipient-not-configured',
        'no escrow key is configured on this deployment',
      );
    }
    if (!recipients.includes(envelope.recipient_spki_sha256)) {
      throw new EscrowRefusedError(
        'unknown-recipient',
        'the envelope is encrypted to a key the cloud was not configured with',
      );
    }
    const envelopeSha256 = createHash('sha256')
      .update(canonicalJsonBytes({ ...envelope }))
      .digest('hex');
    const outcome = await runInTenantTransaction(
      this.dataSource,
      SENSOR_SOURCE_SCHEMA,
      device.tenantId,
      async (qr): Promise<EscrowRecordOutcome> => {
        const eligible: Array<{ id: string }> = await qr.query(
          `SELECT id FROM edge_devices
            WHERE id = $1 AND tenant_id = $2 AND agent_channel = $3
              AND lifecycle_state::text <> ALL($4::text[])
            FOR SHARE`,
          [
            device.id,
            device.tenantId,
            EdgeAgentChannel.SUDERRA_OS,
            [DeviceLifecycleState.REVOKED, DeviceLifecycleState.DECOMMISSIONED],
          ],
        );
        if (eligible.length === 0) {
          throw new EscrowRefusedError(
            'device-not-eligible',
            'the device is not a Suderra OS device of this tenant in service',
          );
        }
        const known: Array<{ id: string }> = await qr.query(
          `SELECT id FROM recovery_key_escrows WHERE device_id = $1 AND envelope_sha256 = $2`,
          [device.id, envelopeSha256],
        );
        const already = known[0];
        if (already !== undefined) return { status: 'duplicate', escrowId: already.id };
        const escrowId = randomUUID();
        // The old key of this volume is burned the moment a new one is escrowed; the partial
        // unique index admits one ACTIVE envelope per device and volume.
        const replaced = await returningRows<{ id: string }>(
          qr,
          `UPDATE recovery_key_escrows
              SET state = $4, superseded_at = now(), superseded_by = $5
            WHERE device_id = $1 AND tenant_id = $2 AND volume_uuid = $3 AND state = 'active'
        RETURNING id`,
          [
            device.id,
            device.tenantId,
            envelope.volume_uuid,
            RecoveryEscrowState.SUPERSEDED,
            escrowId,
          ],
        );
        await qr.query(
          `INSERT INTO recovery_key_escrows
             (id, tenant_id, device_id, volume_uuid, algorithm, recipient_spki_sha256,
              ciphertext, envelope_sha256, state)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            escrowId,
            device.tenantId,
            device.id,
            envelope.volume_uuid,
            envelope.algorithm,
            envelope.recipient_spki_sha256,
            envelope.ciphertext,
            envelopeSha256,
            RecoveryEscrowState.ACTIVE,
          ],
        );
        return { status: 'stored', escrowId, superseded: replaced.length };
      },
    );
    // Identifiers and digests only: the ciphertext is never part of a log line.
    this.logger.log({
      event: outcome.status === 'stored' ? 'recovery_escrow_stored' : 'recovery_escrow_duplicate',
      deviceId: device.id,
      escrowId: outcome.escrowId,
      envelopeSha256,
      recipientSpkiSha256: envelope.recipient_spki_sha256,
    });
    return outcome;
  }

  /** The envelopes of a device, newest first, without their ciphertext. */
  async status(tenantId: string, deviceId: string): Promise<EscrowStatus[]> {
    return runInTenantRead(
      this.dataSource,
      SENSOR_SOURCE_SCHEMA,
      tenantId,
      (qr): Promise<EscrowStatus[]> =>
        qr.query(
          `SELECT e.id, e.volume_uuid AS "volumeUuid", e.recipient_spki_sha256 AS "recipientSpkiSha256",
                  e.state, e.received_at AS "receivedAt", e.superseded_at AS "supersededAt",
                  (SELECT count(*)::int FROM recovery_key_escrow_retrievals r
                    WHERE r.escrow_id = e.id) AS retrievals
             FROM recovery_key_escrows e
            WHERE e.tenant_id = $1 AND e.device_id = $2
            ORDER BY e.received_at DESC, e.id DESC`,
          [tenantId, deviceId],
        ),
    );
  }

  /**
   * The ACTIVE envelope(s) of a device, taken out by an administrator for the custodians
   * to open in the HSM. The reason is required and part of the record; the record of each
   * envelope is written in the transaction that reads it, so an envelope that left the
   * cloud always has its row.
   */
  async retrieve(
    tenantId: string,
    deviceId: string,
    actorId: string,
    reason: string,
  ): Promise<RetrievedEscrow[]> {
    const why = reason.trim();
    if (why.length < MIN_RETRIEVAL_REASON || why.length > MAX_RETRIEVAL_REASON) {
      throw new BadRequestException(
        `A retrieval states its reason in ${MIN_RETRIEVAL_REASON} to ${MAX_RETRIEVAL_REASON} characters`,
      );
    }
    if (actorId.length < 1 || actorId.length > 128) {
      throw new BadRequestException('A retrieval is made by an authenticated user');
    }
    const retrieved = await runInTenantTransaction(
      this.dataSource,
      SENSOR_SOURCE_SCHEMA,
      tenantId,
      async (qr): Promise<RetrievedEscrow[]> => {
        const rows: EscrowRow[] = await qr.query(
          `SELECT id, volume_uuid, algorithm, recipient_spki_sha256, ciphertext, received_at
             FROM recovery_key_escrows
            WHERE tenant_id = $1 AND device_id = $2 AND state = 'active'
            ORDER BY received_at DESC, id DESC
            FOR SHARE`,
          [tenantId, deviceId],
        );
        if (rows.length === 0) {
          throw new NotFoundException(`Device ${deviceId} has no escrowed recovery key`);
        }
        for (const row of rows) {
          await qr.query(
            `INSERT INTO recovery_key_escrow_retrievals
               (tenant_id, escrow_id, device_id, retrieved_by, reason)
             VALUES ($1, $2, $3, $4, $5)`,
            [tenantId, row.id, deviceId, actorId, why],
          );
        }
        return rows.map(
          (row): RetrievedEscrow => ({
            escrowId: row.id,
            deviceId,
            receivedAt: row.received_at,
            envelope: {
              _type: ESCROW_ENVELOPE_TYPE,
              volume_uuid: row.volume_uuid,
              algorithm: ESCROW_ALGORITHM,
              recipient_spki_sha256: row.recipient_spki_sha256,
              ciphertext: row.ciphertext,
            },
          }),
        );
      },
    );
    for (const item of retrieved) {
      this.logger.warn({
        event: 'recovery_escrow_retrieved',
        deviceId,
        escrowId: item.escrowId,
        retrievedBy: actorId,
        reasonSha256: createHash('sha256').update(why).digest('hex'),
      });
    }
    return retrieved;
  }
}
