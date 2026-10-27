import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { makeFixtureTree } from '../gates/fixture-tree';

import { analyzeSecurityBoundaries } from './security-boundary-adapter';

// DET-crossfile2 / Z33 (+ Z-B2). ADR-015: under mTLS no user, pass or token reaches the CONNECT
// frame. The rule lives only in the branch structure of buildNatsConnectionOptions, and two
// gateway bridges rebuild the credentials around the factory. Two static rules close both:
//   SET  - in the module that declares the factory, every write to .user/.pass/.token sits inside
//          an `if`/`switch` that compares `authMode` with a literal;
//   READ - a read of NATS_AUTH_USER|PASS|TOKEN in any non-test module other than the factory
//          (one finding per module, at its first read).
// The factory is found by what it declares (tools/gates/nats-connection-owner.ts), never by path.
// The rule ids are compared as `string`: they are the new ids this package introduces.
const SET_RULE = 'nats_credential_set_outside_auth_mode_branch';
const READ_RULE = 'nats_credential_env_read_outside_factory';
const REPO_ROOT = resolve(__dirname, '..', '..');
const FACTORY = 'libs/backend-common/src/nats/nats-connection.factory.ts';
const ROOTS = ['apps', 'libs/backend-common/src'];

type Output = ReturnType<typeof analyzeSecurityBoundaries>;
function scan(files: Readonly<Record<string, string>>, roots: readonly string[] = ROOTS): Output {
  const workspace = makeFixtureTree('aria-nats-credential-');
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(workspace, path)), { recursive: true });
    writeFileSync(join(workspace, path), text, 'utf8');
  }
  return analyzeSecurityBoundaries({ roots: [...roots] }, workspace);
}
const ofRule = (output: Output, rule: string): Output['findings'] =>
  output.findings.filter((finding) => finding.rule === rule);
/** `path:line` of every finding of one rule, sorted. */
const at = (output: Output, rule: string): string[] =>
  ofRule(output, rule)
    .map((finding) => `${finding.path}:${finding.line ?? 0}`)
    .sort();
/** The 1-based row whose trimmed text is `row`. */
const rowOf = (text: string, row: string): number =>
  text.split('\n').findIndex((candidate) => candidate.trim() === row) + 1;
const outputs: Output[] = [];
const run = (files: Readonly<Record<string, string>>, roots?: readonly string[]): Output => {
  const output = scan(files, roots);
  outputs.push(output);
  return output;
};

// Z33 fixture: the real factory with the patch the RCA names, after the token branch.
const realFactory = readFileSync(join(REPO_ROOT, FACTORY), 'utf8');
const end = realFactory.lastIndexOf('  return options;');
assert.ok(end > 0, 'the factory no longer ends in `return options;`');
const patched = `${realFactory.slice(0, end)}  if (authUser && authPass) {\n    options.user = authUser;\n    options.pass = authPass;\n  }\n${realFactory.slice(end)}`;
const patchUser = patched.split('\n').lastIndexOf('    options.user = authUser;') + 1;
const z33 = run({ [FACTORY]: patched });
assert.deepEqual(at(z33, SET_RULE), [`${FACTORY}:${patchUser}`, `${FACTORY}:${patchUser + 1}`]);
assert.deepEqual(at(z33, READ_RULE), [], 'the factory reads its own environment by design');
for (const finding of ofRule(z33, SET_RULE)) {
  assert.ok(finding.evidence.some((ref) => ref.path === FACTORY && ref.line === finding.line));
}
// Near-miss: the factory as it is on main is clean for both rules.
assert.deepEqual(at(run({ [FACTORY]: realFactory }), SET_RULE), []);
assert.deepEqual(at(run({ [FACTORY]: realFactory }), READ_RULE), []);

// SET rule on a minimal factory: [name, statements, the write row that must be reported].
const factory = (body: string): string =>
  [
    `export function buildNatsConnectionOptions(serviceName?: string): object {`,
    `  const authUser = process.env['NATS_AUTH_USER'];`,
    `  const authPass = process.env['NATS_AUTH_PASS'];`,
    `  const authToken = process.env['NATS_AUTH_TOKEN'];`,
    `  const authMode: string = authToken ? 'token' : 'user-pass';`,
    `  const options: { user?: string; pass?: string; token?: string; name?: string } = {};`,
    body,
    `  return options;`,
    `}`,
  ].join('\n');
