/**
 * @module EmbeddingsMetadata
 * @description Tracks embedding model versions for the vector search pipeline.
 * Used to detect when re-embedding is needed after model upgrades. Only one
 * version per model can be active (enforced by UNIQUE constraint).
 * @see ADR-012 section 12.1 (Embedding Pipeline)
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Unique,
} from 'typeorm';
import { ObjectType, Field, ID, Int } from '@nestjs/graphql';

@ObjectType()
@Entity('embeddings_metadata', { schema: 'messaging' })
@Unique('uq_active_model', ['modelName', 'isActive'])
export class EmbeddingsMetadata {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column({ type: 'varchar', length: 128 })
  modelName!: string;

  @Field()
  @Column({ type: 'varchar', length: 64 })
  modelVersion!: string;

  @Field(() => Int)
  @Column({ type: 'integer' })
  dimension!: number;

  @Field()
  @Column({ type: 'varchar', length: 20 })
  distanceMetric!: string;

  @Field()
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Field()
  @Column({ type: 'boolean', default: true })
  isActive!: boolean;
}
