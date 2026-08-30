import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';
import { ObjectType, Field, ID, Float, Int } from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-scalars';

import { VfdCommandType } from './vfd.enums';

/**
 * VFD Runtime Control-Command Audit Log (DB-SENSOR-HIGH-003).
 *
 * Immutable provenance record for every runtime control command dispatched to a
 * VFD (START/STOP/SET_FREQUENCY/EMERGENCY_STOP/…). Before this table existed,
 * an actuator command left only a `logger.log` line — no durable who/when/what/
 * result, a forensic + IEC 62443 gap for industrial control writes. Mirrors
 * `vfd_parameter_audit_logs` (the parameter-programming audit) but for runtime
 * commands, which do not mutate the `vfd_devices` row and so are invisible to
 * the entity's `@Auditable()` row-CRUD trail.
 *
 * Cross-tenant audit ledger (ADR-011): one table in the `sensor` schema
 * discriminated by `tenant_id`, NOT per-tenant cloned — the platform convention
 * for audit/outbox/retention ledgers (enforced by entity-schema-declaration +
 * tenant-fanout-entity-parity invariants). Registered in
 * MODULE_SCHEMAS['sensor'].infrastructureTables. No `UpdateDateColumn` — audit
 * rows are never modified after creation.
 */
@ObjectType({ description: 'Immutable VFD runtime control-command audit log' })
@Entity('vfd_command_audit_logs', { schema: 'sensor' })
@Index(['tenantId', 'vfdDeviceId', 'timestamp'])
export class VfdCommandAuditLog {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Field()
  @Column({ type: 'uuid', name: 'vfd_device_id' })
  vfdDeviceId!: string;

  @Field(() => VfdCommandType)
  @Column({ type: 'varchar', length: 30 })
  command!: VfdCommandType;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'numeric', precision: 15, scale: 6, nullable: true })
  value?: number;

  @Field()
  @Column({ type: 'boolean' })
  success!: boolean;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  error?: string;

  /** Actor identity (user id) or a system origin token (e.g. 'automation-rule'). */
  @Field()
  @Column({ type: 'varchar', length: 255, name: 'performed_by' })
  performedBy!: string;

  @Field({ nullable: true })
  @Column({ type: 'varchar', length: 255, name: 'performed_by_email', nullable: true })
  performedByEmail?: string;

  /** Where the command originated: 'operator' (GraphQL mutation), 'automation', 'system'. */
  @Field()
  @Column({ type: 'varchar', length: 30, default: 'operator' })
  source!: string;

  @Field(() => Int, { nullable: true })
  @Column({ type: 'integer', name: 'latency_ms', nullable: true })
  latencyMs?: number;

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, unknown>;

  @Field()
  @CreateDateColumn({ type: 'timestamp with time zone' })
  timestamp!: Date;
}
