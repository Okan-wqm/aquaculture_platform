// Party candidates read out of document text, never merged.
//
// WHY: today a party exists only if it appeared in an e-mail header. The
// contractor named on every page of the contract, the counsel signing the
// complaint and the court in the decision are all invisible, so "who is in this
// case and who did what" cannot be answered from the archive the tool just read.
// Reading them from the text is mechanical — an organisation form (`AS`, `ASA`,
// `ANS`), an organisation number, or a `v/ advokat X` construction is a shape,
// not a judgement.
//
// WHAT: candidates with the locator they were read at, a confidence that never
// exceeds the e-mail-header floor, and NO merging. Two spellings stay two
// candidates: deciding that `Nordlys Entreprenør AS` and `Nordlys AS` are one
// party is `party_identity_merge`, which the instance's approval policy reserves
// for a lawyer. What this module may do is say the two look alike and let a
// human decide.
import { byteCompare, collapseWhitespace } from '../legal-text';
import type { LocatedText } from './fact-index';

export interface PartyCandidate {
  /** The name as written in the document. */
  readonly displayName: string;
  /** Comparison key: lower-cased, organisation form and punctuation removed. */
  readonly nameKey: string;
  readonly kind: 'organization' | 'person' | 'court' | 'authority' | 'unknown';
  /** The shape that produced it, so a reader can judge the reading. */
  readonly basis: 'organisation_form' | 'organisation_number' | 'counsel_construction' | 'party_label';
  readonly documentId: string;
  readonly relativePath: string;
  readonly sha256: string;
  readonly locator: string;
  /** The organisation number when the document stated one next to the name. */
  readonly organisationNumber: string | null;
  /** Never above 0.5: a name in running text is weaker than a header address. */
  readonly confidence: number;
}

/** Two candidates whose names differ only in form or spacing. Never merged here. */
export interface IdentityAmbiguity {
  readonly nameKey: string;
  readonly left: PartyCandidate;
  readonly right: PartyCandidate;
}

/** Norwegian and English organisation forms that mark a name as an organisation. */
const ORG_FORMS = ['AS', 'ASA', 'ANS', 'DA', 'BA', 'SA', 'KS', 'NUF', 'Ltd', 'AB', 'GmbH', 'Inc', 'LLC', 'PLC'];
const ORG_FORM_ALTERNATION = ORG_FORMS.join('|');

