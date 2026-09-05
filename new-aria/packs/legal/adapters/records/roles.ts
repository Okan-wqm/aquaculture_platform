// Roles a document assigns to a party, and who a document says it went between.
//
// WHY: "who was byggherre, who was entreprenør, who signed as counsel" is what
// a lawyer means by reconstructing responsibilities, and MEASURED 2026-09-04
// every party in the fixture carried `roles: []`. A role is only ever read
// when the document LABELS it: "Bergen Eiendom ASA (byggherre)",
// "Entreprenør: Nordlys Entreprenør AS", "v/ advokat Kari Nordmann". An
// organisation form says what a party IS, never what it does in this case, so
// no role is inferred from it. Likewise a letter's own "Fra:" / "Til:" lines
// say who it went between, and until now only an e-mail header could.
//
// WHAT: `roleMentionsIn` (party name → role, with the locator) and
// `correspondenceLinesIn` (Fra/Til/From/To lines in a document body, with the
// party candidates named on them). Every reading carries the locator and is
// `mechanical_extraction`; nothing is merged, nothing is inferred.
import { collapseWhitespace } from '../legal-text';
import type { LocatedText } from './fact-index';
import { partyCandidatesIn } from './party-candidates';
import type { PartyCandidate } from './party-candidates';

/** The role vocabulary a document may use. Lower-cased; the recorded role is the document's own word. */
const ROLE_WORDS = [
  'byggherre',
  'entreprenør',
  'entreprenor',
  'totalentreprenør',
  'underentreprenør',
  'oppdragsgiver',
  'leverandør',
  'kjøper',
  'selger',
  'utleier',
  'leietaker',
  'saksøker',
  'saksøkte',
  'klager',
  'innklagede',
  'kreditor',
  'debitor',
  'skyldner',
  'garantist',
  'prosessfullmektig',
  'advokat',
  'takstmann',
  'sakkyndig',
  'contractor',
  'subcontractor',
  'client',
  'employer',
  'supplier',
  'buyer',
  'seller',
  'landlord',
  'tenant',
  'claimant',
  'respondent',
  'plaintiff',
  'defendant',
  'creditor',
  'debtor',
  'guarantor',
  'counsel',
  'expert',
];
const ROLE_ALTERNATION = ROLE_WORDS.join('|');
/** "Bergen Eiendom ASA (byggherre)" — a name followed by its role in parentheses. */
const PARENTHESISED = new RegExp(`\\(\\s*(${ROLE_ALTERNATION})\\s*\\)`, 'giu');
/** "Byggherre: Bergen Eiendom ASA" / "Entreprenør – Nordlys AS" — a role label before a name. */
const LABELLED = new RegExp(`^\\s*(${ROLE_ALTERNATION})\\s*[:：–-]\\s*(\\S.{2,120})$`, 'iu');
/** "Bergen Eiendom ASA v/ advokat Kari Nordmann" — counsel for the party before it. */
const COUNSEL = /(?:v\/|ved)\s*(advokat|adv\.?|attorney|counsel)\s+((?:\p{Lu}[\p{L}'-]*\s+){0,3}\p{Lu}[\p{L}'-]*)/giu;
/** "Fra: X" / "Til: Y" in a document body (a letter, a PDF, a DOCX), not an e-mail header. */
const CORRESPONDENCE = /^\s*(fra|avsender|from|sender|til|mottaker|to|recipient)\s*[:：]\s*(\S.*)$/iu;

export interface RoleMention {
  readonly documentId: string;
  readonly relativePath: string;
  readonly sha256: string;
  readonly locator: string;
  /** The party as written on the line. */
  readonly displayName: string;
  /** The party's comparison key, so the role attaches to the same identity the candidate pass produced. */
  readonly nameKey: string;
  /** The role in the document's own word, lower-cased. */
  readonly role: string;
  readonly basis: 'parenthesised' | 'labelled' | 'counsel_construction';
}

export interface CorrespondenceLine {
  readonly documentId: string;
  readonly relativePath: string;
  readonly sha256: string;
  readonly locator: string;
  readonly direction: 'from' | 'to';
  readonly parties: readonly PartyCandidate[];
}

/** Roles a line assigns, each to the party named beside the role word. */
export function roleMentionsIn(line: LocatedText): RoleMention[] {
  const out: RoleMention[] = [];
  const seen = new Set<string>();
  const base = { documentId: line.documentId, relativePath: line.relativePath, sha256: line.sha256, locator: line.locator };
  const push = (candidate: PartyCandidate | undefined, role: string, basis: RoleMention['basis']): void => {
    if (candidate === undefined) return;
    const normalisedRole = role.toLowerCase();
    const key = `${candidate.nameKey}\n${normalisedRole}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ ...base, displayName: candidate.displayName, nameKey: candidate.nameKey, role: normalisedRole, basis });
  };
  const candidates = partyCandidatesIn(line);

  // "Name (role)": the role attaches to the candidate whose name ends right
  // before the parenthesis.
  for (const match of line.text.matchAll(PARENTHESISED)) {
    const at = match.index ?? 0;
    const before = line.text.slice(0, at);
    const owner = candidates
      .filter((candidate) => candidate.basis !== 'counsel_construction' && before.trimEnd().endsWith(candidate.displayName))
      .sort((a, b) => b.displayName.length - a.displayName.length)[0];
    push(owner, match[1] ?? '', 'parenthesised');
  }

  // "Role: Name": the label names the role of every party on the value side.
  const labelled = LABELLED.exec(line.text);
  if (labelled !== null) {
    const value = labelled[2] ?? '';
    for (const candidate of partyCandidatesIn({ ...line, text: value })) {
      if (candidate.basis === 'counsel_construction') continue;
      push(candidate, labelled[1] ?? '', 'labelled');
    }
  }

  // "v/ advokat Name": counsel is the person's role.
  for (const match of line.text.matchAll(COUNSEL)) {
    const name = collapseWhitespace(match[2] ?? '');
    const counsel = candidates.find((candidate) => candidate.basis === 'counsel_construction' && candidate.displayName === name);
    push(counsel, match[1]?.toLowerCase().startsWith('adv') ? 'advokat' : (match[1] ?? 'counsel'), 'counsel_construction');
  }
  return out;
}

/** A body line saying who the document is from or to, with the parties named on it. */
export function correspondenceLineIn(line: LocatedText): CorrespondenceLine | null {
  const match = CORRESPONDENCE.exec(line.text);
  if (match === null) return null;
  const cue = (match[1] ?? '').toLowerCase();
  const direction: CorrespondenceLine['direction'] = cue === 'fra' || cue === 'avsender' || cue === 'from' || cue === 'sender' ? 'from' : 'to';
  const parties = partyCandidatesIn({ ...line, text: match[2] ?? '' }).filter((candidate) => candidate.basis !== 'counsel_construction');
  if (parties.length === 0) return null;
  return { documentId: line.documentId, relativePath: line.relativePath, sha256: line.sha256, locator: line.locator, direction, parties };
}
