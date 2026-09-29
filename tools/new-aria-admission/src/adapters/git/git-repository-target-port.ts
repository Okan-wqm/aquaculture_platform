import { realpathSync, statSync } from 'node:fs';

import type { RepositoryExecutionSnapshot } from '../../application/repository-execution-snapshot';
import type { RepositoryTargetPort } from '../../application/repository-target-verifier';
import { VerifiedExecutableSource } from '../../runtime/verified-executable';

import { parseVerifiedGitCommit, rawBaseIsAncestor } from './git-commit-object';
import { assertIsolatedGitObjectDatabase } from './git-object-database-policy';
import { commitObjectHints, treeObjectHints } from './git-object-hints';
import { GitProcess } from './git-process';
import type { GitCommandResult } from './git-process';
import { readVerifiedGitObjects } from './git-raw-object';
import { snapshotVerifiedGitTree } from './git-tree-object';

export interface GitExecutableIdentity {
  readonly executable_path: string;
  readonly executable_sha256: string;
}

const trustedPorts = new WeakSet<object>();
interface RawAncestryState {
  readonly root: string;
  readonly base: string;
  readonly head: string;
  readonly isAncestor: boolean;
  readonly headTree: string;
}
const rawAncestries = new WeakMap<object, RawAncestryState>();

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

export function assertTrustedGitRepositoryTargetPort(
  port: RepositoryTargetPort,
): asserts port is GitRepositoryTargetPort {
  if (
    !trustedPorts.has(port) ||
    Object.getPrototypeOf(port) !== GitRepositoryTargetPort.prototype
  ) {
    throw new TypeError('repository target port is not trusted Git');
  }
}

export class GitRepositoryTargetPort implements RepositoryTargetPort {
  private readonly process: GitProcess;
  readonly git_tool_id = 'git';
  readonly git_sha256: string;

  constructor(identity: GitExecutableIdentity) {
    this.git_sha256 = identity.executable_sha256;
    this.process = new GitProcess(
      VerifiedExecutableSource.load(
        identity.executable_path,
        identity.executable_sha256,
        'Git executable',
      ),
    );
    trustedPorts.add(this);
    Object.freeze(this);
  }

  canonicalRoot(repositoryRoot: string): string {
    rawAncestries.delete(this);
    const canonicalInput = realpathSync(repositoryRoot);
    if (canonicalInput !== repositoryRoot || !statSync(canonicalInput).isDirectory()) {
      throw new TypeError('canonical repository root mismatch');
    }
    const root = exactLine(
      this.process.run(repositoryRoot, ['rev-parse', '--path-format=absolute', '--show-toplevel']),
      'Git repository root inspection',
    );
    if (realpathSync(root) !== root || root !== canonicalInput) {
      throw new TypeError('canonical repository root mismatch');
    }
    assertIsolatedGitObjectDatabase(root, this.process);
    return root;
  }

  resolveCommit(root: string, ref: string): string {
    return exactLine(
      this.process.run(root, ['show-ref', '--verify', '--hash', ref]),
      'Git ref resolution',
    );
  }

  objectType(root: string, sha: string): string {
    const result = this.process.run(root, ['cat-file', '-t', sha]);
    return result.status === 0 ? exactLine(result, 'Git object inspection') : 'missing';
  }

  isAncestor(root: string, ancestor: string, descendant: string): boolean {
    const hints = commitObjectHints(root, this.process, ancestor, descendant);
    const objects = readVerifiedGitObjects(root, this.process, hints, 72 * 1024 * 1024);
    const closure = rawBaseIsAncestor(objects, ancestor, descendant);
    assertIsolatedGitObjectDatabase(root, this.process);
    rawAncestries.set(this, {
      root,
      base: ancestor,
      head: descendant,
      isAncestor: closure.is_ancestor,
      headTree: closure.head_tree_oid,
    });
    return closure.is_ancestor;
  }

  mergeBase(root: string, left: string, right: string): string {
    const state = rawAncestries.get(this);
    if (state === undefined || state.root !== root || state.base !== left || state.head !== right) {
      throw new TypeError('raw Git ancestry state is absent');
    }
    return state.isAncestor ? left : '';
  }

  captureExecutionSnapshot(root: string, headSha: string): RepositoryExecutionSnapshot {
    const state = rawAncestries.get(this);
    if (state === undefined || state.root !== root || state.head !== headSha || !state.isAncestor) {
      throw new TypeError('raw Git ancestry state is absent for snapshot');
    }
    const headObjects = readVerifiedGitObjects(root, this.process, [headSha], 4 * 1024 * 1024);
    const head = headObjects.get(headSha);
    if (head === undefined) throw new TypeError('raw Git head object is absent');
    const commit = parseVerifiedGitCommit(head);
    if (commit.tree_oid !== state.headTree) {
      throw new TypeError('raw Git head tree identity changed');
    }
    const hints = treeObjectHints(root, this.process, headSha, commit.tree_oid);
    const objects = readVerifiedGitObjects(root, this.process, hints, 272 * 1024 * 1024);
    const snapshot = snapshotVerifiedGitTree(objects, headSha, commit.tree_oid);
    assertIsolatedGitObjectDatabase(root, this.process);
    return snapshot;
  }
}

Object.freeze(GitRepositoryTargetPort.prototype);
Object.freeze(GitRepositoryTargetPort);
