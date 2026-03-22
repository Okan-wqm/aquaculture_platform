# Agent 1: Tenant Isolation Architect — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce tenant isolation at Redis, PostgreSQL (RLS), and repository levels — make cross-tenant data access architecturally impossible.

**Architecture:** Create `TenantRedisService` wrapper with automatic key prefixing, add PostgreSQL RLS policies, replace unsafe `getRepository()` with `getScopedRepository()`, harden subdomain extraction.

**Tech Stack:** NestJS, Redis (ioredis), PostgreSQL RLS, TypeORM, TypeScript

**Spec:** `docs/superpowers/specs/2026-03-22-tenant-admin-zero-defect-audit-design.md` — Agent 1

---

## File Map

| Action | Path | Purpose |
|--------|------|---------|
| Create | `libs/backend-common/src/redis/tenant-redis.service.ts` | Tenant-scoped Redis wrapper |
| Create | `libs/backend-common/src/redis/tenant-redis.service.spec.ts` | Unit tests |
| Modify | `libs/backend-common/src/redis/redis.service.ts` | Add tenant-aware methods |
| Modify | `libs/backend-common/src/redis/index.ts` | Export new service |
| Create | `libs/backend-common/src/database/rls/tenant-rls.service.ts` | RLS policy manager |
| Create | `libs/backend-common/src/database/rls/tenant-rls.service.spec.ts` | Unit tests |
| Modify | `libs/backend-common/src/database/tenant-aware.repository.ts` | Replace getRepository with getScopedRepository |
| Create | `libs/backend-common/src/database/tenant-aware.repository.spec.ts` | Unit tests for scoped repo |
| Modify | `libs/backend-common/src/decorators/cacheable.decorator.ts` | Enforce tenant key pattern |
| Modify | `libs/backend-common/src/middleware/tenant-context.middleware.ts` | Harden subdomain extraction |
| Modify | `libs/backend-common/src/index.ts` | Export new services |

---

### Task 1: TenantRedisService — Automatic Key Prefixing

**Files:**
- Create: `libs/backend-common/src/redis/tenant-redis.service.ts`
- Create: `libs/backend-common/src/redis/tenant-redis.service.spec.ts`

- [ ] **Step 1: Write the failing test for TenantRedisService**

```typescript
// libs/backend-common/src/redis/tenant-redis.service.spec.ts
import { Test } from '@nestjs/testing';
import { TenantRedisService } from './tenant-redis.service';
import { RedisService } from './redis.service';

describe('TenantRedisService', () => {
  let service: TenantRedisService;
  let mockRedis: jest.Mocked<RedisService>;

  beforeEach(async () => {
    mockRedis = {
      get: jest.fn(),
      set: jest.fn(),
      del: jest.fn(),
      exists: jest.fn(),
      keys: jest.fn(),
      deletePattern: jest.fn(),
      hget: jest.fn(),
      hset: jest.fn(),
      hdel: jest.fn(),
      hgetall: jest.fn(),
    } as any;

    const module = await Test.createTestingModule({
      providers: [
        TenantRedisService,
        { provide: RedisService, useValue: mockRedis },
      ],
    }).compile();

    service = module.get(TenantRedisService);
  });

  describe('key prefixing', () => {
    const tenantId = '4b529829-ea79-48da-9876-abcdef123456';

    it('should prefix get keys with tenant namespace', async () => {
      mockRedis.get.mockResolvedValue('value');
      await service.get(tenantId, 'user:123');
      expect(mockRedis.get).toHaveBeenCalledWith(`tenant:${tenantId}:user:123`);
    });

    it('should prefix set keys with tenant namespace', async () => {
      await service.set(tenantId, 'user:123', 'value', 3600);
      expect(mockRedis.set).toHaveBeenCalledWith(`tenant:${tenantId}:user:123`, 'value', 3600);
    });

    it('should prefix del keys with tenant namespace', async () => {
      await service.del(tenantId, 'user:123');
      expect(mockRedis.del).toHaveBeenCalledWith(`tenant:${tenantId}:user:123`);
    });

    it('should scope deletePattern to tenant namespace', async () => {
      await service.deletePattern(tenantId, 'user:*');
      expect(mockRedis.deletePattern).toHaveBeenCalledWith(`tenant:${tenantId}:user:*`);
    });

    it('should reject empty tenantId', async () => {
      await expect(service.get('', 'key')).rejects.toThrow('tenantId is required');
    });

    it('should reject tenantId that is not a valid UUID', async () => {
      await expect(service.get('not-a-uuid', 'key')).rejects.toThrow('Invalid tenantId format');
    });

    it('should prevent key traversal with tenant prefix in key', async () => {
      // Attacker tries to escape tenant namespace by including another tenant's prefix
      await service.get(tenantId, 'tenant:other-id:secret');
      // Key should still be scoped to original tenant
      expect(mockRedis.get).toHaveBeenCalledWith(`tenant:${tenantId}:tenant:other-id:secret`);
    });
  });

  describe('hash operations', () => {
    const tenantId = '4b529829-ea79-48da-9876-abcdef123456';

    it('should prefix hset keys', async () => {
      await service.hset(tenantId, 'settings', 'theme', 'dark');
      expect(mockRedis.hset).toHaveBeenCalledWith(`tenant:${tenantId}:settings`, 'theme', 'dark');
    });

    it('should prefix hget keys', async () => {
      await service.hget(tenantId, 'settings', 'theme');
      expect(mockRedis.hget).toHaveBeenCalledWith(`tenant:${tenantId}:settings`, 'theme');
    });

    it('should prefix hgetall keys', async () => {
      await service.hgetall(tenantId, 'settings');
      expect(mockRedis.hgetall).toHaveBeenCalledWith(`tenant:${tenantId}:settings`);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest libs/backend-common/src/redis/tenant-redis.service.spec.ts --no-coverage`
