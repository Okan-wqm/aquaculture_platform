#!/usr/bin/env ts-node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import ts from 'typescript';

type CheckName = 'entity_schema' | 'module_schema' | 'migration_registry' | 'db_snapshot';
type FindingRule =
  | 'typeorm_entity_schema_required'
  | 'module_schema_table_missing'
  | 'migration_registry_missing_entry'
  | 'migration_registry_missing_file'
  | 'db_snapshot_table_missing'
  | 'db_snapshot_column_missing'
  | 'db_snapshot_uuid_type_mismatch'
  | 'db_snapshot_nullability_mismatch';

interface AdapterInput {
  readonly target?: string;
  readonly root?: string;
  readonly serviceName?: string;
  readonly checks?: readonly CheckName[];
  readonly allowlist?: readonly string[];
  readonly dbSnapshotPath?: string;
  readonly moduleTableAllowlist?: readonly string[];
}

interface EvidenceRef {
  readonly path: string;
  readonly line?: number;
}

interface AriaOutput {
  readonly observations: readonly AdapterObservation[];
  readonly findings: readonly AdapterFinding[];
  readonly read_paths: readonly string[];
  readonly evidence_sources: readonly string[];
  readonly belief_candidates: readonly MemoryCandidate[];
  readonly cost_units: number;
  readonly metadata: Record<string, unknown>;
}

interface MemoryCandidate {
  readonly belief_id: string;
  readonly claim: string;
  readonly confidence: number;
  readonly evidence_refs: readonly string[];
  readonly source_tool_id: string;
}

interface AdapterObservation {
  readonly id: string;
  readonly type: string;
  readonly path?: string;
  readonly line?: number;
  readonly className?: string;
  readonly schema?: string | null;
  readonly table?: string | null;
  readonly column?: string;
  readonly allowlisted?: boolean;
  readonly details?: Record<string, unknown>;
}

interface AdapterFinding {
  readonly id: string;
  readonly rule: FindingRule;
  readonly severity: 'medium' | 'high';
  readonly path: string;
  readonly line?: number;
  readonly className?: string;
  readonly message: string;
  readonly evidence: readonly EvidenceRef[];
  readonly details?: Record<string, unknown>;
}

interface EntityColumn {
  readonly propertyName: string;
  readonly databaseName: string;
  readonly type: string | null;
  readonly nullable: boolean;
  readonly line: number;
  readonly enumLabels: readonly string[];
}

interface EntityRecord {
  readonly id: string;
  readonly className: string;
  readonly path: string;
  readonly absolutePath: string;
  readonly line: number;
  readonly schema: string | null;
  readonly schemaValid: boolean;
  readonly table: string | null;
  readonly allowlisted: boolean;
  readonly columns: readonly EntityColumn[];
}

interface AnalysisResult {
  readonly observations: AdapterObservation[];
  readonly findings: AdapterFinding[];
  readonly readPaths: string[];
}

interface ModuleSchemaRecord {
  readonly moduleName: string;
  readonly sourceSchema: string;
  readonly strictOwnership: boolean;
  readonly tables: readonly string[];
  readonly referenceDataTables: readonly string[];
  readonly infrastructureTables: readonly string[];
  readonly path: string;
  readonly line: number;
}

interface MigrationRegistry {
  readonly path: string;
  readonly importedClasses: ReadonlyMap<string, string>;
  readonly registeredClasses: readonly string[];
  readonly migrationsArrayLine: number;
}

interface SchemaSnapshot {
  readonly schema: string;
  readonly tables: readonly SnapshotTable[];
}

interface SnapshotTable {
  readonly name: string;
  readonly schema: string;
  readonly columns: readonly SnapshotColumn[];
}

interface SnapshotColumn {
  readonly name: string;
  readonly dataType: string;
  readonly isNullable: 'YES' | 'NO';
}

