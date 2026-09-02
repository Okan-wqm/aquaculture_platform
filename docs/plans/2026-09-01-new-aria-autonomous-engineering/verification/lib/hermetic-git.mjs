import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
export const gitEnvironmentPolicy = 'new-aria-hermetic-git-v1';
const digestPattern = /^[a-f0-9]{64}$/u;
const sessionBrand = Symbol('verified-git-session');
const immutableTools = new Map();
const fixedArguments = [
  '--no-pager',
  '--no-replace-objects',
  '-c',
  'core.quotePath=false',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.untrackedCache=false',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'diff.external=',
];
const cleanEnvironment = Object.freeze({
  LANG: 'C',
  LC_ALL: 'C',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_NO_REPLACE_OBJECTS: '1',
});

function digestFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function immutableExecutable(source, digest) {
  if (immutableTools.has(digest)) return immutableTools.get(digest).path;
  const root = mkdtempSync(join(tmpdir(), 'new-aria-git-tool-'));
  const path = join(root, 'git');
  try {
    copyFileSync(source, path, constants.COPYFILE_EXCL);
    chmodSync(path, 0o500);
    if (digestFile(path) !== digest) throw new Error('private Git snapshot digest mismatch');
    chmodSync(root, 0o500);
    immutableTools.set(digest, { path, root });
    return path;
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

process.once('exit', () => {
  for (const { root } of immutableTools.values()) {
    chmodSync(root, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});
function searchDirectories() {
  const entries = (process.env.PATH ?? '').split(':');
  if (entries.length === 0 || entries.some((entry) => !isAbsolute(entry))) {
    throw new Error('PATH must contain only absolute, non-empty directories');
  }
  return entries;
}
function candidateIn(directory, logicalName) {
  const candidate = join(directory, logicalName);
  try {
    accessSync(candidate, constants.X_OK);
    const executablePath = realpathSync(candidate);
    if (!lstatSync(executablePath).isFile()) throw new Error('Git executable is not a file');
    return executablePath;
  } catch (error) {
    if (new Set(['ENOENT', 'EACCES', 'ENOTDIR']).has(error?.code)) return null;
    throw error;
  }
}
function executableCandidate(logicalName) {
  if (logicalName !== 'git') throw new Error('Git logical name must be git');
  const entries = searchDirectories();
  for (const directory of entries) {
    const candidate = candidateIn(directory, logicalName);
    if (candidate) return candidate;
  }
  throw new Error('Git executable not found');
}

function invoke(executablePath, cwd, args, options = {}) {
  const { encoding = 'utf8', maxBuffer = 16 * 1024 * 1024, input } = options;
  const result = spawnSync(executablePath, args, {
    cwd,
    encoding,
    env: cleanEnvironment,
    input,
    maxBuffer,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = encoding === 'utf8' ? result.stderr.trim() : 'binary command failed';
    throw new Error(`git ${args.at(-1)} failed${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout;
}

function validFacts(tool) {
  if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return false;
  const keys = ['environment_policy', 'executable_sha256', 'logical_name', 'version'];
  return [
    JSON.stringify(Object.keys(tool).sort()) === JSON.stringify(keys),
    tool.logical_name === 'git',
    tool.environment_policy === gitEnvironmentPolicy,
    typeof tool.version === 'string',
    /^git version \d+\.\d+(?:\.\d+)?(?:[.-][0-9A-Za-z.]+)?$/u.test(tool.version ?? ''),
    digestPattern.test(tool.executable_sha256 ?? ''),
  ].every(Boolean);
}

function assertFacts(tool) {
  if (!validFacts(tool)) throw new Error('Git tool facts are invalid');
}

export function resolveGitTool(tool) {
  assertFacts(tool);
  const executablePath = executableCandidate(tool.logical_name);
  if (digestFile(executablePath) !== tool.executable_sha256) {
    throw new Error('Git executable digest mismatch');
  }
  const version = invoke(executablePath, undefined, ['--version']).trim();
  if (version !== tool.version) throw new Error('Git executable version mismatch');
  return { ...tool, executablePath };
}

export function observeGitTool() {
  const executablePath = executableCandidate('git');
  return {
    logical_name: 'git',
    version: invoke(executablePath, undefined, ['--version']).trim(),
    executable_sha256: digestFile(executablePath),
    environment_policy: gitEnvironmentPolicy,
  };
}

function validArguments(args) {
  return Array.isArray(args) && args.length > 0 && args.every((arg) => typeof arg === 'string');
}

export function createGitSession(tool) {
  const resolved = resolveGitTool(tool);
  const executablePath = immutableExecutable(resolved.executablePath, tool.executable_sha256);
  const version = invoke(executablePath, undefined, ['--version']).trim();
  if (version !== tool.version) throw new Error('private Git snapshot version mismatch');
  const facts = Object.freeze({ ...tool });
  return Object.freeze({
    [sessionBrand]: true,
    tool: facts,
    run(repositoryRoot, args, options = {}) {
      if (!validArguments(args)) throw new Error('Git arguments must be a non-empty string array');
      const worktree = realpathSync(repositoryRoot);
      return invoke(
        executablePath,
        worktree,
        [
          `--git-dir=${join(worktree, '.git')}`,
          `--work-tree=${worktree}`,
          ...fixedArguments,
          '-c',
          'core.bare=false',
          ...args,
        ],
        options,
      );
    },
  });
}

function sessionFor(tool) {
  return tool?.[sessionBrand] === true ? tool : createGitSession(tool);
}

export function runGit(repositoryRoot, args, tool, options = {}) {
  return sessionFor(tool).run(repositoryRoot, args, options);
}