Expected: FAIL — `Cannot find module './tenant-redis.service'`

- [ ] **Step 3: Implement TenantRedisService**

```typescript
// libs/backend-common/src/redis/tenant-redis.service.ts
import { Injectable } from '@nestjs/common';
import { RedisService } from './redis.service';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class TenantRedisService {
  constructor(private readonly redis: RedisService) {}

  private tenantKey(tenantId: string, key: string): string {
    if (!tenantId) {
      throw new Error('tenantId is required for tenant-scoped Redis operations');
    }
    if (!UUID_REGEX.test(tenantId)) {
      throw new Error('Invalid tenantId format — must be a valid UUID');
    }
    return `tenant:${tenantId}:${key}`;
  }

  async get(tenantId: string, key: string): Promise<string | null> {
    return this.redis.get(this.tenantKey(tenantId, key));
  }

  async set(tenantId: string, key: string, value: string, ttlSeconds?: number): Promise<void> {
    return this.redis.set(this.tenantKey(tenantId, key), value, ttlSeconds);
  }

  async del(tenantId: string, key: string): Promise<void> {
    return this.redis.del(this.tenantKey(tenantId, key));
  }

  async exists(tenantId: string, key: string): Promise<boolean> {
    return this.redis.exists(this.tenantKey(tenantId, key));
  }

  async deletePattern(tenantId: string, pattern: string): Promise<void> {
    return this.redis.deletePattern(this.tenantKey(tenantId, pattern));
  }

  async hset(tenantId: string, key: string, field: string, value: string): Promise<void> {
    return this.redis.hset(this.tenantKey(tenantId, key), field, value);
  }

  async hget(tenantId: string, key: string, field: string): Promise<string | null> {
    return this.redis.hget(this.tenantKey(tenantId, key), field);
  }

  async hdel(tenantId: string, key: string, field: string): Promise<void> {
    return this.redis.hdel(this.tenantKey(tenantId, key), field);
  }

  async hgetall(tenantId: string, key: string): Promise<Record<string, string>> {
    return this.redis.hgetall(this.tenantKey(tenantId, key));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest libs/backend-common/src/redis/tenant-redis.service.spec.ts --no-coverage`
Expected: PASS — all 9 tests green

- [ ] **Step 5: Export from barrel and commit**

Add to `libs/backend-common/src/redis/index.ts`:
```typescript
export { TenantRedisService } from './tenant-redis.service';
```

Add to `libs/backend-common/src/index.ts` (if redis barrel not already exported):
```typescript
export * from './redis';
```

```bash
git add libs/backend-common/src/redis/tenant-redis.service.ts \
        libs/backend-common/src/redis/tenant-redis.service.spec.ts \
        libs/backend-common/src/redis/index.ts \
        libs/backend-common/src/index.ts
git commit -m "feat(backend-common): add TenantRedisService with automatic tenant key namespacing"
```

---

### Task 2: Replace getRepository() with getScopedRepository()

**Files:**
- Modify: `libs/backend-common/src/database/tenant-aware.repository.ts`
- Create: `libs/backend-common/src/database/tenant-aware.repository.spec.ts`