const DEFAULT_ROOT = 'apps/farm-service/src';
const DEFAULT_CHECKS: readonly CheckName[] = [
  'entity_schema',
  'module_schema',
  'migration_registry',
];
const MODULE_SCHEMA_PATH = 'libs/backend-common/src/database/schema-manager.service.ts';
const APP_MODULE_PATH = 'apps/farm-service/src/app.module.ts';
const MIGRATIONS_DIR = 'apps/farm-service/src/database/migrations';

export function analyzeTypeOrmEntities(
  input: AdapterInput,
  workspaceRoot = process.cwd(),
): AriaOutput {
  const requestedRoot = input.root ?? DEFAULT_ROOT;
  const serviceName = input.serviceName ?? 'farm';
  const checks = new Set(input.checks ?? DEFAULT_CHECKS);
  const scanRoot = resolveInsideWorkspace(workspaceRoot, requestedRoot);
  if (!existsSync(scanRoot)) {
    throw new Error(`scan root does not exist: ${requestedRoot}`);
  }

  const allowlist = new Set((input.allowlist ?? []).map(normalizePath));
  const moduleTableAllowlist = new Set((input.moduleTableAllowlist ?? []).map(String));
  const files = collectEntityFiles(scanRoot);
  const result = analyzeFiles(files, workspaceRoot, allowlist, checks);

  if (checks.has('module_schema')) {
    analyzeModuleSchema(workspaceRoot, serviceName, result, moduleTableAllowlist);
  }
  if (checks.has('migration_registry')) {
    analyzeMigrationRegistry(workspaceRoot, result);
  }
  if (checks.has('db_snapshot')) {
    analyzeDbSnapshot(input, workspaceRoot, serviceName, result);
  }

  result.observations.sort(compareById);
  result.findings.sort(compareById);
  result.readPaths.sort();
  const evidenceSources = Array.from(
    new Set(result.findings.flatMap((finding) => finding.evidence.map((evidence) => evidence.path))),
  ).sort();

  return {
    observations: result.observations,
    findings: result.findings,
    read_paths: Array.from(new Set(result.readPaths)).sort(),
    evidence_sources: evidenceSources,
    belief_candidates: [
      {
        belief_id: 'typeorm:farm-service:entity-schema-surface',
        claim: 'farm-service has a recurring TypeORM entity and migration surface for schema drift checks',
        confidence: 0.85,
        evidence_refs: [
          'apps/farm-service/src/**/*.ts',
          'apps/farm-service/src/database/migrations/*.ts',
          MODULE_SCHEMA_PATH,
        ],
        source_tool_id: 'typeorm-entity-schema-adapter',
      },
    ],
    cost_units: Array.from(new Set(result.readPaths)).length,
    metadata: {
      adapter: 'typeorm-entity-schema-adapter',
      target: input.target ?? null,
      root: normalizePath(relative(workspaceRoot, scanRoot)),
      serviceName,
      checks: Array.from(checks).sort(),
      files_scanned: files.length,
      findings_count: result.findings.length,
      allowlist_count: allowlist.size,
      module_table_allowlist_count: moduleTableAllowlist.size,
    },
  };
}

function compareById(a: { readonly id: string }, b: { readonly id: string }): number {
  return a.id.localeCompare(b.id);
}

