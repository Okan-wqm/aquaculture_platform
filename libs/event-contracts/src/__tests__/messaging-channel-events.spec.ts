import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

describe('messaging channel event contract', () => {
  const repoRoot = process.cwd();

  function readSourceFiles(dir: string): Array<{ path: string; source: string }> {
    const entries = readdirSync(dir);
    const files: Array<{ path: string; source: string }> = [];

    for (const entry of entries) {
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        if (entry === '__tests__') continue;
        files.push(...readSourceFiles(fullPath));
      } else if (entry.endsWith('.ts')) {
        files.push({ path: fullPath, source: readFileSync(fullPath, 'utf8') });
      }
    }

    return files;
  }

  it('does not emit legacy MessageSent from channel messaging code', () => {
    const channelMessagingDirs = [
      join(repoRoot, 'apps/messaging-service/src/channel'),
      join(repoRoot, 'apps/messaging-service/src/message'),
      join(repoRoot, 'apps/messaging-service/src/notification'),
    ];

    const offenders = channelMessagingDirs
      .flatMap(readSourceFiles)
      .filter(({ source }) =>
        /createBaseEvent\(\s*['"]MessageSent['"]/.test(source) ||
        /eventType:\s*['"]MessageSent['"]/.test(source) ||
        /events\.\*\.MessageSent/.test(source),
      )
      .map(({ path }) => path.replace(`${repoRoot}/`, ''));

    expect(offenders).toEqual([]);
  });
});
