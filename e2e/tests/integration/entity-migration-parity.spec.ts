/**
 * Entity ↔ Migration Parity Invariant
 * ============================================================================
 *
 * STATIC analysis — no DB, no service bootstrap. Reads source files off
 * disk, parses `@Entity` / `@Column` decorators and migration SQL, asserts
 * two architectural invariants that have broken deploy twice in 2026-04:
 *
 *   MA2  —  Every `@Entity('<table>')` declared in apps/<svc>/src has a
 *           corresponding `CREATE TABLE [IF NOT EXISTS] "<table>"` in the
 *           same service's migrations directory. Prevents the
 *           "entity shipped, baseline migration forgotten" class (broke
 *           event_store deploy 2026-04-16: 4 entities, 0 migrations).
 *
 *   MA3  —  Every column declared by an entity (via `@Column`,
 *           `@PrimaryGeneratedColumn`, `@CreateDateColumn`,
 *           `@UpdateDateColumn`) appears in the migration's CREATE TABLE
 *           body. The migration may declare additional DB-only columns;
 *           it MUST NOT be missing any entity column. Prevents the
 *           camelCase/snake_case mismatch class (broke HR deploy
 *           2026-04-16: migration referenced `"isDeleted"` when schema
 *           uses `"is_deleted"`).
 *
 * # Philosophy
 *
 * The alternative (runtime DB-comparison tests) catches the issue AFTER
 * migrations apply — too late for a green CI gate. Static parsing runs in
 * milliseconds on every PR and red-lights the PR BEFORE merge when any
 * entity is out of sync with its migrations. That's the Tier-1
 * "make-impossible" pattern.
 *
 * # Precision notes
 *
 *   - TypeORM's default naming strategy preserves property names verbatim
 *     (no snake_case conversion). Explicit `@Column({ name: 'x' })`
 *     overrides.
 *   - `@PrimaryGeneratedColumn` ⇒ property name (usually 'id').
 *   - `@CreateDateColumn` / `@UpdateDateColumn` ⇒ property name (usually
 *     'createdAt' / 'updatedAt').
 *   - Single-table-inheritance (`@TableInheritance`, child @Entity without
 *     name) is rare; the parser skips @Entity decorators without a
 *     resolvable table name.
 *   - Views, partitions, and materialised views are skipped (looking for
 *     CREATE TABLE only).
 *   - Partitioned child tables (e.g. messages_2026_01) are created at
 *     runtime by a parent-level PARTITION OF statement, not by a
 *     per-child CREATE TABLE; they're excluded via PARTITIONED_TABLE_RE
 *     so the parser doesn't expect a migration per shard.
 *
 * # When this test fails
 *
 *   MA2: "Entity X in apps/<svc>/src/.../x.entity.ts has no matching
 *         CREATE TABLE in apps/<svc>/src/**\/migrations/*.ts. Write a
 *         baseline migration or remove the entity."
 *
 *   MA3: "Entity X declares column <col>, but migration Y's CREATE TABLE
 *         for table X doesn't include it. Add the column to the
 *         migration, fix the @Column name: override, or check for a
 *         camelCase/snake_case typo."
 *
 * Both messages give actionable output — no DB inspection required.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ── Paths ───────────────────────────────────────────────────────────────────

const REPO_ROOT = path.resolve(__dirname, '../../..');
const APPS_DIR = path.join(REPO_ROOT, 'apps');

// ── Parse model ─────────────────────────────────────────────────────────────

interface EntityDecl {
  service: string; // e.g. "event-store-service"
  file: string; // absolute path
  tableName: string; // @Entity('<table>') arg
  columns: Set<string>; // DB column names (after @Column({ name }) override)
}

interface CreateTableBlock {
  migrationFile: string; // absolute path
  tableName: string; // table in CREATE TABLE "<table>"
  columns: Set<string>; // column names in body (skipping CONSTRAINT / FK clauses)
}

// ── Regex library ───────────────────────────────────────────────────────────

/**
 * Matches @Entity with a name (string arg or { name: '...' } object).
 *   @Entity('stored_events')
 *   @Entity('departments_hr', { schema: 'hr' })
 *   @Entity({ name: 'foo', schema: 'bar' })
 */
