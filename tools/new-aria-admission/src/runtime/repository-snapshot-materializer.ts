import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import type {
  RepositoryExecutionSnapshot,
  RepositorySnapshotFile,
} from '../application/repository-execution-snapshot';

import {
  listedSnapshotFiles,
  removeSnapshotDirectoryContents,
  repositorySnapshotEntryLimit,
} from './repository-snapshot-directory';
import { runtimeTemporaryRoot } from './runtime-temporary-root';

const digest = (algorithm: 'sha1' | 'sha256', bytes: Uint8Array): string =>
  createHash(algorithm).update(bytes).digest('hex');

const gitBlobDigest = (bytes: Uint8Array): string =>
  createHash('sha1')
    .update(Buffer.from(`blob ${bytes.byteLength}\0`))
    .update(bytes)
    .digest('hex');

function readExactFile(path: string, expected: RepositorySnapshotFile): void {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(descriptor);
    if (
      !before.isFile() ||
      (before.mode & 0o777) !== (expected.mode === '100755' ? 0o500 : 0o400)
    ) {
      throw new TypeError('private repository snapshot file mode changed');
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      digest('sha256', bytes) !== expected.content_sha256 ||
      gitBlobDigest(bytes) !== expected.blob_sha
    ) {
      throw new TypeError('private repository snapshot file changed');
    }
  } finally {
    closeSync(descriptor);
  }
}

function lockDirectories(root: string, snapshot: RepositoryExecutionSnapshot): void {
  const directories = new Set<string>(['']);
  for (const file of snapshot.files) {
    let directory = dirname(file.path);
    while (directory !== '.') {
      directories.add(directory);
      directory = dirname(directory);
    }
  }
  for (const directory of [...directories].sort((left, right) => right.length - left.length)) {
    chmodSync(directory.length === 0 ? root : join(root, directory), 0o500);
  }
}

export class PrivateRepositorySnapshot {
  readonly root: string;
  private readonly device: number;
  private readonly inode: number;
  private readonly maximumEntries: number;
  private readonly rootFd: number;
  private disposed = false;

  constructor(private readonly snapshot: RepositoryExecutionSnapshot) {
    this.maximumEntries = repositorySnapshotEntryLimit(snapshot);
    this.root = mkdtempSync(join(runtimeTemporaryRoot(), 'new-aria-repository-snapshot-'));
    this.rootFd = openSync(
      this.root,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const identity = fstatSync(this.rootFd);
    this.device = identity.dev;
    this.inode = identity.ino;
    try {
      for (const file of snapshot.files) {
        const path = join(this.root, file.path);
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        writeFileSync(path, file.bytes, { flag: 'wx', mode: 0o600 });
        chmodSync(path, file.mode === '100755' ? 0o500 : 0o400);
      }
      lockDirectories(this.root, snapshot);
      this.verify();
    } catch (error) {
      removeSnapshotDirectoryContents(this.rootFd, this.maximumEntries);
      closeSync(this.rootFd);
      rmdirSync(this.root);
      throw error;
    }
  }

  verify(): void {
    if (this.disposed) throw new TypeError('private repository snapshot is closed');
    const rootIdentity = lstatSync(this.root);
    if (
      !rootIdentity.isDirectory() ||
      rootIdentity.isSymbolicLink() ||
      rootIdentity.dev !== this.device ||
      rootIdentity.ino !== this.inode ||
      (rootIdentity.mode & 0o777) !== 0o500
    ) {
      throw new TypeError('private repository snapshot root changed');
    }
    const expectedPaths = this.snapshot.files.map((file) => file.path);
    const descriptorRoot = `/proc/self/fd/${this.rootFd}`;
    const actualPaths = listedSnapshotFiles(descriptorRoot, this.maximumEntries);
    if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
      throw new TypeError('private repository snapshot file set changed');
    }
    for (const file of this.snapshot.files) readExactFile(join(descriptorRoot, file.path), file);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.verifyForDisposal();
      removeSnapshotDirectoryContents(this.rootFd, this.maximumEntries);
      const identity = lstatSync(this.root);
      if (identity.dev !== this.device || identity.ino !== this.inode) {
        throw new TypeError('private repository snapshot root changed during disposal');
      }
      fchmodSync(this.rootFd, 0o700);
      rmdirSync(this.root);
    } finally {
      closeSync(this.rootFd);
    }
  }

  private verifyForDisposal(): void {
    this.disposed = false;
    try {
      this.verify();
    } finally {
      this.disposed = true;
    }
  }
}
