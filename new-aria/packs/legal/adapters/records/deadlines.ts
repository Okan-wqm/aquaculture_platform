// Deadlines and procedural steps, read out of the text a document states them in.
//
// WHY: for a case with a court calendar, a missed deadline is the single most
// costly omission a working set can have — and MEASURED 2026-09-04, the pack
// produced no DEADLINE record at all, and PROCEDURAL_STEP existed only as a
// guess about what a FILE was from its name. A response deadline in a letter
// was invisible.
//
// What this module does is mechanical: a deadline label ("Svarfrist",
// "Forfallsdato") or a deadline phrase ("innen 15.03.2024", "senest",
// "no later than") beside a date is a DEADLINE; a procedural verb beside a
// date ("klage inngitt 18.03.2024", "stevning tatt ut") is a PROCEDURAL_STEP.
// What it refuses to do is compute: "innen 14 dager etter forkynnelse" names a
// period whose end depends on rules of computation and a service date this
// layer cannot know, so it is recorded with NO date — a deadline the lawyer
// must fix, stated as such — never as a date the pack worked out.
//
// Every record is `mechanical_extraction`, is never binding, and carries the
// locator it was read at. Norwegian procedural law is not applied here (the
// instance's non-goals say so); these are the document's own words, located.
import { collapseWhitespace, datedMentionsInOrder } from '../legal-text';
import type { DatePrecision } from '../legal-text';
import type { LocatedText } from './fact-index';

export interface DeadlineMention {
  readonly documentId: string;
  readonly relativePath: string;
  readonly sha256: string;
  readonly locator: string;
  /** The deadline date at its stated precision, or null for a relative period the pack will not compute. */
  readonly value: string | null;
  readonly precision: DatePrecision;
  /** The label or phrase that made this a deadline: "Svarfrist", "innen", "senest". */
  readonly basis: string;
  /** The line as written, for the reader. */
  readonly summary: string;
}

export interface ProceduralStepMention {
  readonly documentId: string;
  readonly relativePath: string;
  readonly sha256: string;
  readonly locator: string;
  readonly value: string;
  readonly precision: DatePrecision;
  /** The step as named: "klage inngitt", "stevning tatt ut". */
  readonly step: string;
  readonly summary: string;
}

/** Labels that name a deadline when they precede a date. */
const DEADLINE_LABEL = /(?<![\p{L}])(svarfrist|klagefrist|ankefrist|betalingsfrist|leveringsfrist|frist(?:en)?|forfallsdato|forfall(?:er)?|deadline|due date|response deadline|payment due|due)(?![\p{L}])/iu;
/** Phrases that bind a date as a limit. */
const DEADLINE_PHRASE = /(?<![\p{L}])(innen|senest|seinast|ikke senere enn|by|no later than|not later than|at the latest|on or before)(?![\p{L}])/iu;
/** A period stated relative to an event the pack cannot date: "innen 14 dager etter forkynnelse". */
const RELATIVE_PERIOD = /(?<![\p{L}])(innen|senest|within|no later than)\s+(\d{1,3})\s+(dager|dag|uker|uke|måneder|måned|virkedager|days|day|weeks|week|months|month|business days|working days)(?![\p{L}])/iu;

/** Procedural steps, named by the document: a document type and what happened to it. */
const PROCEDURAL_DOCUMENT = '(?:klage|anke|stevning|tilsvar|forliksklage|begjæring|prosesskriv|påstand|søksmål|complaint|appeal|writ|summons|defence|defense|motion|petition|claim)';
const PROCEDURAL_VERB = '(?:inngitt|inngis|innsendt|sendt inn|sendt|levert|fremsatt|fremmet|tatt ut|mottatt|forkynt|registrert|avvist|filed|lodged|submitted|served|received|dismissed|registered)';
const PROCEDURAL_STEP = new RegExp(`(?<![\\p{L}])(${PROCEDURAL_DOCUMENT}\\p{L}*)\\s+(?:(?:er|ble|var|was|is|has been|have been)\\s+)?(${PROCEDURAL_VERB})(?![\\p{L}])`, 'iu');

/** Deadlines a line states. A relative period yields one record with no date. */
export function deadlineMentionsIn(line: LocatedText): DeadlineMention[] {
  const out: DeadlineMention[] = [];
  const text = line.text;
  const base = { documentId: line.documentId, relativePath: line.relativePath, sha256: line.sha256, locator: line.locator, summary: collapseWhitespace(text).slice(0, 200) };
  const relative = RELATIVE_PERIOD.exec(text);
  if (relative !== null) {
    out.push({ ...base, value: null, precision: 'unknown', basis: collapseWhitespace(relative[0]) });
    return out;
  }
  const label = DEADLINE_LABEL.exec(text);
  const phrase = DEADLINE_PHRASE.exec(text);
  if (label === null && phrase === null) return out;
  const dates = datedMentionsInOrder(text);
  if (dates.length === 0) return out;
  // The deadline is the first date AFTER the label or phrase that made this a
  // deadline; a date before it belongs to something else on the line.
  const cue = label ?? phrase;
  const cueIndex = cue?.index ?? 0;
  const target = dates.find((mention) => mention.index >= cueIndex) ?? null;
  if (target === null) return out;
  out.push({ ...base, value: target.value, precision: target.precision, basis: collapseWhitespace(cue?.[1] ?? cue?.[0] ?? '') });
  return out;
}

/** Procedural steps a line states with a date. */
export function proceduralStepsIn(line: LocatedText): ProceduralStepMention[] {
  const match = PROCEDURAL_STEP.exec(line.text);
  if (match === null) return [];
  const dates = datedMentionsInOrder(line.text);
  const target = dates[0];
  if (target === undefined) return [];
  return [
    {
      documentId: line.documentId,
      relativePath: line.relativePath,
      sha256: line.sha256,
      locator: line.locator,
      value: target.value,
      precision: target.precision,
      step: collapseWhitespace(`${match[1] ?? ''} ${match[2] ?? ''}`).toLowerCase(),
      summary: collapseWhitespace(line.text).slice(0, 200),
    },
  ];
}
