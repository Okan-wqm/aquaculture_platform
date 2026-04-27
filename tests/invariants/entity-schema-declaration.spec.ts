/**
 * Platform-wide invariant — INFRA-CRITICAL-022 / DEFECT-2:
 *
 * Every `@Entity()` decorator in `apps/**\/*.entity.ts` MUST declare
 * its schema via the `schema:` option (ADR-011 + CLAUDE.md "Inviolable
 * rule #2").
 *
 * # Why
 *
 * When the schema is omitted, TypeORM defaults the entity's expected
 * schema to `public`. The schema-drift validator then compares
 * `expected='public'` against `actual='<service>'` (the table physically
 * lives in the per-service schema thanks to the connection's search_path
 * pin) and reports drift on every entity that omits the option — the
 * 2026-04 deploy gate output saw ~400 false-positive violations across
 * the fleet from this single mechanical defect.
 *
 * The fix is mechanical: add `{ schema: '<svc>' }` as the second @Entity()
 * argument. This invariant guards against regression — any new entity
 * file that ships without the schema declaration fails CI.
 *
 * # Allowed shapes
 *
 *   1. `@Entity()`                           — abstract base / inheritance helper
 *   2. `@Entity('table', { schema: 'svc' })` — string + opts (canonical)
 *   3. `@Entity({ name: 'table', schema: 'svc' })` — single-object form
 *
 * # Forbidden shapes
 *
 *   * `@Entity('table')`                     — missing options arg
 *   * `@Entity('table', { ...optsWithoutSchema })`
 *   * `@Entity({ name: 'table' })`           — single-object missing schema
 *
 * # Why apps/** only
 *
 * `libs/backend-common/src/{audit,security/gdpr,finding-registry}/*.entity.ts`
 * declare `schema: 'shared' | 'event_store'` (cross-service singletons).
 * Those files are already covered by the broader convention; the per-service
 * sweep landed here is scoped to apps/** entities owned by exactly one
 * service.
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

describe('INVARIANT (DEFECT-2): every @Entity() in apps/** declares schema', () => {
  it('every @Entity(<args>) call carries a schema: option (or is parameterless)', () => {
    let grepOut: string;
    try {
      grepOut = execSync(
        `git -C ${REPO_ROOT} grep -lE '@Entity\\(' -- 'apps/*/src/**/*.entity.ts'`,
        { encoding: 'utf8' },
      );
    } catch (err) {
      const e = err as { status?: number };
      if (e.status === 1) return; // No entity files at all — vacuously satisfied.
      throw err;
    }

    const files = grepOut.split('\n').filter(Boolean);
    expect(files.length).toBeGreaterThan(50); // sanity: we have lots of entities

    const violations: string[] = [];

    for (const relativePath of files) {
      const fullPath = resolve(REPO_ROOT, relativePath);
      const src = readFileSync(fullPath, 'utf8');

      // Walk every @Entity( call; brace-balanced scan to capture arg span.
      const callRe = /(^|[^A-Za-z_])@Entity\s*\(/g;
      let match: RegExpExecArray | null;
      while ((match = callRe.exec(src)) !== null) {
        const openParen = match.index + match[0].length - 1;
        // Brace-match for ).
        let depth = 1;
        let i = openParen + 1;
        let inString: '"' | "'" | '`' | null = null;
        while (i < src.length && depth > 0) {
          const ch = src[i];
          if (inString) {
            if (ch === '\\') { i += 2; continue; }
            if (ch === inString) inString = null;
          } else {
            if (ch === '"' || ch === "'" || ch === '`') inString = ch as '"' | "'" | '`';
            else if (ch === '(' || ch === '{' || ch === '[') depth++;
            else if (ch === ')' || ch === '}' || ch === ']') depth--;
          }
          if (depth === 0) break;
          i++;
        }
        const args = src.slice(openParen + 1, i).trim();

        // Allowed: parameterless @Entity()
        if (args === '') continue;

        // Allowed: any args mentioning `schema:` somewhere
        if (/\bschema\s*:/.test(args)) continue;

        // Compute line number for actionable error reporting.
        const lineNo = src.slice(0, match.index).split('\n').length;
        violations.push(
          `${relativePath}:${lineNo}: @Entity(${args.slice(0, 80)}${args.length > 80 ? '…' : ''}) — missing schema declaration`,
        );
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `DEFECT-2 invariant VIOLATED — ${violations.length} @Entity() decorator(s) in apps/** missing schema declaration:\n  ` +
          violations.join('\n  ') +
          `\n\nADD { schema: '<service-schema>' } as the second @Entity argument. ` +
          `Service → schema map: admin-api→admin, auth→auth, billing→billing, config→config, ` +
          `event-store→event_store, farm→farm, hr→hr, messaging→messaging, notification→notification, ` +
          `observability→observability, alert-engine→alert, ai→ai, hydroponics→hydroponics, sensor→sensor.`,
      );
    }
  });
});
