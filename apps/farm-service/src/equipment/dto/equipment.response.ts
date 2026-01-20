/**
 * Equipment Response Types for GraphQL
 */
import { ObjectType, Field, Int, Float, ID, registerEnumType } from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-type-json';
import { EquipmentStatus } from '../entities/equipment.entity';
import { EquipmentCategory } from '../entities/equipment-type.entity';
import { DepartmentResponse } from '../../department/dto/department.response';

// Register enums for GraphQL
registerEnumType(EquipmentStatus, {
  name: 'EquipmentStatus',
  description: 'Status of the equipment',
});

registerEnumType(EquipmentCategory, {
  name: 'EquipmentCategory',
  description: 'Category of equipment type',
});

@ObjectType()
export class SpecificationFieldResponse {
  @Field()
  name: string;

  @Field()
  label: string;

  @Field()
  type: string;

  @Field({ nullable: true })
  required?: boolean;

  @Field({ nullable: true })
  unit?: string;

  @Field(() => GraphQLJSON, { nullable: true })
  options?: Array<{ value: string; label: string }>;

  @Field({ nullable: true })
  defaultValue?: string;

  @Field({ nullable: true })
  min?: number;

  @Field({ nullable: true })
  max?: number;

  @Field({ nullable: true })
  placeholder?: string;

  @Field({ nullable: true })
  group?: string;
}

@ObjectType()
export class EquipmentTypeResponse {
  @Field(() => ID)
  id: string;

  @Field()
  name: string;

  @Field()
  code: string;

  @Field(() => EquipmentCategory)
  category: EquipmentCategory;

  @Field({ nullable: true })
  description?: string;

  @Field({ nullable: true })
  icon?: string;

  @Field(() => GraphQLJSON, { nullable: true })
  specificationSchema?: Record<string, unknown>;

  @Field(() => [SpecificationFieldResponse], { nullable: true })
  specificationFields?: SpecificationFieldResponse[];

  @Field(() => Int, { nullable: true, description: 'Display order in lists' })
  sortOrder?: number;

  @Field()
  isActive: boolean;

  @Field()
  createdAt: Date;

  @Field()
  updatedAt: Date;
}

@ObjectType()
export class EquipmentSystemResponse {
  @Field(() => ID)
  id: string;

  @Field(() => ID)
  systemId: string;

  @Field({ nullable: true })
  systemName?: string;

  @Field({ nullable: true })
  systemCode?: string;

  @Field({ nullable: true })
  isPrimary?: boolean;

  @Field({ nullable: true })
  role?: string;

  @Field(() => Int, { nullable: true })
  criticalityLevel?: number;

  @Field({ nullable: true })
  notes?: string;
}

/**
 * Batch metrics info for equipment (tank/pond/cage) display
 */
@ObjectType()
export class EquipmentBatchMetrics {
  @Field({ nullable: true })
  batchNumber?: string;

  @Field({ nullable: true })
  batchId?: string;

  @Field(() => Int, { nullable: true })
  pieces?: number;

  @Field(() => Float, { nullable: true })
  avgWeight?: number;

  @Field(() => Float, { nullable: true })
  biomass?: number;

  @Field(() => Float, { nullable: true })
  density?: number;

  @Field(() => Float, { nullable: true })
  capacityUsedPercent?: number;

  @Field({ nullable: true })
  isOverCapacity?: boolean;

  @Field({ nullable: true })
  isMixedBatch?: boolean;

  @Field({ nullable: true })
  lastFeedingAt?: Date;

  @Field({ nullable: true })
  lastSamplingAt?: Date;

  @Field({ nullable: true })
  lastMortalityAt?: Date;

  @Field(() => Int, { nullable: true })
  daysSinceStocking?: number;

  // Mortality & Performance metrics
  @Field(() => Int, { nullable: true, description: 'Initial quantity when batch was stocked' })
  initialQuantity?: number;

  @Field(() => Int, { nullable: true, description: 'Total mortality count' })
  totalMortality?: number;

  @Field(() => Float, { nullable: true, description: 'Mortality rate percentage' })
  mortalityRate?: number;

  @Field(() => Float, { nullable: true, description: 'Survival rate percentage' })
  survivalRate?: number;

  @Field(() => Int, { nullable: true, description: 'Total cull count' })
  totalCull?: number;

