#!/usr/bin/env ts-node
// ARIA-HIGH-011 — SQL and TypeORM migration-safety observation (Task 14).
//
// WHY: ARIA read no migration for safety. typeorm-entity-schema-adapter checks
// that migrations are registered and match the schema snapshot; nothing
// observed what a migration DOES — the destructive DDL, the one-step NOT NULL,
// the shared-enum drop that took production down on 2026-07-07, the
// hand-rolled RLS predicate. The repository already decides each of those in
// a gate; ARIA saw none of the verdicts.
//
// WHAT: an observation wrapper around the gates that own migration policy. It
// adds no SQL rule of its own — every verdict below comes from one owner, the
// same module its gate runs, so the gate and the observation cannot disagree:
//
//   tools/gates/migration-sql-lint.ts        delta-safety rules R1–R14
//                                            (`inspectMigrationSource`; R13/R14,
//                                            ADR-053, live in
//                                            migration-add-column-rules.ts and
//                                            migration-sql-structure.ts)
//   tools/gates/expand-contract-ast.ts       @ExpandContract phase discipline
//                                            (`inspectSource`, `validateInspections`)
//   tools/gates/migration-shared-enum-drop.ts orphan-type reclamation
//                                            (`findUnguardedSharedEnumDrop`)
//   tools/gates/rls-predicate-canonical.ts   canonical tenant RLS predicate
//                                            (`findNonCanonicalTenantPolicies`)
//   tools/gates/tenant-aware-migration-ddl.ts qualified/re-pinned DDL that
//                                            escapes the tenant replay
//                                            (`qualifiedDdlOffences`,
//                                             `sourcePinOffences`)
//
// Each owner's SCOPE is its own predicate too (`isMigrationFile`,
// `isExpandContractMigrationPath`, `isTenantAwareMigrationPath`,
// `isRlsPredicateScopedPath`), and so is each owner's grandfather policy:
//
//   - The delta-safety rules bind migrations ADDED by a change set — the gate
//     runs with `--diff-filter=A`, because amending an applied migration is
//     forbidden and TypeORM never re-runs one. A violation in a migration
//     outside `addedPaths` is therefore recorded on the file's observation
//     (`grandfathered_violations`), never raised as a finding: a finding there
//     would ask ARIA to hand-edit a migration production already ran. The
//     same holds for expand-contract's advisory (`warn`) verdict.
//   - Expand-contract errors, the shared-enum drop, the RLS predicate and the
//     tenant-aware qualified-DDL guard are whole-tree invariants (their gates
//     fail on any file in scope, with their own grandfather lists), so they
//     are findings wherever they occur.
//
// Projection, not policy: each finding carries the owner's rule id and
// message, the migration direction (`up`, `down`, `helper`, or `file` for a
// `.sql` script), the source range, the target commit, and a fingerprint that
// survives line shifts. A TypeScript migration that does not parse is an
// observation error (`migration_parse_failure`), never a clean result; a
// `.query(...)` whose SQL is not a template literal is counted as opaque,
// because no owner can read it.
//
// The tenant-aware DDL guard classifies against the workspace's own
// MODULE_SCHEMAS, read as source text by `module-schemas-source.ts` — the
// reader that resolves the spread/import chains the runtime value uses, which
// is what lets this adapter carry the guard at all (ARIA-MEDIUM-588). The
// adapter-side registry is held equal to the runtime MODULE_SCHEMAS by
// `tests/invariants/module-schemas-source-parity.spec.ts`.
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';

import ts from 'typescript';

import {
  inspectSource,
  isExpandContractMigrationPath,
  validateInspections,
  type AstViolation,
  type DecoratorInspection,
} from '../gates/expand-contract-ast';
import {
  findUnguardedSharedEnumDrop,
  isTenantAwareMigrationPath,
} from '../gates/migration-shared-enum-drop';
import {
  MIGRATION_SQL_LINT_RULE_IDS,
  inspectMigrationSource,
  isMigrationFile,
  type Violation,
} from '../gates/migration-sql-lint';
import {
  RLS_PREDICATE_GRANDFATHERED,
  findNonCanonicalTenantPolicies,
  isRlsPredicateScopedPath,
} from '../gates/rls-predicate-canonical';
import {
  RETIRED_SOURCE_TABLES,
  isReviewedSourceSchemaDdl,
  moduleSchemaRegistry,
  qualifiedDdlOffences,
  sourcePinOffences,
  tenantAwareSourceSchemaOf,
  type TenantAwareDdlRegistry,
} from '../gates/tenant-aware-migration-ddl';

