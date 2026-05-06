import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

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

export function resolveInsideWorkspace(workspaceRoot: string, requestedPath: string): string {
  const root = resolve(workspaceRoot);
  const resolved = resolve(root, requestedPath);
  const relativePath = relative(root, resolved);
  if (relativePath.startsWith('..') || relativePath === '..' || relativePath.includes(`..${sep}`)) {
    throw new Error(`path escapes workspace root: ${requestedPath}`);
  }
  return resolved;
}

export function collectFiles(
  root: string,
  options: {
    readonly extensions: readonly string[];
    readonly includeFile?: (name: string, path: string) => boolean;
    readonly includeExcludedDir?: (name: string) => boolean;
  },
): readonly string[] {
  const files: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) {
        if (ADAPTER_EXCLUDED_DIRS.has(entry.name) && options.includeExcludedDir?.(entry.name) !== true) {
          continue;
        }
        stack.push(path);
      } else if (
        entry.isFile() &&
        options.extensions.some((extension) => entry.name.endsWith(extension)) &&
        (options.includeFile?.(entry.name, path) ?? true)
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

export function pathAllowedBySnapshot(workspaceRoot: string, requestedPath: string, input: SnapshotInput): boolean {
  const allowed = snapshotAllowedPathSet(input);
  if (!allowed) {
    return true;
  }
  return allowed.has(normalizeWorkspacePath(relative(workspaceRoot, resolveInsideWorkspace(workspaceRoot, requestedPath))));
}

function snapshotAllowedPathSet(input: SnapshotInput): ReadonlySet<string> | undefined {
  const paths = input.repo_snapshot?.allowed_paths;
  if (!Array.isArray(paths)) {
    return undefined;
  }
  return new Set(paths.map((path) => normalizeWorkspacePath(String(path))));
}

export function readWorkspaceFile(path: string): string {
  return readFileSync(path, 'utf8');
}

export function readWorkspaceJson(path: string): unknown {
  return JSON.parse(readWorkspaceFile(path)) as unknown;
}

export function workspacePathExists(path: string): boolean {
  return existsSync(path);
}

export function normalizeWorkspacePath(path: string): string {
  return path.split(sep).join('/');
}