const VARIANTS: readonly (readonly [string, string, string | undefined])[] = [
  [
    'an if chain on authMode',
    `  if (authMode === 'token') {\n    options.token = authToken;\n  } else if (authMode === 'user-pass') {\n    options.user = authUser;\n    options.pass = authPass;\n  }`,
    undefined,
  ],
  [
    'a switch on authMode',
    `  switch (authMode) {\n    case 'token':\n      options.token = authToken;\n      break;\n    case 'user-pass':\n      options.user = authUser;\n      options.pass = authPass;\n      break;\n  }`,
    undefined,
  ],
  ['no guard at all', `  options.token = authToken;`, 'options.token = authToken;'],
  [
    'a guard on the credential, not the mode',
    `  if (authToken) {\n    options.token = authToken;\n  }`,
    'options.token = authToken;',
  ],
  [
    'a literal compared with another variable',
    `  if (serviceName === 'user-pass') {\n    options.user = authUser;\n  }`,
    'options.user = authUser;',
  ],
  // Near-miss: other fields and plain reads are not credential writes.
  [
    'a field that is no credential, and a read',
    `  options.name = serviceName;\n  const seen = options.token;\n  void seen;`,
    undefined,
  ],
];
for (const [name, body, written] of VARIANTS) {
  const text = factory(body);
  const expected = written === undefined ? [] : [`${FACTORY}:${rowOf(text, written)}`];
  assert.deepEqual(at(run({ [FACTORY]: text }), SET_RULE), expected, name);
}

// READ rule, bench probe form: the gateway bridge rebuilds the credentials around the factory.
const BRIDGE = [
  `import { connect } from '@nats-io/transport-node';`,
  `import { buildNatsConnectionOptions } from '@aquaculture/backend-common/nats';`,
  `export class BridgeService {`,
  `  constructor(private readonly configService: { get<T>(key: string): T | undefined }) {}`,
  `  async connect(): Promise<void> {`,
  `    const connectionOptions: Record<string, unknown> = { ...buildNatsConnectionOptions('b') };`,
  `    const authToken = this.configService.get<string>('NATS_AUTH_TOKEN');`,
  `    const authUser = this.configService.get<string>('NATS_AUTH_USER');`,
  `    const authPass = this.configService.get<string>('NATS_AUTH_PASS');`,
  `    if (authToken) {`,
  `      connectionOptions.token = authToken;`,
  `    } else if (authUser && authPass) {`,
  `      connectionOptions.user = authUser;`,
  `      connectionOptions.pass = authPass;`,
  `    }`,
  `    await connect(connectionOptions);`,
  `  }`,
  `}`,
].join('\n');
const WEB = 'apps/gateway-api/src/websocket';
const probe = run({
  [`${WEB}/bridge.service.ts`]: BRIDGE,
  // the other read forms, one module each
  'apps/a/src/user.ts': `export const user = process.env['NATS_AUTH_USER'];`,
  'apps/a/src/pass.ts': `export const pass = process.env.NATS_AUTH_PASS;`,
  'apps/a/src/token.ts': `export const read = (c: { get(k: string): string | undefined }) => c.get('NATS_AUTH_TOKEN');`,
  // near-misses: none of these reads a NATS credential variable
  'apps/b/src/database.ts': [
    `export const db = process.env['DATABASE_USER'];`,
    `export const smtp = { user: process.env['SMTP_USER'], pass: process.env['SMTP_PASS'] };`,
    `smtp.user = 'relay';`,
  ].join('\n'),
  'apps/b/src/similar.ts': `export const file = process.env['NATS_AUTH_USER_FILE'];`,
  'apps/b/src/doc.ts': [
    `/** NATS_AUTH_USER is ignored under mTLS. */`,
    `// NATS_AUTH_PASS and NATS_AUTH_TOKEN too.`,
    `export const hint = (): never => { throw new Error('set NATS_AUTH_TOKEN or a client certificate'); };`,
  ].join('\n'),
  'apps/b/src/uses-factory.ts': `import { buildNatsConnectionOptions } from '@aquaculture/backend-common/nats';\nexport const options = { ...buildNatsConnectionOptions('svc') };`,
  'apps/b/src/clears.spec.ts': `delete process.env['NATS_AUTH_USER'];`,
});
assert.deepEqual(
  at(probe, READ_RULE),
  [
    `${WEB}/bridge.service.ts:7`,
    'apps/a/src/pass.ts:1',
    'apps/a/src/token.ts:1',
    'apps/a/src/user.ts:1',
  ].sort(),
);
assert.deepEqual(
  at(probe, SET_RULE),
  [],
  'only the module that declares the factory is held to it',
);

