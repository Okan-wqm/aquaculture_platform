// Principals — who may open this console, as what, and on which matters.
//
// WHY: authentication used to be one shared bearer token, and the author of
// every custody receipt was whatever the caller typed into a header. MEASURED
// 2026-09-04: any holder of the token saw every case, the five lawyer-owned
// gates in the approval policy could never be satisfied because nothing could
// tell a lawyer from an operator, and the receipt's `receivedBy` — the one
// field a custody claim rests on — was unauthenticated free text. A product
// that records who took delivery of evidence must know who that is.
//
// WHAT: a JSON file on the volume (never in the image or the repository)
// listing principals — id, display name, role, the SHA-256 of their token,
// the cases they are assigned to or `*`, and when they were created or
// revoked. Tokens themselves are never stored; a token is issued once by the
// CLI and its digest compared in constant time. The file fails closed: a
// malformed principal, a duplicate id, a role the console cannot authenticate,
// or a case id outside the contract's pattern refuses to load. On first boot
// the console seeds the file with the operator behind ARIA_UI_TOKEN, so the
// instance is usable before anyone is added, and never with anyone invented.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { LEGAL_CASE_ID_RE } from '../../shared/legal-contract.ts';
import { ConfigError } from './config.ts';
import type { Principal, PrincipalRole } from './principal.ts';
import { isPrincipalRole } from './principal.ts';

export const PRINCIPALS_SCHEMA_VERSION = 1 as const;
const PRINCIPAL_ID = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export interface PrincipalRecord extends Principal {
  readonly tokenSha256: string;
  readonly createdAt: string;
  readonly revokedAt: string | null;
}

export interface PrincipalsFile {
  readonly schemaVersion: typeof PRINCIPALS_SCHEMA_VERSION;
  readonly principals: ReadonlyArray<PrincipalRecord>;
}

export function tokenDigest(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function fail(path: string, detail: string): never {
  throw new ConfigError('ARIA_UI_PRINCIPALS_FILE', `${path}: ${detail}`);
}

function parseRecord(value: unknown, path: string, index: number): PrincipalRecord {
  const where = `principals[${index}]`;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(path, `${where} must be an object`);
  const row = value as Record<string, unknown>;
  const id = row['id'];
  if (typeof id !== 'string' || !PRINCIPAL_ID.test(id)) fail(path, `${where}.id must match ${PRINCIPAL_ID.source}`);
  const displayName = row['displayName'];
  if (typeof displayName !== 'string' || displayName.trim() === '' || displayName.length > 120) fail(path, `${where}.displayName must be a non-empty string of at most 120 characters`);
  const role = row['role'];
  if (typeof role !== 'string' || !isPrincipalRole(role)) fail(path, `${where}.role must be one the console can authenticate (operator, lawyer)`);
  const tokenSha256 = row['tokenSha256'];
  if (typeof tokenSha256 !== 'string' || !SHA256.test(tokenSha256)) fail(path, `${where}.tokenSha256 must be a 64-character hex digest`);
  const casesRaw = row['cases'];
  let cases: Principal['cases'];
  if (casesRaw === '*') cases = '*';
  else if (Array.isArray(casesRaw) && casesRaw.every((item) => typeof item === 'string' && LEGAL_CASE_ID_RE.test(item))) cases = [...(casesRaw as string[])].sort();
  else fail(path, `${where}.cases must be "*" or an array of case ids`);
  const createdAt = row['createdAt'];
  if (typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt))) fail(path, `${where}.createdAt must be an ISO date-time`);
  const revokedAt = row['revokedAt'];
  if (revokedAt !== null && (typeof revokedAt !== 'string' || Number.isNaN(Date.parse(revokedAt)))) fail(path, `${where}.revokedAt must be an ISO date-time or null`);
  return { id, displayName: displayName.trim(), role: role as PrincipalRole, cases, tokenSha256, createdAt, revokedAt: revokedAt as string | null };
}

export function parsePrincipalsFile(text: string, path: string): PrincipalsFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail(path, 'is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) fail(path, 'must be a JSON object');
  const file = parsed as Record<string, unknown>;
  if (file['schemaVersion'] !== PRINCIPALS_SCHEMA_VERSION) fail(path, `schemaVersion ${String(file['schemaVersion'])} is not one this console reads`);
  if (!Array.isArray(file['principals'])) fail(path, 'principals must be an array');
  const principals = (file['principals'] as unknown[]).map((row, index) => parseRecord(row, path, index));
  const ids = new Set<string>();
  const digests = new Set<string>();
  for (const principal of principals) {
    if (ids.has(principal.id)) fail(path, `principal id ${principal.id} is declared twice`);
    ids.add(principal.id);
    if (digests.has(principal.tokenSha256)) fail(path, `two principals share one token digest; one token identifies one person`);
    digests.add(principal.tokenSha256);
  }
  return { schemaVersion: PRINCIPALS_SCHEMA_VERSION, principals };
}

function writeAtomic(path: string, file: PrincipalsFile): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, path);
}

/** The loaded principals, answering "whose token is this?" in constant time per candidate. */
export class PrincipalDirectory {
  readonly path: string;
  private records: ReadonlyArray<PrincipalRecord>;

