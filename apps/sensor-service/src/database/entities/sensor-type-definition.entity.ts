import {
  ObjectType,
  Field,
  ID,
} from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-scalars';
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/**
 * SensorTypeDefinition entity - tenant-scoped dynamic sensor type definitions.
 * Allows each tenant to define custom sensor types beyond the built-in enum.
 */
@ObjectType()
@Entity('sensor_type_definitions', { schema: 'sensor' })
@Index(['tenantId', 'typeKey'], { unique: true })
export class SensorTypeDefinition {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Field()
  @Column({ name: 'type_key', length: 100 })
  typeKey!: string;

  @Field()
  @Column({ name: 'display_name', length: 200 })
  displayName!: string;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  description?: string;

  @Field({ nullable: true })
  @Column({ length: 100, nullable: true })
  icon?: string;

  @Field({ nullable: true })
  @Column({ length: 100, nullable: true })
  category?: string;

  @Field({ nullable: true })
  @Column({ length: 100, nullable: true })
  industry?: string;

  @Field()
  @Column({ name: 'is_system', default: false })
  isSystem!: boolean;

  @Field(() => GraphQLJSON)
  @Column({ name: 'default_channels', type: 'jsonb', default: '[]' })
  defaultChannels!: unknown[];

  @Field(() => GraphQLJSON)
  @Column({ type: 'jsonb', default: '{}' })
  metadata!: Record<string, unknown>;

  @Field()
  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @Field()
  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
