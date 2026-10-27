/**
 * An in-memory auth store for the module-access writers (PKG-06), reachable only through the
 * transaction's manager: the injected repositories are bare identities that throw on any direct
 * call, so every read and write a spec observes happened inside `dataSource.transaction`. Reads
 * hand back copies, as TypeORM does, so a row only changes when the code under test writes it.
 * It records the RLS binding and every row lock in order, and whether the audit row and the
 * durable token invalidation were written through the transaction's manager.
 */
import { Role } from '@aquaculture/backend-common/decorators';
import type { ModuleRole } from '@aquaculture/shared-contracts';
import { collaborator, stub, stubMember } from '@aquaculture/testing';
import type { DataSource, EntityManager, Repository } from 'typeorm';

import { AuditLog } from '../../../../../audit/audit-log.entity';
import type { AuditLogService, CreateAuditLogDto } from '../../../../../audit/audit-log.service';
import { UserModuleAssignment } from '../../../../authentication/entities/user-module-assignment.entity';
import { User } from '../../../../authentication/entities/user.entity';
import type {
  DurableUserTokenInvalidationService,
  UserTokenInvalidationIntent,
} from '../../../../authentication/services/durable-user-token-invalidation.service';
import { Module } from '../../../../system-module/entities/module.entity';
import { TenantModule } from '../../../entities/tenant-module.entity';
import { ModuleAccessService } from '../../module-access.service';

export const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const OTHER_TENANT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const ADMIN = '00000000-0000-4000-8000-0000000000ad';

export const MODULE_ID = {
  farm: '10000000-0000-4000-8000-000000000001',
  hr: '10000000-0000-4000-8000-000000000002',
  sensor: '10000000-0000-4000-8000-000000000003',
  hydroponics: '10000000-0000-4000-8000-000000000004',
  alert: '10000000-0000-4000-8000-000000000005',
} as const;
export type Code = keyof typeof MODULE_ID;
const CODES: readonly Code[] = ['farm', 'hr', 'sensor', 'hydroponics', 'alert'];

type Where = Readonly<Record<string, unknown>>;

function matches(row: object, where: Where): boolean {
  return Object.entries(where).every(([key, value]) => Reflect.get(row, key) === value);
}

export interface GrantSeed {
  readonly userId: string;
  readonly code: Code;
  readonly role: ModuleRole;
  readonly isPrimaryManager?: boolean;
  readonly isActive?: boolean;
}

export interface WorldSeed {
  readonly users: ReadonlyArray<{
    readonly id: string;
    readonly role: Role;
    readonly tenantId?: string;
  }>;
  /** Modules the tenant has disabled; every other catalogue module is enabled. */
  readonly disabled?: readonly Code[];
  /** tenant_modules.managerId (the legacy designation copy). */
  readonly managers?: Partial<Record<Code, string>>;
  readonly grants?: readonly GrantSeed[];
}

export interface AuditRecord {
  readonly dto: CreateAuditLogDto;
  readonly inTransaction: boolean;
}

export interface InvalidationRecord {
  readonly intent: UserTokenInvalidationIntent;
  readonly inTransaction: boolean;
}

export interface World {
  readonly service: ModuleAccessService;
  readonly users: Map<string, User>;
  readonly tenantModules: Map<string, TenantModule>;
  readonly grants: UserModuleAssignment[];
  /** The RLS bindings (`rls:<tenant>`) and row locks taken, in order. */
  readonly steps: string[];
  readonly transactions: { count: number };
  readonly audits: AuditRecord[];
  readonly invalidations: InvalidationRecord[];
  readonly applied: jest.Mock;
  /** Users saved through the transaction (users.role must never be among the writes). */
  readonly savedUsers: User[];
  grantOf(userId: string, code: Code): UserModuleAssignment | undefined;
  managerOf(code: Code): string | null | undefined;
}

