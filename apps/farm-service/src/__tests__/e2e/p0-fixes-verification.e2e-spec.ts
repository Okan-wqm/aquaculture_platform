/**
 * P0 Fixes Verification Tests
 *
 * End-to-end verification that critical security and data integrity fixes
 * are correctly applied across the farm-service codebase.
 *
 * These tests use reflection to verify decorators and patterns exist
 * without requiring a running database or application context.
 */
import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';

const SRC_ROOT = path.resolve(__dirname, '../../');

// Helper: read file content
function readFile(relativePath: string): string {
  return fs.readFileSync(path.join(SRC_ROOT, relativePath), 'utf-8');
}

// Helper: find all .ts files recursively
function findTsFiles(dir: string, pattern?: RegExp): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
      results.push(...findTsFiles(fullPath, pattern));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      if (!pattern || pattern.test(entry.name)) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

// ============================================================================
// FIX 1: @Roles Authorization Verification
// ============================================================================
describe('Fix 1: @Roles Authorization on Mutations', () => {
  const resolversToCheck = [
    'water-quality/water-quality.resolver.ts',
    'worker/worker.resolver.ts',
    'equipment/equipment.resolver.ts',
    'consumable/consumable.resolver.ts',
    'supplier/supplier.resolver.ts',
    'chemical/chemical.resolver.ts',
    'storage/storage.resolver.ts',
    'regulatory/regulatory.resolver.ts',
    'batch/resolvers/batch-feed-assignment.resolver.ts',
    'department/department.resolver.ts',
    'species/resolvers/species.resolver.ts',
  ];

  it.each(resolversToCheck)('should have Roles import in %s', (resolverPath) => {
    const content = readFile(resolverPath);
    // backend-common ÇİFT alias'lı (`@aquaculture/…` birincil, `@platform/…`
    // ikincil) ve dekoratörler `/decorators` alt yolundan geliyor. Bu assert
    // eskiden TEK bir alias'ı, alt yolsuz, pinliyordu; kod kanonik yola
    // taşınınca 12 resolver'da kırmızıya döndü ve kimse görmedi. Önemli olan
    // `Roles`'un backend-common'dan gelmesi — hangi alias/alt yol olduğu değil.
    expect(content).toMatch(
      /import\s+\{[^}]*\bRoles\b[^}]*\}\s+from\s+'@(?:aquaculture|platform)\/backend-common(?:\/[\w-]+)?'/,
    );
  });

  it.each(resolversToCheck)('should have @Roles before every @Mutation in %s', (resolverPath) => {
    const content = readFile(resolverPath);
    const lines = content.split('\n');

    lines.forEach((line, index) => {
      if (!line.includes('@Mutation(')) return;
      // Check that @Roles appears in the 1-3 lines BEFORE this @Mutation
      const precedingLines = lines.slice(Math.max(0, index - 3), index).join('\n');
      expect(precedingLines).toMatch(/@Roles\(/);
    });
  });

  it('keeps CDSE credentials off the public GraphQL surface', () => {
    expect(fs.existsSync(path.join(SRC_ROOT, 'sentinel-hub/sentinel-hub.resolver.ts'))).toBe(false);

    const module = readFile('sentinel-hub/sentinel-hub.module.ts');
    const internalResolver = readFile('sentinel-hub/marine-provider-credentials.service.ts');
    const signedClient = fs.readFileSync(
      path.resolve(
        SRC_ROOT,
        '../../../libs/backend-common/src/config-client/marine-provider-credential.client.ts',
      ),
      'utf-8',
    );
    expect(module).not.toContain('SentinelHubResolver');
    expect(internalResolver).toContain("this.client.resolve('CDSE', tenantId)");
    expect(internalResolver).not.toMatch(/@(Resolver|Query|Mutation)\b/);
    expect(signedClient).toContain('buildSignedInternalHeaders');
    expect(signedClient).toContain('MARINE_PROVIDER_CREDENTIAL_SUBJECTS.RESOLVE');
  });
});

