#!/usr/bin/env ts-node
// Legal Case Intelligence pack — document inventory adapter (packs/legal, X-2).
//
// WHY: a case-file archive is only useful as an EVIDENCE-ANCHORED working set —
// every record must point at a file whose bytes have a content hash, every
// file must have a fate (text / metadata_only / unreadable / excluded), and
// nothing may be invented. This adapter is the mechanical floor of the pack:
// it walks the archive deterministically, hashes every file, extracts text
// from plain-text formats and from the text layer of PDF / DOCX / XLSX / PPTX
// (never OCR: a scanned page stays metadata_only WITH its reason), captures
// dates and amounts as strings, groups
// version-like files by name/content, and reads parties + communication events
// ONLY from `.eml` headers. Everything it infers is marked
// `humanReviewRequired: true`; it never writes a statement, never merges two
// addresses into one party, never claims a legal conclusion.
//
// WHAT: stdin JSON `{archive_root, case_id, ...}` → stdout ARIA adapter
// output `{observations, findings, read_paths, evidence_sources,
// belief_candidates, cost_units, metadata}` plus the console artifacts under
// `<out_dir>/packs/legal/cases/<caseId>/*.json` whose shapes are the
// interfaces in `ui/shared/legal-contract.ts` (field names byte-for-byte —
// enforced by `legal-document-inventory.test.ts` against `packs/legal/schemas`).
//
// Laws honoured here: L1 (every finding carries `evidence[]` whose paths are in
// `read_paths`; corpus text is data, never instruction), L2 (the archive is
// never written to), L3 (excluded roots are never read; symlinks are never
// followed; no network, no LLM).
import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, posix, relative, resolve } from 'node:path';

import {
  errorCode,
  hashFile,
  normalizeRelative,
  toPosix,
  walkArchive,
} from './legal-archive';
import { BINARY_TEXT_EXTENSIONS, extractBinaryText } from './binary/extract';
import {
  contradictions,
  documentReferencesIn,
  labelledFactsIn,
  missingReferences,
  type ContradictionRow,
  type DocumentReference,
  type LabelledFact,
  type LocatedText,
  type MissingReferenceRow,
  type ReferenceTarget,
} from './records/fact-index';
import { diffVersions } from './records/version-diff';
import { identityAmbiguities, partyCandidatesIn, type IdentityAmbiguity, type PartyCandidate } from './records/party-candidates';
import { matrixRows } from './records/matrix';
import type { HashedRead, WalkedFile, WalkResult } from './legal-archive';
import { ADAPTER_ID, ADAPTER_VERSION, ARTIFACT_ROOT, DEFAULT_MAX_BINARY_BYTES, DEFAULT_MAX_TEXT_BYTES, EXTRACTION_STATUSES } from './legal-records';
import type {
  ExtractionStatus,
  LegalCase,
  LegalCaseArtifacts,
  LegalCoverage,
  LegalDocument,
  LegalDocumentVersion,
  LegalEvidenceRef,
  LegalLink,
  LegalLinkKind,
  LegalParty,
  LegalTimelineEvent,
  LegalVersionStep,
  VersionOrdinalBasis,
} from './legal-records';
import {
  CASE_ID_RE,
  MEDIA_TYPES,
  TEXT_EXTENSIONS,
  byteCompare,
  collapseWhitespace,
  extensionOf,
  extractAmounts,
  extractDatedMentions,
  extractDates,
  guessKind,
  isSignedName,
  jaccard,
  normalizedStem,
  parseAddressList,
  parseEmail,
  parseRfc2822Date,
  sha256Hex,
  stemOf,
  stripHtml,
  tokensOf,
  uniqueSorted,
  versionNumberOf,
} from './legal-text';
import type { MailAddress } from './legal-text';

// ---------------------------------------------------------------------------
// ARIA adapter I/O (CONTRACTS §1 / §6; tool_runner MINIMUM_OUTPUT_FIELDS).
// ---------------------------------------------------------------------------
export interface LegalInventoryInput {
  readonly archive_root: string;
  readonly case_id: string;
  readonly title?: string;
  readonly exclude_roots?: readonly string[];
  readonly out_dir?: string;
  readonly max_text_bytes?: number;
  /**
   * Largest PDF/Office file whose bytes are loaded for text extraction. A
   * larger file is still hashed and inventoried, but fated metadata_only with
   * reason binary_too_large so the coverage record says why it was not read.
   */
  readonly max_binary_bytes?: number;
  /**
   * When each document reached the archive, from the console's intake receipt.
   *
   * A fact's learned-at is the moment WE could first have known it, which for a
   * document is when it was taken in. Without this the adapter cannot say when
   * anything became knowable and every record's learnedAt stays null — an
   * absence the chronology declares rather than fills with the run's own clock.
   */
  readonly intake?: ReadonlyArray<{ readonly relativePath: string; readonly receivedAt: string }>;
  /** ISO timestamp for LegalCase.createdAt. Absent → newest file mtime in the archive (deterministic per tree state). */
  readonly created_at?: string;
  readonly run_id?: string | null;
  readonly cycle_id?: string | null;
}

export interface EvidenceRef {
  readonly path: string;
  readonly line?: number;
}

export interface AdapterObservation {
  readonly id: string;
  readonly type: 'legal_document_inventoried';
  readonly path: string;
  readonly details: Record<string, unknown>;
}

export type LegalClaimType =
  | 'unreadable_document'
  | 'document_version_conflict'
  | 'date_contradiction'
  | 'amount_contradiction'
  | 'missing_evidence'
  | 'party_identity_ambiguity';

export interface AdapterFinding {
  readonly id: string;
  readonly rule: LegalClaimType;
  readonly severity: 'medium' | 'low';
  readonly path: string;
  readonly message: string;
  readonly evidence: readonly EvidenceRef[];
  readonly confidence: number;
}

