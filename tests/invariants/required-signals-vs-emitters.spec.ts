/**
 * Platform-wide invariant: every signal in required-signals.yaml is backed by
 * the canonical BOOT_INVARIANT_SIGNALS contract and every declared emitter
 * source exists.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import {
  BOOT_INVARIANT_SIGNAL_AUTHORITY_PATH,
  BOOT_INVARIANT_SIGNALS,
  type BootInvariantSignalKey,
} from '../../platform/libs/service-catalog/src/boot-invariant-signals';

const REPO_ROOT = resolve(__dirname, '..', '..');
const MANIFEST_PATH = resolve(
  REPO_ROOT,
  'infrastructure',
  'deploy',
  'required-signals.yaml',
);

interface SignalDef {
  pattern: string;
  description?: string;
  canonicalSource: string;
  emitterSources: string[];
}

interface Manifest {
  schema_version: number;
  signal_library: Record<string, SignalDef>;
  services: Array<{ name: string; signals: string[] }>;
}

function loadManifest(): Manifest {
  return yaml.load(readFileSync(MANIFEST_PATH, 'utf8')) as Manifest;
}

describe('INVARIANT: required-signals.yaml boot signal contract', () => {
  const manifest = loadManifest();

  it('uses structured signal schema v2', () => {
    expect(manifest.schema_version).toBe(2);
  });

  it('keeps db-migrate as the sole migration boot signal authority', () => {
    const serviceSignalRefs = manifest.services.flatMap((svc) =>
      svc.signals.map((signal) => ({ service: svc.name, signal })),
    );

    expect(manifest.signal_library).toHaveProperty('db_migrate_complete');
    expect(manifest.signal_library).not.toHaveProperty(
      'migration_runner_applied',
    );
    expect(serviceSignalRefs).not.toContainEqual(
      expect.objectContaining({ signal: 'migration_runner_applied' }),
    );
    expect(
      serviceSignalRefs
        .filter(({ signal }) => signal === 'db_migrate_complete')
        .map(({ service }) => service),
    ).toEqual(['db-migrate']);
  });

  describe('signal_library entries', () => {
    for (const [signalKey, def] of Object.entries(manifest.signal_library)) {
      describe(`signal "${signalKey}"`, () => {
        it('exists in BOOT_INVARIANT_SIGNALS', () => {
          expect(BOOT_INVARIANT_SIGNALS).toHaveProperty(signalKey);
        });

        it('matches the canonical pattern', () => {
          const expected =
            BOOT_INVARIANT_SIGNALS[signalKey as BootInvariantSignalKey]
              .pattern;
          expect(def.pattern).toBe(expected);
        });

        it('points to the canonical source file', () => {
          const fullPath = resolve(REPO_ROOT, def.canonicalSource);
          expect(def.canonicalSource).toBe(
            BOOT_INVARIANT_SIGNAL_AUTHORITY_PATH,
          );
          expect(existsSync(fullPath)).toBe(true);
        });

        it('declares emitter source files that use the structured helper', () => {
          expect(def.emitterSources.length).toBeGreaterThan(0);
          for (const source of def.emitterSources) {
            const fullPath = resolve(REPO_ROOT, source);
            expect(existsSync(fullPath)).toBe(true);
            const content = readFileSync(fullPath, 'utf8');
            expect(content).toContain(signalKey);
            expect(content).toMatch(
              /emitBootInvariantSignal|bootInvariantSignalRecord/,
            );
          }
        });
      });
    }
  });

  describe('per-service signal references', () => {
    for (const svc of manifest.services) {
      for (const sigKey of svc.signals) {
        it(`service "${svc.name}" -> signal "${sigKey}" exists in signal_library`, () => {
          expect(manifest.signal_library).toHaveProperty(sigKey);
        });
      }
    }
  });
});
