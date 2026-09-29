import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { boundedDirectoryEntryNames } from '../src/adapters/bounded-directory-entries';

describe('bounded directory entry iteration', () => {
  it('stops at the first entry beyond the limit without materializing an unbounded roster', () => {
    const root = mkdtempSync(join(tmpdir(), 'new-aria-bounded-directory-'));
    try {
      ['a', 'b', 'c'].forEach((name) => writeFileSync(join(root, name), name));

      expect(() => boundedDirectoryEntryNames(root, 2, 'fixture directory')).toThrow(
        /entry limit/i,
      );
      expect([...boundedDirectoryEntryNames(root, 3, 'fixture directory')].sort()).toEqual([
        'a',
        'b',
        'c',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
