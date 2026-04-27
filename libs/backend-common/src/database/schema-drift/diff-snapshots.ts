/**
 * diffSnapshots — deterministic pairwise diff of two SchemaSnapshot values.
 * ============================================================================
 *
 * Phase 4 foundation: the PR-gate compares the pre-merge schema
 * snapshot against a post-merge shadow-applied snapshot and fails
 * the gate on any breaking change. This function produces the
 * structured list of changes the gate inspects.
 *
 * Intentionally side-effect-free + pure; no DB dependency. Tests
 * construct snapshots by hand + assert the diff output.
 *
 * # Change classes
 *
 *   - table_added / table_removed
 *   - column_added / column_removed
 *   - column_type_changed
 *   - column_nullability_changed
 *   - column_default_changed
 *   - enum_added / enum_removed / enum_labels_changed
 *   - check_added / check_removed / check_definition_changed
 *
 * Each change carries a severity tier that the PR gate maps to its
 * policy:
 *
 *   - breaking: columns / tables removed, nullability tightened,
 *     type narrowed, enum labels removed, CHECK added.
 *   - expand:   additions that broaden the schema (columns added,
 *     enum labels added, CHECK removed).
 *   - neutral:  cosmetic (column default wording change with no
 *     semantic effect, CHECK definition reformat).
 */
import type {
  IntrospectedCheckConstraint,
  IntrospectedColumn,
  IntrospectedEnum,
  IntrospectedExcludeConstraint,
  IntrospectedForeignKeyAction,
  IntrospectedGeneratedColumn,
  IntrospectedHypertable,
  IntrospectedPartialIndex,
  IntrospectedRlsPolicy,
  IntrospectedTable,
  SchemaSnapshot,
} from './pg-catalog-introspector';

export type SnapshotChangeKind =
  | 'table_added'
  | 'table_removed'
  | 'column_added'
  | 'column_removed'
  | 'column_type_changed'
  | 'column_nullability_changed'
  | 'column_default_changed'
  | 'enum_added'
  | 'enum_removed'
  | 'enum_labels_added'
  | 'enum_labels_removed'
  | 'check_added'
  | 'check_removed'
  | 'check_definition_changed'
  // Phase 2 Step 3+ shapes (R11).
  | 'partial_index_added'
  | 'partial_index_removed'
  | 'partial_index_predicate_changed'
  | 'exclude_constraint_added'
  | 'exclude_constraint_removed'
  | 'foreign_key_action_changed'
  | 'foreign_key_added'
  | 'foreign_key_removed'
  | 'generated_column_added'
  | 'generated_column_removed'
  | 'generated_column_expression_changed'
  | 'hypertable_added'
  | 'hypertable_removed'
  | 'rls_policy_added'
  | 'rls_policy_removed'
  | 'rls_policy_expression_changed';

export type SnapshotChangeSeverity = 'breaking' | 'expand' | 'neutral';

export interface SnapshotChange {
  readonly kind: SnapshotChangeKind;
  readonly severity: SnapshotChangeSeverity;
  readonly subject: string; // human-readable pointer ("schema.table.column")
  readonly details?: Record<string, unknown>;
}

/**
 * Produce a stable ordered list of every change from `before` → `after`.
 * The output is deterministic for a given (before, after) pair.
 */
export function diffSnapshots(
  before: SchemaSnapshot,
  after: SchemaSnapshot,
): readonly SnapshotChange[] {
  if (before.schema !== after.schema) {
    throw new Error(
      `[diffSnapshots] cannot diff snapshots from different schemas: ` +
        `before='${before.schema}' vs after='${after.schema}'. ` +
        `Caller must align schema name before invoking.`,
    );
  }
  const changes: SnapshotChange[] = [];
  diffTables(before.tables, after.tables, changes);
  diffEnums(before.enums, after.enums, changes);
  diffChecks(before.checkConstraints, after.checkConstraints, changes);
  diffPartialIndexes(
    before.partialIndexes ?? [],
    after.partialIndexes ?? [],
    changes,
  );
  diffExcludeConstraints(
    before.excludeConstraints ?? [],
    after.excludeConstraints ?? [],
    changes,
  );
  diffForeignKeyActions(
    before.foreignKeyActions ?? [],
    after.foreignKeyActions ?? [],
    changes,
  );
  diffGeneratedColumns(
    before.generatedColumns ?? [],
    after.generatedColumns ?? [],
    changes,
  );
  diffHypertables(
    before.hypertables ?? [],
    after.hypertables ?? [],
    changes,
  );
  diffRlsPolicies(
    before.rlsPolicies ?? [],
    after.rlsPolicies ?? [],
    changes,
  );
  return changes;
}

