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
} from 'typeorm';

/**
 * IndustryTemplate entity - predefined templates for different industries.
 * Each template bundles sensor types, dashboard layouts, and alert presets.
 */
@ObjectType()
@Entity('industry_templates')
export class IndustryTemplate {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column({ name: 'template_key', length: 100, unique: true })
  templateKey!: string;

  @Field()
  @Column({ name: 'display_name', length: 200 })
  displayName!: string;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  description?: string;

  @Field({ nullable: true })
  @Column({ length: 100, nullable: true })
  icon?: string;

  @Field(() => GraphQLJSON)
  @Column({ name: 'sensor_types', type: 'jsonb', default: '[]' })
  sensorTypes!: unknown[];

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ name: 'dashboard_layout', type: 'jsonb', nullable: true })
  dashboardLayout?: Record<string, unknown>;

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ name: 'alert_presets', type: 'jsonb', nullable: true })
  alertPresets?: Record<string, unknown>;

  @Field()
  @Column({ name: 'is_active', default: true })
  isActive!: boolean;

  @Field()
  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