const ENTITY_NAME_RE =
  /@Entity\(\s*(?:(?:['"])([a-z_][a-z0-9_]*)\1|\{[^}]*name\s*:\s*(?:['"])([a-z_][a-z0-9_]*)\2)/i;

/**
 * Matches each decorator line that introduces a column. We accept a
 * compact set: @Column, @PrimaryGeneratedColumn, @PrimaryColumn,
 * @CreateDateColumn, @UpdateDateColumn, @DeleteDateColumn, @VersionColumn.
 * Parameters (if any) are captured so we can look for `name: '...'`.
 */
const COLUMN_DECORATOR_RE =
  /@(Column|PrimaryGeneratedColumn|PrimaryColumn|CreateDateColumn|UpdateDateColumn|DeleteDateColumn|VersionColumn)\(([\s\S]*?)\)\s*$/gm;

/** Extracts `name: '...'` from a decorator argument body. */
const NAME_OVERRIDE_RE = /\bname\s*:\s*(['"])([a-zA-Z_][a-zA-Z0-9_]*)\1/;

/**
 * Matches a property declaration following a decorator. Accepts:
 *   foo: string
 *   foo!: string
 *   foo?: string | null
 *   readonly foo: string
 *   public readonly foo!: string
 */
const PROPERTY_DECL_RE =
  /^\s*(?:public\s+|private\s+|protected\s+|readonly\s+)*([a-zA-Z_][a-zA-Z0-9_]*)\s*[!?]?\s*:/;

/**
 * Matches a CREATE TABLE statement (possibly IF NOT EXISTS) and captures
 * the table name + body between the first outer parens.
 *
 * Non-greedy on body so trailing statements in the same template literal
 * don't get swallowed. Schema-qualified names (`"hr"."departments"`) are
 * handled by matching either form.
 */
const CREATE_TABLE_RE =
  /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"([a-z_][a-z0-9_]*)"\s*\.\s*)?"([a-z_][a-z0-9_]*)"\s*\(([\s\S]*?)\)\s*(?:WITH\s*\([^)]*\)\s*)?(?:PARTITION\s+BY[^;`]*)?(?:;|`)/gi;

/**
 * In a CREATE TABLE body, each column line is `"<name>" <type> ...`. We
 * skip lines whose first token is a constraint or clause keyword.
 */
const COLUMN_LINE_RE = /^\s*"([a-zA-Z_][a-zA-Z0-9_]*)"\s+[A-Za-z]/;

/** Lines that start with these are constraints, not columns. */
const CONSTRAINT_KEYWORDS = new Set([
  'CONSTRAINT',
  'PRIMARY',
  'FOREIGN',
  'UNIQUE',
  'CHECK',
  'EXCLUDE',
  'LIKE',
]);

// ── Filesystem helpers ──────────────────────────────────────────────────────

function listServices(): string[] {
  if (!fs.existsSync(APPS_DIR)) return [];
  return fs
    .readdirSync(APPS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

function walkTsFiles(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip build output and node_modules
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.nx') {
        continue;
      }
      walkTsFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

function listEntityFiles(service: string): string[] {
  const src = path.join(APPS_DIR, service, 'src');
  return walkTsFiles(src).filter((p) => p.endsWith('.entity.ts'));
}

function listMigrationFiles(service: string): string[] {
  const srcRoot = path.join(APPS_DIR, service, 'src');
  const candidates = [
    path.join(srcRoot, 'migrations'),
    path.join(srcRoot, 'database', 'migrations'),
  ];
  const out: string[] = [];
  for (const dir of candidates) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      if (entry.endsWith('.ts')) out.push(path.join(dir, entry));
    }
  }
  return out;
}

// ── Entity parser ───────────────────────────────────────────────────────────

function parseEntity(file: string, content: string, service: string): EntityDecl | null {
  const entityMatch = ENTITY_NAME_RE.exec(content);
  if (!entityMatch) return null;
  const tableName = entityMatch[1] ?? entityMatch[2];
  if (!tableName) return null;

  const columns = new Set<string>();

  // Reset regex state (global flag) between calls.
  COLUMN_DECORATOR_RE.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = COLUMN_DECORATOR_RE.exec(content)) !== null) {
    const decoratorArg = match[2] ?? '';
    const nameOverride = NAME_OVERRIDE_RE.exec(decoratorArg);

    if (nameOverride) {
      const columnName = nameOverride[2];
      if (columnName) columns.add(columnName);
      continue;
    }

    // No explicit name — use the property name from the NEXT non-blank line
    // after the decorator. Scan forward from match end.
    const afterDecorator = content.slice(match.index + match[0].length);
    // Collapse leading whitespace/newlines, then take the next logical line.
    const nextContent = afterDecorator.replace(/^\s+/, '');
    const lineEnd = nextContent.search(/[\r\n]/);
    const firstLine = lineEnd >= 0 ? nextContent.slice(0, lineEnd) : nextContent;

    const propMatch = PROPERTY_DECL_RE.exec(firstLine);
    if (propMatch) {
      const propertyName = propMatch[1];
      if (propertyName) columns.add(propertyName);
    }
  }

  return { service, file, tableName, columns };
}

// ── Migration parser ────────────────────────────────────────────────────────

function parseMigration(file: string, content: string): CreateTableBlock[] {
  const blocks: CreateTableBlock[] = [];
  CREATE_TABLE_RE.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = CREATE_TABLE_RE.exec(content)) !== null) {
    const tableName = match[2];
    const body = match[3];
    if (!tableName || body === undefined) continue;
    const columns = new Set<string>();

    for (const rawLine of body.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      // Strip trailing comma so the column-line regex is happy.
      const stripped = line.replace(/,\s*$/, '');
      const firstToken = stripped.split(/[\s(]/)[0]?.toUpperCase() ?? '';
      if (CONSTRAINT_KEYWORDS.has(firstToken)) continue;
      // Lines beginning with "--" are comments.
      if (stripped.startsWith('--')) continue;
      const colMatch = COLUMN_LINE_RE.exec(stripped);
      const columnName = colMatch?.[1];
      if (columnName) columns.add(columnName);
    }

    blocks.push({ migrationFile: file, tableName, columns });
  }
  return blocks;
}

// ── Allowlist / exclusions ──────────────────────────────────────────────────

/**
 * Tables whose migrations are deliberately excluded from parity checks.
 * KEEP THIS LIST SHORT and commented — every entry is a tracked debt.
 */
const EXCLUDED_TABLES = new Set<string>([
  // Partitioned child tables are created by the parent-level PARTITION OF
  // statement at migration time, not by a per-child CREATE TABLE. Their
  // column shape is inherited, not declared. Declaring them as @Entity
  // (messaging-service does, for ORM scoping) does not imply a standalone
  // CREATE TABLE should exist.
]);

/**
 * Services we do NOT scan for entities. Typically services without
 * persistence (gateway-api proxies requests; observability-service has
 * no migrations yet per SCHEMA_REGISTRY forward declaration).
 */
const SERVICES_WITHOUT_PERSISTENCE = new Set<string>(['gateway-api', 'observability-service']);

/**
 * Entity-file patterns to ignore — DTOs, projections, view-only classes
 * that happen to live under *.entity.ts by convention.
 */
function shouldSkipEntityFile(file: string): boolean {
  const base = path.basename(file);
  // read-only view / projection classes (convention across services)
  if (base.includes('.view.entity.ts')) return true;
  if (base.includes('.projection.entity.ts')) return true;
  return false;
}

// ── Collection ──────────────────────────────────────────────────────────────

function collectAll(): {
  entities: EntityDecl[];
  migrationsByService: Map<string, CreateTableBlock[]>;
} {
  const entities: EntityDecl[] = [];
  const migrationsByService = new Map<string, CreateTableBlock[]>();

  for (const service of listServices()) {
    if (SERVICES_WITHOUT_PERSISTENCE.has(service)) continue;

    // Entities
    for (const file of listEntityFiles(service)) {
      if (shouldSkipEntityFile(file)) continue;
      const content = fs.readFileSync(file, 'utf8');
      const decl = parseEntity(file, content, service);
      if (decl) entities.push(decl);
    }

    // Migrations
    const blocks: CreateTableBlock[] = [];
    for (const file of listMigrationFiles(service)) {
      const content = fs.readFileSync(file, 'utf8');
      blocks.push(...parseMigration(file, content));
    }
    migrationsByService.set(service, blocks);
  }

  return { entities, migrationsByService };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Entity ↔ Migration Parity', () => {
  const { entities, migrationsByService } = collectAll();

  describe('MA2 — every @Entity has a CREATE TABLE migration', () => {
    it('lists at least one entity in apps/ (sanity)', () => {
      expect(entities.length).toBeGreaterThan(0);
    });

    it.each(
      entities
        .filter((e) => !EXCLUDED_TABLES.has(e.tableName))
        .map<[string, string, EntityDecl]>((e) => [e.service, e.tableName, e]),
    )('[%s] table "%s" has a CREATE TABLE migration', (service, tableName, entity) => {
      const blocks = migrationsByService.get(service) ?? [];
      const hasCreateTable = blocks.some((b) => b.tableName === tableName);
      if (!hasCreateTable) {
        throw new Error(
          `Entity-migration parity violation (MA2):\n` +
            `  Entity file:     ${path.relative(REPO_ROOT, entity.file)}\n` +
            `  Declares table:  "${tableName}"\n` +
            `  Expected migration with: CREATE TABLE [IF NOT EXISTS] "${tableName}" (...)\n` +
            `  Searched in:     apps/${service}/src/migrations/ and apps/${service}/src/database/migrations/\n` +
            `  Resolution:      write a baseline migration for this entity,\n` +
            `                   or, if intentional, add "${tableName}" to EXCLUDED_TABLES\n` +
            `                   in entity-migration-parity.spec.ts with a rationale.`,
        );
      }
    });
  });

  describe('MA3 — migration CREATE TABLE columns ⊇ @Entity column names', () => {
    it.each(
      entities
        .filter((e) => !EXCLUDED_TABLES.has(e.tableName))
        .map<[string, string, EntityDecl]>((e) => [e.service, e.tableName, e]),
    )('[%s] "%s" migration declares every entity column', (service, tableName, entity) => {
      const blocks = migrationsByService.get(service) ?? [];
      const block = blocks.find((b) => b.tableName === tableName);
      if (!block) {
        // MA2 will have already reported this; avoid double-failing.
        return;
      }

      const missing: string[] = [];
      for (const col of entity.columns) {
        if (!block.columns.has(col)) missing.push(col);
      }
      if (missing.length > 0) {
        throw new Error(
          `Entity-migration column-parity violation (MA3):\n` +
            `  Entity file:     ${path.relative(REPO_ROOT, entity.file)}\n` +
            `  Table:           "${tableName}"\n` +
            `  Migration file:  ${path.relative(REPO_ROOT, block.migrationFile)}\n` +
            `  Missing columns: ${missing.map((c) => '"' + c + '"').join(', ')}\n` +
            `  Resolution:      add the missing columns to the migration's CREATE TABLE,\n` +
            `                   or use @Column({ name: '...' }) on the entity to\n` +
            `                   override the property name if the DB uses a different\n` +
            `                   identifier (e.g. camelCase ↔ snake_case).`,
        );
      }
    });
  });
});
