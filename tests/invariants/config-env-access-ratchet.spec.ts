/**
 * Platform-wide invariant — ORPHAN-106 / ORPHAN-109 (config SSoT, ratchet):
 *
 * Raw `process.env.*` reads in NestJS service-layer code (apps/<svc>/src) are
 * RATCHETED: the count of offending files may only shrink, never grow.
 *
 * # Why this shape (not a central platform/configs schema)
 *
 * The platform's REAL typed-config SSoT is the per-concern factory pattern that
 * is already wired and fail-fast:
 *   - libs/backend-common/src/database/typeorm-config.factory.ts  (DB config)
 *   - platform/libs/event-bus/src/nats/event-bus-config.factory.ts (NATS, ORPHAN-PR5)
 * Every long-running service reads config through Nest `ConfigService` (≈100
 * files) or these factories. The aspirational central `platform/configs/`
 * directory was never populated (0 files); resurrecting it as another typed
 * schema that nothing consumes would just rebuild the Potemkin-SSoT anti-pattern
 * the audit exists to kill. So instead of a new empty schema, this guard locks
 * the drift surface: new service code MUST route config through ConfigService /
 * a factory, not a fresh raw `process.env` read.
 *
 * # Allowlisted config-layer boundary (legitimately reads process.env)
 *   - any `database/data-source.ts` — the TypeORM CLI migration entry point runs
 *     OUTSIDE the Nest DI container, so ConfigService does not exist there.
 *   - any `main.ts` — process bootstrap before the DI container is built.
 *
 * Reducing the baseline (migrate a service read to ConfigService) is encouraged
 * and only requires lowering BASELINE_FILES here. Raising it fails CI.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

// Baseline captured 2026-06-26 (comment-stripped, excluding the CLI/bootstrap
// allowlist). These are grandfathered boundary reads (health build-info, seed
// scripts, an OS HOSTNAME worker-id, one dashboard timezone flag). The ratchet
// forbids ADDING a new file; migrating any of these to ConfigService lowers it.
const BASELINE_FILES = 5;

const ALLOWLIST = [/\/database\/data-source\.ts$/, /\/main\.ts$/];

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/(?<!:)\/\/.*$/, ''))
    .join('\n');
}

describe('INVARIANT (ORPHAN-106/109): raw process.env reads are ratcheted', () => {
  it(`apps service-layer files reading process.env do not exceed ${BASELINE_FILES}`, () => {
    const files = execFileSync(
      'git',
      ['-C', REPO_ROOT, 'ls-files', 'apps/*/src/**/*.ts'],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
    )
      .split('\n')
      .filter(
        (f) =>
          f.length > 0 &&
          !f.endsWith('.spec.ts') &&
          !f.endsWith('.test.ts') &&
          !f.includes('/__tests__/') &&
          !ALLOWLIST.some((re) => re.test(f)),
      );

    const offenders: string[] = [];
    for (const rel of files) {
      let src: string;
      try {
        src = readFileSync(resolve(REPO_ROOT, rel), 'utf8');
      } catch {
        continue;
      }
      if (/process\.env\./.test(stripComments(src))) {
        offenders.push(rel);
      }
    }

    if (offenders.length > BASELINE_FILES) {
      throw new Error(
        `Raw process.env reads grew from ${BASELINE_FILES} to ${offenders.length}.\n` +
          `Route config through Nest ConfigService or a typed config factory\n` +
          `(typeorm-config.factory / event-bus-config.factory), NOT a raw\n` +
          `process.env read. Offending files:\n` +
          offenders.map((o) => `  ${o}`).join('\n'),
      );
    }

    // Tighten the ratchet if reads were migrated away without lowering BASELINE.
    expect(offenders.length).toBeLessThanOrEqual(BASELINE_FILES);
  });
});
