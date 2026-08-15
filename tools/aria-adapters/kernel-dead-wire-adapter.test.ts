import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { analyzeKernelDeadWire } from './kernel-dead-wire-adapter';

// A synthetic kernel: one policy file, one production reader, one test module,
// one CLI. Every FP trap the real repo taught this rule is present, because a
// rule is only worth shipping if it can be shown NOT to fire.
const workspace = mkdtempSync(join(tmpdir(), 'aria-kernel-dead-wire-'));
const kernel = join(workspace, 'aria-kernel/aria_kernel');
mkdirSync(join(kernel, 'data'), { recursive: true });
mkdirSync(join(kernel, 'tests'), { recursive: true });

writeFileSync(
  join(kernel, 'data', 'policy.json'),
  JSON.stringify(
    {
      _doc: 'documentation, not a tunable',
      comment: 'the other doc-key spelling',
      '**/billing/**': 'a glob key is policy data',
      shadow_min_clean_cycles: 5,
      orphan_promotion_ceiling: 3,
      nested_block: { read_by_the_module: true, never_read_anywhere: 0.9 },
    },
    null,
    2,
  ),
  'utf8',
);

writeFileSync(
  join(kernel, 'reader.py'),
  [
    'def resolve(policy):',
    '    cycles = int(policy.get("shadow_min_clean_cycles") or 5)',
    '    return cycles, policy["nested_block"]["read_by_the_module"]',
  ].join('\n'),
  'utf8',
);

// The load-bearing trap: a TEST names both dead keys. Counting it as a read is
// exactly how an unread tunable stays green forever.
writeFileSync(
  join(kernel, 'tests', 'test_policy.py'),
  [
    'def test_keys(policy):',
    '    assert policy["orphan_promotion_ceiling"] == 3',
    '    assert policy["nested_block"]["never_read_anywhere"] == 0.9',
  ].join('\n'),
  'utf8',
);

writeFileSync(
  join(kernel, 'cli.py'),
  [
    'def build_parser(sub):',
    '    add_subparser(sub, "promote")',
    '    add_subparser(sub, "reconcile")',
    '',
    'def _main(args):',
    '    if args.command == "promote":',
    '        return 0',
    '    return 1',
  ].join('\n'),
  'utf8',
);

const result = analyzeKernelDeadWire(
  {
    roots: ['aria-kernel/aria_kernel'],
    policyDir: 'aria-kernel/aria_kernel/data',
    cliPath: 'aria-kernel/aria_kernel/cli.py',
  },
  workspace,
);

const ruleOf = (id: string) => result.findings.find((finding) => finding.id.endsWith(id));

// --- true positives -------------------------------------------------------
const unreadKey = ruleOf(':orphan_promotion_ceiling');
assert.ok(unreadKey, 'a top-level tunable nothing reads must be flagged');
assert.equal(unreadKey?.rule, 'policy_key_never_read');
assert.equal(unreadKey?.path, 'aria-kernel/aria_kernel/data/policy.json');
assert.ok((unreadKey?.line ?? 0) > 0, 'a finding without a line is not evidence');

assert.ok(
  ruleOf(':never_read_anywhere'),
  'a NESTED tunable nothing reads must be flagged — dead config hides one level down',
);

const deadVerb = ruleOf(':reconcile');
assert.ok(deadVerb, 'a registered CLI verb no branch dispatches must be flagged');
assert.equal(deadVerb?.rule, 'cli_verb_never_routed');

// --- false-positive traps -------------------------------------------------
for (const trap of [
  ':_doc',
  ':comment',
  ':**/billing/**',
  ':shadow_min_clean_cycles',
  ':read_by_the_module',
  ':promote',
]) {
  assert.equal(ruleOf(trap), undefined, `false positive on trap ${trap}`);
}

assert.equal(
  result.findings.length,
  3,
  `expected exactly 3 findings, got ${result.findings.length}`,
);

// --- output contract ------------------------------------------------------
assert.ok(
  result.observations.some((observation) => observation.type === 'kernel_cli_surface'),
  'the CLI surface must be observed even when it is fully routed',
);
assert.ok(
  result.observations.some((observation) => observation.type === 'kernel_policy_file'),
  'every policy file must be observed, flagged or not',
);
assert.ok(result.read_paths.length > 0, 'read_paths must record what was inspected');
assert.deepEqual(
  [...result.findings].map((finding) => finding.id).sort(),
  result.findings.map((finding) => finding.id),
  'findings must be emitted in a stable order',
);

// Determinism: a self-audit whose output moves between runs cannot be audited.
assert.deepEqual(
  analyzeKernelDeadWire(
    {
      roots: ['aria-kernel/aria_kernel'],
      policyDir: 'aria-kernel/aria_kernel/data',
      cliPath: 'aria-kernel/aria_kernel/cli.py',
    },
    workspace,
  ),
  result,
);

process.stdout.write('kernel-dead-wire-adapter.test.ts OK\n');
