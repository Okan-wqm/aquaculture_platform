/**
 * Platform-wide invariant: every signal in required-signals.yaml has a
 * matching emitter source file containing the literal pattern, AND every
 * per-service signals reference points to a signal_library entry that exists.
 *
 * INFRA-CRITICAL-015 closed the migration_runner_applied / centralized
 * aqua-db-migrate misalignment. This invariant locks the contract — a
 * future regression that:
 *   - adds a service requirement for an undefined signal,
 *   - adds a signal_library entry whose signalSource file doesn't contain
 *     the literal pattern,
 *   - removes the pattern string from a signalSource without updating
 *     the manifest,
 * fails CI immediately.
 *
 * Why this invariant matters: the deploy gate is a Tier-1
 * Make-Impossible mechanism. If it ever asserts a signal that nothing
 * can emit, deploys block forever (the failure mode INFRA-CRITICAL-015
 * documented). This test catches the manifest-vs-source drift before it
 * reaches the deploy gate.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const MANIFEST_PATH = resolve(REPO_ROOT, 'infrastructure', 'deploy', 'required-signals.yaml');

interface Manifest {
  signal_library: Record<string, { pattern: string; description?: string; signalSource: string }>;
  services: Array<{ name: string; signals: string[] }>;
}

function loadManifest(): Manifest {
  const raw = readFileSync(MANIFEST_PATH, 'utf8');
  const lines = raw.split('\n');

  // Lightweight YAML parse: this manifest is small and structured.
  // We avoid pulling a yaml dep just for a test invariant.
  const sigLibrary: Manifest['signal_library'] = {};
  const services: Manifest['services'] = [];

  let inSigLib = false;
  let inServices = false;
  let curSig: string | null = null;
  let curSvc: { name: string; signals: string[] } | null = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, '').trimEnd();
    if (line.length === 0) continue;

    // Top-level section markers
    if (/^signal_library:\s*$/.test(line)) { inSigLib = true; inServices = false; continue; }
    if (/^services:\s*$/.test(line)) { inSigLib = false; inServices = true; continue; }
    if (/^[a-z_]+:\s*$/i.test(line) && !line.startsWith(' ')) {
      inSigLib = false; inServices = false; continue;
    }

    if (inSigLib) {
      const sigName = line.match(/^  ([a-z_][a-z0-9_]*):\s*$/);
      if (sigName) {
        curSig = sigName[1]!;
        sigLibrary[curSig] = { pattern: '', signalSource: '' };
        continue;
      }
      if (curSig) {
        const m1 = line.match(/^    pattern:\s*"([^"]+)"\s*$/);
        if (m1) sigLibrary[curSig]!.pattern = m1[1]!;
        const m2 = line.match(/^    signalSource:\s*"([^"]+)"\s*$/);
        if (m2) sigLibrary[curSig]!.signalSource = m2[1]!;
        const m3 = line.match(/^    description:\s*"([^"]+)"\s*$/);
        if (m3) sigLibrary[curSig]!.description = m3[1]!;
      }
    }

    if (inServices) {
      const svcName = line.match(/^  - name:\s*([a-z][a-z0-9-]*)\s*$/);
      if (svcName) {
        if (curSvc) services.push(curSvc);
        curSvc = { name: svcName[1]!, signals: [] };
        continue;
      }
      const sigRef = line.match(/^      - ([a-z_][a-z0-9_]*)\s*$/);
      if (sigRef && curSvc) {
        curSvc.signals.push(sigRef[1]!);
      }
    }
  }
  if (curSvc) services.push(curSvc);

  return { signal_library: sigLibrary, services };
}

describe('INVARIANT: required-signals.yaml ↔ emitter source files', () => {
  const manifest = loadManifest();

  describe('signal_library entries', () => {
    for (const [signalKey, def] of Object.entries(manifest.signal_library)) {
      describe(`signal "${signalKey}"`, () => {
        it('has a non-empty pattern', () => {
          expect(def.pattern.length).toBeGreaterThan(0);
        });

        it('points to a signalSource file that exists', () => {
          const fullPath = resolve(REPO_ROOT, def.signalSource);
          expect(existsSync(fullPath)).toBe(true);
        });

        it('signalSource file contains the literal pattern string', () => {
          const fullPath = resolve(REPO_ROOT, def.signalSource);
          const content = readFileSync(fullPath, 'utf8');
          if (!content.includes(def.pattern)) {
            throw new Error(
              `Signal "${signalKey}" pattern "${def.pattern}" NOT found in ${def.signalSource}.\n` +
                `Either the source emits a different string (rename) or the manifest references a stale pattern.`,
            );
          }
        });
      });
    }
  });

  describe('per-service signal references', () => {
    for (const svc of manifest.services) {
      for (const sigKey of svc.signals) {
        it(`service "${svc.name}" → signal "${sigKey}" exists in signal_library`, () => {
          expect(manifest.signal_library).toHaveProperty(sigKey);
        });
      }
    }
  });
});
