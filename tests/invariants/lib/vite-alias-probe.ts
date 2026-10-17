/**
 * Child-process half of `federation-vite-configs.ts` (FE-HIGH-343): resolves
 * each requested vite config the way `vite build` / `vite` resolve it and
 * writes every resolved `resolve.alias` table to a JSON file.
 *
 * WHY a child process: Vite 7 is ESM-only and loads a config by bundling it and
 * importing the bundle; the invariant suite runs under ts-jest as CommonJS and
 * can do neither. Node runs this file directly (type stripping), so it keeps to
 * erasable TypeScript and never imports from the CommonJS side.
 *
 * WHY resolve instead of reading the config text: the resolved table is what
 * Vite's alias plugin applies, so spreads (`...sharedUiAlias(...)`), helper
 * objects, computed keys and the aliases other plugins append in their `config`
 * hooks are all in it, and no string in the file can hide an entry from it.
 *
 * Usage: node vite-alias-probe.ts '<ProbeRequest JSON>'
 */
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolveConfig } from 'vite';

/** One way a config is resolved: a Vite mode and the command run under it. */
export interface ProbeTarget {
  mode: string;
  command: 'build' | 'serve';
}

export interface ProbeRequest {
  /** Absolute vite config paths. */
  configs: string[];
  targets: ProbeTarget[];
  /** Absolute path the result is written to. */
  out: string;
}

/** A resolved alias; a RegExp `find` travels as its source and flags. */
export interface ProbedAlias {
  find: string | { source: string; flags: string };
  replacement: string;
}

export interface ProbedConfig {
  configFile: string;
  mode: string;
  command: 'build' | 'serve';
  aliases: ProbedAlias[];
  /** Names of the resolved plugins, so the caller can tell the pipeline loaded. */
  plugins: string[];
}

function probedFind(find: string | RegExp): ProbedAlias['find'] {
  return typeof find === 'string' ? find : { source: find.source, flags: find.flags };
}

async function main(): Promise<void> {
  const request = JSON.parse(process.argv[2] ?? '') as ProbeRequest;
  const probed: ProbedConfig[] = [];

  for (const configFile of request.configs) {
    for (const { mode, command } of request.targets) {
      const config = await resolveConfig(
        { configFile, root: dirname(configFile), mode, logLevel: 'silent' },
        command,
        mode,
      );
      probed.push({
        configFile,
        mode,
        command,
        aliases: config.resolve.alias.map((alias) => ({
          find: probedFind(alias.find),
          replacement: alias.replacement,
        })),
        plugins: config.plugins.map((plugin) => plugin.name),
      });
    }
  }

  writeFileSync(request.out, JSON.stringify(probed));
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