function analyzeFiles(
  files: readonly string[],
  workspaceRoot: string,
  allowlist: ReadonlySet<string>,
  checks: ReadonlySet<CheckName>,
): AnalysisResult {
  const observations: AdapterObservation[] = [];
  const findings: AdapterFinding[] = [];
  const readPaths = files.map((file) => normalizePath(relative(workspaceRoot, file)));

  for (const file of files) {
    const sourceText = readFileSync(file, 'utf8');
    const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
    const relativePath = normalizePath(relative(workspaceRoot, file));
    const allowlisted = allowlist.has(relativePath);

    visit(sourceFile, (node) => {
      if (!ts.isClassDeclaration(node)) {
        return;
      }
      const decorator = getEntityDecorator(node);
      if (!decorator) {
        return;
      }

      const line = sourceFile.getLineAndCharacterOfPosition(decorator.getStart(sourceFile)).line + 1;
      const className = node.name?.text ?? '<anonymous>';
      const entity = readEntityDecorator(decorator);
      const record: EntityRecord = {
        id: `typeorm-entity:${relativePath}:${className}`,
        className,
        path: relativePath,
        absolutePath: file,
        line,
        schema: entity.schema,
        schemaValid: entity.schemaValid,
        table: entity.table,
        allowlisted,
        columns: readEntityColumns(node, sourceFile),
      };

      observations.push({
        id: record.id,
        type: 'typeorm_entity',
        className,
        path: relativePath,
        line,
        schema: entity.schema,
        table: entity.table,
        allowlisted,
        details: { column_count: record.columns.length },
      });
      for (const column of record.columns) {
        observations.push({
          id: `typeorm-entity-column:${relativePath}:${className}:${column.databaseName}`,
          type: 'typeorm_entity_column',
          className,
          path: relativePath,
          line: column.line,
          table: entity.table,
          column: column.databaseName,
          details: {
            propertyName: column.propertyName,
            type: column.type,
            nullable: column.nullable,
            enumLabels: column.enumLabels,
          },
        });
      }

      if (checks.has('entity_schema') && !allowlisted && !entity.schemaValid) {
        findings.push({
          id: `typeorm-entity-schema-required:${relativePath}:${line}`,
          rule: 'typeorm_entity_schema_required',
          severity: 'medium',
          path: relativePath,
          line,
          className,
          message:
            '@Entity() must declare a non-empty literal schema option unless the entity is explicitly allowlisted as tenant-owned.',
          evidence: [{ path: relativePath, line }],
        });
      }
    });
  }

  return { observations, findings, readPaths };
}

function analyzeModuleSchema(
  workspaceRoot: string,
  serviceName: string,
  result: AnalysisResult,
  tableAllowlist: ReadonlySet<string>,
): void {
  const modulePath = resolveInsideWorkspace(workspaceRoot, MODULE_SCHEMA_PATH);
  if (!existsSync(modulePath)) {
    result.observations.push({
      id: 'module-schema:missing-source-file',
      type: 'module_schema_unavailable',
      path: MODULE_SCHEMA_PATH,
    });
    return;
  }
  addReadPath(result, workspaceRoot, modulePath);
  const moduleSchema = readModuleSchema(modulePath, workspaceRoot, serviceName);
  if (!moduleSchema) {
    result.observations.push({
      id: `module-schema:${serviceName}:not-found`,
      type: 'module_schema_unavailable',
      path: MODULE_SCHEMA_PATH,
    });
    return;
  }

  const declaredTables = new Set([
    ...moduleSchema.tables,
    ...moduleSchema.referenceDataTables,
    ...moduleSchema.infrastructureTables,
    ...tableAllowlist,
  ]);
  const entityTables = entityObservations(result)
    .map((observation) => observation.table)
    .filter((table): table is string => typeof table === 'string' && table.length > 0);
  for (const table of entityTables) {
    if (declaredTables.has(table)) {
      continue;
    }
    const entity = entityObservations(result).find((observation) => observation.table === table);
    result.findings.push({
      id: `module-schema-table-missing:${serviceName}:${table}`,
      rule: 'module_schema_table_missing',
      severity: 'high',
      path: entity?.path ?? MODULE_SCHEMA_PATH,
      line: entity?.line,
      className: entity?.className,
      message: `Entity table '${table}' is not declared in MODULE_SCHEMAS for service '${serviceName}'.`,
      evidence: [
        ...(entity?.path ? [{ path: entity.path, line: entity.line }] : []),
        { path: MODULE_SCHEMA_PATH, line: moduleSchema.line },
      ],
      details: { table, sourceSchema: moduleSchema.sourceSchema },
    });
  }

  for (const table of moduleSchema.tables) {
    if (!entityTables.includes(table)) {
      result.observations.push({
        id: `module-schema-table-without-entity:${serviceName}:${table}`,
        type: 'module_schema_table_without_entity',
        path: MODULE_SCHEMA_PATH,
        line: moduleSchema.line,
        table,
        details: { sourceSchema: moduleSchema.sourceSchema },
      });
    }
  }
  result.observations.push({
    id: `module-schema:${serviceName}`,
    type: 'module_schema',
    path: MODULE_SCHEMA_PATH,
    line: moduleSchema.line,
    details: {
      sourceSchema: moduleSchema.sourceSchema,
      strictOwnership: moduleSchema.strictOwnership,
      tables: moduleSchema.tables.length,
      referenceDataTables: moduleSchema.referenceDataTables.length,
      infrastructureTables: moduleSchema.infrastructureTables.length,
    },
  });
}

