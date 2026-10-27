import { Role } from '@aquaculture/backend-common/decorators';
import { BadRequestException } from '@nestjs/common';
import { EntityManager, In } from 'typeorm';

import {
  moduleAssignmentGrant,
  type ModuleAssignmentGrant,
} from '../../authentication/services/assignment-module-role';
import { Module } from '../../system-module/entities/module.entity';

/** One grant row a writer is about to insert: the module and the columns its role sets. */
export interface ModuleGrantRow extends ModuleAssignmentGrant {
  readonly moduleId: string;
}

/**
 * The grant of an existing member in one tenant module, with the role moduleAssignmentGrant
 * derives (RBAC-HIGH-027). The module's designated manager is read off the tenant module the
 * writer already holds, so no writer can leave it out.
 */
export function memberModuleGrant(
  tenantModule: {
    readonly managerId?: string | null;
    readonly module: { readonly code: string };
  },
  member: { readonly id: string; readonly role: Role },
  isPrimaryManager: boolean,
): ModuleAssignmentGrant {
  return moduleAssignmentGrant({
    isPrimaryManager,
    isDesignatedManager: tenantModule.managerId === member.id,
    userRole: member.role,
    moduleCode: tenantModule.module.code,
  });
}

/**
 * The grants a write of several modules creates for a member created in the same transaction,
 * in the order given, each with the role moduleAssignmentGrant derives from the module's code
 * (RBAC-HIGH-027). Such a member is nobody's designated manager: tenant_modules.managerId can
 * only name a user that existed before. The codes are read in the writer's transaction; a module
 * id the catalogue does not hold is refused before any row is written, instead of failing on the
 * foreign key half-way.
 */
export async function moduleGrantRows(
  manager: EntityManager,
  input: {
    readonly moduleIds: readonly string[];
    readonly userRole: Role;
    readonly isPrimaryManager: (moduleId: string) => boolean;
  },
): Promise<ModuleGrantRow[]> {
  const modules = await manager.find(Module, {
    select: { id: true, code: true },
    where: { id: In([...input.moduleIds]) },
  });
  const codeById = new Map(modules.map((module) => [module.id, module.code]));
  return input.moduleIds.map((moduleId) => {
    const moduleCode = codeById.get(moduleId);
    if (moduleCode === undefined) {
      throw new BadRequestException(`Unknown module "${moduleId}"`);
    }
    const grant = moduleAssignmentGrant({
      isPrimaryManager: input.isPrimaryManager(moduleId),
      isDesignatedManager: false,
      userRole: input.userRole,
      moduleCode,
    });
    return { moduleId, ...grant };
  });
}
