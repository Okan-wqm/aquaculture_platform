/**
 * Worker Entity - Farm workers for farm-service
 * Maps to the 'farm_workers' table (separate from HR service's 'employees' table).
 *
 * SCOPE (ORPHAN-MEDIUM-379): this is an OPERATIONAL roster, not a personnel
 * record — deep worker PII (address, date of birth, national ID, employment
 * terms, salary) belongs to hr.employees, the platform's worker-PII SSoT.
 * This entity carries only the fields the farm surfaces actually read back:
 * identity (name/email/phone), position, department, vet attribution, status.
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  VersionColumn,
  Index,
  BeforeInsert,
  BeforeUpdate,
} from 'typeorm';
import {
  createEncryptedColumnTransformer,
  createBlindIndex,
} from '@aquaculture/backend-common/security';

/** Env var holding the AES-256 key for at-rest PII encryption (shared with hr PII). */
const PII_KEY_ENV = 'EMPLOYEE_PII_ENCRYPTION_KEY';

/**
 * Deterministic blind index for the encrypted `email` column. Separate key from
 * the encryption key so the lookup-hash boundary and the confidentiality
 * boundary fail independently. @see createBlindIndex.
 */
const emailBlindIndex = createBlindIndex('EMPLOYEE_PII_BLIND_INDEX_KEY');

/** Shape for the encrypted JSON PII column (round-tripped via { json: true }). */
export interface WorkerContactInfo {
  email: string;
  phone: string;
  emergencyContact?: string;
  emergencyPhone?: string;
}

@Entity('farm_workers')
// SECURITY (pii-at-rest): uniqueness is enforced on the deterministic blind
// index, NOT on the encrypted `email` column. GCM ciphertext is non-deterministic
// (fresh IV per write), so a UNIQUE index over `email` would never detect a
// duplicate. The blind-index hash IS deterministic, so this index restores the
// per-tenant single-email guarantee while the plaintext email stays encrypted.
@Index(['tenantId', 'emailHash'], { unique: true })
@Index(['tenantId', 'department'])
export class Worker {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('uuid')
  tenantId!: string;

  @Column({ unique: true })
  employeeNumber!: string;

  /**
   * SECURITY (pii-at-rest): encrypted at rest with AES-256-GCM. DB column stores
   * ciphertext; the transformer decrypts transparently on read.
   */
  @Column({ type: 'text', transformer: createEncryptedColumnTransformer(PII_KEY_ENV) })
  firstName!: string;

  /** SECURITY (pii-at-rest): encrypted at rest with AES-256-GCM. */
  @Column({ type: 'text', transformer: createEncryptedColumnTransformer(PII_KEY_ENV) })
  lastName!: string;

  /**
   * SECURITY (pii-at-rest): encrypted at rest with AES-256-GCM. Equality lookups
   * and per-tenant uniqueness go through `emailHash`, NOT this column — see the
   * class-level @Index comment and the @BeforeInsert/@BeforeUpdate hook.
   */
  @Column({ type: 'text', transformer: createEncryptedColumnTransformer(PII_KEY_ENV) })
  email!: string;

  /**
   * SECURITY (pii-at-rest): deterministic keyed blind index of the normalized
   * email. Derived automatically from `email` by the lifecycle hook below, so
   * callers never set it directly. Backs the (tenantId, emailHash) UNIQUE index.
   */
  @Column({ type: 'text' })
  emailHash!: string;

  /** SECURITY (pii-at-rest): JSON PII (email/phone) encrypted at rest (JSON serialized, then AES-256-GCM). */
  @Column({ type: 'text', transformer: createEncryptedColumnTransformer(PII_KEY_ENV, { json: true }) })
  contactInfo!: WorkerContactInfo;

  @Column({ type: 'varchar', default: 'active' })
  status!: string;

  @Column({ type: 'varchar' })
  department!: string;

  @Column()
  position!: string;

  @Column({ type: 'date' })
  hireDate!: Date;

  @Column({ default: 'USD' })
  currency!: string;

  @Column({ default: false })
  isDeleted!: boolean;

  @Column({ default: false })
  isFarmWorker!: boolean;

  /**
   * Marks a worker as a veterinarian (RPT-011) so treatment applications can
   * attribute the responsible vet via `treatment_applications.veterinarianWorkerId`
   * and the capture forms can offer a vet-only picker.
   */
  @Column({ default: false })
  isVeterinarian!: boolean;

  /** Professional veterinary licence number (registrable credential, not PII). */
  @Column({ type: 'varchar', length: 50, nullable: true })
  veterinaryLicenseNumber?: string;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @Column({ nullable: true })
  createdBy?: string;

  @VersionColumn()
  version!: number;

  /**
   * SECURITY (pii-at-rest): keep the blind index in lock-step with the email on
   * every persist. Running this in a lifecycle hook (rather than asking each
   * caller to set emailHash) makes the correct behaviour the zero-effort default
   * — it is structurally impossible to save a row whose emailHash disagrees with
   * its email. Fires on repository.save() and manager.save() (the two paths the
   * worker handlers use). normalize() inside the blind index mirrors the
   * application's `email.toLowerCase().trim()` normalization.
   */
  @BeforeInsert()
  @BeforeUpdate()
  deriveEmailHash(): void {
    if (this.email) {
      this.email = this.email.toLowerCase().trim();
      this.emailHash = emailBlindIndex(this.email);
    }
  }
}

/** Compute the email blind index for equality lookups outside the entity. */
export function workerEmailBlindIndex(email: string): string {
  return emailBlindIndex(email);
}
