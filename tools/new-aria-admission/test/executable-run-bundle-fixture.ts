import { createHash } from 'node:crypto';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { FileCurrentEpochProvider } from '../src/adapters/file-current-epoch-provider';
import { currentEpochSnapshotFileName } from '../src/adapters/file-current-epoch-binding';
import { canonicalJsonBytes } from '../src/kernel/canonical-json';
import { verifyHistoricalS01ProgressAuthority } from '../src/kernel/operator-progress-authority';
import type { AuthorizedS01ProgressAuthority } from '../src/kernel/operator-progress-authority';
import { parseStrictJson } from '../src/kernel/strict-json';
import type { JsonValue } from '../src/kernel/strict-json';
import { verifyExecutableRunBundle } from '../src/runtime/executable-run-bundle-verifier';
import { verifyHistoricalExecutableRunBundle } from '../src/runtime/executable-run-bundle-historical-verifier';

import type { CliInvocationFixture } from './cli-invocation-fixture';
import { currentEpochSnapshotBytes } from './current-epoch-fixture';
import { verifiedGitTarget } from './git-target-fixture';

type JsonRecord = { [key: string]: JsonValue };
export type BundleArtifactKind = 'evidence' | 'input' | 'stderr' | 'stdout';
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function record(value: JsonValue | undefined, label: string): JsonRecord {
  if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} is not a record`);
  }
  return value;
}

function array(value: JsonValue | undefined, label: string): JsonValue[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} is not an array`);
  return value;
}

function framedRecord(bytes: Buffer, label: string): JsonRecord {
  if (bytes.at(-1) !== 0x0a) throw new TypeError(`${label} is not framed`);
  return record(parseStrictJson(bytes.subarray(0, -1)), label);
}

function changedArtifact(bytes: Buffer, kind: BundleArtifactKind): Buffer {
  if (kind === 'evidence') {
    const value = framedRecord(bytes, 'execution evidence');
    value.run_nonce_sha256 = 'f'.repeat(64);
    return Buffer.concat([canonicalJsonBytes(value), Buffer.from('\n')]);
  }
  if (kind === 'input') {
    const value = array(parseStrictJson(bytes), 'execution envelope');
    const entry = record(value[0], 'execution envelope entry');
    const reference = record(entry.reference, 'execution envelope reference');
    const object = Buffer.concat([
      Buffer.from(typeof entry.object_base64 === 'string' ? entry.object_base64 : '', 'base64'),
      Buffer.from(' '),
    ]);
    entry.object_base64 = object.toString('base64');
    reference.sha256 = digest(object);
    reference.uri = `aria-evidence://sha256/${reference.sha256}`;
    return canonicalJsonBytes(value);
  }
  if (kind === 'stderr') {
    const value = framedRecord(bytes, 'execution stderr');
    value.reason_code = 'TAMPERED-REASON';
    return Buffer.concat([canonicalJsonBytes(value), Buffer.from('\n')]);
  }
  const changed = Buffer.from(bytes);
  changed[0] = changed[0] === 0x7b ? 0x5b : 0x7b;
  return changed;
}

export function tamperAndRepinBundle(
  source: string,
  destination: string,
  kind: BundleArtifactKind,
): void {
  cpSync(source, destination, { recursive: true });
  const markerPath = join(destination, 'COMPLETE.json');
  const marker = framedRecord(readFileSync(markerPath), 'run bundle marker');
  const runs = array(marker.runs, 'run bundle runs');
  const run = record(runs[kind === 'stderr' ? 1 : 0], 'run bundle run');
  const files = array(run.files, 'run bundle files');
  const fileIndex = { evidence: 0, input: 1, stdout: 2, stderr: 3 }[kind];
  const artifact = record(files[fileIndex], 'run bundle artifact');
  if (typeof artifact.path !== 'string') throw new TypeError('run bundle artifact path is absent');
  const artifactPath = join(destination, artifact.path);
  const changed = changedArtifact(readFileSync(artifactPath), kind);
  writeFileSync(artifactPath, changed);
  artifact.byte_length = changed.byteLength;
  artifact.sha256 = digest(changed);
  if (kind === 'stderr') {
    const failure = record(run.failure, 'run bundle failure');
    failure.stderr_byte_length = changed.byteLength;
    failure.stderr_sha256 = digest(changed);
  }
  writeFileSync(markerPath, Buffer.concat([canonicalJsonBytes(marker), Buffer.from('\n')]));
}

export function bundleVerifierFixture(
  fixture: CliInvocationFixture,
  authority: AuthorizedS01ProgressAuthority,
  operatorEnvelopeBytes: Uint8Array,
  operatorTrustRootBytes: Uint8Array,
  operatorTrustRootSha256: string,
  executionTrustRootBytes: Uint8Array,
) {
  const target = verifiedGitTarget(fixture.repository);
  const provider = new FileCurrentEpochProvider({
    state_root: fixture.current_epoch_root,
    provider_id: authority.authority.document.invalidation_epoch_provider_id,
    operator_trust_root_bytes: operatorTrustRootBytes,
    expected_operator_trust_root_sha256: operatorTrustRootSha256,
  });
  const historicalAuthority = verifyHistoricalS01ProgressAuthority({
    envelope_bytes: operatorEnvelopeBytes,
    trust_root_bytes: operatorTrustRootBytes,
    expected_trust_root_sha256: operatorTrustRootSha256,
  });
  return Object.freeze({
    verify: (bundlePath: string) =>
      verifyExecutableRunBundle({
        bundle_path: bundlePath,
        authority,
        target,
        execution_trust_root_bytes: executionTrustRootBytes,
        current_epoch_provider: provider,
      }),
    verify_historical: (bundlePath: string) =>
      verifyHistoricalExecutableRunBundle({
        bundle_path: bundlePath,
        authority: historicalAuthority,
        target,
        execution_trust_root_bytes: executionTrustRootBytes,
      }),
    advance_epoch: () =>
      writeFileSync(
        join(fixture.current_epoch_root, currentEpochSnapshotFileName),
        currentEpochSnapshotBytes(authority, {
          revision: 2,
          dependency_sha256: '9'.repeat(64),
        }),
        { mode: 0o600 },
      ),
    close: () => provider.close(),
  });
}
