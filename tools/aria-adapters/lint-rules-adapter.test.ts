import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { makeFixtureTree } from '../gates/fixture-tree';

import { RULE_PACKS, analyzeLintRules, selectFiles, severityFor } from './lint-rules-adapter';

async function main(): Promise<void> {
  // Expectations that are pinned independently, so one red does not hide
  // another: each is collected here and all are reported together at the end.
  const pins: string[] = [];
  const pin = async (name: string, body: () => void | Promise<void>): Promise<void> => {
    try {
      await body();
    } catch (error: unknown) {
      pins.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const workspace = makeFixtureTree('aria-lint-rules-');
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

  // ARIA-DET B08 — ESLint lines are 1-based, but a rule that is about the
  // whole file reports `line: 0` (eslint-plugin-sonarjs does for
  // `no-empty-test-file`, S2187). The evidence validator refuses a ref whose
  // line is not positive, and one refused ref turns the WHOLE run into
  // `evidence_error`: the adapter owns the normalisation, so a file-level
  // message becomes a finding at line 1 and every other line stays as the
  // engine reported it.
  const fileLevel = makeFixtureTree('aria-lint-rules-line0-');
  const fileLevelSrc = join(fileLevel, 'apps/sample-service/src');
  mkdirSync(fileLevelSrc, { recursive: true });
  // A comment line, not an empty file: the evidence validator also refuses a
  // line past the end of the file, and a file of zero lines has no line 1.
  writeFileSync(join(fileLevelSrc, 'empty.spec.ts'), '// No test lives in this file.\n', 'utf8');
  writeFileSync(
    join(fileLevelSrc, 'covered.spec.ts'),
    [
      "describe('covered', () => {",
      "  it('reads a number', () => {",
      "    expect(Number('2')).toBe(2);",
      '  });',
      '});',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(fileLevelSrc, 'genuine.ts'),
    [
      'export function one(): number {',
      '  return 1;',
      '}',
      '',
      'export function run(expression: string): unknown {',
      "  const wrapped = '(' + expression + ')';",
      '  return eval(wrapped);',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
  const emptySpec = 'apps/sample-service/src/empty.spec.ts';
  const withSpecs = await analyzeLintRules({ roots: ['apps'], includeTests: true }, fileLevel);
  assert.deepEqual(
    withSpecs.findings
      .filter((finding) => finding.rule === 'sonarjs/no-empty-test-file')
      .map((finding) => finding.path),
    [emptySpec],
    'the empty spec, and only it, draws no-empty-test-file; a spec with a real test does not',
  );
  const emptyFinding = withSpecs.findings.find(
    (finding) => finding.rule === 'sonarjs/no-empty-test-file',
  );
  assert.equal(emptyFinding?.line, 1, 'a file-level finding sits on the first line');
  assert.deepEqual(emptyFinding?.evidence, [{ path: emptySpec, line: 1 }]);
  assert.ok(
    emptyFinding?.id.startsWith(`lint-rules:sonarjs/no-empty-test-file:${emptySpec}:1:`),
    `the finding id names line 1, got ${emptyFinding?.id}`,
  );
  for (const finding of withSpecs.findings) {
    const lines = [finding.line, ...finding.evidence.map((ref) => ref.line)];
    assert.ok(
      lines.every((line) => Number.isInteger(line) && (line ?? 0) >= 1),
      `${finding.id}: every line the validator reads is a positive integer, got ${lines.join(',')}`,
    );
  }
  const genuine = withSpecs.findings.find(
    (finding) => finding.rule === 'security/detect-eval-with-expression',
  );
  assert.equal(genuine?.path, 'apps/sample-service/src/genuine.ts');
  assert.equal(genuine?.line, 7, 'a genuine line is not moved by the clamp');
  assert.deepEqual(genuine?.evidence, [{ path: 'apps/sample-service/src/genuine.ts', line: 7 }]);

  // The convention is the plugin's, not one rule's: whatever rule reports
  // line 0 (S104 max-lines, S1451 file-header, S3317 file-name-differ do too)
  // is kept as a finding at line 1; a message with no line already was.
  const stubbed = await analyzeLintRules({ roots: ['apps'], includeTests: true }, fileLevel, () =>
    Promise.resolve({
      lintFiles: (files) =>
        Promise.resolve([
          {
            filePath: files[0] ?? '',
            messages: [
              {
                ruleId: 'sonarjs/file-level-rule',
                severity: 2,
                message: 'whole file',
                line: 0,
                column: 0,
              },
              {
                ruleId: 'sonarjs/file-level-rule-b',
                severity: 2,
                message: 'whole file',
                line: 0,
                column: 1,
              },
              { ruleId: 'sonarjs/line-rule', severity: 2, message: 'one line', line: 7, column: 3 },
              { ruleId: 'sonarjs/no-line-rule', severity: 2, message: 'no line given' },
            ],
          },
        ]),
      getRulesMetaForResults: () => ({}),
    }),
  );
  assert.equal(
    stubbed.findings.length,
    4,
    'a file-level message is kept as a finding, not dropped',
  );
  const byRule = new Map(stubbed.findings.map((finding) => [finding.rule, finding]));
  assert.equal(byRule.get('sonarjs/file-level-rule')?.line, 1);
  assert.equal(byRule.get('sonarjs/file-level-rule-b')?.line, 1);
  assert.equal(byRule.get('sonarjs/line-rule')?.line, 7);
  assert.equal(byRule.get('sonarjs/no-line-rule')?.line, 1);
  for (const finding of stubbed.findings) {
    assert.deepEqual(
      finding.evidence,
      [{ path: finding.path, line: finding.line }],
      `${finding.id}: the evidence ref carries the finding's own line`,
    );
    assert.ok(
      finding.id.includes(`:${finding.path}:${finding.line}:`),
      `${finding.id}: the id carries the finding's own line`,
    );
  }

  // DET-lint1 review r1 (non-blocking 1 and 2), pinned independently so one
  // red does not hide the other.

  // A file of ZERO bytes has no line 1 (the evidence validator counts
  // `read_text().splitlines()` = 0 lines and answers `evidence_line_missing`
  // for any positive line), so clamping its file-level finding to line 1
  // still turns the WHOLE run into `evidence_error`. Pinned outcome: the
  // finding is KEPT (a zero-byte spec is the true positive of
  // no-empty-test-file, and dropping it would hide the rule's clearest case)
  // and it cites the FILE: evidence `[{path}]` without a `line`, which the
  // validator accepts for an existing file. The finding carries no line
  // either, and every other finding of the run survives.
  await pin('a zero-byte spec cannot be cited at line 1', async () => {
    const zero = makeFixtureTree('aria-lint-rules-zero-byte-');
    const zeroSrc = join(zero, 'apps/sample-service/src');
    mkdirSync(zeroSrc, { recursive: true });
    writeFileSync(join(zeroSrc, 'zero.spec.ts'), '', 'utf8');
    writeFileSync(
      join(zeroSrc, 'covered.spec.ts'),
      "describe('covered', () => {\n  it('reads a number', () => {\n    expect(Number('2')).toBe(2);\n  });\n});\n",
      'utf8',
    );
    writeFileSync(
      join(zeroSrc, 'genuine.ts'),
      [
        'export function run(expression: string): unknown {',
        "  const wrapped = '(' + expression + ')';",
        '  return eval(wrapped);',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );
    const zeroPath = 'apps/sample-service/src/zero.spec.ts';
    const zeroRun = await analyzeLintRules({ roots: ['apps'], includeTests: true }, zero);
    const zeroFinding = zeroRun.findings.find((finding) => finding.path === zeroPath);
    assert.equal(zeroFinding?.rule, 'sonarjs/no-empty-test-file', 'the zero-byte spec is kept');
    assert.deepEqual(
      zeroFinding?.evidence,
      [{ path: zeroPath }],
      'a file with no line is cited by path alone, not at a line it does not have',
    );
    assert.equal(zeroFinding?.line, undefined, 'the finding names no line of a file without lines');
    for (const finding of zeroRun.findings) {
      for (const ref of finding.evidence) {
        assert.ok(
          ref.line === undefined || ref.path !== zeroPath,
          `${finding.id}: no evidence ref cites a line of the zero-byte file`,
        );
      }
    }
    const eval7 = zeroRun.findings.find(
      (finding) => finding.rule === 'security/detect-eval-with-expression',
    );
    assert.equal(eval7?.line, 3, 'the other findings of the run survive, unmoved');
    assert.deepEqual(eval7?.evidence, [{ path: 'apps/sample-service/src/genuine.ts', line: 3 }]);
  });

  // The clamp must not make two different messages one finding: a file-level
  // message (line 0) and a genuine line-1 message of the same rule, path and
  // column both clamp to line 1, and the id (rule:path:line:column) is the
  // finding's identity everywhere downstream.
  await pin('a clamped line-0 message and a genuine line-1 message keep distinct ids', async () => {
    const clash = await analyzeLintRules({ roots: ['apps'], includeTests: true }, fileLevel, () =>
      Promise.resolve({
        lintFiles: (files) =>
          Promise.resolve([
            {
              filePath: files[0] ?? '',
              messages: [
                {
                  ruleId: 'sonarjs/shared-rule',
                  severity: 2,
                  message: 'whole file',
                  line: 0,
                  column: 1,
                },
                {
                  ruleId: 'sonarjs/shared-rule',
                  severity: 2,
                  message: 'first line',
                  line: 1,
                  column: 1,
                },
              ],
            },
          ]),
        getRulesMetaForResults: () => ({}),
      }),
    );
    assert.equal(clash.findings.length, 2, 'both messages are findings');
    assert.equal(
      new Set(clash.findings.map((finding) => finding.id)).size,
      2,
      `finding ids are unique, got ${clash.findings.map((finding) => finding.id).join(' | ')}`,
    );
  });

  // ARIA-DET Z-B1 step 1 (ledger Z04, Z13, Z44) — the syntactic repository
  // policy pack. CLAUDE.md names console calls, `any`, and a double assertion
  // through `unknown` FORBIDDEN, yet the developer lint has the first two off
  // in 17 of its 31 projects (farm-service and hr-service among them) and
  // nothing bans the third, so this scan is the only automated catch. The
  // pack is `no-console`, `@typescript-eslint/no-explicit-any` and the inline
  // `aria-policy/no-double-type-assertion`, scoped to the backend roots
  // (apps, libs, platform/libs). Floating promises need type information and
  // belong to the typed step (Z05), which is not pinned here.
  //
  // The constructs under test are spelled in pieces: the pre-commit
  // banned-construct gate reads added lines as text, and a fixture string that
  // names a construct whole is refused as if it were product code.
  const AS = 'as';
  const SUPPRESS = ['eslint', 'disable-next-line'].join('-');
  const NO_CONSOLE = 'no-console';
  const NO_ANY = '@typescript-eslint/no-explicit-any';
  const NO_DOUBLE = 'aria-policy/no-double-type-assertion';
  const policyRuleIds: readonly string[] = [NO_ANY, NO_CONSOLE, NO_DOUBLE];

  // One line of the fixture file, and the policy finding it must draw (if any).
  interface PolicyLine {
    readonly text: string;
    readonly rule?: string;
  }
  const plain = (text: string): PolicyLine => ({ text });
  const flagged = (rule: string, text: string): PolicyLine => ({ text, rule });
  const policyLines: readonly PolicyLine[] = [
    plain('export interface Subscription {'),
    plain('  readonly plan: string;'),
    plain('}'),
    plain('export type Anything = { readonly anyOf: readonly string[] };'),
    plain('export class SubscriptionCache {'),
    plain('  public constructor(private readonly logger: { log(message: string): void }) {}'),
    // The three positives of the zoo (Z04 console, Z44 any, Z13 double assertion).
    plain('  public read(cached: object): Subscription {'),
    flagged(NO_DOUBLE, `    return cached ${AS} unknown ${AS} Subscription;`),
    plain('  }'),
    plain('  public planLength(payload: unknown): number {'),
    flagged(NO_DOUBLE, `    return (payload ${AS} unknown ${AS} Subscription).plan.length;`),
    plain('  }'),
    plain('  public count(payload: unknown): number {'),
    flagged(NO_ANY, `    const typed = payload ${AS} any;`),
    plain('    return typed.count;'),
    plain('  }'),
    flagged(NO_ANY, '  public describe(payload: any): string {'),
    plain('    return String(payload);'),
    plain('  }'),
    plain('  public announce(): void {'),
    flagged(NO_CONSOLE, "    console.log('recalculated');"),
    flagged(NO_CONSOLE, "    console.error('failed');"),
    // Near-misses: each reads like a violation and is not one.
    plain("    this.logger.log('through the injected logger');"),
    plain('  }'),
    plain('  public property(): number {'),
    plain('    const sink = { console: { log: (_message: string): number => 1 } };'),
    plain("    return sink.console.log('a property that is called console');"),
    plain('  }'),
    plain('  public narrow(value: unknown): string {'),
    plain('    try {'),
    plain('      return JSON.stringify(value);'),
    plain('    } catch (error: unknown) {'),
    plain('      return String(error);'),
    plain('    }'),
    plain('  }'),
    plain('  public single(value: string): unknown {'),
    plain(`    const widened = value ${AS} unknown;`),
    plain(`    const frozen = ['any'] ${AS} const;`),
    plain('    const open: unknown = value;'),
    plain('    return [widened, frozen, open];'),
    plain('  }'),
    plain('}'),
  ];
  const policySource = `${policyLines.map((line) => line.text).join('\n')}\n`;
  // A justified inline suppression stays honoured: a deliberate exception must
  // not flood the ledger. Kept in a file of its own so that what the pins on
  // the flagged file report is only about the flagged file.
  const suppressedPath = 'apps/sample-service/src/suppressed.ts';
  const suppressedSource = [
    'export function justified(payload: unknown): number {',
    `  // ${SUPPRESS} no-console -- the banner is read from the operator terminal`,
    "  console.log('boot');",
    `  // ${SUPPRESS} @typescript-eslint/no-explicit-any -- the vendor row is untyped`,
    `  const vendor = payload ${AS} any;`,
    `  // ${SUPPRESS} aria-policy/no-double-type-assertion -- the driver row is untyped`,
    `  const row = payload ${AS} unknown ${AS} { readonly count: number };`,
    '  return vendor.count + row.count;',
    '}',
    '',
  ].join('\n');
  const backendPaths = [
    'apps/sample-service/src/policy.ts',
    'libs/sample-kit/src/policy.ts',
    'platform/libs/sample-bus/src/policy.ts',
  ];
  // `web/apps/...` is the shape an unanchored `apps` pattern would wrongly take
  // for a backend root: the offline-first PWA carries 110 of web's casts and
  // web is measured as its own decision, not swept in by step 1.
  const webPaths = ['web/modules/sample-module/src/policy.ts', 'web/apps/sample-pwa/src/policy.ts'];
  const policySpecPath = 'apps/sample-service/src/policy.spec.ts';
  const policyTree = makeFixtureTree('aria-lint-rules-policy-');
  for (const path of [...backendPaths, ...webPaths, policySpecPath]) {
    mkdirSync(join(policyTree, path, '..'), { recursive: true });
    writeFileSync(join(policyTree, path), policySource, 'utf8');
  }
  writeFileSync(join(policyTree, suppressedPath), suppressedSource, 'utf8');
  const policyRoots = ['apps', 'libs', 'platform/libs', 'web'];
  const policyRun = await analyzeLintRules({ roots: policyRoots }, policyTree);
  const policySet = new Set<string>(policyRuleIds);
  // The suppressed file has a pin of its own; the pins on the flagged files
  // do not read it.
  const policyFindingsOf = (run: typeof policyRun): typeof policyRun.findings =>
    run.findings.filter(
      (finding) => policySet.has(finding.rule) && finding.path !== suppressedPath,
    );
  const observedPolicy = (run: typeof policyRun, rule?: string): string[] =>
    policyFindingsOf(run)
      .filter((finding) => rule === undefined || finding.rule === rule)
      .map((finding) => `${finding.path}:${finding.line}:${finding.rule}`)
      .sort();
  const expectedPolicy = (paths: readonly string[], rule?: string): string[] =>
    paths
      .flatMap((path) =>
        policyLines.flatMap((line, index) =>
          line.rule !== undefined && (rule === undefined || line.rule === rule)
            ? [`${path}:${index + 1}:${line.rule}`]
            : [],
        ),
      )
      .sort();

  // Each rule is found on exactly the lines that draw it, in all three backend
  // roots, and on none of the near-miss or suppressed lines.
  for (const rule of policyRuleIds) {
    await pin(`${rule} is found on exactly its lines in the backend roots`, () => {
      assert.deepEqual(observedPolicy(policyRun, rule), expectedPolicy(backendPaths, rule));
    });
  }

  // At the base of this package a suppression that names a rule of an
  // unregistered plugin is itself reported, as a finding of the rule it names
  // ("Definition for rule ... was not found"), so a deliberate exception
  // floods the ledger instead of silencing it.
  await pin(
    'a justified inline suppression raises no finding, whichever policy rule it names',
    () => {
      assert.ok(policyRun.read_paths.includes(suppressedPath), 'the suppressed file is scanned');
      assert.deepEqual(
        policyRun.findings
          .filter((finding) => finding.path === suppressedPath && policySet.has(finding.rule))
          .map((finding) => `${finding.line}:${finding.rule}: ${finding.message}`),
        [],
      );
    },
  );

  await pin('the policy rules stay out of web and out of spec files', async () => {
    const withTests = await analyzeLintRules(
      { roots: policyRoots, includeTests: true },
      policyTree,
    );
    for (const path of [...webPaths, policySpecPath]) {
      assert.ok(withTests.read_paths.includes(path), `${path} is part of the scan surface`);
    }
    assert.deepEqual(
      [...new Set(observedPolicy(withTests).map((entry) => entry.split(':')[0]))].sort(),
      [...backendPaths].sort(),
      'policy findings exist in the backend roots only: not in web, not in a spec file',
    );
  });

  await pin(
    'a policy finding is medium, below a closing confidence, and cites its own line',
    () => {
      const found = policyFindingsOf(policyRun);
      assert.ok(found.length > 0, 'the policy pack produced findings');
      for (const finding of found) {
        assert.equal(
          finding.severity,
          'medium',
          `${finding.id}: CLAUDE.md names the construct FORBIDDEN`,
        );
        assert.ok((finding.confidence ?? 1) < 0.8, `${finding.id}: shadow findings never close`);
        assert.deepEqual(finding.evidence, [{ path: finding.path, line: finding.line }]);
        assert.ok(
          finding.message.startsWith(`${finding.rule}: `),
          `${finding.id}: ${finding.message}`,
        );
        assert.ok(
          finding.id.startsWith(`lint-rules:${finding.rule}:${finding.path}:${finding.line}:`),
          `${finding.id}: the id carries rule, path and line`,
        );
      }
    },
  );

  await pin('severityFor ranks a policy rule medium whatever its own meta says', () => {
    for (const rule of policyRuleIds) {
      assert.equal(severityFor(rule, { type: 'suggestion' }), 'medium', `${rule} (suggestion)`);
      assert.equal(severityFor(rule, { type: 'problem' }), 'medium', `${rule} (problem)`);
      assert.equal(severityFor(rule, undefined), 'medium', `${rule} (no meta)`);
    }
    assert.equal(
      severityFor('sonarjs/prefer-single-boolean-return', { type: 'suggestion' }),
      'low',
      'only the policy rules are lifted',
    );
  });

  await pin('the policy pack is a named rule pack, counted rule by rule in the summary', () => {
    const packs = ['sonarjs', 'security', 'policy'];
    assert.deepEqual([...RULE_PACKS], packs);
    const summary = policyRun.observations.find(
      (observation) => observation.type === 'lint_rules_summary',
    );
    assert.deepEqual(summary?.details?.rulePacks, packs);
    assert.deepEqual(policyRun.metadata.rulePacks, packs);
    const histogram = (summary?.details?.ruleHistogram ?? {}) as Record<string, number>;
    for (const rule of policyRuleIds) {
      assert.equal(histogram[rule], expectedPolicy(backendPaths, rule).length, `${rule} histogram`);
    }
  });

  // The generic `*` contract says a true positive is "not a style preference
  // the codebase allows", which the judges would refute for a console call in
  // a project whose developer lint allows it. A policy rule states its own
  // premise (CLAUDE.md forbids it), so each one fired here has its own entry,
  // and an entry no rule fires is a dead contract. The registry test
  // (aria-kernel/tests/test_rule_contract_manifests.py) pins what the entries
  // say; this pins that they and the rules that really fire are the same set.
  await pin(
    'each policy rule that fires has its own manifest contract, and no other has one',
    () => {
      const manifest = JSON.parse(
        readFileSync(join(__dirname, 'lint-rules-adapter.tool.json'), 'utf8'),
      ) as { rules: Record<string, unknown> };
      const fired = [
        ...new Set(observedPolicy(policyRun).map((entry) => entry.split(':')[2])),
      ].sort();
      assert.deepEqual(fired, [...policyRuleIds].sort(), 'all three policy rules fire');
      const own = Object.keys(manifest.rules)
        .filter((key) => key !== '*')
        .sort();
      assert.deepEqual(own, fired);
    },
  );

  if (pins.length > 0) {
    throw new Error(`pinned expectations failed:\n- ${pins.join('\n- ')}`);
  }

  process.stdout.write('lint-rules-adapter tests passed\n');
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
