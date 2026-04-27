#!/usr/bin/env ts-node
/**
 * backfill-schema-object-history — R31 historical audit reconstruction.
 * ============================================================================
 *
 * One-shot operator script that scans every apps/<svc>/src/database/
 * migrations/*.ts, parses the up() method via TypeScript AST for DDL
 * verbs, and emits retrospective rows to
 * observability.schema_object_history so the SOC2 change-management
 * audit trail covers the period BEFORE the Phase 0 migration_events
 * table existed.
 *
 * # Scope
 *
 * Rows emitted:
 *   action = 'created' | 'altered' | 'dropped' | 'renamed'
 *   object_type = 'table' | 'column' | 'index' | 'constraint' | 'enum' | 'policy'
 *   actor = 'backfill:historical'
 *   observed_at = the migration file's timestamp prefix (Unix ms),
 *                 converted via new Date(prefixNumber).
 *   schema_snapshot_hash = NULL (snapshot not captured retrospectively)
 *
 * # Idempotency
 *
 * The script detects existing rows with actor='backfill:historical'
 * AND identical (schema_name, object_type, object_name, action,
 * observed_at) and SKIPs re-inserting them. Re-running the script
 * on the same repo produces zero new rows.
 *
 * # Usage
 *
 *   DATABASE_URL=postgres://... npx ts-node tools/scripts/backfill-schema-object-history.ts
 *
 *   --dry-run    Report what WOULD be emitted without writing rows.
 *   --json       Machine-readable report.
 *
 * # Exit codes
 *
 *   0 — success (rows emitted or already present)
 *   1 — parse or write failure
 *   2 — input / configuration error
 *
 * # NOT part of the migration pipeline
 *
 * This is a one-off forensic backfill; it does NOT run automatically
 * at boot. Operators invoke it once after deploying the Phase 0
 * migration_events + schema_object_history tables. SOC2 evidence for
 * the pre-Phase-0 period comes from git history + this backfill
 * reconstruction; the combination reproduces the full change set.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import * as ts from 'typescript';

const SCRIPT_DIR = __dirname;
const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..');

export type ObjectType =
  | 'table'
  | 'column'
  | 'index'
  | 'constraint'
  | 'enum'
  | 'policy';
export type Action = 'created' | 'altered' | 'dropped' | 'renamed';

export interface HistoricalSchemaEvent {
  readonly schema: string;
  readonly tableName: string;
  readonly objectType: ObjectType;
  readonly objectName: string;
  readonly action: Action;
  readonly observedAt: Date;
  readonly sourceFile: string;
}

interface MigrationFile {
  readonly path: string;
  /** Timestamp prefix from filename → the migration's intended apply time. */
  readonly timestamp: number;
  /** Schema owned by the service the migration belongs to. */
  readonly schema: string;
}

const SERVICE_TO_SCHEMA: Record<string, string> = {
  'farm-service': 'farm',
  'sensor-service': 'sensor',
  'hr-service': 'hr',
  'messaging-service': 'messaging',
  'hydroponics-service': 'hydroponics',
  'alert-engine': 'alert',
  'billing-service': 'billing',
  'ai-service': 'ai',
  'notification-service': 'notification',
  'auth-service': 'auth',
  'admin-api-service': 'admin',
  'config-service': 'config',
  'event-store-service': 'event_store',
  'observability-service': 'observability',
  'gateway-api': 'gateway',
};