function analyzeMigrationRegistry(workspaceRoot: string, result: AnalysisResult): void {
  const appModulePath = resolveInsideWorkspace(workspaceRoot, APP_MODULE_PATH);
  const migrationsDir = resolveInsideWorkspace(workspaceRoot, MIGRATIONS_DIR);
  if (!existsSync(appModulePath) || !existsSync(migrationsDir)) {
    result.observations.push({
      id: 'migration-registry:unavailable',
      type: 'migration_registry_unavailable',
      path: APP_MODULE_PATH,
    });
    return;
  }
  addReadPath(result, workspaceRoot, appModulePath);
  const files = collectMigrationFiles(migrationsDir);
  for (const file of files) {
    addReadPath(result, workspaceRoot, file);
  }
  const fileClasses = new Map<string, string>();
  for (const file of files) {
    const className = readFirstExportedClass(file);
    if (className) {
      fileClasses.set(className, normalizePath(relative(workspaceRoot, file)));
    }
  }
  const registry = readMigrationRegistry(appModulePath, workspaceRoot);
  const registered = new Set(registry.registeredClasses);

  for (const [className, filePath] of fileClasses) {
    if (!registered.has(className)) {
      result.findings.push({
        id: `migration-registry-missing-entry:${className}`,
        rule: 'migration_registry_missing_entry',
        severity: 'high',
        path: APP_MODULE_PATH,
        line: registry.migrationsArrayLine,
        message: `Migration class '${className}' exists in ${filePath} but is not registered in app.module.ts migrations array.`,
        evidence: [{ path: filePath }, { path: APP_MODULE_PATH, line: registry.migrationsArrayLine }],
        details: { className, filePath },
      });
    }
  }
  for (const className of registry.registeredClasses) {
    if (!fileClasses.has(className)) {
      result.findings.push({
        id: `migration-registry-missing-file:${className}`,
        rule: 'migration_registry_missing_file',
        severity: 'high',
        path: APP_MODULE_PATH,
        line: registry.migrationsArrayLine,
        message: `Migration class '${className}' is registered in app.module.ts but no matching migration file class was found.`,
        evidence: [{ path: APP_MODULE_PATH, line: registry.migrationsArrayLine }],
        details: { className },
      });
    }
  }
  result.observations.push({
    id: 'migration-registry:farm-service',
    type: 'migration_registry',
    path: APP_MODULE_PATH,
    line: registry.migrationsArrayLine,
    details: {
      files: fileClasses.size,
      registered: registry.registeredClasses.length,
    },
  });
}

