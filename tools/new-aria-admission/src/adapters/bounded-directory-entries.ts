import { opendirSync } from 'node:fs';
import type { Dirent } from 'node:fs';

export class BoundedDirectoryEntryBudget {
  private remaining: number;

  constructor(
    maximumEntries: number,
    private readonly label: string,
  ) {
    if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 0) {
      throw new TypeError(`${label} entry limit is invalid`);
    }
    this.remaining = maximumEntries;
  }

  read(path: string): readonly Dirent[] {
    const directory = opendirSync(path);
    const entries: Dirent[] = [];
    try {
      while (true) {
        const entry = directory.readSync();
        if (entry === null) return Object.freeze(entries);
        if (this.remaining === 0) {
          throw new TypeError(`${this.label} entry limit exceeded`);
        }
        this.remaining -= 1;
        entries.push(entry);
      }
    } finally {
      directory.closeSync();
    }
  }
}

export function boundedDirectoryEntryNames(
  path: string,
  maximumEntries: number,
  label: string,
): readonly string[] {
  return Object.freeze(
    new BoundedDirectoryEntryBudget(maximumEntries, label).read(path).map(({ name }) => name),
  );
}

export function boundedDirectoryEntries(
  descriptor: number,
  maximumEntries: number,
  label: string,
): readonly string[] {
  return boundedDirectoryEntryNames(`/proc/self/fd/${descriptor}`, maximumEntries, label);
}
