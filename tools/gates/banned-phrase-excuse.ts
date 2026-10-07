/**
 * Tree-mode excuse classifier — ARIA-MEDIUM-380.
 *
 * WHY. The diff-time gate (`--mode=staged` / `--mode=range`) stays strict: a
 * new line carrying a banned word is cheap to reword before it lands. The
 * whole-tree scan (`--mode=tree`, run every cycle by the ARIA
 * banned-phrase adapter) reads what is already on main, and there the same
 * word rules reported 49 hits of which 15 were gating excuses (2026-10-07,
 * main 88878799e). The rest were the word in another sense:
 *
 *   - a domain value: `GoalStatus.DEFERRED`, the SQL literal `'deferred'`,
 *     `{ label: 'Deferred' }`, OWASP's `PASS / FAIL / DEFERRED`;
 *   - a technical sense: a temporary directory, temporary variables, a
 *     temporary mitigation, events "deferred past the request lifecycle";
 *   - a document that describes something else: research notes on external
 *     designs, product audits quoting the code they audit, archived
 *     migrations, issue templates for reporters;
 *   - a spec's own scope section ("## Out of Scope").
 *
 * WHAT. `isGatingExcuse` keeps a tree-mode hit only when the word is used the
 * way CLAUDE.md bans it: as the reason to leave work unfinished. Each
 * narrowing below names the false-positive class it removes; anything it
 * does not recognise stays a hit, so a new excuse shape is reported rather
 * than silently dropped.
 */

/**
 * Documents that describe other things rather than state this repository's
 * own decisions: literature syntheses, audit reports that quote the code
 * under audit, immutable migration history, and reporter templates.
 */
const DESCRIPTIVE_PATHS: readonly RegExp[] = [
  /^docs\/research\//,
  /^docs\/product-audits\//,
  /^agents\/[^/]+\/reports\//,
  /\/migrations\/\.archive\//,
  /^\.github\/ISSUE_TEMPLATE\//,
  /\.sql$/,
];

/** What a temporary / interim thing has to be for the word to be an excuse. */
const EXCUSE_NOUN =
  /^\W*(?:\w+\W+){0,2}?(fix|fixes|workaround|solution|hack|patch|shim|stopgap|band-?aid|measure|approach|implementation|code|change|version|until|for now)\b/i;

/** Verbs and connectors that make `deferred` a statement about postponed work. */
const DEFERRED_PREDICATE_BEFORE =
  /\b(is|are|was|were|be|been|being|remains?|stays?|explicitly|intentionally)\s+$/i;
const DEFERRED_PREDICATE_AFTER = /^\s*(as\b|[—–:-]|\.|,|$)/;
/** A condition (`if deferred`, `when deferred`) describes behaviour, not postponed work. */
const DEFERRED_CONDITION_BEFORE = /\b(if|when|unless|once)\s+$/i;
/**
 * A tracking id on the hit's line or the next one (`INFRA-BACKUP-003`,
 * `ARIA-MEDIUM-380`) makes a deferral a tracked one — what CLAUDE.md asks for.
 */
const TRACKING_ID = /\b[A-Z]{2,}(?:-[A-Z]+)*-\d{2,}\b/;

/** `deferred` in its technical sense: deferred past / to / until a point in execution. */
const DEFERRED_TECHNICAL_AFTER =
  /^\s*(past|to\s+(runtime|the)|until\s+(the|after)|or\s+retried|execution|evaluation|loading)\b/i;

const MARKDOWN_HEADING = /^\s*#{1,6}\s/;

function matchedWord(line: string, matchIndex: number): string {
  const rest = line.slice(matchIndex);
  const word = /^[A-Za-z]+(?:\s+[A-Za-z]+)?/.exec(rest);
  return word ? word[0] : '';
}

function isDomainValue(line: string, matchIndex: number, word: string): boolean {
  // An ALL-CAPS token is an enum member or a constant, not prose.
  const first = word.split(/\s+/)[0] ?? '';
  if (first.length > 1 && first === first.toUpperCase()) return true;
  // A word glued to a quote or an identifier character is a literal or a name.
  const before = line[matchIndex - 1] ?? ' ';
  const after = line[matchIndex + first.length] ?? ' ';
  return /['"`\w.]/.test(before) || /['"`\w]/.test(after);
}

export function isDescriptivePath(relPath: string): boolean {
  return DESCRIPTIVE_PATHS.some((re) => re.test(relPath));
}

/**
 * True when the hit at `matchIndex` on `line` is a gating excuse. `label` is
 * the rule label the gate reports (`for now`, `temporary`, `deferred (…)`).
 */
export function isGatingExcuse(
  relPath: string,
  line: string,
  matchIndex: number,
  label: string,
  nextLine = '',
): boolean {
  if (isDescriptivePath(relPath)) return false;
  const word = matchedWord(line, matchIndex);
  if (isDomainValue(line, matchIndex, word)) return false;
  const after = line.slice(matchIndex + (word.split(/\s+/)[0] ?? '').length);
  if (label === 'temporary' || label === 'interim') {
    return EXCUSE_NOUN.test(after);
  }
  if (label.startsWith('deferred')) {
    if (TRACKING_ID.test(line) || TRACKING_ID.test(nextLine)) return false;
    if (MARKDOWN_HEADING.test(line)) return true;
    if (DEFERRED_TECHNICAL_AFTER.test(after)) return false;
    const before = line.slice(0, matchIndex);
    if (DEFERRED_CONDITION_BEFORE.test(before)) return false;
    return DEFERRED_PREDICATE_BEFORE.test(before) || DEFERRED_PREDICATE_AFTER.test(after);
  }
  if (label.startsWith('out of scope')) {
    // A spec's own scope section names what the spec covers; it excuses nothing.
    return !MARKDOWN_HEADING.test(line);
  }
  return true;
}