function analyzeDbSnapshot(
  input: AdapterInput,
  workspaceRoot: string,
  serviceName: string,
  result: AnalysisResult,
): void {
  if (!input.dbSnapshotPath) {
    result.findings.push({
      id: 'db-snapshot:missing-path',
      rule: 'db_snapshot_table_missing',
      severity: 'high',
      path: '.',
      message: "checks includes 'db_snapshot' but dbSnapshotPath was not provided.",
      evidence: [],
    });
    return;
  }
  const snapshotPath = resolveInsideWorkspace(workspaceRoot, input.dbSnapshotPath);
  if (!existsSync(snapshotPath)) {
    throw new Error(`dbSnapshotPath does not exist: ${input.dbSnapshotPath}`);
  }
  addReadPath(result, workspaceRoot, snapshotPath);
  const snapshot = readJson(snapshotPath) as SchemaSnapshot;
  const snapshotRel = normalizePath(relative(workspaceRoot, snapshotPath));
  const tables = new Map(snapshot.tables.map((table) => [table.name, table]));

  for (const entity of entityObservations(result)) {
    if (!entity.table || !entity.path) {
      continue;
    }
    const table = tables.get(entity.table);
    if (!table) {
      result.findings.push({
        id: `db-snapshot-table-missing:${entity.table}`,
        rule: 'db_snapshot_table_missing',
        severity: 'high',
        path: entity.path,
        line: entity.line,
        className: entity.className,
        message: `Entity table '${entity.table}' is missing from schema snapshot '${snapshot.schema}'.`,
        evidence: [{ path: entity.path, line: entity.line }, { path: snapshotRel }],
        details: { table: entity.table, schema: snapshot.schema },
      });
    }
  }

  const records = collectEntityRecords(result);
  for (const record of records) {
    if (!record.table) {
      continue;
    }
    const table = tables.get(record.table);
    if (!table) {
      continue;
    }
    const dbColumns = new Map(table.columns.map((column) => [column.name, column]));
    for (const column of record.columns) {
      const dbColumn = dbColumns.get(column.databaseName);
      if (!dbColumn) {
        result.findings.push({
          id: `db-snapshot-column-missing:${record.table}:${column.databaseName}`,
          rule: 'db_snapshot_column_missing',
          severity: 'high',
          path: record.path,
          line: column.line,
          className: record.className,
          message: `Entity column '${record.table}.${column.databaseName}' is missing from schema snapshot '${snapshot.schema}'.`,
          evidence: [{ path: record.path, line: column.line }, { path: snapshotRel }],
          details: { table: record.table, column: column.databaseName },
        });
        continue;
      }
      if (column.type === 'uuid' && dbColumn.dataType !== 'uuid') {
        result.findings.push({
          id: `db-snapshot-uuid-type-mismatch:${record.table}:${column.databaseName}`,
          rule: 'db_snapshot_uuid_type_mismatch',
          severity: 'high',
          path: record.path,
          line: column.line,
          className: record.className,
          message: `Entity declares '${record.table}.${column.databaseName}' as uuid but snapshot type is '${dbColumn.dataType}'.`,
          evidence: [{ path: record.path, line: column.line }, { path: snapshotRel }],
          details: { table: record.table, column: column.databaseName, expected: 'uuid', actual: dbColumn.dataType },
        });
      }
      if (!column.nullable && dbColumn.isNullable === 'YES') {
        result.findings.push({
          id: `db-snapshot-nullability-mismatch:${record.table}:${column.databaseName}`,
          rule: 'db_snapshot_nullability_mismatch',
          severity: 'medium',
          path: record.path,
          line: column.line,
          className: record.className,
          message: `Entity declares '${record.table}.${column.databaseName}' as NOT NULL but snapshot column is nullable.`,
          evidence: [{ path: record.path, line: column.line }, { path: snapshotRel }],
          details: { table: record.table, column: column.databaseName },
        });
      }
    }
    const entityColumns = new Set(record.columns.map((column) => column.databaseName));
    for (const dbColumn of table.columns) {
      if (!entityColumns.has(dbColumn.name)) {
        result.observations.push({
          id: `db-snapshot-orphan-column:${record.table}:${dbColumn.name}`,
          type: 'db_snapshot_orphan_column',
          path: snapshotRel,
          table: record.table,
          column: dbColumn.name,
          details: { dataType: dbColumn.dataType, isNullable: dbColumn.isNullable },
        });
      }
    }
  }

  result.observations.push({
    id: `db-snapshot:${serviceName}:${snapshot.schema}`,
    type: 'db_snapshot',
    path: snapshotRel,
    details: { schema: snapshot.schema, tables: snapshot.tables.length },
  });
}

function entityObservations(result: AnalysisResult): AdapterObservation[] {
  return result.observations.filter((observation) => observation.type === 'typeorm_entity');
}