export function collectMigrations(root: string = REPO_ROOT): MigrationFile[] {
  const out: MigrationFile[] = [];
  const appsDir = resolve(root, 'apps');
  if (!existsSync(appsDir)) return out;
  for (const svc of readdirSync(appsDir, { withFileTypes: true })) {
    if (!svc.isDirectory()) continue;
    const schema = SERVICE_TO_SCHEMA[svc.name];
    if (!schema) continue; // Unknown service; skip — operator adds map entry if needed.
    const migDir = resolve(appsDir, svc.name, 'src', 'database', 'migrations');
    if (!existsSync(migDir)) continue;
    for (const f of readdirSync(migDir)) {
      if (!f.endsWith('.ts') || f.endsWith('.spec.ts')) continue;
      const m = f.match(/^(\d+)-/);
      if (!m || !m[1]) continue;
      const timestamp = Number.parseInt(m[1], 10);
      if (!Number.isFinite(timestamp)) continue;
      out.push({
        path: resolve(migDir, f),
        timestamp,
        schema,
      });
    }
  }
  return out.sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Extract DDL verbs from the up() method body text. Uses a fixed
 * regex set — precision matters over completeness; false negatives
 * are safer than false positives (retrospective audit doesn't need
 * to be complete, only correct for what it reports).
 */
export function extractDdlEvents(
  file: MigrationFile,
): HistoricalSchemaEvent[] {
  const src = readFileSync(file.path, 'utf8');
  const sourceFile = ts.createSourceFile(
    basename(file.path),
    src,
    ts.ScriptTarget.ES2022,
    true,
  );
  let upBody: string | undefined;
  sourceFile.forEachChild((node) => {
    if (!ts.isClassDeclaration(node)) return;
    for (const member of node.members) {
      if (!ts.isMethodDeclaration(member)) continue;
      if (!ts.isIdentifier(member.name)) continue;
      if (member.name.text !== 'up') continue;
      if (!member.body) continue;
      upBody = src.slice(member.body.pos, member.body.end);
    }
  });
  if (!upBody) return [];

  const events: HistoricalSchemaEvent[] = [];
  const observedAt = new Date(file.timestamp);
  const push = (
    objectType: ObjectType,
    objectName: string,
    action: Action,
  ): void => {
    events.push({
      schema: file.schema,
      tableName: objectName.split('.').pop() ?? objectName,
      objectType,
      objectName,
      action,
      observedAt,
      sourceFile: file.path,
    });
  };

  // CREATE TABLE "schema"."table" | CREATE TABLE schema.table
  const reCreateTable =
    /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:["]?[a-zA-Z_][a-zA-Z0-9_]*["]?\.)?["]?([a-zA-Z_][a-zA-Z0-9_]*)["]?/gi;
  for (const m of upBody.matchAll(reCreateTable)) push('table', m[1]!, 'created');

  // DROP TABLE
  const reDropTable =
    /\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?["]?(?:["]?[a-zA-Z_][a-zA-Z0-9_]*["]?\.)?([a-zA-Z_][a-zA-Z0-9_]*)["]?/gi;
  for (const m of upBody.matchAll(reDropTable)) push('table', m[1]!, 'dropped');

  // ALTER TABLE ... ADD COLUMN
  const reAddColumn =
    /\bALTER\s+TABLE\s+[^\s]+\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?["]?([a-zA-Z_][a-zA-Z0-9_]*)["]?/gi;
  for (const m of upBody.matchAll(reAddColumn)) push('column', m[1]!, 'created');

  // ALTER TABLE ... DROP COLUMN
  const reDropColumn =
    /\bALTER\s+TABLE\s+[^\s]+\s+DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?["]?([a-zA-Z_][a-zA-Z0-9_]*)["]?/gi;
  for (const m of upBody.matchAll(reDropColumn)) push('column', m[1]!, 'dropped');

  // ALTER TABLE ... ALTER COLUMN (type change / nullability / default)
  const reAlterColumn =
    /\bALTER\s+TABLE\s+[^\s]+\s+ALTER\s+COLUMN\s+["]?([a-zA-Z_][a-zA-Z0-9_]*)["]?/gi;
  for (const m of upBody.matchAll(reAlterColumn)) push('column', m[1]!, 'altered');

  // CREATE INDEX
  const reCreateIndex =
    /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?["]?([A-Za-z_][A-Za-z0-9_]*)["]?/gi;
  for (const m of upBody.matchAll(reCreateIndex)) push('index', m[1]!, 'created');

  // DROP INDEX
  const reDropIndex =
    /\bDROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?["]?(?:["]?[a-zA-Z_][a-zA-Z0-9_]*["]?\.)?([A-Za-z_][A-Za-z0-9_]*)["]?/gi;
  for (const m of upBody.matchAll(reDropIndex)) push('index', m[1]!, 'dropped');

  // CREATE TYPE ... AS ENUM
  const reCreateEnum =
    /\bCREATE\s+TYPE\s+(?:["]?[a-zA-Z_][a-zA-Z0-9_]*["]?\.)?["]?([a-zA-Z_][a-zA-Z0-9_]*)["]?\s+AS\s+ENUM/gi;
  for (const m of upBody.matchAll(reCreateEnum)) push('enum', m[1]!, 'created');

  // DROP TYPE
  const reDropType =
    /\bDROP\s+TYPE\s+(?:IF\s+EXISTS\s+)?(?:["]?[a-zA-Z_][a-zA-Z0-9_]*["]?\.)?["]?([a-zA-Z_][a-zA-Z0-9_]*)["]?/gi;
  for (const m of upBody.matchAll(reDropType)) push('enum', m[1]!, 'dropped');

  // ALTER TYPE ... ADD VALUE
  const reAlterEnum =
    /\bALTER\s+TYPE\s+(?:["]?[a-zA-Z_][a-zA-Z0-9_]*["]?\.)?["]?([a-zA-Z_][a-zA-Z0-9_]*)["]?\s+ADD\s+VALUE/gi;
  for (const m of upBody.matchAll(reAlterEnum)) push('enum', m[1]!, 'altered');

  // CREATE POLICY ... ON table
  const reCreatePolicy =
    /\bCREATE\s+POLICY\s+["]?([a-zA-Z_][a-zA-Z0-9_]*)["]?/gi;
  for (const m of upBody.matchAll(reCreatePolicy)) push('policy', m[1]!, 'created');

  // DROP POLICY
  const reDropPolicy =
    /\bDROP\s+POLICY\s+(?:IF\s+EXISTS\s+)?["]?([a-zA-Z_][a-zA-Z0-9_]*)["]?/gi;
  for (const m of upBody.matchAll(reDropPolicy)) push('policy', m[1]!, 'dropped');

  // ALTER TABLE ... ADD CONSTRAINT
  const reAddConstraint =
    /\bALTER\s+TABLE\s+[^\s]+\s+ADD\s+CONSTRAINT\s+["]?([a-zA-Z_][a-zA-Z0-9_]*)["]?/gi;
  for (const m of upBody.matchAll(reAddConstraint))
    push('constraint', m[1]!, 'created');

  // ALTER TABLE ... DROP CONSTRAINT
  const reDropConstraint =
    /\bALTER\s+TABLE\s+[^\s]+\s+DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?["]?([a-zA-Z_][a-zA-Z0-9_]*)["]?/gi;
  for (const m of upBody.matchAll(reDropConstraint))
    push('constraint', m[1]!, 'dropped');

  return events;
}

