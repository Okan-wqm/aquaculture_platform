import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { canonicalOutputPendingName } from './canonical-output-recovery';
import { openOrResumeCanonicalOutputPending } from './canonical-output-pending';
import { readOwnedPublicationFile } from './owned-publication-file';
import {
  bindOwnerControlledDirectory,
  verifyOwnerControlledDirectory,
} from './publication-directory-guard';

const descriptorPath = (descriptor: number): string => `/proc/self/fd/${descriptor}`;

function missing(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

export function canonicalOutputReservationSidecarName(
  outputName: string,
  reservation: Uint8Array,
): string {
  const digest = createHash('sha256')
    .update(Buffer.from(outputName))
    .update(Buffer.from([0]))
    .update(reservation)
    .digest('hex');
  return `.new-aria-reservation-${digest}.pending`;
}

function exact(parentFd: number, name: string, bytes: Buffer, links: 1 | 2): void {
  const actual = readOwnedPublicationFile(parentFd, name, {
    expected_length: bytes.byteLength,
    expected_link_count: links,
    maximum_length: bytes.byteLength,
    label: 'canonical output reservation',
  });
  if (!actual.equals(bytes)) throw new TypeError('canonical output reservation bytes differ');
}

function assertPair(parentFd: number, output: string, sidecar: string, bytes: Buffer): void {
  exact(parentFd, output, bytes, 2);
  exact(parentFd, sidecar, bytes, 2);
  const root = descriptorPath(parentFd);
  const outputStat = lstatSync(join(root, output));
  const sidecarStat = lstatSync(join(root, sidecar));
  if (outputStat.dev !== sidecarStat.dev || outputStat.ino !== sidecarStat.ino) {
    throw new TypeError('canonical output reservation pair identity differs');
  }
}

function materializePending(path: string, bytes: Buffer): void {
  const descriptor = openOrResumeCanonicalOutputPending(path, bytes);
  try {
    if (fstatSync(descriptor).size === 0) writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export type CanonicalOutputReservationPhase = 'RESERVED' | 'PUBLISHED';

export function acquireCanonicalOutputReservation(
  path: string,
  reservation: Buffer,
  expected: Buffer,
): CanonicalOutputReservationPhase {
  const parentPath = dirname(path);
  const output = basename(path);
  const sidecar = canonicalOutputReservationSidecarName(output, reservation);
  const parentFd = openSync(
    parentPath,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const binding = bindOwnerControlledDirectory(parentPath, parentFd);
    const root = descriptorPath(parentFd);
    const outputPath = join(root, output);
    const sidecarPath = join(root, sidecar);
    const hasOutput = exists(outputPath);
    const hasSidecar = exists(sidecarPath);
    if (hasOutput) {
      if (hasSidecar) {
        const outputStat = lstatSync(outputPath);
        const sidecarStat = lstatSync(sidecarPath);
        if (outputStat.dev === sidecarStat.dev && outputStat.ino === sidecarStat.ino) {
          assertPair(parentFd, output, sidecar, reservation);
          verifyOwnerControlledDirectory(parentPath, parentFd, binding);
          return 'RESERVED';
        }
        exact(parentFd, output, expected, 1);
        exact(parentFd, sidecar, reservation, 1);
        unlinkSync(sidecarPath);
        fsyncSync(parentFd);
        verifyOwnerControlledDirectory(parentPath, parentFd, binding);
        return 'PUBLISHED';
      }
      exact(parentFd, output, expected, 1);
      verifyOwnerControlledDirectory(parentPath, parentFd, binding);
      return 'PUBLISHED';
    }
    materializePending(sidecarPath, reservation);
    exact(parentFd, sidecar, reservation, 1);
    linkSync(sidecarPath, outputPath);
    fsyncSync(parentFd);
    assertPair(parentFd, output, sidecar, reservation);
    verifyOwnerControlledDirectory(parentPath, parentFd, binding);
    return 'RESERVED';
  } finally {
    closeSync(parentFd);
  }
}

export function publishReservedCanonicalOutput(
  path: string,
  reservation: Buffer,
  expected: Buffer,
): void {
  const parentPath = dirname(path);
  const output = basename(path);
  const sidecar = canonicalOutputReservationSidecarName(output, reservation);
  const parentFd = openSync(
    parentPath,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const binding = bindOwnerControlledDirectory(parentPath, parentFd);
    const root = descriptorPath(parentFd);
    assertPair(parentFd, output, sidecar, reservation);
    const pending = canonicalOutputPendingName(output, expected);
    materializePending(join(root, pending), expected);
    renameSync(join(root, pending), join(root, output));
    fsyncSync(parentFd);
    exact(parentFd, output, expected, 1);
    exact(parentFd, sidecar, reservation, 1);
    unlinkSync(join(root, sidecar));
    fsyncSync(parentFd);
    verifyOwnerControlledDirectory(parentPath, parentFd, binding);
  } finally {
    closeSync(parentFd);
  }
}

export function abortReservedCanonicalOutput(path: string, reservation: Buffer): void {
  const parentPath = dirname(path);
  const output = basename(path);
  const sidecar = canonicalOutputReservationSidecarName(output, reservation);
  const parentFd = openSync(
    parentPath,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const binding = bindOwnerControlledDirectory(parentPath, parentFd);
    const root = descriptorPath(parentFd);
    assertPair(parentFd, output, sidecar, reservation);
    unlinkSync(join(root, output));
    unlinkSync(join(root, sidecar));
    fsyncSync(parentFd);
    verifyOwnerControlledDirectory(parentPath, parentFd, binding);
  } finally {
    closeSync(parentFd);
  }
}
