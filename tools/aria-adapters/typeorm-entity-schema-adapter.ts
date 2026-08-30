#!/usr/bin/env ts-node
import { relative } from 'node:path';

import ts from 'typescript';

import {
  collectFiles,
  filterFilesBySnapshot,
  isArchivedWorkspacePath,
  normalizeWorkspacePath,
  pathAllowedBySnapshot,
  readWorkspaceFile,
  readWorkspaceJson,
  resolveInsideWorkspace as resolveAdapterPath,
  workspacePathExists,
} from './adapter-fs';

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
  // FAZ 7 — multi-service sweep. When present (or when neither `root` nor
  // `services` is given, via DEFAULT_SERVICES), the adapter runs its full
  // check set per service and merges the outputs; schema-drift discipline
  // stops being a farm-only property.
  readonly services?: readonly { readonly root: string; readonly serviceName: string }[];
  readonly checks?: readonly CheckName[];
  readonly allowlist?: readonly string[];
  readonly dbSnapshotPath?: string;
  readonly moduleTableAllowlist?: readonly string[];
  readonly repo_snapshot?: { readonly allowed_paths?: readonly string[]; readonly snapshot_hash?: string; readonly repo_state_id?: string };
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

/**
 * E13 spot-audit FP class (1) — ADR-011 schema-ownership policy, DERIVED from
 * the SSoT file (`libs/backend-common/src/database/schema-manager.service.ts`)
 * by parsing its source text. Never hardcode a copy of either list here:
 * per-tenant tables in tenant-scoped services (TENANT_SCOPED_MODULES)
 * CORRECTLY omit `schema:` so search_path routes them into `tenant_<uuid>`;
 * only that service's cross-tenant tables (MODULE_SCHEMAS[].infrastructureTables)
 * must declare a literal schema.
 */
