import { lstatSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { assertCanonicalObjectDirectoryContents } from './git-object-directory-policy';
import type { GitCommandResult } from './git-process';
import { GitProcess } from './git-process';

const FORBIDDEN_CONFIG =
  /^(?:extensions\.partialclone|remote\..*\.(?:promisor|partialclonefilter))$/u;

function exactLine(result: GitCommandResult, label: string): string {
  if (result.status !== 0 || result.stderr.length !== 0) {
    throw new TypeError(`${label} failed closed`);
  }
  const line = result.stdout.endsWith('\n') ? result.stdout.slice(0, -1) : result.stdout;
  if (line.length === 0 || line.includes('\n') || line.includes('\r')) {
    throw new TypeError(`${label} did not return one exact line`);
  }
  return line;
}

function optionalEntry(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new TypeError('Git object database path inspection failed closed');
  }
}

function assertCanonicalDirectory(path: string, label: string, optional = false): void {
  const entry = optionalEntry(path);
  if (entry === undefined && optional) return;
  if (entry === undefined || !entry.isDirectory() || realpathSync(path) !== path) {
    throw new TypeError(`${label} is not a canonical non-symbolic directory`);
  }
}

function assertGitDirectoryBinding(root: string, actual: string, common: string): void {
  const controlPath = join(root, '.git');
  const control = optionalEntry(controlPath);
  if (control === undefined) throw new TypeError('Git directory binding is absent');
  if (actual === common) {
    if (
      !control.isDirectory() ||
      realpathSync(controlPath) !== controlPath ||
      actual !== controlPath
    ) {
      throw new TypeError('Git directory binding is not an in-root canonical directory');
    }
    return;
  }
  const worktreesDirectory = join(common, 'worktrees');
  if (
    !control.isFile() ||
    control.nlink !== 1 ||
    realpathSync(controlPath) !== controlPath ||
    dirname(actual) !== worktreesDirectory
  ) {
    throw new TypeError('Git directory binding is not a canonical linked worktree');
  }
  assertCanonicalDirectory(worktreesDirectory, 'Git linked-worktree directory');
}

function assertNoPartialCloneConfig(root: string, process: GitProcess): void {
  const config = process.run(root, ['config', '--includes', '--name-only', '--get-regexp', '.*']);
  if (config.status === 1 && config.stdout.length === 0 && config.stderr.length === 0) return;
  if (config.status !== 0 || config.stderr.length !== 0 || config.stdout.includes('\r')) {
    throw new TypeError('Git local configuration inspection failed closed');
  }
  const names = config.stdout.split('\n').filter((name) => name.length > 0);
  if (names.some((name) => FORBIDDEN_CONFIG.test(name.toLowerCase()))) {
    throw new TypeError('Git partial-clone or promisor configuration is forbidden');
  }
}

export function assertIsolatedGitObjectDatabase(root: string, process: GitProcess): void {
  const objectFormat = exactLine(
    process.run(root, ['rev-parse', '--show-object-format']),
    'Git object format inspection',
  );
  if (objectFormat !== 'sha1') throw new TypeError('Git object format must be SHA-1');
  const actualGitDirectory = exactLine(
    process.run(root, ['rev-parse', '--absolute-git-dir']),
    'Git actual directory inspection',
  );
  const gitDirectory = exactLine(
    process.run(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
    'Git common directory inspection',
  );
  assertCanonicalDirectory(actualGitDirectory, 'Git actual directory');
  assertCanonicalDirectory(gitDirectory, 'Git common directory');
  assertGitDirectoryBinding(root, actualGitDirectory, gitDirectory);
  assertCanonicalObjectDirectoryContents(join(gitDirectory, 'objects'));
  assertCanonicalDirectory(join(gitDirectory, 'objects/info'), 'Git object info directory', true);
  for (const directory of new Set([actualGitDirectory, gitDirectory])) {
    for (const relative of ['shallow', 'info/grafts']) {
      if (optionalEntry(join(directory, relative)) !== undefined) {
        throw new TypeError(`Git object database metadata ${relative} is forbidden`);
      }
    }
  }
  for (const relative of ['objects/info/alternates', 'objects/info/http-alternates']) {
    if (optionalEntry(join(gitDirectory, relative)) !== undefined) {
      throw new TypeError(`Git object database metadata ${relative} is forbidden`);
    }
  }
  const shallow = exactLine(
    process.run(root, ['rev-parse', '--is-shallow-repository']),
    'Git shallow state inspection',
  );
  if (shallow !== 'false') throw new TypeError('shallow Git repositories are forbidden');
  const replacements = process.run(root, ['for-each-ref', '--format=%(refname)', 'refs/replace']);
  if (
    replacements.status !== 0 ||
    replacements.stderr.length !== 0 ||
    replacements.stdout.length !== 0
  ) {
    throw new TypeError('Git replacement refs are forbidden');
  }
  assertNoPartialCloneConfig(root, process);
}
