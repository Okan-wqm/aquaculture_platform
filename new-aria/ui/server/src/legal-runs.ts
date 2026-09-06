// The service publishes its own validated bytes; workers never receive live run paths.
import { createHash, randomUUID, sign, verify } from 'node:crypto';
import { closeSync, constants, fsyncSync, lstatSync, openSync, readFileSync, renameSync } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { LEGAL_ARTIFACT_FILES, LEGAL_ARTIFACT_LAYOUT, LEGAL_ARTIFACT_ROOT, LEGAL_CASE_ID_RE, LEGAL_CASE_LAYOUT, LEGAL_RUN_KEY_RE } from '../../shared/legal-contract.ts';
import type { LegalCase, LegalDocument, LegalEvidenceRef } from '../../shared/legal-contract.ts';
import { validateCase, validateCoverage, validateDocuments, validateLinks, validateParties, validateStatements, validateTimeline, validateVersions } from '../../shared/legal-artifact-validate.ts';
import type { ServerConfig } from './config.ts';
import { verifiedDecisions } from './decisions-overlay.ts';
import { HttpError } from './errors.ts';
import type { LedgerSigner, LedgerVerifier } from './ledger.ts';
import { caseRoot, readCaseMeta, readIntakeLedger, withReconciledIntake } from './legal-intake.ts';
import type { IntakeRecord } from './legal-intake.ts';
import { runLegalWorker } from './legal-worker.ts';
import type { LegalWorker, LegalWorkerRequest } from './legal-worker.ts';

const FILES = Object.values(LEGAL_ARTIFACT_FILES);
const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;
const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const MANIFEST = 'manifest.json';
const KERNEL_RESULT = 'kernel-result.json';

export interface PreparedLegalInventory { readonly runKey: string; execute(): Promise<void>; }
export interface ResolvedLegalRun { readonly dir: string; readonly runKey: string | null; }
interface RunFile { readonly name: string; readonly sha256: string; readonly bytes: number; }
interface RunManifest {
  readonly schemaVersion: 1;
  readonly caseId: string;
  readonly runKey: string;
  readonly adapterVersion: string;
  readonly snapshotSha256: string;
  readonly cycleId: string | null;
  readonly sourceVersion: string;
  readonly inputSha256: string;
  readonly runtimeProfileSha256: string | null;
  readonly excludedPaths: ReadonlyArray<string>;
  readonly files: ReadonlyArray<RunFile>;
}

function invalid(): never { throw new HttpError(502, 'legal_run_invalid'); }
function hash(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function parse(bytes: Buffer): unknown { try { return JSON.parse(bytes.toString('utf8')) as unknown; } catch { return invalid(); } }
function missing(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'ENOENT'; }
function caseArtifacts(toolsDir: string, caseId: string): string {
  if (!LEGAL_CASE_ID_RE.test(caseId)) throw new HttpError(400, 'case_id_invalid');
  return join(toolsDir, LEGAL_ARTIFACT_ROOT, caseId);
}

/** Live service directories cannot be supplied by workers. */
async function assertDirectories(root: string, path: string): Promise<void> {
  const base = resolve(root);
  const suffix = relative(base, resolve(path));
  if (suffix === '..' || suffix.startsWith(`..${sep}`)) invalid();
  let current = base;
  for (const part of ['', ...suffix.split(sep).filter(Boolean)]) {
    if (part !== '') current = join(current, part);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) invalid();
  }
}