export interface AriaOutput {
  readonly observations: readonly AdapterObservation[];
  readonly findings: readonly AdapterFinding[];
  readonly read_paths: readonly string[];
  readonly evidence_sources: readonly string[];
  readonly belief_candidates: readonly never[];
  readonly cost_units: number;
  readonly metadata: Record<string, unknown>;
}

export interface LegalInventoryResult {
  readonly output: AriaOutput;
  readonly artifacts: LegalCaseArtifacts | null;
  readonly artifactDir: string | null;
  readonly writtenFiles: readonly string[];
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------
interface InventoryEntry {
  readonly file: WalkedFile;
  readonly document: LegalDocument;
  readonly text: string | null;
  readonly textTruncated: boolean;
  readonly readFailure: string | null;
  /** Why a metadata_only file yielded no text (extractor's stated reason), or null. */
  readonly noTextReason: string | null;
}

function documentIdFor(relativePath: string, contentSha256: string): string {
  // Identity = path + content so two byte-identical files in different places
  // stay two documents (they must, to be grouped as VERSION_OF each other).
  return `doc_${sha256Hex(`${relativePath}\n${contentSha256}`).slice(0, 16)}`;
}

function inventoryFile(file: WalkedFile, caseId: string, maxTextBytes: number, maxBinaryBytes: number): InventoryEntry {
  const fileName = posix.basename(file.relativePath);
  const extension = extensionOf(fileName);
  const mediaType = MEDIA_TYPES[extension] ?? null;
  const guess = guessKind(fileName);
  const modifiedAt = file.mtime.toISOString();
  const base = {
    caseId,
    relativePath: file.relativePath,
    fileName,
    extension,
    mediaType,
    bytes: file.bytes,
    modifiedAt,
    kindGuess: guess.kind,
    kindConfidence: guess.confidence,
  };
  const build = (
    extraction: ExtractionStatus,
    sha256: string,
    excerpt: string | null,
    dates: readonly string[],
    amounts: readonly string[],
    excludedReason: string | null,
  ): LegalDocument => ({
    documentId: documentIdFor(file.relativePath, sha256),
    caseId: base.caseId,
    relativePath: base.relativePath,
    fileName: base.fileName,
    extension: base.extension,
    mediaType: base.mediaType,
    bytes: base.bytes,
    sha256,
    modifiedAt: base.modifiedAt,
    kindGuess: base.kindGuess,
    kindConfidence: base.kindConfidence,
    extraction,
    excerpt,
    datesMentioned: dates,
    amountsMentioned: amounts,
    versionGroupId: null,
    excludedReason,
  });

  if (file.excluded) {
    // Bytes under an excluded root are never opened — not even to hash them.
    return {
      file,
      document: build('excluded', '', null, [], [], `excluded_root:${file.excludedRoot ?? ''}`),
      text: null,
      textTruncated: false,
      readFailure: null,
      noTextReason: null,
    };
  }
  if (file.symlink) {
    return {
      file,
      document: build('unreadable', '', null, [], [], null),
      text: null,
      textTruncated: false,
      readFailure: 'symlink_not_followed',
      noTextReason: null,
    };
  }
  const wantsText = TEXT_EXTENSIONS.has(extension);
  const wantsBinaryText = BINARY_TEXT_EXTENSIONS.has(extension);
  // A PDF or Office container must be read whole: its text layer is not a
  // prefix of the file. A plain-text file only needs its head. Everything else
  // is hashed without keeping any bytes.
  const binaryTooLarge = wantsBinaryText && file.bytes > maxBinaryBytes;
  const headBytes = wantsText ? maxTextBytes : wantsBinaryText && !binaryTooLarge ? file.bytes : 0;
  let hashed: HashedRead;
  try {
    hashed = hashFile(file.absolutePath, headBytes);
  } catch (error: unknown) {
    return {
      file,
      document: build('unreadable', '', null, [], [], null),
      text: null,
      textTruncated: false,
      readFailure: `read_failed:${errorCode(error)}`,
      noTextReason: null,
    };
  }
  const metadataOnly = (reason: string): InventoryEntry => ({
    file,
    document: build('metadata_only', hashed.sha256, null, [], [], null),
    text: null,
    textTruncated: false,
    readFailure: null,
    noTextReason: reason,
  });
  if (!wantsText && !wantsBinaryText) {
    return metadataOnly(`no_text_extraction_for_extension:${extension || '(none)'}`);
  }
  if (binaryTooLarge) {
    return metadataOnly(`binary_too_large:${file.bytes}>${maxBinaryBytes}`);
  }
  let text: string;
  let textTruncated = hashed.truncated;
  if (wantsBinaryText) {
    const outcome = extractBinaryText(extension, hashed.head);
    if (outcome.status === 'no_text') return metadataOnly(outcome.reason);
    // Downstream regex passes are bounded by max_text_bytes exactly as for
    // plain-text files, so a 900-page PDF cannot dominate the run.
    textTruncated = outcome.text.length > maxTextBytes;
    text = textTruncated ? outcome.text.slice(0, maxTextBytes) : outcome.text;
  } else {
    text = hashed.head.toString('utf8').replace(/^\uFEFF/, '');
    if (extension === '.html' || extension === '.htm') {
      text = stripHtml(text);
    }
  }
  // Page markers (\f[page N]) are locators for readers of `text`; they are not
  // prose and must not lead the excerpt.
  const withoutPageMarkers = text.replace(/(?:^|\f)\[page \d+\]\n?/gm, '');
  const excerptSource = extension === '.eml' ? parseEmail(text).body : withoutPageMarkers;
  const excerpt = collapseWhitespace(excerptSource).slice(0, 240) || null;
  return {
    file,
    document: build('text', hashed.sha256, excerpt, extractDates(text), extractAmounts(text), null),
    text,
    textTruncated,
    readFailure: null,
    noTextReason: null,
  };
}

// ---------------------------------------------------------------------------
// Version groups (union-find over identical sha256 OR identical normalised stem)
// ---------------------------------------------------------------------------
interface VersionGrouping {
  readonly versions: readonly LegalDocumentVersion[];
  readonly groupIdByDocument: ReadonlyMap<string, string>;
  readonly membersByGroup: ReadonlyMap<string, readonly InventoryEntry[]>;
}

/**
 * The text of a document as the case-content passes should read it.
 *
 * An e-mail's headers are transport metadata; scanning them for case content
 * turns every message's own send time and address list into case facts.
 */
function scannedText(entry: InventoryEntry): string {
  if (entry.text === null) return '';
  return entry.document.extension === '.eml' ? parseEmail(entry.text).body : entry.text;
}

/** The labelled values one document states, located the way a reader would find them. */
function labelledFactsOf(entry: InventoryEntry): LabelledFact[] {
  if (entry.text === null) return [];
  const scanned = scannedText(entry);
  const facts: LabelledFact[] = [];
  for (const line of locatedLines(scanned)) {
    facts.push(
      ...labelledFactsIn({
        documentId: entry.document.documentId,
        relativePath: entry.document.relativePath,
        sha256: entry.document.sha256,
        locator: line.locator,
        text: line.text,
      }),
    );
  }
  return facts;
}

function buildVersionGroups(entries: readonly InventoryEntry[]): VersionGrouping {
  const candidates = entries.filter((entry) => entry.document.extraction === 'text' || entry.document.extraction === 'metadata_only');
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let cursor = id;
    while (parent.get(cursor) !== cursor) {
      cursor = parent.get(cursor) ?? cursor;
    }
    return cursor;
  };
  const union = (a: string, b: string): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(byteCompare(rootA, rootB) < 0 ? rootB : rootA, byteCompare(rootA, rootB) < 0 ? rootA : rootB);
  };
  const byStem = new Map<string, string>();
  const bySha = new Map<string, string>();
  for (const entry of candidates) {
    const id = entry.document.documentId;
    parent.set(id, id);
    const stem = normalizedStem(entry.document.fileName);
    const stemOwner = byStem.get(stem);
    if (stemOwner) union(id, stemOwner);
    else byStem.set(stem, id);
    const shaOwner = bySha.get(entry.document.sha256);
    if (shaOwner) union(id, shaOwner);
    else bySha.set(entry.document.sha256, id);
  }
  const groups = new Map<string, InventoryEntry[]>();
  for (const entry of candidates) {
    const root = find(entry.document.documentId);
    const list = groups.get(root) ?? [];
    list.push(entry);
    groups.set(root, list);
  }
  const versions: LegalDocumentVersion[] = [];
  const groupIdByDocument = new Map<string, string>();
  const membersByGroup = new Map<string, readonly InventoryEntry[]>();
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const stems = members.map((member) => normalizedStem(member.document.fileName)).sort(byteCompare);
    const versionGroupId = `vg_${sha256Hex(stems[0] ?? '').slice(0, 12)}`;
    const numbers = members.map((member) => versionNumberOf(member.document.fileName));
    const distinctNumbers = new Set(numbers.filter((value): value is number => value !== null));
    const numberedOrder = numbers.every((value) => value !== null) && distinctNumbers.size === members.length;
    const ordered = [...members].sort((a, b) => {
      if (numberedOrder) {
        return (versionNumberOf(a.document.fileName) ?? 0) - (versionNumberOf(b.document.fileName) ?? 0);
      }
      const byTime = a.file.mtime.getTime() - b.file.mtime.getTime();
      return byTime !== 0 ? byTime : byteCompare(a.document.relativePath, b.document.relativePath);
    });
    const shaCounts = new Map<string, number>();
    const mtimeCounts = new Map<number, number>();
    for (const member of ordered) {
      shaCounts.set(member.document.sha256, (shaCounts.get(member.document.sha256) ?? 0) + 1);
      mtimeCounts.set(member.file.mtime.getTime(), (mtimeCounts.get(member.file.mtime.getTime()) ?? 0) + 1);
    }
    let previousTokens: string[] | null = null;
    const memberRecords = ordered.map((member, index) => {
      const tokens = tokensOf(stemOf(member.document.fileName));
      let basis: VersionOrdinalBasis;
      if (numberedOrder) basis = 'name_suffix';
      else if ((shaCounts.get(member.document.sha256) ?? 0) > 1) basis = 'content_similarity';
      else if ((mtimeCounts.get(member.file.mtime.getTime()) ?? 0) === 1) basis = 'file_mtime';
      else basis = 'unknown';
      const record = {
        documentId: member.document.documentId,
        ordinal: index + 1,
        basis,
        similarityToPrevious: previousTokens === null ? null : jaccard(tokens, previousTokens),
      };
      previousTokens = tokens;
      return record;
    });
    let signedMember: string | null = null;
    for (const member of ordered) {
      if (isSignedName(member.document.fileName)) signedMember = member.document.documentId;
    }
    // What moved between each consecutive pair. A version group that only says
    // "these belong together" leaves the reader to open both files and compare
    // by hand; the comparison is mechanical, so the pack does it and quotes
    // both sides. It never nominates a member as authoritative — that is a
    // lawyer's declaration (approval class filed_version_declaration).
    const steps: LegalVersionStep[] = [];
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1];
      const current = ordered[index];
      if (previous === undefined || current === undefined) continue;
      if (previous.text === null || current.text === null) continue;
      const diff = diffVersions(
        { text: previous.text, facts: labelledFactsOf(previous) },
        { text: current.text, facts: labelledFactsOf(current) },
      );
      steps.push({
        fromDocumentId: previous.document.documentId,
        toDocumentId: current.document.documentId,
        values: [
          ...diff.changedValues.map((change) => ({
            label: change.label,
            kind: change.kind,
            from: change.from,
            to: change.to,
            fromLocator: change.fromLocator,
            toLocator: change.toLocator,
          })),
          ...diff.addedValues.map((value) => ({ label: value.label, kind: value.kind, from: null, to: value.value, fromLocator: null, toLocator: value.locator })),
          ...diff.removedValues.map((value) => ({ label: value.label, kind: value.kind, from: value.value, to: null, fromLocator: value.locator, toLocator: null })),
        ],
        addedLines: diff.addedLines.length,
        removedLines: diff.removedLines.length,
        unchangedLines: diff.unchangedLines,
        humanReviewRequired: true,
      });
    }
    versions.push({
      versionGroupId,
      members: memberRecords,
      signedMember,
      filedMember: null,
      steps,
      humanReviewRequired: true,
    });
    membersByGroup.set(versionGroupId, ordered);
    for (const member of ordered) groupIdByDocument.set(member.document.documentId, versionGroupId);
  }
  versions.sort((a, b) => byteCompare(a.versionGroupId, b.versionGroupId));
  return { versions, groupIdByDocument, membersByGroup };
}