- [ ] **Step 1: Write failing test for getScopedRepository**

```typescript
// libs/backend-common/src/database/tenant-aware.repository.spec.ts
import { TenantAwareRepository } from './tenant-aware.repository';

describe('TenantAwareRepository', () => {
  describe('getScopedRepository', () => {
    it('should return a repository proxy that enforces tenant filtering on find', async () => {
      // Mock setup
      const mockRepo = {
        find: jest.fn().mockResolvedValue([]),
        findOne: jest.fn().mockResolvedValue(null),
        metadata: { columns: [{ propertyName: 'tenantId' }] },
      };
      const repo = createMockTenantAwareRepository(mockRepo, 'tenant-123');
      const scoped = repo.getScopedRepository();

      await scoped.find({});
      expect(mockRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ tenantId: 'tenant-123' }),
        }),
      );
    });

    it('should throw if getRepository is called (deprecated)', () => {
      const mockRepo = { metadata: { columns: [] } };
      const repo = createMockTenantAwareRepository(mockRepo, 'tenant-123');
      expect(() => repo.getRepository()).toThrow(
        'getRepository() is deprecated. Use getScopedRepository() which enforces tenant filtering.',
      );
    });
  });
});

function createMockTenantAwareRepository(mockRepo: any, tenantId: string) {
  // Minimal mock — actual implementation will use real DI
  const instance = Object.create(TenantAwareRepository.prototype);
  instance['repository'] = mockRepo;
  instance['tenantId'] = tenantId;
  return instance;
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest libs/backend-common/src/database/tenant-aware.repository.spec.ts --no-coverage`
Expected: FAIL — `getScopedRepository is not a function` or `getRepository does not throw`

- [ ] **Step 3: Modify TenantAwareRepository**

In `libs/backend-common/src/database/tenant-aware.repository.ts`, find the `getRepository()` method and replace:

```typescript
// BEFORE:
getRepository(): Repository<T> {
  return this.repository;
}

// AFTER:
/**
 * @deprecated Use getScopedRepository() which enforces tenant filtering.
 * This method is removed to prevent accidental cross-tenant data access.
 */
getRepository(): never {
  throw new Error(
    'getRepository() is deprecated. Use getScopedRepository() which enforces tenant filtering. ' +
    'If you need raw repository access for a legitimate cross-tenant operation, ' +
    'use getUnfilteredRepository() with explicit justification.',
  );
}

/**
 * Returns a proxy repository that automatically applies tenant filtering
 * to all find/findOne operations. Write operations are blocked — use
 * the TenantAwareRepository methods (create, update, delete) instead.
 */
getScopedRepository(): Pick<Repository<T>, 'find' | 'findOne' | 'count' | 'createQueryBuilder'> {
  const tenantId = this.tenantId;
  const repo = this.repository;

  return {
    find: (options?: FindManyOptions<T>) => {
      const where = { ...(options?.where as any || {}), tenantId };
      return repo.find({ ...options, where });
    },
    findOne: (options: FindOneOptions<T>) => {
      const where = { ...(options.where as any || {}), tenantId };
      return repo.findOne({ ...options, where });
    },
    count: (options?: FindManyOptions<T>) => {
      const where = { ...(options?.where as any || {}), tenantId };
      return repo.count({ ...options, where });
    },
    createQueryBuilder: (alias?: string) => {
      const qb = repo.createQueryBuilder(alias);
      qb.andWhere(`${alias || repo.metadata.tableName}.tenantId = :tenantId`, { tenantId });
      return qb;
    },
  };
}

/**
 * Returns the raw repository WITHOUT tenant filtering.
 * Use ONLY for legitimate cross-tenant operations (e.g., migrations, admin tools).
 * Every call site must document WHY unfiltered access is needed.
 */
getUnfilteredRepository(): Repository<T> {
  return this.repository;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest libs/backend-common/src/database/tenant-aware.repository.spec.ts --no-coverage`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add libs/backend-common/src/database/tenant-aware.repository.ts \
        libs/backend-common/src/database/tenant-aware.repository.spec.ts
