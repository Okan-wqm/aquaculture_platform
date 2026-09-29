import { createHash } from 'node:crypto';
import { closeSync, constants, openSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';

import {
  bindOwnerControlledDirectory,
  verifyOwnerControlledDirectory,
} from './publication-directory-guard';
import { parseCompletionProofBundleMarker } from './completion-proof-bundle-contract';
import type { CompletionBundleArtifactDescriptor } from './completion-proof-bundle-contract';
import { readOwnedPublicationFile } from './owned-publication-file';

export interface CompletionProofBundleAuthorityArtifacts {
  readonly marker_sha256: string;
  readonly operator_envelope_bytes: Buffer;
  readonly operator_trust_root_bytes: Buffer;
}

const descriptorPath = (descriptor: number): string => `/proc/self/fd/${descriptor}`;
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function closeIgnoringFailure(descriptor: number): void {
  if (descriptor < 0) return;
  try {
    closeSync(descriptor);
  } catch {
    // Preserve the primary pre-authorization failure.
  }
}

function readPublicArtifact(
  directoryFd: number,
  descriptor: CompletionBundleArtifactDescriptor,
): Buffer {
  if (descriptor.byte_length > 1024 * 1024) {
    throw new TypeError('completion authority artifact exceeds its byte limit');
  }
  const bytes = readOwnedPublicationFile(
    directoryFd,
    descriptor.path.slice('payload/'.length),
    {
      expected_length: descriptor.byte_length,
      maximum_length: 1024 * 1024,
      label: 'completion authority artifact',
    },
  );
  if (sha256(bytes) !== descriptor.sha256) {
    throw new TypeError('completion authority artifact differs from its marker');
  }
  return bytes;
}

export function readCompletionProofBundleAuthority(
  bundlePath: string,
  markerName: 'CANDIDATE.json' | 'COMPLETE.json' = 'COMPLETE.json',
): CompletionProofBundleAuthorityArtifacts {
  if (!isAbsolute(bundlePath) || normalize(bundlePath) !== bundlePath) {
    throw new TypeError('completion bundle path must be absolute and canonical');
  }
  let rootFd = -1;
  let payloadFd = -1;
  try {
    rootFd = openSync(
      bundlePath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const rootBinding = bindOwnerControlledDirectory(bundlePath, rootFd);
    const markerBytes = readOwnedPublicationFile(rootFd, markerName, {
      minimum_length: 2,
      maximum_length: 256 * 1024,
      label: 'completion bundle marker',
    });
    const marker = parseCompletionProofBundleMarker(markerBytes);
    const payloadPath = join(bundlePath, 'payload');
    payloadFd = openSync(
      join(descriptorPath(rootFd), 'payload'),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const payloadBinding = bindOwnerControlledDirectory(payloadPath, payloadFd);
    const result = Object.freeze({
      marker_sha256: sha256(markerBytes),
      operator_envelope_bytes: readPublicArtifact(payloadFd, marker.files.operator_envelope),
      operator_trust_root_bytes: readPublicArtifact(payloadFd, marker.files.operator_trust_root),
    });
    verifyOwnerControlledDirectory(payloadPath, payloadFd, payloadBinding);
    verifyOwnerControlledDirectory(bundlePath, rootFd, rootBinding);
    return result;
  } finally {
    closeIgnoringFailure(payloadFd);
    closeIgnoringFailure(rootFd);
  }
}
