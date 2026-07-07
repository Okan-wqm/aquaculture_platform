/**
 * Worker Entity - Farm workers for farm-service
 * Maps to the 'farm_workers' table (separate from HR service's 'employees' table)
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
import { DecimalTransformer } from '@aquaculture/backend-common/database';
import {
  createEncryptedColumnTransformer,
  createBlindIndex,
} from '@aquaculture/backend-common/security';

/** Env var holding the AES-256 key for at-rest PII encryption (shared with nationalId). */
const PII_KEY_ENV = 'EMPLOYEE_PII_ENCRYPTION_KEY';

/**
 * Deterministic blind index for the encrypted `email` column. Separate key from
 * the encryption key so the lookup-hash boundary and the confidentiality
 * boundary fail independently. @see createBlindIndex.
 */
const emailBlindIndex = createBlindIndex('EMPLOYEE_PII_BLIND_INDEX_KEY');

/** Shapes for the encrypted JSONB PII columns (round-tripped via { json: true }). */
export interface WorkerContactInfo {
  email: string;
  phone: string;
  emergencyContact?: string;
  emergencyPhone?: string;
}

export interface WorkerAddress {
  street: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
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

  /** SECURITY (pii-at-rest): JSONB PII encrypted at rest (JSON serialized, then AES-256-GCM). */
  @Column({ type: 'text', transformer: createEncryptedColumnTransformer(PII_KEY_ENV, { json: true }) })
  contactInfo!: WorkerContactInfo;

  /** SECURITY (pii-at-rest): JSONB PII encrypted at rest (JSON serialized, then AES-256-GCM). */
  @Column({ type: 'text', transformer: createEncryptedColumnTransformer(PII_KEY_ENV, { json: true }) })
  address!: WorkerAddress;

  /**
   * SECURITY (pii-at-rest): date-of-birth encrypted at rest. Stored as text
   * ciphertext. The encryption transformer round-trips strings, so the honest
   * type at this boundary is an ISO-8601 date string (`YYYY-MM-DD`) — NOT a
   * `Date`. Typing it `Date` would be a lie the moment the transformer's
   * `from()` returns a decrypted string. Callers write a normalized ISO date.
   */
  @Column({ type: 'text', transformer: createEncryptedColumnTransformer(PII_KEY_ENV) })
  dateOfBirth!: string;

  /**
   * SECURITY: Government ID encrypted at rest with AES-256-GCM.
   * DB column stores ciphertext; application decrypts on read.
   * @see DB-CRITICAL-001
   */
  @Column({ type: 'text', transformer: createEncryptedColumnTransformer(PII_KEY_ENV) })
  nationalId!: string;

  @Column({ type: 'varchar', default: 'active' })
  status!: string;

  @Column({ type: 'varchar' })
  employmentType!: string;

  @Column({ type: 'varchar' })
  department!: string;

  @Column()
  position!: string;

  @Column({ type: 'date' })
  hireDate!: Date;

  @Column({ type: 'decimal', precision: 12, scale: 2, transformer: new DecimalTransformer() })
  baseSalary!: number;

  @Column({ default: 'USD' })
  currency!: string;

  @Column({ default: false })
  isDeleted!: boolean;

  @Column({ default: false })
  isFarmWorker!: boolean;

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
