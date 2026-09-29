import {
  chmodSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readPrivateKeyFile } from '../src/runtime/private-key-file';

const temporaryRoots: string[] = [];

function privateKeyFixture(): {
  readonly root: string;
  readonly path: string;
  readonly bytes: Buffer;
} {
  const root = mkdtempSync(join(tmpdir(), 'new-aria-private-key-'));
  temporaryRoots.push(root);
  const path = join(root, 'execution-private.der');
  const bytes = Buffer.from('private-key-fixture');
  writeFileSync(path, bytes, { mode: 0o600 });
  return { root, path, bytes };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe('private key file loader', () => {
  it('reads an owner-only, single-link key through an identity-bound parent', () => {
    const fixture = privateKeyFixture();

    expect(readPrivateKeyFile(fixture.path)).toEqual(fixture.bytes);
  });

  it('rejects group- or world-readable key material', () => {
    const fixture = privateKeyFixture();
    chmodSync(fixture.path, 0o640);

    expect(() => readPrivateKeyFile(fixture.path)).toThrow(/mode/);
  });

  it('rejects hard-linked key material', () => {
    const fixture = privateKeyFixture();
    linkSync(fixture.path, join(fixture.root, 'second-link.der'));

    expect(() => readPrivateKeyFile(fixture.path)).toThrow(/link/);
  });

  it('rejects a symlink alias for key material', () => {
    const fixture = privateKeyFixture();
    const alias = join(fixture.root, 'alias.der');
    symlinkSync(fixture.path, alias);

    expect(() => readPrivateKeyFile(alias)).toThrow(/canonical|symbolic/);
  });

  it('rejects a parent directory writable by another identity', () => {
    const fixture = privateKeyFixture();
    chmodSync(fixture.root, 0o777);

    expect(() => readPrivateKeyFile(fixture.path)).toThrow(/parent/);
    expect(readFileSync(fixture.path)).toEqual(fixture.bytes);
  });
});
