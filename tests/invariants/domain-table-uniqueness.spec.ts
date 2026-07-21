/**
 * Platform-wide invariant — domain-table single-owner discipline (APA-213 /
 * ADMIN-CRITICAL-022, the support-silo consolidation: TICKETS + MESSAGING).
 *
 * A durable PLATFORM-LEVEL domain table must be declared by exactly ONE
 * `@Entity()` in exactly ONE owning schema across the whole platform. Two
 * services declaring the same table in two different EXPLICIT schemas is a
 * WRITE-DUPLICATE silo: one side writes rows the other side (and every reader)
 * never sees. That is precisely the disease APA-201 removed for announcements
 * and APA-213 removes for support tickets AND support messaging — admin-api
 * wrote `admin.support_tickets` / `admin.ticket_comments` /
 * `admin.message_threads` / `admin.messages` over REST while tenants + the real
 * SSoT read/write `auth.*` over GraphQL.
 *
 * This spec makes the wrong state fail at CI time: it scans every service's
 * entity files (apps entity.ts sources), extracts each
 * `@Entity('<table>', { schema })` declaration, and asserts the CONSOLIDATED
 * support-domain tables below are each owned by a single EXPLICIT schema (auth).
 *
 * # SCOPE — support-domain tables consolidated so far
 *
 * `support_tickets` + `ticket_comments` (tickets slice) and `message_threads` +
 * `messages` (messaging slice). All four are now owned solely by the auth-service
 * support SSoT.
 *
 * # WHY EXPLICIT-SCHEMA ONLY (the `messages` name collision)
 *
 * `messages` is ALSO the table name of a completely different domain: the
 * messaging-service tenant-to-tenant channel messaging entity
 * (`apps/messaging-service/src/message/entities/message.entity.ts`), declared
 * `@Entity('messages')` with the schema OMITTED. Per ADR-011 a schema-omitted
 * entity in a tenant-scoped service is a PER-TENANT table routed into
 * `tenant_<uuid>` by search_path at runtime — a categorically different kind of
 * table from a platform-level support table, and one that can never form a
 * cross-service write-duplicate of it. So the single-owner assertion counts only
 * declarations that carry an EXPLICIT `schema:` (the platform-level ones); the
 * tenant-scoped `messages` is correctly excluded. Asserting global name
 * uniqueness instead would false-fail on that legitimate collision. (Support
 * tables like `support_tickets` are platform-level and have no schema-omitted
 * declaration, so the filter leaves their check unchanged.)
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

/**
 * Domain tables that MUST have exactly one EXPLICIT-schema owner platform-wide.
 * Their single legitimate owner is the auth-service `support` SSoT.
 */
const CONSOLIDATED_TABLES: Readonly<Record<string, string>> = {
  support_tickets: 'auth',
  ticket_comments: 'auth',
  message_threads: 'auth',
  messages: 'auth',
};

interface EntityDeclaration {
  readonly file: string;
  readonly table: string;
  readonly schema: string | null;
  readonly line: number;
}

function listEntityFiles(): string[] {
  let out: string;
  try {
    out = execSync(
      `git -C ${REPO_ROOT} grep -lE '@Entity\\(' -- 'apps/*/src/**/*.entity.ts'`,
      { encoding: 'utf8' },
    );
  } catch (err) {
    const e = err as { status?: number };
    if (e.status === 1) return [];
    throw err;
  }
  return out
    .split('\n')
    .filter(Boolean)
    .filter((f) => !f.includes('/.archive/') && !f.includes('/__tests__/'));
}

/**
 * Walk every `@Entity(` call site and capture its raw argument string using
 * brace-matching so multi-line decorator args are handled. Mirrors the proven
 * scanner in entity-schema-declaration.spec.ts.
 */
function findEntityCalls(src: string): Array<{ start: number; args: string }> {
  const calls: Array<{ start: number; args: string }> = [];
  const callRe = /(^|[^A-Za-z_])@Entity\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = callRe.exec(src)) !== null) {
    const openParen = match.index + match[0].length - 1;
    let depth = 1;
    let i = openParen + 1;
    let inString: '"' | "'" | '`' | null = null;
    while (i < src.length && depth > 0) {
      const ch = src[i];
      if (inString) {
        if (ch === '\\') {
          i += 2;
          continue;
        }
        if (ch === inString) inString = null;
      } else if (ch === '"' || ch === "'" || ch === '`') {
        inString = ch as '"' | "'" | '`';
      } else if (ch === '(' || ch === '{' || ch === '[') {
        depth++;
      } else if (ch === ')' || ch === '}' || ch === ']') {
        depth--;
      }
      if (depth === 0) break;
      i++;
    }
    calls.push({ start: openParen, args: src.slice(openParen + 1, i).trim() });
  }
  return calls;
}

