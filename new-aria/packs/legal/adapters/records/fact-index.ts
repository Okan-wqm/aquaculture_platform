// Mechanical fact index: labelled dates and amounts, and what refers to what.
//
// WHY: "this document says the invoice date is 12.03.2024 and that one says
// 26.03.2024" is the single most useful thing a case tool can tell a lawyer, and
// it is also the easiest thing to get wrong by asking a model. It does not need
// a model: both documents state the value next to a label, and comparing two
// stated values is arithmetic. Doing it mechanically means the answer is
// reproducible, carries both sides with their locators, and can never be a
// hallucination — which is the whole point of putting this layer under the
// judges rather than beside them.
//
// MEASURED 2026-09-04, two ways this layer fell short of a real archive:
//   - It read only `Label: value` on one flowing line. Spreadsheets (tab-separated
//     cells, no colons), PDF field tables (label on one line, value on the next),
//     labels carrying a digit (`Pkt 3 frist:`) and sums stated in prose
//     ("Kontraktssummen er avtalt til NOK 4 950 000") were all invisible.
//   - It compared every pair of documents that used the same label. Two
//     unrelated invoices each stating their own `Beløp` became a dispute; on 400
//     unrelated letters that was 237,880 false rows. A shared LABEL is not a
//     shared SUBJECT. Two documents may disagree only when a mechanical anchor
//     says they are about the same thing: one cites the other, or both cite the
//     same reference (an agreement date, an invoice number, a case number).
//
// WHAT: deterministic passes over already-extracted text.
//   1. labelledFactsInLines — labelled values from lines, table rows, split
//      label/value pairs and prose amounts, each with the shape it was read in
//   2. documentReferencesIn — "iht. avtale av 15.01.2024", "faktura nr. 2024-001"
//   3. contradictions / missingReferences — comparisons over those two, where a
//      contradiction needs a shared subject anchor and each (label, subject)
//      cluster yields one row per distinct value rather than one per pair
// Every row carries the document, the locator and the document's content hash,
// so a reader can open the exact bytes the claim came from.
import { byteCompare, collapseWhitespace, extractAmounts, extractDatedMentions, normalizeAmount } from '../legal-text';
import type { DatePrecision } from '../legal-text';

/** The shape a labelled value was read in. Informational; it never changes the value. */
export type FactSource = 'label' | 'table' | 'split' | 'prose';

/** A value a document states next to a label. */
export interface LabelledFact {
  readonly documentId: string;
  readonly relativePath: string;
  readonly sha256: string;
  readonly locator: string;
  /** The label as written, collapsed: "Fakturadato". */
  readonly label: string;
  /** Comparison key: lower-cased, punctuation and spacing removed. */
  readonly labelKey: string;
  readonly kind: 'date' | 'amount';
  /** ISO date at its stated precision, or the normalised numeric amount. */
  readonly value: string;
  /** How the value was written, for a reader who wants the original wording. */
  readonly raw: string;
  readonly precision: DatePrecision | null;
  readonly source: FactSource;
}

/** A document naming another document. */
export interface DocumentReference {
  readonly documentId: string;
  readonly relativePath: string;
  readonly sha256: string;
  readonly locator: string;
  /** Document class as named: avtale, faktura, klage… */
  readonly kind: string;
  /** The identifying token: a date, a number, or a reference string. */
  readonly identifier: string;
  readonly raw: string;
}

export interface ContradictionRow {
  readonly labelKey: string;
  readonly label: string;
  readonly kind: 'date' | 'amount';
  readonly left: LabelledFact;
  readonly right: LabelledFact;
  /** The reference both documents share, which is why they may disagree at all. */
  readonly anchor: string;
}

/**
 * Documents that are versions of one another.
 *
 * Two drafts of the same agreement stating different prices are not in
 * conflict — that is what a revision IS, and it belongs in the version
 * comparison where the reader is told what changed. Reporting it as a
 * contradiction would bury the disagreements BETWEEN parties under the
 * ordinary history of one document.
 */
export type VersionGroups = ReadonlyMap<string, string>;

