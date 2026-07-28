/**
 * Module management domain types
 */

// GENERATED backend contracts — tools/codegen/admin-contracts/manifest.ts.
import type {
  ModuleStats,
  TenantModuleAssignment,
} from './generated/admin-contracts';

export type {
  ModuleStats,
  TenantModuleAssignment,
};

import type { ModuleQuantities } from './billing';

export interface SystemModule {
  id: string;
  code: string;
  name: string;
  description: string | null;
  defaultRoute: string;
  icon: string | null;
  isCore: boolean;
  isActive: boolean;
  price: number;
  tenantsCount: number;
  createdAt: string;
  updatedAt: string;
}
