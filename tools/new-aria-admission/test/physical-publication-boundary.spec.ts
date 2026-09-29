import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertPhysicalPathSeparation,
  assertSafeTemporaryParent,
} from '../src/runtime/physical-publication-boundary';

describe('physical publication boundary', () => {
  it('allows a repository below a shared temp parent but rejects temp storage inside it', () => {
    const parent = mkdtempSync(join(tmpdir(), 'new-aria-physical-boundary-'));
    const repository = mkdtempSync(join(parent, 'repository-'));
    try {
      expect(() => assertSafeTemporaryParent(parent, [repository])).not.toThrow();
      expect(() => assertSafeTemporaryParent(repository, [repository])).toThrow(/overlap/i);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('accepts a safe temp symlink alias but rejects an alias into a protected root', () => {
    const parent = mkdtempSync(join(tmpdir(), 'new-aria-temp-alias-'));
    const repository = mkdtempSync(join(parent, 'repository-'));
    const safe = mkdtempSync(join(parent, 'safe-'));
    const safeAlias = join(parent, 'safe-alias');
    const repositoryAlias = join(parent, 'repository-alias');
    symlinkSync(safe, safeAlias);
    symlinkSync(repository, repositoryAlias);
    try {
      expect(() => assertSafeTemporaryParent(safeAlias, [repository])).not.toThrow();
      expect(() => assertSafeTemporaryParent(repositoryAlias, [repository])).toThrow(/overlap/i);
      expect(() => assertSafeTemporaryParent(repository, [repository, safe])).toThrow(/overlap/i);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('rejects a mutation path whose symlink parent aliases a protected resource', () => {
    const parent = mkdtempSync(join(tmpdir(), 'new-aria-physical-alias-'));
    const protectedRoot = mkdtempSync(join(parent, 'protected-'));
    const alias = join(parent, 'alias');
    symlinkSync(protectedRoot, alias);
    try {
      expect(() =>
        assertPhysicalPathSeparation(
          [join(alias, 'result.json')],
          [join(protectedRoot, 'input.json')],
        ),
      ).toThrow(/physically canonical|overlap/i);
      expect(() =>
        assertPhysicalPathSeparation(
          [join(protectedRoot, 'input.json')],
          [join(alias, 'input.json')],
        ),
      ).toThrow(/overlap/i);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
