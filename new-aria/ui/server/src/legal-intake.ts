// Case intake — the moment a document enters the archive, recorded as evidence.
//
// WHY: a legal working set is only as trustworthy as its first minute. Before
// this module the archive was mounted by hand and nothing recorded when a file
// arrived, from whom, or what its bytes hashed to; the adapter's later hash was
// the only measurement, so "this document reached us unchanged" rested on a
// single observation with nothing to check it against. Here the console records
// the arrival — time, size, sha256, who took delivery — and the adapter's
// independent re-hash of the same bytes becomes a second measurement that must
// agree. Two independent measurements of the same bytes turn a claim into a
// receipt.
//
// The receipt is a signed, head-committed ledger (ledger.ts): every row is
// signed with the console's key, appends are serialised per case, and a head
// commitment states the row count. MEASURED 2026-09-04 before that: a
// re-chained receipt, a truncated tail and an empty ledger all read "intact",
// and two concurrent uploads broke the chain for good.
//
// WHAT: per-case directories under the cases root:
//   <caseId>/archive/          the documents; the adapter reads ONLY here and
//                              never writes (pack law L2)
//   <caseId>/intake.jsonl      append-only, hash-chained, row-signed receipt
//   <caseId>/intake.head.json  signed head commitment over the receipt
//   <caseId>/case.meta.json    the case's own identity and custodian
// Uploads retain unique transaction directories with signed receiving/received/failed
// state. Durable bytes and a validated signed receipt precede archive publication.
// Reconciliation preserves partial evidence and refuses corruption before new work.

