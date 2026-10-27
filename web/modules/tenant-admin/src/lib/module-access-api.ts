/**
 * The tenant-admin client of module access (PKG-06; ADR-051 §2 "Change").
 *
 * WHAT: Assign / Remove Manager by module code; a member's module roles read and replaced as a
 * whole (setUserModuleAccess); each owner module's designated managers. Replies are narrowed
 * here, at the trust boundary, and a malformed one is refused instead of rendered: a role that
 * is no module role, a module code that is no owner module, or a reply for another member.
 */
import {
  OWNER_MODULE_CODES,
  isModuleRole,
  isOwnerModuleCode,
  type ModuleRole,
  type OwnerModuleCode,
} from '@aquaculture/shared-contracts';

import {
  ASSIGN_MODULE_MANAGER_MUTATION,
  MODULE_PRIMARY_MANAGERS_QUERY,
  REMOVE_MODULE_MANAGER_MUTATION,
  SET_USER_MODULE_ACCESS_MUTATION,
  USER_MODULE_ACCESS_QUERY,
} from '../graphql';
import { apiClient } from '../services/api-client';

import type { TenantModule } from './types';

/** A member's role in every owner module; null is no grant. */
export type ModuleAccessGrants = { readonly [Code in OwnerModuleCode]: ModuleRole | null };

export interface ModulePrimaryManager {
  readonly moduleCode: OwnerModuleCode;
  readonly userId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeGrants(value: unknown, field: string): ModuleAccessGrants {
  if (!isRecord(value)) throw new Error(`${field}.moduleAccess must be an object`);
  const grants: { [Code in OwnerModuleCode]?: ModuleRole | null } = {};
  for (const code of OWNER_MODULE_CODES) {
    const role: unknown = value[code];
    if (role === null) {
      grants[code] = null;
    } else if (isModuleRole(role)) {
      grants[code] = role;
    } else {
      throw new Error(`${field}.moduleAccess.${code} must be a module role or null`);
    }
  }
  return {
    farm: grants.farm ?? null,
    hr: grants.hr ?? null,
    sensor: grants.sensor ?? null,
    hydroponics: grants.hydroponics ?? null,
  };
}

function decodeUserModuleAccess(value: unknown, field: string, userId: string): ModuleAccessGrants {
  if (!isRecord(value) || value.userId !== userId) {
    throw new Error(`${field} must answer for the requested member`);
  }
  return decodeGrants(value.moduleAccess, field);
}

export async function assignModuleManager(
  moduleCode: OwnerModuleCode,
  userId: string,
): Promise<TenantModule> {
  const data = await apiClient.graphql<{ assignModuleManager: TenantModule }>(
    ASSIGN_MODULE_MANAGER_MUTATION,
    { input: { moduleCode, userId } },
  );
  return data.assignModuleManager;
}

export async function removeModuleManager(moduleCode: OwnerModuleCode): Promise<TenantModule> {
  const data = await apiClient.graphql<{ removeModuleManager: TenantModule }>(
    REMOVE_MODULE_MANAGER_MUTATION,
    { moduleCode },
  );
  return data.removeModuleManager;
}

export async function getUserModuleAccess(userId: string): Promise<ModuleAccessGrants> {
  const data = await apiClient.graphql<{ userModuleAccess: unknown }>(USER_MODULE_ACCESS_QUERY, {
    userId,
  });
  return decodeUserModuleAccess(data.userModuleAccess, 'userModuleAccess', userId);
}

export async function setUserModuleAccess(
  userId: string,
  moduleAccess: ModuleAccessGrants,
): Promise<ModuleAccessGrants> {
  const data = await apiClient.graphql<{ setUserModuleAccess: unknown }>(
    SET_USER_MODULE_ACCESS_MUTATION,
    { input: { userId, moduleAccess } },
  );
  return decodeUserModuleAccess(data.setUserModuleAccess, 'setUserModuleAccess', userId);
}

export async function getModulePrimaryManagers(): Promise<ModulePrimaryManager[]> {
  const data = await apiClient.graphql<{ modulePrimaryManagers: unknown }>(
    MODULE_PRIMARY_MANAGERS_QUERY,
  );
  const rows = data.modulePrimaryManagers;
  if (!Array.isArray(rows)) throw new Error('modulePrimaryManagers must be a list');
  return rows.map((row: unknown, index): ModulePrimaryManager => {
    if (!isRecord(row) || !isOwnerModuleCode(row.moduleCode) || typeof row.userId !== 'string') {
      throw new Error(`modulePrimaryManagers[${index}] must name an owner module and a member`);
    }
    return { moduleCode: row.moduleCode, userId: row.userId };
  });
}