import {
  collectFiles,
  containedWorkspace,
  filterFilesBySnapshot,
  isArchivedWorkspacePath,
  isWorkspaceRelativePath,
  normalizeWorkspacePath,
  pathAllowedBySnapshot,
  requireScanRoots,
  type RepoSnapshot,
} from './adapter-fs';
import { MODULE_SCHEMAS_SOURCE_PATH, readModuleSchemasSource } from './module-schemas-source';

const TOOL_ID = 'sql-migration-safety-adapter';

interface AdapterInput {
  readonly roots?: readonly string[];
  /**
   * A workspace-relative directory under which the scanned tree mirrors the
   * repository layout (a fixture workspace). The owners' path questions — is
   * this a tenant-aware migration, is it grandfathered — are asked of the path
   * below it; evidence still cites the workspace path. Absent in production.
   */
  readonly pathBase?: string;
  /**
   * Workspace-relative paths of the migrations a change set ADDS — the set the
   * delta-safety gate lints (`--diff-filter=A`). Absent: no migration is new.
   */
  readonly addedPaths?: readonly string[];
  readonly repo_snapshot?: RepoSnapshot & { readonly base_commit_sha?: string | null };
}

interface EvidenceRef {
  readonly path: string;
  readonly line?: number;
}

interface AdapterObservation {
  readonly id: string;
  readonly type: string;
  readonly path?: string;
  readonly details?: Record<string, unknown>;
}

type Direction = 'up' | 'down' | 'helper' | 'file';
type FindingSeverity = 'critical' | 'high' | 'medium' | 'low';

type MigrationRule =
  | 'destructive_ddl_without_marker'
  | 'single_step_add_not_null'
  | 'create_index_not_idempotent'
  | 'session_scoped_search_path'
  | 'overbroad_exception_catch'
  | 'create_table_without_if_not_exists'
  | 'create_type_without_do_block'
  | 'add_column_without_if_not_exists'
  | 'alter_column_unguarded'
  | 'add_constraint_without_do_block'
  | 'drop_table_without_if_exists'
  | 'add_column_rewriting_default'
  | 'add_column_exemption_shape'
  | 'expand_contract_missing_depends_on'
  | 'expand_contract_depends_on_unresolved'
  | 'breaking_ddl_without_expand_contract'
  | 'unguarded_shared_enum_drop'
  | 'rls_predicate_not_canonical'
  | 'qualified_ddl_escapes_tenant_replay';

interface AdapterFinding {
  readonly id: string;
  readonly rule: MigrationRule;
  readonly severity: FindingSeverity;
  readonly path: string;
  readonly line: number;
  readonly message: string;
  readonly evidence: readonly EvidenceRef[];
  readonly confidence: number;
  /** The owning gate and the rule id it reports under. */
  readonly owner: string;
  readonly owner_rule_id: string;
  readonly direction: Direction;
  readonly range: { readonly start_line: number; readonly end_line: number };
  /** The relation, type, policy or class the owner names, when it names one. */
  readonly subject: string | null;
  readonly remediation: string;
  readonly target_sha: string | null;
  readonly fingerprint: string;
}

interface AriaOutput {
  readonly observations: readonly AdapterObservation[];
  readonly findings: readonly AdapterFinding[];
  readonly read_paths: readonly string[];
  readonly evidence_sources: readonly string[];
  readonly belief_candidates: readonly unknown[];
  readonly cost_units: number;
  readonly metadata: Record<string, unknown>;
}

interface Projection {
  readonly rule: MigrationRule;
  readonly severity: FindingSeverity;
  readonly confidence: number;
}

const SQL_LINT_OWNER = 'tools/gates/migration-sql-lint.ts';
/** The ADR-053 ADD COLUMN rules (R13/R14) the SQL-lint owner imports. */
const SQL_LINT_ADD_COLUMN_RULES = 'tools/gates/migration-add-column-rules.ts';
const SQL_LINT_STRUCTURE = 'tools/gates/migration-sql-structure.ts';
const EXPAND_CONTRACT_OWNER = 'tools/gates/expand-contract-ast.ts';
const ENUM_DROP_OWNER = 'tools/gates/migration-shared-enum-drop.ts';
const RLS_OWNER = 'tools/gates/rls-predicate-canonical.ts';
const TENANT_DDL_OWNER = 'tools/gates/tenant-aware-migration-ddl.ts';

