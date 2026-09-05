/**
 * INVARIANT — every admin-api mutation handler is audited by the awaited,
 * transaction-aware interceptor (ADMIN-CRITICAL-008).
 *
 * Until 2026-09-05 admin-api-service had 246 POST/PUT/PATCH/DELETE handlers
 * and zero @AuditedOperation decorators; the only audit rows were the ones a
 * handful of handlers wrote by hand through a writer that swallowed
 * failures. This spec reflects on every controller in the service:
 *
 *   1. A handler decorated @Post/@Put/@Patch/@Delete must also carry
 *      @AuditedOperation in the same decorator block, or be listed in the
 *      governed ratchet `.claude/allowlists/admin-unaudited-mutations.yaml`
 *      with owner, future expiry, findingId and reason.
 *   2. Every ratchet entry must name a handler that is genuinely unaudited;
 *      decorating a handler without removing its entry fails, so the list
 *      only shrinks.
 *   3. The service registers AuditedOperationModule.forRoot() (the decorator
 *      is inert metadata otherwise) and lists AuditLogEntity in its TypeORM
 *      metadata (the interceptor writes through getRepository).
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import * as yaml from 'js-yaml';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SERVICE_SRC = 'apps/admin-api-service/src';
const ALLOWLIST = '.claude/allowlists/admin-unaudited-mutations.yaml';

interface AllowlistEntry {
  handler: string;
  owner: string;
  expiry: string | Date;
  findingId: string;
  reason: string;
}

interface Handler {
  readonly id: string;
  readonly audited: boolean;
}

function read(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), 'utf8');
}

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(?<!:)\/\/.*$/, ''))
    .join('\n');
}

function controllerFiles(): string[] {
  return execFileSync(
    'git',
    [
      '-C',
      REPO_ROOT,
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      `${SERVICE_SRC}/**/*.controller.ts`,
    ],
    {
      encoding: 'utf8',
    },
  )
    .split('\n')
    .filter((rel) => rel.length > 0 && !rel.endsWith('.spec.ts'));
}

const HTTP_MUTATION = /^\s*@(Post|Put|Patch|Delete)\(/;
const SIGNATURE = /^\s*(?:async\s+)?([A-Za-z_]\w*)\s*\(/;

/** Every mutation handler in a controller, with whether its decorator block audits it. */
function mutationHandlers(rel: string): Handler[] {
  const lines = stripComments(read(rel)).split('\n');
  const handlers: Handler[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!HTTP_MUTATION.test(lines[i] ?? '')) continue;
    // Walk back over the contiguous decorator block, then forward to the signature.
    let start = i;
    while (start > 0 && /^\s*@/.test(lines[start - 1] ?? '')) start -= 1;
    let name: string | undefined;
    // The signature is the first non-decorator line after the block.
    let sigIndex = i + 1;
    while (sigIndex < lines.length && /^\s*@|^\s*$/.test(lines[sigIndex] ?? '')) sigIndex += 1;
    // Multi-line decorator arguments end with ")"; skip continuation lines.
    while (sigIndex < lines.length && !SIGNATURE.test(lines[sigIndex] ?? '')) sigIndex += 1;
    name = SIGNATURE.exec(lines[sigIndex] ?? '')?.[1];
    if (!name) throw new Error(`${rel}:${i + 1}: mutation decorator with no handler signature`);
    const block = lines.slice(start, sigIndex).join('\n');
    handlers.push({ id: `${rel}#${name}`, audited: /@AuditedOperation\(/.test(block) });
    i = sigIndex;
  }
  return handlers;
}

describe('INVARIANT (ADMIN-CRITICAL-008): every admin mutation handler is audited', () => {
  const files = controllerFiles();
  const handlers = files.flatMap(mutationHandlers);
  const unaudited = handlers
    .filter((h) => !h.audited)
    .map((h) => h.id)
    .sort();
  const doc = yaml.load(read(ALLOWLIST)) as { entries?: AllowlistEntry[] };
  const entries = doc.entries ?? [];

  it('reflects on the fleet of admin controllers (sanity)', () => {
    expect(files.length).toBeGreaterThanOrEqual(20);
    expect(handlers.length).toBeGreaterThanOrEqual(200);
  });

  it('every unaudited mutation handler is governed by the ratchet', () => {
    const governed = new Set(entries.map((e) => e.handler));
    expect(unaudited.filter((id) => !governed.has(id))).toEqual([]);
  });

  it('the ratchet names only handlers that are genuinely unaudited, with owner, future expiry and finding', () => {
    const today = new Date().toISOString().slice(0, 10);
    const actual = new Set(unaudited);
    for (const entry of entries) {
      expect(actual.has(entry.handler)).toBe(true);
      expect(entry.owner).toMatch(/\S/);
      expect(entry.findingId).toMatch(/^[A-Z]+-[A-Z]+-\d+$/);
      expect(entry.reason).toMatch(/\S/);
      const expiry =
        entry.expiry instanceof Date ? entry.expiry.toISOString().slice(0, 10) : entry.expiry;
      expect(expiry).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(expiry > today).toBe(true);
    }
  });

  it('the service registers the interceptor and the shared audit entity', () => {
    const appModule = stripComments(read(`${SERVICE_SRC}/app.module.ts`));
    expect(appModule).toMatch(/AuditedOperationModule\.forRoot\(\)/);
    const auditModule = stripComments(read(`${SERVICE_SRC}/audit/audit.module.ts`));
    expect(auditModule).toMatch(/forFeature\(\[[^\]]*\bAuditLogEntity\b[^\]]*\]\)/);
  });
});
