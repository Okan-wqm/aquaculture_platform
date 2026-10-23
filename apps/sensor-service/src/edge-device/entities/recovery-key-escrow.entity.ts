import { Check, Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Where an escrowed envelope stands (ADR-048 DEC-14.3).
 *
 * ACTIVE      the envelope of a volume's current recovery key
 * SUPERSEDED  a newer envelope for the same volume arrived: after a recovery the old
 *             key is burned and the device escrows a new one
 */
export enum RecoveryEscrowState {
  ACTIVE = 'active',
  SUPERSEDED = 'superseded',
}

const STATES = Object.values(RecoveryEscrowState)
  .map((state) => `'${state}'`)
  .join(', ');

/**
 * A device's `/data` recovery key, encrypted to the offline escrow key (ADR-048 DEC-14.3;
 * Suderra-OS docs/security/data-recovery.md, `suderra.data-recovery-escrow.v1`).
 *
 * The cloud holds ciphertext only: the plaintext is the volume's recovery key, encrypted
 * on the device to an RSA key whose private half lives in an offline HSM under a
 * custodian quorum, so nothing here, and nobody with this table, can open a volume. Even
 * so the ciphertext is kept confidential: this entity has no GraphQL field, it is read only
 * by `RecoveryKeyEscrowService`, and an administrator receives it only through the audited
 * retrieval (`recovery_key_escrow_retrievals`).
 *
 * At most one ACTIVE envelope per device and volume (a new one supersedes the old); the
 * same envelope delivered twice is one row (`(device_id, envelope_sha256)` is unique).
 *
 * Per-tenant table — no `schema:` (ADR-011 search_path routing).
 */
@Entity('recovery_key_escrows')
@Check('CHK_recovery_key_escrows_state', `"state" IN (${STATES})`)
@Check('CHK_recovery_key_escrows_algorithm', `"algorithm" = 'RSA-OAEP-SHA256'`)
@Check('CHK_recovery_key_escrows_recipient', `"recipient_spki_sha256" ~ '^[0-9a-f]{64}$'`)
@Check('CHK_recovery_key_escrows_envelope', `"envelope_sha256" ~ '^[0-9a-f]{64}$'`)
@Index('uq_recovery_key_escrows_active', ['deviceId', 'volumeUuid'], {
  unique: true,
  where: `"state" = 'active'`,
})
@Index('uq_recovery_key_escrows_device_envelope', ['deviceId', 'envelopeSha256'], { unique: true })
@Index('idx_recovery_key_escrows_tenant_device', ['tenantId', 'deviceId'])
export class RecoveryKeyEscrow {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'uuid', name: 'device_id' })
  deviceId!: string;

  /** The LUKS UUID of the volume the key opens. */
  @Column({ type: 'uuid', name: 'volume_uuid' })
  volumeUuid!: string;

  @Column({ type: 'varchar', length: 32 })
  algorithm!: string;

  /** sha256 of the DER SubjectPublicKeyInfo of the escrow key the envelope is encrypted to. */
  @Column({ type: 'char', length: 64, name: 'recipient_spki_sha256' })
  recipientSpkiSha256!: string;

  /** The encrypted key, base64, exactly as the device sent it. */
  @Column({ type: 'text' })
  ciphertext!: string;

  /** sha256 over the canonical envelope: one row per envelope however often it is delivered. */
  @Column({ type: 'char', length: 64, name: 'envelope_sha256' })
  envelopeSha256!: string;

  @Column({ type: 'varchar', length: 16, default: RecoveryEscrowState.ACTIVE })
  state!: RecoveryEscrowState;

  @CreateDateColumn({ name: 'received_at', type: 'timestamptz' })
  receivedAt!: Date;

  @Column({ type: 'timestamptz', name: 'superseded_at', nullable: true })
  supersededAt!: Date | null;

  /** The envelope that replaced this one. */
  @Column({ type: 'uuid', name: 'superseded_by', nullable: true })
  supersededBy!: string | null;
}