interface SchemaOwnershipPolicy {
  /** SSoT file exists and is inside the repo snapshot (when one is given). */
  readonly ssotReadable: boolean;
  /** Parsed TENANT_SCOPED_MODULES set; null when the declaration is absent (fail-closed). */
  readonly tenantScopedModules: ReadonlySet<string> | null;
  readonly moduleSchema: ModuleSchemaRecord | null;
  readonly infrastructureTables: ReadonlySet<string>;
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
// FAZ 7 — the schema-per-tenant services from MODULE_SCHEMAS (ADR-011).
// Scanning only farm-service made schema drift a farm-only property while
// six sibling services carried the identical per-tenant discipline unwatched.
const DEFAULT_SERVICES: readonly { readonly root: string; readonly serviceName: string }[] = [
  { root: 'apps/alert-engine/src', serviceName: 'alert' },
  { root: 'apps/ai-service/src', serviceName: 'ai' },
  { root: 'apps/farm-service/src', serviceName: 'farm' },
  { root: 'apps/hr-service/src', serviceName: 'hr' },
  { root: 'apps/hydroponics-service/src', serviceName: 'hydroponics' },
  { root: 'apps/messaging-service/src', serviceName: 'messaging' },
  { root: 'apps/sensor-service/src', serviceName: 'sensor' },
];

export function analyzeTypeOrmEntities(
  input: AdapterInput,
  workspaceRoot = process.cwd(),
): AriaOutput {
  // FAZ 7 — multi-service fan-out. Explicit `root` keeps the historical
  // single-service call shape (fixtures, targeted runs); everything else
  // sweeps the declared service list and merges.
  if (input.root === undefined) {
    const services = (input.services ?? DEFAULT_SERVICES).filter((service) =>
      workspacePathExists(resolveInsideWorkspace(workspaceRoot, service.root)),
    );
    const outputs = services.map((service) =>
      analyzeTypeOrmEntities(
        { ...input, services: undefined, root: service.root, serviceName: service.serviceName },
        workspaceRoot,
      ),
    );
    const merged = <T>(select: (output: AriaOutput) => readonly T[]): T[] =>
      outputs.flatMap((output) => [...select(output)]);
    const readPaths = Array.from(new Set(merged((output) => output.read_paths))).sort();
    return {
      observations: merged((output) => output.observations),
      findings: merged((output) => output.findings),
      read_paths: readPaths,
      evidence_sources: Array.from(new Set(merged((output) => output.evidence_sources))).sort(),
      belief_candidates: merged((output) => output.belief_candidates),
      cost_units: readPaths.length,
      metadata: {
        adapter: 'typeorm-entity-schema-adapter',
        scanMode: 'multi_service_v1',
        services: services.map((service) => service.serviceName),
        findings_count: merged((output) => output.findings).length,
      },
    };
  }
  const requestedRoot = input.root ?? DEFAULT_ROOT;
  const serviceName = input.serviceName ?? 'farm';
  const checks = new Set(input.checks ?? DEFAULT_CHECKS);
  const scanRoot = resolveInsideWorkspace(workspaceRoot, requestedRoot);
  if (!workspacePathExists(scanRoot)) {
    throw new Error(`scan root does not exist: ${requestedRoot}`);
  }

  const allowlist = new Set((input.allowlist ?? []).map(normalizePath));
  const moduleTableAllowlist = new Set((input.moduleTableAllowlist ?? []).map(String));
  const files = filterFilesBySnapshot(collectEntityFiles(scanRoot), workspaceRoot, input);
  // The ownership policy is consulted by BOTH the entity_schema check (per-tenant
  // vs cross-tenant classification) and the module_schema check (declared-table
  // diff), so it is parsed exactly once per service run.
  const policy = loadSchemaOwnershipPolicy(workspaceRoot, serviceName, input);
  const result = analyzeFiles(files, workspaceRoot, allowlist, checks, serviceName, policy);
  if (policy.ssotReadable && (checks.has('entity_schema') || checks.has('module_schema'))) {
    result.readPaths.push(MODULE_SCHEMA_PATH);
  }

  if (checks.has('module_schema')) {
    analyzeModuleSchema(serviceName, result, moduleTableAllowlist, policy);
  }
  if (checks.has('migration_registry')) {
    analyzeMigrationRegistry(workspaceRoot, result, input, requestedRoot, serviceName);
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
        belief_id: `typeorm:${serviceName}-service:entity-schema-surface`,
        claim: `${serviceName}-service has a recurring TypeORM entity and migration surface for schema drift checks`,
        confidence: 0.85,
        evidence_refs: [
          `${requestedRoot.replace(/\/$/, '')}/**/*.ts`,
          `${requestedRoot.replace(/\/$/, '')}/database/migrations/*.ts`,
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
  serviceName: string,
  policy: SchemaOwnershipPolicy,
): AnalysisResult {
  const observations: AdapterObservation[] = [];
  const findings: AdapterFinding[] = [];
  const readPaths = files.map((file) => normalizePath(relative(workspaceRoot, file)));

  for (const file of files) {
    const sourceText = readWorkspaceFile(file);
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
        // ADR-011 (E13 FP class 1): in a tenant-scoped service, omitting
        // `schema:` is the CORRECT pattern for per-tenant tables — search_path
        // routes them into tenant_<uuid> at runtime. A missing schema is only
        // a violation when the table is in that service's cross-tenant
        // infrastructureTables set (parsed from the SSoT, never hardcoded).
        // When the SSoT cannot be read or lacks TENANT_SCOPED_MODULES the
        // check fails closed and keeps the historical always-flag behaviour.
        const effectiveTable = entity.table ?? snakeCaseIdentifier(className);
        const tenantScoped =
          policy.tenantScopedModules !== null && policy.tenantScopedModules.has(serviceName);
        const infrastructureTable = policy.infrastructureTables.has(effectiveTable);
        if (!tenantScoped || infrastructureTable) {
          findings.push({
            id: `typeorm-entity-schema-required:${relativePath}:${line}`,
            rule: 'typeorm_entity_schema_required',
            severity: 'medium',
            path: relativePath,
            line,
            className,
            message: infrastructureTable
              ? `@Entity() for cross-tenant infrastructure table '${effectiveTable}' (MODULE_SCHEMAS['${serviceName}'].infrastructureTables) must declare a non-empty literal schema option.`
              : '@Entity() must declare a non-empty literal schema option unless the entity is explicitly allowlisted as tenant-owned.',
            evidence: [
              { path: relativePath, line },
              ...(infrastructureTable && policy.moduleSchema
                ? [{ path: policy.moduleSchema.path, line: policy.moduleSchema.line }]
                : []),
            ],
            details: { table: effectiveTable, tenantScoped, infrastructureTable },
          });
        }
      }
    });
  }

  return { observations, findings, readPaths };
}

