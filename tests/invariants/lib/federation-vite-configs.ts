/**
 * The web's vite configs, which of them build a Module Federation container,
 * and the alias tables Vite resolves for them (FE-HIGH-343).
 *
 * Discovery walks `web/` on disk, so a config is governed by existing, not by
 * being listed. Alias tables come from Vite itself (`vite-alias-probe.ts`, run
 * in a child process): FE-HIGH-343's first invariant read alias keys out of the
 * config text with a comment-stripping regex that did not know about strings,
 * and in sensor-module the glob `'**\/*.svg?react'` opened a "comment" that
 * `'src/**\/*.{test,spec}…'` closed, so the scan saw none of that config's
 * aliases. Only the resolved table is what the build applies.
 *
 * Shared by web-shared-ui-singleton-imports.spec.ts (no federation build
 * aliases a shared singleton) and shared-ui-test-alias.spec.ts (specs alias
 * shared-ui to source, builds never do).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

import { removeFixtureTree } from '../../../tools/gates/fixture-tree';

import type { ProbedAlias, ProbedConfig, ProbeRequest, ProbeTarget } from './vite-alias-probe';

export type { ProbedAlias, ProbedConfig, ProbeTarget };

export const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const WEB_ROOT = resolve(REPO_ROOT, 'web');
const PROBE = resolve(__dirname, 'vite-alias-probe.ts');

/** Never descend into build output or installed deps. */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', 'build', '.nx']);

/**
 * Name of `@module-federation/vite`'s alias-conflict check, which every
 * federation pipeline mounts. A resolved config carrying it is a federation
 * build; one without it is not, whatever its text says.
 */
export const FEDERATION_PLUGIN = 'check-alias-conflicts';

function walkViteConfigs(dirAbs: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dirAbs, { withFileTypes: true })) {
    const childAbs = join(dirAbs, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) out.push(...walkViteConfigs(childAbs));
    } else if (entry.isFile() && entry.name === 'vite.config.ts') {
      out.push(childAbs);
    }
  }
  return out;
}

/** Every `vite.config.ts` under `web/`, repo-relative and sorted. */
export function webViteConfigs(): readonly string[] {
  return walkViteConfigs(WEB_ROOT)
    .map((configAbs) => relative(REPO_ROOT, configAbs))
    .sort();
}

/**
 * The configs that call the federation plugin: the shell host and every
 * remote. web-shared-ui-singleton-imports.spec.ts proves this text test picks
 * exactly the configs whose resolved pipeline mounts `FEDERATION_PLUGIN`.
 */
export function federationViteConfigs(): readonly string[] {
  return webViteConfigs().filter((file) =>
    readFileSync(resolve(REPO_ROOT, file), 'utf-8').includes('federation('),
  );
}

/**
 * The environment a real `vite build` / `vite` sees. Jest's and Vitest's
 * markers are dropped: `@module-federation/vite` returns no plugins at all when
 * it detects a test process, which would hide the aliases it appends, and Vite
 * keeps an inherited `NODE_ENV=test` instead of deriving it from the mode.
 */
function buildEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => key !== 'NODE_ENV' && key !== 'JEST_WORKER_ID' && !key.startsWith('VITEST'),
    ),
  );
}

/** Resolve each config under each target, the way Vite does for a real run. */
export function resolveViteAliases(
  configs: readonly string[],
  targets: readonly ProbeTarget[],
): readonly ProbedConfig[] {
  const outDir = mkdtempSync(join(tmpdir(), 'vite-alias-probe-'));
  try {
    const request: ProbeRequest = {
      configs: configs.map((file) => resolve(REPO_ROOT, file)),
      targets: [...targets],
      out: join(outDir, 'aliases.json'),
    };
    execFileSync(process.execPath, [PROBE, JSON.stringify(request)], {
      cwd: REPO_ROOT,
      env: buildEnvironment(),
      stdio: ['ignore', 'ignore', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
    });
    const probed = JSON.parse(readFileSync(request.out, 'utf-8')) as ProbedConfig[];
    return probed.map((entry) => ({
      ...entry,
      configFile: relative(REPO_ROOT, entry.configFile),
    }));
  } finally {
    removeFixtureTree(outDir);
  }
}

/** A resolved `find`, printed as the config would spell it. */
export function describeFind(find: ProbedAlias['find']): string {
  return typeof find === 'string' ? find : `/${find.source}/${find.flags}`;
}

/**
 * Whether an alias rewrites `specifier` before any user plugin sees it —
 * `@module-federation/vite`'s own alias-conflict rule: a string `find` shadows
 * itself and every specifier below it, a RegExp `find` shadows what it matches.
 *
 * Stricter than the plugin's warning, which lets an alias through when its
 * replacement points back into `node_modules/<same package>`: FE-HIGH-343
 * proved only the bare specifier reaches `loadShare`, and no config needs
 * anything else.
 */
export function aliasShadows(find: ProbedAlias['find'], specifier: string): boolean {
  if (typeof find === 'string') {
    return find === specifier || specifier.startsWith(`${find}/`);
  }
  return new RegExp(find.source, find.flags).test(specifier);
}
