/**
 * RemoveModule revokes the tokens of everyone holding the module (PKG-06; RBAC-HIGH-035;
 * ADR-051 §2 "Change": "Removing a module revokes the tokens of everyone holding it").
 *
 * WHY: RemoveModule only flipped tenant_modules.isEnabled and wrote no audit row. The
 * module-access reader drops a disabled module from the next token it mints, but every live
 * access token kept the module — in `moduleAccess` and in the legacy `modules` list — until it
 * expired, while a site-assignment change already enqueued a durable invalidation.
 *
 * WHAT: `revokeModuleHolders` runs inside the RemoveModule receipt transaction, after the module
 * row was disabled; runWithReceipt has bound the transaction to the tenant (RLS). It reads the
 * holders — every member with an active grant row in the module, and every tenant administrator,
 * who holds each enabled module through the account role (ADR-051 §1, OQ1) — enqueues one durable
 * access-token invalidation per holder (module-access-invalidation.ts) through the transaction's
 * manager, and writes one audit row, so the disable, the recovery signal and the audit commit
 * together. The caller cuts the live tokens after commit (applyModuleAccessInvalidations).
 * Grant rows are left as they are: the reader joins isEnabled, so re-enabling the module restores
 * exactly the grants the members held.
 */
import type { EntityManager } from 'typeorm';

import type { AuditLogService } from '../../../audit/audit-log.service';
import type {
  DurableUserTokenInvalidationService,
  UserTokenInvalidationIntent,
} from '../../authentication/services/durable-user-token-invalidation.service';

import {
  enqueueModuleAccessInvalidations,
  type ModuleAccessHolder,
} from './module-access-invalidation';

/** The holders of one module in one tenant: its members with a live grant row, and its admins. */
export const MODULE_HOLDERS_SQL = `
  SELECT u.id, u."tenantId", u.role
    FROM auth.users u
   WHERE u."tenantId" = $1
     AND (u.role = 'TENANT_ADMIN'
          OR EXISTS (SELECT 1
                       FROM auth.user_module_assignments uma
                      WHERE uma."userId" = u.id
                        AND uma."tenantId" = $1
                        AND uma."moduleId" = $2
                        AND uma."isActive" = true))
   ORDER BY u.id`;

export interface ModuleRemovalPorts {
  readonly durable: DurableUserTokenInvalidationService;
  readonly audit: AuditLogService;
}

export interface ModuleRemoval {
  readonly tenantId: string;
  readonly moduleId: string;
  /** The tenant module row RemoveModule disabled. */
  readonly tenantModuleId: string;
  readonly actor: { readonly id: string; readonly email?: string };
  readonly removedAt: Date;
}

function holdersOf(rows: unknown): ModuleAccessHolder[] {
  if (!Array.isArray(rows)) {
    throw new TypeError('module holders: the query returned no rows array');
  }
  return rows.map((row: unknown, index): ModuleAccessHolder => {
    const id: unknown = typeof row === 'object' && row !== null ? Reflect.get(row, 'id') : null;
    const tenantId: unknown =
      typeof row === 'object' && row !== null ? Reflect.get(row, 'tenantId') : null;
    const role: unknown = typeof row === 'object' && row !== null ? Reflect.get(row, 'role') : null;
    if (typeof id !== 'string' || typeof tenantId !== 'string' || typeof role !== 'string') {
      throw new TypeError(`module holders: row ${index} has no id, tenantId and role`);
    }
    return { id, tenantId, role };
  });
}

export async function revokeModuleHolders(
  manager: EntityManager,
  ports: ModuleRemovalPorts,
  removal: ModuleRemoval,
): Promise<UserTokenInvalidationIntent[]> {
  const holders = holdersOf(
    await manager.query(MODULE_HOLDERS_SQL, [removal.tenantId, removal.moduleId]),
  );
  const intents = await enqueueModuleAccessInvalidations(
    manager,
    ports.durable,
    holders,
    'tenant-module-removed',
    removal.removedAt,
  );
  await ports.audit.log(
    {
      tenantId: removal.tenantId,
      performedBy: removal.actor.id,
      performedByEmail: removal.actor.email,
      action: 'TENANT_MODULE_REMOVED',
      entityType: 'TenantModule',
      entityId: removal.tenantModuleId,
      previousValue: { moduleId: removal.moduleId, isEnabled: true },
      newValue: { moduleId: removal.moduleId, isEnabled: false },
      details: { membersInvalidated: intents.length },
    },
    manager,
  );
  return intents;
}
