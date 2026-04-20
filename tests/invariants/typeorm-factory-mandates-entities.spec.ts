/**
 * Platform-wide invariant — INFRA-CRITICAL-021 (Phase A.6 defense-in-depth):
 *
 * Every callsite of `createServiceTypeOrmConfig(configService, { ... })`
 * MUST include an `entities:` property in the options object.
 *
 * # Why
 *
 * The factory's TypeScript signature already requires `entities`, but the
 * runtime check + this static invariant guard against three real failure
 * modes that would silently re-open the cross-service entity contamination
 * class (DEFECT-1):
 *
 *   1. A future regression that re-makes `entities` optional on the
 *      `ServiceTypeOrmOptions` type.
 *   2. A JS-only consumer (CLI tool, test fixture) that bypasses the
 *      TypeScript type check.
 *   3. A `// @ts-expect-error` slip past the type check during a refactor.
 *
 * Without `entities`, TypeORM falls back to scanning
 * `getMetadataArgsStorage()` globally — picking up every `@Entity()`
 * decorated class that any imported module has loaded as a side effect.
 * That was the root cause of the ~30 false-positive cross-schema drift
 * violations per service that the SchemaDriftValidator was reporting.
 *
 * Pass `entities: []` if the service relies entirely on
 * `TypeOrmModule.forFeature()` autoload (the factory always sets
 * `autoLoadEntities: true` so forFeature registrations get auto-merged).
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

describe('INVARIANT (INFRA-CRITICAL-021): createServiceTypeOrmConfig callsites pass explicit entities', () => {
  it('every apps/*/src/app.module.ts call site includes an entities property', () => {
    let grepOut: string;
    try {
      grepOut = execSync(
        `git -C ${REPO_ROOT} grep -lE 'createServiceTypeOrmConfig\\s*\\(' -- 'apps/*/src/app.module.ts'`,
        { encoding: 'utf8' },
      );
    } catch (err) {
      const e = err as { status?: number; stdout?: string };
      // git grep exits 1 when no matches found — that means no factory
      // callsites at all, which is itself a regression.
      if (e.status === 1) {
        throw new Error(
          'INFRA-CRITICAL-021 invariant: no createServiceTypeOrmConfig callsites found in apps/. ' +
            'Either every service stopped using the factory (architectural regression) ' +
            'OR the grep pattern is broken.',
        );
      }
      throw err;
    }

    const files = grepOut.split('\n').filter(Boolean);
    expect(files.length).toBeGreaterThanOrEqual(13);

    const violations: string[] = [];
    for (const relativePath of files) {
      const fullPath = resolve(REPO_ROOT, relativePath);
      const src = readFileSync(fullPath, 'utf8');

      // Walk every createServiceTypeOrmConfig(...) call and assert each
      // options-object body contains an entities: property. Use a hand-rolled
      // brace-balanced scanner (regex cannot reliably balance braces).
      const callRe = /createServiceTypeOrmConfig\s*\(/g;
      let match: RegExpExecArray | null;
      while ((match = callRe.exec(src)) !== null) {
        const callStart = match.index + match[0].length;
        // Skip past `configService, {` — find the first opening brace
        // belonging to the OPTIONS object (the second arg).
        const braceOpen = src.indexOf('{', callStart);
        if (braceOpen === -1) continue;
        // Brace-match to find the closing brace.
        let depth = 1;
        let i = braceOpen + 1;
        while (i < src.length && depth > 0) {
          const ch = src[i];
          if (ch === '{') depth++;
          else if (ch === '}') depth--;
          i++;
        }
        const optionsBody = src.slice(braceOpen + 1, i - 1);
        if (!/\bentities\s*:/.test(optionsBody)) {
          // Compute line number of the call for actionable error reporting.
          const lineNo = src.slice(0, match.index).split('\n').length;
          violations.push(`${relativePath}:${lineNo}: createServiceTypeOrmConfig({...}) — missing entities: property`);
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `INFRA-CRITICAL-021 invariant VIOLATED — createServiceTypeOrmConfig callsites missing required entities:\n  ` +
          violations.join('\n  ') +
          `\n\nAdd entities: [Entity1, Entity2, ...] explicitly. Pass entities: [] if the service ` +
          `relies entirely on TypeOrmModule.forFeature() autoload — the factory always sets ` +
          `autoLoadEntities: true so forFeature registrations are auto-merged into the connection ` +
          `entity list. Documented in libs/backend-common/src/database/typeorm-config.factory.ts.`,
      );
    }
  });
});
