/**
 * Module management domain types
 */

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

export interface ModuleStats {
  totalModules: number;
  activeModules: number;
  coreModules: number;
  totalAssignments: number;
  moduleUsage: readonly { moduleId: string; moduleName: string; tenantsCount: number }[];
}

export interface TenantModuleAssignment {
  id: string;
  tenantId: string;
  tenantName: string;
  moduleId: string;
  moduleCode: string;
  moduleName: string;
  assignedAt: string;
  expiresAt: string | null;
}