// ---------------------------------------------------------------------------
// Parties, timeline, links
// ---------------------------------------------------------------------------
interface PartyAccumulator {
  readonly address: string;
  readonly displayNames: Set<string>;
  mentions: number;
  readonly evidence: LegalEvidenceRef[];
}

interface Derived {
  readonly parties: readonly LegalParty[];
  readonly timeline: readonly LegalTimelineEvent[];
  readonly links: readonly LegalLink[];
  /** Names that look alike across documents. A question for a human, never a merge. */
  readonly identityAmbiguities: readonly IdentityAmbiguity[];
}

/** Party ids are content-derived so two runs over one archive agree. */
function partyIdForName(nameKey: string): string {
  return `party_${sha256Hex(`name\n${nameKey}`).slice(0, 12)}`;
}

function evidenceRef(document: LegalDocument, locator: string): LegalEvidenceRef {
  return { documentId: document.documentId, locator, sha256: document.sha256 };
}

function partyIdFor(address: string): string {
  return `party_${sha256Hex(address.toLowerCase()).slice(0, 12)}`;
}

function linkIdFor(kind: LegalLinkKind, fromId: string, toId: string): string {
  return `lnk_${sha256Hex(`${kind}\n${fromId}\n${toId}`).slice(0, 12)}`;
}