import { createHash, randomUUID, sign, verify } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import type { Dirent } from 'node:fs';
import { link, mkdir, open, readdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';

import { LEGAL_CASE_ID_RE, LEGAL_CASE_LAYOUT } from '../../shared/legal-contract.ts';
import { HttpError } from './errors.ts';
import { resolveInside } from './fsafe.ts';
import type { LedgerHead, LedgerSigner, LedgerVerdict, LedgerVerifier, SignedRowFields } from './ledger.ts';
import { appendSigned, headFileName, LEDGER_SCHEMA_VERSION, readHead, verifyLedger } from './ledger.ts';

/**
 * Case ids become directory names on BOTH sides — this receipt and the
 * adapter's artifacts — so the pattern is the contract's, not a local one.
 */
const CASE_ID = LEGAL_CASE_ID_RE;
/**
 * Characters a stored path segment may never contain: control bytes (written
 * as escapes, never as literal bytes in this source), separators, wildcards
 * and quoting.
 */
const FORBIDDEN_SEGMENT_CHARS = /[\u0000-\u001f\u007f/\\:*?"<>|]/;
const SHA256 = /^[0-9a-f]{64}$/;

export const ARCHIVE_DIR = LEGAL_CASE_LAYOUT.archive;
export const INTAKE_LEDGER = LEGAL_CASE_LAYOUT.intake;
export const CASE_META = LEGAL_CASE_LAYOUT.meta;
const TEMP_DIR = '.intake-tmp';
const ORPHAN_DIR = '.intake-orphans';

export interface CaseMeta {
  readonly caseId: string;
  readonly title: string;
  readonly jurisdiction: string | null;
  readonly courtReference: string | null;
  /** Who is answerable for this archive's chain of custody. */
  readonly custodian: string;
  readonly createdAt: string;
  readonly createdBy: string;
}

/** The arrival itself — the fields the row hash is computed over, in this order. */
export interface IntakePayload {
  readonly caseId: string;
  /** Path inside archive/, POSIX separators, exactly as stored. */
  readonly relativePath: string;
  /** The name the uploader's file had, before any validation trimmed it. */
  readonly fileName: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly receivedAt: string;
  readonly receivedBy: string;
  readonly sourceNote: string | null;
}

export type IntakeRecord = IntakePayload & SignedRowFields;

/** Field order is fixed here, so a row's hash never depends on how the object was built. */
export function intakeCanonical(row: IntakePayload, previousRowHash: string | null): ReadonlyArray<unknown> {
  return [LEDGER_SCHEMA_VERSION, row.caseId, row.relativePath, row.fileName, row.bytes, row.sha256, row.receivedAt, row.receivedBy, row.sourceNote, previousRowHash];
}

function badRequest(code: string, detail?: string): never {
  throw new HttpError(400, code, detail);
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === 'ENOENT';
}

export function assertCaseId(caseId: string): string {
  if (!CASE_ID.test(caseId)) {
    badRequest('case_id_invalid', 'a case id is 3-64 characters of a-z, 0-9, dot, dash or underscore');
  }
  return caseId;
}

/**
 * Validates an uploaded document's relative path. Folder structure is allowed
 * because a real archive has it, but every segment is checked and `..` can never
 * appear: this path is data from a request.
 */
export function assertRelativePath(raw: string): string {
  const trimmed = raw.trim().replace(/\\/g, '/');
  if (trimmed === '') badRequest('file_name_missing');
  if (trimmed.length > 1024) badRequest('file_name_too_long');
  const segments = trimmed.split('/').filter((segment) => segment !== '');
  if (segments.length === 0) badRequest('file_name_missing');
  for (const segment of segments) {
    if (segment === '.' || segment === '..') badRequest('file_name_traversal', segment);
    if (segment.length > 120) badRequest('file_name_segment_too_long', segment.slice(0, 40));
    if (FORBIDDEN_SEGMENT_CHARS.test(segment)) badRequest('file_name_invalid', segment);
  }
  return segments.join('/');
}

/** Decodes the percent-encoded file-name header; a malformed encoding is a bad request. */
export function decodeFileNameHeader(value: string | undefined): string {
  if (value === undefined || value.trim() === '') badRequest('file_name_missing', 'set X-Aria-File-Name');
  try {
    return decodeURIComponent(value);
  } catch {
    return badRequest('file_name_encoding_invalid', 'X-Aria-File-Name must be percent-encoded UTF-8');
  }
}

export function caseRoot(casesDir: string, caseId: string): string {
  return resolveInside(casesDir, assertCaseId(caseId));
}

/**
 * A receipt row is read back only in the shape it was written. A row of another
 * schema version, or one missing the fields the chain and the signature are
 * computed over, is refused by line rather than cast and served: a receipt the
 * reader cannot fully account for cannot stand as a custody record.
 */
export function parseIntakeRecord(value: unknown, where: string): IntakeRecord {
  const invalid = (detail: string): never => {
    throw new HttpError(502, 'intake_ledger_invalid', `${where}: ${detail}`);
  };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid('row must be an object');
  const row = value as Record<string, unknown>;
  if (row['schemaVersion'] !== LEDGER_SCHEMA_VERSION) invalid(`schemaVersion ${String(row['schemaVersion'])} is not one this console reads`);
  const text = (field: string): string => {
    const candidate = row[field];
    if (typeof candidate !== 'string' || candidate === '') invalid(`${field} must be a non-empty string`);
    return candidate as string;
  };
  const nullableText = (field: string): string | null => {
    const candidate = row[field];
    if (candidate === null) return null;
    if (typeof candidate !== 'string') invalid(`${field} must be a string or null`);
    return candidate as string;
  };
  const bytes = row['bytes'];
  if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes <= 0) invalid('bytes must be a positive integer');
  const sha256 = text('sha256');
  if (!SHA256.test(sha256)) invalid('sha256 must be a 64-character hex digest');
  const rowHash = text('rowHash');
  if (!SHA256.test(rowHash)) invalid('rowHash must be a 64-character hex digest');
  const previousRowHash = nullableText('previousRowHash');
  if (previousRowHash !== null && !SHA256.test(previousRowHash)) invalid('previousRowHash must be a 64-character hex digest or null');
  return {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    caseId: text('caseId'),
    relativePath: text('relativePath'),
    fileName: text('fileName'),
    bytes: bytes as number,
    sha256,
    receivedAt: text('receivedAt'),
    receivedBy: text('receivedBy'),
    sourceNote: nullableText('sourceNote'),
    previousRowHash,
    rowHash,
    keyId: text('keyId'),
    signature: text('signature'),
  };
}

export async function readIntakeLedger(casesDir: string, caseId: string): Promise<IntakeRecord[]> {
  const path = join(caseRoot(casesDir, caseId), INTAKE_LEDGER);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const rows: IntakeRecord[] = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new HttpError(502, 'intake_ledger_corrupt', path);
    }
    rows.push(parseIntakeRecord(parsed, `${path}:${index + 1}`));
  }
  return rows;
}

