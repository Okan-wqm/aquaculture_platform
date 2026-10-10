/**
 * Preserve, don't keep: ARIA's own records in a finished worktree are
 * archived before the worktree is removed.
 *
 * Two user decisions meet here. 2026-10-09: "ARIA'ya özgü yapılar
 * silinmemeli" - ARIA's structures must not be deleted. 2026-10-10: "bitmiş
 * ARIA worktree'leri silinsin" - finished ARIA worktrees should be deleted.
 * The resolution (2026-10-10): a worktree that passes every other rule but
 * holds untracked or ignored files under ARIA artifact paths is removed only
 * after exactly those files are archived, fsynced, and verified by
 * extracting the archive and comparing every entry with the manifest. Any
 * failure keeps the worktree.
 *
 * An archive is written as `<name>.partial` and renamed only once verified,
 * so a file without that suffix is always an archive of record; a failed
 * attempt's `.partial` is deleted. Archives of record are never deleted
 * here; the archive root's retention is manual (runbook). Directories are
 * 0700 and files 0600: aria-tools may hold key material.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export interface ManifestEntry {
  path: string;
  type: 'file' | 'symlink';
  size: number;
  sha256?: string;
  target?: string;
}

export interface ArchivePlan {
  /** Worktree-relative paths as git reported them (directories included whole). */
  entries: string[];
  files: ManifestEntry[];
  bytes: number;
}

export type PlanResult = { ok: true; plan: ArchivePlan } | { ok: false; detail: string };

const CHUNK = 1024 * 1024;