/**
 * Splits extracted text into locatable lines.
 *
 * PDF text carries page markers, so an event inside a PDF is located by page —
 * a line number in an extracted stream is a coordinate in a file nobody can
 * open. Text without markers keeps line numbers, which a reader can follow.
 */
interface LocatedLine {
  readonly text: string;
  readonly locator: string;
}

function locatedLines(text: string): LocatedLine[] {
  const out: LocatedLine[] = [];
  let page: number | null = null;
  let lineNumber = 0;
  for (const raw of text.split(/\r?\n/)) {
    lineNumber += 1;
    const marker = /^\f?\[page (\d+)\]$/.exec(raw.trim());
    if (marker !== null) {
      page = Number(marker[1]);
      continue;
    }
    out.push({ text: raw, locator: page === null ? `line:${lineNumber}` : `page:${page}` });
  }
  return out;
}

/**
 * The mechanical disagreement pass.
 *
 * Reading every document's text once more to compare what they STATE is the
 * cheapest honest answer to "what conflicts here?": both sides are quoted from
 * bytes, both carry a locator and a content hash, and the result is identical on
 * every run. It is deliberately placed under the judge lane rather than beside
 * it — a layer that cannot hallucinate has to hold the floor.
 */
interface FactIndex {
  readonly facts: readonly LabelledFact[];
  readonly references: readonly DocumentReference[];
  readonly contradictions: readonly ContradictionRow[];
  readonly missing: readonly MissingReferenceRow[];
}

function buildFactIndex(entries: readonly InventoryEntry[], grouping: VersionGrouping): FactIndex {
  const facts: LabelledFact[] = [];
  const references: DocumentReference[] = [];
  const targets: ReferenceTarget[] = [];
  for (const entry of entries) {
    if (entry.text === null) continue;
    const document = entry.document;
    const identifiers: string[] = [document.fileName.toLowerCase()];
    const dates = new Set<string>(document.datesMentioned);
    // An e-mail's headers are transport metadata, not case content: `Date:`
    // there is when the message was sent, and comparing two messages' send
    // times would report every pair of e-mails as a disagreement.
    const scanned = scannedText(entry);
    for (const line of locatedLines(scanned)) {
      const located: LocatedText = {
        documentId: document.documentId,
        relativePath: document.relativePath,
        sha256: document.sha256,
        locator: line.locator,
        text: line.text,
      };
      const lineFacts = labelledFactsIn(located);
      facts.push(...lineFacts);
      references.push(...documentReferencesIn(located));
      // A document's own header lines are what a reference to it would name.
      identifiers.push(line.text.toLowerCase());
    }
    targets.push({
      documentId: document.documentId,
      relativePath: document.relativePath,
      fileName: document.fileName,
      haystack: identifiers.join('\n'),
      dates,
    });
  }
  return {
    facts,
    references,
    contradictions: contradictions(facts, grouping.groupIdByDocument),
    missing: missingReferences(references, targets),
  };
}

