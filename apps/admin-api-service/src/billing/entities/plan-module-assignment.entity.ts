import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
  Unique,
} from 'typeorm';
import { PlanDefinition } from './plan-definition.entity';

/**
 * Included quantities for a module in a plan
 */
export interface IncludedQuantities {
  users?: number;        // Included users
  farms?: number;        // Included farms
  ponds?: number;        // Included ponds
  sensors?: number;      // Included sensors
  devices?: number;      // Included devices
  storageGb?: number;    // Included storage in GB
  apiCalls?: number;     // Included API calls per month
  alerts?: number;       // Included alerts per month
  reports?: number;      // Included reports per month
  integrations?: number; // Included integrations
}

/**
 * Plan-Module Assignment Entity
 *
 * Defines which modules are included in a plan and with what quantities.
 * This creates pre-defined "bundles" of modules for plans.
 *
 * Example: Professional Plan includes
 * - Farm Module: 3 farms, 10 ponds
 * - Sensor Module: 50 sensors, 10GB storage
 * - Alert Module: 1000 alerts
 */
@Entity('plan_module_assignments')
@Index(['planId'])
@Index(['moduleId'])
@Unique(['planId', 'moduleId'])
export class PlanModuleAssignment {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /**
   * Reference to plan definition
   */
  @Column('uuid')
  planId!: string;

  @ManyToOne(() => PlanDefinition, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'plan_id' })
  plan!: PlanDefinition;

  /**
   * Reference to system module (system_modules.id)
   */
  @Column('uuid')
  moduleId!: string;

  /**
   * Module code for convenience
   */
  @Column({ type: 'varchar', length: 50 })
  moduleCode!: string;

  /**
   * Quantities included in this plan for this module
   */
  @Column('jsonb', { default: {} })
  includedQuantities!: IncludedQuantities;

  /**
   * Whether this module is required (always included)
   * vs optional (can be removed by tenant)
   */
  @Column({ default: false })
  isRequired!: boolean;

  /**
   * Whether additional quantities can be purchased
   * beyond the included amounts
   */
  @Column({ default: true })
  allowOverage!: boolean;

  /**
   * Display order in plan details
   */
  @Column({ type: 'int', default: 0 })
  sortOrder!: number;

  /**
   * Special notes about this module in this plan
   */
  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  // ============================================
  // Helper Methods
  // ============================================

  /**
   * Get included quantity for a specific metric
   */
  getIncludedQuantity(metric: keyof IncludedQuantities): number {
    return this.includedQuantities[metric] ?? 0;
  }

  /**
   * Check if a quantity exceeds the included amount
   */
  isOverage(metric: keyof IncludedQuantities, quantity: number): boolean {
    const included = this.getIncludedQuantity(metric);
    return quantity > included;
  }

  /**
   * Calculate overage quantity
   */
  getOverageQuantity(metric: keyof IncludedQuantities, quantity: number): number {
    const included = this.getIncludedQuantity(metric);
    return Math.max(0, quantity - included);
  }
}
