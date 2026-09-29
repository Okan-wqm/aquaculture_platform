import { createHash } from 'node:crypto';
import { closeSync, constants, openSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';

import {
  bindOwnerControlledDirectory,
  verifyOwnerControlledDirectory,
} from './publication-directory-guard';
import type { BoundPublicationDirectory } from './publication-directory-guard';
import type { CompletionProofBundleSource } from './completion-proof-bundle';
import {
  parseCompletionProofBundleMarker,
  type CompletionBundleArtifactDescriptor,
  type CompletionProofBundleMarker,
} from './completion-proof-bundle-contract';
import { boundedDirectoryEntries } from '../adapters/bounded-directory-entries';
import { readOwnedPublicationFile } from './owned-publication-file';

export interface LoadedCompletionProofBundle {
  readonly marker: CompletionProofBundleMarker;
  readonly marker_bytes: Buffer;
  readonly source: CompletionProofBundleSource;
}

const descriptorPath = (descriptor: number): string => `/proc/self/fd/${descriptor}`;
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const MEBIBYTE = 1024 * 1024;
const MAX_TOTAL_BYTES = 80 * MEBIBYTE;

function closeIgnoringFailure(descriptor: number): void {
  if (descriptor < 0) return;
  try {
    closeSync(descriptor);
  } catch {
    // Preserve the primary closed-reader failure.
  }
}

function exactEntries(descriptor: number, expected: readonly string[], label: string): void {
  const actual = [...boundedDirectoryEntries(descriptor, expected.length + 1, label)].sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length ||
    actual.some((entry, index) => entry !== canonical[index])
  )
    throw new TypeError(`${label} file roster is not exact`);
}

function readOwnedFile(
  directoryFd: number,
  name: string,
  expectedLength: number | undefined,
  maximumLength: number,
): Buffer {
  return readOwnedPublicationFile(directoryFd, name, {
    expected_length: expectedLength,
    maximum_length: maximumLength,
    label: 'completion bundle artifact',
  });
}

function limit(path: string): number {
  if (path.includes('/object-')) return 16 * MEBIBYTE;
  if (
    path.endsWith('event-chain.jsonl') ||
    path.includes('/manifest-') ||
    path.endsWith('evidence-attestation.json')
  )
    return 4 * MEBIBYTE;
  return MEBIBYTE;
}

function flatten(
  marker: CompletionProofBundleMarker,
): readonly CompletionBundleArtifactDescriptor[] {
  const files = marker.files;
  return Object.freeze([
    files.target_request,
    files.operator_envelope,
    files.operator_trust_root,
    files.evidence_trust_root,
    files.execution_trust_root,
    files.event_policy,
    files.freshness_policy,
    files.event_chain,
    ...files.manifests,
    ...files.objects,
    files.evidence_attestation,
    files.projection_artifact,
  ]);
}

function artifact(
  artifacts: ReadonlyMap<string, Buffer>,
  descriptor: CompletionBundleArtifactDescriptor,
): Buffer {
  const bytes = artifacts.get(descriptor.path);
  if (bytes === undefined) throw new TypeError('completion bundle artifact is absent');
  return bytes;
}

export function readBoundCompletionProofBundle(
  bundlePath: string,
  rootFd: number,
  markerName: 'CANDIDATE.json' | 'COMPLETE.json' = 'COMPLETE.json',
): LoadedCompletionProofBundle {
  if (!isAbsolute(bundlePath) || normalize(bundlePath) !== bundlePath) {
    throw new TypeError('completion bundle path must be absolute and canonical');
  }
  let payloadFd = -1;
  try {
    const rootBinding: BoundPublicationDirectory = bindOwnerControlledDirectory(bundlePath, rootFd);
    exactEntries(rootFd, [markerName, 'payload'], 'completion bundle root');
    const markerBytes = readOwnedFile(rootFd, markerName, undefined, 256 * 1024);
    const marker = parseCompletionProofBundleMarker(markerBytes);
    const payloadPath = join(bundlePath, 'payload');
    payloadFd = openSync(
      join(descriptorPath(rootFd), 'payload'),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const payloadBinding = bindOwnerControlledDirectory(payloadPath, payloadFd);
    const descriptors = flatten(marker);
    const names = descriptors.map(({ path }) => path.slice('payload/'.length));
    exactEntries(payloadFd, names, 'completion bundle payload');
    let total = 0;
    const artifacts = new Map<string, Buffer>();
    for (const descriptor of descriptors) {
      if (descriptor.byte_length > limit(descriptor.path)) {
        throw new TypeError('completion bundle artifact exceeds its byte limit');
      }
      if (total > MAX_TOTAL_BYTES - descriptor.byte_length) {
        throw new TypeError('completion bundle exceeds its aggregate byte budget');
      }
      const name = descriptor.path.slice('payload/'.length);
      const bytes = readOwnedFile(payloadFd, name, descriptor.byte_length, limit(descriptor.path));
      if (sha256(bytes) !== descriptor.sha256) {
        throw new TypeError('completion bundle artifact differs from its marker');
      }
      artifacts.set(descriptor.path, bytes);
      total += bytes.byteLength;
    }
    verifyOwnerControlledDirectory(payloadPath, payloadFd, payloadBinding);
    verifyOwnerControlledDirectory(bundlePath, rootFd, rootBinding);
    const files = marker.files;
    return Object.freeze({
      marker,
      marker_bytes: markerBytes,
      source: Object.freeze({
        target_request_bytes: artifact(artifacts, files.target_request),
        operator_envelope_bytes: artifact(artifacts, files.operator_envelope),
        operator_trust_root_bytes: artifact(artifacts, files.operator_trust_root),
        evidence_trust_root_bytes: artifact(artifacts, files.evidence_trust_root),
        execution_trust_root_bytes: artifact(artifacts, files.execution_trust_root),
        event_policy_bytes: artifact(artifacts, files.event_policy),
        freshness_policy_bytes: artifact(artifacts, files.freshness_policy),
        event_chain_bytes: artifact(artifacts, files.event_chain),
        manifest_bytes: Object.freeze(files.manifests.map((entry) => artifact(artifacts, entry))),
        objects: new Map(
          files.objects.map((entry) => [entry.uri, artifact(artifacts, entry)] as const),
        ),
        evidence_attestation_bytes: artifact(artifacts, files.evidence_attestation),
        projection_artifact_bytes: artifact(artifacts, files.projection_artifact),
      }),
    });
  } finally {
    closeIgnoringFailure(payloadFd);
  }
}

export function readCompletionProofBundle(
  bundlePath: string,
  markerName: 'CANDIDATE.json' | 'COMPLETE.json' = 'COMPLETE.json',
): LoadedCompletionProofBundle {
  if (!isAbsolute(bundlePath) || normalize(bundlePath) !== bundlePath) {
    throw new TypeError('completion bundle path must be absolute and canonical');
  }
  const rootFd = openSync(
    bundlePath,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    return readBoundCompletionProofBundle(bundlePath, rootFd, markerName);
  } finally {
    closeIgnoringFailure(rootFd);
  }
}
