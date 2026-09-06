// SCENARIO: the principals file — who may open the console, as what, on which cases.
// EXPECTS: first boot seeds the operator behind the shared token and nobody
// else; a principal is added with a token shown once and stored only as a
// digest; the token resolves to that principal and to nobody after revocation;
// every malformed shape fails closed; the CLI does the same over argv.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ConfigError } from '../src/config.ts';
import { runPrincipalsCli } from '../src/principals-cli.ts';
import { addPrincipal, canSeeCase, loadOrCreatePrincipals, loadPrincipals, parsePrincipalsFile, revokePrincipal, tokenDigest } from '../src/principals.ts';

const NOW = '2026-09-05T08:00:00.000Z';

function file(label: string): string {
  return join(mkdtempSync(join(tmpdir(), `aria-principals-${label}-`)), 'principals.json');
}

test('first boot seeds the operator behind the shared token — a real credential, never an invented one — with owner-only permissions', () => {
  const path = file('seed');
  const directory = loadOrCreatePrincipals(path, { id: 'console-token-holder', displayName: 'Console token holder', tokenSha256: tokenDigest('shared-operator-token-0123456789') }, NOW);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(directory.list().length, 1);
  assert.equal(directory.list()[0]?.role, 'operator');
  assert.equal(directory.list()[0]?.cases, '*');
  assert.equal(directory.resolve('shared-operator-token-0123456789')?.id, 'console-token-holder');
  assert.equal(directory.resolve('wrong'), null);
  // Without a seed the file is empty: nobody is invented.
  const empty = loadOrCreatePrincipals(file('empty'), null, NOW);
  assert.deepEqual(empty.list(), []);
});

test('a principal is added with a token shown once; only its digest is stored; the token resolves to the principal with its cases', () => {
  const path = file('add');
  loadOrCreatePrincipals(path, null, NOW);
  const { token, record } = addPrincipal(path, { id: 'kari', displayName: 'Advokat Kari Nordmann', role: 'lawyer', cases: ['sak-24-001', 'sak-24-003'] }, NOW);
  assert.ok(token.length >= 40);
  assert.ok(!readFileSync(path, 'utf8').includes(token), 'the token never reaches the disk');
  assert.equal(record.tokenSha256, tokenDigest(token));
  const directory = loadPrincipals(path);
  const principal = directory.resolve(token);
  assert.ok(principal);
  assert.equal(principal.id, 'kari');
  assert.equal(principal.role, 'lawyer');
  assert.deepEqual(principal.cases, ['sak-24-001', 'sak-24-003']);
  assert.equal(canSeeCase(principal, 'sak-24-001'), true);
  assert.equal(canSeeCase(principal, 'sak-24-002'), false);
  assert.equal(canSeeCase({ ...principal, cases: '*' }, 'sak-24-002'), true);
  // The same id cannot be added twice.
  assert.throws(() => addPrincipal(path, { id: 'kari', displayName: 'x', role: 'lawyer', cases: '*' }, NOW), ConfigError);
});

test('a revoked principal identifies nobody, and the record stays so past receipts keep naming a known id', () => {
  const path = file('revoke');
  const { token } = addPrincipal(path, { id: 'ola', displayName: 'Ola Operator', role: 'operator', cases: '*' }, NOW);
  assert.equal(loadPrincipals(path).resolve(token)?.id, 'ola');
  const revoked = revokePrincipal(path, 'ola', '2026-09-06T00:00:00.000Z');
  assert.equal(revoked.revokedAt, '2026-09-06T00:00:00.000Z');
  assert.equal(loadPrincipals(path).resolve(token), null);
  assert.equal(loadPrincipals(path).list().length, 1, 'the record is kept');
  assert.throws(() => revokePrincipal(path, 'nobody', NOW), ConfigError);
});

test('every malformed shape fails closed: bad JSON, unknown schema, bad id, alien role, bad digest, bad case id, duplicate id, shared digest', () => {
  const good = { id: 'kari', displayName: 'Kari', role: 'lawyer', tokenSha256: 'a'.repeat(64), cases: ['sak-24-001'], createdAt: NOW, revokedAt: null };
  const refuse = (text: string, why: RegExp): void => assert.throws(() => parsePrincipalsFile(text, '/p.json'), why);
  refuse('{ not json', /not valid JSON/);
  refuse(JSON.stringify({ schemaVersion: 2, principals: [] }), /schemaVersion 2/);
  refuse(JSON.stringify({ schemaVersion: 1, principals: [{ ...good, id: 'Kari Nordmann' }] }), /id must match/);
  refuse(JSON.stringify({ schemaVersion: 1, principals: [{ ...good, role: 'auditor' }] }), /role must be one the console can authenticate/);
  refuse(JSON.stringify({ schemaVersion: 1, principals: [{ ...good, tokenSha256: 'abc' }] }), /tokenSha256/);
  refuse(JSON.stringify({ schemaVersion: 1, principals: [{ ...good, cases: ['Bad Case'] }] }), /cases must be/);
  refuse(JSON.stringify({ schemaVersion: 1, principals: [good, { ...good, tokenSha256: 'b'.repeat(64) }] }), /declared twice/);
  refuse(JSON.stringify({ schemaVersion: 1, principals: [good, { ...good, id: 'ola' }] }), /share one token digest/);
  const path = file('missing');
  assert.throws(() => loadPrincipals(path), ConfigError);
  writeFileSync(path, '[]');
  assert.throws(() => loadPrincipals(path), /must be a JSON object/);
});

