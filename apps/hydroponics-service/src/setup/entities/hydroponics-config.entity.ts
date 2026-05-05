import { ObjectType, Field, ID } from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-scalars';
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  Unique,
} from 'typeorm';

@ObjectType()
@Entity('hydroponics_config')
@Unique(['tenantId', 'configName'])
export class HydroponicsConfig {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column({ type: 'uuid', name: 'tenant_id' })
  @Index()
  tenantId!: string;

  @Field()
  @Column({ type: 'varchar', length: 255, name: 'config_name', default: 'Default' })
  configName!: string;

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', default: '{}' })
  settings!: Record<string, unknown>;

  @Field()
  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @Field()
  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