/**
 * The files whose text decides a verdict here: the five owners (with the
 * modules the SQL-lint owner imports its R13/R14 rules from), and the
 * platform catalog the tenant-aware migration directories derive from. Their
 * hashes are the observation's provenance (`metadata.authorities`): the same
 * finding under a different hash came from a different rule.
 */
const AUTHORITY_PATHS: readonly string[] = [
  SQL_LINT_OWNER,
  SQL_LINT_ADD_COLUMN_RULES,
  SQL_LINT_STRUCTURE,
  EXPAND_CONTRACT_OWNER,
  ENUM_DROP_OWNER,
  RLS_OWNER,
  TENANT_DDL_OWNER,
  'platform/libs/service-catalog/src/index.ts',
  'platform/libs/service-catalog/src/topology.ts',
];

/**
 * migration-sql-lint's rule ids onto this adapter's rule vocabulary. The gate
 * reports severities CRITICAL/HIGH/MEDIUM; the finding keeps them.
 * `assertLintProjectionComplete` refuses to run when the gate grows a rule
 * this table does not project.
 */
export const SQL_LINT_PROJECTION: Readonly<Record<string, Projection>> = {
  'R1-destructive-without-marker': {
    rule: 'destructive_ddl_without_marker',
    severity: 'critical',
    confidence: 0.85,
  },
  'R2-single-step-add-not-null': {
    rule: 'single_step_add_not_null',
    severity: 'high',
    confidence: 0.85,
  },
  'R3-create-index-not-idempotent': {
    rule: 'create_index_not_idempotent',
    severity: 'medium',
    confidence: 0.85,
  },
  'R4-session-scoped-set-search-path': {
    rule: 'session_scoped_search_path',
    severity: 'critical',
    confidence: 0.85,
  },
  'R5-overbroad-exception-catch': {
    rule: 'overbroad_exception_catch',
    severity: 'high',
    confidence: 0.85,
  },
  'R6-create-table-without-if-not-exists': {
    rule: 'create_table_without_if_not_exists',
    severity: 'medium',
    confidence: 0.85,
  },
  'R8-create-type-without-do-block': {
    rule: 'create_type_without_do_block',
    severity: 'medium',
    confidence: 0.85,
  },
  'R9-add-column-without-if-not-exists': {
    rule: 'add_column_without_if_not_exists',
    severity: 'medium',
    confidence: 0.85,
  },
  'R10-alter-column-unguarded': {
    rule: 'alter_column_unguarded',
    severity: 'medium',
    confidence: 0.85,
  },
  'R11-add-constraint-without-do-block': {
    rule: 'add_constraint_without_do_block',
    severity: 'medium',
    confidence: 0.85,
  },
  'R12-drop-table-without-if-exists': {
    rule: 'drop_table_without_if_exists',
    severity: 'critical',
    confidence: 0.85,
  },
  'R13-add-column-rewriting-default': {
    rule: 'add_column_rewriting_default',
    severity: 'high',
    confidence: 0.85,
  },
  'R14-add-column-exemption-shape': {
    rule: 'add_column_exemption_shape',
    severity: 'high',
    confidence: 0.85,
  },
};

const EXPAND_CONTRACT_PROJECTION: Readonly<Record<AstViolation['kind'], Projection>> = {
  contract_missing_dependsOn: {
    rule: 'expand_contract_missing_depends_on',
    severity: 'high',
    confidence: 0.9,
  },
  dependsOn_unresolved: {
    rule: 'expand_contract_depends_on_unresolved',
    severity: 'high',
    confidence: 0.9,
  },
  breaking_ddl_without_decorator: {
    rule: 'breaking_ddl_without_expand_contract',
    severity: 'low',
    confidence: 0.7,
  },
};

const ENUM_DROP_PROJECTION: Projection = {
  rule: 'unguarded_shared_enum_drop',
  severity: 'critical',
  confidence: 0.9,
};
const RLS_PROJECTION: Projection = {
  rule: 'rls_predicate_not_canonical',
  severity: 'critical',
  confidence: 0.9,
};
const TENANT_DDL_PROJECTION: Projection = {
  rule: 'qualified_ddl_escapes_tenant_replay',
  severity: 'high',
  confidence: 0.9,
};