function collectEntityRecords(result: AnalysisResult): EntityRecord[] {
  const entities = entityObservations(result);
  return entities.map((entity): EntityRecord => {
    const columns = result.observations
      .filter(
        (observation) =>
          observation.type === 'typeorm_entity_column' &&
          observation.path === entity.path &&
          observation.className === entity.className,
      )
      .map((observation): EntityColumn => {
        const details = observation.details ?? {};
        return {
          propertyName: String(details.propertyName ?? observation.column ?? ''),
          databaseName: observation.column ?? '',
          type: typeof details.type === 'string' ? details.type : null,
          nullable: details.nullable === true,
          line: observation.line ?? entity.line ?? 1,
          enumLabels: Array.isArray(details.enumLabels)
            ? details.enumLabels.filter((item): item is string => typeof item === 'string')
            : [],
        };
      });
    return {
      id: entity.id,
      className: entity.className ?? '<anonymous>',
      path: entity.path ?? '',
      absolutePath: '',
      line: entity.line ?? 1,
      schema: entity.schema ?? null,
      schemaValid: typeof entity.schema === 'string' && entity.schema.length > 0,
      table: entity.table ?? null,
      allowlisted: entity.allowlisted === true,
      columns,
    };
  });
}

function getEntityDecorator(node: ts.ClassDeclaration): ts.CallExpression | null {
  const decorators = ts.canHaveDecorators(node) ? ts.getDecorators(node) ?? [] : [];
  for (const decorator of decorators) {
    const expression = decorator.expression;
    if (!ts.isCallExpression(expression)) {
      continue;
    }
    const callee = expression.expression;
    if (ts.isIdentifier(callee) && callee.text === 'Entity') {
      return expression;
    }
  }
  return null;
}

function readEntityDecorator(call: ts.CallExpression): {
  readonly schema: string | null;
  readonly schemaValid: boolean;
  readonly table: string | null;
} {
  const firstArg = call.arguments[0];
  const secondArg = call.arguments[1];
  const optionsArg = ts.isObjectLiteralExpression(firstArg)
    ? firstArg
    : secondArg && ts.isObjectLiteralExpression(secondArg)
      ? secondArg
      : null;
  const table =
    firstArg && ts.isStringLiteralLike(firstArg)
      ? firstArg.text
      : firstArg && ts.isObjectLiteralExpression(firstArg)
        ? readStringProperty(firstArg, 'name')
        : null;
  const schema = optionsArg ? readStringProperty(optionsArg, 'schema') : null;
  return {
    schema,
    schemaValid: typeof schema === 'string' && schema.trim().length > 0,
    table,
  };
}

function readEntityColumns(node: ts.ClassDeclaration, sourceFile: ts.SourceFile): readonly EntityColumn[] {
  const columns: EntityColumn[] = [];
  for (const member of node.members) {
    if (!ts.isPropertyDeclaration(member) || !member.name || !ts.isIdentifier(member.name)) {
      continue;
    }
    const decorator = getColumnDecorator(member);
    if (!decorator) {
      continue;
    }
    const propertyName = member.name.text;
    const options = readColumnOptions(decorator, propertyName);
    columns.push({
      propertyName,
      databaseName: options.databaseName,
      type: options.type,
      nullable: options.nullable,
      line: sourceFile.getLineAndCharacterOfPosition(decorator.getStart(sourceFile)).line + 1,
      enumLabels: options.enumLabels,
    });
  }
  return columns;
}

function getColumnDecorator(node: ts.PropertyDeclaration): ts.CallExpression | null {
  const decorators = ts.canHaveDecorators(node) ? ts.getDecorators(node) ?? [] : [];
  const names = new Set([
    'Column',
    'PrimaryColumn',
    'PrimaryGeneratedColumn',
    'CreateDateColumn',
    'UpdateDateColumn',
    'DeleteDateColumn',
    'VersionColumn',
  ]);
  for (const decorator of decorators) {
    const expression = decorator.expression;
    if (!ts.isCallExpression(expression)) {
      continue;
    }
    const callee = expression.expression;
    if (ts.isIdentifier(callee) && names.has(callee.text)) {
      return expression;
    }
  }
  return null;
}