function diffTables(
  before: readonly IntrospectedTable[],
  after: readonly IntrospectedTable[],
  out: SnapshotChange[],
): void {
  const beforeByName = new Map(before.map((t) => [t.name, t]));
  const afterByName = new Map(after.map((t) => [t.name, t]));

  // Order: removals → additions → per-existing-table column diffs.
  for (const t of before) {
    if (!afterByName.has(t.name)) {
      out.push({
        kind: 'table_removed',
        severity: 'breaking',
        subject: `${t.schema}.${t.name}`,
      });
    }
  }
  for (const t of after) {
    if (!beforeByName.has(t.name)) {
      out.push({
        kind: 'table_added',
        severity: 'expand',
        subject: `${t.schema}.${t.name}`,
      });
    }
  }
  for (const t of before) {
    const other = afterByName.get(t.name);
    if (!other) continue;
    diffColumns(t, other, out);
  }
}

function diffColumns(
  beforeTable: IntrospectedTable,
  afterTable: IntrospectedTable,
  out: SnapshotChange[],
): void {
  const beforeByName = new Map(
    beforeTable.columns.map((c) => [c.name, c]),
  );
  const afterByName = new Map(afterTable.columns.map((c) => [c.name, c]));

  for (const c of beforeTable.columns) {
    if (!afterByName.has(c.name)) {
      out.push({
        kind: 'column_removed',
        severity: 'breaking',
        subject: `${beforeTable.schema}.${beforeTable.name}.${c.name}`,
      });
    }
  }
  for (const c of afterTable.columns) {
    if (!beforeByName.has(c.name)) {
      out.push({
        kind: 'column_added',
        severity: 'expand',
        subject: `${afterTable.schema}.${afterTable.name}.${c.name}`,
        details: {
          dataType: c.dataType,
          isNullable: c.isNullable,
        },
      });
    }
  }
  for (const c of beforeTable.columns) {
    const other = afterByName.get(c.name);
    if (!other) continue;
    diffColumnShape(beforeTable, c, other, out);
  }
}

function diffColumnShape(
  table: IntrospectedTable,
  before: IntrospectedColumn,
  after: IntrospectedColumn,
  out: SnapshotChange[],
): void {
  const subject = `${table.schema}.${table.name}.${before.name}`;
  if (before.dataType !== after.dataType) {
    out.push({
      kind: 'column_type_changed',
      // Type changes are USUALLY breaking (row rewrite + cast risk).
      // PR gate may downgrade via an explicit @ExpandContract marker
      // on the migration; the diff alone classifies all type changes
      // as breaking so the default policy is fail-closed.
      severity: 'breaking',
      subject,
      details: { before: before.dataType, after: after.dataType },
    });
  }
  if (before.isNullable !== after.isNullable) {
    const severity: SnapshotChangeSeverity =
      before.isNullable === 'YES' && after.isNullable === 'NO'
        ? 'breaking' // NULL → NOT NULL tightens semantics
        : 'expand'; // NOT NULL → NULL loosens
    out.push({
      kind: 'column_nullability_changed',
      severity,
      subject,
      details: { before: before.isNullable, after: after.isNullable },
    });
  }
  if (before.columnDefault !== after.columnDefault) {
    out.push({
      kind: 'column_default_changed',
      severity: 'neutral',
      subject,
      details: {
        before: before.columnDefault,
        after: after.columnDefault,
      },
    });
  }
}

