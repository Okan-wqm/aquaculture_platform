import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { join, posix, relative, resolve, sep } from 'node:path';

export interface RepoSnapshot {
  readonly snapshot_mode?: string;
  readonly repo_state_id?: string;
  readonly snapshot_hash?: string;
  readonly allowed_paths?: readonly string[];
}

export interface SnapshotInput {
  readonly repo_snapshot?: RepoSnapshot;
}

export const ADAPTER_EXCLUDED_DIRS = new Set([
  '.aria-poc',
  '.claude',
  '.git',
  'agent-workspace',
  'aria-tools',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'tmp',
]);

// E13 spot-audit FP class (2) — dead-corpus exclusion (single shared predicate).
// WHY: adapters emitted findings against files that are no longer live code.
// The repo's observed convention is timestamped `.archive/` snapshot folders
// kept inside each service's migrations directory (e.g.
// `apps/farm-service/src/database/migrations/.archive/2026-05-18T09-42-08-277Z/…`);
// the dotted/undotted/underscored `archive(d)` directory names (`docs/plans/
// _archive/`) and the `*.archived.*` filename infix are the sibling spellings
// of the same convention. A retired
// migration cannot need a test and an archived class cannot need registry or
// schema discipline, so flagging the archive corpus is pure false-positive
// noise. Every adapter that walks source trees imports THIS predicate instead
// of growing its own copy, so the convention has exactly one definition.
const ARCHIVED_DIR_SEGMENTS = new Set([
  '.archive',
  '.archived',
  '_archive',
  '_archived',
  'archive',
  'archived',
]);

export function isArchivedWorkspacePath(path: string): boolean {
  const segments = normalizeWorkspacePath(path).split('/');
  const fileName = segments[segments.length - 1] ?? '';
  return (
    segments.some((segment) => ARCHIVED_DIR_SEGMENTS.has(segment)) ||
    fileName.includes('.archived.')
  );
}

/**
 * The one containment rule for a workspace-relative path: POSIX, relative,
 * already normalised (no `.`, `..` or empty segment, no trailing `/`), not
 * leading out of the workspace, and free of NUL, which node's fs rejects by
 * throwing. It is lexical, so a path that fails it never reaches the
 * filesystem, and a non-normalised spelling such as `c/../../x.rs` fails
 * instead of being resolved: no caller can alias its way out. Every adapter
 * check of "is this inside the workspace" goes through this predicate.
 */
export function isWorkspaceRelativePath(path: string): boolean {
  return (
    path !== '' &&
    path !== '.' &&
    path !== '..' &&
    !path.includes('\0') &&
    !posix.isAbsolute(path) &&
    !path.startsWith('../') &&
    !path.endsWith('/') &&
    posix.normalize(path) === path
  );
}

/**
 * The absolute path `requestedPath` spells under `workspaceRoot`, refused when
 * the spelling leads out of it (`isWorkspaceRelativePath`). It names a path;
 * it does not touch the filesystem, so it can name one that does not exist
 * yet. What is AT the path is asked only through the contained accessors
 * (`readWorkspaceFile`, `workspacePathExists`, `collectFiles`, all through
 * `containedWorkspace`), which refuse a path with a symlink on any component:
 * a symlink spelled inside the workspace can point anywhere (ARIA-LOW-543).
 */
export function resolveInsideWorkspace(workspaceRoot: string, requestedPath: string): string {
  const root = resolve(workspaceRoot);
  const resolved = resolve(root, requestedPath);
  const relativePath = normalizeWorkspacePath(relative(root, resolved));
  // `relative` already normalises; '' is the workspace root itself.
  if (relativePath !== '' && !isWorkspaceRelativePath(relativePath)) {
    throw new Error(`path escapes workspace root: ${requestedPath}`);
  }
  return resolved;
}

