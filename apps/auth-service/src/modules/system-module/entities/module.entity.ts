import { ObjectType, Field, ID, registerEnumType } from '@nestjs/graphql';
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/**
 * Available module codes in the system
 * Updated: 3 core modules only (Farm, HR, Sensor)
 */
export enum ModuleCode {
  FARM = 'farm',
  HR = 'hr',
  SENSOR = 'sensor',
}

registerEnumType(ModuleCode, {
  name: 'ModuleCode',
  description: 'Available module codes',
});

/**
 * Module Entity
 *
 * Represents a system module that can be assigned to tenants.
 * Each module provides specific functionality (Farm management, HR, etc.)
 */
@ObjectType()
@Entity('modules')
@Index('IDX_modules_code', ['code'], { unique: true })
export class Module {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * Unique module code (farm, hr, seapod, etc.)
   */
  @Field()
  @Column({ type: 'varchar', unique: true, length: 50 })
  code: string;

  /**
   * Display name
   */
  @Field()
  @Column({ type: 'varchar', length: 100 })
  name: string;

  /**
   * Module description
   */
  @Field(() => String, { nullable: true })
  @Column({ type: 'text', nullable: true })
  description: string | null;

  /**
   * Icon name for UI (e.g., 'fish', 'users', 'microscope')
   */
  @Field(() => String, { nullable: true })
  @Column({ type: 'varchar', length: 50, nullable: true })
  icon: string | null;

  /**
   * Display color for UI (hex code)
   */
  @Field(() => String, { nullable: true })
  @Column({ type: 'varchar', length: 20, nullable: true })
  color: string | null;

  /**
   * Module is active and can be assigned to tenants
   */
  @Field()
  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  /**
   * Display order in lists
   */
  @Field()
  @Column({ type: 'int', default: 0 })
  sortOrder: number;

  /**
   * Default route path (e.g., '/farm/dashboard')
   */
  @Field()
  @Column({ type: 'varchar', length: 100 })
  defaultRoute: string;

  /**
   * Module features/capabilities (JSON array)
   */
  @Field(() => [String], { nullable: true })
  @Column('simple-array', { nullable: true })
  features: string[];

  /**
   * Base price for this module (pricing details in module_pricing table)
   */
  @Field(() => Number, { nullable: true })
  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0, nullable: true })
  price: number | null;

  /**
   * Whether this is a core module included in all plans
   */
  @Field(() => Boolean, { nullable: true })
  @Column({ type: 'boolean', default: false, name: 'is_core', nullable: true })
  isCore: boolean | null;

  @Field()
  @CreateDateColumn()
  createdAt: Date;

  @Field()
  @UpdateDateColumn()
  updatedAt: Date;

  // ============================================
  // Static Factory Methods
  // ============================================

  /**
   * Create default modules for seeding
   * Updated: 3 core modules (Farm, HR, Sensor)
   */
  static createDefaults(): Partial<Module>[] {
    return [
      {
        code: ModuleCode.FARM,
        name: 'Fish Farm Management',
        description:
          'Comprehensive fish farm management: pond management, stock tracking, feeding programs, growth analysis, water quality monitoring, harvest planning, inventory and detailed analytics',
        icon: 'fish',
        color: '#0EA5E9',
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
        code: ModuleCode.HR,
        name: 'Human Resources',
        description:
          'Human resources management: personnel tracking, department management, attendance control, leave management, payroll, performance evaluation, training tracking and HR analytics',
        icon: 'users',
        color: '#8B5CF6',
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
        code: ModuleCode.SENSOR,
        name: 'Sensor Monitoring',
        description:
          'IoT sensor management, real-time data monitoring, alerts and analytics',
        icon: 'activity',
        color: '#06B6D4',
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
    ];
  }
}
