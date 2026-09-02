import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const planRoot = fileURLToPath(new URL('..', import.meta.url));
export const repositoryRoot = fileURLToPath(new URL('../../../..', import.meta.url));

export function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

export function targetArguments() {
  const target = {
    baseSha: argument('--base'),
    headSha: argument('--head'),
    reviewedRef: argument('--reviewed-ref'),
    baseTree: argument('--base-tree'),
    headTree: argument('--head-tree'),
    diffSha256: argument('--diff-sha256'),
    designSha256: argument('--design-sha256'),
    formatScopeSha256: argument('--format-scope-sha256'),
  };
  assert(
    Object.values(target).every((value) => typeof value === 'string'),
    'exact --base/--head/--reviewed-ref/tree/diff/design/format target arguments are required',
  );
  return target;
}

function copyExternalInputs(ownerRoot) {
  const design = 'docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md';
  const formatScope = 'tools/quality/format-scope.json';
  for (const path of [design, formatScope]) {
    mkdirSync(join(ownerRoot, path, '..'), { recursive: true });
    cpSync(join(repositoryRoot, path), join(ownerRoot, path));
  }
}

export function withPlanCopy(prefix, run) {
  const ownerRoot = mkdtempSync(join(tmpdir(), prefix));
  const copy = join(ownerRoot, 'docs/plans/2026-09-01-new-aria-autonomous-engineering');
  try {
    mkdirSync(join(ownerRoot, 'docs/plans'), { recursive: true });
    cpSync(planRoot, copy, { recursive: true });
    copyExternalInputs(ownerRoot);
    return run(copy, ownerRoot);
  } finally {
    rmSync(ownerRoot, { recursive: true, force: true });
  }
}

export function replace(root, relativePath, before, after) {
  const path = join(root, relativePath);
  const source = readFileSync(path, 'utf8');
  assert(source.includes(before), `fixture anchor missing: ${relativePath}`);
  writeFileSync(path, source.replace(before, after));
}

export function mutateJson(root, relativePath, mutate) {
  const path = join(root, relativePath);
  const value = JSON.parse(readFileSync(path, 'utf8'));
  mutate(value);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function mutateJsonLine(root, relativePath, index, mutate) {
  const path = join(root, relativePath);
  const lines = readFileSync(path, 'utf8').trimEnd().split('\n');
  const value = JSON.parse(lines[index]);
  mutate(value);
  lines[index] = JSON.stringify(value);
  writeFileSync(path, `${lines.join('\n')}\n`);
}