function diffEnums(
  before: readonly IntrospectedEnum[],
  after: readonly IntrospectedEnum[],
  out: SnapshotChange[],
): void {
  const beforeByName = new Map(before.map((e) => [e.name, e]));
  const afterByName = new Map(after.map((e) => [e.name, e]));
  for (const e of before) {
    if (!afterByName.has(e.name)) {
      out.push({
        kind: 'enum_removed',
        severity: 'breaking',
        subject: `${e.schema}.${e.name}`,
      });
    }
  }
  for (const e of after) {
    if (!beforeByName.has(e.name)) {
      out.push({
        kind: 'enum_added',
        severity: 'expand',
        subject: `${e.schema}.${e.name}`,
      });
    }
  }
  for (const e of before) {
    const other = afterByName.get(e.name);
    if (!other) continue;
    const beforeSet = new Set(e.labels);
    const afterSet = new Set(other.labels);
    const removed = e.labels.filter((l) => !afterSet.has(l));
    const added = other.labels.filter((l) => !beforeSet.has(l));
    if (removed.length > 0) {
      out.push({
        kind: 'enum_labels_removed',
        severity: 'breaking',
        subject: `${e.schema}.${e.name}`,
        details: { removed },
      });
    }
    if (added.length > 0) {
      out.push({
        kind: 'enum_labels_added',
        severity: 'expand',
        subject: `${e.schema}.${e.name}`,
        details: { added },
      });
    }
  }
}

function diffChecks(
  before: readonly IntrospectedCheckConstraint[],
  after: readonly IntrospectedCheckConstraint[],
  out: SnapshotChange[],
): void {
  // Key by (tableName, name). Schema is implicit.
  const key = (c: IntrospectedCheckConstraint): string =>
    `${c.tableName}::${c.name}`;
  const beforeByKey = new Map(before.map((c) => [key(c), c]));
  const afterByKey = new Map(after.map((c) => [key(c), c]));
  for (const c of before) {
    if (!afterByKey.has(key(c))) {
      out.push({
        kind: 'check_removed',
        // Removing a CHECK loosens the schema — expand.
        severity: 'expand',
        subject: `${c.schema}.${c.tableName}.${c.name}`,
      });
    }
  }
  for (const c of after) {
    if (!beforeByKey.has(key(c))) {
      out.push({
        kind: 'check_added',
        // Adding a CHECK tightens — breaking if existing rows would
        // violate, safe if the caller pre-backfilled. PR gate cannot
        // verify backfill status from snapshot alone; treat as breaking
        // by default. Callers can downgrade via gate config.
        severity: 'breaking',
        subject: `${c.schema}.${c.tableName}.${c.name}`,
        details: { definition: c.definition },
      });
    }
  }
  for (const c of before) {
    const other = afterByKey.get(key(c));
    if (!other) continue;
    if (c.definition !== other.definition) {
      out.push({
        kind: 'check_definition_changed',
        severity: 'neutral',
        subject: `${c.schema}.${c.tableName}.${c.name}`,
        details: { before: c.definition, after: other.definition },
      });
    }
  }
}

/**
 * Partial indexes — key by (table, indexName). Predicate change is
 * breaking because it can invalidate write paths (a stricter WHERE
 * excludes rows that used to match).
 */
function diffPartialIndexes(
  before: readonly IntrospectedPartialIndex[],
  after: readonly IntrospectedPartialIndex[],
  out: SnapshotChange[],
): void {
  const key = (p: IntrospectedPartialIndex): string =>
    `${p.tableName}::${p.indexName}`;
  const beforeByKey = new Map(before.map((p) => [key(p), p]));
  const afterByKey = new Map(after.map((p) => [key(p), p]));
  for (const p of before) {
    if (!afterByKey.has(key(p))) {
      out.push({
        kind: 'partial_index_removed',
        severity: 'expand',
        subject: `${p.schema}.${p.tableName}.${p.indexName}`,
      });
    }
  }
  for (const p of after) {
    if (!beforeByKey.has(key(p))) {
      out.push({
        kind: 'partial_index_added',
        severity: 'expand',
        subject: `${p.schema}.${p.tableName}.${p.indexName}`,
        details: { predicate: p.predicate },
      });
    }
  }
  for (const p of before) {
    const other = afterByKey.get(key(p));
    if (!other) continue;
    if (p.predicate !== other.predicate) {
      out.push({
        kind: 'partial_index_predicate_changed',
        severity: 'breaking',
        subject: `${p.schema}.${p.tableName}.${p.indexName}`,
        details: { before: p.predicate, after: other.predicate },
      });
    }
  }
}