/**
 * Subject anchors per document: the reference keys (`kind:identifier`) a
 * document carries, whether it names itself by one or cites another by it.
 * Two documents share a subject when their key sets intersect.
 */
export type SubjectAnchors = ReadonlyMap<string, ReadonlySet<string>>;

export interface MissingReferenceRow {
  readonly reference: DocumentReference;
  /** What was searched, so "not found" is a statement about a known scope. */
  readonly searchedDocuments: number;
}

/** One line of already-extracted text with a locator a reader can follow. */
export interface LocatedText {
  readonly documentId: string;
  readonly relativePath: string;
  readonly sha256: string;
  readonly locator: string;
  readonly text: string;
}

// A label is a short run before a colon: letters, spaces, a few punctuation
// marks and — since 2026-09-05 — digits, so `Pkt 3 frist:` is a label. It must
// still carry at least three letters, so a date followed by a colon is not one.
const LABEL_LINE = /^\s*([\p{L}\p{N}][\p{L}\p{N} .()/-]{2,39}?)\s*[:：]\s*(\S.*)$/u;
/** A line that is ONLY a label: the value sits on the next line (PDF field tables). */
const LABEL_ONLY_LINE = /^\s*([\p{L}\p{N}][\p{L}\p{N} .()/-]{2,39}?)\s*[:：]\s*$/u;
const LETTERS = /\p{L}/gu;

/**
 * Labels that do NOT name a shared fact, and would manufacture disagreements.
 *
 * Two kinds sit here. Transport headers (`From`, `Subject`, `Date` on an e-mail)
 * describe the message, not the case. Self-describing fields (`Dato`, `Sted`,
 * `Vår ref`) describe the document they sit in: two documents written on
 * different days both stating their own date is not a conflict, it is two
 * documents. Only a label that names a specific thing — `Fakturadato`,
 * `Forfallsdato`, `Kontraktssum`, `Svarfrist` — can be compared across files.
 */
const LABEL_STOPWORDS: ReadonlySet<string> = new Set([
  // Message transport
  'fra', 'til', 'from', 'to', 'cc', 'bcc', 'subject', 'emne', 're', 'vedlegg', 'attachment', 'date', 'sent', 'received',
  // Self-describing document fields
  'dato', 'datum', 'sted', 'place', 'signatur', 'sign', 'underskrift', 'side', 'page', 'ref', 'referanse', 'reference',
  'vårref', 'deresref', 'ourref', 'yourref', 'saksnr', 'saksnummer', 'caseno', 'casenumber', 'versjon', 'version',
]);

/** Words that sit between a noun and the amount it states, and are not the noun. */
const PROSE_CONNECTORS: ReadonlySet<string> = new Set([
  'er', 'ble', 'var', 'blir', 'utgjør', 'utgjorde', 'på', 'til', 'av', 'med', 'om', 'for', 'avtalt', 'fastsatt', 'satt', 'beregnet', 'kr',
  'is', 'was', 'be', 'at', 'of', 'to', 'for', 'in', 'amounts', 'amounted', 'set', 'agreed', 'fixed', 'total', 'totalling', 'totaling',
  'og', 'and', 'som', 'that', 'the', 'a', 'an', 'en', 'et', 'ei',
]);