function deriveRecords(entries: readonly InventoryEntry[], grouping: VersionGrouping, learnedAt: ReadonlyMap<string, string>): Derived {
  const parties = new Map<string, PartyAccumulator>();
  const textParties = new Map<string, { candidate: PartyCandidate; mentions: number; evidence: LegalEvidenceRef[] }>();
  const textCandidates: PartyCandidate[] = [];
  const timeline: LegalTimelineEvent[] = [];
  const links: LegalLink[] = [];

  const touchParty = (mail: MailAddress, document: LegalDocument, header: string): string => {
    const existing = parties.get(mail.address) ?? { address: mail.address, displayNames: new Set<string>(), mentions: 0, evidence: [] };
    existing.mentions += 1;
    if (mail.displayName) existing.displayNames.add(mail.displayName);
    existing.evidence.push(evidenceRef(document, `header:${header}`));
    parties.set(mail.address, existing);
    return partyIdFor(mail.address);
  };

  for (const entry of entries) {
    if (entry.text === null) continue;
    const document = entry.document;
    if (document.extension === '.eml') {
      const mail = parseEmail(entry.text);
      const header = (name: string): string | undefined => mail.headers.get(name)?.[0];
      const senders = parseAddressList(header('from') ?? '');
      const recipients = [
        ...parseAddressList(header('to') ?? '').map((address) => ({ address, header: 'To' })),
        ...parseAddressList(header('cc') ?? '').map((address) => ({ address, header: 'Cc' })),
      ];
      for (const sender of senders) {
        const partyId = touchParty(sender, document, 'From');
        links.push({
          linkId: linkIdFor('WAS_SENT_BY', document.documentId, partyId),
          kind: 'WAS_SENT_BY',
          from: { kind: 'DOCUMENT', id: document.documentId },
          to: { kind: 'PARTY', id: partyId },
          evidence: [evidenceRef(document, 'header:From')],
          confidence: 0.6,
        });
      }
      for (const recipient of recipients) {
        const partyId = touchParty(recipient.address, document, recipient.header);
        links.push({
          linkId: linkIdFor('WAS_RECEIVED_BY', document.documentId, partyId),
          kind: 'WAS_RECEIVED_BY',
          from: { kind: 'DOCUMENT', id: document.documentId },
          to: { kind: 'PARTY', id: partyId },
          evidence: [evidenceRef(document, `header:${recipient.header}`)],
          confidence: 0.6,
        });
      }
      const dateHeader = header('date');
      const parsedDate = dateHeader === undefined ? null : parseRfc2822Date(dateHeader);
      if (parsedDate) {
        const subject = collapseWhitespace(header('subject') ?? '');
        const fromNames = senders.map((sender) => sender.displayName ?? sender.address).join(', ');
        const toNames = recipients.map((recipient) => recipient.address.displayName ?? recipient.address.address).join(', ');
        timeline.push({
          eventId: `evt_${sha256Hex(`${document.relativePath}:header:Date\n${parsedDate.iso}`).slice(0, 12)}`,
          kind: 'COMMUNICATION',
          occurredAt: parsedDate.iso,
          learnedAt: learnedAt.get(document.relativePath) ?? null,
          datePrecision: parsedDate.precision,
          summary: `Email "${subject}" from ${fromNames} to ${toNames}`.slice(0, 200),
          evidence: [evidenceRef(document, 'header:Date')],
          assertedBy: 'party',
          confidence: 0.6,
          humanReviewRequired: true,
        });
      }
      continue;
    }
    // Parties named in the text, not only in an e-mail header. Nothing is
    // merged: two spellings stay two candidates, and their resemblance is
    // raised as a question the approval policy hands to a lawyer.
    for (const line of locatedLines(scannedText(entry))) {
      const located: LocatedText = {
        documentId: document.documentId,
        relativePath: document.relativePath,
        sha256: document.sha256,
        locator: line.locator,
        text: line.text,
      };
      for (const found of partyCandidatesIn(located)) {
        textCandidates.push(found);
        const existing = textParties.get(found.displayName);
        if (existing === undefined) {
          textParties.set(found.displayName, { candidate: found, mentions: 1, evidence: [evidenceRef(document, found.locator)] });
        } else {
          existing.mentions += 1;
          // One evidence ref per document: a name repeated on every page of one
          // file is one document's word, not many sources agreeing.
          if (!existing.evidence.some((ref) => ref.documentId === document.documentId)) {
            existing.evidence.push(evidenceRef(document, found.locator));
          }
        }
      }
    }
    // A dated line becomes an EVENT candidate. The source is
    // `mechanical_extraction`: a parser read these bytes at this locator and
    // would read them the same way tomorrow. It is NOT `ai_inference` — no
    // model ran — and it is not the party's own assertion either, so confidence
    // stays low and human review is always required. The date's precision
    // travels with it; a month mention never becomes a day.
    for (const line of locatedLines(entry.text)) {
      const mention = extractDatedMentions(line.text)[0];
      if (mention === undefined) continue;
      const words = line.text.match(/\p{L}{2,}/gu) ?? [];
      if (words.length < 3) continue;
      timeline.push({
        eventId: `evt_${sha256Hex(`${document.relativePath}:${line.locator}\n${mention.value}`).slice(0, 12)}`,
        kind: 'EVENT',
        occurredAt: mention.value,
        learnedAt: learnedAt.get(document.relativePath) ?? null,
        datePrecision: mention.precision,
        summary: collapseWhitespace(line.text).slice(0, 200),
        evidence: [evidenceRef(document, line.locator)],
        assertedBy: 'mechanical_extraction',
        confidence: 0.35,
        humanReviewRequired: true,
      });
    }
  }

  for (const [versionGroupId, members] of grouping.membersByGroup) {
    for (let index = 1; index < members.length; index += 1) {
      const current = members[index]?.document;
      const previous = members[index - 1]?.document;
      if (!current || !previous) continue;
      links.push({
        linkId: linkIdFor('VERSION_OF', current.documentId, previous.documentId),
        kind: 'VERSION_OF',
        from: { kind: 'DOCUMENT', id: current.documentId },
        to: { kind: 'DOCUMENT', id: previous.documentId },
        evidence: [
          { documentId: current.documentId, versionId: versionGroupId, sha256: current.sha256 },
          { documentId: previous.documentId, versionId: versionGroupId, sha256: previous.sha256 },
        ],
        confidence: current.sha256 === previous.sha256 ? 0.9 : 0.5,
      });
    }
  }

  const partyRecords: LegalParty[] = [...parties.values()]
    .map((party) => {
      const names = [...party.displayNames].sort(byteCompare);
      return {
        partyId: partyIdFor(party.address),
        displayName: names[0] ?? party.address,
        kind: 'unknown' as const,
        roles: [],
        aliases: uniqueSorted([...names, party.address]),
        mentions: party.mentions,
        evidence: party.evidence,
        identityConfidence: names.length > 0 ? 0.5 : 0.4,
        humanReviewRequired: true,
      };
    })
    .sort((a, b) => byteCompare(a.partyId, b.partyId));

  // Text-derived parties join the header-derived ones, with their own ids and
  // the basis they were read from. An address-derived party is not replaced by
  // a name that resembles it: only a human may decide those are one identity.
  const addressAliases = new Set(partyRecords.flatMap((party) => party.aliases.map((alias) => alias.toLowerCase())));
  const textRecords: LegalParty[] = [...textParties.values()]
    .filter((entry) => !addressAliases.has(entry.candidate.displayName.toLowerCase()))
    .map((entry) => ({
      partyId: partyIdForName(entry.candidate.nameKey),
      displayName: entry.candidate.displayName,
      kind: entry.candidate.kind,
      // A role is only recorded when the document labelled it; an organisation
      // form says what a party IS, never what it does in this case.
      roles: entry.candidate.basis === 'party_label' ? [entry.candidate.basis] : [],
      aliases: entry.candidate.organisationNumber === null ? [entry.candidate.displayName] : uniqueSorted([entry.candidate.displayName, entry.candidate.organisationNumber]),
      mentions: entry.mentions,
      evidence: entry.evidence,
      identityConfidence: entry.candidate.confidence,
      humanReviewRequired: true,
    }));
  const allParties = [...partyRecords, ...textRecords].sort((a, b) => byteCompare(a.partyId, b.partyId));

  timeline.sort((a, b) => byteCompare(a.occurredAt ?? '', b.occurredAt ?? '') || byteCompare(a.eventId, b.eventId));
  links.sort((a, b) => byteCompare(a.linkId, b.linkId));
  return { parties: allParties, timeline, links, identityAmbiguities: identityAmbiguities(textCandidates) };
}