/**
 * What the entry at `path` IS, asked of the path itself with lstat (no
 * symlink followed), never of the directory listing that names it.
 *
 * The two answers differ inside the adapter room (`aria_kernel/adapter_room.py`):
 * the room shows only what git tracks, and covers an untracked file beneath a
 * tracked directory with a read-only bind of `/dev/null`. The parent's
 * listing still names the entry with its on-disk type, "regular file"; the
 * path itself is the character device the cover put there, which the room's
 * mount refuses to open (EACCES). A walker that trusted the listing returned
 * the covered entry and its adapter died opening it (ARIA-LOW-542:
 * kernel-dead-wire-adapter exited 1 in the room with an untracked
 * `aria_kernel/digest.py` in the checkout, 0 outside it). `collectFiles` and
 * `containedWorkspace` both classify through this one function, so the walk
 * lists exactly the files the reader will open; outside the room nothing is
 * covered and both see every file.
 */
type EntryKind = 'absent' | 'symlink' | 'file' | 'directory' | 'special';

function entryKindAt(path: string): EntryKind {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat === undefined) return 'absent';
  if (stat.isSymbolicLink()) return 'symlink';
  if (stat.isFile()) return 'file';
  if (stat.isDirectory()) return 'directory';
  return 'special';
}

/**
 * What a workspace-relative path names, looked up without following any
 * symlink: `refused` when the path fails `isWorkspaceRelativePath` or any of
 * its components (the entry included) is a symlink, so nothing behind a
 * symlink is ever examined and the answer says nothing about files outside the
 * workspace; `absent` when no entry is there; `file` for a regular file;
 * `directory` for a directory; `other` for a special file (in the adapter
 * room, the `/dev/null` cover over an untracked file, which the room does not
 * show: see `entryKindAt`).
 */
export type WorkspaceEntry = 'absent' | 'file' | 'directory' | 'other' | 'refused';

export interface ContainedWorkspace {
  /** The workspace root's own realpath: the base every relative path spells under. */
  readonly root: string;
  readonly entry: (path: string) => WorkspaceEntry;
  /** The UTF-8 text of a `file` entry; any other entry is refused with an error. */
  readonly readFile: (path: string) => string;
}

/**
 * Filesystem access confined to a workspace: one resolver owns containment
 * (`isWorkspaceRelativePath`, then a component walk under the root's realpath
 * that refuses every symlink), so a caller cannot escape by passing an
 * unchecked path. `collectFiles` classifies each entry with the same
 * `entryKindAt`, so the walk and this reader agree on what the workspace
 * holds. The final open uses O_NOFOLLOW, so a file swapped for a symlink
 * after the check is refused too.
 */
export function containedWorkspace(workspaceRoot: string): ContainedWorkspace {
  const root = realpathSync(workspaceRoot);
  const entry = (path: string): WorkspaceEntry => {
    if (!isWorkspaceRelativePath(path)) return 'refused';
    const segments = path.split('/');
    let current = root;
    for (const [index, segment] of segments.entries()) {
      current = join(current, segment);
      const kind = entryKindAt(current);
      if (kind === 'absent') return 'absent';
      if (kind === 'symlink') return 'refused';
      if (index === segments.length - 1) {
        return kind === 'file' || kind === 'directory' ? kind : 'other';
      }
      if (kind !== 'directory') return 'absent';
    }
    return 'directory';
  };
  return {
    root,
    entry,
    readFile: (path) => {
      if (entry(path) !== 'file') throw new Error(`refused workspace read: ${path}`);
      const descriptor = openSync(join(root, path), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (!fstatSync(descriptor).isFile()) throw new Error(`refused workspace read: ${path}`);
        return readFileSync(descriptor, 'utf8');
      } finally {
        closeSync(descriptor);
      }
    },
  };
}

/**
 * Every file under `root` (an absolute path inside `workspaceRoot`) whose
 * name ends with one of `options.extensions`. The walk never follows a
 * symlink, its root included: a root reached through a symlink on any
 * component (`containedWorkspace`) walks nothing, exactly as a symlinked
 * directory met inside the walk is skipped (ARIA-LOW-543).
 */
