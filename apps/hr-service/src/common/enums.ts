// Shared enums for HR service
import { registerOwnerModuleEnum } from '@aquaculture/backend-common/graphql';
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
 * The GraphQL enum of the module a department belongs to (`HRModuleCode`) — the workspaces whose
 * Team area lists only their own people. A department with no module is company-wide.
 *
 * Its values are the module dictionary's owner modules (`OWNER_MODULE`, shared-contracts), hr
 * included, so an HR-owned unit is no longer forced to NULL (HR-MEDIUM-064); its Postgres labels
 * are held equal to them by `tests/invariants/module-dictionary-ssot.spec.ts`. Code that holds a
 * value types it `OwnerModuleCode`; this reference only names the GraphQL type.
 * An employee carries no module of their own: it is read through their department, so the two
 * cannot disagree.
 */
export const HR_MODULE_CODE_ENUM = registerOwnerModuleEnum(
  'HRModuleCode',
  'Module a department belongs to; unset means company-wide',
);