git commit -m "fix(backend-common): replace getRepository() with getScopedRepository() to enforce tenant filtering"
```

---

### Task 3: Cacheable Decorator — Enforce Tenant Key Pattern

**Files:**
- Modify: `libs/backend-common/src/decorators/cacheable.decorator.ts`

- [ ] **Step 1: Read current cacheable decorator implementation**

Read: `libs/backend-common/src/decorators/cacheable.decorator.ts`

- [ ] **Step 2: Add compile-time tenant key pattern validation**

Find the key interpolation logic and add validation that warns when a cache key does not contain a tenant identifier:

```typescript
// Add at the top of the decorator factory function, after key interpolation:
private validateTenantKeyPattern(interpolatedKey: string, methodName: string): void {
  // Check if the key contains a tenant namespace segment
  if (!interpolatedKey.includes('tenant:') && !interpolatedKey.startsWith('system:') && !interpolatedKey.startsWith('global:')) {
    const logger = new Logger('CacheableDecorator');
    logger.warn(
      `Cache key "${interpolatedKey}" in ${methodName} does not include tenant namespace. ` +
      `Use TenantRedisService or prefix with "tenant:{tenantId}:" to prevent cross-tenant cache contamination. ` +
      `If this is intentionally global, prefix with "system:" or "global:".`,
    );
  }
}
```

- [ ] **Step 3: Run existing cacheable tests**

Run: `npx jest libs/backend-common/src/decorators/ --no-coverage`
Expected: PASS — no regression

- [ ] **Step 4: Commit**

```bash
git add libs/backend-common/src/decorators/cacheable.decorator.ts
git commit -m "fix(backend-common): add tenant key pattern validation to @Cacheable decorator"
```

---

### Task 4: PostgreSQL Row-Level Security (RLS) Policies

**Files:**
- Create: `libs/backend-common/src/database/rls/tenant-rls.service.ts`
- Create: `libs/backend-common/src/database/rls/tenant-rls.service.spec.ts`

- [ ] **Step 1: Write failing test for RLS service**

```typescript
// libs/backend-common/src/database/rls/tenant-rls.service.spec.ts
import { Test } from '@nestjs/testing';
import { TenantRlsService } from './tenant-rls.service';
import { DataSource } from 'typeorm';