const ENUM_DROP_REMEDIATION =
  'Drop the COLUMN in every schema and leave the orphaned enum; a migration that must reclaim the type ' +
  'needs a pg_depend "no dependents remain" gate AND a SHARED-ENUM-DROP-REVIEWED annotation ' +
  '(tools/gates/migration-shared-enum-drop.ts).';
const RLS_REMEDIATION =
  'Replace the inline CREATE POLICY with applyTenantRlsToSchema(queryRunner, {...}) from ' +
  'libs/backend-common/src/database/rls/apply-tenant-rls.helper.ts, which emits the canonical predicate.';
const TENANT_DDL_REMEDIATION =
  'Drop the schema prefix so the replay search_path routes the DDL into tenant_<uuid>, or — if the ' +
  'table really is cross-tenant — register it in MODULE_SCHEMAS[].infrastructureTables ' +
  '(tools/gates/tenant-aware-migration-ddl.ts).';

/**
 * The tenant-aware DDL registry, read once per run from the workspace's own
 * MODULE_SCHEMAS source text (ARIA-MEDIUM-588). `ready === false` names why:
 * without a registry the guard cannot classify, and the failure is recorded as
 * an observation — never as silence and never as a guessed verdict.
 */
interface TenantDdlRegistries {
  readonly ready: boolean;
  readonly reason: string | null;
  readonly bySchema: ReadonlyMap<string, TenantAwareDdlRegistry>;
  readonly readPaths: readonly string[];
}

function loadTenantDdlRegistries(
  workspace: ReturnType<typeof containedWorkspace>,
  workspaceRoot: string,
): TenantDdlRegistries {
  if (workspace.entry(MODULE_SCHEMAS_SOURCE_PATH) !== 'file') {
    return {
      ready: false,
      reason: `no ${MODULE_SCHEMAS_SOURCE_PATH} in the workspace`,
      bySchema: new Map(),
      readPaths: [],
    };
  }
  const source = readModuleSchemasSource(workspaceRoot);
  if (source.errors.length > 0) {
    return {
      ready: false,
      reason: `MODULE_SCHEMAS reader errors: ${source.errors.map((error) => error.message).join('; ')}`,
      bySchema: new Map(),
      readPaths: source.readPaths,
    };
  }
  const bySchema = new Map<string, TenantAwareDdlRegistry>();
  for (const module of source.modules) {
    bySchema.set(
      module.sourceSchema,
      moduleSchemaRegistry(module, RETIRED_SOURCE_TABLES.get(module.sourceSchema) ?? new Set()),
    );
  }
  return { ready: true, reason: null, bySchema, readPaths: source.readPaths };
}

export function assertLintProjectionComplete(): void {
  const missing = MIGRATION_SQL_LINT_RULE_IDS.filter((id) => SQL_LINT_PROJECTION[id] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `${TOOL_ID}: migration-sql-lint reports rule(s) ${missing.join(', ')} that this adapter does not ` +
        'project; add them to SQL_LINT_PROJECTION and the manifest rules before the adapter can run.',
    );
  }
}

/** What the TypeScript compiler says about one migration's shape. */
interface MigrationShape {
  readonly methods: readonly {
    readonly name: 'up' | 'down';
    readonly start: number;
    readonly end: number;
  }[];
  readonly classLines: ReadonlyMap<string, number>;
  readonly templateQueryCalls: number;
  readonly opaqueQueryCalls: number;
  readonly parseFailure: { readonly line: number; readonly message: string } | null;
}

function lineOf(sourceFile: ts.SourceFile, position: number): number {
  return sourceFile.getLineAndCharacterOfPosition(position).line + 1;
}

