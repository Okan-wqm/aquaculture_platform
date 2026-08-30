import {
  ObjectType,
  Field,
  ID,
  Int,
  registerEnumType,
} from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-scalars';
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  Index,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum ScadaDeployStatus {
  PENDING = 'pending',
  SENT = 'sent',
  RECEIVED = 'received',
  DEPLOYING = 'deploying',
  VERIFYING = 'verifying',
  SUCCESS = 'success',
  FAILED = 'failed',
  ROLLED_BACK = 'rolled_back',
  /** WF-011: undeploy command published to the device (delete flow). */
  UNDEPLOY_SENT = 'undeploy_sent',
  /** WF-011: device acked that the package was cleared. */
  UNDEPLOYED = 'undeployed',
}

registerEnumType(ScadaDeployStatus, {
  name: 'ScadaDeployStatus',
  description: 'Status of a SCADA package deployment to edge device',
});

@ObjectType()
@Entity('scada_deploy_logs')
@Index(['tenantId', 'deviceId'])
@Index(['tenantId', 'packageId'])
@Index(['tenantId', 'commandId'], { unique: true })
export class ScadaDeployLog {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  /** Nullable since Faz 3: a log row targets a package OR a process (DB CHECK enforces at least one). */
  @Field(() => ID, { nullable: true })
  @Column({ type: 'uuid', name: 'package_id', nullable: true })
  packageId?: string;

  /** Process-diagram deploys log here too (Faz 3 — they previously logged nothing). */
  @Field(() => ID, { nullable: true })
  @Column({ type: 'uuid', name: 'process_id', nullable: true })
  processId?: string;

  @Field()
  @Column({ type: 'uuid', name: 'device_id' })
  deviceId!: string;

  @Field()
  @Column({ type: 'uuid', name: 'command_id' })
  commandId!: string;

  @Field(() => Int)
  @Column({ name: 'version', type: 'int' })
  version!: number;

  @Field(() => ScadaDeployStatus)
  @Column({ name: 'status', type: 'enum', enum: ScadaDeployStatus, default: ScadaDeployStatus.PENDING })
  status!: ScadaDeployStatus;

  @Field()
  @Column({ name: 'sent_at', type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  sentAt!: Date;

  @Field({ nullable: true })
  @Column({ name: 'received_at', type: 'timestamptz', nullable: true })
  receivedAt?: Date;

  @Field({ nullable: true })
  @Column({ name: 'deployed_at', type: 'timestamptz', nullable: true })
  deployedAt?: Date;

  @Field({ nullable: true })
  @Column({ name: 'verified_at', type: 'timestamptz', nullable: true })
  verifiedAt?: Date;

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ name: 'health_check_results', type: 'jsonb', nullable: true })
  healthCheckResults?: Record<string, unknown>;

  @Field({ nullable: true })
  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage?: string;

  @Field(() => Int, { nullable: true })
  @Column({ name: 'rolled_back_to', type: 'int', nullable: true })
  rolledBackTo?: number;

  /** Content-addressed snapshot this deploy shipped (deploy_artifacts.id). */
  @Field(() => ID, { nullable: true })
  @Column({ name: 'artifact_id', type: 'uuid', nullable: true })
  artifactId?: string;

  /** sha256 of the shipped payload's canonical JSON. */
  @Field({ nullable: true })
  @Column({ name: 'checksum_sha256', type: 'char', length: 64, nullable: true })
  checksumSha256?: string;

  @Field({ nullable: true })
  @Column({ name: 'deployed_by', nullable: true })
  deployedBy?: string;

  @Field()
  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @Field({ nullable: true })
  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt?: Date;
}