export function makeWorld(seed: WorldSeed): World {
  const steps: string[] = [];
  const transactions = { count: 0 };
  const audits: AuditRecord[] = [];
  const invalidations: InvalidationRecord[] = [];
  const savedUsers: User[] = [];
  let inTransaction = false;
  // The transaction-local RLS settings (set_config(..., true)): they end with the transaction.
  const rls: { tenant: string | null; bypass: string | null } = { tenant: null, bypass: null };

  const users = new Map(
    seed.users.map((user) => [
      user.id,
      Object.assign(new User(), {
        id: user.id,
        role: user.role,
        tenantId: user.tenantId ?? TENANT,
        email: `${user.id}@example.test`,
      }),
    ]),
  );
  const modules = new Map<string, Module>(
    CODES.map((code) => [
      MODULE_ID[code],
      Object.assign(new Module(), { id: MODULE_ID[code], code, name: code }),
    ]),
  );
  const tenantModules = new Map<string, TenantModule>(
    CODES.map((code) => [
      MODULE_ID[code],
      Object.assign(new TenantModule(), {
        id: `tm-${code}`,
        tenantId: TENANT,
        moduleId: MODULE_ID[code],
        isEnabled: !(seed.disabled ?? []).includes(code),
        managerId: seed.managers?.[code] ?? null,
      }),
    ]),
  );
  const grants: UserModuleAssignment[] = (seed.grants ?? []).map((grant, index) =>
    Object.assign(new UserModuleAssignment(), {
      id: `uma-${index}`,
      userId: grant.userId,
      moduleId: MODULE_ID[grant.code],
      tenantId: TENANT,
      isPrimaryManager: grant.isPrimaryManager ?? false,
      isActive: grant.isActive ?? true,
      role: grant.role,
      expiresAt: null,
      assignedBy: ADMIN,
    }),
  );

  const codeOf = (moduleId: string): string => modules.get(moduleId)?.code ?? moduleId;

  const userTable = stub<Repository<User>>({
    findOne: stubMember<Repository<User>['findOne']>(
      (options: { where: Where; lock?: unknown }) => {
        if (options.lock !== undefined) steps.push(`user:${String(options.where['id'])}`);
        const found = [...users.values()].find((user) => matches(user, options.where));
        return Promise.resolve(found === undefined ? null : Object.assign(new User(), found));
      },
    ),
    save: stubMember<Repository<User>['save']>((user: User) => {
      savedUsers.push(user);
      return Promise.resolve(user);
    }),
  });
  const tenantModuleTable = stub<Repository<TenantModule>>({
    findOne: stubMember<Repository<TenantModule>['findOne']>(
      (options: { where: Where; lock?: unknown }) => {
        const found = [...tenantModules.values()].find((row) => matches(row, options.where));
        if (options.lock !== undefined && found !== undefined) {
          steps.push(`tenant_module:${codeOf(found.moduleId)}`);
        }
        return Promise.resolve(
          found === undefined ? null : Object.assign(new TenantModule(), found),
        );
      },
    ),
    find: stubMember<Repository<TenantModule>['find']>(
      (options: { where: Where; lock?: unknown }) => {
        const found = [...tenantModules.values()]
          .filter((row) => matches(row, options.where))
          .sort((a, b) => a.moduleId.localeCompare(b.moduleId));
        if (options.lock !== undefined) {
          for (const row of found) steps.push(`tenant_module:${codeOf(row.moduleId)}`);
        }
        return Promise.resolve(found.map((row) => Object.assign(new TenantModule(), row)));
      },
    ),
    save: stubMember<Repository<TenantModule>['save']>((row: TenantModule) => {
      tenantModules.set(row.moduleId, Object.assign(new TenantModule(), row));
      return Promise.resolve(row);
    }),
  });
  const grantTable = stub<Repository<UserModuleAssignment>>({
    find: stubMember<Repository<UserModuleAssignment>['find']>((options: { where: Where }) =>
      Promise.resolve(
        grants
          .filter((grant) => matches(grant, options.where))
          .map((grant) => Object.assign(new UserModuleAssignment(), grant)),
      ),
    ),
    findOne: stubMember<Repository<UserModuleAssignment>['findOne']>(
      (options: { where: Where }) => {
        const found = grants.find((grant) => matches(grant, options.where));
        return Promise.resolve(
          found === undefined ? null : Object.assign(new UserModuleAssignment(), found),
        );
      },
    ),
    create: stubMember<Repository<UserModuleAssignment>['create']>(
      (dto: Partial<UserModuleAssignment>) => Object.assign(new UserModuleAssignment(), dto),
    ),
    save: stubMember<Repository<UserModuleAssignment>['save']>((row: UserModuleAssignment) => {
      const inserted = Object.assign(new UserModuleAssignment(), row, {
        id: `uma-${grants.length}`,
      });
      grants.push(inserted);
      return Promise.resolve(inserted);
    }),
    update: stubMember<Repository<UserModuleAssignment>['update']>(
      (criteria: Where, partial: Partial<UserModuleAssignment>) => {
        const hit = grants.filter((grant) => matches(grant, criteria));
        for (const grant of hit) Object.assign(grant, partial);
        return Promise.resolve({ affected: hit.length, raw: [], generatedMaps: [] });
      },
    ),
  });

  const injectedTenantModules = collaborator<Repository<TenantModule>>(
    {},
    'TenantModule repository',
  );
  const injectedUsers = collaborator<Repository<User>>({}, 'User repository');
  const manager = stub<EntityManager>({
    query: stubMember<EntityManager['query']>((sql: string, parameters?: unknown[]) => {
      if (sql.includes('set_config') && parameters?.[0] === 'app.current_tenant') {
        steps.push(`rls:${String(parameters[1])}`);
        rls.tenant = String(parameters[1]);
      } else if (sql.includes('set_config') && parameters?.[0] === 'app.bypass_rls') {
        rls.bypass = 'off';
      } else if (sql.includes('current_setting')) {
        // The binding read-back: what the transaction-local settings resolve to.
        return Promise.resolve([{ tenant: rls.tenant, bypass: rls.bypass }]);
      }
      return Promise.resolve([]);
    }),
    withRepository: stubMember<EntityManager['withRepository']>((repository: unknown) => {
      if (repository === injectedTenantModules) return tenantModuleTable;
      if (repository === injectedUsers) return userTable;
      throw new Error('withRepository: unexpected repository');
    }),
    getRepository: stubMember<EntityManager['getRepository']>((entity: unknown) => {
      if (entity === UserModuleAssignment) return grantTable;
      if (entity === TenantModule) return tenantModuleTable;
      throw new Error('getRepository: unexpected entity');
    }),
    find: stubMember<EntityManager['find']>((entity: unknown) => {
      if (entity !== Module) throw new Error('find: unexpected entity');
      return Promise.resolve([...modules.values()]);
    }),
  });
  const dataSource = stub<DataSource>({
    transaction: stubMember<DataSource['transaction']>(
      async (work: (transactionManager: EntityManager) => Promise<unknown>) => {
        transactions.count += 1;
        inTransaction = true;
        try {
          return await work(manager);
        } finally {
          inTransaction = false;
          rls.tenant = null;
          rls.bypass = null;
        }
      },
    ),
  });
  const auditLogService = collaborator<AuditLogService>(
    {
      log: jest.fn((dto: CreateAuditLogDto, auditManager?: unknown) => {
        audits.push({ dto, inTransaction: inTransaction && auditManager === manager });
        return Promise.resolve(Object.assign(new AuditLog(), dto));
      }),
    },
    'AuditLogService',
  );
  const applied = jest.fn().mockResolvedValue(undefined);
  const durable = collaborator<DurableUserTokenInvalidationService>(
    {
      enqueue: jest.fn((intentManager: EntityManager, intent: UserTokenInvalidationIntent) => {
        invalidations.push({ intent, inTransaction: inTransaction && intentManager === manager });
        return Promise.resolve();
      }),
      applyImmediately: applied,
    },
    'DurableUserTokenInvalidationService',
  );

  const service = new ModuleAccessService(
    injectedTenantModules,
    injectedUsers,
    dataSource,
    auditLogService,
    durable,
  );
  return {
    service,
    users,
    tenantModules,
    grants,
    steps,
    transactions,
    audits,
    invalidations,
    applied,
    savedUsers,
    grantOf: (userId, code) =>
      grants.find((grant) => grant.userId === userId && grant.moduleId === MODULE_ID[code]),
    managerOf: (code) => tenantModules.get(MODULE_ID[code])?.managerId,
  };
}

export function actor(): { readonly tenantId: string; readonly userId: string } {
  return { tenantId: TENANT, userId: ADMIN };
}

export { Role };
