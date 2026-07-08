import { join } from 'node:path';

import { describe, expect, it } from '@jest/globals';
import * as ts from 'typescript';

/**
 * strictPropertyInitialization SSoT.
 *
 * WHY: TypeORM entities and GraphQL DTOs declare their fields via decorators;
 * the ORM / framework assigns them at runtime, so under
 * `strictPropertyInitialization: true` every such field carries a definite-
 * assignment `!`. farm-service and messaging-service historically DISABLED the
 * flag in their authoring tsconfigs, so their entities were authored WITHOUT
 * `!`. That divergence from `tsconfig.base.json` (which sets the flag `true`)
 * was invisible to their own build but exploded when the platform
 * `bootstrap-from-scratch` schema-drift test compiled every service's entities
 * under the strict base config — the un-`!`'d entities failed TS2564, were
 * silently dropped, and their tables passed the drift matrix by omission.
 *
 * This invariant makes that regression impossible to reopen: the authoring +
 * build tsconfigs of the two formerly-divergent services must resolve
 * `strictPropertyInitialization` to `true` (inherited from base — no local
 * `false` override), matching every other backend service.
 *
 * SCOPE NOTE: `apps/farm-service/tsconfig.e2e.json` is intentionally EXCLUDED —
 * its e2e suite has pre-existing, strict-init-unrelated TS2349 (supertest
 * default-import) breakage, so the flag stays `false` there with a documented
 * reason until that suite compiles. See docs/reviews/orphan-findings.md.
 */

const REPO_ROOT = process.cwd();

/**
 * Resolve the EFFECTIVE strictPropertyInitialization for a tsconfig, following
 * its full `extends` chain. `strict: true` in the base turns the flag on
 * implicitly, so the effective value is `strictPropertyInitialization ?? strict`
 * — this catches both a re-added local `false` override and a base regression
 * that would drop strictness platform-wide.
 */
function effectiveStrictPropertyInit(relPath: string): boolean | undefined {
  const configPath = join(REPO_ROOT, relPath);
  const host: ts.ParseConfigFileHost = {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => {
      throw new Error(
        `Cannot parse ${relPath}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`,
      );
    },
  };
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, host);
  if (!parsed) {
    throw new Error(`Cannot resolve tsconfig ${relPath}`);
  }
  const { strictPropertyInitialization, strict } = parsed.options;
  return strictPropertyInitialization ?? strict;
}

// The authoring (app/spec) + build tsconfigs that MUST enforce strict init.
// If a service ever re-introduces `strictPropertyInitialization: false` in one
// of these, entities/DTOs could again be authored without `!` and drift.
const STRICT_INIT_CONFIGS = [
  'apps/farm-service/tsconfig.app.json',
  'apps/farm-service/tsconfig.spec.json',
  'apps/farm-service/tsconfig.build.json',
  'apps/messaging-service/tsconfig.app.json',
  'apps/messaging-service/tsconfig.spec.json',
  'apps/messaging-service/tsconfig.build.json',
];

describe('strictPropertyInitialization SSoT', () => {
  it('tsconfig.base.json keeps strictPropertyInitialization enabled (the inherited default)', () => {
    expect(effectiveStrictPropertyInit('tsconfig.base.json')).toBe(true);
  });

  it.each(STRICT_INIT_CONFIGS)(
    '%s resolves strictPropertyInitialization to true (no local `false` override)',
    (relPath) => {
      expect(effectiveStrictPropertyInit(relPath)).toBe(true);
    },
  );
});
