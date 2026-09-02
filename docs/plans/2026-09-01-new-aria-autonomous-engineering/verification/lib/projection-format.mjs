import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

export function formatProjection(repositoryRoot, path, content) {
  const result = spawnSync(
    join(repositoryRoot, 'node_modules/.bin/prettier'),
    [
      '--config',
      join(repositoryRoot, '.prettierrc'),
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