function loadSchemaOwnershipPolicy(
  workspaceRoot: string,
  serviceName: string,
  input: AdapterInput,
): SchemaOwnershipPolicy {
  const modulePath = resolveInsideWorkspace(workspaceRoot, MODULE_SCHEMA_PATH);
  if (!workspacePathExists(modulePath) || !pathAllowedBySnapshot(workspaceRoot, MODULE_SCHEMA_PATH, input)) {
    return {
      ssotReadable: false,
      tenantScopedModules: null,
      moduleSchema: null,
      infrastructureTables: new Set(),
    };
  }
  const sourceFile = ts.createSourceFile(
    modulePath,
    readWorkspaceFile(modulePath),
    ts.ScriptTarget.Latest,
    true,
  );
  const moduleSchema = readModuleSchema(sourceFile, modulePath, workspaceRoot, serviceName);
  return {
    ssotReadable: true,
    tenantScopedModules: readTenantScopedModules(sourceFile),
    moduleSchema,
    infrastructureTables: new Set(moduleSchema?.infrastructureTables ?? []),
  };
}

function analyzeModuleSchema(
  serviceName: string,
  result: AnalysisResult,
  tableAllowlist: ReadonlySet<string>,
  policy: SchemaOwnershipPolicy,
): void {
  if (!policy.ssotReadable) {
    result.observations.push({
      id: 'module-schema:missing-source-file',
      type: 'module_schema_unavailable',
      path: MODULE_SCHEMA_PATH,
    });
    return;
  }
  const moduleSchema = policy.moduleSchema;
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

function analyzeMigrationRegistry(
  workspaceRoot: string,
  result: AnalysisResult,
  input: AdapterInput,
  rootRel: string,
  serviceName: string,
): void {
  // FAZ 7 — derived from the service root instead of farm-only constants,
  // so every swept service gets the same registry discipline.
  const APP_MODULE_PATH = `${rootRel.replace(/\/$/, '')}/app.module.ts`;
  const MIGRATIONS_DIR = `${rootRel.replace(/\/$/, '')}/database/migrations`;
  const appModulePath = resolveInsideWorkspace(workspaceRoot, APP_MODULE_PATH);
  const migrationsDir = resolveInsideWorkspace(workspaceRoot, MIGRATIONS_DIR);
  if (!workspacePathExists(appModulePath) || !workspacePathExists(migrationsDir) || !pathAllowedBySnapshot(workspaceRoot, APP_MODULE_PATH, input)) {
    result.observations.push({
      id: `migration-registry:unavailable:${serviceName}`,
      type: 'migration_registry_unavailable',
      path: APP_MODULE_PATH,
    });
    return;
  }
  addReadPath(result, workspaceRoot, appModulePath);
  const files = filterFilesBySnapshot(collectMigrationFiles(migrationsDir), workspaceRoot, input);
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
  // FAZ 7 — two legitimate registration styles exist (ADR-011): farm-service
  // imports each migration class into app.module.ts (the diffable registry
  // this check was written for), while sibling services register a GLOB in
  // data-source.ts (`migrations: ['src/database/migrations/[0-9]*.ts']`),
  // where every file is registered by construction and a per-class diff can
  // only produce false findings. Detect the style before judging.
  if (registry.registeredClasses.length === 0) {
    const dataSourcePath = `${rootRel.replace(/\/$/, '')}/database/data-source.ts`;
    const dataSourceAbsolute = resolveInsideWorkspace(workspaceRoot, dataSourcePath);
    if (
      workspacePathExists(dataSourceAbsolute) &&
      /migrations:\s*\[[^\]]*database\/migrations\//.test(readWorkspaceFile(dataSourceAbsolute))
    ) {
      addReadPath(result, workspaceRoot, dataSourceAbsolute);
      result.observations.push({
        id: `migration-registry:glob:${serviceName}`,
        type: 'migration_registry_glob',
        path: dataSourcePath,
        details: { files: fileClasses.size },
      });
      return;
    }
  }
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
    id: `migration-registry:${serviceName}`,
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
  if (!workspacePathExists(snapshotPath)) {
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
          // details is loosely typed; String() on a non-string object prints
          // '[object Object]' — narrow instead of coercing.
          propertyName:
            typeof details.propertyName === 'string'
              ? details.propertyName
              : (observation.column ?? ''),
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
  // NOTE: both arguments are optional — bare `@Entity()` is legal TypeORM
  // (table name then defaults to snakeCase(className)), so each guard must
  // tolerate an absent node before asking TypeScript for its kind.
  const firstArg = call.arguments[0];
  const secondArg = call.arguments[1];
  const optionsArg = firstArg && ts.isObjectLiteralExpression(firstArg)
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
  // `secondArg` died when findObjectArg took over options discovery —
  // removed rather than underscore-parked (İ2: dead code is deleted).
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
  sourceFile: ts.SourceFile,
  path: string,
  workspaceRoot: string,
  serviceName: string,
): ModuleSchemaRecord | null {
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

/**
 * Parses `TENANT_SCOPED_MODULES` (`new Set(['farm', …])`) out of the SSoT
 * source. WHY parse instead of import: the adapter must observe the exact
 * on-disk contents of the workspace under analysis (fixtures included), and
 * importing the module would execute NestJS/TypeORM side effects.
 * Returns null when the declaration is absent so callers fail closed.
 */
function readTenantScopedModules(sourceFile: ts.SourceFile): ReadonlySet<string> | null {
  let found: ReadonlySet<string> | null = null;
  visit(sourceFile, (node) => {
    if (
      found !== null ||
      !ts.isVariableDeclaration(node) ||
      !ts.isIdentifier(node.name) ||
      node.name.text !== 'TENANT_SCOPED_MODULES'
    ) {
      return;
    }
    const initializer = unwrapExpression(node.initializer);
    if (!initializer || !ts.isNewExpression(initializer)) {
      return;
    }
    if (!ts.isIdentifier(initializer.expression) || initializer.expression.text !== 'Set') {
      return;
    }
    const firstArg = initializer.arguments?.[0];
    if (!firstArg || !ts.isArrayLiteralExpression(firstArg)) {
      return;
    }
    found = new Set(
      firstArg.elements
        .filter((element): element is ts.StringLiteralLike => ts.isStringLiteralLike(element))
        .map((element) => element.text),
    );
  });
  return found;
}

/**
 * TypeORM DefaultNamingStrategy falls back to snakeCase(className) when
 * @Entity() carries no explicit table name; mirror it so infrastructure-table
 * membership still resolves for bare `@Entity()` declarations.
 */
function snakeCaseIdentifier(name: string): string {
  return name
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase();
}

function readMigrationRegistry(path: string, workspaceRoot: string): MigrationRegistry {
  const sourceFile = ts.createSourceFile(path, readWorkspaceFile(path), ts.ScriptTarget.Latest, true);
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
  const sourceFile = ts.createSourceFile(path, readWorkspaceFile(path), ts.ScriptTarget.Latest, true);
  for (const statement of sourceFile.statements) {
    if (ts.isClassDeclaration(statement) && statement.name) {
      return statement.name.text;
    }
  }
  return null;
}

function readJson(path: string): unknown {
  return readWorkspaceJson(path);
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
  return collectFiles(root, {
    extensions: ['.entity.ts'],
    // E13 FP class (2): archived corpus is dead code — no schema discipline applies.
    includeFile: (name, path) => !isArchivedWorkspacePath(path),
  });
}

function collectMigrationFiles(root: string): readonly string[] {
  if (!workspacePathExists(root)) {
    return [];
  }
  return collectFiles(root, {
    extensions: ['.ts'],
    // E13 FP class (2): `.archive/<timestamp>/` migration snapshots are retired
    // by definition — they are never registered, so diffing them against the
    // live registry can only produce false findings.
    includeFile: (name, path) =>
      !name.endsWith('.spec.ts') &&
      !name.endsWith('.test.ts') &&
      !name.endsWith('.d.ts') &&
      !isArchivedWorkspacePath(path),
  });
}

function resolveInsideWorkspace(workspaceRoot: string, requestedPath: string): string {
  return resolveAdapterPath(workspaceRoot, requestedPath);
}

function addReadPath(result: AnalysisResult, workspaceRoot: string, path: string): void {
  result.readPaths.push(normalizePath(relative(workspaceRoot, path)));
}

function normalizePath(path: string): string {
  return normalizeWorkspacePath(path);
}

function readStdin(): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    // setEncoding('utf8') makes every chunk a string at runtime, but the
    // stream's declared chunk type stays `string | Buffer` — concatenating the
    // union is what the type checker rejects. Narrow at the boundary rather
    // than widening `input` (kernel-dead-wire-adapter is the converged shape).
    process.stdin.on('data', (chunk: string | Buffer) => {
      input += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
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
