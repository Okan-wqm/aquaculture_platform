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
 * failure keeps the worktree. This module never deletes an archive; the
 * archive root's retention is manual (runbook).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

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

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
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
          ...(hash ? { sha256: sha256(full) } : {}),
        });
      } else {
        return { ok: false, detail: `${rel} is neither a file, a directory nor a symlink` };
      }
    } catch (error) {
      return {
        ok: false,
        detail: `${rel}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    ok: true,
    plan: { entries, files, bytes: files.reduce((sum, f) => sum + f.size, 0) },
  };
}

function fsyncPath(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
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

function sameEntries(a: ManifestEntry[], b: ManifestEntry[]): string | null {
  if (a.length !== b.length) return `archive holds ${b.length} entries, manifest ${a.length}`;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
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

/** Writes, fsyncs and verifies the archive and its manifest. Never deletes an archive. */
export function writeArchive(req: ArchiveRequest): ArchiveResult {
  const day = new Date(req.now).toISOString().slice(0, 10);
  const dir = join(req.root, day);
  const zstd = hasZstd();
  const ext = zstd ? 'tar.zst' : 'tar.gz';
  const flag = zstd ? '--zstd' : '--gzip';
  let archive = '';
  let manifest = '';
  try {
    mkdirSync(dir, { recursive: true });
    const stem = `${req.dirName}-${req.head.slice(0, 12)}`;
    for (let n = 1; ; n += 1) {
      const suffix = n === 1 ? '' : `-${n}`;
      archive = join(dir, `${stem}${suffix}.${ext}`);
      manifest = join(dir, `${stem}${suffix}.manifest.json`);
      if (!existsSync(archive) && !existsSync(manifest)) break;
    }
  } catch (error) {
    return {
      ok: false,
      detail: `archive dir: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const entries = req.plan.entries.map((e) => e.replace(/\/$/, ''));
  const create = spawnSync(
    req.tarBin,
    [flag, '-C', req.worktree, '-cf', archive, '--', ...entries],
    {
      encoding: 'utf8',
    },
  );
  if (create.status !== 0 || create.error) {
    return {
      ok: false,
      detail: `tar failed: ${(create.stderr ?? create.error?.message ?? '').trim()}`,
    };
  }
  let verifyDir: string | null = null;
  try {
    fsyncPath(archive);
    const body = {
      schema: 'aqua/worktree-gc/archive-manifest/v1',
      created_at: new Date(req.now).toISOString(),
      worktree: req.worktree,
      branch: req.branch,
      head: req.head,
      archive,
      compression: zstd ? 'zstd' : 'gzip',
      files: req.plan.files,
    };
    writeFileSync(manifest, `${JSON.stringify(body)}\n`, { mode: 0o600 });
    fsyncPath(manifest);
    fsyncPath(dir);
    // Verified by reading it back, not by trusting tar's exit code.
    verifyDir = mkdtempSync(join(dir, '.verify-'));
    const extract = spawnSync(req.tarBin, [flag, '-xf', archive, '-C', verifyDir], {
      encoding: 'utf8',
    });
    if (extract.status !== 0 || extract.error) {
      return { ok: false, detail: `archive unreadable: ${(extract.stderr ?? '').trim()}` };
    }
    const listed = planArchive(verifyDir, entries, true);
    if (!listed.ok) return { ok: false, detail: `archive check: ${listed.detail}` };
    const mismatch = sameEntries(req.plan.files, listed.plan.files);
    if (mismatch) return { ok: false, detail: mismatch };
    return { ok: true, archive, manifest };
  } catch (error) {
    return {
      ok: false,
      detail: `archive: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    // Only the verification copy goes; the archive itself is never deleted here.
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