describe('TenantRlsService', () => {
  let service: TenantRlsService;
  let mockDataSource: jest.Mocked<DataSource>;

  beforeEach(async () => {
    mockDataSource = {
      query: jest.fn().mockResolvedValue([]),
    } as any;

    const module = await Test.createTestingModule({
      providers: [
        TenantRlsService,
        { provide: DataSource, useValue: mockDataSource },
      ],
    }).compile();

    service = module.get(TenantRlsService);
  });

  it('should generate correct ENABLE RLS SQL', () => {
    const sql = service.generateEnableRlsSql('farm', 'tanks');
    expect(sql).toContain('ALTER TABLE "farm"."tanks" ENABLE ROW LEVEL SECURITY');
  });

  it('should generate correct policy SQL with tenantId column', () => {
    const sql = service.generatePolicySql('farm', 'tanks', 'tenantId');
    expect(sql).toContain('CREATE POLICY');
    expect(sql).toContain('"tenantId" = current_setting(\'app.current_tenant_id\')');
  });

  it('should validate schema name against injection', () => {
    expect(() => service.generateEnableRlsSql('farm; DROP TABLE', 'tanks')).toThrow(
      'Invalid schema name',
    );
  });

  it('should validate table name against injection', () => {
    expect(() => service.generateEnableRlsSql('farm', 'tanks; DROP TABLE')).toThrow(
      'Invalid table name',
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest libs/backend-common/src/database/rls/tenant-rls.service.spec.ts --no-coverage`
Expected: FAIL

- [ ] **Step 3: Implement TenantRlsService**

```typescript
// libs/backend-common/src/database/rls/tenant-rls.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

const SAFE_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

@Injectable()
export class TenantRlsService {
  private readonly logger = new Logger(TenantRlsService.name);

  constructor(private readonly dataSource: DataSource) {}

  private validateIdentifier(name: string, type: string): void {
    if (!SAFE_IDENTIFIER.test(name)) {
      throw new Error(`Invalid ${type} name: "${name}" — must match ${SAFE_IDENTIFIER}`);
    }
  }

  generateEnableRlsSql(schema: string, table: string): string {
    this.validateIdentifier(schema, 'schema');
    this.validateIdentifier(table, 'table');
    return `ALTER TABLE "${schema}"."${table}" ENABLE ROW LEVEL SECURITY;`;
  }

  generatePolicySql(
    schema: string,
    table: string,
    tenantColumn: string = 'tenantId',
  ): string {
    this.validateIdentifier(schema, 'schema');
    this.validateIdentifier(table, 'table');
    this.validateIdentifier(tenantColumn, 'column');

    const policyName = `rls_tenant_isolation_${schema}_${table}`;
    return `
      CREATE POLICY "${policyName}" ON "${schema}"."${table}"
        FOR ALL
        USING ("${tenantColumn}" = current_setting('app.current_tenant_id')::uuid)
        WITH CHECK ("${tenantColumn}" = current_setting('app.current_tenant_id')::uuid);
    `.trim();
  }

  async enableRlsForTable(schema: string, table: string, tenantColumn: string = 'tenantId'): Promise<void> {
    try {
      await this.dataSource.query(this.generateEnableRlsSql(schema, table));
      await this.dataSource.query(this.generatePolicySql(schema, table, tenantColumn));
      this.logger.log(`RLS enabled for ${schema}.${table} on column ${tenantColumn}`);
    } catch (error) {
      if (error.message?.includes('already exists')) {
        this.logger.debug(`RLS policy already exists for ${schema}.${table}`);
        return;
      }
      throw error;
    }
  }

  /**
   * Call this at the start of each request/transaction to set the tenant context
   * for RLS policy evaluation. Uses SET LOCAL so it is transaction-scoped.
   */
  async setTenantContext(tenantId: string): Promise<void> {
    if (!tenantId || !/^[0-9a-f-]{36}$/i.test(tenantId)) {
      throw new Error('Invalid tenantId for RLS context');
    }
    await this.dataSource.query(`SET LOCAL app.current_tenant_id = $1`, [tenantId]);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest libs/backend-common/src/database/rls/tenant-rls.service.spec.ts --no-coverage`
Expected: PASS

- [ ] **Step 5: Export and commit**

```bash
mkdir -p libs/backend-common/src/database/rls
git add libs/backend-common/src/database/rls/tenant-rls.service.ts \
        libs/backend-common/src/database/rls/tenant-rls.service.spec.ts
git commit -m "feat(backend-common): add TenantRlsService for PostgreSQL Row-Level Security"
```

---

### Task 5: Harden Subdomain Extraction

**Files:**
- Modify: `libs/backend-common/src/middleware/tenant-context.middleware.ts`

- [ ] **Step 1: Read current subdomain extraction logic**

Read: `libs/backend-common/src/middleware/tenant-context.middleware.ts:100-140`

- [ ] **Step 2: Add strict domain validation**

Find the subdomain extraction section and add configurable allowed domains:

```typescript
// Add to the class or middleware factory:
private readonly allowedBaseDomains: string[];

// In constructor or factory:
this.allowedBaseDomains = (process.env.ALLOWED_BASE_DOMAINS || '').split(',').filter(Boolean);

// In subdomain extraction logic, after extracting subdomain:
private extractTenantFromSubdomain(hostname: string): string | null {
  // Only extract from known base domains in production
  if (this.allowedBaseDomains.length > 0) {
    const matchesDomain = this.allowedBaseDomains.some(domain =>
      hostname.endsWith(`.${domain}`) || hostname === domain,
    );
    if (!matchesDomain) {
      this.logger.warn(`Subdomain extraction rejected: hostname "${hostname}" not in allowed domains`);
      return null;
    }
  }

  const parts = hostname.split('.');
  if (parts.length < 3) return null;

  const subdomain = parts[0];
  // Only accept valid UUIDs — reject anything else
  if (!UUID_REGEX.test(subdomain)) return null;

  return subdomain;
}
```

- [ ] **Step 3: Commit**

```bash
git add libs/backend-common/src/middleware/tenant-context.middleware.ts
git commit -m "fix(backend-common): harden subdomain tenant extraction with allowed domain whitelist"
```

---

### Task 6: Discovery Pass

- [ ] **Step 1: Read all files in scope for additional issues**

Read through all files in `libs/backend-common/src/` touched during Tasks 1-5. Look for:
- Any other method that returns raw repository without tenant scope
- Any Redis operation that doesn't use tenant namespace
- Any cache key pattern without tenant identifier
- Any SQL query that doesn't parameterize tenant context

- [ ] **Step 2: Document findings in DISCOVERY_LOG.md**

```bash
cat >> docs/superpowers/DISCOVERY_LOG.md << 'EOF'
## Agent 1: tenant-isolation-architect — Discoveries

| # | Severity | File | Description | Fixed |
|---|----------|------|-------------|-------|
| (fill during implementation) | | | | |
EOF
```

- [ ] **Step 3: Fix CRIT/HIGH discoveries within scope, log MED/LOW**

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "fix(backend-common): tenant isolation discovery fixes"
```