// ============================================================================
// FIX 4: Federation Security Verification
// ============================================================================
describe('Fix 4: Federation Security', () => {
  it('should reject empty tenantId in resolveReference', () => {
    const content = readFile('farm/resolvers/farm.resolver.ts');
    expect(content).toMatch(/if\s*\(\s*!reference\.tenantId\s*\)/);
    expect(content).toMatch(/return\s+null/);
    // Should NOT have the old fallback
    expect(content).not.toMatch(/reference\.tenantId\s*\?\?\s*''/);
  });

  const federationEntities = [
    'farm/entities/farm.entity.ts',
    'tank/entities/tank.entity.ts',
    'batch/entities/batch.entity.ts',
    'species/entities/species.entity.ts',
  ];

  it.each(federationEntities)('should have @Key directive in %s', (entityPath) => {
    const content = readFile(entityPath);
    expect(content).toMatch(/@Directive\('@key\(fields:\s*"id"\)'\)/);
    expect(content).toMatch(/import\s+\{[^}]*Directive[^}]*\}\s+from\s+'@nestjs\/graphql'/);
  });

  it('should have event publishing outside try/catch in create-batch.handler.ts', () => {
    const content = readFile('batch/handlers/create-batch.handler.ts');
    const commitIndex = content.indexOf('commitTransaction');
    const releaseIndex = content.indexOf('queryRunner.release()');
    const eventPublishIndex = content.indexOf('eventBus.publish');

    // Event publish should come AFTER release
    expect(eventPublishIndex).toBeGreaterThan(releaseIndex);
  });
});

// ============================================================================
// FIX 3: Transaction Safety Verification
// ============================================================================
describe('Fix 3: Transaction Safety', () => {
  const handlersNeedingTransactions = [
    'batch/handlers/deploy-cleaner-fish.handler.ts',
    'batch/handlers/record-cleaner-mortality.handler.ts',
    'batch/handlers/transfer-cleaner-fish.handler.ts',
    'batch/handlers/remove-cleaner-fish.handler.ts',
    'harvest/handlers/delete-harvest-record.handler.ts',
  ];

  it.each(handlersNeedingTransactions)('uses the tenant transaction SSoT in %s', (handlerPath) => {
    const content = readFile(handlerPath);
    expect(content).toMatch(/DataSource/);
    expect(content).toMatch(
      /import\s+\{[^}]*runInTenantTransaction[^}]*\}\s+from\s+'@aquaculture\/backend-common\/database'/,
    );
    expect(content).toMatch(/runInTenantTransaction\(this\.dataSource,\s*'farm',\s*tenantId,/);
    expect(content).not.toMatch(/createQueryRunner\(/);
  });
});

// ============================================================================
// FIX 5: Race Condition Protection Verification
// ============================================================================
describe('Fix 5: Race Condition Protection', () => {
  it('should use pessimistic lock in record-mortality.handler.ts', () => {
    const content = readFile('batch/handlers/record-mortality.handler.ts');
    expect(content).toMatch(/pessimistic_write/);
  });

  it('should not have deprecated updateTankBatchAfterTransfer in transfer-batch.handler.ts', () => {
    const content = readFile('batch/handlers/transfer-batch.handler.ts');
    expect(content).not.toMatch(/(?:function|private|protected|public)\s+updateTankBatchAfterTransfer\b/);
    expect(content).not.toMatch(/\.updateTankBatchAfterTransfer\s*\(/);
  });
});

// ============================================================================
// FIX 6: CQRS Import Standardization Verification
// ============================================================================
describe('Fix 6: CQRS Import Standardization', () => {
  it('should not have any direct @nestjs/cqrs imports in farm-service', () => {
    const tsFiles = findTsFiles(SRC_ROOT);
    const violations: string[] = [];
    const nestCqrsModule = ['@nestjs', 'cqrs'].join('/');

    for (const file of tsFiles) {
      if (file.includes('node_modules') || file.includes('__tests__')) continue;
      const content = fs.readFileSync(file, 'utf-8');
      if (
        content.includes(`from '${nestCqrsModule}'`) ||
        content.includes(`from "${nestCqrsModule}"`)
      ) {
        violations.push(file.replace(SRC_ROOT + '/', ''));
      }
    }

    expect(violations).toEqual([]);
  });
});

// ============================================================================
// FIX 2: REST Controller Security Verification
// ============================================================================
describe('Fix 2: REST Controller Security', () => {
  it('should not use @Headers for tenant/user in batch controller', () => {
    const content = readFile('batch/controllers/batch.controller.ts');
    expect(content).not.toMatch(/@Headers\(['"]x-tenant-id['"]\)/);
    expect(content).not.toMatch(/@Headers\(['"]x-user-id['"]\)/);
  });
});
