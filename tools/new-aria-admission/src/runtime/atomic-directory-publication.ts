import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize } from 'node:path';

import { BoundedDirectoryEntryBudget } from '../adapters/bounded-directory-entries';
import {
  bindOwnerControlledDirectory,
  verifyOwnerControlledDirectory,
} from './publication-directory-guard';
import type { BoundPublicationDirectory } from './publication-directory-guard';

const fileName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const descriptorPath = (descriptor: number): string => `/proc/self/fd/${descriptor}`;
const entries = (path: string) =>
  new BoundedDirectoryEntryBudget(4_096, 'publication directory').read(path);

function removeFlatDirectory(parentFd: number, name: string): void {
  const path = join(descriptorPath(parentFd), name);
  const directoryFd = openSync(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    fchmodSync(directoryFd, 0o700);
    for (const entry of entries(descriptorPath(directoryFd))) {
      if (!entry.isFile() && !entry.isSymbolicLink()) {
        throw new TypeError('publication staging contains an unexpected entry');
      }
      unlinkSync(join(descriptorPath(directoryFd), entry.name));
    }
  } finally {
    closeSync(directoryFd);
  }
  rmdirSync(path);
}

function closeIgnoringFailure(descriptor: number): void {
  if (descriptor < 0) return;
  try {
    closeSync(descriptor);
  } catch {
    // Construction cleanup preserves the originating failure.
  }
}

function cleanupFailedConstruction(
  parentFd: number,
  rootFd: number,
  stagingFd: number,
  rootName: string,
  rootCreated: boolean,
): void {
  closeIgnoringFailure(stagingFd);
  if (rootFd >= 0) {
    try {
      const names = entries(descriptorPath(rootFd)).map(({ name }) => name);
      if (names.includes('staging')) removeFlatDirectory(rootFd, 'staging');
    } catch {
      // Unknown entries are never deleted during failed construction cleanup.
    }
    closeIgnoringFailure(rootFd);
  }
  if (rootCreated) {
    try {
      rmdirSync(join(descriptorPath(parentFd), rootName));
      fsyncSync(parentFd);
    } catch {
      // A failed safe removal leaves the owned root for operator inspection.
    }
  }
  closeIgnoringFailure(parentFd);
}

export class AtomicDirectoryPublication {
  private readonly parentFd: number;
  private readonly parentPath: string;
  private readonly parentBinding: BoundPublicationDirectory;
  private readonly rootFd: number;
  private readonly rootName: string;
  private readonly rootPath: string;
  private readonly rootBinding: BoundPublicationDirectory;
  private stagingFd: number;
  private released = false;

  constructor(rootPath: string) {
    if (!isAbsolute(rootPath) || normalize(rootPath) !== rootPath) {
      throw new TypeError('publication path must be absolute and canonical');
    }
    const parent = dirname(rootPath);
    this.rootPath = rootPath;
    this.rootName = basename(rootPath);
    this.parentPath = parent;
    const parentFd = openSync(
      parent,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    let rootFd = -1;
    let stagingFd = -1;
    let rootCreated = false;
    try {
      this.parentBinding = bindOwnerControlledDirectory(parent, parentFd);
      mkdirSync(join(descriptorPath(parentFd), this.rootName), { mode: 0o700 });
      rootCreated = true;
      rootFd = openSync(
        join(descriptorPath(parentFd), this.rootName),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      this.rootBinding = bindOwnerControlledDirectory(this.rootPath, rootFd);
      mkdirSync(join(descriptorPath(rootFd), 'staging'), { mode: 0o700 });
      stagingFd = openSync(
        join(descriptorPath(rootFd), 'staging'),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      fsyncSync(rootFd);
      fsyncSync(parentFd);
      this.parentFd = parentFd;
      this.rootFd = rootFd;
      this.stagingFd = stagingFd;
      this.verifyRoot();
    } catch (error) {
      cleanupFailedConstruction(parentFd, rootFd, stagingFd, this.rootName, rootCreated);
      throw error;
    }
  }

  write(name: string, bytes: Uint8Array): void {
    if (this.released || !fileName.test(name)) throw new TypeError('publication file is invalid');
    const descriptor = openSync(
      join(descriptorPath(this.stagingFd), name),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(descriptor, bytes);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }

  commitPayload(): void {
    if (this.released) throw new TypeError('publication is closed');
    fsyncSync(this.stagingFd);
    closeSync(this.stagingFd);
    this.stagingFd = -1;
    this.verifyRoot();
    renameSync(
      join(descriptorPath(this.rootFd), 'staging'),
      join(descriptorPath(this.rootFd), 'payload'),
    );
    fsyncSync(this.rootFd);
  }

  stageCandidate(marker: Uint8Array): void {
    if (this.released || this.stagingFd >= 0) throw new TypeError('publication is not committed');
    const descriptor = openSync(
      join(descriptorPath(this.rootFd), 'CANDIDATE.json'),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(descriptor, marker);
      fsyncSync(descriptor);
      fsyncSync(this.rootFd);
      this.verifyRoot();
    } finally {
      closeSync(descriptor);
    }
  }

  completeCandidate(): void {
    if (this.released || this.stagingFd >= 0) throw new TypeError('publication is not committed');
    this.verifyRoot();
    renameSync(
      join(descriptorPath(this.rootFd), 'CANDIDATE.json'),
      join(descriptorPath(this.rootFd), 'COMPLETE.json'),
    );
    fsyncSync(this.rootFd);
    fsyncSync(this.parentFd);
    this.verifyRoot();
    closeSync(this.rootFd);
    closeSync(this.parentFd);
    this.released = true;
  }

  releaseCandidate(): void {
    if (this.released || this.stagingFd >= 0) throw new TypeError('publication is not committed');
    this.verifyRoot();
    fsyncSync(this.rootFd);
    fsyncSync(this.parentFd);
    closeSync(this.rootFd);
    closeSync(this.parentFd);
    this.released = true;
  }

  abort(): void {
    if (this.released) return;
    this.released = true;
    try {
      this.verifyRoot();
      if (this.stagingFd >= 0) {
        closeSync(this.stagingFd);
        this.stagingFd = -1;
      }
      const names = entries(descriptorPath(this.rootFd)).map(({ name }) => name);
      if (names.includes('staging')) removeFlatDirectory(this.rootFd, 'staging');
      if (names.includes('payload')) removeFlatDirectory(this.rootFd, 'payload');
      if (names.includes('CANDIDATE.json'))
        unlinkSync(join(descriptorPath(this.rootFd), 'CANDIDATE.json'));
      if (names.includes('COMPLETE.json'))
        unlinkSync(join(descriptorPath(this.rootFd), 'COMPLETE.json'));
      if (entries(descriptorPath(this.rootFd)).length !== 0) {
        throw new TypeError('publication root contains an unexpected entry');
      }
      fchmodSync(this.rootFd, 0o700);
      this.verifyRoot();
      rmdirSync(join(descriptorPath(this.parentFd), this.rootName));
      fsyncSync(this.parentFd);
    } finally {
      if (this.stagingFd >= 0) closeSync(this.stagingFd);
      closeSync(this.rootFd);
      closeSync(this.parentFd);
    }
  }

  private verifyRoot(): void {
    verifyOwnerControlledDirectory(this.parentPath, this.parentFd, this.parentBinding);
    verifyOwnerControlledDirectory(this.rootPath, this.rootFd, this.rootBinding);
  }
}
