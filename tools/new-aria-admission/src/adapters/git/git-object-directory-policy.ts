import { lstatSync, opendirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

const looseDirectory = /^[a-f0-9]{2}$/u;
const looseObject = /^[a-f0-9]{38}$/u;
const MAX_OBJECT_ROOT_ENTRIES = 258;
const MAX_LOOSE_OBJECTS = 100_000;
const MAX_PACK_ENTRIES = 4_096;
const MAX_INFO_ENTRIES = 4_096;

interface EntryBudget {
  remaining: number;
}

function consumeEntry(budget: EntryBudget, label: string): void {
  budget.remaining -= 1;
  if (budget.remaining < 0) throw new TypeError(`${label} exceeds its entry bound`);
}

function canonicalDirectory(path: string, label: string): void {
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || realpathSync(path) !== path) {
    throw new TypeError(`${label} is not a canonical non-symbolic directory`);
  }
}

function scanRegularFiles(
  directoryPath: string,
  maximumEntries: number,
  label: string,
  validName: (name: string) => boolean,
  sharedBudget?: EntryBudget,
): void {
  canonicalDirectory(directoryPath, label);
  const directory = opendirSync(directoryPath);
  try {
    let count = 0;
    while (true) {
      const entry = directory.readSync();
      if (entry === null) break;
      if (sharedBudget !== undefined) consumeEntry(sharedBudget, label);
      count += 1;
      if (count > maximumEntries) throw new TypeError(`${label} exceeds its entry bound`);
      const metadata = lstatSync(join(directoryPath, entry.name));
      if (!validName(entry.name) || !entry.isFile() || !metadata.isFile() || metadata.nlink !== 1) {
        throw new TypeError(`${label} contains a symbolic, linked, special, or invalid entry`);
      }
    }
  } finally {
    directory.closeSync();
  }
}

function scanInfoDirectory(infoPath: string): void {
  canonicalDirectory(infoPath, 'Git object info directory');
  const directory = opendirSync(infoPath);
  const budget: EntryBudget = { remaining: MAX_INFO_ENTRIES };
  try {
    while (true) {
      const entry = directory.readSync();
      if (entry === null) break;
      consumeEntry(budget, 'Git object info directory');
      const path = join(infoPath, entry.name);
      const metadata = lstatSync(path);
      if (entry.isDirectory() && metadata.isDirectory()) {
        scanRegularFiles(
          path,
          MAX_INFO_ENTRIES,
          'Git object info subdirectory',
          () => true,
          budget,
        );
      } else if (!entry.isFile() || !metadata.isFile() || metadata.nlink !== 1) {
        throw new TypeError('Git object info directory contains a symbolic or special entry');
      }
    }
  } finally {
    directory.closeSync();
  }
}

export function assertCanonicalObjectDirectoryContents(objectDirectory: string): void {
  canonicalDirectory(objectDirectory, 'Git object database');
  const directory = opendirSync(objectDirectory);
  let looseObjects = 0;
  try {
    let rootEntries = 0;
    while (true) {
      const entry = directory.readSync();
      if (entry === null) break;
      rootEntries += 1;
      if (rootEntries > MAX_OBJECT_ROOT_ENTRIES) {
        throw new TypeError('Git object database exceeds its root entry bound');
      }
      const path = join(objectDirectory, entry.name);
      if (entry.name === 'pack') {
        scanRegularFiles(path, MAX_PACK_ENTRIES, 'Git pack directory', (name) => {
          if (name.endsWith('.promisor')) {
            throw new TypeError('Git object database metadata .promisor is forbidden');
          }
          return true;
        });
        continue;
      }
      if (entry.name === 'info') {
        scanInfoDirectory(path);
        continue;
      }
      if (!looseDirectory.test(entry.name)) {
        throw new TypeError('Git object database contains an invalid root entry');
      }
      scanRegularFiles(
        path,
        MAX_LOOSE_OBJECTS - looseObjects,
        'Git loose object directory',
        (name) => {
          if (!looseObject.test(name)) return false;
          looseObjects += 1;
          return looseObjects <= MAX_LOOSE_OBJECTS;
        },
      );
    }
  } finally {
    directory.closeSync();
  }
}
