// Shared enums for HR service
import { registerEnumType } from '@nestjs/graphql';

// Aquaculture-specific: Work Area Types
export enum WorkAreaType {
  SHORE_FACILITY = 'shore_facility',
  SEA_CAGE = 'sea_cage',
  FLOATING_PLATFORM = 'floating_platform',
  VESSEL = 'vessel',
  FEED_BARGE = 'feed_barge',
  PROCESSING_PLANT = 'processing_plant',
  HATCHERY = 'hatchery',
  LABORATORY = 'laboratory',
  OFFICE = 'office',
  WAREHOUSE = 'warehouse',
  WORKSHOP = 'workshop',
  OTHER = 'other',
}

// Register enum once for GraphQL
registerEnumType(WorkAreaType, { name: 'WorkAreaType' });
