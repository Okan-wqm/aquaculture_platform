/**
 * Preflight phase — verify the environment is sane BEFORE we destroy
 * anything. Failure here aborts the run with a non-zero exit and zero
 * side effects.
 *
 * Checks (architectural-fix-tier-3 "make it detectable"):
 *   1. Docker daemon is reachable.
 *   2. The project compose file exists at the expected path.
 *   3. The auth-service compose env declares SUPER_ADMIN_EMAIL and
 *      SUPER_ADMIN_PASSWORD — without those the post-reset database
 *      will have NO super-admin row and the operator will lock
 *      themselves out. We read from the running auth container if
 *      present (truth on disk via `docker inspect`), and fall back to
 *      a parse of the compose file when the container is absent.
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

import { logInfo, logWarn } from './log.ts';

export interface PreflightResult {
  composePath: string;
  dockerVersion: string;
  superAdminEmailConfigured: boolean;
  superAdminPasswordConfigured: boolean;
  warnings: readonly string[];
}

const PHASE = 'preflight';

/**
 * Run docker version. Throws if docker is not reachable.
 */
function checkDocker(): string {
  try {
    return execSync('docker version --format "{{.Server.Version}}"', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    throw new Error(
      `Docker daemon not reachable. Is Docker running? Original error: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Inspect a running container's environment for one variable. Returns
 * undefined if the container is missing or the variable is unset.
 *
 * We use `docker inspect ... --format` rather than `docker exec env` so
 * the read is read-only and works even if the container is unhealthy.
 */
function readContainerEnv(container: string, varName: string): string | undefined {
  try {
    const raw = execSync(
      `docker inspect ${container} --format '{{range .Config.Env}}{{println .}}{{end}}'`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const prefix = `${varName}=`;
    for (const line of raw.split('\n')) {
      if (line.startsWith(prefix)) {
        return line.slice(prefix.length);
      }
    }
    return undefined;
  } catch {
    // Container missing or inspect failed — caller falls back to compose.
    return undefined;
  }
}

/**
 * Heuristic compose-file scan for SUPER_ADMIN_* presence under the
 * auth-service block. Used when the auth container is absent.
 *
 * Tier-3 detection only: a missing env var here is a warning, not a
 * fatal — the operator may set the var in their shell at execute time.
 */
function composeDeclaresSuperAdmin(composePath: string, varName: string): boolean {
  if (!existsSync(composePath)) return false;
  const src = readFileSync(composePath, 'utf8');
  // Locate the `auth-service:` service block and scan its body.
  const headerIdx = src.indexOf('\n  auth-service:');
  if (headerIdx === -1) return false;
  // Block ends at the next sibling service header (two-space indent).
  const tail = src.slice(headerIdx + 1);
  const nextSiblingMatch = tail.search(/\n {2}[a-z][a-zA-Z0-9_-]*:/m);
  const block = nextSiblingMatch === -1 ? tail : tail.slice(0, nextSiblingMatch);
  return new RegExp(`\\b${varName}\\b`).test(block);
}

export function runPreflight(composePath: string): PreflightResult {
  logInfo(PHASE, 'starting preflight checks');
  const warnings: string[] = [];

  const dockerVersion = checkDocker();
  logInfo(PHASE, 'docker reachable', { version: dockerVersion });

  if (!existsSync(composePath)) {
    throw new Error(`Compose file not found: ${composePath}`);
  }
  logInfo(PHASE, 'compose file present', { composePath });

  // Prefer truth from the running container; fall back to the compose file.
  const fromContainerEmail = readContainerEnv('aqua-auth', 'SUPER_ADMIN_EMAIL');
  const fromContainerPassword = readContainerEnv('aqua-auth', 'SUPER_ADMIN_PASSWORD');

  const emailConfigured =
    Boolean(fromContainerEmail && fromContainerEmail.trim().length > 0) ||
    composeDeclaresSuperAdmin(composePath, 'SUPER_ADMIN_EMAIL');
  const passwordConfigured =
    Boolean(fromContainerPassword && fromContainerPassword.trim().length > 0) ||
    composeDeclaresSuperAdmin(composePath, 'SUPER_ADMIN_PASSWORD');

  if (!emailConfigured) {
    const w =
      'SUPER_ADMIN_EMAIL not detected in aqua-auth container env or compose file. ' +
      'After reset the seed will skip super-admin creation and you will have NO admin login.';
    warnings.push(w);
    logWarn(PHASE, w);
  }
  if (!passwordConfigured) {
    const w =
      'SUPER_ADMIN_PASSWORD not detected in aqua-auth container env or compose file. ' +
      'After reset the seed will skip super-admin creation.';
    warnings.push(w);
    logWarn(PHASE, w);
  }

  logInfo(PHASE, 'preflight complete', {
    superAdminEmailConfigured: emailConfigured,
    superAdminPasswordConfigured: passwordConfigured,
    warningCount: warnings.length,
  });

  return {
    composePath,
    dockerVersion,
    superAdminEmailConfigured: emailConfigured,
    superAdminPasswordConfigured: passwordConfigured,
    warnings,
  };
}