// ---------------------------------------------------------------------------
// Coverage + case
// ---------------------------------------------------------------------------
function buildCoverage(
  caseId: string,
  entries: readonly InventoryEntry[],
  walk: WalkResult,
  excludedRoots: readonly string[],
): LegalCoverage {
  const byExtraction: Record<ExtractionStatus, number> = { text: 0, metadata_only: 0, unreadable: 0, excluded: 0 };
  const kindCounts = new Map<string, number>();
  const unreadable: { relativePath: string; reason: string }[] = [];
  for (const entry of entries) {
    byExtraction[entry.document.extraction] += 1;
    kindCounts.set(entry.document.kindGuess, (kindCounts.get(entry.document.kindGuess) ?? 0) + 1);
    if (entry.document.extraction === 'unreadable') {
      unreadable.push({ relativePath: entry.document.relativePath, reason: entry.readFailure ?? 'read_failed:UNKNOWN' });
    } else if (entry.document.extraction === 'metadata_only') {
      unreadable.push({ relativePath: entry.document.relativePath, reason: entry.noTextReason ?? `no_text_extraction_for_extension:${entry.document.extension || '(none)'}` });
    }
  }
  for (const failure of walk.directoryErrors) {
    unreadable.push({ relativePath: failure.relativePath, reason: failure.reason });
  }
  unreadable.sort((a, b) => byteCompare(a.relativePath, b.relativePath));
  const byKind: Record<string, number> = {};
  for (const kind of [...kindCounts.keys()].sort(byteCompare)) {
    byKind[kind] = kindCounts.get(kind) ?? 0;
  }
  return {
    caseId,
    totalFiles: entries.length,
    byExtraction,
    byKind,
    excludedRoots: [...excludedRoots].sort(byteCompare),
    unreadable,
    // Complete = every file has a fate AND no directory was left unwalked.
    complete: walk.directoryErrors.length === 0 && entries.every((entry) => EXTRACTION_STATUSES.includes(entry.document.extraction)),
  };
}

function snapshotSha256(entries: readonly InventoryEntry[]): string {
  const lines = entries.map((entry) => `${entry.document.relativePath}\t${entry.document.sha256 || entry.document.extraction}\n`);
  return sha256Hex(lines.join(''));
}

// ---------------------------------------------------------------------------
// Artifact writing (never outside out_dir; atomic per file)
// ---------------------------------------------------------------------------
function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