/** Each component is opened relative to a held directory descriptor, including across renames. */
async function openRegular(root: string, path: string): Promise<FileHandle> {
  const suffix = relative(resolve(root), resolve(path));
  if (suffix === '' || suffix === '..' || suffix.startsWith(`..${sep}`)) invalid();
  const parts = suffix.split(sep);
  const file = parts.pop();
  if (file === undefined) return invalid();
  let directory = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (const part of parts) {
      const next = await open(`/proc/self/fd/${directory.fd}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      await directory.close();
      directory = next;
    }
    return await open(`/proc/self/fd/${directory.fd}/${file}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } finally { await directory.close(); }
}

async function boundedFile(root: string, path: string, cap: number): Promise<Buffer> {
  try {
    const fd = await openRegular(root, path);
    try {
      const info = await fd.stat();
      if (!info.isFile() || info.size > cap) invalid();
      const chunks: Buffer[] = [];
      let length = 0;
      while (length <= cap) {
        const chunk = Buffer.alloc(Math.min(65536, cap + 1 - length));
        const result = await fd.read(chunk, 0, chunk.length, null);
        if (result.bytesRead === 0) break;
        length += result.bytesRead;
        if (length > cap) invalid();
        chunks.push(chunk.subarray(0, result.bytesRead));
      }
      return Buffer.concat(chunks);
    } finally { await fd.close(); }
  } catch (error) { if (error instanceof HttpError) throw error; return invalid(); }
}

function versionOfSources(root: string): string {
  const parts = [LEGAL_CASE_LAYOUT.meta, LEGAL_CASE_LAYOUT.intake, LEGAL_CASE_LAYOUT.intakeHead, LEGAL_CASE_LAYOUT.decisions, LEGAL_CASE_LAYOUT.decisionsHead].map(name => {
    const path = join(root, name);
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) invalid();
      // Heads authenticate the ledger content. Size also detects an append whose head is not yet committed.
      return name.endsWith('.jsonl') ? [name, stat.size] : [name, hash(readFileSync(path))];
    } catch (error) { if (missing(error)) return [name, null]; throw error; }
  });
  return hash(JSON.stringify(parts));
}

function profileVersion(path: string): string | null {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_MANIFEST_BYTES) invalid();
    return hash(readFileSync(path));
  } catch (error) { if (missing(error)) return null; throw error; }
}

async function copySource(root: string, destination: string, row: IntakeRecord): Promise<void> {
  const source = resolve(root, row.relativePath);
  if (row.relativePath.includes('\\')) invalid();
  const input = await openRegular(root, source);
  const target = join(destination, row.relativePath);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const output = await open(target, 'wx', 0o400);
  try {
    const info = await input.stat();
    if (!info.isFile() || info.size !== row.bytes) throw new HttpError(502, 'intake_bytes_invalid');
    const digest = createHash('sha256');
    let total = 0;
    const buffer = Buffer.alloc(65536);
    while (true) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > row.bytes) throw new HttpError(502, 'intake_bytes_invalid');
      const chunk = buffer.subarray(0, bytesRead);
      digest.update(chunk);
      await output.writeFile(chunk);
    }
    if (total !== row.bytes || digest.digest('hex') !== row.sha256) throw new HttpError(502, 'intake_bytes_invalid');
    await output.utimes(info.atime, info.mtime);
    await output.sync();
  } finally { await input.close(); await output.close(); }
}

function unique<T>(items: ReadonlyArray<T>, key: (item: T) => string): Map<string, T> {
  const result = new Map<string, T>();
  for (const item of items) { const id = key(item); if (result.has(id)) invalid(); result.set(id, item); }
  return result;
}

