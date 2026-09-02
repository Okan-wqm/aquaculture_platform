import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

export function formatProjection(sourceRepositoryRoot, runtimeRepositoryRoot, path, content) {
  const result = spawnSync(
    process.execPath,
    [
      join(runtimeRepositoryRoot, 'node_modules/prettier/bin/prettier.cjs'),
      '--config',
      join(sourceRepositoryRoot, '.prettierrc'),
      '--prose-wrap',
      'always',
      '--stdin-filepath',
      path,
    ],
    { input: content, encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`projection formatting failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}
