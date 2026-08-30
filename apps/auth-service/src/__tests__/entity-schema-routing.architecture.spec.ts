/**
 * Auth-service @Entity schema-routing architecture invariant (AUDIT-HIGH-009, ADR-011).
 *
 * WHY: auth is a PLATFORM-LEVEL (cross-tenant) service — login must resolve a
 * tenant before any tenant context exists — so unlike the schema-per-tenant
 * services (farm/sensor/hr/…), EVERY auth `@Entity` MUST pin an explicit `schema:`.
 * An entity that omits it defaults to `public`, which (a) puts a table in the
 * off-limits `public` schema and (b) trips SchemaDriftValidator on cold start with
 * "declares schema=public but table lives in auth" (the INFRA-CRITICAL-023 class).
 * The sibling farm invariant asserts the OPPOSITE (tenant-owned entities must NOT
 * pin a schema); this is auth's mirror.
 */
import * as fs from 'fs';
import * as path from 'path';

const SRC_ROOT = path.resolve(__dirname, '../');

// Schemas an auth-service entity may legitimately target: its own `auth` schema,
// or the canonical cross-service `shared` schema (audit_logs / user_consents /
// gdpr_data_requests / user_permissions) per ADR-011 + CLAUDE.md D14.
const ALLOWED_SCHEMAS = new Set(['auth', 'shared']);

function findEntityFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && !entry.name.startsWith('.')) {
        files.push(...findEntityFiles(fullPath));
      }
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.entity.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

/** Every `@Entity(...)` decorator's balanced argument list in a file. */
function entityDecoratorArgs(content: string): string[] {
  const args: string[] = [];
  const re = /@Entity\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    let depth = 1;
    let j = m.index + m[0].length;
    while (j < content.length && depth > 0) {
      if (content[j] === '(') depth++;
      else if (content[j] === ')') depth--;
      j++;
    }
    args.push(content.slice(m.index + m[0].length, j - 1));
  }
  return args;
}

describe('Auth-service entity schema routing architecture (ADR-011)', () => {
  const entities = findEntityFiles(SRC_ROOT).map((file) => ({
    relativePath: path.normalize(path.relative(SRC_ROOT, file)),
    decorators: entityDecoratorArgs(fs.readFileSync(file, 'utf-8')),
  }));

  it('scans a non-empty @Entity surface', () => {
    const total = entities.reduce((n, e) => n + e.decorators.length, 0);
    expect(total).toBeGreaterThan(0);
  });

  it('every @Entity pins an explicit schema: (never defaults to public)', () => {
    const violations = entities
      .flatMap((e) => e.decorators.map((args) => ({ file: e.relativePath, args })))
      .filter(({ args }) => !/schema:\s*'[^']+'/.test(args))
      .map(({ file }) => file);

    expect(violations).toEqual([]);
  });

  it('every @Entity schema is a platform-legitimate target (auth | shared)', () => {
    const offenders = entities
      .flatMap((e) => e.decorators.map((args) => ({ file: e.relativePath, args })))
      .map(({ file, args }) => {
        const match = /schema:\s*'([^']+)'/.exec(args);
        return { file, schema: match?.[1] };
      })
      .filter(({ schema }) => schema !== undefined && !ALLOWED_SCHEMAS.has(schema))
      .map(({ file, schema }) => `${file} → schema='${schema}'`);

    expect(offenders).toEqual([]);
  });
});
