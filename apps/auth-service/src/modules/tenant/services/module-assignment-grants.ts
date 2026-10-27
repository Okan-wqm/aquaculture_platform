import type { ModuleRole } from '@aquaculture/shared-contracts';
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
 * The grants an invite creates for a member created in the same transaction, in the order
 * given, each with the role moduleAssignmentGrant gives the invited module role in that module
 * (RBAC-HIGH-027, PKG-06). The codes are read in the writer's transaction; a module id the
 * catalogue does not hold is refused before any row is written, instead of failing on the
 * foreign key half-way.
 */
export async function moduleGrantRows(
  manager: EntityManager,
  input: {
    readonly moduleIds: readonly string[];
    readonly invitedModuleRole: ModuleRole;
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
      invitedModuleRole: input.invitedModuleRole,
      moduleCode,
    });
    return { moduleId, ...grant };
  });
}
