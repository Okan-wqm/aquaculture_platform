import { closeSync, constants, openSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize } from 'node:path';

import { boundedDirectoryEntries } from '../adapters/bounded-directory-entries';
import {
  CompletionProofBundlePublication,
  materializeCompletionProofBundle,
} from './completion-proof-bundle';
import type {
  CompletionProofBundleMaterial,
  CompletionProofBundleSource,
} from './completion-proof-bundle';
import { readOwnedPublicationFile } from './owned-publication-file';
import {
  bindOwnerControlledDirectory,
  verifyOwnerControlledDirectory,
} from './publication-directory-guard';

const descriptorPath = (descriptor: number): string => `/proc/self/fd/${descriptor}`;

function isMissing(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}

function closeIgnoringFailure(descriptor: number): void {
  if (descriptor < 0) return;
  try {
    closeSync(descriptor);
  } catch {
    // Resume preserves the primary validation failure.
  }
}

function exactBytes(directoryFd: number, name: string, expected: Buffer): void {
  const actual = readOwnedPublicationFile(directoryFd, name, {
    expected_length: expected.byteLength,
    maximum_length: expected.byteLength,
    label: 'resumable completion bundle artifact',
  });
  if (!actual.equals(expected)) {
    throw new TypeError('resumable completion bundle artifact bytes differ');
  }
}

function validateArtifactDirectory(
  directoryFd: number,
  material: CompletionProofBundleMaterial,
): readonly string[] {
  const entries = boundedDirectoryEntries(
    directoryFd,
    material.artifacts.size + 1,
    'completion bundle artifact directory',
  );
  if (entries.length !== material.artifacts.size) {
    throw new TypeError('completion bundle payload roster is incomplete');
  }
  for (const name of entries) {
    const expected = material.artifacts.get(name);
    if (expected === undefined) {
      throw new TypeError('completion bundle contains an unexpected artifact');
    }
    exactBytes(directoryFd, name, expected);
  }
  return entries;
}

function exactCandidate(rootFd: number, material: CompletionProofBundleMaterial): void {
  let payloadFd = -1;
  try {
    payloadFd = openSync(
      join(descriptorPath(rootFd), 'payload'),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    validateArtifactDirectory(payloadFd, material);
    exactBytes(rootFd, 'CANDIDATE.json', material.marker_bytes);
  } finally {
    closeIgnoringFailure(payloadFd);
  }
}

function resumeExisting(bundlePath: string, material: CompletionProofBundleMaterial): boolean {
  const parentPath = dirname(bundlePath);
  const rootName = basename(bundlePath);
  let parentFd = -1;
  let rootFd = -1;
  try {
    parentFd = openSync(
      parentPath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const parentBinding = bindOwnerControlledDirectory(parentPath, parentFd);
    rootFd = openSync(
      join(descriptorPath(parentFd), rootName),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const rootBinding = bindOwnerControlledDirectory(bundlePath, rootFd);
    const entries = [...boundedDirectoryEntries(rootFd, 3, 'completion bundle root')].sort();
    if (entries.length !== 2 || entries[0] !== 'CANDIDATE.json' || entries[1] !== 'payload')
      throw new TypeError('completion bundle cannot adopt an unproven partial publication');
    exactCandidate(rootFd, material);
    verifyOwnerControlledDirectory(bundlePath, rootFd, rootBinding);
    verifyOwnerControlledDirectory(parentPath, parentFd, parentBinding);
    return true;
  } finally {
    closeIgnoringFailure(rootFd);
    closeIgnoringFailure(parentFd);
  }
}

export function ensureStagedCompletionProofBundle(
  bundlePath: string,
  source: CompletionProofBundleSource,
): void {
  if (!isAbsolute(bundlePath) || normalize(bundlePath) !== bundlePath) {
    throw new TypeError('completion bundle path must be absolute and canonical');
  }
  const material = materializeCompletionProofBundle(source);
  try {
    if (resumeExisting(bundlePath, material)) return;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const publication = new CompletionProofBundlePublication(bundlePath);
  publication.stage(source);
  publication.detachCandidate();
}
