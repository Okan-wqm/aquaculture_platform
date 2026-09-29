import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';

import { boundedDirectoryEntryNames } from '../adapters/bounded-directory-entries';
import {
  bindOwnerControlledDirectory,
  verifyOwnerControlledDirectory,
} from './publication-directory-guard';
import type { BoundPublicationDirectory } from './publication-directory-guard';
import { EXECUTION_INPUT_ENVELOPE_MAX_BYTES } from './execution-input-envelope';
import { parseExecutionSessionBundleMarker } from './executable-run-bundle-contract';
import type {
  BundleArtifactDescriptor,
  ExecutionSessionBundleMarker,
} from './executable-run-bundle-contract';

interface LoadedExecutionSessionBundle {
  readonly marker: ExecutionSessionBundleMarker;
  readonly marker_bytes: Buffer;
  readonly artifacts: ReadonlyMap<string, Buffer>;
}

const descriptorPath = (descriptor: number): string => `/proc/self/fd/${descriptor}`;
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const MAX_BUNDLE_BYTES = 80 * 1024 * 1024;
const MAX_SMALL_ARTIFACT_BYTES = 1024 * 1024;

function closeIgnoringFailure(descriptor: number): void {
  if (descriptor < 0) return;
  try {
    closeSync(descriptor);
  } catch {
    // A read failure remains the primary fail-closed result.
  }
}

function exactEntries(descriptor: number, expected: readonly string[], label: string): void {
  const actual = [
    ...boundedDirectoryEntryNames(descriptorPath(descriptor), expected.length, label),
  ].sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((entry, index) => entry !== sortedExpected[index])
  )
    throw new TypeError(`${label} file roster is not exact`);
}

function validateOwnedFile(
  descriptor: number,
  expectedBytes: number | undefined,
  maximumBytes: number,
): ReturnType<typeof fstatSync> {
  const stat = fstatSync(descriptor);
  const effectiveUser = process.geteuid?.();
  if (
    effectiveUser === undefined ||
    !stat.isFile() ||
    stat.uid !== effectiveUser ||
    stat.nlink !== 1 ||
    (stat.mode & 0o777) !== 0o600 ||
    stat.size < 0 ||
    stat.size > maximumBytes ||
    (expectedBytes !== undefined && stat.size !== expectedBytes)
  )
    throw new TypeError('run bundle artifact is mutable, oversized, or has unsafe metadata');
  return stat;
}

function readOwnedFile(
  directoryFd: number,
  name: string,
  expectedBytes: number | undefined,
  maximumBytes: number,
): Buffer {
  const descriptor = openSync(
    join(descriptorPath(directoryFd), name),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const before = validateOwnedFile(descriptor, expectedBytes, maximumBytes);
    const bytes = readFileSync(descriptor);
    const after = validateOwnedFile(descriptor, expectedBytes, maximumBytes);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      bytes.byteLength !== after.size
    )
      throw new TypeError('run bundle artifact changed while it was read');
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function artifactLimit(path: string): number {
  return path.endsWith('-input-envelope.json')
    ? EXECUTION_INPUT_ENVELOPE_MAX_BYTES
    : MAX_SMALL_ARTIFACT_BYTES;
}

function verifyDescriptor(descriptor: BundleArtifactDescriptor, bytes: Uint8Array): void {
  if (bytes.byteLength !== descriptor.byte_length || digest(bytes) !== descriptor.sha256) {
    throw new TypeError('run bundle artifact differs from its marker');
  }
}

export function readExecutionSessionBundle(
  bundlePath: string,
  expectedRunIds: readonly string[],
  markerName: 'CANDIDATE.json' | 'COMPLETE.json' = 'COMPLETE.json',
): LoadedExecutionSessionBundle {
  if (!isAbsolute(bundlePath) || normalize(bundlePath) !== bundlePath) {
    throw new TypeError('run bundle path must be absolute and canonical');
  }
  let rootFd = -1;
  let payloadFd = -1;
  let rootBinding: BoundPublicationDirectory | undefined;
  let payloadBinding: BoundPublicationDirectory | undefined;
  try {
    rootFd = openSync(
      bundlePath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    rootBinding = bindOwnerControlledDirectory(bundlePath, rootFd);
    exactEntries(rootFd, [markerName, 'payload'], 'run bundle root');
    const markerBytes = readOwnedFile(rootFd, markerName, undefined, 256 * 1024);
    const marker = parseExecutionSessionBundleMarker(markerBytes, expectedRunIds);
    const payloadPath = join(bundlePath, 'payload');
    payloadFd = openSync(
      join(descriptorPath(rootFd), 'payload'),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    payloadBinding = bindOwnerControlledDirectory(payloadPath, payloadFd);
    const descriptors = marker.runs.flatMap((run) => run.files);
    const names = descriptors.map(({ path }) => path.slice('payload/'.length));
    exactEntries(payloadFd, names, 'run bundle payload');
    let totalBytes = 0;
    const artifacts = new Map<string, Buffer>();
    for (const descriptor of descriptors) {
      const maximum = artifactLimit(descriptor.path);
      if (
        descriptor.byte_length > maximum ||
        totalBytes > MAX_BUNDLE_BYTES - descriptor.byte_length
      )
        throw new TypeError('run bundle exceeds its aggregate byte budget');
      const name = descriptor.path.slice('payload/'.length);
      const bytes = readOwnedFile(payloadFd, name, descriptor.byte_length, maximum);
      verifyDescriptor(descriptor, bytes);
      totalBytes += bytes.byteLength;
      artifacts.set(descriptor.path, bytes);
    }
    verifyOwnerControlledDirectory(payloadPath, payloadFd, payloadBinding);
    verifyOwnerControlledDirectory(bundlePath, rootFd, rootBinding);
    return Object.freeze({ marker, marker_bytes: markerBytes, artifacts });
  } finally {
    closeIgnoringFailure(payloadFd);
    closeIgnoringFailure(rootFd);
  }
}
