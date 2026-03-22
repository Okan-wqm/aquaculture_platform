# Agent 2: Auth Security Architect — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix all authentication and authorization gaps in auth-service tenant module — guard missing resolvers, unify dual user creation paths, add token revocation on delete, consolidate update mutations.

**Architecture:** Add decorator guards to unguarded resolvers, merge `TenantAdminService` + `TenantUserManagementService` into unified `UserLifecycleService`, add token revocation to delete flow, remove redundant `updateTenantSettings` mutation.

**Tech Stack:** NestJS, TypeORM, GraphQL, bcrypt, NATS

**Owned files:** All files in `apps/auth-service/src/modules/tenant/`

---

## File Map

| Action | Path | Purpose |
|--------|------|---------|
| Modify | `apps/auth-service/src/modules/tenant/resolvers/mobile-settings.resolver.ts` | Add `@TenantAdminOrHigher()` guards |
| Modify | `apps/auth-service/src/modules/tenant/resolvers/tenant-admin.resolver.ts` | Add `@Roles()` to `myModules` |
| Modify | `apps/auth-service/src/modules/tenant/resolvers/tenant.resolver.ts` | Remove `updateTenantSettings` mutation, consolidate into `updateTenant` |
| Create | `apps/auth-service/src/modules/tenant/services/user-lifecycle.service.ts` | Unified user creation/deletion service |
| Create | `apps/auth-service/src/modules/tenant/services/user-lifecycle.service.spec.ts` | Unit tests |
| Modify | `apps/auth-service/src/modules/tenant/services/tenant-user-management.service.ts` | Delegate to UserLifecycleService |
| Modify | `apps/auth-service/src/modules/tenant/services/tenant-admin.service.ts` | Delegate to UserLifecycleService |
| Modify | `apps/auth-service/src/modules/tenant/services/tenant.service.ts` | Merge updateTenantSettings into update with role-based filtering |
| Modify | `apps/auth-service/src/modules/tenant/tenant.module.ts` | Register UserLifecycleService |

---

### Task 1: Guard MobileSettingsResolver

**Files:**
- Modify: `apps/auth-service/src/modules/tenant/resolvers/mobile-settings.resolver.ts`

- [ ] **Step 1: Read current mobile-settings.resolver.ts**

Read: `apps/auth-service/src/modules/tenant/resolvers/mobile-settings.resolver.ts`

- [ ] **Step 2: Add TenantAdminOrHigher guard to all methods**

Add import and decorators:

```typescript
import { TenantAdminOrHigher } from '@aquaculture/backend-common';

// Add to EVERY @Query and @Mutation method:
@TenantAdminOrHigher()
```

