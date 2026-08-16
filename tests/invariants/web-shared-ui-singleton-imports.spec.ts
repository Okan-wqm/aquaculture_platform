/**
 * Invariant: federated web runtime code must consume shared-ui through the
 * public `@aquaculture/shared-ui` package entrypoint.
 *
 * Module Federation relies on that package specifier as the singleton identity
 * for React contexts. Deep source imports such as `../../../shared-ui/src/...`
 * create a second module identity in production bundles. The observable failure
 * is a Provider/Hook split: AuthProvider or TenantProvider exists, but a remote
 * or shell hook reads a different context instance and throws at runtime.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { listEffectiveWorktreeFiles } from './lib/effective-worktree-files';

const REPO_ROOT = resolve(__dirname, '..', '..');
const WEB_RUNTIME_GLOBS = [
  'web/shell/src/**/*.ts',
  'web/shell/src/**/*.tsx',
  'web/modules/*/src/**/*.ts',
  'web/modules/*/src/**/*.tsx',
] as const;

const EXEMPT_PATH_PATTERNS = [
  /__tests__\//,
  /\.spec\.ts$/,
  /\.spec\.tsx$/,
  /\.test\.ts$/,
  /\.test\.tsx$/,
  /\.d\.ts$/,
] as const;

interface Hit {
  file: string;
  line: number;
  specifier: string;
}

function listRuntimeFiles(): readonly string[] {
  return listEffectiveWorktreeFiles(REPO_ROOT, WEB_RUNTIME_GLOBS).filter(
    (file) => !EXEMPT_PATH_PATTERNS.some((pattern) => pattern.test(file)),
  );
}

const IMPORT_SPECIFIER_RE =
  /^\s*(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/;

function scanFile(file: string): readonly Hit[] {
  const content = readFileSync(resolve(REPO_ROOT, file), 'utf-8');
  const lines = content.split(/\r?\n/);
  const hits: Hit[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const match = IMPORT_SPECIFIER_RE.exec(line);
    if (!match) continue;

    const specifier = match[1] ?? '';
    if (specifier.includes('shared-ui/src/')) {
      hits.push({ file, line: index + 1, specifier });
    }
  }

  return hits;
}

describe('INVARIANT: federated web runtime imports shared-ui through one singleton package identity', () => {
  const hits = listRuntimeFiles().flatMap((file) => [...scanFile(file)]);

  it('does not deep-import shared-ui source files from shell or remote modules', () => {
    if (hits.length > 0) {
      const details = hits.map((hit) => `  ${hit.file}:${hit.line} -> ${hit.specifier}`).join('\n');

      throw new Error(
        `Found ${hits.length} shared-ui deep source import(s):\n${details}\n\n` +
          `Use the public '@aquaculture/shared-ui' entrypoint instead. ` +
          `Deep source imports create duplicate React context module identities ` +
          `under Module Federation and can break AuthProvider/TenantProvider at runtime.`,
      );
    }

    expect(hits).toEqual([]);
  });
});