function validateArtifacts(bytes: ReadonlyMap<string, Buffer>, caseId: string, runKey: string, receipts: ReadonlyArray<IntakeRecord>, excludedPaths: ReadonlyArray<string>): LegalCase {
  const value = (name: string): unknown => { const file = bytes.get(name); return file === undefined ? invalid() : parse(file); };
  const record = validateCase(value(LEGAL_ARTIFACT_FILES.case));
  const documents = validateDocuments(value(LEGAL_ARTIFACT_FILES.documents));
  const versions = validateVersions(value(LEGAL_ARTIFACT_FILES.versions));
  const parties = validateParties(value(LEGAL_ARTIFACT_FILES.parties));
  const timeline = validateTimeline(value(LEGAL_ARTIFACT_FILES.timeline));
  const statements = validateStatements(value(LEGAL_ARTIFACT_FILES.statements));
  const links = validateLinks(value(LEGAL_ARTIFACT_FILES.links));
  const coverage = validateCoverage(value(LEGAL_ARTIFACT_FILES.coverage));
  if (record.caseId !== caseId || coverage.caseId !== caseId || record.cycleId !== runKey || record.adapterId !== 'legal-document-inventory' || record.archiveRoot !== `data/legal-cases/${caseId}/archive`) invalid();
  const docs = unique(documents, row => row.documentId);
  const paths = unique(documents, row => row.relativePath);
  const groups = unique(versions, row => row.versionGroupId);
  const partyMap = unique(parties, row => row.partyId);
  const events = unique(timeline, row => row.eventId);
  const claims = unique(statements, row => row.statementId);
  unique(links, row => row.linkId);
  const receiptMap = unique(receipts, row => row.relativePath);
  if (documents.length !== receipts.length || coverage.totalFiles !== documents.length) invalid();
  const canonical = new Map<string, LegalDocument>();
  for (const document of documents) {
    if (document.sha256 === '') continue;
    const previous = canonical.get(document.sha256);
    if (previous === undefined || document.relativePath.length < previous.relativePath.length || (document.relativePath.length === previous.relativePath.length && Buffer.compare(Buffer.from(document.relativePath), Buffer.from(previous.relativePath)) < 0)) canonical.set(document.sha256, document);
  }
  for (const document of documents) {
    const receipt = receiptMap.get(document.relativePath);
    if (document.caseId !== caseId || receipt === undefined) invalid();
    if (document.extraction === 'excluded' || (document.extraction !== 'unreadable' && document.sha256 !== receipt.sha256) || document.bytes !== receipt.bytes) invalid();
    if (document.versionGroupId !== null) {
      const group = groups.get(document.versionGroupId);
      if (group === undefined || !group.members.some(member => member.documentId === document.documentId)) invalid();
    }
    const owner = canonical.get(document.sha256);
    const expectedOwner = owner === undefined || owner.documentId === document.documentId ? null : owner.documentId;
    if (document.duplicateOf !== expectedOwner) invalid();
  }
  const evidence = (ref: LegalEvidenceRef): void => {
    const doc = docs.get(ref.documentId);
    if (doc === undefined || doc.sha256 !== ref.sha256) invalid();
    if (ref.versionId !== undefined && ref.versionId !== doc.versionGroupId) invalid();
  };
  for (const group of versions) {
    const members = unique(group.members, member => member.documentId);
    if ((group.signedMember !== null && !members.has(group.signedMember)) || (group.filedMember !== null && !members.has(group.filedMember))) invalid();
    for (const member of group.members) { const document = docs.get(member.documentId); if (document === undefined || document.versionGroupId !== group.versionGroupId) invalid(); }
    for (const step of group.steps) if (!group.members.some(row => row.documentId === step.fromDocumentId) || !group.members.some(row => row.documentId === step.toDocumentId)) invalid();
  }
  for (const party of parties) { party.evidence.forEach(evidence); party.roleEvidence.forEach(row => evidence(row.evidence)); }
  for (const event of timeline) event.evidence.forEach(evidence);
  for (const statement of statements) {
    statement.supportingSources.forEach(evidence); statement.contradictingSources.forEach(evidence);
    if (statement.assertedByPartyId !== null && !partyMap.has(statement.assertedByPartyId)) invalid();
    if (statement.relatedClaimIds.some(id => !claims.has(id))) invalid();
  }
  const recordExists = (kind: string, id: string): boolean => {
    if (kind === 'CASE') return id === caseId;
    if (kind === 'DOCUMENT') return docs.has(id);
    if (kind === 'PARTY') return partyMap.has(id);
    if (kind === 'DOCUMENT_VERSION') return groups.has(id);
    if (kind === 'CLAIM' || kind === 'COUNTERCLAIM') return claims.has(id);
    const event = events.get(id);
    return event !== undefined && event.kind === kind;
  };
  for (const link of links) { if (!recordExists(link.from.kind, link.from.id) || !recordExists(link.to.kind, link.to.id)) invalid(); link.evidence.forEach(evidence); }
  const extractionCounts = { text: 0, metadata_only: 0, unreadable: 0, excluded: 0 };
  const kindCounts = new Map<string, number>();
  const unreadablePaths = new Set<string>();
  for (const document of documents) {
    extractionCounts[document.extraction] += 1;
    kindCounts.set(document.kindGuess, (kindCounts.get(document.kindGuess) ?? 0) + 1);
    if (document.extraction === 'metadata_only' || document.extraction === 'unreadable') unreadablePaths.add(document.relativePath);
  }
  for (const kind of ['text', 'metadata_only', 'unreadable', 'excluded'] as const) if (coverage.byExtraction[kind] !== extractionCounts[kind]) invalid();
  if (Object.keys(coverage.byKind).length !== kindCounts.size || Object.entries(coverage.byKind).some(([kind, count]) => kindCounts.get(kind) !== count)) invalid();
  if (coverage.distinctDocuments !== documents.filter(document => document.duplicateOf === null).length) invalid();
  if (coverage.unreadable.length !== unreadablePaths.size) invalid();
  for (const unreadable of coverage.unreadable) if (!unreadablePaths.delete(unreadable.relativePath)) invalid();
  const reconciliation = coverage.reconciliation;
  const sorted = (paths: ReadonlyArray<string>): string[] => [...paths].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  if (reconciliation === null || reconciliation.receipts !== receipts.length + excludedPaths.length || reconciliation.matched !== receipts.length || reconciliation.documentsWithoutReceipt.length !== 0 || JSON.stringify(sorted(reconciliation.receiptsWithoutDocument)) !== JSON.stringify(sorted(excludedPaths)) || reconciliation.hashMismatches.length !== 0 || coverage.complete !== (excludedPaths.length === 0)) invalid();
  const lines = [...receipts].sort((a, b) => Buffer.compare(Buffer.from(a.relativePath), Buffer.from(b.relativePath))).map(row => {
    const document = paths.get(row.relativePath);
    if (document === undefined) return invalid();
    return `${row.relativePath}\t${document.extraction === 'unreadable' ? 'unreadable' : row.sha256}\n`;
  }).join('');
  if (record.snapshotSha256 !== hash(lines)) invalid();
  return record;
}

