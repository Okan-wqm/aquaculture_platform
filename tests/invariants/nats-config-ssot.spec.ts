/**
 * Platform-wide invariant — Config SSoT (Cluster 3a):
 *
 * Every service's EventBusModule.forRootAsync must flow through the single
 * `buildEventBusConfig` factory (platform/libs/event-bus). The NATS URL +
 * JetStream stream-name defaults live ONCE (DEFAULT_NATS_URL /
 * DEFAULT_NATS_STREAM_NAME); a service `app.module.ts` may not re-inline the
 * `nats://localhost:4222` / `AQUACULTURE_EVENTS` literals (the hand-copied
 * `useFactory: (cs) => ({ natsUrl: cs.get('NATS_URL', '...'), ... })` that was
 * duplicated into 10 modules).
 */

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

function gitGrepFiles(pattern: string): string[] {
  let out = '';
  try {
    out = execFileSync('git', ['-C', REPO_ROOT, 'grep', '-l', '-E', pattern], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    // git grep exits 1 when there are no matches.
    return [];
  }
  return out.split('\n').filter(Boolean);
}

describe('INVARIANT (Config SSoT 3a): NATS config flows through buildEventBusConfig', () => {
  it('no service app.module.ts re-inlines the NATS URL / stream-name literals', () => {
    const offenders = gitGrepFiles('nats://localhost:4222|AQUACULTURE_EVENTS').filter((f) =>
      /^apps\/[^/]+\/src\/app\.module\.ts$/.test(f),
    );
    expect(offenders).toEqual([]);
  });

  it('DEFAULT_NATS_URL is declared exactly once (backend-common connection layer)', () => {
    // Exclude test files — this very spec mentions the symbol in its grep pattern.
    const decls = gitGrepFiles('export const DEFAULT_NATS_URL\\b').filter(
      (f) => !f.endsWith('.spec.ts') && !f.includes('/__tests__/'),
    );
    expect(decls).toEqual([
      'libs/backend-common/src/nats/nats-connection.factory.ts',
    ]);
  });

  it('DEFAULT_NATS_STREAM_NAME is declared exactly once (event-bus factory)', () => {
    const decls = gitGrepFiles('export const DEFAULT_NATS_STREAM_NAME\\b').filter(
      (f) => !f.endsWith('.spec.ts') && !f.includes('/__tests__/'),
    );
    expect(decls).toEqual([
      'platform/libs/event-bus/src/nats/event-bus-config.factory.ts',
    ]);
  });
});
