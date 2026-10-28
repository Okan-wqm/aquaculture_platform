import { ObjectType, Field, ID } from '@nestjs/graphql';
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { colors, PLATFORM_MODULE } from '@aquaculture/shared-contracts';

/**
 * Module Entity
 *
 * Represents a system module that can be assigned to tenants.
 * Each module provides specific functionality (Farm management, HR, etc.)
 */
@ObjectType()
@Entity('modules', { schema: 'auth' })
@Index('IDX_modules_code', ['code'], { unique: true })
export class Module {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /**
   * Unique module code: a code of the module dictionary (`PLATFORM_MODULE`, shared-contracts).
   */
  @Field()
  @Column({ type: 'varchar', unique: true, length: 50 })
  code!: string;

  /**
   * Display name
   */
  @Field()
  @Column({ type: 'varchar', length: 100 })
  name!: string;

  /**
   * Module description
   */
  @Field(() => String, { nullable: true })
  @Column({ type: 'text', nullable: true })
  description?: string | null;

  /**
   * Icon name for UI (e.g., 'fish', 'users', 'microscope')
   */
  @Field(() => String, { nullable: true })
  @Column({ type: 'varchar', length: 50, nullable: true })
  icon?: string | null;

  /**
   * Display color for UI (hex code)
   */
  @Field(() => String, { nullable: true })
  @Column({ type: 'varchar', length: 20, nullable: true })
  color?: string | null;

  /**
   * Module is active and can be assigned to tenants
   */
  @Field()
  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  /**
   * Display order in lists
   */
  @Field()
  @Column({ type: 'int', default: 0 })
  sortOrder!: number;

  /**
   * Default route path (e.g., '/farm/dashboard')
   */
  @Field()
  @Column({ type: 'varchar', length: 100 })
  defaultRoute!: string;

  /**
   * Module features/capabilities (JSON array)
   */
  @Field(() => [String], { nullable: true })
  @Column('simple-array', { nullable: true })
  features!: string[];

  /**
   * Whether this is a core module included in all plans.
   *
   * WHY this stays while `price` left: isCore is catalogue metadata (an
   * enablement/classification flag consumed by the admin module catalogue
   * UI), not a price input. All subscription pricing is billing-owned
   * (platform rule D14): per-module prices live in the module-pricing
   * catalog (admin.module_pricing) and plan/subscription pricing in
   * billing.plans / billing.subscriptions. auth.modules carries catalogue
   * metadata only — see migration 1807200000000-DropModulePriceFromAuthModules.
   */
  @Field(() => Boolean, { nullable: true })
  @Column({ type: 'boolean', default: false, name: 'is_core', nullable: true })
  isCore?: boolean | null;

  @Field()
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Field()
  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;

  // ============================================
  // Static Factory Methods
  // ============================================

  /**
   * The catalogue seed: one row per code of the module dictionary, in its order
   * (`PLATFORM_MODULE`; `tests/invariants/module-dictionary-ssot.spec.ts` holds the two equal).
   */
  static createDefaults(): Partial<Module>[] {
    return [
      {
        code: PLATFORM_MODULE.FARM,
        name: 'Fish Farm Management',
        description:
          'Comprehensive fish farm management: pond management, stock tracking, feeding programs, growth analysis, water quality monitoring, harvest planning, inventory and detailed analytics',
        icon: 'fish',
        color: colors.info[400],
        defaultRoute: '/farm/dashboard',
        sortOrder: 1,
        features: [
          'farms',
          'sites',
          'tanks',
          'batches',
          'species',
          'feeding',
          'growth',
          'water-quality',
          'fish-health',
          'harvest',
          'maintenance',
          'equipment',
          'suppliers',
          'chemicals',
          'feeds',
          'inventory',
          'analytics',
          'reports',
        ],
      },
      {
        code: PLATFORM_MODULE.HR,
        name: 'Human Resources',
        description:
          'Human resources management: personnel tracking, department management, attendance control, leave management, payroll, performance evaluation, training tracking and HR analytics',
        icon: 'users',
        color: colors.accent[400],
        defaultRoute: '/hr/dashboard',
        sortOrder: 2,
        features: [
          'employees',
          'departments',
          'attendance',
          'leaves',
          'payroll',
          'performance',
          'training',
          'certifications',
          'scheduling',
          'analytics',
          'reports',
        ],
      },
      {
        code: PLATFORM_MODULE.SENSOR,
        name: 'Sensor Monitoring',
        description:
          'IoT sensor management, real-time data monitoring, alerts and analytics',
        icon: 'activity',
        color: colors.info[300],
        defaultRoute: '/sensor/dashboard',
        sortOrder: 3,
        features: [
          'devices',
          'readings',
          'alerts',
          'calibration',
          'thresholds',
          'analytics',
          'trends',
          'reports',
        ],
      },
      {
        code: PLATFORM_MODULE.HYDROPONICS,
        name: 'Hydroponics Management',
        description:
          'Hydroponic system management: growing systems, nutrient solutions, growing beds, climate control, harvest tracking and analytics',
        icon: 'sprout',
        color: colors.success[500],
        defaultRoute: '/hydroponics/setup',
        sortOrder: 4,
        features: [
          'systems',
          'nutrients',
          'growing-beds',
          'climate',
          'harvest',
          'analytics',
        ],
      },
      {
        code: PLATFORM_MODULE.ALERT,
        name: 'Alert Engine',
        description:
          'Real-time alert rules, incident management, escalation policies, and alert history for proactive monitoring',
        icon: 'bell',
        color: colors.error[500],
        defaultRoute: '/alerts/dashboard',
        sortOrder: 5,
        features: [
          'rules',
          'incidents',
          'escalation',
          'history',
          'notifications',
        ],
      },
      {
        code: PLATFORM_MODULE.AI,
        name: 'AI Analytics',
        description:
          'AI-powered analytics: conversational agents, predictive insights, anomaly detection, and intelligent recommendations',
        icon: 'brain',
        color: colors.accent[300],
        defaultRoute: '/ai/dashboard',
        sortOrder: 6,
        features: [
          'agents',
          'predictions',
          'anomaly-detection',
          'recommendations',
          'analytics',
        ],
      },
    ];
  }
}