function readColumnOptions(call: ts.CallExpression, propertyName: string): {
  readonly databaseName: string;
  readonly type: string | null;
  readonly nullable: boolean;
  readonly enumLabels: readonly string[];
} {
  const decoratorName = ts.isIdentifier(call.expression) ? call.expression.text : '';
  const firstArg = call.arguments[0];
  const secondArg = call.arguments[1];
  const optionsArg = findObjectArg(call.arguments);
  const databaseName = optionsArg ? readStringProperty(optionsArg, 'name') ?? propertyName : propertyName;
  const explicitType =
    firstArg && ts.isStringLiteralLike(firstArg)
      ? firstArg.text
      : optionsArg
        ? readStringProperty(optionsArg, 'type')
        : null;
  const type =
    explicitType ??
    (decoratorName === 'PrimaryGeneratedColumn' && firstArg && ts.isStringLiteralLike(firstArg)
      ? firstArg.text
      : null);
  return {
    databaseName,
    type,
    nullable: optionsArg ? readBooleanProperty(optionsArg, 'nullable') === true : false,
    enumLabels: optionsArg ? readStringArrayProperty(optionsArg, 'enum') : [],
  };
}

function findObjectArg(args: ts.NodeArray<ts.Expression>): ts.ObjectLiteralExpression | null {
  for (const arg of args) {
    if (ts.isObjectLiteralExpression(arg)) {
      return arg;
    }
  }
  return null;
}

function readModuleSchema(
  path: string,
  workspaceRoot: string,
  serviceName: string,
): ModuleSchemaRecord | null {
  const sourceFile = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  let found: ModuleSchemaRecord | null = null;
  visit(sourceFile, (node) => {
    if (found || !ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || node.name.text !== 'MODULE_SCHEMAS') {
      return;
    }
    const initializer = unwrapExpression(node.initializer);
    if (!initializer || !ts.isArrayLiteralExpression(initializer)) {
      return;
    }
    for (const element of initializer.elements) {
      if (!ts.isObjectLiteralExpression(element)) {
        continue;
      }
      const moduleName = readStringProperty(element, 'moduleName');
      if (moduleName !== serviceName) {
        continue;
      }
      found = {
        moduleName,
        sourceSchema: readStringProperty(element, 'sourceSchema') ?? serviceName,
        strictOwnership: readBooleanProperty(element, 'strictOwnership') === true,
        tables: readStringArrayProperty(element, 'tables'),
        referenceDataTables: readStringArrayProperty(element, 'referenceDataTables'),
        infrastructureTables: readStringArrayProperty(element, 'infrastructureTables'),
        path: normalizePath(relative(workspaceRoot, path)),
        line: sourceFile.getLineAndCharacterOfPosition(element.getStart(sourceFile)).line + 1,
      };
      return;
    }
  });
  return found;
}

function readMigrationRegistry(path: string, workspaceRoot: string): MigrationRegistry {
  const sourceFile = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  const importedClasses = new Map<string, string>();
  const registeredClasses: string[] = [];
  let migrationsArrayLine = 1;

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause?.namedBindings) {
      continue;
    }
    if (!ts.isNamedImports(statement.importClause.namedBindings)) {
      continue;
    }
    const specifier = ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : '';
    if (!specifier.includes('/database/migrations/') && !specifier.includes('./database/migrations/')) {
      continue;
    }
    for (const element of statement.importClause.namedBindings.elements) {
      importedClasses.set(element.name.text, specifier);
    }
  }

  visit(sourceFile, (node) => {
    if (!ts.isPropertyAssignment(node) || !isPropertyNamed(node.name, 'migrations')) {
      return;
    }
    if (!ts.isArrayLiteralExpression(node.initializer)) {
      return;
    }
    migrationsArrayLine = sourceFile.getLineAndCharacterOfPosition(node.initializer.getStart(sourceFile)).line + 1;
    for (const element of node.initializer.elements) {
      if (ts.isIdentifier(element)) {
        registeredClasses.push(element.text);
      }
    }
  });

  return {
    path: normalizePath(relative(workspaceRoot, path)),
    importedClasses,
    registeredClasses,
    migrationsArrayLine,
  };
}