/** sha256 of a file, read in 1 MiB chunks: an ARIA ledger can be large. */
export function sha256File(path: string): string {
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(CHUNK);
  const fd = openSync(path, 'r');
  try {
    for (
      let n = readSync(fd, buffer, 0, CHUNK, null);
      n > 0;
      n = readSync(fd, buffer, 0, CHUNK, null)
    ) {
      hash.update(buffer.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Every file and symlink under the entries, without following a symlink. */
export function planArchive(base: string, entries: string[], hash: boolean): PlanResult {
  const files: ManifestEntry[] = [];
  const stack = entries.map((e) => e.replace(/\/$/, ''));
  for (let rel = stack.pop(); rel !== undefined; rel = stack.pop()) {
    const full = join(base, rel);
    try {
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) {
        files.push({ path: rel, type: 'symlink', size: 0, target: readlinkSync(full) });
      } else if (stat.isDirectory()) {
        for (const name of readdirSync(full)) stack.push(`${rel}/${name}`);
      } else if (stat.isFile()) {
        files.push({
          path: rel,
          type: 'file',
          size: stat.size,
          ...(hash ? { sha256: sha256File(full) } : {}),
        });
      } else {
        return { ok: false, detail: `${rel} is neither a file, a directory nor a symlink` };
      }
    } catch (error) {
      return { ok: false, detail: `${rel}: ${message(error)}` };
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    ok: true,
    plan: { entries, files, bytes: files.reduce((sum, f) => sum + f.size, 0) },
  };
}

/** Why two entry lists differ, or null when every path, type, size, hash and target match. */
export function sameEntries(expected: ManifestEntry[], actual: ManifestEntry[]): string | null {
  if (expected.length !== actual.length) {
    return `found ${actual.length} entries, manifest has ${expected.length}`;
  }
  for (let i = 0; i < expected.length; i += 1) {
    const x = expected[i];
    const y = actual[i];
    if (
      !x ||
      !y ||
      x.path !== y.path ||
      x.type !== y.type ||
      x.size !== y.size ||
      x.sha256 !== y.sha256 ||
      x.target !== y.target
    ) {
      return `entry ${x?.path ?? y?.path} differs from the manifest`;
    }
  }
  return null;
}

/** Bytes available to an unprivileged writer at `path` or its nearest existing ancestor. */
export function freeBytes(path: string): number | null {
  let probe = path;
  while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
  try {
    const stat = statfsSync(probe);
    return stat.bavail * stat.bsize;
  } catch {
    return null;
  }
}

function fsyncPath(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Creates `dir` 0700 if missing (fsyncing its parent), and holds it at 0700. */
function privateDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    fsyncPath(dirname(dir));
  }
  chmodSync(dir, 0o700);
}

function hasZstd(): boolean {
  const r = spawnSync('zstd', ['--version'], { encoding: 'utf8' });
  return r.status === 0 && !r.error;
}

export interface ArchiveRequest {
  root: string;
  worktree: string;
  dirName: string;
  head: string;
  branch: string | null;
  plan: ArchivePlan;
  tarBin: string;
  now: number;
}

export type ArchiveResult =
  | { ok: true; archive: string; manifest: string }
  | { ok: false; detail: string };

/** Writes, verifies, then publishes the archive and its manifest. Never deletes an archive of record. */
export function writeArchive(req: ArchiveRequest): ArchiveResult {
  const day = new Date(req.now).toISOString().slice(0, 10);
  const dir = join(req.root, day);
  const zstd = hasZstd();
  const ext = zstd ? 'tar.zst' : 'tar.gz';
  const flag = zstd ? '--zstd' : '--gzip';
  let archive = '';
  let manifest = '';
  try {
    privateDir(req.root);
    privateDir(dir);
    const stem = `${req.dirName}-${req.head.slice(0, 12)}`;
    for (let n = 1; ; n += 1) {
      const suffix = n === 1 ? '' : `-${n}`;
      archive = join(dir, `${stem}${suffix}.${ext}`);
      manifest = join(dir, `${stem}${suffix}.manifest.json`);
      if (!existsSync(archive) && !existsSync(manifest)) break;
    }
  } catch (error) {
    return { ok: false, detail: `archive dir: ${message(error)}` };
  }
  const partial = `${archive}.partial`;
  const manifestPartial = `${manifest}.partial`;
  const discard = (): void => {
    // A failed attempt is not an archive of record.
    rmSync(partial, { force: true });
    rmSync(manifestPartial, { force: true });
  };
  discard();
  const entries = req.plan.entries.map((e) => e.replace(/\/$/, ''));
  const create = spawnSync(
    req.tarBin,
    [flag, '-C', req.worktree, '-cf', partial, '--', ...entries],
    { encoding: 'utf8' },
  );
  if (create.status !== 0 || create.error) {
    discard();
    const why = (create.stderr ?? create.error?.message ?? '').trim();
    return { ok: false, detail: `tar failed: ${why}` };
  }
  let verifyDir: string | null = null;
  try {
    chmodSync(partial, 0o600);
    fsyncPath(partial);
    // Verified by reading it back, not by trusting tar's exit code.
    verifyDir = mkdtempSync(join(dir, '.verify-'));
    const extract = spawnSync(req.tarBin, [flag, '-xf', partial, '-C', verifyDir], {
      encoding: 'utf8',
    });
    if (extract.status !== 0 || extract.error) {
      discard();
      return { ok: false, detail: `archive unreadable: ${(extract.stderr ?? '').trim()}` };
    }
    const listed = planArchive(verifyDir, entries, true);
    const mismatch = listed.ok
      ? sameEntries(req.plan.files, listed.plan.files)
      : `archive check: ${listed.detail}`;
    if (mismatch) {
      discard();
      return { ok: false, detail: mismatch };
    }
    const body = {
      schema: 'aqua/worktree-gc/archive-manifest/v1',
      created_at: new Date(req.now).toISOString(),
      worktree: req.worktree,
      branch: req.branch,
      head: req.head,
      archive,
      archive_sha256: sha256File(partial),
      compression: zstd ? 'zstd' : 'gzip',
      files: req.plan.files,
    };
    writeFileSync(manifestPartial, `${JSON.stringify(body)}\n`, { mode: 0o600 });
    fsyncPath(manifestPartial);
    renameSync(partial, archive);
    renameSync(manifestPartial, manifest);
    fsyncPath(dir);
    return { ok: true, archive, manifest };
  } catch (error) {
    discard();
    return { ok: false, detail: `archive: ${message(error)}` };
  } finally {
    if (verifyDir !== null) rmSync(verifyDir, { recursive: true, force: true });
  }
}

/** Puts archived files back into a tree (after a removal git refused). Existing files win. */
export function restoreArchive(archive: string, into: string, tarBin: string): boolean {
  const flag = archive.endsWith('.tar.zst') ? '--zstd' : '--gzip';
  const r = spawnSync(tarBin, [flag, '-xf', archive, '-C', into, '--skip-old-files'], {
    encoding: 'utf8',
  });
  return r.status === 0 && !r.error;
}