// The owner is found by what it declares, not by its path: a moved factory is still held to the
// rule, the old path is an ordinary module, and a barrel that re-exports the symbol is no owner.
const moved = factory(`  options.user = authUser;`);
const relocated = run({
  'libs/backend-common/src/net/connection.ts': moved,
  [FACTORY]: `export const leftover = process.env['NATS_AUTH_USER'];`,
  'libs/backend-common/src/nats/index.ts': `export { buildNatsConnectionOptions } from '../net/connection';\nexport const t = process.env['NATS_AUTH_TOKEN'];`,
});
assert.deepEqual(at(relocated, SET_RULE), [
  `libs/backend-common/src/net/connection.ts:${rowOf(moved, 'options.user = authUser;')}`,
]);
assert.deepEqual(
  at(relocated, READ_RULE),
  [`${FACTORY}:1`, 'libs/backend-common/src/nats/index.ts:2'].sort(),
);

// Clean-main baseline on a small scope (no full run): the factory is clean and the two gateway
// bridges are the two true READ findings. Moving both onto buildNatsConnectionOptions, as the
// farm bridge already does, empties this list.
const firstRead = (path: string): number =>
  readFileSync(join(REPO_ROOT, path), 'utf8')
    .split('\n')
    .findIndex((row) => /'NATS_AUTH_(?:USER|PASS|TOKEN)'/.test(row)) + 1;
const real = analyzeSecurityBoundaries({ roots: ['libs/backend-common/src/nats', WEB] }, REPO_ROOT);
outputs.push(real);
const bridges = ['nats-bridge.service.ts', 'st-language-bridge.service.ts'].map(
  (name) => `${WEB}/${name}`,
);
assert.deepEqual(
  at(real, READ_RULE),
  bridges.map((path) => `${path}:${firstRead(path)}`),
);
assert.deepEqual(at(real, SET_RULE), []);

// Both rules are declared in the manifest, and the adapter stays SHADOW.
type Manifest = {
  status?: string;
  rules: Record<string, { claim_type?: string; premises?: string[] }>;
};
const manifest = JSON.parse(
  readFileSync(join(__dirname, 'security-boundary-adapter.tool.json'), 'utf8'),
) as Manifest;
assert.equal(manifest.status, 'SHADOW');
for (const rule of [SET_RULE, READ_RULE]) {
  const declared = manifest.rules[rule];
  assert.ok(declared, `${rule} must be declared in security-boundary-adapter.tool.json`);
  assert.equal(declared.claim_type, 'wrong_code');
  assert.ok((declared.premises ?? []).length > 0, `${rule} needs premises`);
}
for (const output of outputs) {
  const ids = output.findings.map((finding) => finding.id);
  assert.equal(new Set(ids).size, ids.length, 'a finding id is emitted twice');
  for (const finding of output.findings) {
    assert.ok(manifest.rules[finding.rule], `${finding.rule} is emitted but not declared`);
    for (const ref of finding.evidence) {
      assert.ok(output.read_paths.includes(ref.path), `evidence ${ref.path} must be a read path`);
    }
  }
}

process.stdout.write('security-boundary-adapter nats credential tests passed\n');