  @Field(() => Float, { nullable: true, description: 'Feed Conversion Ratio' })
  fcr?: number;

  @Field(() => Float, { nullable: true, description: 'Specific Growth Rate' })
  sgr?: number;

  // Cleaner Fish metrics
  @Field(() => Int, { nullable: true, description: 'Cleaner fish count in tank' })
  cleanerFishQuantity?: number;

  @Field(() => Float, { nullable: true, description: 'Cleaner fish biomass in kg' })
  cleanerFishBiomassKg?: number;

  @Field(() => GraphQLJSON, { nullable: true, description: 'Cleaner fish batch details array' })
  cleanerFishDetails?: unknown[];
}

@ObjectType()
export class EquipmentResponse {
  @Field(() => ID)
  id: string;

  @Field(() => ID)
  tenantId: string;

  @Field(() => ID, { nullable: true })
  departmentId?: string;

  @Field(() => DepartmentResponse, { nullable: true })
  department?: DepartmentResponse;

  @Field(() => ID, { nullable: true })
  siteId?: string;

  @Field(() => [EquipmentSystemResponse], { nullable: true, description: 'Systems this equipment serves (many-to-many)' })
  systems?: EquipmentSystemResponse[];

  @Field(() => [ID], { nullable: true, description: 'System IDs for convenience' })
  systemIds?: string[];

  @Field(() => ID, { nullable: true, description: 'Parent equipment for nested hierarchy' })
  parentEquipmentId?: string;

  @Field(() => EquipmentResponse, { nullable: true })
  parentEquipment?: EquipmentResponse;

  @Field(() => [EquipmentResponse], { nullable: true })
  childEquipment?: EquipmentResponse[];

  @Field(() => Int, { nullable: true, description: 'Number of sub-equipment items' })
  subEquipmentCount?: number;

  @Field(() => ID)
  equipmentTypeId: string;

  @Field(() => EquipmentTypeResponse, { nullable: true })
  equipmentType?: EquipmentTypeResponse;

  @Field()
  name: string;

  @Field()
  code: string;

  @Field({ nullable: true })
  description?: string;

  @Field({ nullable: true })
  serialNumber?: string;

  @Field({ nullable: true })
  model?: string;

  @Field({ nullable: true })
  manufacturer?: string;

  @Field(() => GraphQLJSON, { nullable: true })
  specifications?: Record<string, unknown>;

  @Field({ nullable: true })
  purchaseDate?: Date;

  @Field({ nullable: true })
  installationDate?: Date;

  @Field({ nullable: true })
  warrantyEndDate?: Date;

  @Field(() => Float, { nullable: true })
  purchasePrice?: number;

  @Field(() => EquipmentStatus)
  status: EquipmentStatus;

  @Field({ nullable: true })
  notes?: string;

  // Tank-specific fields (denormalized from specifications for quick access)
  @Field({ nullable: true, description: 'Whether this equipment is a tank' })
  isTank?: boolean;

  @Field(() => Float, { nullable: true, description: 'Tank volume in m³' })
  volume?: number;

  @Field(() => Float, { nullable: true, description: 'Current biomass in kg' })
  currentBiomass?: number;

  @Field(() => Int, { nullable: true, description: 'Current fish count' })
  currentCount?: number;

  @Field(() => GraphQLJSON, { nullable: true, description: 'Physical location info' })
  location?: Record<string, unknown>;

  @Field(() => ID, { nullable: true })
  supplierId?: string;

  @Field()
  isActive: boolean;

  @Field({ nullable: true })
  isVisibleInSensor?: boolean;

  @Field(() => EquipmentBatchMetrics, { nullable: true, description: 'Batch metrics for tanks/ponds/cages' })
  batchMetrics?: EquipmentBatchMetrics;

  @Field(() => ID, { nullable: true })
  createdBy?: string;

  @Field(() => ID, { nullable: true })
  updatedBy?: string;

  @Field()
  createdAt: Date;

  @Field()
  updatedAt: Date;
}

@ObjectType()
export class PaginatedEquipmentResponse {
  @Field(() => [EquipmentResponse])
  items: EquipmentResponse[];

  @Field(() => Int)
  total: number;

  @Field(() => Int)
  page: number;

  @Field(() => Int)
  limit: number;

  @Field(() => Int)
  totalPages: number;
}
