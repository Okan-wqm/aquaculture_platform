// Server configuration — every knob comes from the environment, validated once.
//
// WHY: the console runs inside a container next to the kernel; a missing token
// or tools dir must refuse to start rather than serve an open or empty console.
// WHAT: parses process.env into a frozen ServerConfig and throws ConfigError with
// the offending variable name when a required value is absent or malformed.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { InstancePolicy } from './instance-policy.ts';
import { effectiveAllowActions, loadInstancePolicy } from './instance-policy.ts';

export class ConfigError extends Error {
  readonly variable: string;

  constructor(variable: string, message: string) {
    super(`${variable}: ${message}`);
    this.name = 'ConfigError';
    this.variable = variable;
  }
}

export interface ServerConfig {
  readonly host: string;
  readonly port: number;
  readonly token: string;
  readonly toolsDir: string;
  readonly workspaceRoot: string | null;
  readonly workspaceBase: string;
  readonly kernelBin: string;
  readonly staticDir: string;
  /**
   * Whether KERNEL control (cycle run, pause, resume) is served. The environment
   * grants it and the instance manifest may take it away; neither alone can
   * turn it on. Case actions are not governed here: the instance's approval
   * policy decides them per action class (see gates.ts).
   */
  readonly allowActions: boolean;
  readonly actionTimeoutMs: number;
  readonly version: string;
  /** Root of the per-case intake directories the console writes. */
  readonly legalCasesDir: string;
  /** Largest single document accepted at intake. */
  readonly maxUploadBytes: number;
  /**
   * The Ed25519 key the console signs its custody ledgers with. It lives on
   * the volume, never in the image; created on first boot when absent.
   */
  readonly ledgerKeyFile: string;
  /** The instance manifest, when one is configured; null means none. */
  readonly instancePolicy: InstancePolicy | null;
}

// The module runs from `server/src` (tests, dev) or from `server/dist/server/src`
// (built), so the ui/ root is found by walking up to the manifest named
// new-aria-ui rather than by a fixed number of `..` segments.
function findUiRoot(): string {
  let current = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(resolve(current, 'package.json'), 'utf8'));
      if (typeof parsed === 'object' && parsed !== null && (parsed as { name?: unknown }).name === 'new-aria-ui') return current;
    } catch {
      // Not this directory; keep climbing.
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

const UI_ROOT = findUiRoot();

function readVersion(): string {
  try {
    const parsed: unknown = JSON.parse(readFileSync(resolve(UI_ROOT, 'package.json'), 'utf8'));
    if (typeof parsed === 'object' && parsed !== null && 'version' in parsed) {
      const version = (parsed as { version: unknown }).version;
      if (typeof version === 'string') return version;
    }
  } catch {
    // The version is informational; an unreadable manifest must not stop the server.
  }
  return '0.0.0';
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === '') {
    throw new ConfigError(name, 'is required');
  }
  return value.trim();
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new ConfigError(name, `must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function flag(env: NodeJS.ProcessEnv, name: string): boolean {
  const raw = env[name];
  return raw === '1' || raw === 'true';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const token = required(env, 'ARIA_UI_TOKEN');
  if (token.length < 16) {
    throw new ConfigError('ARIA_UI_TOKEN', 'must be at least 16 characters');
  }
  const toolsDir = resolve(required(env, 'ARIA_TOOLS_DIR'));
  const workspaceRootRaw = env['ARIA_WORKSPACE_ROOT'];
  const workspaceRoot =
    workspaceRootRaw !== undefined && workspaceRootRaw.trim() !== '' ? resolve(workspaceRootRaw.trim()) : null;
  // Loaded before anything else that depends on it: a configured-but-broken
  // instance manifest must stop the server here, not be discovered later by a
  // request that quietly ran without the policy it advertises.
  const instancePolicy = loadInstancePolicy(env);
  return Object.freeze({
    host: env['ARIA_UI_HOST']?.trim() || '0.0.0.0',
    port: integer(env, 'ARIA_UI_PORT', 8480, 1, 65535),
    token,
    toolsDir,
    workspaceRoot,
    workspaceBase: env['ARIA_WORKSPACE_BASE']?.trim() || resolve(toolsDir, '..', 'workspaces'),
    kernelBin: env['ARIA_KERNEL_BIN']?.trim() || '/opt/new-aria/bin/aria',
    staticDir: resolve(env['ARIA_UI_STATIC_DIR']?.trim() || resolve(UI_ROOT, 'web', 'dist')),
    allowActions: effectiveAllowActions(flag(env, 'ARIA_UI_ALLOW_ACTIONS'), instancePolicy),
    actionTimeoutMs: integer(env, 'ARIA_UI_ACTION_TIMEOUT_MS', 600_000, 1_000, 86_400_000),
    version: readVersion(),
    // The corpus mount is read-only in a legal deployment, so intake writes to
    // its own root; it defaults beside the workspaces rather than inside them.
    legalCasesDir: resolve(env['ARIA_LEGAL_CASES_DIR']?.trim() || resolve(toolsDir, '..', 'legal-cases')),
    maxUploadBytes: integer(env, 'ARIA_UI_MAX_UPLOAD_BYTES', 512 * 1024 * 1024, 1024, 8 * 1024 * 1024 * 1024),
    // Beside the ledgers it signs, on the durable volume, never under the corpus.
    ledgerKeyFile: resolve(env['ARIA_UI_LEDGER_KEY_FILE']?.trim() || resolve(toolsDir, '..', 'keys', 'ledger-ed25519.pem')),
    instancePolicy,
  });
}
