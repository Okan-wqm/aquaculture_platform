/**
 * P0 Fixes Verification Tests
 *
 * Static verification that critical security and data integrity fixes are
 * still applied across the farm-service codebase: file reads and regexes,
 * no database, no application context.
 *
 * Until 2026-09-04 this file was `src/__tests__/e2e/p0-fixes-verification.e2e-spec.ts`,
 * a name no Jest config matched (the unit lane ignores `src/__tests__/e2e/`,
 * the e2e config matches `test/**`), so none of it had run in CI
 * (INFRA-MEDIUM-142). It is a unit spec and lives in the unit lane. The two
 * blocks that tests/invariants already owns repo-wide were dropped rather
 * than kept as copies: the `@Headers('x-tenant-id')` ban
 * (farm-rest-cqrs-ssot.spec.ts) and the frozen `@nestjs/cqrs` importer set
 * (repo-hygiene-invariants.spec.ts).
 */
import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';

const SRC_ROOT = path.resolve(__dirname, '../');

// Helper: read file content
function readFile(relativePath: string): string {
  return fs.readFileSync(path.join(SRC_ROOT, relativePath), 'utf-8');
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
    expect(content).toMatch(
      /import\s+\{[^}]*Roles[^}]*\}\s+from\s+'@aquaculture\/backend-common\/decorators'/,
    );
  });

  it.each(resolversToCheck)('should have @Roles before every @Mutation in %s', (resolverPath) => {
    const content = readFile(resolverPath);
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      if (lines[i]?.includes('@Mutation(')) {
        // Check that @Roles appears in the 1-3 lines BEFORE this @Mutation
        const precedingLines = lines.slice(Math.max(0, i - 3), i).join('\n');
        expect(precedingLines).toMatch(/@Roles\(/);
      }
    }
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
    expect(content).not.toMatch(
      /(?:function|private|protected|public)\s+updateTankBatchAfterTransfer\b/,
    );
    expect(content).not.toMatch(/\.updateTankBatchAfterTransfer\s*\(/);
  });
});