test('offline CLI explicitly locks storage and adds, lists and revokes without disclosing stored digests', async () => {
  const path = file('cli');
  const env = { ARIA_UI_PRINCIPALS_FILE: path, ARIA_TOOLS_DIR: path + '-tools' };
  const added = JSON.parse(await runPrincipalsCli(['add', '--offline', '--id', 'kari', '--display', 'Kari', '--role', 'lawyer', '--cases', '*'], env, NOW));
  assert.equal(loadPrincipals(path).resolve(added.token)?.id, 'kari');
  const listed = await runPrincipalsCli(['list', '--offline'], env, NOW);
  assert.match(listed, /kari/);
  assert.ok(!listed.includes('tokenSha256'));
  assert.ok(!listed.includes(added.token));
  await runPrincipalsCli(['revoke', '--offline', '--id', 'kari'], env, NOW);
  assert.equal(loadPrincipals(path).resolve(added.token), null);
  await assert.rejects(runPrincipalsCli(['list', '--file', path], env, NOW), /explicit --offline/);
  assert.ok(existsSync(path));
});


test('existing principals are never reseeded when bootstrap token changes', () => {
  const path = file('no-reseed');
  loadOrCreatePrincipals(path, { id: 'original', displayName: 'Original', tokenSha256: tokenDigest('original-token') }, NOW);
  const before = readFileSync(path, 'utf8');
  const loaded = loadOrCreatePrincipals(path, { id: 'replacement', displayName: 'Replacement', tokenSha256: tokenDigest('replacement-token') }, NOW);
  assert.equal(readFileSync(path, 'utf8'), before);
  assert.equal(loaded.resolve('replacement-token'), null);
  assert.equal(loaded.resolve('original-token')?.id, 'original');
});


test('revoked bootstrap identity cannot be recreated when an initialized principal file disappears', async () => {
  const path = file('deleted-authority');
  const seed = { id: 'original', displayName: 'Original', tokenSha256: tokenDigest('old-bootstrap-token') };
  loadOrCreatePrincipals(path, seed, NOW);
  revokePrincipal(path, seed.id, NOW);
  unlinkSync(path);
  assert.throws(() => loadOrCreatePrincipals(path, seed, NOW), /initialized principal store is missing/);
  assert.equal(existsSync(path), false);
  assert.throws(() => addPrincipal(path, { id: 'replacement', displayName: 'Replacement', role: 'operator', cases: '*' }, NOW), /initialized principal store is missing/);
  await assert.rejects(runPrincipalsCli(['add', '--offline', '--id', 'replacement', '--display', 'Replacement', '--role', 'operator', '--cases', '*'], { ARIA_TOOLS_DIR: path + '-tools', ARIA_UI_PRINCIPALS_FILE: path }, NOW), /initialized principal store is missing/);
  assert.equal(existsSync(path), false);
});

test('legacy existing store gains metadata-only initialization marker without changing identities', () => {
  const path = file('legacy-marker');
  const original = JSON.stringify({ schemaVersion: 1, principals: [{ id: 'legacy', displayName: 'Legacy', role: 'operator', tokenSha256: tokenDigest('legacy-token'), cases: '*', createdAt: NOW, revokedAt: NOW }] });
  writeFileSync(path, original);
  const directory = loadOrCreatePrincipals(path, null, NOW);
  assert.equal(readFileSync(path, 'utf8'), original);
  assert.equal(directory.resolve('legacy-token'), null);
  assert.deepEqual(JSON.parse(readFileSync(path + '.initialized', 'utf8')), { schemaVersion: 1, initialized: true });
  assert.equal(statSync(path + '.initialized').mode & 0o777, 0o600);
});

test('invalid or interrupted initialization marker never authorizes a new seed', () => {
  for (const marker of ['', '{', '{"schemaVersion":2,"initialized":true}', '{"schemaVersion":1,"initialized":false}']) {
    const path = file('invalid-marker');
    writeFileSync(path + '.initialized', marker);
    assert.throws(() => loadOrCreatePrincipals(path, { id: 'original', displayName: 'Original', tokenSha256: tokenDigest('old-token') }, NOW), /initialization marker/);
    assert.equal(existsSync(path), false);
    assert.equal(readFileSync(path + '.initialized', 'utf8'), marker);
  }
});