/** Accept the current kernel run-result contract, never a partial success-shaped object. */
function validateKernelResult(bytes: Buffer, record: LegalCase, runKey: string, receipts: ReadonlyArray<IntakeRecord>): void {
  const result = object(parse(bytes));
  const envelope = object(result['envelope']);
  const health = object(result['health_decision']);
  const runner = object(envelope['runner']);
  const evidence = object(envelope['evidence_validation']);
  const array = (value: unknown): unknown[] => Array.isArray(value) ? value : invalid();
  const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';
  const digest = (value: unknown): boolean => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
  const oneOf = (value: unknown, allowed: ReadonlyArray<string>): boolean => typeof value === 'string' && allowed.includes(value);
  const nonnegative = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const count = (value: unknown): boolean => nonnegative(value) && Number.isSafeInteger(value);
  const runId = envelope['run_id'];
  if (envelope['schema_version'] !== 1 || !nonempty(runId) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(runId)) invalid();
  if (record.runId !== null && record.runId !== runId) invalid();
  if (envelope['status'] !== 'ok' || envelope['tool_id'] !== record.adapterId || envelope['cycle_id'] !== runKey || !digest(envelope['input_hash']) || !digest(envelope['output_hash']) || !nonnegative(envelope['duration_ms']) || !nonnegative(envelope['cost_units'])) invalid();
  const expectedPaths = new Set(receipts.map(row => `${record.archiveRoot}/${row.relativePath}`));
  const readPaths = array(envelope['read_paths']);
  if (readPaths.length !== expectedPaths.size || new Set(readPaths).size !== readPaths.length || readPaths.some(path => typeof path !== 'string' || !expectedPaths.has(path))) invalid();
  if (array(envelope['operator_feedback_refs']).some(value => !nonempty(value))) invalid();
  array(envelope['memory_candidates']);
  array(envelope['emitted_observations']); array(envelope['emitted_findings']); array(envelope['raw_findings']);
  const snapshot = object(envelope['repo_snapshot']);
  if (snapshot['schema_version'] !== 1) invalid();
  if (runner['type'] !== 'subprocess' || runner['exit_code'] !== 0 || runner['timed_out'] !== false || runner['parse_error'] !== null || !digest(runner['stderr_hash']) || typeof runner['stderr_sample'] !== 'string' || !count(runner['raw_observations_count']) || !count(runner['raw_findings_count'])) invalid();
  if (array(runner['scoped_mutations']).length !== 0 || array(runner['scope_out_mutations']).length !== 0) invalid();
  array(runner['raw_findings_sample']);
  if (evidence['valid'] !== true || evidence['repository_mutation_attempt'] !== false || array(evidence['errors']).length !== 0 || array(evidence['evidence_sources']).some(path => typeof path !== 'string' || !expectedPaths.has(path))) invalid();
  if (health['schema_version'] !== 1 || health['tool_id'] !== record.adapterId || !oneOf(health['status'], ['SHADOW', 'ACTIVE', 'CALIBRATE']) || !oneOf(health['action'], ['none', 'calibrate']) || (health['action'] === 'calibrate' && health['status'] !== 'CALIBRATE') || !nonempty(health['at']) || Number.isNaN(Date.parse(health['at'])) || !nonempty(health['reason'])) invalid();
  object(health['metrics']);
  const runtime = object(envelope['_runtime_artifact_payload']);
  if (typeof runtime['stdout'] !== 'string' || typeof runtime['stderr'] !== 'string' || `sha256:${hash(runtime['stdout'])}` !== envelope['output_hash'] || `sha256:${hash(runtime['stderr'])}` !== runner['stderr_hash']) invalid();
  const output = object(runtime['parsed_output']);
  if (!isDeepStrictEqual(output, parse(Buffer.from(runtime['stdout'])))) invalid();
  const observations = array(runtime['raw_observations']); const findings = array(runtime['raw_findings']);
  if (observations.length !== runner['raw_observations_count'] || findings.length !== runner['raw_findings_count'] || !isDeepStrictEqual(observations, output['observations']) || !isDeepStrictEqual(findings, output['findings']) || !isDeepStrictEqual(findings, envelope['raw_findings'])) invalid();
  if (!isDeepStrictEqual(output['read_paths'], readPaths) || !isDeepStrictEqual(output['evidence_sources'], readPaths) || output['cost_units'] !== envelope['cost_units']) invalid();
  array(output['belief_candidates']);
  const metadata = object(output['metadata']);
  if (metadata['status'] !== 'ok' || metadata['case_id'] !== record.caseId || metadata['archive_root'] !== record.archiveRoot || metadata['adapter_version'] !== record.adapterVersion) invalid();
}