/**
 * EXCLUDE constraints — key by (table, name). Add = breaking
 * (rows may violate), remove = expand.
 */
function diffExcludeConstraints(
  before: readonly IntrospectedExcludeConstraint[],
  after: readonly IntrospectedExcludeConstraint[],
  out: SnapshotChange[],
): void {
  const key = (e: IntrospectedExcludeConstraint): string =>
    `${e.tableName}::${e.name}`;
  const beforeByKey = new Map(before.map((e) => [key(e), e]));
  const afterByKey = new Map(after.map((e) => [key(e), e]));
  for (const e of before) {
    if (!afterByKey.has(key(e))) {
      out.push({
        kind: 'exclude_constraint_removed',
        severity: 'expand',
        subject: `${e.schema}.${e.tableName}.${e.name}`,
      });
    }
  }
  for (const e of after) {
    if (!beforeByKey.has(key(e))) {
      out.push({
        kind: 'exclude_constraint_added',
        severity: 'breaking',
        subject: `${e.schema}.${e.tableName}.${e.name}`,
        details: { definition: e.definition },
      });
    }
  }
}

/**
 * Foreign-key actions — key by (table, constraintName). Action
 * change (ON DELETE CASCADE → NO ACTION) is breaking for cascade
 * logic; add/remove are direct relations.
 */
function diffForeignKeyActions(
  before: readonly IntrospectedForeignKeyAction[],
  after: readonly IntrospectedForeignKeyAction[],
  out: SnapshotChange[],
): void {
  const key = (f: IntrospectedForeignKeyAction): string =>
    `${f.tableName}::${f.constraintName}`;
  const beforeByKey = new Map(before.map((f) => [key(f), f]));
  const afterByKey = new Map(after.map((f) => [key(f), f]));
  for (const f of before) {
    if (!afterByKey.has(key(f))) {
      out.push({
        kind: 'foreign_key_removed',
        severity: 'breaking',
        subject: `${f.schema}.${f.tableName}.${f.constraintName}`,
      });
    }
  }
  for (const f of after) {
    if (!beforeByKey.has(key(f))) {
      out.push({
        kind: 'foreign_key_added',
        severity: 'expand',
        subject: `${f.schema}.${f.tableName}.${f.constraintName}`,
        details: {
          referencedTable: f.referencedTable,
          onDelete: f.onDelete,
          onUpdate: f.onUpdate,
        },
      });
    }
  }
  for (const f of before) {
    const other = afterByKey.get(key(f));
    if (!other) continue;
    if (
      f.onDelete !== other.onDelete ||
      f.onUpdate !== other.onUpdate ||
      f.deferrable !== other.deferrable
    ) {
      out.push({
        kind: 'foreign_key_action_changed',
        severity: 'breaking',
        subject: `${f.schema}.${f.tableName}.${f.constraintName}`,
        details: {
          before: {
            onDelete: f.onDelete,
            onUpdate: f.onUpdate,
            deferrable: f.deferrable,
          },
          after: {
            onDelete: other.onDelete,
            onUpdate: other.onUpdate,
            deferrable: other.deferrable,
          },
        },
      });
    }
  }
}

/**
 * Generated / identity columns — key by (table, column). Expression
 * change on a stored-generated column is breaking (row-rewrite risk).
 */
function diffGeneratedColumns(
  before: readonly IntrospectedGeneratedColumn[],
  after: readonly IntrospectedGeneratedColumn[],
  out: SnapshotChange[],
): void {
  const key = (g: IntrospectedGeneratedColumn): string =>
    `${g.tableName}::${g.columnName}`;
  const beforeByKey = new Map(before.map((g) => [key(g), g]));
  const afterByKey = new Map(after.map((g) => [key(g), g]));
  for (const g of before) {
    if (!afterByKey.has(key(g))) {
      out.push({
        kind: 'generated_column_removed',
        severity: 'expand',
        subject: `${g.schema}.${g.tableName}.${g.columnName}`,
      });
    }
  }
  for (const g of after) {
    if (!beforeByKey.has(key(g))) {
      out.push({
        kind: 'generated_column_added',
        severity: 'expand',
        subject: `${g.schema}.${g.tableName}.${g.columnName}`,
        details: { kind: g.kind, expression: g.expression },
      });
    }
  }
  for (const g of before) {
    const other = afterByKey.get(key(g));
    if (!other) continue;
    if (g.expression !== other.expression || g.kind !== other.kind) {
      out.push({
        kind: 'generated_column_expression_changed',
        severity: 'breaking',
        subject: `${g.schema}.${g.tableName}.${g.columnName}`,
        details: {
          before: { kind: g.kind, expression: g.expression },
          after: { kind: other.kind, expression: other.expression },
        },
      });
    }
  }
}

