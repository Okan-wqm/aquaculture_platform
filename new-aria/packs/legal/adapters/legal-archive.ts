// Legal Case Intelligence pack — archive walk and content hashing.
//
// WHY: L2 (never mutate the corpus) and L3 (never leave the boundary) are
// enforced at the filesystem edge: the walk is read-only, sorted by byte order
// so it is identical on every machine, never follows a symlink, and never
// opens a file under an excluded root. Hashing streams the whole file through
// sha256 while keeping only a bounded head in memory.
//
// WHAT: POSIX path helpers, `walkArchive`, and `hashFile`.
import { createHash } from 'node:crypto';
import { closeSync, lstatSync, openSync, readdirSync, readSync } from 'node:fs';
import { resolve, sep } from 'node:path';

import { byteCompare } from './legal-text';

export function toPosix(path: string): string {
  return path.split(sep).join('/').replace(/\\/g, '/');
}

export function normalizeRelative(path: string): string {
  const cleaned = toPosix(path.trim()).replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  if (cleaned === '' || cleaned === '.') {
    return '';
  }
  return cleaned;
}

// ---------------------------------------------------------------------------
// Filesystem walk + hashing
// ---------------------------------------------------------------------------
export interface WalkedFile {
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly bytes: number;
  readonly mtime: Date;
  readonly excluded: boolean;
  readonly excludedRoot: string | null;
  readonly symlink: boolean;
}

export interface WalkResult {
  readonly files: readonly WalkedFile[];
  readonly directoryErrors: ReadonlyArray<{ readonly relativePath: string; readonly reason: string }>;
  readonly matchedExcludeRoots: ReadonlySet<string>;
}

export function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof (error as { code: unknown }).code === 'string') {
    return (error as { code: string }).code;
  }
  return 'UNKNOWN';
}

function excludedRootFor(relativePath: string, excludeRoots: readonly string[]): string | null {
  for (const root of excludeRoots) {
    if (relativePath === root || relativePath.startsWith(`${root}/`)) {
      return root;
    }
  }
  return null;
}

export function walkArchive(archiveRoot: string, excludeRoots: readonly string[]): WalkResult {
  const files: WalkedFile[] = [];
  const directoryErrors: { relativePath: string; reason: string }[] = [];
  const matched = new Set<string>();
  // Depth-first, entries sorted by byte order — the ONLY ordering that is
  // identical on every machine and locale.
  const walk = (absoluteDir: string, relativeDir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(absoluteDir).sort(byteCompare);
    } catch (error: unknown) {
      directoryErrors.push({ relativePath: relativeDir, reason: `directory_read_failed:${errorCode(error)}` });
      return;
    }
    for (const name of entries) {
      const absolutePath = resolve(absoluteDir, name);
      const relativePath = relativeDir === '' ? name : `${relativeDir}/${name}`;
      const excludedRoot = excludedRootFor(relativePath, excludeRoots);
      if (excludedRoot !== null) matched.add(excludedRoot);
      let info: ReturnType<typeof lstatSync>;
      try {
        info = lstatSync(absolutePath);
      } catch (error: unknown) {
        directoryErrors.push({ relativePath, reason: `stat_failed:${errorCode(error)}` });
        continue;
      }
      if (info.isSymbolicLink()) {
        // Never followed: a link can point outside the archive (L3 boundary).
        files.push({
          relativePath,
          absolutePath,
          bytes: info.size,
          mtime: info.mtime,
          excluded: excludedRoot !== null,
          excludedRoot,
          symlink: true,
        });
        continue;
      }
      if (info.isDirectory()) {
        walk(absolutePath, relativePath);
        continue;
      }
      if (info.isFile()) {
        files.push({
          relativePath,
          absolutePath,
          bytes: info.size,
          mtime: info.mtime,
          excluded: excludedRoot !== null,
          excludedRoot,
          symlink: false,
        });
      }
    }
  };
  walk(archiveRoot, '');
  return { files, directoryErrors, matchedExcludeRoots: matched };
}

export interface HashedRead {
  readonly sha256: string;
  readonly head: Buffer;
  readonly truncated: boolean;
}

/** Streams the whole file through sha256 while keeping only the first `headBytes` bytes in memory. */
export function hashFile(absolutePath: string, headBytes: number): HashedRead {
  const fd = openSync(absolutePath, 'r');
  try {
    const hash = createHash('sha256');
    const chunk = Buffer.allocUnsafe(1 << 20);
    const headParts: Buffer[] = [];
    let kept = 0;
    let truncated = false;
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      const view = chunk.subarray(0, read);
      hash.update(view);
      const take = Math.max(0, Math.min(read, headBytes - kept));
      if (take > 0) {
        headParts.push(Buffer.from(view.subarray(0, take)));
        kept += take;
      }
      if (take < read) truncated = true;
    }
    return { sha256: hash.digest('hex'), head: Buffer.concat(headParts), truncated };
  } finally {
    closeSync(fd);
  }
}