function typeOrmShape(path: string, source: string): MigrationShape {
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.ES2022, true);
  const methods: { name: 'up' | 'down'; start: number; end: number }[] = [];
  const classLines = new Map<string, number>();
  let templateQueryCalls = 0;
  let opaqueQueryCalls = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name !== undefined) {
      classLines.set(node.name.text, lineOf(sourceFile, node.getStart(sourceFile)));
      for (const member of node.members) {
        if (
          ts.isMethodDeclaration(member) &&
          ts.isIdentifier(member.name) &&
          (member.name.text === 'up' || member.name.text === 'down') &&
          member.body !== undefined
        ) {
          methods.push({
            name: member.name.text,
            start: lineOf(sourceFile, member.getStart(sourceFile)),
            end: lineOf(sourceFile, member.body.getEnd()),
          });
        }
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'query'
    ) {
      const first = node.arguments[0];
      if (
        first !== undefined &&
        (ts.isNoSubstitutionTemplateLiteral(first) || ts.isTemplateExpression(first))
      ) {
        templateQueryCalls += 1;
      } else {
        opaqueQueryCalls += 1;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  // Syntax only: the file is read, never type-checked or executed.
  const transpiled = ts.transpileModule(source, {
    fileName: path,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      experimentalDecorators: true,
    },
  });
  const diagnostic = (transpiled.diagnostics ?? [])[0];
  let parseFailure: MigrationShape['parseFailure'] = null;
  if (diagnostic !== undefined) {
    const at =
      diagnostic.file !== undefined && diagnostic.start !== undefined
        ? lineOf(diagnostic.file, diagnostic.start)
        : 1;
    parseFailure = {
      line: at,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ').slice(0, 300),
    };
  }
  return { methods, classLines, templateQueryCalls, opaqueQueryCalls, parseFailure };
}

function directionAt(shape: MigrationShape | null, line: number): Direction {
  if (shape === null) return 'file';
  const method = shape.methods.find(
    (candidate) => line >= candidate.start && line <= candidate.end,
  );
  return method === undefined ? 'helper' : method.name;
}

function sha256(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

/** The workspace path the owners' path predicates are asked about. */
function repoShapedPath(workspacePath: string, pathBase: string | null): string | null {
  if (pathBase === null) return workspacePath;
  return workspacePath.startsWith(`${pathBase}/`) ? workspacePath.slice(pathBase.length + 1) : null;
}

interface FileVerdict {
  readonly path: string;
  readonly repoPath: string;
  readonly source: string;
  readonly kind: 'typeorm' | 'sql';
  readonly shape: MigrationShape | null;
  readonly added: boolean;
}

export function analyzeMigrationSafety(
  input: AdapterInput,
  workspaceRoot = process.cwd(),
): AriaOutput {
  assertLintProjectionComplete();
  const roots = requireScanRoots(TOOL_ID, input.roots);
  const workspace = containedWorkspace(workspaceRoot);
  const pathBase = input.pathBase === undefined ? null : input.pathBase;
  if (pathBase !== null && !isWorkspaceRelativePath(pathBase)) {
    throw new Error(
      `${TOOL_ID}: pathBase must be a normalised workspace-relative path: ${pathBase}`,
    );
  }
  const targetSha = input.repo_snapshot?.base_commit_sha ?? null;
  const addedPaths = new Set((input.addedPaths ?? []).map((path) => normalizeWorkspacePath(path)));
  const readPaths = new Set<string>();
  const observations: AdapterObservation[] = [];
  const findings: AdapterFinding[] = [];

  // A root that is not a contained workspace path is a caller error, not an
  // empty scan; a root that does not exist in this checkout scans nothing.
  const rootDirs = roots.filter((root) => {
    const entry = workspace.entry(root);
    if (entry === 'refused') {
      throw new Error(`${TOOL_ID}: root is not a contained workspace-relative path: ${root}`);
    }
    return entry === 'directory';
  });
  const candidates = filterFilesBySnapshot(
    rootDirs.flatMap((root) =>
      collectFiles(workspaceRoot, join(workspaceRoot, root), { extensions: ['.ts', '.sql'] }),
    ),
    workspaceRoot,
    input,
  );

  const files: FileVerdict[] = [];
  for (const absolute of candidates) {
    const path = normalizeWorkspacePath(relative(workspaceRoot, absolute));
    const repoPath = repoShapedPath(path, pathBase);
    if (repoPath === null || isArchivedWorkspacePath(repoPath)) continue;
    const inScope =
      isMigrationFile(repoPath) ||
      isExpandContractMigrationPath(repoPath) ||
      isTenantAwareMigrationPath(repoPath) ||
      isRlsPredicateScopedPath(repoPath);
    if (!inScope || /\.(spec|test)\.ts$/.test(repoPath) || repoPath.includes('/__tests__/'))
      continue;
    const source = workspace.readFile(path);
    readPaths.add(path);
    const kind = path.endsWith('.sql') ? 'sql' : 'typeorm';
    files.push({
      path,
      repoPath,
      source,
      kind,
      shape: kind === 'typeorm' ? typeOrmShape(path, source) : null,
      added: addedPaths.has(path),
    });
  }

  const emit = (
    file: FileVerdict,
    projection: Projection,
    owner: string,
    ownerRuleId: string,
    line: number,
    snippet: string,
    message: string,
    remediation: string,
    subject: string | null,
    occurrence: number,
    direction: Direction = directionAt(file.shape, line),
  ): void => {
    const fingerprint = sha256(
      [
        projection.rule,
        file.path,
        ownerRuleId,
        snippet.replace(/\s+/g, ' ').trim(),
        String(occurrence),
      ].join('\n'),
    );
    findings.push({
      id: `${TOOL_ID}:${projection.rule}:${file.path}:${fingerprint.slice(7, 23)}`,
      rule: projection.rule,
      severity: projection.severity,
      path: file.path,
      line,
      message,
      evidence: [{ path: file.path, line }],
      confidence: projection.confidence,
      owner,
      owner_rule_id: ownerRuleId,
      direction,
      range: { start_line: line, end_line: line + Math.max(0, snippet.split('\n').length - 1) },
      subject,
      remediation,
      target_sha: targetSha,
      fingerprint,
    });
  };

  // --------------------------------------- tenant-aware DDL (whole scope)
  // The guard's registry comes from THIS workspace's MODULE_SCHEMAS source
  // text (the reader that resolves spread/import entries — ARIA-MEDIUM-588);
  // the same verdicts the invariant gate produces from the runtime import.
  const tenantDdlRegistries = loadTenantDdlRegistries(workspace, workspaceRoot);
  for (const path of tenantDdlRegistries.readPaths) {
    readPaths.add(path);
  }
  const tenantDdlReportedSchemas = new Set<string>();
  const tenantDdlRegistryFor = (schema: string): TenantAwareDdlRegistry | null => {
    if (!tenantDdlRegistries.ready) {
      if (!tenantDdlReportedSchemas.has(schema)) {
        tenantDdlReportedSchemas.add(schema);
        observations.push({
          id: `${TOOL_ID}:tenant-aware-ddl-registry-unavailable:${schema}`,
          type: 'tenant_aware_ddl_registry_unavailable',
          details: { schema, reason: tenantDdlRegistries.reason },
        });
      }
      return null;
    }
    const registry = tenantDdlRegistries.bySchema.get(schema);
    if (registry === undefined && !tenantDdlReportedSchemas.has(schema)) {
      tenantDdlReportedSchemas.add(schema);
      observations.push({
        id: `${TOOL_ID}:tenant-aware-ddl-registry-unavailable:${schema}`,
        type: 'tenant_aware_ddl_registry_unavailable',
        details: {
          schema,
          reason: `MODULE_SCHEMAS has no entry for source schema '${schema}'`,
        },
      });
    }
    return registry ?? null;
  };

  // ------------------------------------------ expand-contract (whole scope)
  // `validateInspections` resolves `dependsOn` against every inspected class,
  // so it runs once over the whole scoped set, exactly as the gate's walk.
  const expandScoped = files.filter(
    (file) => file.kind === 'typeorm' && isExpandContractMigrationPath(file.repoPath),
  );
  const inspections: DecoratorInspection[] = expandScoped.flatMap((file) =>
    inspectSource(file.path, file.source),
  );
  const expandViolations = validateInspections(inspections);

  const grandfatheredByPath = new Map<string, Record<string, number>>();
  const countGrandfathered = (file: FileVerdict, ownerRuleId: string): void => {
    const counts = grandfatheredByPath.get(file.path) ?? {};
    counts[ownerRuleId] = (counts[ownerRuleId] ?? 0) + 1;
    grandfatheredByPath.set(file.path, counts);
  };
  const occurrences = new Map<string, number>();
  const nextOccurrence = (key: string): number => {
    const next = (occurrences.get(key) ?? 0) + 1;
    occurrences.set(key, next);
    return next;
  };

  const byPath = new Map(files.map((file) => [file.path, file]));
  for (const violation of expandViolations) {
    const file = byPath.get(violation.filePath);
    if (file === undefined) continue;
    const projection = EXPAND_CONTRACT_PROJECTION[violation.kind];
    if (violation.severity === 'warn' && !file.added) {
      countGrandfathered(file, violation.kind);
      continue;
    }
    const line =
      (file.shape === null ? undefined : file.shape.classLines.get(violation.className)) ?? 1;
    emit(
      file,
      projection,
      EXPAND_CONTRACT_OWNER,
      violation.kind,
      line,
      `class ${violation.className}`,
      `${violation.className}: ${violation.details}`,
      violation.details,
      violation.className,
      nextOccurrence(`${violation.kind}:${file.path}:${violation.className}`),
      // A class-level verdict about the forward path: the gate reads only the
      // up() body for breaking DDL, and the phase order governs when up() runs.
      'up',
    );
  }

  let parseFailures = 0;
  let opaqueQueryCalls = 0;
  for (const file of files) {
    // ---------------------------------------- delta-safety rules (change set)
    const lintViolations: readonly Violation[] = isMigrationFile(file.repoPath)
      ? inspectMigrationSource(file.repoPath, file.source)
      : [];
    for (const violation of lintViolations) {
      if (!file.added) {
        countGrandfathered(file, violation.ruleId);
        continue;
      }
      const projection = SQL_LINT_PROJECTION[violation.ruleId];
      if (projection === undefined) {
        throw new Error(`${TOOL_ID}: unprojected migration-sql-lint rule ${violation.ruleId}`);
      }
      emit(
        file,
        projection,
        SQL_LINT_OWNER,
        violation.ruleId,
        violation.line,
        violation.snippet,
        violation.message,
        violation.message,
        null,
        nextOccurrence(`${violation.ruleId}:${file.path}:${violation.snippet}`),
      );
    }

    // ------------------------------------ orphan-type reclamation (scope-wide)
    if (file.kind === 'typeorm' && isTenantAwareMigrationPath(file.repoPath)) {
      const drop = findUnguardedSharedEnumDrop(file.source);
      if (drop !== null) {
        const type = /\bDROP\s+TYPE\s+(?:IF\s+EXISTS\s+)?([\w."]+)/i.exec(drop.snippet);
        emit(
          file,
          ENUM_DROP_PROJECTION,
          ENUM_DROP_OWNER,
          'unguarded-shared-enum-drop',
          drop.line,
          drop.snippet,
          'up() drops a type in a tenant-aware migration without the pg_depend dependents gate and the ' +
            'SHARED-ENUM-DROP-REVIEWED annotation: tenant clones still reference the source-schema enum, so the ' +
            'source-first fan-out aborts db-migrate (the 2026-07-07 outage).',
          ENUM_DROP_REMEDIATION,
          type === null ? null : (type[1] ?? null),
          1,
        );
      }
    }

    // ------------------------------------------- canonical RLS (scope-wide)
    if (
      isRlsPredicateScopedPath(file.repoPath) &&
      !RLS_PREDICATE_GRANDFATHERED.has(file.repoPath)
    ) {
      for (const policy of findNonCanonicalTenantPolicies(file.source)) {
        emit(
          file,
          RLS_PROJECTION,
          RLS_OWNER,
          'rls-predicate-not-canonical',
          policy.line,
          policy.excerpt,
          `tenant-isolation policy ${policy.policy} is not the canonical RLS predicate: ${policy.reason}.`,
          RLS_REMEDIATION,
          policy.policy,
          nextOccurrence(`rls:${file.path}:${policy.policy}`),
        );
      }
    }

    // ------------------------------- tenant-aware qualified DDL (scope-wide)
    if (file.kind === 'typeorm' && isTenantAwareMigrationPath(file.repoPath)) {
      const schema = tenantAwareSourceSchemaOf(file.repoPath);
      const registry = schema === null ? null : tenantDdlRegistryFor(schema);
      if (schema !== null && registry !== null) {
        const offences = isReviewedSourceSchemaDdl(file.repoPath)
          ? []
          : qualifiedDdlOffences(file.path, file.source, schema, registry);
        for (const offence of offences) {
          emit(
            file,
            TENANT_DDL_PROJECTION,
            TENANT_DDL_OWNER,
            'qualified-ddl-escapes-tenant-replay',
            offence.line,
            offence.reason,
            `${file.path}: ${offence.reason}`,
            TENANT_DDL_REMEDIATION,
            null,
            nextOccurrence(`tenant-ddl:${file.path}:${offence.line}`),
          );
        }
        for (const offence of sourcePinOffences(file.path, file.source, schema)) {
          emit(
            file,
            TENANT_DDL_PROJECTION,
            TENANT_DDL_OWNER,
            'source-pin-escapes-tenant-replay',
            offence.line,
            offence.reason,
            `${file.path}: ${offence.reason}`,
            TENANT_DDL_REMEDIATION,
            null,
            nextOccurrence(`tenant-pin:${file.path}:${offence.line}`),
          );
        }
      }
    }

    if (file.shape !== null) {
      if (file.shape.parseFailure !== null) {
        parseFailures += 1;
        observations.push({
          id: `${TOOL_ID}:parse-failure:${file.path}`,
          type: 'migration_parse_failure',
          path: file.path,
          details: { line: file.shape.parseFailure.line, message: file.shape.parseFailure.message },
        });
      }
      opaqueQueryCalls += file.shape.opaqueQueryCalls;
    }
  }

  const findingsByPath = new Map<string, number>();
  for (const finding of findings)
    findingsByPath.set(finding.path, (findingsByPath.get(finding.path) ?? 0) + 1);
  for (const file of files) {
    const owners: string[] = [];
    if (isMigrationFile(file.repoPath)) owners.push('migration-sql-lint');
    if (file.kind === 'typeorm' && isExpandContractMigrationPath(file.repoPath))
      owners.push('expand-contract-ast');
    if (file.kind === 'typeorm' && isTenantAwareMigrationPath(file.repoPath))
      owners.push('migration-shared-enum-drop');
    if (file.kind === 'typeorm' && isTenantAwareMigrationPath(file.repoPath))
      owners.push('tenant-aware-migration-ddl');
    if (isRlsPredicateScopedPath(file.repoPath)) owners.push('rls-predicate-canonical');
    observations.push({
      id: `${TOOL_ID}:file:${file.path}`,
      type: 'migration_safety_file',
      path: file.path,
      details: {
        kind: file.kind,
        in_change_set: file.added,
        owners,
        verdict:
          file.shape !== null && file.shape.parseFailure !== null ? 'unparsable' : 'observed',
        sql_template_calls: file.shape === null ? null : file.shape.templateQueryCalls,
        opaque_query_calls: file.shape === null ? null : file.shape.opaqueQueryCalls,
        findings: findingsByPath.get(file.path) ?? 0,
        grandfathered_violations: grandfatheredByPath.get(file.path) ?? {},
      },
    });
  }

  // ------------------------------------------------------- change set honesty
  const scanned = new Set(files.map((file) => file.path));
  const unmatched = [...addedPaths].filter((path) => !scanned.has(path)).sort();
  observations.push({
    id: `${TOOL_ID}:change-set`,
    type: 'migration_change_set',
    details: { declared: addedPaths.size, matched: addedPaths.size - unmatched.length, unmatched },
  });

  // ------------------------------------------------------------ provenance
  const authorities: Record<string, string | null> = {};
  for (const path of AUTHORITY_PATHS) {
    if (workspace.entry(path) === 'file' && pathAllowedBySnapshot(workspaceRoot, path, input)) {
      authorities[path] = sha256(workspace.readFile(path));
      readPaths.add(path);
    } else {
      authorities[path] = null;
    }
  }

  const findingCounts: Record<string, number> = {};
  for (const finding of findings)
    findingCounts[finding.rule] = (findingCounts[finding.rule] ?? 0) + 1;
  const grandfatheredCounts: Record<string, number> = {};
  for (const counts of grandfatheredByPath.values()) {
    for (const [rule, count] of Object.entries(counts))
      grandfatheredCounts[rule] = (grandfatheredCounts[rule] ?? 0) + count;
  }
  observations.push({
    id: `${TOOL_ID}:summary`,
    type: 'migration_safety_summary',
    details: {
      files: files.length,
      typeorm_files: files.filter((file) => file.kind === 'typeorm').length,
      sql_files: files.filter((file) => file.kind === 'sql').length,
      parse_failures: parseFailures,
      clean: parseFailures === 0,
      opaque_query_calls: opaqueQueryCalls,
      findings: findingCounts,
      grandfathered_violations: grandfatheredCounts,
      authorities,
      authorities_complete: Object.values(authorities).every((hash) => hash !== null),
      target_sha: targetSha,
    },
  });

  const sortedReadPaths = [...readPaths].sort();
  return {
    observations: observations.sort((a, b) => a.id.localeCompare(b.id)),
    findings: findings.sort((a, b) => a.id.localeCompare(b.id)),
    read_paths: sortedReadPaths,
    evidence_sources: sortedReadPaths,
    belief_candidates: [],
    cost_units: sortedReadPaths.length,
    metadata: {
      scanMode: 'sql_migration_safety_v1',
      pathBase,
      authorities,
      changeSetSize: addedPaths.size,
    },
  };
}

function readStdin(): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let input = '';
    process.stdin.setEncoding('utf8');
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
  process.stdout.write(`${JSON.stringify(analyzeMigrationSafety(input))}\n`);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
