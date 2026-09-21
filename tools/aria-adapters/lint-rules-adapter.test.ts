import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { analyzeLintRules, selectFiles, severityFor } from './lint-rules-adapter';

async function main(): Promise<void> {
  const workspace = mkdtempSync(join(tmpdir(), 'aria-lint-rules-'));
  const src = join(workspace, 'apps/sample-service/src');
  mkdirSync(src, { recursive: true });
  writeFileSync(
    join(src, 'flagged.ts'),
    [
      'export function sameBranches(flag: boolean): number {',
      '  if (flag) {',
      '    return 1;',
      '  } else {',
      '    return 1;',
      '  }',
      '}',
      'export function runUserExpression(expression: string): unknown {',
      "  return eval('(' + expression + ')');",
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(join(src, 'clean.ts'), 'export const one = 1;\n', 'utf8');
  writeFileSync(join(src, 'flagged.spec.ts'), 'export const spec = eval("1");\n', 'utf8');
  writeFileSync(join(src, 'types.d.ts'), 'export declare const declared: number;\n', 'utf8');
  mkdirSync(join(src, '.archive'), { recursive: true });
  writeFileSync(join(src, '.archive', 'old.ts'), 'export const old = eval("1");\n', 'utf8');

  // Selection: sources only — no spec, no declaration, no archive — unless asked.
  const selected = selectFiles({ roots: ['apps'] }, workspace).map((file) =>
    file.slice(workspace.length + 1),
  );
  assert.deepEqual(selected, [
    'apps/sample-service/src/clean.ts',
    'apps/sample-service/src/flagged.ts',
  ]);
  const withTests = selectFiles({ roots: ['apps'], includeTests: true }, workspace);
  assert.ok(
    withTests.some((file) => file.endsWith('flagged.spec.ts')),
    'includeTests admits spec files',
  );

  // Snapshot narrowing: only the allowed path is read.
  const narrowed = selectFiles(
    { roots: ['apps'], repo_snapshot: { allowed_paths: ['apps/sample-service/src/clean.ts'] } },
    workspace,
  );
  assert.deepEqual(
    narrowed.map((file) => file.slice(workspace.length + 1)),
    ['apps/sample-service/src/clean.ts'],
  );

  // Severity is the pack's classification.
  assert.equal(severityFor('security/detect-eval-with-expression', { type: 'problem' }), 'high');
  assert.equal(severityFor('sonarjs/no-all-duplicated-branches', { type: 'problem' }), 'medium');
  assert.equal(severityFor('sonarjs/prefer-single-boolean-return', { type: 'suggestion' }), 'low');
  assert.equal(
    severityFor('security/detect-object-injection', { type: 'problem' }),
    'low',
    'heuristic rules enter low',
  );

  // The real packs, through ARIA's own configuration.
  const output = await analyzeLintRules({ roots: ['apps'] }, workspace);
  const rules = new Map(output.findings.map((finding) => [finding.rule, finding]));
  assert.ok(
    rules.has('sonarjs/no-all-duplicated-branches'),
    `sonarjs pack must fire, got ${[...rules.keys()].join(',')}`,
  );
  assert.ok(rules.has('security/detect-eval-with-expression'), 'security pack must fire');
  const duplicated = rules.get('sonarjs/no-all-duplicated-branches');
  assert.equal(duplicated?.path, 'apps/sample-service/src/flagged.ts');
  assert.equal(duplicated?.line, 2);
  assert.deepEqual(duplicated?.evidence, [{ path: 'apps/sample-service/src/flagged.ts', line: 2 }]);
  assert.equal(duplicated?.severity, 'medium');
  assert.equal(rules.get('security/detect-eval-with-expression')?.severity, 'high');
  assert.ok(
    output.findings.every((finding) => finding.path !== 'apps/sample-service/src/flagged.spec.ts'),
  );
  assert.ok(
    output.findings.every((finding) => output.read_paths.includes(finding.path)),
    'evidence stays inside read_paths',
  );
  assert.ok(
    output.findings.every((finding) => (finding.confidence ?? 1) < 0.8),
    'shadow findings never carry a closing confidence',
  );
  const summary = output.observations.find(
    (observation) => observation.type === 'lint_rules_summary',
  );
  assert.ok(summary, 'summary observation is always present');
  assert.equal(summary?.details?.files, 2);
  assert.equal(summary?.details?.parseErrors, 0);
  assert.deepEqual(summary?.details?.rulePacks, ['sonarjs', 'security']);
  assert.equal(output.cost_units, 2);

  // A file the parser cannot read is an observation, not a finding.
  writeFileSync(join(src, 'broken.ts'), 'export function (\n', 'utf8');
  const withBroken = await analyzeLintRules({ roots: ['apps'] }, workspace);
  const parseErrors = withBroken.observations.filter(
    (observation) => observation.type === 'lint_rules_parse_error',
  );
  assert.equal(parseErrors.length, 1);
  assert.equal(parseErrors[0]?.path, 'apps/sample-service/src/broken.ts');
  assert.ok(
    withBroken.findings.every((finding) => finding.path !== 'apps/sample-service/src/broken.ts'),
  );

  // An empty scan surface is an empty, well-formed output — no engine is started.
  const empty = await analyzeLintRules({ roots: ['missing'] }, workspace, () =>
    Promise.reject(new Error('engine must not start for an empty surface')),
  );
  assert.deepEqual(empty.findings, []);
  assert.equal(empty.observations.length, 1);

  process.stdout.write('lint-rules-adapter tests passed\n');
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
