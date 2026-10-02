/**
 * Declared activation state of production WAL archiving, read from its single
 * source of truth (`.github/manifests/dr-activation.json`), and the PostgreSQL
 * `archive_mode` that state implies.
 *
 * WHY: compose, the healthcheck and the freshness lane each carry a projection
 * of this one declaration. Every invariant that pins a projection derives its
 * expectation here, so the manifest is the only place a test accepts as the
 * activation switch (INFRA-CRITICAL-195: compose archived WAL the manifest
 * declared not-activated, with no bucket, until pg_wal filled the disk).
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const REPO_ROOT = resolve(__dirname, '..', '..', '..');
export const WAL_ARCHIVE_CAPABILITY = 'production-wal-archive';
export const DR_ACTIVATION_MANIFEST_PATH = join(REPO_ROOT, '.github/manifests/dr-activation.json');

export type WalArchiveActivation = 'active' | 'not-activated';
export type ArchiveMode = 'on' | 'off';

function isActivation(value: unknown): value is WalArchiveActivation {
  return value === 'active' || value === 'not-activated';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The declared state of `production-wal-archive`; throws on any other shape. */
export function declaredWalArchiveActivation(
  manifestPath: string = DR_ACTIVATION_MANIFEST_PATH,
): WalArchiveActivation {
  const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const capabilities = isRecord(manifest) ? manifest.capabilities : undefined;
  const capability = isRecord(capabilities) ? capabilities[WAL_ARCHIVE_CAPABILITY] : undefined;
  const state = isRecord(capability) ? capability.state : undefined;
  if (!isActivation(state)) {
    throw new Error(`${WAL_ARCHIVE_CAPABILITY} must declare state active or not-activated`);
  }
  return state;
}

/** The only `archive_mode` a runtime in this declared state may run with. */
export function archiveModeFor(state: WalArchiveActivation): ArchiveMode {
  return state === 'active' ? 'on' : 'off';
}
