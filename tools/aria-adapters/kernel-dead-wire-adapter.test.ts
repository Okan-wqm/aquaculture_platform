import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { makeFixtureTree } from '../gates/fixture-tree';

import { analyzeKernelDeadWire } from './kernel-dead-wire-adapter';

const REPO_ROOT = resolve(__dirname, '..', '..');

// The kernel's own glob matcher, asked through the `python3 -I -S` bridge shape
// kernel-owners.ts uses, so this test restates no second glob grammar.
const GLOB_BRIDGE = [
  'import json, sys',
  'sys.path.insert(0, sys.argv[1])',
  'from aria_kernel.canonical_path import matches_repo_glob',
  'ask = json.load(sys.stdin)',
  'json.dump([p for p in ask["paths"] if not any(matches_repo_glob(p, g) for g in ask["globs"])], sys.stdout)',
].join('\n');

function pathsOutsideGlobs(paths: readonly string[], globs: readonly string[]): string[] {
  const argv = ['-I', '-S', '-c', GLOB_BRIDGE, join(REPO_ROOT, 'aria-kernel')];
  const input = JSON.stringify({ paths, globs });
  return JSON.parse(execFileSync('python3', argv, { encoding: 'utf8', input })) as string[];
}

// A synthetic kernel: one policy file, one production reader, one test module,
// one CLI. Every FP trap the real repo taught this rule is present, because a
// rule is only worth shipping if it can be shown NOT to fire.
const workspace = makeFixtureTree('aria-kernel-dead-wire-');
const kernel = join(workspace, 'aria-kernel/aria_kernel');
mkdirSync(join(kernel, 'data'), { recursive: true });
mkdirSync(join(kernel, 'tests'), { recursive: true });

writeFileSync(
  join(kernel, 'data', 'policy.json'),
  JSON.stringify({
    _doc: 'documentation, not a tunable',
    comment: 'the other doc-key spelling',
    '**/billing/**': 'a glob key is policy data',
    shadow_min_clean_cycles: 5,
    orphan_promotion_ceiling: 3,
    nested_block: { read_by_the_module: true, never_read_anywhere: 0.9 },
  }),
  'utf8',
);

// A policy file one directory down: `collectFiles` recurses, so the adapter
// reads it and the manifest must grant it. The note and the extensionless file
// (the real kernel ships data/sandbox_etc/hosts) are not policy: unread, ungranted.
mkdirSync(join(kernel, 'data', 'nested'), { recursive: true });
mkdirSync(join(kernel, 'data', 'sandbox_etc'), { recursive: true });
writeFileSync(
  join(kernel, 'data', 'nested', 'zz.json'),
  JSON.stringify({ zz_unread_nested_policy_key: 1, zz_read_nested_policy_key: 2 }),
  'utf8',
);
writeFileSync(join(kernel, 'data', 'nested', 'readme.md'), '{"zz_markdown_only_key": 1}', 'utf8');
writeFileSync(join(kernel, 'data', 'sandbox_etc', 'hosts'), '127.0.0.1 localhost\n', 'utf8');

