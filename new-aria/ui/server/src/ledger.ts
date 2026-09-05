// Append-only, signed, head-committed ledgers — the console's custody record.
//
// WHY: the intake receipt used to be a hash chain and nothing more. MEASURED
// 2026-09-04: it defended against an editor who forgot to rehash, and against
// nobody else — a ledger re-chained from scratch verified clean, a tail cut off
// verified clean, a case with zero receipts read "intact", and two uploads that
// finished in the same event-loop turn both took the same predecessor and
// broke the chain for good. A custody record has to be stronger than the
// person holding the disk.
//
// WHAT: three properties, each closing one of those holes.
//   1. Every row carries an Ed25519 signature over its row hash, made with a
//      key that lives on the volume and never in the repository. Re-chaining
//      needs the key; without it the signatures stop verifying. The public key
//      can be handed to a client, so a third party can verify the receipt
//      without trusting this console.
//   2. A head commitment beside the ledger states the row count and the last
//      row hash, signed. A truncated tail disagrees with the count; an appended
//      forgery disagrees too; a missing head is reported as unanchored.
//   3. Appends are serialised per ledger inside the process, so no writer can
//      observe a stale tail. Zero rows is `empty`, never `intact`.
// Nothing here is a dependency: node:crypto signs, node:fs appends.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { open, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { HttpError } from './errors.ts';

export const LEDGER_SCHEMA_VERSION = 2 as const;
const SHA256 = /^[0-9a-f]{64}$/;

/** The signing identity of one console instance. */
export interface LedgerSigner {
  readonly keyId: string;
  readonly publicKeyPem: string;
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
}

/** The verifying half: what a client or a later reader needs. */
export interface LedgerVerifier {
  readonly keyId: string;
  readonly publicKey: KeyObject;
}

function keyIdOf(publicKey: KeyObject): string {
  return createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);
}

export function signerFromPrivatePem(pem: string): LedgerSigner {
  const privateKey = createPrivateKey(pem);
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error(`ledger key must be ed25519, got ${privateKey.asymmetricKeyType ?? 'unknown'}`);
  const publicKey = createPublicKey(privateKey);
  return { keyId: keyIdOf(publicKey), publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(), privateKey, publicKey };
}

export function verifierFromPublicPem(pem: string): LedgerVerifier {
  const publicKey = createPublicKey(pem);
  return { keyId: keyIdOf(publicKey), publicKey };
}

/**
 * Loads the console's signing key, creating it on first boot.
 *
 * The key is generated on the volume with owner-only permissions and never
 * travels in the image or the repository. Generating it automatically is the
 * same decision as registering the adapter automatically: a product that needs
 * a shell command before its first receipt can be written is not deployed.
 */
