import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

function readRepoFile(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf8');
}

describe('INVARIANT: React Router 7 source contracts', () => {
  it('does not pass removed v7 future flags to declarative routers', () => {
    const files = execFileSync('git', ['ls-files', '-z', '--', 'web/**/*.ts', 'web/**/*.tsx'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
      .split('\0')
      .filter(Boolean);

    for (const file of files) {
      expect(readRepoFile(file)).not.toMatch(/v7_(?:startTransition|relativeSplatPath)/);
    }
  });

  it('keeps one declarative NavigateFunction owner in each deployable type graph', () => {
    const owners = [
      {
        declaration: 'web/shared-ui/src/types/react-router-declarative.ts',
        probe: 'web/shared-ui/src/types/react-router-declarative.compile-probe.ts',
        entrypoint: 'web/shared-ui/src/types/index.ts',
      },
      {
        declaration: 'web/apps/aquamobil/src/types/react-router-declarative.ts',
        probe: 'web/apps/aquamobil/src/types/react-router-declarative.compile-probe.ts',
      },
    ] as const;

    const requiredFiles = owners.flatMap((owner) => [owner.declaration, owner.probe]);
    expect(requiredFiles.filter((file) => !existsSync(resolve(REPO_ROOT, file)))).toEqual([]);

    for (const owner of owners) {
      const augmentation = readRepoFile(owner.declaration);
      const probe = readRepoFile(owner.probe);

      expect(augmentation).toMatch(/declare module ['"]react-router['"]/);
      expect(augmentation).toMatch(/interface NavigateFunction/);
      expect(augmentation).toMatch(/\(to: To, options\?: NavigateOptions\): void/);
      expect(augmentation).toMatch(/\(delta: number\): void/);
      expect(augmentation).toContain('export type DeclarativeNavigateResult');
      expect(probe).toContain("const pathResult: DeclarativeNavigateResult = navigate('/x')");
      expect(probe).toContain('const deltaResult: DeclarativeNavigateResult = navigate(-1)');
    }

    expect(readRepoFile(owners[0].entrypoint)).toContain(
      "export type { DeclarativeNavigateResult } from './react-router-declarative'",
    );
    expect(readRepoFile('web/shared-ui/src/index.ts')).toContain('DeclarativeNavigateResult');
    expect(readRepoFile(owners[1].declaration)).not.toContain('@aquaculture/shared-ui');
    expect(readRepoFile(owners[1].probe)).not.toContain('@aquaculture/shared-ui');
  });

  it('declares all sensor lazy providers before DataProviderRoot renders', () => {
    const source = readRepoFile('web/modules/sensor-module/src/providers/DataProviderContext.tsx');
    const rootOffset = source.indexOf('export const DataProviderRoot');
    const lazyOffsets = [...source.matchAll(/React\.lazy\(/g)].map((match) => match.index);

    expect(rootOffset).toBeGreaterThan(-1);
    expect(lazyOffsets).toHaveLength(3);
    expect(lazyOffsets.every((offset) => offset < rootOffset)).toBe(true);
  });
});
