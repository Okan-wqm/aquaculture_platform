import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { createBaseEvent, type UserDeletedEvent } from '../index';

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
      .filter(
        ({ source }) =>
          /createBaseEvent\(\s*['"]MessageSent['"]/.test(source) ||
          /eventType:\s*['"]MessageSent['"]/.test(source) ||
          /events\.\*\.MessageSent/.test(source),
      )
      .map(({ path }) => path.replace(`${repoRoot}/`, ''));

    expect(offenders).toEqual([]);
  });

  it('keeps UserDeleted requester separate from the deleted user target', () => {
    const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const requesterId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const deletedUserId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

    const event: UserDeletedEvent = {
      ...createBaseEvent<UserDeletedEvent>('UserDeleted', tenantId, {
        userId: requesterId,
      }),
      deletedUserId,
    };

    expect(event.userId).toBe(requesterId);
    expect(event.deletedUserId).toBe(deletedUserId);
    expect(event.userId).not.toBe(event.deletedUserId);
  });
});
