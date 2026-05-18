/**
 * EdgeWitnessV2 — junction table: witnesses to a provisioning ceremony.
 *
 * Per ADR-025. Per-tenant under sensor schema. Supersedes ADR-022's
 * `edge.witnesses` (and corrects its initial generic-JSON shape per the
 * ADR-022-FINDING-002 reinterpretation). Each row records one
 * (provisioning_id, witness_user_id, witness_role) tuple plus the
 * witness's Ed25519 signature over the bundle hash.
 *
 * # DDL contract (ADR-022 §2.4 carried forward)
 *
 *   - `witnessRole` enum CHECK (witness_role IN
 *     ('legal_counsel','auditor','security_lead')).
 *   - `witnessSignature bytea NOT NULL CHECK (octet_length=64)` —
 *     Ed25519 signature over `bundle_sha256`.
 *   - `signedAt timestamptz NOT NULL`.
 *   - FK `provisioningId → provisioning_records.provisioning_id`
 *     ON DELETE RESTRICT.
 *   - FK `witnessUserId → auth.users` ON DELETE RESTRICT.
 *   - Composite PK `(provisioning_id, witness_user_id, witness_role)` —
 *     a single witness can sign in only one role per ceremony.
 */
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';

@Entity('witnesses')
@Index(['tenantId', 'provisioningId'])
@Index(['tenantId', 'witnessUserId', 'signedAt'])
export class EdgeWitnessV2 {
  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string;

  @PrimaryColumn({ name: 'provisioning_id', type: 'uuid' })
  provisioningId!: string;

  @PrimaryColumn({ name: 'witness_user_id', type: 'uuid' })
  witnessUserId!: string;

  @PrimaryColumn({ name: 'witness_role', type: 'varchar', length: 32 })
  witnessRole!: 'legal_counsel' | 'auditor' | 'security_lead';

  @Column({ name: 'witness_signature', type: 'bytea' })
  witnessSignature!: Buffer;

  @Column({ name: 'signed_at', type: 'timestamptz' })
  signedAt!: Date;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
