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
  UpdateDateColumn,
} from 'typeorm';

export enum DeploymentStatus {
  PENDING = 'pending',
  DEPLOYING = 'deploying',
  SUCCESS = 'success',
  FAILED = 'failed',
  ROLLED_BACK = 'rolled_back',
}

registerEnumType(DeploymentStatus, {
  name: 'DeploymentStatus',
  description: 'Status of a program deployment to edge device',
});

@ObjectType()
@Entity('deployment_logs')
@Index(['tenantId', 'deviceId'])
@Index(['tenantId', 'programId'])
@Index(['commandId'], { unique: true })
export class DeploymentLog {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Field()
  @Column({ type: 'uuid', name: 'program_id' })
  programId!: string;

  @Field()
  @Column({ type: 'uuid', name: 'device_id' })
  deviceId!: string;

  @Field()
  @Column({ type: 'uuid', name: 'command_id' })
  commandId!: string;

  @Field(() => Int)
  @Column({ name: 'version', type: 'int' })
  version!: number;

  @Field(() => DeploymentStatus)
  @Column({ name: 'status', type: 'enum', enum: DeploymentStatus, default: DeploymentStatus.PENDING })
  status!: DeploymentStatus;

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ name: 'edge_script', type: 'jsonb', nullable: true })
  edgeScript?: Record<string, unknown>;

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
  @Column({ name: 'deployed_at', type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  deployedAt!: Date;

  @Field({ nullable: true })
  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt?: Date;

  @Field({ nullable: true })
  @Column({ name: 'edge_ack_at', type: 'timestamptz', nullable: true })
  edgeAckAt?: Date;

  @Field({ nullable: true })
  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage?: string;

  @Field({ nullable: true })
  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt?: Date;
}
