#!/usr/bin/env node
/** Lightweight local metadata checks. Required hosted-validation owns compilation and suites. */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const [mode, messagePath] = process.argv.slice(2);
function fail(message) {
  process.stderr.write(`local-hook: ${message}\n`);
  process.exit(1);
}
function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}
if (mode === 'commit-msg') {
  if (!messagePath) fail('commit message path is required');
  const message = readFileSync(messagePath, 'utf8');
  const subject = message.split('\n')[0];
  if (/^Co-Authored-By:/im.test(message)) fail('Co-Authored-By trailers are not permitted');
  if (
    !/^(?:Merge |Revert |(?:fix|feat|refactor|security|test|chore)(?:\([^)]+\))?!?: )/.test(subject)
  ) {
    fail('use the repository conventional commit type and subject');
  }
  if (/^(fix|security|refactor\(agentic,phase-|feat)/.test(subject)) {
    const trailers = [...message.matchAll(/^Closes:\s+(\S+?)#([A-Z][A-Z0-9.-]+)\s*$/gm)];
    if (trailers.length === 0)
      fail('this commit requires a Closes: review-path#finding-id trailer');
    for (const [, review, finding] of trailers) {
      if (
        review.includes('..') ||
        !/^(docs\/reviews\/|aria-findings\/|aria-debts\/)/.test(review) ||
        !existsSync(review)
      ) {
        fail(`Closes review does not exist: ${review}`);
      }
      if (review.startsWith('docs/reviews/')) {
        const registry = readFileSync('docs/reviews/_registry/findings.jsonl', 'utf8');
        const registered = registry
          .split('\n')
          .filter(Boolean)
          .some((line) => JSON.parse(line).id === finding);
        if (!registered) fail(`Closes finding is not registered: ${finding}`);
      }
    }
  }
} else if (mode === 'pre-commit') {
  git(['diff', '--cached', '--check']);
  const files = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'])
    .split('\0')
    .filter(Boolean);
  for (const file of files) {
    if (
      /(^|\/)\.env(?:$|\.(?!example$|template$|sample$))/.test(file) ||
      /(?:^|\/)(?:id_rsa|id_ed25519)$/.test(file)
    ) {
      fail(`secret-bearing file must not be committed: ${file}`);
    }
  }
} else if (mode === 'pre-push' || mode === 'post-merge') {
  process.stdout.write(
    'Local metadata checks only; required hosted-validation must pass before merge or deploy.\n',
  );
} else {
  fail('expected pre-commit, commit-msg, pre-push or post-merge');
}
