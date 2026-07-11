import { ObjectType, Field, ID, registerEnumType } from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-scalars';
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  Index,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

import { DeployArtifactType } from '../../deploy-artifact/entities/deploy-artifact.entity';

/**
 * Release-bundle lifecycle (enterprise plan Faz 5).
 *
 * ```text
 *  PENDING ──► STAGED ──► CONFIRMED ──► ROLLED_BACK
 *     │           │
 *     ▼           ▼
 *  FAILED      FAILED
 * ```
 *
 * PENDING     — row committed (with the outbox event, same transaction);
 *               the edge has not acknowledged staging yet.
 * STAGED      — edge verified manifest signature + every artifact
 *               checksum and reported the bundle staged (nothing applied).
 * CONFIRMED   — edge applied every artifact atomically under its deploy
 *               lock and acked success.
 * FAILED      — verification or apply failed (terminal; the edge applies
 *               nothing on verification failure).
 * ROLLED_BACK — a later bundle republished this bundle's predecessor
 *               content (terminal).
 *
 * The transition map in `release-bundle.service.ts` is the SSoT for
 * which edges exist — every status write goes through it.
 */
export enum ReleaseBundleStatus {
  PENDING = 'pending',
  STAGED = 'staged',
  CONFIRMED = 'confirmed',
  FAILED = 'failed',
  ROLLED_BACK = 'rolled_back',
}

registerEnumType(ReleaseBundleStatus, {
  name: 'ReleaseBundleStatus',
  description: 'Two-phase release bundle lifecycle state',
});

/** One artifact reference inside a bundle manifest. */
export interface ReleaseBundleArtifactRef {
  artifactId: string;
  kind: DeployArtifactType;
  sha256: string;
  /** Source entity (package/program id) for post-ack status fan-out. */
  sourceEntityId?: string;
  /** Per-artifact deploy-log correlation id (DeploymentLog/ScadaDeployLog). */
  logCommandId?: string;
  /** Source entity's version at build time (edge stamps it into applied meta). */
  version?: number;
}

/** The signed manifest content (canonical JSON of this is what's hashed). */
export interface ReleaseBundleManifest {
  bundleId: string;
  artifacts: ReleaseBundleArtifactRef[];
}

/**
 * A two-phase release bundle shipped to one edge device (Faz 5).
 * Per-tenant table — no `schema:` (ADR-011 search_path routing).
 */
@ObjectType()
@Entity('release_bundles')
@Index(['tenantId', 'commandId'], { unique: true })
@Index(['tenantId', 'deviceId', 'status'])
export class ReleaseBundle {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column({ type: 'uuid', name: 'tenant_id' })
  @Index()
  tenantId!: string;

  @Field(() => ID)
  @Column({ type: 'uuid', name: 'device_id' })
  deviceId!: string;

  /** MQTT command correlation id — the edge acks carry this back. */
  @Field(() => ID)
  @Column({ type: 'uuid', name: 'command_id' })
  commandId!: string;

  /** Signed manifest: bundleId + per-artifact {kind, artifactId, sha256}. */
  @Field(() => GraphQLJSON)
  @Column({ type: 'jsonb' })
  manifest!: ReleaseBundleManifest;

  /** sha256 (hex) of the canonical JSON of `manifest` — the signed value. */
  @Field()
  @Column({ name: 'manifest_sha256', type: 'char', length: 64 })
  manifestSha256!: string;

  /** ed25519 signature (hex) over tenant + manifestSha256, domain tag bundle-v1. */
  @Field({ nullable: true })
  @Column({ type: 'varchar', length: 128, nullable: true })
  signature?: string;

  @Field(() => ReleaseBundleStatus)
  @Column({ type: 'enum', enum: ReleaseBundleStatus, default: ReleaseBundleStatus.PENDING })
  status!: ReleaseBundleStatus;

  /** The device's previously CONFIRMED bundle at build time (rollback anchor). */
  @Field(() => ID, { nullable: true })
  @Column({ name: 'previous_bundle_id', type: 'uuid', nullable: true })
  previousBundleId?: string;

  @Field({ nullable: true })
  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage?: string;

  @Field({ nullable: true })
  @Column({ name: 'staged_at', type: 'timestamptz', nullable: true })
  stagedAt?: Date;

  @Field({ nullable: true })
  @Column({ name: 'confirmed_at', type: 'timestamptz', nullable: true })
  confirmedAt?: Date;

  @Field({ nullable: true })
  @Column({ name: 'failed_at', type: 'timestamptz', nullable: true })
  failedAt?: Date;

  @Field({ nullable: true })
  @Column({ name: 'created_by', nullable: true })
  createdBy?: string;

  @Field()
  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @Field()
  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
