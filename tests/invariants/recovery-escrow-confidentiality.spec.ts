import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

import { stripComments } from './helpers/ts-source';

/**
 * ADR-048 DEC-14.3 — a device's `/data` recovery envelope leaves the cloud only through
 * the audited retrieval.
 *
 * The envelope is ciphertext for an offline HSM, so holding it is not holding a key, but
 * it is what a custodian quorum needs to open a volume, and the record of who took it is
 * the point of keeping it. In comment-stripped source this spec pins:
 *
 *   - the escrow tables are read and written only by `RecoveryKeyEscrowService` (the
 *     entities, the migration and the registries that list a table aside);
 *   - the escrow entities carry no GraphQL decorator, so no resolver can expose a column;
 *   - the service writes the retrieval record before it returns the envelope, in the same
 *     transaction callback;
 *   - no log call of the service carries the ciphertext or the document;
 *   - the console types hold no ciphertext of their own: the status type has no such member
 *     and the retrieval type carries one opaque `envelope`;
 *   - nothing in production calls `record` yet. The envelope's delivery is not defined in
 *     `contracts/suderra-edge/v1` (Suderra-OS docs/security/data-recovery.md, "What is still
 *     missing"), and the cloud does not invent an unauthenticated one: the day a transport
 *     is added, this assertion changes in the same commit as the contract that defines it.
 */

const REPO_ROOT = join(__dirname, '..', '..');
const SENSOR = 'apps/sensor-service/src/';
const SERVICE = `${SENSOR}edge-device/recovery-key-escrow.service.ts`;
const ENTITIES = [
  `${SENSOR}edge-device/entities/recovery-key-escrow.entity.ts`,
  `${SENSOR}edge-device/entities/recovery-key-escrow-retrieval.entity.ts`,
];
const DTO = `${SENSOR}edge-device/dto/recovery-key-escrow.dto.ts`;
const ALLOWED_TOUCHERS = new Set([
  SERVICE,
  ...ENTITIES,
  `${SENSOR}database/migrations/1833000000000-RecoveryKeyEscrow.ts`,
  `${SENSOR}app.module.ts`,
  `${SENSOR}edge-device/edge-device.module.ts`,
  'libs/backend-common/src/database/schema-manager.service.ts',
]);

function productionSources(): string[] {
  return execFileSync(
    'git',
    ['-C', REPO_ROOT, 'ls-files', 'apps/*.ts', 'libs/*.ts', 'platform/*.ts'],
    { encoding: 'utf8' },
  )
    .split('\n')
    .filter(
      (path) =>
        path.endsWith('.ts') &&
        !path.endsWith('.spec.ts') &&
        !path.endsWith('.test.ts') &&
        !path.endsWith('.d.ts') &&
        !/\/(__tests__|__mocks__|test-helpers|testing)\//.test(path),
    );
}

const read = (path: string): string => stripComments(readFileSync(join(REPO_ROOT, path), 'utf8'));

/** The text of each `this.logger.<level>(…)` call, parentheses balanced. */
function logCalls(source: string): string[] {
  const calls: string[] = [];
  const start = /this\.logger\.(?:log|warn|error|debug|verbose)\(/g;
  for (let match = start.exec(source); match !== null; match = start.exec(source)) {
    let depth = 1;
    let end = match.index + match[0].length;
    while (end < source.length && depth > 0) {
      const ch = source[end];
      if (ch === '(') depth += 1;
      if (ch === ')') depth -= 1;
      end += 1;
    }
    calls.push(source.slice(match.index, end));
  }
  return calls;
}

/** The body of `async <name>(` up to the next method at the class's indentation. */
function methodBody(source: string, name: string): string {
  const start = source.indexOf(`async ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const rest = source.slice(start + 1);
  const next = rest.search(/\n {2}(?:private |protected |public )?(?:async )?[A-Za-z]+\(/);
  return next === -1 ? rest : rest.slice(0, next);
}

describe('recovery escrow confidentiality (ADR-048 DEC-14.3)', () => {
  it('the escrow tables are touched only by the escrow service', () => {
    const touchers = productionSources().filter((path) =>
      /recovery_key_escrow|RecoveryKeyEscrow/.test(read(path)),
    );
    const unexpected = touchers.filter(
      (path) => !ALLOWED_TOUCHERS.has(path) && !/recovery-key-escrow/.test(path),
    );
    expect(unexpected).toEqual([]);
    expect(touchers).toContain(SERVICE);
  });

  it('no escrow entity has a GraphQL field', () => {
    for (const path of ENTITIES) {
      const source = read(path);
      expect(source).not.toMatch(/@ObjectType|@Field\b|@InputType|@nestjs\/graphql/);
    }
  });

  it('the service writes the retrieval record before it returns the envelope', () => {
    const body = methodBody(read(SERVICE), 'retrieve');
    const insert = body.indexOf('INSERT INTO recovery_key_escrow_retrievals');
    const read_ = body.indexOf('FROM recovery_key_escrows');
    const handOut = body.indexOf('return rows.map');
    expect(read_).toBeGreaterThan(-1);
    expect(insert).toBeGreaterThan(read_);
    expect(handOut).toBeGreaterThan(insert);
  });

  it('no log call of the service carries the ciphertext or the document', () => {
    const calls = logCalls(read(SERVICE));
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call).not.toMatch(/ciphertext/i);
      expect(call).not.toMatch(/\bdocument\b/);
      expect(call).not.toMatch(/\benvelope\s*[:,}]/);
      expect(call).not.toMatch(/\.\.\.envelope|\.\.\.row|\bretrieved\b/);
    }
  });

  it('the console types hold no ciphertext member of their own', () => {
    const dto = read(DTO);
    expect(dto).not.toMatch(/ciphertext\s*[!?]?:/i);
    const retrieval = dto.slice(dto.indexOf("@ObjectType('RetrievedRecoveryEscrow')"));
    expect((retrieval.match(/@Field\(/g) ?? []).length).toBe(4);
    expect(retrieval).toContain('envelope!: string;');
  });

  it('nothing in production delivers an envelope to the service until the contract defines the transport', () => {
    const callers = productionSources().filter(
      (path) =>
        path !== SERVICE &&
        /\bescrow\.record\s*\(|RecoveryKeyEscrowService[\s\S]{0,400}\.record\(/.test(read(path)),
    );
    expect(callers).toEqual([]);
  });
});