export function collectFiles(
  workspaceRoot: string,
  root: string,
  options: {
    readonly extensions: readonly string[];
    readonly includeFile?: (name: string, path: string) => boolean;
    readonly includeExcludedDir?: (name: string) => boolean;
    /**
     * A directory the walk must not enter, decided from its name, the
     * directory holding it, and the workspace root. Language conventions
     * that depend on a sibling file (cargo's default build dir is `target/`
     * beside a `Cargo.toml`) cannot be a name in ADAPTER_EXCLUDED_DIRS: a
     * `target/` without that manifest is ordinary source. The root is passed
     * so the convention asks its sibling question through containment
     * (rust-cargo's `cargoTargetDirSkip`), never by a direct fs probe.
     * Absent for every adapter that has no such convention, so their walk is
     * unchanged.
     */
    readonly skipDir?: (name: string, parentPath: string, workspaceRoot: string) => boolean;
  },
): readonly string[] {
  const rootPath = workspaceRelative(workspaceRoot, root);
  if (rootPath !== '' && containedWorkspace(workspaceRoot).entry(rootPath) === 'refused') {
    return [];
  }
  const files: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    // The listing supplies names only; what each name IS comes from
    // `entryKindAt` (see there: in the adapter room the listing's type of a
    // covered untracked file is not what the path holds). A symlink, a
    // special file and an entry gone since the listing are not walked.
    for (const name of readdirSync(current)) {
      const path = resolve(current, name);
      const kind = entryKindAt(path);
      if (kind === 'directory') {
        if (ADAPTER_EXCLUDED_DIRS.has(name) && options.includeExcludedDir?.(name) !== true) {
          continue;
        }
        if (options.skipDir !== undefined && options.skipDir(name, current, workspaceRoot)) {
          continue;
        }
        stack.push(path);
      } else if (
        kind === 'file' &&
        options.extensions.some((extension) => name.endsWith(extension)) &&
        (options.includeFile?.(name, path) ?? true)
      ) {
        files.push(path);
      }
    }
  }
  return files.sort();
}

export function filterFilesBySnapshot(
  files: readonly string[],
  workspaceRoot: string,
  input: SnapshotInput,
): readonly string[] {
  const allowed = snapshotAllowedPathSet(input);
  if (!allowed) {
    return files;
  }
  return files.filter((file) => allowed.has(normalizeWorkspacePath(relative(workspaceRoot, file))));
}

export function pathAllowedBySnapshot(
  workspaceRoot: string,
  requestedPath: string,
  input: SnapshotInput,
): boolean {
  const allowed = snapshotAllowedPathSet(input);
  if (!allowed) {
    return true;
  }
  return allowed.has(
    normalizeWorkspacePath(
      relative(workspaceRoot, resolveInsideWorkspace(workspaceRoot, requestedPath)),
    ),
  );
}

function snapshotAllowedPathSet(input: SnapshotInput): ReadonlySet<string> | undefined {
  const paths = input.repo_snapshot?.allowed_paths;
  if (!Array.isArray(paths)) {
    return undefined;
  }
  return new Set(paths.map((path) => normalizeWorkspacePath(String(path))));
}

/**
 * `path` (absolute, or relative to `workspaceRoot`) as a workspace-relative
 * path: '' for the workspace root itself. A path outside the workspace comes
 * back as `../…`, which `containedWorkspace` refuses.
 */
function workspaceRelative(workspaceRoot: string, path: string): string {
  const root = resolve(workspaceRoot);
  return normalizeWorkspacePath(relative(root, resolve(root, path)));
}

/**
 * The UTF-8 text of the workspace file at `path`, read through
 * `containedWorkspace`: a path with a symlink on any component, a directory,
 * a special file or a path outside the workspace is refused with an error.
 * It was `readFileSync`, which followed every symlink, so a path an adapter
 * named explicitly (kernel-dead-wire's policyDir and cliPath, typeorm's
 * MODULE_SCHEMA_PATH) was read from wherever a symlink there pointed
 * (ARIA-LOW-543).
 */
export function readWorkspaceFile(workspaceRoot: string, path: string): string {
  return containedWorkspace(workspaceRoot).readFile(workspaceRelative(workspaceRoot, path));
}

