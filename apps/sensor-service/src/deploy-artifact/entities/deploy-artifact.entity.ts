import { ObjectType, Field, ID, Int, registerEnumType } from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-scalars';
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  Index,
  CreateDateColumn,
} from 'typeorm';

export enum DeployArtifactType {
  SCADA_PACKAGE = 'scada_package',
  PROCESS = 'process',
  AUTOMATION_PROGRAM = 'automation_program',
}

registerEnumType(DeployArtifactType, {
  name: 'DeployArtifactType',
  description: 'Kind of deployable artifact snapshotted in the content-addressed store',
});

/**
 * Content-addressed, IMMUTABLE deploy artifact snapshot (enterprise plan
 * Faz 3). Every deploy persists the exact payload it shipped, keyed by the
 * sha256 of its canonical JSON — identical content dedupes to the same row,
 * and rollback becomes "republish artifact N" instead of relying on the
 * edge's single previous-version slot.
 *
 * Rows are NEVER updated or deleted by application code
 * (`artifact-immutability.spec.ts` pins this). Per-tenant table — no
 * `schema:` (ADR-011 search_path routing).
 */
@ObjectType()
@Entity('deploy_artifacts')
@Index(['tenantId', 'contentSha256'], { unique: true })
@Index(['tenantId', 'artifactType', 'sourceEntityId'])
export class DeployArtifact {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column({ type: 'uuid', name: 'tenant_id' })
  @Index()
  tenantId!: string;

  @Field(() => DeployArtifactType)
  @Column({ name: 'artifact_type', type: 'enum', enum: DeployArtifactType })
  artifactType!: DeployArtifactType;

  /** sha256 (hex) of the canonical JSON serialization of `content`. */
  @Field()
  @Column({ name: 'content_sha256', type: 'char', length: 64 })
  contentSha256!: string;

  /** The exact deploy payload as shipped. */
  @Field(() => GraphQLJSON)
  @Column({ type: 'jsonb' })
  content!: Record<string, unknown>;

  /** Document contract version of the content (e.g. ScadaPackageDocV2 = 2). */
  @Field(() => Int, { nullable: true })
  @Column({ name: 'schema_version', type: 'int', nullable: true })
  schemaVersion?: number;

  /** The source entity this snapshot was taken from (package/process/program id). */
  @Field(() => ID, { nullable: true })
  @Column({ name: 'source_entity_id', type: 'uuid', nullable: true })
  sourceEntityId?: string;

  /** The source entity's version counter at snapshot time. */
  @Field(() => Int, { nullable: true })
  @Column({ name: 'source_entity_version', type: 'int', nullable: true })
  sourceEntityVersion?: number;

  @Field({ nullable: true })
  @Column({ name: 'created_by', nullable: true })
  createdBy?: string;

  @Field()
  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