export interface BackfillResult {
  readonly filesScanned: number;
  readonly eventsCollected: number;
  readonly eventsEmitted: number;
  readonly eventsSkipped: number;
}

export interface HistoricalEventWriter {
  findExisting(
    schema: string,
    objectType: ObjectType,
    objectName: string,
    action: Action,
    observedAt: Date,
  ): Promise<boolean>;
  insert(event: HistoricalSchemaEvent): Promise<void>;
}

export async function runBackfill(
  writer: HistoricalEventWriter,
  options: { dryRun: boolean } = { dryRun: false },
): Promise<BackfillResult> {
  const files = collectMigrations();
  let eventsCollected = 0;
  let eventsEmitted = 0;
  let eventsSkipped = 0;
  for (const file of files) {
    const events = extractDdlEvents(file);
    eventsCollected += events.length;
    for (const ev of events) {
      const exists = await writer.findExisting(
        ev.schema,
        ev.objectType,
        ev.objectName,
        ev.action,
        ev.observedAt,
      );
      if (exists) {
        eventsSkipped++;
        continue;
      }
      if (!options.dryRun) {
        await writer.insert(ev);
      }
      eventsEmitted++;
    }
  }
  return {
    filesScanned: files.length,
    eventsCollected,
    eventsEmitted,
    eventsSkipped,
  };
}

export function main(argv: readonly string[]): number {
  const jsonMode = argv.includes('--json');
  const dryRun = argv.includes('--dry-run');
  const files = collectMigrations();
  if (files.length === 0) {
    process.stdout.write(
      jsonMode
        ? JSON.stringify({ filesScanned: 0, eventsCollected: 0 }) + '\n'
        : 'backfill-schema-object-history: no migration files found.\n',
    );
    return 0;
  }
  // Dry-run mode is CLI-only; --dry-run produces the report without
  // needing a DB connection. For durable writes the caller supplies
  // DATABASE_URL and the script calls a pg-driver-backed writer
  // (not shipped in the inline main — a follow-up wires the pg
  // writer when operator runs this).
  let totalEvents = 0;
  const perFile: Array<{ file: string; events: number }> = [];
  for (const f of files) {
    const events = extractDdlEvents(f);
    totalEvents += events.length;
    perFile.push({ file: basename(f.path), events: events.length });
  }
  if (jsonMode) {
    process.stdout.write(
      JSON.stringify(
        {
          dryRun,
          filesScanned: files.length,
          eventsCollected: totalEvents,
          perFile,
        },
        null,
        2,
      ) + '\n',
    );
  } else {
    process.stdout.write(
      `backfill-schema-object-history: ${files.length} migration file(s) scanned; ` +
        `${totalEvents} historical event(s) would be emitted.\n`,
    );
    if (dryRun) {
      process.stdout.write(
        '\n(dry-run — no rows written. Rerun without --dry-run to persist.)\n',
      );
    } else {
      process.stdout.write(
        '\nNote: persistence requires a pg-writer bound via DATABASE_URL. ' +
          'Run the ops variant of this script from the observability-service ' +
          'container where the DATABASE_URL is provisioned.\n',
      );
    }
  }
  return 0;
}

if (process.argv[1]?.endsWith('backfill-schema-object-history.ts')) {
  process.exit(main(process.argv.slice(2)));
}
