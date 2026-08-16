import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

import {
  MIGRATION_EXECUTION_SCOPE_V1_PROPERTY,
  MIGRATION_EXECUTION_SCOPE_V1_SCHEMA,
  getSourceOnlyMigrationMetadata,
} from '../../libs/backend-common/src/database/tenant-fanout.decorator';
import { CreateFeedingOperationControlPlane1808600000000 } from '../../apps/farm-service/src/database/migrations/1808600000000-CreateFeedingOperationControlPlane';
import { InstallFeedingOperationMutationKernel1808700000000 } from '../../apps/farm-service/src/database/migrations/1808700000000-InstallFeedingOperationMutationKernel';
import {
  FEEDING_MIGRATION_AUTHORITY_V1,
  FEEDING_MIGRATION_AUTHORITY_V1_DIGEST,
  projectFeedingMigrationExecutionTargetsV1,
} from '../../apps/farm-service/src/database/migrations/feeding-migration-authority.v1';
import { FARM_MIGRATIONS } from '../../apps/farm-service/src/database/migrations/manifest';

const REPO_ROOT = resolve(__dirname, '..', '..');
const DB_MIGRATE_SPEC =
  'apps/db-migrate/src/__tests__/feeding-growth-and-ledger-authorities.integration.spec.ts';
const FARM_STORAGE_MIGRATION_SPEC =
  'apps/farm-service/src/__tests__/integration/storage-inventory-physical-key.postgres.spec.ts';
const FEEDING_OPERATION_MIGRATION_SPEC =
  'apps/db-migrate/src/__tests__/feeding-operation-authority.integration.spec.ts';
const MIGRATIONS_DIR = join(REPO_ROOT, 'apps/farm-service/src/database/migrations');
const FEEDING_MIGRATION_START = 1_808_600_000_000;
const FEEDING_MIGRATION_END = 1_810_000_000_000;
const IMMUTABLE_RUNTIME_EXTERNAL_IMPORTS = new Set(['node:crypto']);

interface ImportEdge {
  readonly specifier: string;
  readonly typeOnly: boolean;
}

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), 'utf8');
}

