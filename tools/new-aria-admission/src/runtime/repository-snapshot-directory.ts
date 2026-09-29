import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  rmdirSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';

import { BoundedDirectoryEntryBudget } from '../adapters/bounded-directory-entries';
import type { RepositoryExecutionSnapshot } from '../application/repository-execution-snapshot';
import { compareCodePoints } from '../kernel/canonical-json';

export function repositorySnapshotEntryLimit(snapshot: RepositoryExecutionSnapshot): number {
  const directories = new Set<string>();
  for (const file of snapshot.files) {
    const segments = file.path.split('/').slice(0, -1);
    let parent = '';
    for (const segment of segments) {
      parent = parent.length === 0 ? segment : `${parent}/${segment}`;
      directories.add(parent);
    }
  }
  return snapshot.files.length + directories.size;
}

export function listedSnapshotFiles(root: string, maximumEntries: number): readonly string[] {
  const files: string[] = [];
  const budget = new BoundedDirectoryEntryBudget(maximumEntries, 'repository snapshot');
  const visit = (relativeDirectory: string): void => {
    const directory = relativeDirectory.length === 0 ? root : join(root, relativeDirectory);
    for (const entry of budget.read(directory)) {
      const relative =
        relativeDirectory.length === 0 ? entry.name : `${relativeDirectory}/${entry.name}`;
      const path = join(root, relative);
      if (entry.isSymbolicLink())
        throw new TypeError('private repository snapshot contains a symlink');
      if (entry.isDirectory()) {
        if ((lstatSync(path).mode & 0o777) !== 0o500) {
          throw new TypeError('private repository snapshot directory mode changed');
        }
        visit(relative);
      } else if (entry.isFile()) {
        files.push(relative);
      } else {
        throw new TypeError('private repository snapshot contains a special entry');
      }
    }
  };
  visit('');
  return files.sort(compareCodePoints);
}

export function removeSnapshotDirectoryContents(directoryFd: number, maximumEntries: number): void {
  const budget = new BoundedDirectoryEntryBudget(maximumEntries, 'repository snapshot cleanup');
  const remove = (parentFd: number): void => {
    fchmodSync(parentFd, 0o700);
    const directory = `/proc/self/fd/${parentFd}`;
    for (const entry of budget.read(directory)) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        unlinkSync(path);
        continue;
      }
      if (entry.isDirectory()) {
        const childFd = openSync(
          path,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        try {
          const before = fstatSync(childFd);
          const visible = lstatSync(path);
          if (before.dev !== visible.dev || before.ino !== visible.ino) {
            throw new TypeError('private repository cleanup directory identity changed');
          }
          remove(childFd);
          const after = lstatSync(path);
          if (before.dev !== after.dev || before.ino !== after.ino) {
            throw new TypeError('private repository cleanup directory identity changed');
          }
          rmdirSync(path);
        } finally {
          closeSync(childFd);
        }
        continue;
      }
      if (!entry.isFile()) throw new TypeError('private repository cleanup found a special entry');
      const fileFd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const exact = fstatSync(fileFd);
        const visible = lstatSync(path);
        if (!exact.isFile() || exact.dev !== visible.dev || exact.ino !== visible.ino) {
          throw new TypeError('private repository cleanup file identity changed');
        }
        unlinkSync(path);
      } finally {
        closeSync(fileFd);
      }
    }
  };
  remove(directoryFd);
}