function readFirstExportedClass(path: string): string | null {
  const sourceFile = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  for (const statement of sourceFile.statements) {
    if (ts.isClassDeclaration(statement) && statement.name) {
      return statement.name.text;
    }
  }
  return null;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function readStringProperty(object: ts.ObjectLiteralExpression, propertyName: string): string | null {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property) || !isPropertyNamed(property.name, propertyName)) {
      continue;
    }
    return ts.isStringLiteralLike(property.initializer) ? property.initializer.text : null;
  }
  return null;
}

function readBooleanProperty(object: ts.ObjectLiteralExpression, propertyName: string): boolean | null {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property) || !isPropertyNamed(property.name, propertyName)) {
      continue;
    }
    if (property.initializer.kind === ts.SyntaxKind.TrueKeyword) {
      return true;
    }
    if (property.initializer.kind === ts.SyntaxKind.FalseKeyword) {
      return false;
    }
  }
  return null;
}

function readStringArrayProperty(object: ts.ObjectLiteralExpression, propertyName: string): readonly string[] {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property) || !isPropertyNamed(property.name, propertyName)) {
      continue;
    }
    const initializer = property.initializer;
    if (!ts.isArrayLiteralExpression(initializer)) {
      return [];
    }
    return initializer.elements
      .filter((element): element is ts.StringLiteralLike => ts.isStringLiteralLike(element))
      .map((element) => element.text);
  }
  return [];
}

function isPropertyNamed(name: ts.PropertyName, expected: string): boolean {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text === expected;
  }
  return false;
}

function unwrapExpression(expression: ts.Expression | undefined): ts.Expression | undefined {
  let current = expression;
  while (current && (ts.isAsExpression(current) || ts.isTypeAssertionExpression(current) || ts.isParenthesizedExpression(current))) {
    current = current.expression;
  }
  return current;
}

function visit(node: ts.Node, visitor: (node: ts.Node) => void): void {
  visitor(node);
  ts.forEachChild(node, (child) => visit(child, visitor));
}

function collectEntityFiles(root: string): readonly string[] {
  const files: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
      } else if (entry.isFile() && entry.name.endsWith('.entity.ts')) {
        files.push(path);
      }
    }
  }
  return files.sort();
}

function collectMigrationFiles(root: string): readonly string[] {
  if (!existsSync(root)) {
    return [];
  }
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts'))
    .map((entry) => resolve(root, entry.name))
    .sort();
}

function resolveInsideWorkspace(workspaceRoot: string, requestedPath: string): string {
  const root = resolve(workspaceRoot);
  const resolved = resolve(root, requestedPath);
  const relativePath = relative(root, resolved);
  if (relativePath.startsWith('..') || relativePath === '..' || relativePath.includes(`..${sep}`)) {
    throw new Error(`path escapes workspace root: ${requestedPath}`);
  }
  return resolved;
}

function addReadPath(result: AnalysisResult, workspaceRoot: string, path: string): void {
  result.readPaths.push(normalizePath(relative(workspaceRoot, path)));
}

function normalizePath(path: string): string {
  return path.split(sep).join('/');
}

function readStdin(): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      input += chunk;
    });
    process.stdin.on('end', () => resolvePromise(input));
    process.stdin.on('error', reject);
  });
}

async function main(): Promise<void> {
  const rawInput = await readStdin();
  const input = rawInput.trim().length > 0 ? (JSON.parse(rawInput) as AdapterInput) : {};
  process.stdout.write(`${JSON.stringify(analyzeTypeOrmEntities(input))}\n`);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