export function loadOrCreateSigner(path: string): LedgerSigner {
  if (existsSync(path)) return signerFromPrivatePem(readFileSync(path, 'utf8'));
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const pair = generateKeyPairSync('ed25519');
  const pem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  writeFileSync(path, pem, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return signerFromPrivatePem(pem);
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** The chain fields every signed row carries, whatever its payload. */
export interface SignedRowFields {
  readonly schemaVersion: typeof LEDGER_SCHEMA_VERSION;
  readonly previousRowHash: string | null;
  readonly rowHash: string;
  readonly keyId: string;
  /** Ed25519 over the row hash bytes, base64. */
  readonly signature: string;
}

/** The head commitment written beside a ledger after every append. */
export interface LedgerHead {
  readonly schemaVersion: typeof LEDGER_SCHEMA_VERSION;
  readonly ledger: string;
  readonly rows: number;
  readonly headRowHash: string | null;
  readonly keyId: string;
  readonly committedAt: string;
  readonly signature: string;
}

export type LedgerStatus = 'empty' | 'intact' | 'broken';

export interface LedgerVerdict {
  readonly status: LedgerStatus;
  /** True for `empty` and `intact`. Kept for readers that only ask yes or no. */
  readonly valid: boolean;
  readonly rows: number;
  readonly brokenAt: number | null;
  readonly reason: string | null;
  /** True when a signed head commitment was present and agreed with the rows. */
  readonly anchored: boolean;
  readonly keyId: string | null;
}

export function hashCanonical(fields: ReadonlyArray<unknown>): string {
  return createHash('sha256').update(JSON.stringify(fields), 'utf8').digest('hex');
}

function signHex(hex: string, signer: LedgerSigner): string {
  return sign(null, Buffer.from(hex, 'hex'), signer.privateKey).toString('base64');
}

function verifyHex(hex: string, signature: string, verifier: LedgerVerifier): boolean {
  try {
    return verify(null, Buffer.from(hex, 'hex'), verifier.publicKey, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

function headCanonical(head: Omit<LedgerHead, 'signature'>): string {
  return hashCanonical([head.schemaVersion, head.ledger, head.rows, head.headRowHash, head.keyId, head.committedAt]);
}

export function headFileName(ledgerName: string): string {
  return ledgerName.replace(/\.jsonl$/, '') + '.head.json';
}

// ---------------------------------------------------------------------------
// Append, serialised per ledger
// ---------------------------------------------------------------------------
const queues = new Map<string, Promise<unknown>>();

/** Runs `task` after every earlier task on the same ledger has finished, success or failure. */
function serialised<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.then(task, task);
  queues.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}

export interface AppendInput<Payload extends object> {
  readonly dir: string;
  readonly ledger: string;
  readonly payload: Payload;
  /** The payload's fields in the fixed order the row hash is computed over. */
  readonly canonical: (payload: Payload, previousRowHash: string | null) => ReadonlyArray<unknown>;
  readonly signer: LedgerSigner;
  readonly now: string;
}

/** Read rows inside the same critical section as the head and append. */
async function readRows<Payload extends object>(path: string): Promise<Array<Payload & SignedRowFields>> {
  let text: string;
  try { text = await readFile(path, 'utf8'); }
  catch (error) {
    if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT') return [];
    throw error;
  }
  return text.split('\n').filter((line) => line.trim() !== '').map((line) => {
    let parsed: unknown;
    try { parsed = JSON.parse(line); }
    catch { throw new HttpError(502, 'ledger_corrupt'); }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new HttpError(502, 'ledger_corrupt');
    return parsed as Payload & SignedRowFields;
  });
}

/** Consistent in-process read; callers still validate domain fields and signatures. */
export function readLedgerSnapshot<Row extends object>(dir: string, ledger: string, parse: (value: unknown, where: string) => Row): Promise<{ rows: Row[]; head: LedgerHead | null }> {
  const path = join(dir, ledger);
  return serialised(path, async () => ({
    rows: (await readRows(path)).map((row, index) => parse(row, `${ledger}:${index + 1}`)),
    head: await readHead(dir, ledger),
  }));
}

async function writeHead(dir: string, ledger: string, rows: number, headRowHash: string | null, signer: LedgerSigner, now: string): Promise<LedgerHead> {
  const unsigned: Omit<LedgerHead, 'signature'> = { schemaVersion: LEDGER_SCHEMA_VERSION, ledger, rows, headRowHash, keyId: signer.keyId, committedAt: now };
  const head: LedgerHead = { ...unsigned, signature: signHex(headCanonical(unsigned), signer) };
  const path = join(dir, headFileName(ledger));
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(head, null, 2)}\n`, 'utf8');
  await rename(tmp, path);
  return head;
}

/**
 * Appends one signed row and re-commits the head. Serialised per ledger: the
 * tail is read inside the critical section, so two concurrent appends can never
 * take the same predecessor.
 */
export function appendSigned<Payload extends object>(input: AppendInput<Payload>): Promise<Payload & SignedRowFields> {
  const path = join(input.dir, input.ledger);
  return serialised(path, async () => {
    const rows = await readRows<Payload>(path);
    const head = await readHead(input.dir, input.ledger);
    let verdict: LedgerVerdict;
    try { verdict = verifyLedger({ rows, head, canonical: input.canonical, verifier: input.signer }); }
    catch { throw new HttpError(502, 'ledger_chain_invalid'); }
    if (!verdict.valid || (head !== null && head.ledger !== input.ledger)) throw new HttpError(502, 'ledger_chain_invalid', verdict.reason ?? 'ledger_name_mismatch');
    const previousRowHash = head === null ? null : head.headRowHash;
    const rowHash = hashCanonical(input.canonical(input.payload, previousRowHash));
    const row: Payload & SignedRowFields = {
      ...input.payload,
      schemaVersion: LEDGER_SCHEMA_VERSION,
      previousRowHash,
      rowHash,
      keyId: input.signer.keyId,
      signature: signHex(rowHash, input.signer),
    };
    const handle = await open(path, 'a');
    try {
      await handle.appendFile(`${JSON.stringify(row)}\n`, 'utf8');
      // The receipt is the product's evidence; it reaches the disk before the
      // request is answered, so a crash cannot lose an arrival already reported.
      await handle.sync();
    } finally {
      await handle.close();
    }
    await writeHead(input.dir, input.ledger, rows.length + 1, rowHash, input.signer, input.now);
    return row;
  });
}

/** Reads the head commitment, or null when the ledger has never been committed. */
export async function readHead(dir: string, ledger: string): Promise<LedgerHead | null> {
  let text: string;
  try {
    text = await readFile(join(dir, headFileName(ledger)), 'utf8');
  } catch (error) {
    if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT') return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(502, 'ledger_head_corrupt', join(dir, headFileName(ledger)));
  }
  if (typeof parsed !== 'object' || parsed === null) throw new HttpError(502, 'ledger_head_corrupt', join(dir, headFileName(ledger)));
  return parsed as LedgerHead;
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export interface VerifyInput<Row extends SignedRowFields> {
  readonly rows: ReadonlyArray<Row>;
  readonly head: LedgerHead | null;
  /** The row's payload fields in canonical order; must match what appendSigned hashed. */
  readonly canonical: (row: Row, previousRowHash: string | null) => ReadonlyArray<unknown>;
  /** null when the console holds no key: chain hashes are still checked, signatures cannot be. */
  readonly verifier: LedgerVerifier | null;
}

function broken(rows: number, brokenAt: number | null, reason: string, keyId: string | null): LedgerVerdict {
  return { status: 'broken', valid: false, rows, brokenAt, reason, anchored: false, keyId };
}

/**
 * Re-walks a ledger: chain, signatures, then the head commitment. The first
 * failure is named with its row; a passing walk is `intact` only when the head
 * agrees, and a ledger with no rows is `empty`, never `intact`.
 */
export function verifyLedger<Row extends SignedRowFields>(input: VerifyInput<Row>): LedgerVerdict {
  const { rows, head, verifier } = input;
  const keyId = verifier?.keyId ?? null;
  let previous: string | null = null;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index] as Row;
    if (row.schemaVersion !== LEDGER_SCHEMA_VERSION) return broken(rows.length, index, 'schema_version_unknown', keyId);
    if (row.previousRowHash !== previous) return broken(rows.length, index, 'previous_row_hash_mismatch', keyId);
    if (hashCanonical(input.canonical(row, previous)) !== row.rowHash) return broken(rows.length, index, 'row_hash_mismatch', keyId);
    if (verifier === null) {
      // Without the key the row's origin cannot be checked; say so rather than
      // pass it as verified.
      return broken(rows.length, index, 'ledger_key_missing', keyId);
    }
    if (row.keyId !== verifier.keyId) return broken(rows.length, index, 'key_unknown', keyId);
    if (!verifyHex(row.rowHash, row.signature, verifier)) return broken(rows.length, index, 'signature_invalid', keyId);
    previous = row.rowHash;
  }
  if (head === null) {
    if (rows.length === 0) return { status: 'empty', valid: true, rows: 0, brokenAt: null, reason: null, anchored: false, keyId };
    return broken(rows.length, null, 'unanchored', keyId);
  }
  if (verifier === null) return broken(rows.length, null, 'ledger_key_missing', keyId);
  if (head.keyId !== verifier.keyId) return broken(rows.length, null, 'head_key_unknown', keyId);
  const { signature, ...unsigned } = head;
  if (!verifyHex(headCanonical(unsigned), signature, verifier)) return broken(rows.length, null, 'head_signature_invalid', keyId);
  if (head.rows > rows.length) return broken(rows.length, rows.length, 'head_mismatch:truncated', keyId);
  if (head.rows < rows.length) return broken(rows.length, head.rows, 'head_mismatch:extended', keyId);
  if (head.headRowHash !== previous) return broken(rows.length, rows.length === 0 ? null : rows.length - 1, 'head_mismatch:head_row', keyId);
  if (rows.length === 0) return { status: 'empty', valid: true, rows: 0, brokenAt: null, reason: null, anchored: true, keyId };
  return { status: 'intact', valid: true, rows: rows.length, brokenAt: null, reason: null, anchored: true, keyId };
}
