/**
 * DET crossfile-2 (ledger ids Z33, Z-B2) — the one owner of "which module builds the NATS
 * connection", and of the credential names its CONNECT-identity rule talks about.
 *
 * # Why
 *
 * ADR-015 says no user, pass or token reaches the CONNECT frame under mTLS. The rule lives in the
 * branch structure of `buildNatsConnectionOptions` only, and the ARIA security-boundary adapter
 * (which now checks it statically) must find that factory by what it exports, never by a copy of
 * its path. `tools/gates/nats-connection-owner.ts` is that one owner; the adapter reads it
 * (`../gates/<module>`, the one edge the adapter lint override allows).
 *
 * # What this pins (new API: the module above and its three exports, named below)
 *
 * 1. `declaresNatsConnectionFactory(sourceFile)`: true for a module that DECLARES and exports
 *    `buildNatsConnectionOptions`; false for a re-export (the `nats/index.ts` barrel does exactly
 *    that), an import, an unexported function, a class member, a similar name, a comment or a
 *    string.
 * 2. On this checkout exactly one non-test module declares the factory: the owner file.
 * 3. `NATS_CREDENTIAL_ENV_VARS` and `NATS_CREDENTIAL_FIELDS` are what the factory really reads
 *    from the environment and really writes onto its options, so a new credential variable or
 *    field cannot reach the factory without reaching the rule. The oracle is a read of the
 *    factory's own text, not the module under test.
 *
 * Why this lives here and not in tools/gates: the pre-commit hook runs every tools/gates spec
 * (tools/gates/run-all.mjs), so a red spec there cannot be committed. The owner module itself is
 * a tools/gates module. The factory's own behaviour under mTLS is pinned next to it, in
 * libs/backend-common/src/nats/__tests__/nats-connection.factory.auth.spec.ts.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import * as ts from 'typescript';

import { hermeticGitEnv } from '../../tools/gates/hermetic-git';
import {
  declaresNatsConnectionFactory,
  NATS_CREDENTIAL_ENV_VARS,
  NATS_CREDENTIAL_FIELDS,
} from '../../tools/gates/nats-connection-owner';

const REPO_ROOT = resolve(__dirname, '..', '..');
const FACTORY = 'libs/backend-common/src/nats/nats-connection.factory.ts';
const SYMBOL = 'buildNatsConnectionOptions';

const parse = (text: string): ts.SourceFile =>
  ts.createSourceFile('probe.ts', text, ts.ScriptTarget.Latest, true);

describe('declaresNatsConnectionFactory', () => {
  it.each([
    ['a function declaration', `export function ${SYMBOL}(name?: string): object { return {}; }`],
    ['a const arrow function', `export const ${SYMBOL} = (name?: string): object => ({});`],
    [
      'a declaration exported by name',
      `function ${SYMBOL}(): object { return {}; }\nexport { ${SYMBOL} };`,
    ],
    [
      'a module with other exports',
      `export const DEFAULT_NATS_URL = 'nats://localhost:4222';\nexport function ${SYMBOL}(): object { return {}; }`,
    ],
  ])('is true for %s', (_name, text) => {
    expect(declaresNatsConnectionFactory(parse(text))).toBe(true);
  });

  // Near-misses: each one mentions the symbol and none of them is the owner.
  it.each([
    [
      'the barrel re-export',
      `export { ${SYMBOL}, DEFAULT_NATS_URL } from './nats-connection.factory';`,
    ],
    ['a star re-export', `export * from './nats-connection.factory';`],
    [
      'an import that is used',
      `import { ${SYMBOL} } from '@aquaculture/backend-common/nats';\nexport const options = ${SYMBOL}('x');`,
    ],
    ['an import that is re-exported', `import { ${SYMBOL} } from './f';\nexport { ${SYMBOL} };`],
    ['a function that is not exported', `function ${SYMBOL}(): object { return {}; }`],
    ['a class member of that name', `export class Probe { ${SYMBOL}(): void {} }`],
    ['a longer name', `export function ${SYMBOL}For(): void {}`],
    ['another factory', `export function buildEventBusConfig(): void {}`],
    [
      'a comment and a string',
      `// export function ${SYMBOL}() {}\nexport const note = 'export function ${SYMBOL}';`,
    ],
  ])('is false for %s', (_name, text) => {
    expect(declaresNatsConnectionFactory(parse(text))).toBe(false);
  });
});

describe('the NATS connection factory owner on this checkout', () => {
  const factoryText = readFileSync(join(REPO_ROOT, FACTORY), 'utf8');
  const unique = (pattern: RegExp): string[] =>
    [...new Set([...factoryText.matchAll(pattern)].map((match) => match[1] ?? ''))].sort();

  it('is one non-test module, found by what it declares', () => {
    const named = execFileSync('git', ['-C', REPO_ROOT, 'grep', '-l', '-z', SYMBOL, '--', '*.ts'], {
      encoding: 'utf8',
      env: hermeticGitEnv(),
      maxBuffer: 64 * 1024 * 1024,
    })
      .split('\0')
      .filter((path) => path.length > 0 && !/\.(?:spec|test|d)\.ts$/.test(path));
    expect(named.length).toBeGreaterThan(1); // the barrel and the callers name it too
    const owners = named.filter((path) =>
      declaresNatsConnectionFactory(parse(readFileSync(join(REPO_ROOT, path), 'utf8'))),
    );
    expect(owners).toEqual([FACTORY]);
  });

  it('owns the credential environment variables the factory reads', () => {
    expect([...NATS_CREDENTIAL_ENV_VARS].sort()).toEqual(
      unique(/process\.env\['(NATS_AUTH_[A-Z_]+)'\]/g),
    );
  });

  it('owns the credential fields the factory writes from them', () => {
    expect([...NATS_CREDENTIAL_FIELDS].sort()).toEqual(unique(/\boptions\.(\w+) = auth[A-Z]\w*;/g));
  });
});
