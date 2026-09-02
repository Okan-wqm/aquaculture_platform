#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface Arguments {
  readonly developmentRef: string;
  readonly eventName: string;
  readonly headSha: string;
  readonly prBaseSha: string;
  readonly ref: string;
  readonly repo: string;
}

export interface AffectedRange {
  readonly baseSha: string;
  readonly headSha: string;
  readonly fullValidation: boolean;
  readonly reason: string;
}

const SHA_PATTERN = /^[0-9a-f]{40}$/u;

/**
 * The full-validation fallback base: the repository's oldest root commit.
 *
 * "Validate everything" must still name a base every consumer can diff
 * against — `nx affected --base`, `git diff base...head`, the changed-file
 * guards. The empty-tree SHA this replaces is a real git object but NOT a
 * commit: the first main push after the lane landed resolved its baseline
 * to it and every CI job died with `object … is a tree, not a commit`,
 * leaving main red until a deployment tag existed — a tag only a green
 * pipeline could create. Root..head spans the whole history, which IS the
 * everything-affected intent, and it is always a valid commit.
 */
function repositoryRootCommit(repo: string, headSha: string): string {
  const roots = git(repo, ['rev-list', '--max-parents=0', headSha]).split('\n');
  const oldest = roots.filter(Boolean).at(-1);
  if (!oldest) {
    throw new Error(`unable to resolve a root commit for ${headSha}`);
  }
  return oldest;
}

function argumentValue(argv: readonly string[], name: string): string {
  const index = argv.indexOf(name);
  if (index < 0 || index + 1 >= argv.length) return '';
  return argv[index + 1] ?? '';
}

function parseArguments(argv: readonly string[]): Arguments {
  return {
    developmentRef: argumentValue(argv, '--development-ref') || 'deployed/development',
    eventName: argumentValue(argv, '--event-name'),
    headSha: argumentValue(argv, '--head-sha'),
    prBaseSha: argumentValue(argv, '--pr-base-sha'),
    ref: argumentValue(argv, '--ref'),
    repo: resolve(argumentValue(argv, '--repo') || process.cwd()),
  };
}

function git(repo: string, args: readonly string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

function requireCommit(repo: string, sha: string, field: string): void {
  if (!SHA_PATTERN.test(sha)) {
    throw new Error(`${field} must be a 40-character lowercase commit SHA`);
  }
  git(repo, ['cat-file', '-e', `${sha}^{commit}`]);
}

function isAncestor(repo: string, baseSha: string, headSha: string): boolean {
  try {
    git(repo, ['merge-base', '--is-ancestor', baseSha, headSha]);
    return true;
  } catch {
    return false;
  }
}

function tryResolveCommit(repo: string, ref: string): string | undefined {
  try {
    return git(repo, ['rev-parse', '--verify', `${ref}^{commit}`]);
  } catch {
    return undefined;
  }
}

function refExists(repo: string, ref: string): boolean {
  try {
    git(repo, ['rev-parse', '--verify', ref]);
    return true;
  } catch {
    return false;
  }
}

export function resolveAffectedRange(args: Arguments): AffectedRange {
  requireCommit(args.repo, args.headSha, 'head SHA');

  if (args.eventName === 'pull_request') {
    requireCommit(args.repo, args.prBaseSha, 'pull request base SHA');
    if (!isAncestor(args.repo, args.prBaseSha, args.headSha)) {
      throw new Error('pull request base SHA is not an ancestor of the requested head SHA');
    }

    return {
      baseSha: args.prBaseSha,
      headSha: args.headSha,
      fullValidation: false,
      reason: 'pull-request-base',
    };
  }

  if (args.eventName === 'push' && args.ref === 'refs/heads/main') {
    const baseSha = tryResolveCommit(args.repo, args.developmentRef);
    if (!baseSha) {
      return {
        baseSha: repositoryRootCommit(args.repo, args.headSha),
        headSha: args.headSha,
        fullValidation: true,
        reason: refExists(args.repo, args.developmentRef)
          ? 'development-baseline-invalid'
          : 'development-baseline-missing',
      };
    }
    requireCommit(args.repo, baseSha, 'development baseline SHA');
    if (!isAncestor(args.repo, baseSha, args.headSha)) {
      return {
        baseSha: repositoryRootCommit(args.repo, args.headSha),
        headSha: args.headSha,
        fullValidation: true,
        reason: 'development-baseline-not-ancestor',
      };
    }
    return {
      baseSha,
      headSha: args.headSha,
      fullValidation: false,
      reason: 'development-deploy-baseline',
    };
  }

  throw new Error(`unsupported event/ref: ${args.eventName || '(empty)'}/${args.ref || '(empty)'}`);
}

function writeGithubOutputs(range: AffectedRange): void {
  const outputPath = process.env['GITHUB_OUTPUT'];
  if (!outputPath) return;
  appendFileSync(
    outputPath,
    [
      `base_sha=${range.baseSha}`,
      `head_sha=${range.headSha}`,
      `full_validation=${String(range.fullValidation)}`,
      `range_reason=${range.reason}`,
      '',
    ].join('\n'),
  );
}

function main(argv: readonly string[]): number {
  try {
    const range = resolveAffectedRange(parseArguments(argv));
    writeGithubOutputs(range);
    process.stdout.write(`${JSON.stringify(range)}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`resolve-affected-range: ${message}\n`);
    return 2;
  }
}

process.exitCode = main(process.argv.slice(2));
