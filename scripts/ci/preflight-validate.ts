#!/usr/bin/env node
/**
 * CI pre-flight validator for docker-compose files (WS3 / ADR-016 Phase A2).
 *
 * Mirrors the deploy-time `docker compose config --quiet` guard into
 * CI so interpolation / YAML schema drift is caught at PR-merge time,
 * not at deploy time. Tier-1 Make-Impossible: breaking any compose
 * interpolation at PR-time fails CI before the deploy pipeline runs.
 *
 * Approach:
 *   1. Extract every `${VAR:?...}` required-interpolation reference
 *      from the target compose file(s).
 *   2. Emit a throwaway .env file with dummy values for each required
 *      var.
 *   3. Invoke `docker compose -f <file> --env-file <dummy> config
 *      --quiet` and fail the build if compose reports an error.
 *
 * Why a dummy-env approach (instead of a hand-maintained
 * `infrastructure/deploy/ci-test.env`): the compose file IS the SSoT
 * for "what prod needs at interpolation time". A hand-maintained env
 * file would drift the moment someone adds a new `${VAR:?}` without
 * updating it. Deriving at CI time keeps the two in lockstep for free.
 *
 * Usage:
 *   node scripts/ci/preflight-validate.ts <compose-file> [<compose-file> ...]
 *
 * Exit codes:
 *   0  every compose file interpolates cleanly
 *   1  at least one compose file failed interpolation / YAML schema
 *   2  invocation error (file missing, docker not available)
 *
 * Runs on Node 22+ with built-in TypeScript type-stripping — no
 * transpile step, no tsx dependency.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { extractRequiredVars, writeDummyEnvForCompose } from './lib/compose-dummy-env.ts';

/** Invoke `docker compose config --quiet`; returns its exit code. */
function runComposeValidate(composePath: string, envPath: string): number {
  const args = [
    'compose',
    '-f',
    composePath,
    '--env-file',
    envPath,
    'config',
    '--quiet',
  ];
  console.log(`  running: docker ${args.join(' ')}`);
  const result = spawnSync('docker', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
  return result.status ?? 2;
}

/** Validate one compose file end-to-end. Returns true on success. */
function validateFile(composePath: string): boolean {
  console.log(`::group::pre-flight: ${composePath}`);
  try {
    if (!existsSync(composePath)) {
      console.error(`::error::compose file not found: ${composePath}`);
      return false;
    }

    const required = extractRequiredVars(composePath);
    console.log(
      `  extracted ${required.size} required-env-var references ` +
        `(\${VAR:?...} pattern)`,
    );

    const { envPath, cleanup } = writeDummyEnvForCompose(composePath);
    try {
      const rc = runComposeValidate(composePath, envPath);
      if (rc !== 0) {
        console.error(
          `::error::docker compose config failed for ${composePath} ` +
            `(exit ${rc}). Likely cause: YAML schema error, unknown key, ` +
            `or a \${VAR:?} reference shape the validator does not yet ` +
            `understand.`,
        );
        return false;
      }
      console.log(`  OK: ${composePath} interpolates cleanly`);
      return true;
    } finally {
      cleanup();
    }
  } finally {
    console.log('::endgroup::');
  }
}

function main(argv: string[]): number {
  if (argv.length < 3) {
    console.error(
      'usage: preflight-validate.ts <compose-file> [<compose-file> ...]',
    );
    return 2;
  }

  // Sanity check: docker CLI must be present in the CI image.
  try {
    execFileSync('docker', ['compose', 'version'], { stdio: 'ignore' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`::error::docker compose not available: ${msg}`);
    return 2;
  }

  let allOk = true;
  for (const arg of argv.slice(2)) {
    const composePath = resolve(arg);
    if (!validateFile(composePath)) {
      allOk = false;
    }
  }

  if (!allOk) {
    console.error(
      '::error::pre-flight validation failed. Fix the compose file(s) ' +
        'or the env-var references above.',
    );
    return 1;
  }

  console.log('All compose files interpolate cleanly.');
  return 0;
}

process.exit(main(process.argv));