async function durableWrite(path: string, bytes: Buffer): Promise<void> {
  const fd = await open(path, 'wx', 0o400);
  try { await fd.writeFile(bytes); await fd.sync(); } finally { await fd.close(); }
}
function syncDirectory(path: string): void { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
function syncAncestors(path: string, boundary: string): void {
  let current = resolve(path);
  while (current !== resolve(boundary)) { syncDirectory(current); const parent = dirname(current); if (parent === current) invalid(); current = parent; }
  syncDirectory(current);
}
function signed(value: Record<string, unknown>, signer: LedgerSigner): Buffer {
  return Buffer.from(JSON.stringify({ ...value, keyId: signer.keyId, signature: sign(null, Buffer.from(JSON.stringify(value)), signer.privateKey).toString('base64') }));
}
function verified(bytes: Buffer, verifier: LedgerVerifier): Record<string, unknown> {
  const envelope = object(parse(bytes));
  const { keyId, signature, ...payload } = envelope;
  if (keyId !== verifier.keyId || typeof signature !== 'string' || !verify(null, Buffer.from(JSON.stringify(payload)), verifier.publicKey, Buffer.from(signature, 'base64'))) invalid();
  return payload;
}

/** The intake queue protects source capture and publication; authority checks never yield. */
export async function prepareLegalInventory(config: ServerConfig, caseId: string, title: string | null, signer: LedgerSigner, assertAuthority: () => void, worker: LegalWorker = request => runLegalWorker(config, request)): Promise<PreparedLegalInventory> {
  const root = caseRoot(config.legalCasesDir, caseId);
  assertAuthority();
  if (await readCaseMeta(config.legalCasesDir, caseId) === null) throw new HttpError(404, 'case_not_found');
  const runKey = `legal-${randomUUID()}`;
  const jobRoot = join(config.workspaceBase, 'legal-jobs', runKey);
  const snapshotDir = join(jobRoot, 'snapshot');
  const request: LegalWorkerRequest = { caseId, runKey, snapshotDir, toolsDir: join(jobRoot, 'tools'), inputFile: join(jobRoot, 'input.json') };
  const excludeRoots = config.instancePolicy === null ? [] : config.instancePolicy.corpusExcludeRoots;
  const liveProfile = join(config.toolsDir, 'runtime-profile.json');
  const captured = await withReconciledIntake(config.legalCasesDir, caseId, signer, async () => {
    assertAuthority();
    const sourceVersion = versionOfSources(root);
    const decisions = await verifiedDecisions({ casesDir: config.legalCasesDir, verifier: signer }, caseId);
    if (decisions.some(row => row.kind === 'document_removal')) throw new HttpError(409, 'case_content_removal_pending');
    const receipts = await readIntakeLedger(config.legalCasesDir, caseId);
    const excluded = (path: string): boolean => excludeRoots.some(excludedRoot => path === excludedRoot || path.startsWith(`${excludedRoot}/`));
    const includedReceipts = receipts.filter(row => !excluded(row.relativePath));
    const excludedPaths = receipts.filter(row => excluded(row.relativePath)).map(row => row.relativePath);
    await mkdir(snapshotDir, { recursive: true, mode: 0o700 });
    let runtimeProfileFile: string | undefined;
    let runtimeProfileSha256: string | null = null;
    if (profileVersion(liveProfile) !== null) {
      const bytes = await boundedFile(config.toolsDir, liveProfile, MAX_MANIFEST_BYTES);
      runtimeProfileFile = join(jobRoot, 'runtime-profile.json');
      runtimeProfileSha256 = hash(bytes);
      await durableWrite(runtimeProfileFile, bytes);
    }
    for (const receipt of includedReceipts) await copySource(join(root, LEGAL_CASE_LAYOUT.archive), snapshotDir, receipt);
    const input = Buffer.from(JSON.stringify({ case_id: caseId, archive_root: `data/legal-cases/${caseId}/archive`, out_dir: '/output', cycle_id: runKey,
      ...(title === null ? {} : { title }), exclude_roots: excludeRoots,
      intake: receipts.map(row => ({ relativePath: row.relativePath, receivedAt: row.receivedAt, sha256: row.sha256 })) }));
    if (input.length > MAX_INPUT_BYTES) throw new HttpError(413, 'legal_inventory_input_limit');
    await durableWrite(request.inputFile, input);
    if (versionOfSources(root) !== sourceVersion) throw new HttpError(409, 'legal_source_changed');
    return { receipts: includedReceipts, excludedPaths, sourceVersion, inputSha256: hash(input), runtimeProfileFile, runtimeProfileSha256 };
  });
  let executed = false;
  return { runKey, execute: async (): Promise<void> => {
    if (executed) throw new HttpError(409, 'legal_job_already_executed');
    executed = true;
    assertAuthority();
    await worker({ ...request, ...(captured.runtimeProfileFile === undefined ? {} : { runtimeProfileFile: captured.runtimeProfileFile }) });
    const outputDir = join(request.toolsDir, LEGAL_ARTIFACT_ROOT, caseId);
    const artifacts = new Map<string, Buffer>();
    for (const file of FILES) artifacts.set(file, await boundedFile(request.toolsDir, join(outputDir, file), MAX_ARTIFACT_BYTES));
    const record = validateArtifacts(artifacts, caseId, runKey, captured.receipts, captured.excludedPaths);
    const kernelBytes = await boundedFile(request.toolsDir, join(request.toolsDir, KERNEL_RESULT), MAX_ARTIFACT_BYTES);
    validateKernelResult(kernelBytes, record, runKey, captured.receipts);
    artifacts.set(KERNEL_RESULT, kernelBytes);
    const targetRoot = caseArtifacts(config.toolsDir, caseId);
    const runs = join(targetRoot, LEGAL_ARTIFACT_LAYOUT.runs);
    await mkdir(runs, { recursive: true, mode: 0o700 });
    await assertDirectories(await realpath(config.toolsDir), runs);
    syncAncestors(runs, dirname(resolve(config.toolsDir)));
    const staging = join(runs, `.pending-${runKey}`);
    await mkdir(staging, { mode: 0o700 });
    const files: RunFile[] = [];
    for (const [name, bytes] of artifacts) { await durableWrite(join(staging, name), bytes); files.push({ name, sha256: hash(bytes), bytes: bytes.length }); }
    const manifest: RunManifest = { schemaVersion: 1, caseId, runKey, adapterVersion: record.adapterVersion, snapshotSha256: record.snapshotSha256, cycleId: record.cycleId, sourceVersion: captured.sourceVersion, inputSha256: captured.inputSha256, runtimeProfileSha256: captured.runtimeProfileSha256, excludedPaths: captured.excludedPaths, files };
    const manifestBytes = signed({ ...manifest }, signer);
    await durableWrite(join(staging, MANIFEST), manifestBytes);
    const pointer = signed({ schemaVersion: 1, caseId, runKey, adapterVersion: record.adapterVersion, snapshotSha256: record.snapshotSha256, cycleId: record.cycleId, files: FILES, manifestSha256: hash(manifestBytes) }, signer);
    const pointerTemp = join(targetRoot, `.current-${runKey}.tmp`);
    await durableWrite(pointerTemp, pointer);
    syncDirectory(staging);
    await withReconciledIntake(config.legalCasesDir, caseId, signer, async () => {
      const decisions = await verifiedDecisions({ casesDir: config.legalCasesDir, verifier: signer }, caseId);
      if (decisions.some(row => row.kind === 'document_removal')) throw new HttpError(409, 'case_content_removal_pending');
      // No await from this check through both renames: principal administration cannot interleave.
      assertAuthority();
      if (versionOfSources(root) !== captured.sourceVersion) throw new HttpError(409, 'legal_source_changed');
      if (profileVersion(liveProfile) !== captured.runtimeProfileSha256) throw new HttpError(409, 'legal_authority_changed');
      renameSync(staging, join(runs, runKey));
      syncDirectory(runs);
      renameSync(pointerTemp, join(targetRoot, LEGAL_ARTIFACT_LAYOUT.current));
      syncDirectory(targetRoot);
    });
  } };
}

/** A present current pointer is authoritative: malformed signatures never fall back. */
export async function resolveLegalRun(toolsDir: string, caseId: string, verifier: LedgerVerifier | null): Promise<ResolvedLegalRun> {
  const root = caseArtifacts(toolsDir, caseId);
  const current = join(root, LEGAL_ARTIFACT_LAYOUT.current);
  try { await lstat(current); } catch (error) { if (missing(error)) return { dir: root, runKey: null }; throw error; }
  if (verifier === null) throw new HttpError(503, 'ledger_key_missing');
  const pointer = verified(await boundedFile(toolsDir, current, MAX_MANIFEST_BYTES), verifier);
  const runKey = pointer['runKey'];
  if (pointer['schemaVersion'] !== 1 || pointer['caseId'] !== caseId || typeof runKey !== 'string' || !LEGAL_RUN_KEY_RE.test(runKey)) invalid();
  const dir = join(root, LEGAL_ARTIFACT_LAYOUT.runs, runKey);
  const manifestBytes = await boundedFile(toolsDir, join(dir, MANIFEST), MAX_MANIFEST_BYTES);
  if (hash(manifestBytes) !== pointer['manifestSha256']) invalid();
  const manifest = verified(manifestBytes, verifier);
  if (manifest['schemaVersion'] !== 1 || manifest['caseId'] !== caseId || manifest['runKey'] !== runKey || manifest['adapterVersion'] !== pointer['adapterVersion'] || manifest['snapshotSha256'] !== pointer['snapshotSha256'] || manifest['cycleId'] !== pointer['cycleId']) invalid();
  const files = manifest['files'];
  if (!Array.isArray(files) || files.length !== FILES.length + 1) invalid();
  const expected = new Set<string>([...FILES, KERNEL_RESULT]);
  for (const value of files) {
    const file = object(value);
    const name = file['name'];
    if (typeof name !== 'string' || !expected.delete(name) || typeof file['sha256'] !== 'string' || !SHA256.test(file['sha256'])) invalid();
    const bytes = await boundedFile(toolsDir, join(dir, name), MAX_ARTIFACT_BYTES);
    if (bytes.length !== file['bytes'] || hash(bytes) !== file['sha256']) invalid();
  }
  if (expected.size !== 0) invalid();
  return { dir, runKey };
}
