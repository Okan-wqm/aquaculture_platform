/**
 * `suderra.result.v1` as the cloud accepts it (ADR-048 DEC-27): every golden
 * fixture of the contract (`fixtures/result/valid`, `fixtures/result/invalid`)
 * is judged the way the contract says, by the cloud's own parser, so the
 * cloud cannot accept a document the contract refuses or refuse one it allows.
 */
import { readdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';

import {
  MAX_RESULT_BYTES,
  parseResultDocument,
  RESULT_KINDS,
  RESULT_OUTCOMES,
  ResultDocumentError,
  TIME_STATES,
} from '../edge-result-document';

const FIXTURES = resolve(__dirname, '../../../../../contracts/suderra-edge/v1/fixtures/result');

const files = (dir: 'valid' | 'invalid'): string[] =>
  readdirSync(join(FIXTURES, dir)).filter((name) => name.endsWith('.json'));
const bytes = (dir: 'valid' | 'invalid', name: string): Buffer =>
  readFileSync(join(FIXTURES, dir, name));

describe('the cloud parses result documents exactly as the contract fixtures say', () => {
  it('the fixture sets are not empty', () => {
    expect(files('valid').length).toBeGreaterThanOrEqual(20);
    expect(files('invalid').length).toBeGreaterThanOrEqual(10);
  });

  it.each(files('valid'))('accepts valid/%s and keeps every member', (name) => {
    const raw = bytes('valid', name);
    const result = parseResultDocument(raw);
    const original = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
    expect(JSON.parse(JSON.stringify(result))).toEqual(original);
  });

  it.each(files('invalid'))('refuses invalid/%s', (name) => {
    expect(() => parseResultDocument(bytes('invalid', name))).toThrow(ResultDocumentError);
  });
});

describe('what is not a result document', () => {
  const valid = bytes('valid', 'edge-update-ok.json');

  it('refuses a message over the size limit before parsing it', () => {
    const padded = Buffer.concat([valid, Buffer.alloc(MAX_RESULT_BYTES, 0x20)]);
    expect(() => parseResultDocument(padded)).toThrow(/bytes \(limit/);
  });

  it('refuses bytes that are not UTF-8, not JSON, or not an object', () => {
    expect(() => parseResultDocument(Buffer.from([0xff, 0xfe, 0x7b]))).toThrow(/UTF-8/);
    expect(() => parseResultDocument(Buffer.from('{"_type"'))).toThrow(/not JSON/);
    for (const text of ['[]', '"x"', '7', 'null']) {
      expect(() => parseResultDocument(Buffer.from(text))).toThrow(ResultDocumentError);
    }
  });

  it('refuses a document whose subject names a statement without its digest, for every update kind', () => {
    for (const kind of [
      'edge-update',
      'os-update',
      'site-config',
      'site-netpolicy',
      'trust-anchors',
    ]) {
      const doc = {
        _type: 'suderra.result.v1',
        seq: 5,
        kind,
        outcome: 'ok',
        occurred_at: '2026-10-20T11:20:00Z',
        time_state: 'synced-nts',
        board_profile: 'revpi-connect4',
        os_version: '1.0.0',
        subject: { statement_type: `suderra.${kind}.v1` },
      };
      expect(() => parseResultDocument(Buffer.from(JSON.stringify(doc)))).toThrow(
        ResultDocumentError,
      );
    }
  });

  it('names the schema members that failed, not the document content', () => {
    try {
      parseResultDocument(
        Buffer.from(
          JSON.stringify({ _type: 'suderra.result.v1', seq: 0, kind: 'nope', secret: 'xyz' }),
        ),
      );
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(ResultDocumentError);
      expect((error as ResultDocumentError).reasons.length).toBeGreaterThan(0);
      expect((error as ResultDocumentError).message).not.toContain('xyz');
    }
  });
});

describe('the vocabulary is the schema', () => {
  it('reads the kinds, outcomes and clock states from result.schema.json', () => {
    expect(RESULT_KINDS).toEqual(
      expect.arrayContaining(['edge-update', 'os-update', 'site-config']),
    );
    expect(RESULT_OUTCOMES).toEqual(['ok', 'rejected', 'failed', 'alarm']);
    expect(TIME_STATES).toEqual(['unsynced', 'synced-unauthenticated', 'synced-nts']);
  });
});
