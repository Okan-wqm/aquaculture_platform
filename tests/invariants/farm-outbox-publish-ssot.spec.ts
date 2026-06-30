/**
 * INVARIANT: farm-service command handlers emit domain events through the
 * transactional OUTBOX, never a direct `eventBus.publish(...)`.
 *
 * WHY: a post-commit `eventBus.publish()` is at-most-once — a NATS outage
 * between the DB commit and the publish silently drops the event, and for
 * stock movements that drop includes the LowStockDetected reorder alert
 * (ORPHAN-MEDIUM-266). The correct pattern enqueues the event via
 * `OutboxPublisher.enqueue(event, manager)` INSIDE the write transaction, so the
 * outbox row commits atomically with the domain write (at-least-once) and a
 * relay worker delivers it. This invariant fails the build if a command handler
 * reintroduces a direct publish. Comments that merely mention the old pattern
 * are stripped before scanning.
 *
 * Scope: every `*.handler.ts` under `apps/farm-service/src` whose class
 * implements `ICommandHandler`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, relative, normalize, join, sep } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const FARM_SRC = resolve(REPO_ROOT, 'apps/farm-service/src');

const DIRECT_PUBLISH = /\beventBus\s*\??\.\s*publish\s*\(/;

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '') // block + JSDoc comments
    .replace(/(^|[^:])\/\/.*$/gm, '$1'); // line comments (not URLs)
}

function findCommandHandlerFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && !entry.name.startsWith('.')) {
        files.push(...findCommandHandlerFiles(fullPath));
      }
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.handler.ts') && !entry.name.endsWith('.spec.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

describe('INVARIANT: farm command handlers emit domain events via the outbox', () => {
  it('has no command handler calling eventBus.publish() directly (use OutboxPublisher.enqueue)', () => {
    const violations = findCommandHandlerFiles(FARM_SRC)
      .map((file) => ({
        relativePath: normalize(relative(FARM_SRC, file)).split(sep).join('/'),
        content: readFileSync(file, 'utf-8'),
      }))
      .filter(({ content }) => /\bICommandHandler\b/.test(content))
      .filter(({ content }) => DIRECT_PUBLISH.test(stripComments(content)))
      .map(({ relativePath }) => relativePath);

    expect(violations).toEqual([]);
  });
});