function moduleEdges(path: string): readonly ImportEdge[] {
  const source = readFileSync(path, 'utf8');
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const dynamicLoads: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportEqualsDeclaration(node)) {
      dynamicLoads.push(`${relative(REPO_ROOT, path)}: ${node.getText(sourceFile)}`);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      dynamicLoads.push(`${relative(REPO_ROOT, path)}: ${node.getText(sourceFile)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  expect(dynamicLoads).toEqual([]);

  return sourceFile.statements.flatMap((statement) => {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      return [
        {
          specifier: statement.moduleSpecifier.text,
          typeOnly: statement.importClause?.isTypeOnly === true,
        },
      ];
    }
    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      return [
        {
          specifier: statement.moduleSpecifier.text,
          typeOnly: statement.isTypeOnly,
        },
      ];
    }
    return [];
  });
}

function feedingMigrationFiles(): readonly string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d{13}-.+\.ts$/.test(name))
    .filter((name) => {
      const timestamp = Number(name.slice(0, 13));
      return timestamp >= FEEDING_MIGRATION_START && timestamp <= FEEDING_MIGRATION_END;
    })
    .sort()
    .map((name) => join(MIGRATIONS_DIR, name));
}

function resolveLocalImport(importer: string, specifier: string): string {
  const candidate = resolve(dirname(importer), specifier);
  for (const path of [`${candidate}.ts`, join(candidate, 'index.ts')]) {
    if (existsSync(path)) return path;
  }
  throw new Error(`Unresolved local migration import ${specifier} from ${importer}`);
}

function runtimeDependencyClosure(root: string): ReadonlySet<string> {
  const visited = new Set<string>();
  const pending = [root];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    for (const edge of moduleEdges(file)) {
      if (edge.typeOnly) continue;
      if (!edge.specifier.startsWith('.')) {
        expect(IMMUTABLE_RUNTIME_EXTERNAL_IMPORTS).toContain(edge.specifier);
        continue;
      }
      const dependency = resolveLocalImport(file, edge.specifier);
      expect(relative(MIGRATIONS_DIR, dependency)).not.toMatch(/^\.\.(?:\/|$)/);
      expect(dependency).toMatch(/(?:\.|-)v\d+\.ts$/);
      pending.push(dependency);
    }
  }
  return visited;
}

describe('feeding PostgreSQL migration proof reachability', () => {
  it('belongs to the platform migration execution project and its standard test target', () => {
    const project = JSON.parse(read('apps/db-migrate/project.json')) as {
      implicitDependencies?: string[];
      targets?: { test?: { options?: { command?: string } } };
    };
    const config = read('apps/db-migrate/jest.config.cts');

    expect(existsSync(join(REPO_ROOT, DB_MIGRATE_SPEC))).toBe(true);
    expect(
      existsSync(
        join(
          REPO_ROOT,
          'apps/farm-service/src/database/migrations/__tests__/feeding-growth-and-ledger-authorities.postgres.spec.ts',
        ),
      ),
    ).toBe(false);
    expect(project.implicitDependencies).toContain('farm-service');
    expect(project.targets?.test?.options?.command).toContain(
      'jest --config apps/db-migrate/jest.config.cts',
    );
    expect(config).toContain("'<rootDir>/src/**/*.spec.ts'");
  });

  it('is reached by strict CI targets and owns every post-control-plane migration proof', () => {
    const workflow = read('.github/workflows/ci-affected.yml');
    const spec = read(DB_MIGRATE_SPEC);
    const storageSpec = read(FARM_STORAGE_MIGRATION_SPEC);
    const operationSpec = read(FEEDING_OPERATION_MIGRATION_SPEC);
    const projectedControlPlaneProofs = new Set(
      projectFeedingMigrationExecutionTargetsV1(FARM_MIGRATIONS).map(
        (MigrationTarget) => new MigrationTarget().name,
      ),
    );
    expect(workflow).toContain('affected-target-policy.sh --target test');
    expect(workflow).toContain('affected-target-policy.sh --target test:integration');
    expect(operationSpec).toContain('projectFeedingMigrationExecutionTargetsV1(FARM_MIGRATIONS)');
    expect(operationSpec).toContain(
      'for (const MigrationTarget of FEEDING_FIXED_CONTROL_PLANE_MIGRATIONS)',
    );
    for (const migration of feedingMigrationFiles()) {
      const className = readFileSync(migration, 'utf8').match(/export class (\w+)/)?.[1];
      if (!className) throw new Error(`Missing migration class in ${migration}`);
      if (projectedControlPlaneProofs.has(className)) continue;
      expect(`${spec}\n${storageSpec}\n${operationSpec}`).toContain(className);
    }
    expect(spec).toContain("id: '1810000000000'");
    expect(spec).toContain('bootPostgresContainer');
  });

  it('keeps the complete 180860..181000 runtime closure inside versioned migration sources', () => {
    const roots = feedingMigrationFiles();
    expect(roots.length).toBeGreaterThan(0);
    const visited = new Set<string>();
    for (const root of roots) {
      const typeormEdge = moduleEdges(root).find((edge) => edge.specifier === 'typeorm');
      expect(typeormEdge?.typeOnly).toBe(true);
      for (const dependency of runtimeDependencyClosure(root)) {
        visited.add(dependency);
      }
    }

    expect([...visited].some((file) => file.endsWith('feeding-migration-authority.v1.ts'))).toBe(
      true,
    );
    expect([...visited].some((file) => relative(MIGRATIONS_DIR, file).startsWith('..'))).toBe(
      false,
    );
  });

  it('pins every direct or transitive authority consumer to the artifact semantic digest', () => {
    const recomputed = createHash('sha256')
      .update(JSON.stringify(FEEDING_MIGRATION_AUTHORITY_V1), 'utf8')
      .digest('hex');
    expect(FEEDING_MIGRATION_AUTHORITY_V1_DIGEST).toBe(recomputed);

    const consumers = feedingMigrationFiles().filter((file) =>
      [...runtimeDependencyClosure(file)].some((dependency) =>
        dependency.endsWith('feeding-migration-authority.v1.ts'),
      ),
    );
    expect(consumers.length).toBeGreaterThan(0);
    for (const file of consumers) {
      const source = readFileSync(file, 'utf8');
      const pinnedDigest = source.match(
        /const MIGRATION_AUTHORITY_DIGEST\s*=\s*['"]([0-9a-f]{64})['"]/,
      )?.[1];
      expect(pinnedDigest).toBe(FEEDING_MIGRATION_AUTHORITY_V1_DIGEST);
      expect(source).toContain('assertFeedingMigrationAuthorityV1(MIGRATION_AUTHORITY_DIGEST)');
    }
  });

  it('binds source-only routing to the frozen digested authority before class execution', () => {
    const { declarations, propertyName } = FEEDING_MIGRATION_AUTHORITY_V1.migrationExecution;
    expect(propertyName).toBe(MIGRATION_EXECUTION_SCOPE_V1_PROPERTY);
    expect(Object.keys(declarations).sort()).toEqual([
      'createControlPlane',
      'installMutationKernel',
    ]);
    for (const declaration of Object.values(declarations)) {
      expect(Object.isFrozen(declaration)).toBe(true);
      expect(Object.keys(declaration).sort()).toEqual(['reason', 'schemaVersion', 'scope']);
      expect(declaration).toMatchObject({
        schemaVersion: MIGRATION_EXECUTION_SCOPE_V1_SCHEMA,
        scope: 'source-only',
      });
    }

    expect(getSourceOnlyMigrationMetadata(CreateFeedingOperationControlPlane1808600000000)).toEqual(
      {
        ...declarations.createControlPlane,
        target: CreateFeedingOperationControlPlane1808600000000,
      },
    );
    expect(
      getSourceOnlyMigrationMetadata(InstallFeedingOperationMutationKernel1808700000000),
    ).toEqual({
      ...declarations.installMutationKernel,
      target: InstallFeedingOperationMutationKernel1808700000000,
    });

    for (const file of [
      resolve(MIGRATIONS_DIR, '1808600000000-CreateFeedingOperationControlPlane.ts'),
      resolve(MIGRATIONS_DIR, '1808700000000-InstallFeedingOperationMutationKernel.ts'),
    ]) {
      const source = readFileSync(file, 'utf8');
      expect(source).not.toContain('@aquaculture/backend-common/database');
      expect(source).not.toContain('@SourceOnlyMigration');
      expect(
        source.indexOf('assertFeedingMigrationAuthorityV1(MIGRATION_AUTHORITY_DIGEST)'),
      ).toBeLessThan(source.indexOf('export class'));
    }
  });

  it('projects the exact feeding migration prefix from canonical farm order and rejects drift', () => {
    expect(projectFeedingMigrationExecutionTargetsV1(FARM_MIGRATIONS)).toEqual([
      CreateFeedingOperationControlPlane1808600000000,
      InstallFeedingOperationMutationKernel1808700000000,
    ]);
    expect(() => projectFeedingMigrationExecutionTargetsV1([...FARM_MIGRATIONS].reverse())).toThrow(
      /exact canonical authority order/i,
    );
    expect(() =>
      projectFeedingMigrationExecutionTargetsV1(
        FARM_MIGRATIONS.filter(
          (target) => target !== InstallFeedingOperationMutationKernel1808700000000,
        ),
      ),
    ).toThrow(/exact canonical authority order/i);
    expect(() =>
      projectFeedingMigrationExecutionTargetsV1([
        ...FARM_MIGRATIONS,
        CreateFeedingOperationControlPlane1808600000000,
      ]),
    ).toThrow(/exact canonical authority order/i);
  });
});