export function readWorkspaceJson(workspaceRoot: string, path: string): unknown {
  return JSON.parse(readWorkspaceFile(workspaceRoot, path)) as unknown;
}

/**
 * Whether `path` names workspace content: the workspace root, or a regular
 * file or directory reached from it without crossing a symlink
 * (`containedWorkspace`). A path through a symlink is not workspace content,
 * as `collectFiles` skips one; neither is a special file (the adapter room's
 * cover over an untracked file). It was `existsSync`, which followed
 * symlinks (ARIA-LOW-543).
 */
export function workspacePathExists(workspaceRoot: string, path: string): boolean {
  const relativePath = workspaceRelative(workspaceRoot, path);
  if (relativePath === '') return true;
  const entry = containedWorkspace(workspaceRoot).entry(relativePath);
  return entry === 'file' || entry === 'directory';
}

/**
 * Whether the entry at `path` is a regular file with an execute bit set,
 * asked with lstat of the path itself, never through a symlink: a symlink is
 * not walked workspace content, so it is not executable content either
 * (ARIA-LOW-593 — the two lstatSync calls this replaces lived outside the
 * containment owner). The mode is read in one lstat of the final entry; the
 * component walk already happened when `collectFiles` classified the path
 * the callers pass.
 */
export function workspaceIsExecutable(workspaceRoot: string, path: string): boolean {
  const relativePath = workspaceRelative(workspaceRoot, path);
  if (relativePath === '' || !isWorkspaceRelativePath(relativePath)) return false;
  const stat = lstatSync(join(realpathSync(workspaceRoot), relativePath), {
    throwIfNoEntry: false,
  });
  return stat !== undefined && stat.isFile() && (stat.mode & 0o111) !== 0;
}

/**
 * The byte size of the regular file at `path` (absolute, or relative to
 * `workspaceRoot`): the owner's answer to "how big is it", as
 * `readWorkspaceFile` answers "what does it say". The path is reached through
 * `containedWorkspace`, so a symlink on any component, a directory, a special
 * file, an absent entry, the workspace root itself and a path outside the
 * workspace are refused with an error; the size is one lstat of the final
 * entry, never through a symlink, and an entry swapped for a non-file after
 * the component walk is refused too. A per-file byte cap asks this before it
 * reads (the Rust runtime adapter, ARIA-HIGH-010), so no adapter measures a
 * file on a second fs path (eslint overrides 2b/2c, ARIA-LOW-593).
 */
export function workspaceFileBytes(workspaceRoot: string, path: string): number {
  const workspace = containedWorkspace(workspaceRoot);
  const relativePath = workspaceRelative(workspaceRoot, path);
  if (workspace.entry(relativePath) !== 'file') {
    throw new Error(`refused workspace size: ${path}`);
  }
  const stat = lstatSync(join(workspace.root, relativePath));
  if (!stat.isFile()) throw new Error(`refused workspace size: ${path}`);
  return stat.size;
}

export function normalizeWorkspacePath(path: string): string {
  return path.split(sep).join('/');
}

/**
 * The scan surface of an adapter lives in ONE place: its manifest
 * (`tools/aria-adapters/<tool_id>.tool.json`, `default_input.roots`), which
 * `cycle.py` reads and passes at runtime. Adapters used to carry a second copy
 * as a `DEFAULT_ROOTS` fallback. That fallback never fired in production — and
 * that was the danger, not the comfort: it governed tests and standalone runs,
 * so a manifest edit could leave the fixtures validating a file set production
 * never scans, with every test still green.
 *
 * The copies agreed on the day this was written. Nothing made them agree.
 */
export function requireScanRoots(
  toolId: string,
  roots: readonly string[] | undefined,
): readonly string[] {
  if (roots && roots.length > 0) return roots;
  throw new Error(
    `${toolId}: roots is required and was not supplied. The scan surface is ` +
      `declared once, in tools/aria-adapters/${toolId}.tool.json ` +
      `(default_input.roots); the cycle passes it at runtime. Callers outside ` +
      `the cycle (tests, local runs) must pass the same roots explicitly ` +
      `rather than inherit a second copy that can drift from production.`,
  );
}