/**
 * TimescaleDB hypertables — key by table name. Adding / removing
 * a hypertable is expand/breaking; chunk count jumps are surfaced
 * as neutral (data growth, not schema drift).
 */
function diffHypertables(
  before: readonly IntrospectedHypertable[],
  after: readonly IntrospectedHypertable[],
  out: SnapshotChange[],
): void {
  const beforeByName = new Map(before.map((h) => [h.tableName, h]));
  const afterByName = new Map(after.map((h) => [h.tableName, h]));
  for (const h of before) {
    if (!afterByName.has(h.tableName)) {
      out.push({
        kind: 'hypertable_removed',
        severity: 'breaking',
        subject: `${h.schema}.${h.tableName}`,
      });
    }
  }
  for (const h of after) {
    if (!beforeByName.has(h.tableName)) {
      out.push({
        kind: 'hypertable_added',
        severity: 'expand',
        subject: `${h.schema}.${h.tableName}`,
        details: { chunkCount: h.chunkCount },
      });
    }
  }
  // Chunk-count change is NOT a schema drift — do not emit.
}

/**
 * RLS policies — key by (table, policyName). Expression change
 * on USING or WITH CHECK is breaking (silently alters tenant
 * visibility). Add is expand; remove is breaking (rows become
 * visible that were previously filtered).
 */
function diffRlsPolicies(
  before: readonly IntrospectedRlsPolicy[],
  after: readonly IntrospectedRlsPolicy[],
  out: SnapshotChange[],
): void {
  const key = (p: IntrospectedRlsPolicy): string =>
    `${p.tableName}::${p.policyName}`;
  const beforeByKey = new Map(before.map((p) => [key(p), p]));
  const afterByKey = new Map(after.map((p) => [key(p), p]));
  for (const p of before) {
    if (!afterByKey.has(key(p))) {
      out.push({
        kind: 'rls_policy_removed',
        severity: 'breaking',
        subject: `${p.schema}.${p.tableName}.${p.policyName}`,
      });
    }
  }
  for (const p of after) {
    if (!beforeByKey.has(key(p))) {
      out.push({
        kind: 'rls_policy_added',
        severity: 'expand',
        subject: `${p.schema}.${p.tableName}.${p.policyName}`,
        details: {
          command: p.command,
          usingExpr: p.usingExpr,
          withCheckExpr: p.withCheckExpr,
        },
      });
    }
  }
  for (const p of before) {
    const other = afterByKey.get(key(p));
    if (!other) continue;
    if (
      p.usingExpr !== other.usingExpr ||
      p.withCheckExpr !== other.withCheckExpr ||
      p.command !== other.command ||
      p.permissive !== other.permissive
    ) {
      out.push({
        kind: 'rls_policy_expression_changed',
        severity: 'breaking',
        subject: `${p.schema}.${p.tableName}.${p.policyName}`,
        details: {
          before: {
            command: p.command,
            usingExpr: p.usingExpr,
            withCheckExpr: p.withCheckExpr,
            permissive: p.permissive,
          },
          after: {
            command: other.command,
            usingExpr: other.usingExpr,
            withCheckExpr: other.withCheckExpr,
            permissive: other.permissive,
          },
        },
      });
    }
  }
}

/**
 * Partition changes by severity tier. Convenience for PR gates that
 * fail on breaking-count > 0.
 */
export function partitionBySeverity(
  changes: readonly SnapshotChange[],
): {
  breaking: readonly SnapshotChange[];
  expand: readonly SnapshotChange[];
  neutral: readonly SnapshotChange[];
} {
  return {
    breaking: changes.filter((c) => c.severity === 'breaking'),
    expand: changes.filter((c) => c.severity === 'expand'),
    neutral: changes.filter((c) => c.severity === 'neutral'),
  };
}
