import {
  ConfigurationChangeIntentV1,
  ConfigurationKeyId,
  ConfigurationStoredStateV1,
} from '@aquaculture/configuration-contracts';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { ConfigEnvironment } from './configuration.entity';

@Entity('configuration_scopes', { schema: 'config' })
export class ConfigurationScope {
  @PrimaryColumn({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @PrimaryColumn({ type: 'enum', enum: ConfigEnvironment })
  environment!: ConfigEnvironment;

  @Column({ type: 'bigint', default: '0' })
  revision!: string;

  @Column({ type: 'timestamptz', name: 'updated_at', default: () => 'CURRENT_TIMESTAMP' })
  updatedAt!: Date;
}

@Entity('configuration_operation_receipts', { schema: 'config' })
@Index(['tenantId', 'createdAt'])
export class ConfigurationOperationReceipt {
  @PrimaryColumn({ type: 'uuid', name: 'operation_id' })
  operationId!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'enum', enum: ConfigEnvironment })
  environment!: ConfigEnvironment;

  @Column({ type: 'char', length: 64, name: 'request_digest' })
  requestDigest!: string;

  @Column({ type: 'char', length: 64, name: 'catalog_digest' })
  catalogDigest!: string;

  @Column({ type: 'char', length: 64, name: 'previous_snapshot_token' })
  previousSnapshotToken!: string;

  @Column({ type: 'char', length: 64, name: 'resulting_snapshot_token' })
  resultingSnapshotToken!: string;

  @Column({ type: 'bigint', name: 'resulting_scope_revision' })
  resultingScopeRevision!: string;

  @Column({ type: 'varchar', length: 100, name: 'actor_id' })
  actorId!: string;

  @Column({ type: 'varchar', length: 255 })
  reason!: string;

  @Column({ type: 'jsonb', name: 'receipt_payload' })
  receiptPayload!: Record<string, unknown>;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}

@Entity('configuration_change_journal', { schema: 'config' })
@Index(['operationId', 'sequence'])
@Index(['tenantId', 'catalogId', 'sequence'])
export class ConfigurationChangeJournal {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  sequence!: string;

  @Column({ type: 'uuid', name: 'operation_id' })
  operationId!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'varchar', length: 64, name: 'catalog_id' })
  catalogId!: ConfigurationKeyId;

  @Column({ type: 'varchar', length: 32 })
  intent!: ConfigurationChangeIntentV1;

  @Column({ type: 'varchar', length: 32, name: 'previous_state' })
  previousState!: ConfigurationStoredStateV1;

  @Column({ type: 'varchar', length: 32, name: 'new_state' })
  newState!: ConfigurationStoredStateV1;

  @Column({ type: 'char', length: 64, nullable: true, name: 'previous_value_digest' })
  previousValueDigest!: string | null;

  @Column({ type: 'char', length: 64, nullable: true, name: 'new_value_digest' })
  newValueDigest!: string | null;

  @Column({ type: 'integer', nullable: true, name: 'previous_version' })
  previousVersion!: number | null;

  @Column({ type: 'integer', nullable: true, name: 'new_version' })
  newVersion!: number | null;

  @Column({ type: 'varchar', length: 100, name: 'actor_id' })
  actorId!: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}