/** "Nordlys Entreprenør AS", "Bergen Eiendom ASA". A capitalised run ending in a form. */
const ORGANISATION = new RegExp(`(?<![\\p{L}])((?:\\p{Lu}[\\p{L}&.'-]*\\s+){0,5}\\p{Lu}[\\p{L}&.'-]*\\s+(?:${ORG_FORM_ALTERNATION}))(?![\\p{L}])`, 'gu');
/** "org.nr. 987 654 321", "organisasjonsnummer 987654321". */
const ORG_NUMBER = /(?:org\.?\s*nr\.?|organisasjonsnummer|orgnr)\s*:?\s*((?:\d[\s.]?){9})/giu;
/** "v/ advokat Kari Nordmann", "ved advokat Kari Nordmann". */
const COUNSEL = /(?:v\/|ved)\s*(?:advokat|adv\.?|attorney|counsel)\s+((?:\p{Lu}[\p{L}'-]*\s+){0,3}\p{Lu}[\p{L}'-]*)/giu;
/** A labelled party line: "Byggherre: Bergen Eiendom ASA", "Saksøker: …". */
const PARTY_LABEL = /^\s*(byggherre|entrepren\p{L}*|saks\p{L}*|klager|innklagede|motpart|kreditor|debitor|claimant|respondent|plaintiff|defendant|contractor|client)\s*:\s*(\S.{2,80})$/iu;
/** Courts and public bodies name themselves. */
const COURT = /(?<![\p{L}])((?:\p{Lu}[\p{L}]*\s+)?(?:tingrett|lagmannsrett|H\p{L}yesterett|forliksr\p{L}d|district court|court of appeal))(?![\p{L}])/gu;

/** Strips the organisation form and punctuation so two spellings compare. */
export function partyNameKey(displayName: string): string {
  const withoutForm = collapseWhitespace(displayName).replace(new RegExp(`\\s+(?:${ORG_FORM_ALTERNATION})$`, 'iu'), '');
  return withoutForm
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

function candidate(
  line: LocatedText,
  displayName: string,
  kind: PartyCandidate['kind'],
  basis: PartyCandidate['basis'],
  organisationNumber: string | null,
): PartyCandidate | null {
  const name = collapseWhitespace(displayName);
  if (name.length < 3 || name.length > 120) return null;
  const nameKey = partyNameKey(name);
  if (nameKey.length < 3) return null;
  return {
    displayName: name,
    nameKey,
    kind,
    basis,
    documentId: line.documentId,
    relativePath: line.relativePath,
    sha256: line.sha256,
    locator: line.locator,
    organisationNumber,
    // A name in running text is a weaker reading than an address in a header,
    // and the pack's floor for a header-derived party is 0.5. Nothing this
    // module produces may look more certain than that.
    confidence: basis === 'organisation_number' ? 0.5 : 0.4,
  };
}

/** Every party candidate one line offers. */
export function partyCandidatesIn(line: LocatedText): PartyCandidate[] {
  const out: PartyCandidate[] = [];
  const push = (value: PartyCandidate | null): void => {
    if (value !== null) out.push(value);
  };

  const numbers = [...line.text.matchAll(ORG_NUMBER)].map((match) => (match[1] ?? '').replace(/[\s.]/g, ''));
  const organisationNumber = numbers[0] ?? null;
  for (const match of line.text.matchAll(ORGANISATION)) {
    push(candidate(line, match[1] ?? '', 'organization', organisationNumber === null ? 'organisation_form' : 'organisation_number', organisationNumber));
  }
  for (const match of line.text.matchAll(COUNSEL)) {
    push(candidate(line, match[1] ?? '', 'person', 'counsel_construction', null));
  }
  for (const match of line.text.matchAll(COURT)) {
    push(candidate(line, match[1] ?? '', 'court', 'party_label', null));
  }
  const labelled = PARTY_LABEL.exec(line.text);
  if (labelled !== null) {
    const value = labelled[2] ?? '';
    // A labelled line usually also matches the organisation shape; recording it
    // twice would double a party's mention count and inflate its weight.
    const alreadySeen = out.some((existing) => value.includes(existing.displayName));
    if (!alreadySeen) push(candidate(line, value, 'unknown', 'party_label', organisationNumber));
  }
  return out;
}

/**
 * Candidates that look like the same party under different spellings.
 *
 * This is a QUESTION, not a merge. `party_identity_merge` is reserved for a
 * lawyer by the instance's approval policy, and a tool that quietly merged two
 * names would destroy the distinction a conflict check depends on.
 */
export function identityAmbiguities(candidates: readonly PartyCandidate[]): IdentityAmbiguity[] {
  const byKey = new Map<string, PartyCandidate[]>();
  for (const value of candidates) {
    const bucket = byKey.get(value.nameKey);
    if (bucket === undefined) byKey.set(value.nameKey, [value]);
    else bucket.push(value);
  }
  const rows: IdentityAmbiguity[] = [];
  for (const [nameKey, bucket] of byKey) {
    const spellings = new Map<string, PartyCandidate>();
    for (const value of [...bucket].sort((a, b) => byteCompare(a.displayName, b.displayName) || byteCompare(a.relativePath, b.relativePath))) {
      if (!spellings.has(value.displayName)) spellings.set(value.displayName, value);
    }
    const distinct = [...spellings.values()];
    for (let left = 0; left < distinct.length; left += 1) {
      for (let right = left + 1; right < distinct.length; right += 1) {
        rows.push({ nameKey, left: distinct[left] as PartyCandidate, right: distinct[right] as PartyCandidate });
      }
    }
  }
  return rows.sort((a, b) => byteCompare(a.nameKey, b.nameKey) || byteCompare(a.left.displayName, b.left.displayName));
}
