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

/**
 * The module a department belongs to — the workspaces whose Team area lists
 * only their own people. A department with no module is company-wide.
 *
 * Values are tenant module codes (auth-service `ModuleCode`); the subset
 * relation is pinned by `tests/invariants/hr-module-code-parity.spec.ts`.
 * An employee carries no module of their own: it is read through their
 * department, so the two cannot disagree.
 */
export enum HrModuleCode {
  FARM = 'farm',
  HYDROPONICS = 'hydroponics',
  SENSOR = 'sensor',
}

registerEnumType(HrModuleCode, {
  name: 'HRModuleCode',
  description: 'Module a department belongs to; unset means company-wide',
});
