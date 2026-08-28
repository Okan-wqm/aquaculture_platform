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

// E13 spot-audit FP class (2) — dead-corpus exclusion (single shared predicate).
// WHY: adapters emitted findings against files that are no longer live code.
// The repo's observed convention is timestamped `.archive/` snapshot folders
// kept inside each service's migrations directory (e.g.
// `apps/farm-service/src/database/migrations/.archive/2026-05-18T09-42-08-277Z/…`);
// the dotted/undotted `archive(d)` directory names and the `*.archived.*`
// filename infix are the sibling spellings of the same convention. A retired
// migration cannot need a test and an archived class cannot need registry or
// schema discipline, so flagging the archive corpus is pure false-positive
// noise. Every adapter that walks source trees imports THIS predicate instead
// of growing its own copy, so the convention has exactly one definition.
const ARCHIVED_DIR_SEGMENTS = new Set(['.archive', '.archived', 'archive', 'archived']);

export function isArchivedWorkspacePath(path: string): boolean {
  const segments = normalizeWorkspacePath(path).split('/');
  const fileName = segments[segments.length - 1] ?? '';
  return (
    segments.some((segment) => ARCHIVED_DIR_SEGMENTS.has(segment)) ||
    fileName.includes('.archived.')
  );
}

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
