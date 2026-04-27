/**
 * Admin-API schema-boundaries invariant
 * ============================================================================
 *
 * Closes AUDIT-MEDIUM-009 (2026-04-22 cold audit). admin-api-service has
 * intentionally broad database access — it reads AND writes the
 * `admin` schema, it provisions tenant rows in `auth`, and it lands
 * cross-tenant rows in the `shared` schema per ADR-011. It also
 * declares READ-VIEW entities for other services' schemas (billing /
 * farm / sensor / hr / messaging / …) via `synchronize: false`.
 *
 * The contract is:
 *
 *   admin-api MAY WRITE to:   admin, auth, shared
 *   admin-api MAY ONLY READ (synchronize: false) from: every other schema
 *
 * Violating that contract means admin-api is generating DDL for a table
 * that another service owns — the `billing.subscriptions` table
 * would suddenly have two DDL sources racing each other — which was
 * the root cause of multiple pre-2026 deploy-gate schema-drift
 * incidents.
 *
 * # When this spec fails
 *
 *   - New @Entity pointing at a non-owned schema without
 *     `synchronize: false` → add the marker OR move the entity to the
 *     owning service.
 *   - A read-view's `synchronize: false` was accidentally removed →
 *     restore it; admin-api must not own DDL for non-admin tables.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ADMIN_API_SRC = path.resolve(REPO_ROOT, 'apps/admin-api-service/src');

/**
 * Schemas admin-api is allowed to WRITE (i.e. declare entities without
 * `synchronize: false`). Every entity pointing at a schema NOT in this
 * set must carry `synchronize: false`.
 */
const WRITE_ALLOWED: ReadonlySet<string> = new Set(['admin', 'auth', 'shared']);

function walkEntityFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkEntityFiles(abs));
    } else if (entry.isFile() && entry.name.endsWith('.entity.ts')) {
      out.push(abs);
    }
  }
  return out;
}

interface EntityMeta {
  path: string;
  schema: string | null;
  synchronize: boolean | null;
}

/**
 * Extract the (first) @Entity decorator's schema and synchronize flag
 * from a file. Matches both the `@Entity('table', { schema: 'x' })`
 * form and the single-object `@Entity({ name: 'table', schema: 'x' })`
 * form. Returns schema=null for abstract bases without @Entity().
 */
function parseEntity(filePath: string): EntityMeta {
  const text = readFileSync(filePath, 'utf8');
  // Accept `@Entity(...)` with the schema/synchronize options anywhere
  // inside the decorator argument list. The decorator argument spans
  // multiple lines in most files.
  const decoratorBlock = /@Entity\(([^@]*?)\)\s*(?:export\s+)?(?:abstract\s+)?class\b/s.exec(text);
  const body = decoratorBlock ? decoratorBlock[1]! : text;
  const schemaMatch = /schema:\s*'([a-z_]+)'/.exec(body);
  const syncMatch = /synchronize:\s*(true|false)/.exec(body);
  return {
    path: filePath,
    schema: schemaMatch ? schemaMatch[1]! : null,
    synchronize: syncMatch ? syncMatch[1] === 'true' : null,
  };
}

describe('AUDIT-MEDIUM-009 admin-api schema-boundaries contract', () => {
  if (!statSync(ADMIN_API_SRC, { throwIfNoEntry: false })?.isDirectory()) {
    it.skip('admin-api-service source not found — skipping', () => {
      /* no-op */
    });
    return;
  }

  const files = walkEntityFiles(ADMIN_API_SRC);
  const entities = files.map(parseEntity).filter((e) => e.schema !== null);

  it('at least one @Entity scanned', () => {
    expect(entities.length).toBeGreaterThan(0);
  });

  describe('every @Entity in a non-write-allowed schema must be a read-view (synchronize: false)', () => {
    for (const entity of entities) {
      const rel = path.relative(REPO_ROOT, entity.path);
      if (entity.schema === null) continue;
      if (WRITE_ALLOWED.has(entity.schema)) {
        // schema in {admin, auth, shared} — no synchronize constraint
        continue;
      }
      it(`${rel}: schema='${entity.schema}' must declare synchronize: false (admin-api does not own DDL for that schema)`, () => {
        expect(entity.synchronize).toBe(false);
      });
    }
  });

  describe('WRITE_ALLOWED set matches CLAUDE.md + ADR-011', () => {
    it('write-allowed schemas are exactly {admin, auth, shared}', () => {
      expect([...WRITE_ALLOWED].sort()).toEqual(['admin', 'auth', 'shared']);
    });
  });
});