export function labelKeyOf(label: string): string {
  return collapseWhitespace(label)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

function letterCount(text: string): number {
  return (text.match(LETTERS) ?? []).length;
}

function usableLabel(label: string): { readonly label: string; readonly labelKey: string } | null {
  const collapsed = collapseWhitespace(label);
  const labelKey = labelKeyOf(collapsed);
  if (labelKey.length < 3 || letterCount(collapsed) < 3 || LABEL_STOPWORDS.has(labelKey)) return null;
  return { label: collapsed, labelKey };
}

function factsFromValue(line: LocatedText, label: { readonly label: string; readonly labelKey: string }, value: string, source: FactSource): LabelledFact[] {
  const out: LabelledFact[] = [];
  const date = extractDatedMentions(value)[0];
  if (date !== undefined) {
    out.push({
      documentId: line.documentId,
      relativePath: line.relativePath,
      sha256: line.sha256,
      locator: line.locator,
      label: label.label,
      labelKey: label.labelKey,
      kind: 'date',
      value: date.value,
      raw: collapseWhitespace(value).slice(0, 120),
      precision: date.precision,
      source,
    });
  }
  const amount = extractAmounts(value)[0];
  if (amount !== undefined) {
    out.push({
      documentId: line.documentId,
      relativePath: line.relativePath,
      sha256: line.sha256,
      locator: line.locator,
      label: label.label,
      labelKey: label.labelKey,
      kind: 'amount',
      value: normalizeAmount(amount),
      raw: collapseWhitespace(value).slice(0, 120),
      precision: null,
      source,
    });
  }
  return out;
}

/**
 * Reads the labelled values out of one flowing line.
 *
 * A line may state a date AND an amount ("Beløp eks. mva: NOK 4 950 000,00");
 * both are recorded under the same label, because that is what the document
 * says. Only the FIRST value of each kind is taken: a line listing three
 * amounts is a table row, and pairing its label with each of them would invent
 * relationships the document does not state.
 */
export function labelledFactsIn(line: LocatedText): LabelledFact[] {
  const match = LABEL_LINE.exec(line.text);
  if (match === null) return [];
  const label = usableLabel(match[1] ?? '');
  if (label === null) return [];
  return factsFromValue(line, label, match[2] ?? '', 'label');
}

/** A cell that is a plain number (a spreadsheet's numeric cell, no currency written). */
const PLAIN_NUMBER = /^\s*-?\d{1,3}(?:[ . ]\d{3})*(?:[.,]\d{1,2})?\s*$|^\s*-?\d+(?:[.,]\d{1,2})?\s*$/;
/** A header cell naming a money column, and the currency it names when it does. */
const MONEY_HEADER = /\b(bel[øo]p|sum|pris|amount|total|kostnad|cost|verdi|value)\b/iu;
const HEADER_CURRENCY = /\b(nok|kr|eur|usd)\b/iu;

/**
 * Reads the labelled values out of a run of tab-separated rows (a spreadsheet
 * sheet, a DOCX table).
 *
 * A row's text cell names the item; its date cells and money cells are the
 * values. A numeric cell with no currency written is an amount only when the
 * header row names the column as money, and the currency then comes from that
 * header ("Beløp NOK") or stays unstated. Nothing is guessed from a bare
 * number under a column the header did not name.
 */
export function tabularFactsIn(rows: readonly LocatedText[]): LabelledFact[] {
  const out: LabelledFact[] = [];
  let header: readonly string[] | null = null;
  for (const row of rows) {
    const cells = row.text.split('\t').map((cell) => collapseWhitespace(cell));
    const isHeader = cells.every((cell) => cell === '' || (letterCount(cell) >= 2 && extractDatedMentions(cell).length === 0 && extractAmounts(cell).length === 0 && !PLAIN_NUMBER.test(cell)));
    if (isHeader) {
      header = cells;
      continue;
    }
    const textCells = cells.filter((cell) => cell !== '' && extractDatedMentions(cell).length === 0 && extractAmounts(cell).length === 0 && !PLAIN_NUMBER.test(cell) && letterCount(cell) >= 3);
    // The label is the row's own text cell; failing that, the header of the
    // first text column. A row with neither names nothing and yields nothing.
    const labelText = textCells[0] ?? null;
    const label = labelText === null ? null : usableLabel(labelText);
    if (label === null) continue;
    cells.forEach((cell, column) => {
      if (cell === '' || cell === labelText) return;
      const headerCell = header?.[column] ?? '';
      if (extractDatedMentions(cell).length > 0 || extractAmounts(cell).length > 0) {
        out.push(...factsFromValue(row, label, cell, 'table'));
        return;
      }
      if (PLAIN_NUMBER.test(cell) && MONEY_HEADER.test(headerCell)) {
        const currency = HEADER_CURRENCY.exec(headerCell)?.[1] ?? '';
        out.push(...factsFromValue(row, label, `${currency} ${cell}`.trim() + (currency === '' ? ' kr' : ''), 'table').map((fact) => (currency === '' ? { ...fact, value: normalizeAmount(cell), raw: cell } : fact)));
      }
    });
  }
  return out;
}

/**
 * Amounts stated in prose, with the noun before them as the label:
 * "Kontraktssummen er avtalt til NOK 4 950 000 eks. mva" → Kontraktssummen.
 *
 * The label is the run of words immediately before the amount with the
 * connecting words ("er avtalt til") removed from its tail. A line that has a
 * labelled shape is not read here; a line whose noun cannot be found yields
 * nothing rather than a guess.
 */
export function proseAmountFactsIn(line: LocatedText): LabelledFact[] {
  if (LABEL_LINE.test(line.text) || line.text.includes('\t')) return [];
  const out: LabelledFact[] = [];
  const text = line.text;
  for (const amount of extractAmounts(text)) {
    const at = text.indexOf(amount);
    if (at <= 0) continue;
    const before = text.slice(0, at).replace(/[,;:.–-]\s*$/, '');
    const clause = before.split(/[.;:,()–]/).pop() ?? '';
    const words = clause.trim().split(/\s+/).filter((word) => word !== '').slice(-6);
    while (words.length > 0 && PROSE_CONNECTORS.has((words[words.length - 1] ?? '').toLowerCase())) words.pop();
    const nounPhrase = words.slice(-3).join(' ');
    const label = usableLabel(nounPhrase);
    if (label === null || extractDatedMentions(nounPhrase).length > 0) continue;
    out.push(...factsFromValue(line, label, amount, 'prose').filter((fact) => fact.kind === 'amount'));
  }
  return out;
}

/**
 * Every labelled value a document's lines state, read in every shape this
 * layer understands: flowing `Label: value` lines, a label alone followed by
 * its value on the next line, tab-separated table rows, and sums in prose.
 */
export function labelledFactsInLines(lines: readonly LocatedText[]): LabelledFact[] {
  const out: LabelledFact[] = [];
  let tableRun: LocatedText[] = [];
  let pendingLabel: { readonly label: string; readonly labelKey: string } | null = null;
  const flushTable = (): void => {
    if (tableRun.length > 0) out.push(...tabularFactsIn(tableRun));
    tableRun = [];
  };
  for (const line of lines) {
    if (line.text.includes('\t')) {
      pendingLabel = null;
      tableRun.push(line);
      continue;
    }
    flushTable();
    if (line.text.trim() === '') continue;
    const labelOnly = LABEL_ONLY_LINE.exec(line.text);
    if (labelOnly !== null) {
      pendingLabel = usableLabel(labelOnly[1] ?? '');
      continue;
    }
    if (pendingLabel !== null) {
      // The value line of a split pair is short: a date or an amount and little
      // else. A sentence after a bare label is a paragraph, not a field value.
      const words = line.text.trim().split(/\s+/).length;
      if (words <= 6 && (extractDatedMentions(line.text).length > 0 || extractAmounts(line.text).length > 0)) {
        out.push(...factsFromValue(line, pendingLabel, line.text, 'split'));
        pendingLabel = null;
        continue;
      }
      pendingLabel = null;
    }
    const labelled = labelledFactsIn(line);
    if (labelled.length > 0) {
      out.push(...labelled);
      continue;
    }
    out.push(...proseAmountFactsIn(line));
  }
  flushTable();
  return out;
}

/** Document classes a legal archive names in running text. */
const REFERENCE_KINDS = ['avtale', 'kontrakt', 'faktura', 'klage', 'anke', 'dom', 'kjennelse', 'protokoll', 'rapport', 'agreement', 'contract', 'invoice', 'complaint', 'decision', 'minutes', 'report'];
const REFERENCE_KIND_ALTERNATION = REFERENCE_KINDS.join('|');
/** "avtale av 15.01.2024", "faktura datert 2024-03-12", "agreement dated 2024-01-15". */
const REFERENCE_BY_DATE = new RegExp(`(?<![\\p{L}])(${REFERENCE_KIND_ALTERNATION})\\w*\\s+(?:av|datert|dated|of|from)\\s+(\\S+(?:\\s+\\p{L}+\\s+\\d{4})?)`, 'giu');
/** "faktura nr. 2024-001", "invoice no 2024-001", "faktura 2024-001". */
const REFERENCE_BY_NUMBER = new RegExp(`(?<![\\p{L}])(${REFERENCE_KIND_ALTERNATION})\\w*\\s+(?:nr\\.?|no\\.?|number|#)?\\s*([0-9][\\w-]{2,})`, 'giu');

/** Every reference a line makes to another document. */
export function documentReferencesIn(line: LocatedText): DocumentReference[] {
  const out: DocumentReference[] = [];
  const seen = new Set<string>();
  const push = (kind: string, identifier: string, raw: string): void => {
    const key = `${kind}\n${identifier}`;
    if (identifier === '' || seen.has(key)) return;
    seen.add(key);
    out.push({
      documentId: line.documentId,
      relativePath: line.relativePath,
      sha256: line.sha256,
      locator: line.locator,
      kind: kind.toLowerCase(),
      identifier,
      raw: collapseWhitespace(raw).slice(0, 120),
    });
  };
  for (const match of line.text.matchAll(REFERENCE_BY_DATE)) {
    const date = extractDatedMentions(match[2] ?? '')[0];
    if (date !== undefined) push(match[1] ?? '', date.value, match[0]);
  }
  for (const match of line.text.matchAll(REFERENCE_BY_NUMBER)) {
    push(match[1] ?? '', (match[2] ?? '').toLowerCase(), match[0]);
  }
  return out;
}

/** The subject key a reference contributes: `faktura:2024-001`, `avtale:2024-01-15`. */
export function subjectKeyOf(reference: Pick<DocumentReference, 'kind' | 'identifier'>): string {
  return `${reference.kind}:${reference.identifier}`;
}

const NAME_IDENTIFIER = /[0-9][\w-]{2,}/g;

/**
 * The subject keys a document IS, read from its own file name:
 * `faktura_2024-001.pdf` is `faktura:2024-001`, `avtale_2024-01-15.txt` is
 * `avtale:2024-01-15`. A document that names itself this way is the SUBJECT
 * other documents cite; what it states about itself is what a citing document
 * may disagree with.
 */
export function selfSubjectKeysOf(fileName: string): string[] {
  const lower = fileName.toLowerCase();
  const kinds = REFERENCE_KINDS.filter((kind) => lower.includes(kind));
  if (kinds.length === 0) return [];
  const identifiers = new Set<string>();
  for (const date of extractDatedMentions(lower)) identifiers.add(date.value);
  for (const match of lower.matchAll(NAME_IDENTIFIER)) identifiers.add(match[0]);
  const keys: string[] = [];
  for (const kind of kinds) for (const identifier of identifiers) keys.push(`${kind}:${identifier}`);
  return keys.sort(byteCompare);
}

/**
 * Builds the per-document subject anchors: the keys each document cites, plus
 * the keys it IS by its own name. Two documents share a subject when their
 * anchor sets intersect.
 */
export function subjectAnchorsOf(references: readonly DocumentReference[], selfKeys: SubjectAnchors = new Map()): SubjectAnchors {
  const anchors = new Map<string, Set<string>>();
  for (const [documentId, keys] of selfKeys) anchors.set(documentId, new Set(keys));
  for (const reference of references) {
    const keys = anchors.get(reference.documentId) ?? new Set<string>();
    keys.add(subjectKeyOf(reference));
    anchors.set(reference.documentId, keys);
  }
  return anchors;
}

function sharedAnchor(a: string, b: string, anchors: SubjectAnchors): string | null {
  const keysA = anchors.get(a);
  const keysB = anchors.get(b);
  if (keysA === undefined || keysB === undefined) return null;
  const shared = [...keysA].filter((key) => keysB.has(key)).sort(byteCompare);
  return shared[0] ?? null;
}

/**
 * Two documents stating different values under the same label ABOUT THE SAME
 * SUBJECT.
 *
 * Only CROSS-document disagreements are reported; the same label twice inside
 * one document is a table, a restatement or a running header. Two documents
 * qualify only when a mechanical anchor says they are about the same thing —
 * they share a reference key — and never when they are versions of one
 * another.
 *
 * When the SUBJECT itself is in the archive (a document whose own name carries
 * the key: the invoice every complaint cites), a disagreement is between what
 * the subject states of itself and what a citing document states of it; a
 * label the subject never states is each citing document's own fact, not a
 * fact about the subject, and three hundred letters citing one agreement and
 * each stating their own `Beløp` are three hundred amounts, not a dispute.
 * When the subject is absent from the archive, the citing documents may still
 * disagree with each other, one row per distinct value against the
 * first-stated value — never one per pair.
 */
export function contradictions(
  facts: readonly LabelledFact[],
  versionGroupOf: VersionGroups = new Map(),
  anchors: SubjectAnchors = new Map(),
  selfKeys: SubjectAnchors = new Map(),
): ContradictionRow[] {
  const byKey = new Map<string, LabelledFact[]>();
  for (const fact of facts) {
    const key = `${fact.kind}\n${fact.labelKey}`;
    const bucket = byKey.get(key);
    if (bucket === undefined) byKey.set(key, [fact]);
    else bucket.push(fact);
  }
  const rows: ContradictionRow[] = [];
  for (const bucket of byKey.values()) {
    // One representative per (document, value): the first occurrence in each
    // document, so the row is stable across runs.
    const representative = new Map<string, LabelledFact>();
    for (const fact of [...bucket].sort((a, b) => byteCompare(a.relativePath, b.relativePath) || byteCompare(a.locator, b.locator))) {
      const key = `${fact.documentId}\n${fact.value}`;
      if (!representative.has(key)) representative.set(key, fact);
    }
    const distinct = [...representative.values()];
    // Cluster by shared subject: union-find over documents whose anchors meet.
    const parent = new Map<string, string>();
    const find = (id: string): string => {
      let cursor = id;
      while ((parent.get(cursor) ?? cursor) !== cursor) cursor = parent.get(cursor) ?? cursor;
      return cursor;
    };
    for (const fact of distinct) parent.set(fact.documentId, fact.documentId);
    const anchorBetween = new Map<string, string>();
    for (let left = 0; left < distinct.length; left += 1) {
      for (let right = left + 1; right < distinct.length; right += 1) {
        const a = distinct[left] as LabelledFact;
        const b = distinct[right] as LabelledFact;
        if (a.documentId === b.documentId) continue;
        const anchor = sharedAnchor(a.documentId, b.documentId, anchors);
        if (anchor === null) continue;
        anchorBetween.set(`${a.documentId}\n${b.documentId}`, anchor);
        anchorBetween.set(`${b.documentId}\n${a.documentId}`, anchor);
        const rootA = find(a.documentId);
        const rootB = find(b.documentId);
        if (rootA !== rootB) parent.set(byteCompare(rootA, rootB) < 0 ? rootB : rootA, byteCompare(rootA, rootB) < 0 ? rootA : rootB);
      }
    }
    const clusters = new Map<string, LabelledFact[]>();
    for (const fact of distinct) {
      const root = find(fact.documentId);
      const list = clusters.get(root) ?? [];
      list.push(fact);
      clusters.set(root, list);
    }
    for (const members of clusters.values()) {
      if (members.length < 2) continue;
      const ordered = [...members].sort((a, b) => byteCompare(a.relativePath, b.relativePath) || byteCompare(a.locator, b.locator));
      // The keys that hold this cluster together, and whether any document in
      // the ARCHIVE (in this bucket or not) IS one of those subjects.
      const clusterKeys = new Set<string>();
      for (const fact of ordered) for (const key of anchors.get(fact.documentId) ?? []) clusterKeys.add(key);
      const subjectDocuments = new Set<string>();
      for (const [documentId, keys] of selfKeys) {
        if ([...keys].some((key) => clusterKeys.has(key))) subjectDocuments.add(documentId);
      }
      const subjectFacts = ordered.filter((fact) => subjectDocuments.has(fact.documentId));
      // A subject is in the archive but states nothing under this label: the
      // citing documents' values are their own facts, not claims about it.
      if (subjectDocuments.size > 0 && subjectFacts.length === 0) continue;
      // The subject's own statement leads when there is one; otherwise the
      // first-stated value does. Every other distinct value is one row.
      const leads = subjectFacts.length > 0 ? subjectFacts : [ordered[0] as LabelledFact];
      const seenValues = new Set<string>(leads.map((fact) => fact.value));
      const lead = leads[0] as LabelledFact;
      for (const other of ordered) {
        if (leads.some((candidate) => candidate.documentId === other.documentId)) continue;
        if (seenValues.has(other.value)) continue;
        const groupA = versionGroupOf.get(lead.documentId);
        const groupB = versionGroupOf.get(other.documentId);
        if (groupA !== undefined && groupA === groupB) continue;
        // A month and a day inside that month are not in conflict: one is
        // simply less precise. Saying otherwise would manufacture a dispute.
        if (lead.kind === 'date' && (lead.value.startsWith(other.value) || other.value.startsWith(lead.value))) continue;
        seenValues.add(other.value);
        const anchor = anchorBetween.get(`${lead.documentId}\n${other.documentId}`) ?? sharedAnchor(lead.documentId, other.documentId, anchors) ?? [...clusterKeys].sort(byteCompare)[0] ?? '';
        rows.push({ labelKey: lead.labelKey, label: lead.label, kind: lead.kind, left: lead, right: other, anchor });
      }
    }
  }
  return rows.sort((a, b) => byteCompare(a.labelKey, b.labelKey) || byteCompare(a.left.relativePath, b.left.relativePath) || byteCompare(a.right.relativePath, b.right.relativePath));
}

/** Text a document carries that could satisfy a reference to it. */
export interface ReferenceTarget {
  readonly documentId: string;
  readonly relativePath: string;
  /** The file's own name: what a reference to this document would most likely say. */
  readonly fileName: string;
  /** The document's text, lower-cased, for identifier matching. Empty for a document that could not be read. */
  readonly haystack: string;
  /** Dates the document states, at any precision. */
  readonly dates: ReadonlySet<string>;
}

/**
 * References the archive cannot satisfy.
 *
 * "Not found" is a claim about a searched scope, so the row records how many
 * documents were searched.
 *
 * A candidate must look like the KIND referred to — its file name carries the
 * word — before its content is allowed to satisfy the reference. Without that,
 * any document merely mentioning the same date would answer for the agreement,
 * and the check would quietly never fire. A document that could not be read
 * still answers by its NAME: a scanned agreement sitting in the archive is
 * present, not missing.
 */
export function missingReferences(references: readonly DocumentReference[], targets: readonly ReferenceTarget[]): MissingReferenceRow[] {
  const rows: MissingReferenceRow[] = [];
  const seen = new Set<string>();
  const selfNames = new Map(targets.map((target) => [target.documentId, target.fileName.toLowerCase()]));
  for (const reference of references) {
    // A document's own title line ("FAKTURA nr. 2024-001" at the head of
    // faktura_2024-001.pdf) is the document naming ITSELF, not a reference to
    // something else. Treating it as a missing document would make every
    // invoice in an archive report its own absence.
    if ((selfNames.get(reference.documentId) ?? '').includes(reference.identifier)) continue;
    const satisfied = targets.some((target) => {
      if (target.documentId === reference.documentId) return false;
      const name = target.fileName.toLowerCase();
      if (name.includes(reference.identifier)) return true;
      if (!name.includes(reference.kind)) return false;
      return target.dates.has(reference.identifier) || target.haystack.includes(reference.identifier);
    });
    if (satisfied) continue;
    const key = `${reference.kind}\n${reference.identifier}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ reference, searchedDocuments: targets.length });
  }
  return rows.sort((a, b) => byteCompare(a.reference.kind, b.reference.kind) || byteCompare(a.reference.identifier, b.reference.identifier));
}
