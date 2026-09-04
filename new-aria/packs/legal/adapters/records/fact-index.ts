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
// WHAT: three deterministic passes over already-extracted text.
//   1. labelledFacts   — "Fakturadato: 12.03.2024" → (label, value, locator)
//   2. documentReferences — "iht. avtale av 15.01.2024", "faktura nr. 2024-001"
//   3. contradictions / missingReferences — the comparisons over those two
// Every row carries the document, the locator and the document's content hash,
// so a reader can open the exact bytes the claim came from.
import { byteCompare, collapseWhitespace, extractAmounts, extractDatedMentions, normalizeAmount } from '../legal-text';
import type { DatePrecision } from '../legal-text';

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

// A label is a short run of letters and spaces before a colon. The bound is what
// keeps a sentence containing a colon from being read as a labelled field.
const LABEL_LINE = /^\s*([\p{L}][\p{L} .()/-]{2,39}?)\s*[:：]\s*(\S.*)$/u;

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

export function labelKeyOf(label: string): string {
  return collapseWhitespace(label)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

/**
 * Reads the labelled values out of one line.
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
  const label = collapseWhitespace(match[1] ?? '');
  const rest = match[2] ?? '';
  const labelKey = labelKeyOf(label);
  if (labelKey.length < 3 || LABEL_STOPWORDS.has(labelKey)) return [];
  const out: LabelledFact[] = [];
  const date = extractDatedMentions(rest)[0];
  if (date !== undefined) {
    out.push({
      documentId: line.documentId,
      relativePath: line.relativePath,
      sha256: line.sha256,
      locator: line.locator,
      label,
      labelKey,
      kind: 'date',
      value: date.value,
      raw: collapseWhitespace(rest).slice(0, 120),
      precision: date.precision,
    });
  }
  const amount = extractAmounts(rest)[0];
  if (amount !== undefined) {
    out.push({
      documentId: line.documentId,
      relativePath: line.relativePath,
      sha256: line.sha256,
      locator: line.locator,
      label,
      labelKey,
      kind: 'amount',
      value: normalizeAmount(amount),
      raw: collapseWhitespace(rest).slice(0, 120),
      precision: null,
    });
  }
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

/**
 * Two documents stating different values under the same label.
 *
 * Only CROSS-document disagreements are reported. The same label appearing
 * twice inside one document with different values is usually a table, a
 * restatement or a running header — reporting it would bury the disagreements
 * that matter under noise from a single file's layout.
 */
export function contradictions(facts: readonly LabelledFact[], versionGroupOf: VersionGroups = new Map()): ContradictionRow[] {
  const byKey = new Map<string, LabelledFact[]>();
  for (const fact of facts) {
    const key = `${fact.kind}\n${fact.labelKey}`;
    const bucket = byKey.get(key);
    if (bucket === undefined) byKey.set(key, [fact]);
    else bucket.push(fact);
  }
  const rows: ContradictionRow[] = [];
  for (const bucket of byKey.values()) {
    // One representative per (document, value): the pair reported is the first
    // occurrence in each document, so the row is stable across runs.
    const representative = new Map<string, LabelledFact>();
    for (const fact of [...bucket].sort((a, b) => byteCompare(a.relativePath, b.relativePath) || byteCompare(a.locator, b.locator))) {
      const key = `${fact.documentId}\n${fact.value}`;
      if (!representative.has(key)) representative.set(key, fact);
    }
    const distinct = [...representative.values()];
    for (let left = 0; left < distinct.length; left += 1) {
      for (let right = left + 1; right < distinct.length; right += 1) {
        const a = distinct[left] as LabelledFact;
        const b = distinct[right] as LabelledFact;
        if (a.documentId === b.documentId) continue;
        if (a.value === b.value) continue;
        const groupA = versionGroupOf.get(a.documentId);
        const groupB = versionGroupOf.get(b.documentId);
        if (groupA !== undefined && groupA === groupB) continue;
        // A month and a day inside that month are not in conflict: one is
        // simply less precise. Saying otherwise would manufacture a dispute.
        if (a.kind === 'date' && (a.value.startsWith(b.value) || b.value.startsWith(a.value))) continue;
        rows.push({ labelKey: a.labelKey, label: a.label, kind: a.kind, left: a, right: b });
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
  /** The document's text, lower-cased, for identifier matching. */
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
 * and the check would quietly never fire.
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