function lineNumberAt(src: string, offset: number): number {
  return src.slice(0, offset).split('\n').length;
}

/**
 * Extract the declared table name from an `@Entity(...)` argument string.
 * Handles both the positional form `@Entity('table', …)` and the object form
 * `@Entity({ name: 'table', … })`.
 */
function extractTableName(args: string): string | null {
  const nameForm = args.match(/\bname\s*:\s*['"]([a-z_][a-z0-9_]*)['"]/i);
  if (nameForm && nameForm[1]) return nameForm[1];
  const positional = args.match(/^['"]([a-z_][a-z0-9_]*)['"]/i);
  if (positional && positional[1]) return positional[1];
  return null;
}

function extractSchema(args: string): string | null {
  const schemaMatch = args.match(/\bschema\s*:\s*['"]([a-z_][a-z0-9_]*)['"]/i);
  if (schemaMatch && schemaMatch[1]) return schemaMatch[1];
  return null;
}

function collectDeclarations(): EntityDeclaration[] {
  const declarations: EntityDeclaration[] = [];
  for (const relativePath of listEntityFiles()) {
    const src = readFileSync(resolve(REPO_ROOT, relativePath), 'utf8');
    for (const call of findEntityCalls(src)) {
      if (call.args === '') continue;
      const table = extractTableName(call.args);
      if (!table || !(table in CONSOLIDATED_TABLES)) continue;
      declarations.push({
        file: relativePath,
        table,
        schema: extractSchema(call.args),
        line: lineNumberAt(src, call.start),
      });
    }
  }
  return declarations;
}

describe('INVARIANT — domain-table-uniqueness (APA-213 support silo: tickets + messaging)', () => {
  const declarations = collectDeclarations();

  it('finds the consolidated support tables in the entity graph', () => {
    const tablesSeen = new Set(declarations.map((d) => d.table));
    for (const table of Object.keys(CONSOLIDATED_TABLES)) {
      expect(tablesSeen.has(table)).toBe(true);
    }
  });

  it('each consolidated support table is declared in exactly ONE owning (explicit) schema', () => {
    const violations: string[] = [];

    for (const [table, expectedSchema] of Object.entries(CONSOLIDATED_TABLES)) {
      // Count only EXPLICIT-schema declarations. A schema-omitted declaration is
      // an ADR-011 per-tenant table (routed into tenant_<uuid> by search_path) —
      // a different kind of table that can never be a cross-service silo of a
      // platform-level support table (see the `messages` collision in the header).
      const declsForTable = declarations.filter(
        (d): d is EntityDeclaration & { schema: string } =>
          d.table === table && d.schema !== null,
      );
      const owningSchemas = new Set(declsForTable.map((d) => d.schema));

      if (owningSchemas.size !== 1) {
        violations.push(
          `'${table}' is declared in ${owningSchemas.size} explicit schema(s) ` +
            `[${[...owningSchemas].join(', ')}] — a write-duplicate silo:\n` +
            declsForTable
              .map((d) => `      ${d.file}:${d.line}  @Entity('${d.table}', { schema: '${d.schema}' })`)
              .join('\n'),
        );
        continue;
      }

      const [ownerSchema] = [...owningSchemas];
      if (ownerSchema !== expectedSchema) {
        violations.push(
          `'${table}' is owned by schema '${ownerSchema}' but must be owned by ` +
            `'${expectedSchema}' (the auth-service support SSoT).`,
        );
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `domain-table-uniqueness invariant VIOLATED — ${violations.length} ` +
          `support-domain table(s) with more than one owner:\n  - ` +
          violations.join('\n  - ') +
          `\n\nEach consolidated table must be declared by exactly ONE @Entity() ` +
          `in schema '${CONSOLIDATED_TABLES.support_tickets}'. Remove the duplicate ` +
          `admin-api entity and migrate its rows onto the auth SSoT (see APA-213).`,
      );
    }

    expect(violations).toHaveLength(0);
  });
});