writeFileSync(
  join(kernel, 'reader.py'),
  [
    'def resolve(policy):',
    '    cycles = int(policy.get("shadow_min_clean_cycles") or 5)',
    '    nested = policy.get("zz_read_nested_policy_key")',
    '    return cycles, nested, policy["nested_block"]["read_by_the_module"]',
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

// CLI traps: a verb dispatched through a set literal, a set literal that is not
// a dispatch, and a nested parser. The nested group has two dead siblings on
// purpose: a lone verb with no branch can be the group's fall-through (notify
// send, economy recommend in the real cli.py), which no line reader can tell
// from a dead one.
writeFileSync(
  join(kernel, 'cli.py'),
  [
    'def build_parser(sub):',
    '    add_subparser(sub, "promote")',
    '    add_subparser(sub, "reconcile")',
    '    add_subparser(sub, "zzset-a")',
    '    add_subparser(sub, "zzset-b")',
    '    add_subparser(sub, "zzset-unlisted")',
    '    add_subparser(sub, "zztuple")',
    '    add_subparser(sub, "zzmode")',
    '    group = add_subparser(sub, "zzgroup")',
    '    zzgroup_sub = group.add_subparsers(dest="zzgroup_command")',
    '    add_subparser(zzgroup_sub, "zz-nested-routed")',
    '    add_subparser(zzgroup_sub, "zz-nested-dead-a")',
    '    add_subparser(zzgroup_sub, "zz-nested-dead-b")',
    '',
    'def _main(args, mode):',
    '    if args.command == "promote":',
    '        return 0',
    '    if args.command in {"zzset-a", "zzset-b"}:',
    '        return 0',
    '    if args.command in ("zztuple", "zzother"):',
    '        return 0',
    '    if mode in {"zzmode"}:',
    '        return 0',
    '    if args.command == "zzgroup":',
    '        if args.zzgroup_command == "zz-nested-routed":',
    '            return 0',
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

const ruleOf = (id: string): (typeof result.findings)[number] | undefined =>
  result.findings.find((finding) => finding.id.endsWith(id));

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

const nestedUnread = ruleOf(':zz_unread_nested_policy_key');
assert.ok(nestedUnread, 'a tunable nobody reads in a data/ subdirectory must be flagged');
assert.equal(nestedUnread?.path, 'aria-kernel/aria_kernel/data/nested/zz.json');

for (const verb of [':zz-nested-dead-a', ':zz-nested-dead-b']) {
  assert.equal(
    ruleOf(verb)?.rule,
    'cli_verb_never_routed',
    `a verb registered on a nested parser that no branch dispatches must be flagged: ${verb}`,
  );
}
// Near misses: a verb the set literal does not list, and a set literal that is
// not an `args.command` dispatch.
for (const verb of [':zzset-unlisted', ':zzmode']) {
  assert.equal(ruleOf(verb)?.rule, 'cli_verb_never_routed', `${verb} is not dispatched`);
}

// --- false-positive traps -------------------------------------------------
for (const trap of [
  ':_doc',
  ':comment',
  ':**/billing/**',
  ':shadow_min_clean_cycles',
  ':read_by_the_module',
  ':promote',
  ':zz_read_nested_policy_key',
  ':zz_markdown_only_key',
  ':zzset-a',
  ':zzset-b',
  ':zztuple',
  ':zz-nested-routed',
]) {
  assert.equal(ruleOf(trap), undefined, `false positive on trap ${trap}`);
}

assert.equal(
  result.findings.length,
  8,
  `expected exactly 8 findings, got ${result.findings.length}`,
);

// --- scope: what the adapter reads is what the manifest grants -------------
// The kernel refuses the whole run (`read_path_outside_snapshot`,
// `evidence_outside_snapshot`) when a path read or cited is outside the manifest
// globs; the adapter's walk and the manifest are one surface, pinned together.
const NOT_POLICY = [
  'aria-kernel/aria_kernel/data/nested/readme.md',
  'aria-kernel/aria_kernel/data/sandbox_etc/hosts',
];
for (const path of NOT_POLICY) {
  assert.ok(!result.read_paths.includes(path), `${path} is not policy JSON and must stay unread`);
}
const manifest = JSON.parse(
  readFileSync(join(__dirname, 'kernel-dead-wire-adapter.tool.json'), 'utf8'),
) as { declared_scope: string[]; allowed_read_globs: string[] };
const reachedPaths = [
  ...new Set([
    ...result.read_paths,
    ...result.findings.flatMap((finding) => finding.evidence.map((ref) => ref.path)),
  ]),
].sort();
for (const [field, globs] of [
  ['declared_scope', manifest.declared_scope],
  ['allowed_read_globs', manifest.allowed_read_globs],
] as const) {
  assert.deepEqual(
    pathsOutsideGlobs(reachedPaths, globs),
    [],
    `${field} must cover every path the adapter reads or cites`,
  );
  // A glob wider than the walk (`data/**`) would count unread files as observed.
  assert.deepEqual(
    pathsOutsideGlobs(NOT_POLICY, globs),
    NOT_POLICY,
    `${field} must not grant files under data/ the adapter never reads`,
  );
}

// Nested verbs in the real cli.py are dispatched by `args.<group>_command`
// branches, one verb per group by falling through them: reading nested parsers
// must not turn that into findings on the production CLI.
const production = analyzeKernelDeadWire({ roots: ['aria-kernel/aria_kernel'] }, REPO_ROOT);
assert.deepEqual(
  production.findings
    .filter((finding) => finding.rule === 'cli_verb_never_routed')
    .map((finding) => finding.id),
  [],
  'the production CLI has no dead verb: reading nested parsers must not invent one',
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
