import { ObjectType, Field, ID } from '@nestjs/graphql';
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import GraphQLJSON from 'graphql-type-json';

/**
 * Allowed mobile features configuration
 */
@ObjectType('MobileAllowedFeatures')
export class MobileAllowedFeatures {
  @Field(() => Boolean)
  mortality!: boolean;

  @Field(() => Boolean)
  cull!: boolean;

  @Field(() => Boolean)
  harvest!: boolean;

  @Field(() => Boolean)
  feeding!: boolean;

  @Field(() => Boolean)
  waterQuality!: boolean;

  @Field(() => Boolean)
  tankView!: boolean;
}

/**
 * Default features for new mobile users
 */
export const DEFAULT_MOBILE_FEATURES: MobileAllowedFeatures = {
  mortality: true,
  cull: true,
  harvest: true,
  feeding: false,
  waterQuality: false,
  tankView: true,
};

/**
 * Per-user mobile access settings
 * Controls which features a user can access on the AquaMobil PWA
 */
@ObjectType('MobileUserSettings')
@Entity('mobile_user_settings')
export class MobileUserSettings {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field(() => String)
  @Column({ type: 'uuid', name: 'user_id', unique: true })
  userId!: string;

  @Field(() => String)
  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Field(() => GraphQLJSON)
  @Column({ type: 'jsonb', name: 'allowed_features', default: () => `'${JSON.stringify(DEFAULT_MOBILE_FEATURES)}'` })
  allowedFeatures!: MobileAllowedFeatures;

  @Field(() => Boolean)
  @Column({ type: 'boolean', name: 'is_mobile_enabled', default: true })
  isMobileEnabled!: boolean;

  @Field(() => Date)
  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @Field(() => Date)
  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
