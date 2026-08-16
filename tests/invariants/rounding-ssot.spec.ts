import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const ROUNDING_AUTHORITY = 'apps/farm-service/src/common/utils/rounding.util.ts';
const GUARDED_HELPERS = ['round2', 'round3'] as const;

function farmTypeScriptFiles(): string[] {
  return execFileSync('rg', ['--files', 'apps/farm-service/src', '-g', '*.ts'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\n')
    .filter(Boolean);
}

describe('farm quantity rounding authority', () => {
  it('keeps every production rounding helper behind the common SSOT', () => {
    const files = farmTypeScriptFiles();
    expect(files).toContain(ROUNDING_AUTHORITY);

    const violations: string[] = [];
    for (const file of files.filter((candidate) => !candidate.endsWith('.spec.ts'))) {
      const source = readFileSync(join(REPO_ROOT, file), 'utf8');
      source.split('\n').forEach((line, index) => {
        for (const helper of GUARDED_HELPERS) {
          const declaresHelper =
            new RegExp(`\\bfunction\\s+${helper}\\s*\\(`).test(line) ||
            new RegExp(`\\b(?:const|let)\\s+${helper}\\s*[:=]`).test(line);
          if (declaresHelper && file !== ROUNDING_AUTHORITY) {
            violations.push(`${file}:${index + 1} redeclares ${helper}`);
          }
        }
      });
    }

    expect(violations).toEqual([]);
  });

  it('exports both governed precisions from one implementation file', () => {
    const authority = readFileSync(join(REPO_ROOT, ROUNDING_AUTHORITY), 'utf8');
    for (const helper of GUARDED_HELPERS) {
      expect(authority).toMatch(new RegExp(`export function ${helper}\\s*\\(`));
    }
  });
});
