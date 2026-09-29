import { chmodSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AtomicDirectoryPublication } from '../src/runtime/atomic-directory-publication';

const mutableFs = jest.requireActual<typeof import('node:fs')>('node:fs');
const temporaryRoots: string[] = [];

afterEach(() => {
  jest.restoreAllMocks();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe('atomic directory publication construction', () => {
  it.each([0o770, 0o707])(
    'rejects a publication parent writable outside its owner (%s)',
    (mode) => {
      const parent = mkdtempSync(join(tmpdir(), 'new-aria-publication-'));
      temporaryRoots.push(parent);
      chmodSync(parent, mode);

      expect(() => new AtomicDirectoryPublication(join(parent, 'bundle'))).toThrow(
        /owner-controlled/,
      );
      expect(existsSync(join(parent, 'bundle'))).toBe(false);
    },
  );

  it('removes every owned artifact after a mid-construction failure', () => {
    const parent = mkdtempSync(join(tmpdir(), 'new-aria-publication-'));
    temporaryRoots.push(parent);
    const publicationPath = join(parent, 'bundle');
    const originalMkdir = mutableFs.mkdirSync;
    let calls = 0;
    jest.spyOn(mutableFs, 'mkdirSync').mockImplementation((path, options) => {
      calls += 1;
      if (calls === 2) throw new TypeError('injected staging creation failure');
      return originalMkdir(path, options);
    });

    expect(() => new AtomicDirectoryPublication(publicationPath)).toThrow(/injected/);
    expect(existsSync(publicationPath)).toBe(false);
  });
});
