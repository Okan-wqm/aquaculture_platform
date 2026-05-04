import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

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