  constructor(path: string, file: PrincipalsFile) {
    this.path = path;
    this.records = file.principals;
  }

  /** The principal a token identifies, or null. A revoked principal identifies nobody. */
  resolve(token: string): Principal | null {
    const presented = Buffer.from(tokenDigest(token), 'hex');
    let found: PrincipalRecord | null = null;
    // Every record is compared, whatever the outcome, so timing says nothing
    // about which digest matched.
    for (const record of this.records) {
      const matches = timingSafeEqual(presented, Buffer.from(record.tokenSha256, 'hex'));
      if (matches && record.revokedAt === null) found = record;
    }
    if (found === null) return null;
    return { id: found.id, displayName: found.displayName, role: found.role, cases: found.cases };
  }

  reload(): void {
    this.records = loadPrincipals(this.path).list();
  }

  list(): ReadonlyArray<PrincipalRecord> {
    return this.records;
  }
}

export function loadPrincipals(path: string): PrincipalDirectory {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    fail(path, 'is unreadable');
  }
  return new PrincipalDirectory(path, parsePrincipalsFile(text, path));
}

const INITIALIZATION_MARKER = '{"schemaVersion":1,"initialized":true}\n';

function hasInitializationMarker(path: string): boolean {
  let text: string;
  try {
    text = readFileSync(`${path}.initialized`, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    fail(path, 'initialization marker is unreadable');
  }
  if (text !== INITIALIZATION_MARKER) fail(path, 'initialization marker is invalid');
  return true;
}

/** Publish and persist the tombstone before any first-store write can occur. */
function createInitializationMarker(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(`${path}.initialized`, 'wx', 0o600);
  try {
    writeFileSync(fd, INITIALIZATION_MARKER, 'utf8');
    fsyncSync(fd);
  } finally { closeSync(fd); }
  const directoryFd = openSync(dirname(path), 'r');
  try { fsyncSync(directoryFd); }
  finally { closeSync(directoryFd); }
}

/**
 * Loads the principals file, creating it on first boot with the operator
 * behind the shared token as its only entry. The seed is a real credential
 * the operator already holds, never an invented one; without a seed an empty
 * file is written and only the CLI can add a first principal. A durable marker
 * prevents a missing initialized store from ever reopening bootstrap eligibility.
 */
export function loadOrCreatePrincipals(path: string, seed: { readonly id: string; readonly displayName: string; readonly tokenSha256: string } | null, now: string): PrincipalDirectory {
  const initialized = hasInitializationMarker(path);
  if (existsSync(path)) {
    const directory = loadPrincipals(path);
    if (!initialized) createInitializationMarker(path);
    return directory;
  }
  if (initialized) fail(path, 'initialized principal store is missing; restore the authoritative store');
  const principals: PrincipalRecord[] = seed === null ? [] : [{ ...seed, role: 'operator', cases: '*', createdAt: now, revokedAt: null }];
  const file = parsePrincipalsFile(JSON.stringify({ schemaVersion: PRINCIPALS_SCHEMA_VERSION, principals }), path);
  createInitializationMarker(path);
  writeAtomic(path, file);
  return loadPrincipals(path);
}

export interface AddPrincipalInput {
  readonly id: string;
  readonly displayName: string;
  readonly role: PrincipalRole;
  readonly cases: '*' | ReadonlyArray<string>;
}

/**
 * Adds a principal and returns the token ONCE. Only its digest is stored; a
 * lost token is replaced by revoking the principal and adding a new one.
 */
export function addPrincipal(path: string, input: AddPrincipalInput, now: string): { readonly token: string; readonly record: PrincipalRecord } {
  const current: PrincipalsFile = { schemaVersion: PRINCIPALS_SCHEMA_VERSION, principals: loadOrCreatePrincipals(path, null, now).list() };
  if (current.principals.some((principal) => principal.id === input.id)) fail(path, `principal id ${input.id} already exists; revoke it or choose another id`);
  const token = randomBytes(32).toString('base64url');
  const record = parseRecord({ id: input.id, displayName: input.displayName, role: input.role, tokenSha256: tokenDigest(token), cases: input.cases === '*' ? '*' : [...input.cases], createdAt: now, revokedAt: null }, path, current.principals.length);
  writeAtomic(path, { schemaVersion: PRINCIPALS_SCHEMA_VERSION, principals: [...current.principals, record] });
  return { token, record };
}

/** Marks a principal revoked; the record stays so past receipts keep naming a known id. */
export function revokePrincipal(path: string, id: string, now: string): PrincipalRecord {
  const current = parsePrincipalsFile(readFileSync(path, 'utf8'), path);
  const target = current.principals.find((principal) => principal.id === id);
  if (target === undefined) fail(path, `no principal ${id}`);
  if (target.revokedAt !== null) return target;
  const revoked: PrincipalRecord = { ...target, revokedAt: now };
  writeAtomic(path, { schemaVersion: PRINCIPALS_SCHEMA_VERSION, principals: current.principals.map((principal) => (principal.id === id ? revoked : principal)) });
  return revoked;
}

/** Whether a principal may see a case at all. Absence reads as 404, never as "exists but forbidden". */
export function canSeeCase(principal: Principal, caseId: string): boolean {
  return principal.cases === '*' || principal.cases.includes(caseId);
}