/** The signed head commitment, or null when the case has never had a receipt committed. */
export function readIntakeHead(casesDir: string, caseId: string): Promise<LedgerHead | null> {
  return readHead(caseRoot(casesDir, caseId), INTAKE_LEDGER);
}

export type ChainVerdict = LedgerVerdict;

/**
 * Re-walks the receipt: chain hashes, every row's signature, then the head
 * commitment. A ledger with no rows is `empty`; `intact` is earned only when
 * the signed head agrees with what is on disk.
 */
export function verifyIntakeChain(rows: readonly IntakeRecord[], head: LedgerHead | null, verifier: LedgerVerifier | null): ChainVerdict {
  return verifyLedger({ rows, head, canonical: intakeCanonical, verifier });
}

export async function createCase(casesDir: string, meta: Omit<CaseMeta, 'createdAt'>, now: string): Promise<CaseMeta> {
  const root = caseRoot(casesDir, meta.caseId);
  if (meta.title.trim() === '') badRequest('case_title_missing');
  // A custodian is not decoration: an archive nobody is answerable for cannot
  // support a chain-of-custody claim later.
  if (meta.custodian.trim() === '') badRequest('case_custodian_missing', 'a case archive needs a named custodian');
  return serialiseIntake(root, async () => {
    try {
      await stat(join(root, CASE_META));
      throw new HttpError(409, 'case_already_exists', meta.caseId);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (!isMissing(error)) throw error;
    }
    const archive = join(root, ARCHIVE_DIR);
    const firstCreated = await mkdir(archive, { recursive: true });
    let boundary = dirname(resolve(casesDir));
    if (firstCreated !== undefined && (boundary === firstCreated || boundary.startsWith(firstCreated + sep))) boundary = dirname(firstCreated);
    await syncDirectories(archive, boundary);
    const record: CaseMeta = {
      caseId: meta.caseId,
      title: meta.title.trim(),
      jurisdiction: meta.jurisdiction === null ? null : meta.jurisdiction.trim() || null,
      courtReference: meta.courtReference === null ? null : meta.courtReference.trim() || null,
      custodian: meta.custodian.trim(),
      createdAt: now,
      createdBy: meta.createdBy,
    };
    // Metadata becomes visible only after its bytes and containing namespace are durable.
    const temporary = join(root, `case-meta-${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally { await handle.close(); }
    await link(temporary, join(root, CASE_META));
    await unlink(temporary);
    await syncPath(root);
    return record;
  });
}

export async function readCaseMeta(casesDir: string, caseId: string): Promise<CaseMeta | null> {
  const path = join(caseRoot(casesDir, caseId), CASE_META);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  try {
    return JSON.parse(text) as CaseMeta;
  } catch {
    throw new HttpError(502, 'case_meta_invalid', caseId);
  }
}

export interface UploadOutcome {
  readonly record: IntakeRecord;
  /** True when these exact bytes were already stored at this path; nothing was written. */
  readonly duplicate: boolean;
}

export interface UploadOptions {
  readonly casesDir: string;
  readonly caseId: string;
  readonly fileName: string;
  readonly receivedBy: string;
  readonly sourceNote: string | null;
  readonly maxBytes: number;
  readonly now: string;
  /** The console's ledger key. Without it no receipt can be signed, so no document is taken in. */
  readonly signer: LedgerSigner | null;
}

async function readExistingHash(path: string): Promise<string | null> {
  let contents: Buffer;
  try {
    contents = await readFile(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  return createHash('sha256').update(contents).digest('hex');
}

type ArchiveTarget = { readonly kind: 'missing' | 'conflict' } | { readonly kind: 'file'; readonly sha256: string; readonly bytes: number };

/** A document occupies a leaf; every preceding path segment must remain a directory. */
async function inspectArchiveTarget(archive: string, relativePath: string): Promise<ArchiveTarget> {
  const segments = relativePath.split('/');
  let current = archive;
  for (let index = 0; index < segments.length; index++) {
    current = join(current, segments[index] as string);
    let info;
    try { info = await stat(current); }
    catch (error) { if (isMissing(error)) return { kind: 'missing' }; throw error; }
    if (index < segments.length - 1) {
      if (!info.isDirectory()) return { kind: 'conflict' };
    } else {
      if (!info.isFile()) return { kind: 'conflict' };
      const contents = await readFile(current);
      return { kind: 'file', sha256: createHash('sha256').update(contents).digest('hex'), bytes: contents.length };
    }
  }
  throw new HttpError(502, 'intake_transaction_invalid', relativePath);
}

function overlapsDocumentPath(left: string, right: string): boolean {
  return left.startsWith(right + '/') || right.startsWith(left + '/');
}

/** Durable per-upload state; receiving never implies that a complete document arrived. */
interface IntakeTransaction {
  readonly version: 1;
  readonly id: string;
  readonly state: 'receiving' | 'received' | 'failed';
  readonly caseId: string;
  readonly relativePath: string;
  readonly payload: IntakePayload | null;
  readonly failure: string | null;
}

const intakeQueues = new Map<string, Promise<unknown>>();

/** Separate from the ledger mutex: the whole intake decision/publication is one critical section. */
function serialiseIntake<T>(root: string, task: () => Promise<T>): Promise<T> {
  const previous = intakeQueues.get(root) ?? Promise.resolve();
  const next = previous.then(task, task);
  const settled = next.catch(() => undefined);
  intakeQueues.set(root, settled);
  const clear = (): void => { if (intakeQueues.get(root) === settled) intakeQueues.delete(root); };
  return next.then(value => { clear(); return value; }, error => { clear(); throw error; });
}

async function syncPath(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function durableDirectory(path: string, boundary: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await syncDirectories(path, boundary);
}

async function syncDirectories(path: string, boundary: string): Promise<void> {
  let current = path;
  while (current !== boundary) {
    await syncPath(current);
    current = dirname(current);
  }
  await syncPath(boundary);
}

async function syncPartial(directory: string): Promise<void> {
  try { await syncPath(join(directory, 'document.part')); }
  catch (error) { if (!isMissing(error)) throw error; }
  await syncPath(directory);
}

async function writeTransaction(directory: string, transaction: IntakeTransaction, signer: LedgerSigner): Promise<void> {
  const text = JSON.stringify(transaction);
  const signature = sign(null, Buffer.from(text), signer.privateKey).toString('base64');
  const temp = join(directory, `transaction-${randomUUID()}.tmp`);
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify({ transaction, keyId: signer.keyId, signature }) + '\n');
    await handle.sync();
  } finally { await handle.close(); }
  await rename(temp, join(directory, 'transaction.json'));
  await syncPath(directory);
}

function isStoredPath(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try { return assertRelativePath(value) === value; }
  catch { return false; }
}

function transactionPayload(value: unknown): IntakePayload {
  if (typeof value !== 'object' || value === null) throw new HttpError(502, 'intake_transaction_invalid');
  const row = value as Record<string, unknown>;
  if (typeof row['caseId'] !== 'string' || !CASE_ID.test(row['caseId']) || !isStoredPath(row['relativePath']) ||
      typeof row['fileName'] !== 'string' || row['fileName'] === '' ||
      typeof row['bytes'] !== 'number' || !Number.isSafeInteger(row['bytes']) || row['bytes'] <= 0 ||
      typeof row['sha256'] !== 'string' || !SHA256.test(row['sha256']) ||
      typeof row['receivedAt'] !== 'string' || row['receivedAt'] === '' ||
      typeof row['receivedBy'] !== 'string' || row['receivedBy'] === '' ||
      (row['sourceNote'] !== null && typeof row['sourceNote'] !== 'string')) {
    throw new HttpError(502, 'intake_transaction_invalid');
  }
  return { caseId: row['caseId'], relativePath: row['relativePath'], fileName: row['fileName'], bytes: row['bytes'],
    sha256: row['sha256'], receivedAt: row['receivedAt'], receivedBy: row['receivedBy'], sourceNote: row['sourceNote'] };
}

/** null is reserved for a directory in which the first journal never committed. */
async function readTransaction(directory: string, caseId: string, signer: LedgerSigner): Promise<IntakeTransaction | null> {
  let text: string;
  try { text = await readFile(join(directory, 'transaction.json'), 'utf8'); }
  catch (error) {
    if (isMissing(error)) {
      const entries = await readdir(directory, { withFileTypes: true });
      if (entries.every(entry => entry.isFile() && /^transaction-[a-zA-Z0-9-]+\.tmp$/.test(entry.name))) return null;
    }
    throw new HttpError(502, 'intake_transaction_invalid', directory);
  }
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new HttpError(502, 'intake_transaction_invalid', directory); }
  if (typeof value !== 'object' || value === null) throw new HttpError(502, 'intake_transaction_invalid');
  const envelope = value as Record<string, unknown>;
  const transaction = envelope['transaction'];
  if (typeof transaction !== 'object' || transaction === null || typeof envelope['signature'] !== 'string' || envelope['keyId'] !== signer.keyId ||
      !verify(null, Buffer.from(JSON.stringify(transaction)), signer.publicKey, Buffer.from(envelope['signature'], 'base64'))) {
    throw new HttpError(502, 'intake_transaction_invalid', directory);
  }
  const row = transaction as Record<string, unknown>;
  if (row['version'] !== 1 || typeof row['id'] !== 'string' || row['id'] !== directory.split(sep).at(-1) || row['caseId'] !== caseId ||
      (row['state'] !== 'receiving' && row['state'] !== 'received' && row['state'] !== 'failed') || !isStoredPath(row['relativePath']) ||
      (row['state'] === 'failed' ? typeof row['failure'] !== 'string' || row['failure'] === '' : row['failure'] !== null) ||
      (row['state'] === 'receiving' && row['payload'] !== null)) {
    throw new HttpError(502, 'intake_transaction_invalid', directory);
  }
  const payload = row['payload'] === null ? null : transactionPayload(row['payload']);
  if ((row['state'] === 'received' && payload === null) ||
      (payload !== null && (payload.caseId !== caseId || payload.relativePath !== row['relativePath']))) {
    throw new HttpError(502, 'intake_transaction_invalid', directory);
  }
  return { version: 1, id: row['id'], caseId, state: row['state'], relativePath: row['relativePath'], payload, failure: row['failure'] as string | null };
}

async function verifyReceivedBytes(directory: string, transaction: IntakeTransaction): Promise<void> {
  const payload = transaction.payload;
  if (payload === null) throw new HttpError(502, 'intake_transaction_invalid', directory);
  const path = join(directory, 'document.part');
  if (await readExistingHash(path) !== payload.sha256 || (await stat(path)).size !== payload.bytes) {
    throw new HttpError(502, 'intake_bytes_invalid', transaction.id);
  }
}

async function verifiedIntakeRows(casesDir: string, caseId: string, signer: LedgerSigner): Promise<IntakeRecord[]> {
  const rows = await readIntakeLedger(casesDir, caseId);
  const head = await readIntakeHead(casesDir, caseId);
  const verdict = verifyIntakeChain(rows, head, signer);
  if (!verdict.valid || (head !== null && head.ledger !== INTAKE_LEDGER) ||
      rows.some(row => row.caseId !== caseId || !isStoredPath(row.relativePath)) ||
      new Set(rows.map(row => row.relativePath)).size !== rows.length) {
    throw new HttpError(502, 'intake_chain_invalid', verdict.reason ?? 'receipt_case_ledger_or_path_mismatch');
  }
  return rows;
}

async function publishReceived(casesDir: string, caseId: string, directory: string, transaction: IntakeTransaction, signer: LedgerSigner): Promise<UploadOutcome> {
  const root = caseRoot(casesDir, caseId);
  const payload = transaction.payload;
  if (payload === null || payload.caseId !== caseId || payload.relativePath !== transaction.relativePath || !Number.isSafeInteger(payload.bytes) || payload.bytes <= 0 || !SHA256.test(payload.sha256)) {
    throw new HttpError(502, 'intake_transaction_invalid', directory);
  }
  const tempPath = join(directory, 'document.part');
  await verifyReceivedBytes(directory, transaction);
  const rows = await verifiedIntakeRows(casesDir, caseId, signer);
  const target = resolveInside(join(root, ARCHIVE_DIR), payload.relativePath);
  if (rows.some(row => overlapsDocumentPath(row.relativePath, payload.relativePath))) throw new HttpError(409, 'document_name_conflict', payload.relativePath);
  const existing = await inspectArchiveTarget(join(root, ARCHIVE_DIR), payload.relativePath);
  if (existing.kind === 'conflict') throw new HttpError(409, 'document_name_conflict', payload.relativePath);
  const prior = rows.find(row => row.relativePath === payload.relativePath);
  if (prior !== undefined && (prior.sha256 !== payload.sha256 || prior.bytes !== payload.bytes)) throw new HttpError(409, 'document_name_conflict', payload.relativePath);
  if (existing.kind === 'file' && (existing.sha256 !== payload.sha256 || existing.bytes !== payload.bytes)) throw new HttpError(409, 'document_name_conflict', payload.relativePath);
  // A visible file without a signed receipt is never adopted as trusted evidence.
  if (existing.kind === 'file' && prior === undefined) throw new HttpError(502, 'intake_archive_unreceipted', payload.relativePath);
  const record = prior ?? await appendSigned<IntakePayload>({ dir: root, ledger: INTAKE_LEDGER, payload, canonical: intakeCanonical, signer, now: payload.receivedAt });
  // appendSigned fsyncs its row. Commit the head and its directory before publication.
  await syncPath(join(root, headFileName(INTAKE_LEDGER)));
  await syncPath(root);
  await verifiedIntakeRows(casesDir, caseId, signer);
  if (existing.kind === 'missing') {
    await durableDirectory(dirname(target), root);
    // link is atomic and refuses an existing target; rename would overwrite evidence.
    await link(tempPath, target);
    await syncPath(dirname(target));
  }
  return { record, duplicate: prior !== undefined };
}

async function reconcileIntakeLocked(casesDir: string, caseId: string, signer: LedgerSigner): Promise<void> {
  const root = caseRoot(casesDir, caseId);
  const rows = await verifiedIntakeRows(casesDir, caseId, signer);
  const temporary = join(root, TEMP_DIR);
  let entries: Dirent[];
  try { entries = await readdir(temporary, { withFileTypes: true }); }
  catch (error) { if (!isMissing(error)) throw error; entries = []; }
  const transactions: Array<{ directory: string; transaction: IntakeTransaction }> = [];
  const orphans: string[] = [];
  // Inspect every journal and completed byte set before changing any evidence.
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const directory = join(temporary, entry.name);
    if (entry.isFile() && /^upload-[a-f0-9]{16}\.part$/.test(entry.name)) {
      orphans.push(directory);
      continue;
    }
    if (!entry.isDirectory()) throw new HttpError(502, 'intake_transaction_invalid', entry.name);
    const transaction = await readTransaction(directory, caseId, signer);
    if (transaction === null) {
      orphans.push(directory);
      continue;
    }
    if (transaction.state === 'received') await verifyReceivedBytes(directory, transaction);
    transactions.push({ directory, transaction });
  }
  const received = transactions.filter(item => item.transaction.state === 'received');
  const pending = new Map<string, IntakePayload>();
  for (const { transaction } of received) {
    const payload = transaction.payload;
    if (payload === null) throw new HttpError(502, 'intake_transaction_invalid');
    // Committed receipts reserve their whole path topology. Conflicts against
    // those receipts are terminal refusals; uncommitted competing paths are ambiguous.
    if (rows.some(row => row.relativePath === payload.relativePath || overlapsDocumentPath(row.relativePath, payload.relativePath))) continue;
    const other = pending.get(payload.relativePath);
    if ((other !== undefined && (other.sha256 !== payload.sha256 || other.bytes !== payload.bytes)) ||
        [...pending.keys()].some(path => overlapsDocumentPath(path, payload.relativePath))) {
      throw new HttpError(502, 'intake_transaction_conflict', payload.relativePath);
    }
    pending.set(payload.relativePath, payload);
  }
  const published = new Set<string>();
  // Missing archives may be republished only from a verified completed transaction.
  // Existing accepted bytes must validate before any pending receipt is created.
  for (const row of rows) {
    if (!isStoredPath(row.relativePath)) throw new HttpError(502, 'intake_chain_invalid', 'receipt_path_invalid');
    const actual = await inspectArchiveTarget(join(root, ARCHIVE_DIR), row.relativePath);
    const recoverable = received.some(item => item.transaction.payload !== null &&
      item.transaction.relativePath === row.relativePath && item.transaction.payload.sha256 === row.sha256 && item.transaction.payload.bytes === row.bytes);
    if (actual.kind === 'missing' && recoverable) continue;
    if (actual.kind !== 'file' || actual.sha256 !== row.sha256 || actual.bytes !== row.bytes) throw new HttpError(502, 'intake_bytes_invalid', row.relativePath);
    published.add(row.relativePath);
  }
  for (const { transaction } of received) {
    if (rows.some(row => row.relativePath === transaction.relativePath || overlapsDocumentPath(row.relativePath, transaction.relativePath))) continue;
    const target = await inspectArchiveTarget(join(root, ARCHIVE_DIR), transaction.relativePath);
    if (target.kind === 'file') throw new HttpError(502, 'intake_archive_unreceipted', transaction.relativePath);
  }
  for (const orphan of orphans) {
    const quarantine = join(root, ORPHAN_DIR);
    await durableDirectory(quarantine, root);
    await rename(orphan, join(quarantine, randomUUID()));
    await syncPath(quarantine);
    await syncPath(temporary);
  }
  for (const { directory, transaction } of transactions) {
    if (transaction.state === 'receiving') {
      await syncPartial(directory);
      await writeTransaction(directory, { ...transaction, state: 'failed', failure: 'receiving_interrupted' }, signer);
    } else if (transaction.state === 'received') {
      const prior = rows.find(row => row.relativePath === transaction.relativePath);
      if (prior !== undefined && transaction.payload !== null && prior.sha256 === transaction.payload.sha256 &&
          prior.bytes === transaction.payload.bytes && published.has(transaction.relativePath)) continue;
      try { await publishReceived(casesDir, caseId, directory, transaction, signer); }
      catch (error) {
        if (!(error instanceof HttpError) || error.code !== 'document_name_conflict') throw error;
        await writeTransaction(directory, { ...transaction, state: 'failed', failure: error.code }, signer);
      }
    }
  }
}

/** Hold reconciliation and a snapshot read/copy in the same case intake critical section. */
export function withReconciledIntake<T>(casesDir: string, caseId: string, signer: LedgerSigner, task: () => Promise<T>): Promise<T> {
  return serialiseIntake(caseRoot(casesDir, caseId), async () => {
    await reconcileIntakeLocked(casesDir, caseId, signer);
    return task();
  });
}

/** Run at startup and before inventory jobs; corruption is preserved and blocks readiness. */
export function reconcileIntake(casesDir: string, caseId: string, signer: LedgerSigner): Promise<void> {
  return withReconciledIntake(casesDir, caseId, signer, async () => undefined);
}

/** Streams, durably records completion, signs its receipt, then publishes without replacement. */
export async function uploadDocument(req: IncomingMessage, options: UploadOptions): Promise<UploadOutcome> {
  const root = caseRoot(options.casesDir, options.caseId);
  if (typeof options.receivedBy !== 'string' || options.receivedBy.trim() === '' ||
      typeof options.now !== 'string' || options.now.trim() === '' ||
      (options.sourceNote !== null && typeof options.sourceNote !== 'string') ||
      !Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) badRequest('intake_metadata_invalid');
  if ((await readCaseMeta(options.casesDir, options.caseId)) === null) throw new HttpError(404, 'case_not_found', options.caseId);
  const signer = options.signer;
  if (signer === null) throw new HttpError(503, 'ledger_key_missing');
  const relativePath = assertRelativePath(options.fileName);
  return serialiseIntake(root, async () => {
    await reconcileIntakeLocked(options.casesDir, options.caseId, signer);
    const id = randomUUID();
    const directory = join(root, TEMP_DIR, id);
    await durableDirectory(directory, root);
    const receiving: IntakeTransaction = { version: 1, id, state: 'receiving', caseId: options.caseId, relativePath, payload: null, failure: null };
    await writeTransaction(directory, receiving, signer);
    const tempPath = join(directory, 'document.part');
    const hash = createHash('sha256');
    let bytes = 0;
    try {
      await pipeline(req, async function* measure(source: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
        for await (const chunk of source) {
          bytes += chunk.length;
          if (bytes > options.maxBytes) throw new HttpError(413, 'document_too_large', `limit ${options.maxBytes} bytes`);
          hash.update(chunk);
          yield chunk;
        }
      }, createWriteStream(tempPath, { flags: 'wx', mode: 0o600 }));
      if (bytes === 0) badRequest('document_empty');
      await syncPath(tempPath);
      await syncPath(directory);
    } catch (error) {
      await syncPartial(directory);
      await writeTransaction(directory, { ...receiving, state: 'failed', failure: error instanceof HttpError ? error.code : 'receiving_failed' }, signer);
      throw error;
    }
    const payload: IntakePayload = { caseId: options.caseId, relativePath, fileName: options.fileName, bytes, sha256: hash.digest('hex'), receivedAt: options.now, receivedBy: options.receivedBy, sourceNote: options.sourceNote };
    const received: IntakeTransaction = { ...receiving, state: 'received', payload };
    await writeTransaction(directory, received, signer);
    try { return await publishReceived(options.casesDir, options.caseId, directory, received, signer); }
    catch (error) {
      // Conflicting uploads were not accepted; keep their bytes and the explicit refusal.
      if (error instanceof HttpError && error.code === 'document_name_conflict') await writeTransaction(directory, { ...received, state: 'failed', failure: error.code }, signer);
      throw error;
    }
  });
}

/** Lists the case ids present under the cases directory, sorted. */
export async function listCaseIds(casesDir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(resolve(casesDir), { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory() && CASE_ID.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

/**
 * The archive path an inventory run is pointed at, expressed relative to the
 * workspace root the kernel runs the adapter in.
 *
 * MEASURED: the kernel's tool runner resolves `runner.cwd` under the workspace
 * root and requires it to stay there (tool_runner.py:78-84), and it refuses to
 * run a ts-node adapter unless `<cwd>/node_modules/ts-node/dist/bin.js` exists
 * (tool_runner.py:694). Both hold only when the workspace root is the ARIA
 * install itself — the adapter's own code and its runtime live there. The case
 * archives must therefore sit INSIDE that root (a mounted volume under it), and
 * the run is pointed at a path relative to it.
 *
 * A cases directory outside the workspace root is a deployment mistake, and it
 * is refused here with the reason rather than producing an inventory run that
 * would fail deep inside the kernel with an unrelated message.
 */
export function archiveRunRoot(workspaceRoot: string | null, casesDir: string, caseId: string): string {
  assertCaseId(caseId);
  if (workspaceRoot === null) {
    throw new HttpError(409, 'workspace_root_not_configured', 'ARIA_WORKSPACE_ROOT must name the ARIA install the adapter runs in');
  }
  const root = resolve(workspaceRoot);
  const archive = resolve(casesDir, caseId, ARCHIVE_DIR);
  if (archive !== root && !archive.startsWith(root + sep)) {
    throw new HttpError(
      409,
      'cases_dir_outside_workspace',
      `ARIA_LEGAL_CASES_DIR (${casesDir}) must be inside ARIA_WORKSPACE_ROOT (${workspaceRoot}); the adapter runs with the workspace root as its working directory`,
    );
  }
  return relative(root, archive).split(sep).join('/');
}
