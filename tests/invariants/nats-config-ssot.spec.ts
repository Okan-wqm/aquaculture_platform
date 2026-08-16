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

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { listEffectiveWorktreeFiles } from './lib/effective-worktree-files';

const REPO_ROOT = resolve(__dirname, '..', '..');

function filesContaining(pattern: RegExp): readonly string[] {
  return listEffectiveWorktreeFiles(REPO_ROOT, ['apps/', 'libs/', 'platform/'])
    .filter((file) => /\.(?:ts|tsx)$/u.test(file))
    .filter((file) => pattern.test(readFileSync(resolve(REPO_ROOT, file), 'utf8')));
}

describe('INVARIANT (Config SSoT 3a): NATS config flows through buildEventBusConfig', () => {
  it('no service app.module.ts re-inlines the NATS URL / stream-name literals', () => {
    const offenders = filesContaining(/nats:\/\/localhost:4222|AQUACULTURE_EVENTS/u).filter((f) =>
      /^apps\/[^/]+\/src\/app\.module\.ts$/.test(f),
    );
    expect(offenders).toEqual([]);
  });

  it('DEFAULT_NATS_URL is declared exactly once by the event-bus transport', () => {
    const decls = filesContaining(/export const DEFAULT_NATS_URL\b/u).filter(
      (f) => !f.endsWith('.spec.ts') && !f.includes('/__tests__/'),
    );
    expect(decls).toEqual(['platform/libs/event-bus/src/nats/nats-connection.factory.ts']);
  });

  it('DEFAULT_NATS_STREAM_NAME is declared exactly once (event-bus factory)', () => {
    const decls = filesContaining(/export const DEFAULT_NATS_STREAM_NAME\b/u).filter(
      (f) => !f.endsWith('.spec.ts') && !f.includes('/__tests__/'),
    );
    expect(decls).toEqual(['platform/libs/event-bus/src/nats/event-bus-config.factory.ts']);
  });

  it('keeps the transport dependency graph one-way', () => {
    const offenders = listEffectiveWorktreeFiles(REPO_ROOT, ['platform/libs/event-bus/'])
      .filter((file) => /\.(?:ts|tsx)$/u.test(file))
      .filter((file) =>
        /from ['"]@(?:aquaculture|platform)\/backend-common(?:\/[^'"]+)?['"]/u.test(
          readFileSync(resolve(REPO_ROOT, file), 'utf8'),
        ),
      );

    expect(offenders).toEqual([]);
  });
});