Methods to guard:
- `getMobileUserSettings(userId)` — was accessible by any authenticated user
- `getMyMobileSettings()` — this one can stay with just auth (user's own settings)
- `getMobileUsersSettings()` — needs `@TenantAdminOrHigher()`
- `updateMobileUserSettings(input)` — needs `@TenantAdminOrHigher()`
- `bulkUpdateMobileSettings(input)` — needs `@TenantAdminOrHigher()`

Note: `getMyMobileSettings()` is the user reading their OWN settings, so it should NOT require admin. Use `@Roles(Role.MODULE_USER)` minimum instead (any authenticated tenant user).

- [ ] **Step 3: Commit**

```bash
git add apps/auth-service/src/modules/tenant/resolvers/mobile-settings.resolver.ts
git commit -m "fix(auth): add @TenantAdminOrHigher() guards to MobileSettingsResolver"
```

---

### Task 2: Guard myModules Query

**Files:**
- Modify: `apps/auth-service/src/modules/tenant/resolvers/tenant-admin.resolver.ts`

- [ ] **Step 1: Read current tenant-admin.resolver.ts**

Read: `apps/auth-service/src/modules/tenant/resolvers/tenant-admin.resolver.ts`

- [ ] **Step 2: Add minimum role guard to myModules**

```typescript
import { ModuleManagerOrHigher } from '@aquaculture/backend-common';
// Actually, myModules should be accessible by ALL tenant users (they need to know their modules for navigation)
// So use the least restrictive guard that still requires authentication + tenant membership:
import { Roles, Role } from '@aquaculture/backend-common';

@Query(() => [TenantModule])
@Roles(Role.MODULE_USER, Role.MODULE_MANAGER, Role.TENANT_ADMIN, Role.SUPER_ADMIN)
async myModules(@CurrentUser() user: JwtPayload): Promise<TenantModule[]> {
  // existing implementation
}
```

This ensures: (1) user must be authenticated (JwtAuthGuard), (2) user must have at least MODULE_USER role, (3) TenantGuard validates tenant membership. The current implementation already scopes by userId, so data leakage was mitigated — but explicit guards are defense-in-depth.

- [ ] **Step 3: Commit**

```bash
git add apps/auth-service/src/modules/tenant/resolvers/tenant-admin.resolver.ts
git commit -m "fix(auth): add explicit @Roles() guard to myModules query"
```

---

### Task 3: Unified UserLifecycleService

**Files:**
- Create: `apps/auth-service/src/modules/tenant/services/user-lifecycle.service.ts`
- Create: `apps/auth-service/src/modules/tenant/services/user-lifecycle.service.spec.ts`

- [ ] **Step 1: Read both existing user creation implementations**

Read: `apps/auth-service/src/modules/tenant/services/tenant-admin.service.ts` (look for `assignUserToModule`)
Read: `apps/auth-service/src/modules/tenant/services/tenant-user-management.service.ts` (look for `createTenantUser`)

- [ ] **Step 2: Write failing test for UserLifecycleService**

```typescript
// apps/auth-service/src/modules/tenant/services/user-lifecycle.service.spec.ts
import { UserLifecycleService } from './user-lifecycle.service';

describe('UserLifecycleService', () => {
  let service: UserLifecycleService;
  let mockUserRepo: any;
  let mockTokenService: any;
  let mockEventBus: any;
  let mockDataSource: any;

  beforeEach(() => {
    mockUserRepo = {
      findOne: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
    };
    mockTokenService = {
      revokeAllUserRefreshTokens: jest.fn().mockResolvedValue(undefined),
    };
    mockEventBus = {
      publish: jest.fn().mockResolvedValue(undefined),
    };
    mockDataSource = {
      createQueryRunner: jest.fn().mockReturnValue({
        connect: jest.fn(),
        startTransaction: jest.fn(),
        commitTransaction: jest.fn(),
        rollbackTransaction: jest.fn(),
        release: jest.fn(),
        manager: { save: jest.fn(), findOne: jest.fn() },
      }),
    };

    service = new UserLifecycleService(
      mockUserRepo,
      mockTokenService,
      mockEventBus,
      mockDataSource,
    );
  });

  describe('createUser', () => {
    it('should create user with role assignment in single transaction', async () => {
      const input = {
        email: 'test@example.com',
        firstName: 'Test',
        lastName: 'User',
        tenantId: 'tenant-123',
        roleId: 'role-456',
      };
      mockUserRepo.findOne.mockResolvedValue(null); // no existing user
      const qr = mockDataSource.createQueryRunner();
      qr.manager.save.mockResolvedValue({ id: 'user-789', ...input });

      const result = await service.createUser(input);
      expect(qr.startTransaction).toHaveBeenCalled();
      expect(qr.commitTransaction).toHaveBeenCalled();
    });
  });

  describe('deleteUser', () => {
    it('should deactivate user AND revoke all refresh tokens', async () => {
      const userId = 'user-789';
      const tenantId = 'tenant-123';
      mockUserRepo.findOne.mockResolvedValue({ id: userId, tenantId, isActive: true });

      await service.deleteUser(userId, tenantId);

      expect(mockTokenService.revokeAllUserRefreshTokens).toHaveBeenCalledWith(userId);
    });

    it('should not allow deleting another TENANT_ADMIN', async () => {
      const userId = 'user-789';
      const tenantId = 'tenant-123';
      mockUserRepo.findOne.mockResolvedValue({
        id: userId,
        tenantId,
        role: 'TENANT_ADMIN',
        isActive: true,
      });

      await expect(service.deleteUser(userId, tenantId)).rejects.toThrow(
        'Cannot delete another tenant admin',
      );
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx jest apps/auth-service/src/modules/tenant/services/user-lifecycle.service.spec.ts --no-coverage`
Expected: FAIL

- [ ] **Step 4: Implement UserLifecycleService**

```typescript
// apps/auth-service/src/modules/tenant/services/user-lifecycle.service.ts
import { Injectable, ForbiddenException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { User } from '../entities/user.entity';
import { TokenService } from '../../authentication/services/token.service';
import { EventBus } from '@nestjs/cqrs';
import { Role } from '@aquaculture/backend-common';

export interface CreateUserInput {
  email: string;
  firstName: string;
  lastName: string;
  tenantId: string;
  roleId?: string;
  moduleIds?: string[];
  sendInvitation?: boolean;
}

@Injectable()
export class UserLifecycleService {
  private readonly logger = new Logger(UserLifecycleService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly tokenService: TokenService,
    private readonly eventBus: EventBus,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Unified user creation — handles both legacy module-based and new RBAC-based flows
   * in a single transaction. Creates:
   * 1. User record in auth.users
   * 2. Role assignment in tenant schema (if roleId provided)
   * 3. Module assignments in auth.user_module_assignments (if moduleIds provided)
   * 4. Invitation token (if sendInvitation)
   */
  async createUser(input: CreateUserInput): Promise<User> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Check for existing user
      const existing = await this.userRepository.findOne({
        where: { email: input.email, tenantId: input.tenantId },
      });
      if (existing) {
        throw new ForbiddenException('User already exists in this tenant');
      }

      // Create user
      const user = this.userRepository.create({
        email: input.email,
        firstName: input.firstName,
        lastName: input.lastName,
        tenantId: input.tenantId,
        role: Role.MODULE_USER,
        isActive: true,
      });

      const savedUser = await queryRunner.manager.save(user);

      // Create role assignment if provided
      if (input.roleId) {
        await this.createRoleAssignment(queryRunner, savedUser.id, input.tenantId, input.roleId);
      }

      // Create module assignments if provided
      if (input.moduleIds?.length) {
        await this.createModuleAssignments(queryRunner, savedUser.id, input.tenantId, input.moduleIds);
      }

      await queryRunner.commitTransaction();

      this.logger.log(`User ${savedUser.id} created in tenant ${input.tenantId}`);
      return savedUser;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Unified user deletion — deactivates user, revokes ALL tokens, and cleans up assignments.
   * Ensures deleted users cannot continue using the platform with existing tokens.
   */
  async deleteUser(userId: string, tenantId: string): Promise<void> {
    const user = await this.userRepository.findOne({
      where: { id: userId, tenantId },
    });

    if (!user) {
      throw new ForbiddenException('User not found in this tenant');
    }

    if (user.role === Role.TENANT_ADMIN) {
      throw new ForbiddenException('Cannot delete another tenant admin');
    }

    // Deactivate
    user.isActive = false;
    await this.userRepository.save(user);

    // CRITICAL: Revoke ALL refresh tokens — prevents deleted user from getting new access tokens
    await this.tokenService.revokeAllUserRefreshTokens(userId);

    this.logger.log(`User ${userId} deleted and all tokens revoked in tenant ${tenantId}`);
  }

  private async createRoleAssignment(
    queryRunner: any,
    userId: string,
    tenantId: string,
    roleId: string,
  ): Promise<void> {
    const schemaName = this.getTenantSchemaName(tenantId);
    await queryRunner.query(
      `INSERT INTO "${schemaName}"."user_role_assignments" ("userId", "roleId", "isActive")
       VALUES ($1, $2, true)
       ON CONFLICT ("userId") DO UPDATE SET "roleId" = $2, "isActive" = true`,
      [userId, roleId],
    );
  }

  private async createModuleAssignments(
    queryRunner: any,
    userId: string,
    tenantId: string,
    moduleIds: string[],
  ): Promise<void> {
    for (const moduleId of moduleIds) {
      await queryRunner.query(
        `INSERT INTO "auth"."user_module_assignments" ("userId", "moduleId", "tenantId", "isActive")
         VALUES ($1, $2, $3, true)
         ON CONFLICT ("userId", "moduleId") DO UPDATE SET "isActive" = true`,
        [userId, moduleId, tenantId],
      );
    }
  }

  private getTenantSchemaName(tenantId: string): string {
    return `tenant_${tenantId.replace(/-/g, '').substring(0, 16)}`;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest apps/auth-service/src/modules/tenant/services/user-lifecycle.service.spec.ts --no-coverage`
Expected: PASS

- [ ] **Step 6: Register in module and commit**

Add `UserLifecycleService` to `tenant.module.ts` providers array.

```bash
git add apps/auth-service/src/modules/tenant/services/user-lifecycle.service.ts \
        apps/auth-service/src/modules/tenant/services/user-lifecycle.service.spec.ts \
        apps/auth-service/src/modules/tenant/tenant.module.ts
git commit -m "feat(auth): add unified UserLifecycleService — single path for user create/delete"
```

---

### Task 4: Wire Existing Services to UserLifecycleService

**Files:**
- Modify: `apps/auth-service/src/modules/tenant/services/tenant-user-management.service.ts`
- Modify: `apps/auth-service/src/modules/tenant/services/tenant-admin.service.ts`

- [ ] **Step 1: Read both services to find delegation points**

Read: `apps/auth-service/src/modules/tenant/services/tenant-user-management.service.ts` (find `createTenantUser`, `deleteTenantUser`)
Read: `apps/auth-service/src/modules/tenant/services/tenant-admin.service.ts` (find `assignUserToModule`, `deactivateUser`)

- [ ] **Step 2: Delegate createTenantUser to UserLifecycleService**

In `tenant-user-management.service.ts`, inject `UserLifecycleService` and delegate:

```typescript
// Add to constructor:
private readonly userLifecycle: UserLifecycleService,

// In createTenantUser method, replace direct user creation with:
const user = await this.userLifecycle.createUser({
  email: input.email,
  firstName: input.firstName,
  lastName: input.lastName,
  tenantId,
  roleId: input.roleId,
  sendInvitation: input.sendInvitation,
});
```

- [ ] **Step 3: Add token revocation to deleteTenantUser**

In `tenant-user-management.service.ts`, find `deleteTenantUser` and delegate to `UserLifecycleService.deleteUser()` which includes token revocation.

- [ ] **Step 4: Delegate assignUserToModule to UserLifecycleService**

In `tenant-admin.service.ts`, delegate user creation portion of `assignUserToModule` to `UserLifecycleService.createUser()` with `moduleIds` parameter.

- [ ] **Step 5: Run existing tests**

Run: `npx jest apps/auth-service/src/modules/tenant/ --no-coverage`
Expected: PASS — existing tests should still work since behavior is unchanged, just routed through single service

- [ ] **Step 6: Commit**

```bash
git add apps/auth-service/src/modules/tenant/services/tenant-user-management.service.ts \
        apps/auth-service/src/modules/tenant/services/tenant-admin.service.ts
git commit -m "refactor(auth): delegate user create/delete to unified UserLifecycleService"
```

---

### Task 5: Consolidate updateTenantSettings into updateTenant

**Files:**
- Modify: `apps/auth-service/src/modules/tenant/resolvers/tenant.resolver.ts`
- Modify: `apps/auth-service/src/modules/tenant/services/tenant.service.ts`

- [ ] **Step 1: Read current updateTenant and updateTenantSettings implementations**

Read: `apps/auth-service/src/modules/tenant/resolvers/tenant.resolver.ts` (find both mutations)
Read: `apps/auth-service/src/modules/tenant/services/tenant.service.ts` (find both methods)

- [ ] **Step 2: Remove updateTenantSettings mutation from resolver**

In `tenant.resolver.ts`, remove the `@Mutation` for `updateTenantSettings`. The `updateTenant` mutation already routes non-SUPER_ADMIN users to field-restricted updates — this is the correct single entry point.

- [ ] **Step 3: Merge updateTenantSettings logic into update method with role-based filtering**

In `tenant.service.ts`, ensure the `update()` method:
1. SUPER_ADMIN: can update all fields
2. TENANT_ADMIN: can only update allowlisted fields (name, description, logoUrl, contactEmail, contactPhone, address, settings)
3. Publishes `TenantUpdatedEvent` for ALL updates (not just SUPER_ADMIN path)

```typescript
// In update() method, replace Object.assign with:
if (userRole === Role.SUPER_ADMIN) {
  // SUPER_ADMIN can update everything
  Object.keys(input).forEach(key => {
    if (input[key] !== undefined) tenant[key] = input[key];
  });
} else {
  // TENANT_ADMIN: allowlisted fields only
  const allowedFields = ['name', 'description', 'logoUrl', 'contactEmail', 'contactPhone', 'address', 'settings'];
  Object.keys(input).forEach(key => {
    if (allowedFields.includes(key) && input[key] !== undefined) {
      tenant[key] = input[key];
    }
  });
}

// Publish event for ALL paths:
await this.eventBus.publish(new TenantUpdatedEvent({ tenantId: tenant.id, changes: input }));
```

- [ ] **Step 4: Remove standalone updateTenantSettings method from service (if separate)**

- [ ] **Step 5: Run existing tests**

Run: `npx jest apps/auth-service/src/modules/tenant/ --no-coverage`
Expected: PASS (may need test updates if tests called updateTenantSettings directly)

- [ ] **Step 6: Commit**

```bash
git add apps/auth-service/src/modules/tenant/resolvers/tenant.resolver.ts \
        apps/auth-service/src/modules/tenant/services/tenant.service.ts
git commit -m "refactor(auth): consolidate updateTenantSettings into updateTenant with role-based field filtering"
```

---

### Task 6: Discovery Pass

- [ ] **Step 1: Scan all owned files for additional issues**
- [ ] **Step 2: Log discoveries to DISCOVERY_LOG.md**
- [ ] **Step 3: Fix CRIT/HIGH within scope**
- [ ] **Step 4: Final commit**