export function writeArtifacts(outDir: string, artifacts: LegalCaseArtifacts): { readonly dir: string; readonly files: readonly string[] } {
  const root = resolve(outDir);
  const dir = resolve(root, ARTIFACT_ROOT, artifacts.case.caseId);
  const escape = relative(root, dir);
  if (escape.startsWith('..') || isAbsolute(escape)) {
    throw new Error(`artifact directory escapes out_dir: ${dir}`);
  }
  mkdirSync(dir, { recursive: true });
  const files: string[] = [];
  const table: ReadonlyArray<readonly [string, unknown]> = [
    ['case.json', artifacts.case],
    ['documents.json', artifacts.documents],
    ['versions.json', artifacts.versions],
    ['parties.json', artifacts.parties],
    ['timeline.json', artifacts.timeline],
    ['statements.json', artifacts.statements],
    ['links.json', artifacts.links],
    ['coverage.json', artifacts.coverage],
  ];
  for (const [name, value] of table) {
    const path = resolve(dir, name);
    writeJsonAtomic(path, value);
    files.push(path);
  }
  return { dir, files };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${ADAPTER_ID}: input.${field} is required and must be a non-empty string`);
  }
  return value;
}

export function runLegalDocumentInventory(input: LegalInventoryInput, cwd: string = process.cwd()): LegalInventoryResult {
  const archiveRootInput = requireString(input.archive_root, 'archive_root');
  const caseSlug = requireString(input.case_id, 'case_id');
  if (!CASE_ID_RE.test(caseSlug)) {
    throw new Error(`${ADAPTER_ID}: input.case_id must match ${CASE_ID_RE.source} (it names an artifact directory)`);
  }
  const maxTextBytes = input.max_text_bytes ?? DEFAULT_MAX_TEXT_BYTES;
  if (!Number.isInteger(maxTextBytes) || maxTextBytes < 0) {
    throw new Error(`${ADAPTER_ID}: input.max_text_bytes must be a non-negative integer`);
  }
  const maxBinaryBytes = input.max_binary_bytes ?? DEFAULT_MAX_BINARY_BYTES;
  if (!Number.isInteger(maxBinaryBytes) || maxBinaryBytes < 0) {
    throw new Error(`${ADAPTER_ID}: input.max_binary_bytes must be a non-negative integer`);
  }
  const excludeRoots = uniqueSorted(
    (input.exclude_roots ?? []).map((root) => {
      const normalized = normalizeRelative(String(root));
      if (normalized === '' || isAbsolute(normalized) || normalized.split('/').includes('..')) {
        throw new Error(`${ADAPTER_ID}: exclude_roots entries must be relative paths inside the archive: ${root}`);
      }
      return normalized;
    }),
  );
  const caseId = `case_${caseSlug}`;
  const archiveRootPosix = normalizeRelative(archiveRootInput) || '.';
  const archiveRootAbs = resolve(cwd, archiveRootInput);
  const outDir = resolve(cwd, input.out_dir ?? process.env['ARIA_TOOLS_DIR'] ?? 'aria-tools');

  if (!existsSync(archiveRootAbs) || !statSync(archiveRootAbs).isDirectory()) {
    // G-10 convention: an absent scope exits clean with a status, never a crash.
    return {
      output: {
        observations: [],
        findings: [],
        read_paths: [],
        evidence_sources: [],
        belief_candidates: [],
        cost_units: 0,
        metadata: { case_id: caseId, out_dir: toPosix(outDir), archive_root: archiveRootPosix, status: 'scope_absent', adapter_version: ADAPTER_VERSION },
      },
      artifacts: null,
      artifactDir: null,
      writtenFiles: [],
    };
  }

  const walk = walkArchive(archiveRootAbs, excludeRoots);
  const entries = walk.files.map((file) => inventoryFile(file, caseId, maxTextBytes, maxBinaryBytes));
  const grouping = buildVersionGroups(entries);
  const documents: LegalDocument[] = entries
    .map((entry) => ({ ...entry.document, versionGroupId: grouping.groupIdByDocument.get(entry.document.documentId) ?? null }))
    .sort((a, b) => byteCompare(a.relativePath, b.relativePath));
  // The receipt is keyed by the path inside archive/, which is exactly the
  // relative path the walk produces, so the two line up without translation.
  const learnedAt = new Map((input.intake ?? []).map((row) => [normalizeRelative(row.relativePath), row.receivedAt]));
  const derived = deriveRecords(entries, grouping, learnedAt);
  const factIndex = buildFactIndex(entries, grouping);
  const statements = matrixRows(factIndex.contradictions, factIndex.missing);
  const presentExcludedRoots = excludeRoots.filter((root) => walk.matchedExcludeRoots.has(root) || existsSync(resolve(archiveRootAbs, root)));
  const coverage = buildCoverage(caseId, entries, walk, presentExcludedRoots);
  const newestMtime = entries.reduce<Date | null>((newest, entry) => (newest === null || entry.file.mtime > newest ? entry.file.mtime : newest), null);
  const legalCase: LegalCase = {
    caseId,
    title: input.title ?? caseSlug,
    jurisdiction: null,
    courtReference: null,
    archiveRoot: archiveRootPosix,
    createdAt: input.created_at ?? (newestMtime ?? new Date(0)).toISOString(),
    snapshotSha256: snapshotSha256(entries),
    adapterId: ADAPTER_ID,
    adapterVersion: ADAPTER_VERSION,
    runId: input.run_id ?? null,
    cycleId: input.cycle_id ?? null,
  };
  const artifacts: LegalCaseArtifacts = {
    case: legalCase,
    documents,
    versions: grouping.versions,
    parties: derived.parties,
    timeline: derived.timeline,
    // The matrix rows the archive itself supports: a value two documents state
    // differently, and a reference the archive cannot satisfy. Rows that need
    // reading comprehension stay an agent's job, and their absence is visible.
    statements,
    links: derived.links,
    coverage,
  };
  const written = writeArtifacts(outDir, artifacts);

  // stdout paths are addressed the way the caller addressed the archive
  // (archive_root as given + relative path) so a workspace-relative archive
  // yields workspace-resolvable evidence for the kernel validator.
  const workspacePath = (relativePath: string): string => (archiveRootPosix === '.' ? relativePath : `${archiveRootPosix}/${relativePath}`);
  const readPaths: string[] = [];
  const observations: AdapterObservation[] = [];
  const findings: AdapterFinding[] = [];
  for (const entry of entries) {
    const document = entry.document;
    const path = workspacePath(document.relativePath);
    if (!entry.file.excluded) readPaths.push(path);
    observations.push({
      id: `${ADAPTER_ID}:doc:${document.relativePath}`,
      type: 'legal_document_inventoried',
      path,
      details: {
        documentId: document.documentId,
        extraction: document.extraction,
        kindGuess: document.kindGuess,
        sha256: document.sha256,
        bytes: document.bytes,
        textTruncated: entry.textTruncated,
        versionGroupId: grouping.groupIdByDocument.get(document.documentId) ?? null,
      },
    });
    if (document.extraction === 'unreadable' || document.extraction === 'metadata_only') {
      const reason = coverage.unreadable.find((gap) => gap.relativePath === document.relativePath)?.reason ?? 'unknown';
      findings.push({
        id: `${ADAPTER_ID}:unreadable:${document.relativePath}`,
        rule: 'unreadable_document',
        severity: 'medium',
        path,
        message:
          `\`${document.relativePath}\` has no extracted text (${reason}); it is inventoried as ${document.extraction} ` +
          'and is a coverage gap until a human supplies its content.',
        evidence: [{ path }],
        confidence: 0.95,
      });
    }
  }
  for (const version of grouping.versions) {
    const members = grouping.membersByGroup.get(version.versionGroupId) ?? [];
    const first = members[0];
    if (!first) continue;
    findings.push({
      id: `${ADAPTER_ID}:version-group:${version.versionGroupId}`,
      rule: 'document_version_conflict',
      severity: 'low',
      path: workspacePath(first.document.relativePath),
      message:
        `${members.length} files share a version lineage (${members.map((member) => `\`${member.document.relativePath}\``).join(', ')}); ` +
        'which one is authoritative requires human review.',
      evidence: members.map((member) => ({ path: workspacePath(member.document.relativePath) })),
      confidence: 0.5,
    });
  }
  // Two documents disagreeing about a value they both state. Both sides travel
  // with their locator and their content hash: a contradiction reported from one
  // side is an accusation, and the reader must be able to open both.
  for (const row of factIndex.contradictions) {
    findings.push({
      id: `${ADAPTER_ID}:${row.kind}-contradiction:${row.labelKey}:${row.left.relativePath}:${row.right.relativePath}`,
      rule: row.kind === 'date' ? 'date_contradiction' : 'amount_contradiction',
      severity: 'medium',
      path: workspacePath(row.left.relativePath),
      message:
        `\`${row.left.relativePath}\` (${row.left.locator}) states ${row.label} = ${row.left.value} ` +
        `while \`${row.right.relativePath}\` (${row.right.locator}) states ${row.right.value}. ` +
        'Both readings are mechanical; which is correct requires human review.',
      evidence: [{ path: workspacePath(row.left.relativePath) }, { path: workspacePath(row.right.relativePath) }],
      confidence: 0.6,
    });
  }
  // Two spellings that look like one party. This is a QUESTION: the approval
  // policy reserves party_identity_merge for a lawyer, and a tool that merged
  // them quietly would destroy the distinction a conflict check depends on.
  for (const row of derived.identityAmbiguities) {
    findings.push({
      id: `${ADAPTER_ID}:party-identity:${row.nameKey}:${row.left.displayName}:${row.right.displayName}`,
      rule: 'party_identity_ambiguity',
      severity: 'low',
      path: workspacePath(row.left.relativePath),
      message:
        `\`${row.left.relativePath}\` (${row.left.locator}) names "${row.left.displayName}" while ` +
        `\`${row.right.relativePath}\` (${row.right.locator}) names "${row.right.displayName}". ` +
        'They are kept as separate parties; deciding they are one identity is a lawyer\'s call.',
      evidence: [{ path: workspacePath(row.left.relativePath) }, { path: workspacePath(row.right.relativePath) }],
      confidence: 0.4,
    });
  }
  // A document naming a document the archive does not hold. The message states
  // the scope that was searched, because "not found" is only meaningful against
  // a known set.
  for (const row of factIndex.missing) {
    findings.push({
      id: `${ADAPTER_ID}:missing-evidence:${row.reference.kind}:${row.reference.identifier}`,
      rule: 'missing_evidence',
      severity: 'medium',
      path: workspacePath(row.reference.relativePath),
      message:
        `\`${row.reference.relativePath}\` (${row.reference.locator}) refers to ${row.reference.kind} ${row.reference.identifier} ` +
        `("${row.reference.raw}"), and no document among the ${row.searchedDocuments} readable files in this archive matches it. ` +
        'The referenced document is either missing from the archive or filed under a name this pass could not connect.',
      evidence: [{ path: workspacePath(row.reference.relativePath) }],
      confidence: 0.5,
    });
  }
  const sortedReadPaths = uniqueSorted(readPaths);
  const output: AriaOutput = {
    observations: observations.sort((a, b) => byteCompare(a.id, b.id)),
    findings: findings.sort((a, b) => byteCompare(a.id, b.id)),
    read_paths: sortedReadPaths,
    evidence_sources: sortedReadPaths,
    belief_candidates: [],
    cost_units: entries.length,
    metadata: {
      case_id: caseId,
      out_dir: toPosix(outDir),
      archive_root: archiveRootPosix,
      adapter_version: ADAPTER_VERSION,
      status: 'ok',
      artifact_dir: toPosix(written.dir),
      exclude_roots_declared: excludeRoots,
      exclude_roots_not_found: excludeRoots.filter((root) => !presentExcludedRoots.includes(root)),
      coverage: {
        totalFiles: coverage.totalFiles,
        byExtraction: coverage.byExtraction,
        excludedRoots: coverage.excludedRoots,
        unreadable: coverage.unreadable.length,
        complete: coverage.complete,
      },
      version_groups: grouping.versions.length,
      parties: derived.parties.length,
      timeline_events: derived.timeline.length,
      labelled_facts: factIndex.facts.length,
      document_references: factIndex.references.length,
      contradictions: factIndex.contradictions.length,
      missing_references: factIndex.missing.length,
      party_identity_ambiguities: derived.identityAmbiguities.length,
      statements: statements.length,
    },
  };
  return { output, artifacts, artifactDir: written.dir, writtenFiles: written.files };
}

function readStdin(): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string | Buffer) => {
      input += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    });
    process.stdin.on('end', () => resolvePromise(input));
    process.stdin.on('error', reject);
  });
}

async function main(): Promise<void> {
  const raw = await readStdin();
  if (raw.trim().length === 0) {
    throw new Error(`${ADAPTER_ID}: stdin JSON is required ({archive_root, case_id, ...})`);
  }
  const input = JSON.parse(raw) as LegalInventoryInput;
  const result = runLegalDocumentInventory(input);
  process.stdout.write(`${JSON.stringify(result.output)}\n`);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}

