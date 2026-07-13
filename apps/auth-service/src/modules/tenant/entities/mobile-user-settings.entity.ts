import { ObjectType, Field, ID } from '@nestjs/graphql';
import GraphQLJSON from 'graphql-type-json';
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Allowed mobile features configuration
 */
/**
 * WHY: Explicit GraphQL ObjectType ensures the mobile app receives a strongly-typed
 * feature map. Each boolean flag controls a specific mobile app capability.
 * New features (transfer, schedule, attendance, leave, tasks) were added to support
 * the complete field worker workflow — from tank operations to HR self-service.
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

  /** WHY: Transfer between tanks is a core field operation alongside mortality/harvest */
  @Field(() => Boolean, { defaultValue: true })
  transfer!: boolean;

  /** WHY: Field workers need their shift schedule on mobile */
  @Field(() => Boolean, { defaultValue: true })
  schedule!: boolean;

  /** WHY: Clock-in/out is the primary reason field workers open the app daily */
  @Field(() => Boolean, { defaultValue: true })
  attendance!: boolean;

  /** WHY: Leave requests from the field prevent unnecessary office visits */
  @Field(() => Boolean, { defaultValue: true })
  leave!: boolean;

  /** WHY: Task assignments drive daily operational workflow on-site */
  @Field(() => Boolean, { defaultValue: true })
  tasks!: boolean;

  /** WHY: Warehouse staff need mobile stock entry (receive, dispense, transfer, count)
      from the warehouse floor without returning to a desktop computer. */
  @Field(() => Boolean, { defaultValue: true })
  storage!: boolean;

  /** WHY (FARM-HIGH-214): weekly lakselus counts happen AT the pen — field capture
      writes the lice_counts SSoT the Mattilsynet assembler reads. */
  @Field(() => Boolean, { defaultValue: true })
  liceCount!: boolean;

  /** WHY (FARM-HIGH-214): welfare scoring (gill/fin/wound/deformity) is a physical
      fish-sample inspection performed tank-side. */
  @Field(() => Boolean, { defaultValue: true })
  welfare!: boolean;

  /** WHY (FARM-HIGH-214): escape detection happens in the field and the rømming
      varsling is legally immediate — capture must not wait for a desktop. */
  @Field(() => Boolean, { defaultValue: true })
  escape!: boolean;

  /** WHY (FARM-HIGH-214): managers review/approve scheduled report drafts from
      mobile (online-only). The client also enforces a MODULE_MANAGER role floor
      mirroring the draft resolver's @Roles matrix. */
  @Field(() => Boolean, { defaultValue: true })
  reports!: boolean;
}

/**
 * WHY: All core operational features enabled by default for new users.
 * Tenant admin can restrict per-user via the AccessType settings UI.
 * waterQuality remains false — it requires specialized sensor training.
 */
/**
 * Default mobile feature flags for newly created users.
 * All core aquaculture operations default to true — warehouse staff and
 * field workers need immediate access without admin configuration.
 * waterQuality and storage were previously false but are now enabled
 * because they are core operational features, not optional add-ons.
 */
export const DEFAULT_MOBILE_FEATURES: MobileAllowedFeatures = {
  mortality: true,
  cull: true,
  harvest: true,
  feeding: true,
  waterQuality: true,
  tankView: true,
  transfer: true,
  schedule: true,
  attendance: true,
  leave: true,
  tasks: true,
  storage: true,
  liceCount: true,
  welfare: true,
  escape: true,
  reports: true,
};

/**
 * Per-user mobile access settings
 * Controls which features a user can access on the AquaMobil PWA
 */
@ObjectType('MobileUserSettings')
@Entity('mobile_user_settings', { schema: 'auth' })
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
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Field(() => Date)
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
