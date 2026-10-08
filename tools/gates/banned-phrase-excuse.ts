/**
 * Tree-mode excuse classifier — ARIA-MEDIUM-380.
 *
 * WHY. The diff-time gate (`--mode=staged` / `--mode=range`) stays strict: a
 * new line carrying a banned word is cheap to reword before it lands. The
 * whole-tree scan (`--mode=tree`, run every cycle by the ARIA
 * banned-phrase adapter) reads what is already on main, and there the word
 * rules alone reported 49 hits of which 14 were gating excuses (2026-10-07,
 * main 88878799e). The rest were the word in another sense.
 *
 * WHAT. A banned word in prose — a document, or a comment in code — is a hit
 * UNLESS it matches one narrowly defined, tested sense that is not an excuse:
 *
 *   - a document that describes something else (DESCRIPTIVE_PATHS);
 *   - in code outside a comment: an enum member, an identifier or a string
 *     literal (`GoalStatus.DEFERRED`, `'deferred'`); in prose a backtick
 *     code span is the same identifier context;
 *   - `temporary` / `interim` naming a technical object (a temporary
 *     directory, table, credential, variable, mitigation);
 *   - `deferred` in its execution sense (deferred past the request, deferred
 *     to runtime, deferred loading, `if deferred`);
 *   - a deferral that names a finding the review registry holds
 *     (`{AREA}-{SEVERITY}-{NNN}`), which is what CLAUDE.md asks for;
 *   - a spec's own "Out of Scope" heading.
 *
 * Anything else stays a hit, so an excuse shape this file does not know is
 * reported rather than dropped. `tools/gates/banned-phrase.spec.ts` pins each
 * narrowing with a fixture, and the reviewer's probe lines as true positives.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Documents that describe other things rather than state this repository's
 * own decisions: literature syntheses, audit reports quoting the code under
 * audit, archived migrations (immutable history), and reporter templates.
 */
const DESCRIPTIVE_PATHS: readonly RegExp[] = [
  /^docs\/research\//,
  /^docs\/product-audits\//,
  /^agents\/[^/]+\/reports\//,
  /\/migrations\/\.archive\//,
  /^\.github\/ISSUE_TEMPLATE\//,
];

/** Files whose non-comment text is code; everything else is prose. */
const CODE_FILE =
  /\.(c|m)?(t|j)sx?$|\.py$|\.sql$|\.sh$|\.ya?ml$|\.rs$|\.go$|(^|\/)Dockerfile[^/]*$/;
function lineCommentMarkers(relPath: string): readonly string[] {
  if (/\.sql$/.test(relPath)) return ['--'];
  if (/\.py$|\.sh$|\.ya?ml$|(^|\/)Dockerfile[^/]*$/.test(relPath)) return ['#'];
  return ['//'];
}
const BLOCK_COMMENT_LINE = /^\s*(\/\*|\*)/;

/** `temporary` / `interim` naming a technical object, not an unfinished fix. */
const TEMPORARY_TECHNICAL_AFTER =
  /^\s*(directory|directories|dir|file|files|folder|table|tables|variable|variables|credentials?|password|token|key|buffer|storage|copy|snapshot|location|path|workspace|clone|branch|mitigation|lock|session|failure|error|outage|anchor)\b/i;

/** `deferred` in its execution sense. */
const DEFERRED_TECHNICAL_AFTER =
  /^\s*(past\b|to\s+runtime\b|until\s+(after\s+)?(commit|the\s+(transaction|request|response)\s+(commits|ends|completes)|first\s+use)\b|(loading|execution|evaluation|rendering|import|initiali[sz]ation|constraint|constraints|promise|value)\b)/i;
const DEFERRED_CONDITION_BEFORE = /\b(if|when|unless|once)\s+$/i;

/** The registry's finding id format: `{AREA}-{SEVERITY}-{NNN}`. */
const FINDING_ID = /\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-(?:CRITICAL|HIGH|MEDIUM|LOW|NIT)-\d{2,}\b/g;
const FINDING_REGISTRY = 'docs/reviews/_registry/findings.jsonl';

const MARKDOWN_HEADING = /^\s*#{1,6}\s/;

let registeredIdsCache: { root: string; ids: ReadonlySet<string> } | null = null;

/** Every finding id the review registry holds (read once per repo root). */
export function registeredFindingIds(repoRoot: string): ReadonlySet<string> {
  if (registeredIdsCache?.root === repoRoot) return registeredIdsCache.ids;
  const ids = new Set<string>();
  try {
    for (const line of readFileSync(resolve(repoRoot, FINDING_REGISTRY), 'utf8').split('\n')) {
      const match = /"id":"([^"]+)"/.exec(line);
      if (match?.[1]) ids.add(match[1]);
    }
  } catch {
    // No registry in this checkout: no deferral can cite a registered finding.
  }
  registeredIdsCache = { root: repoRoot, ids };
  return ids;
}

export function isDescriptivePath(relPath: string): boolean {
  return DESCRIPTIVE_PATHS.some((re) => re.test(relPath));
}

/** Index where the line's comment starts, or -1 (the marker must not sit inside quotes). */
function commentStart(line: string, markers: readonly string[]): number {
  if (BLOCK_COMMENT_LINE.test(line)) return 0;
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i] ?? '';
    if (quote) {
      if (ch === quote && line[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (markers.some((marker) => line.startsWith(marker, i))) return i;
  }
  return -1;
}

function insideBacktickSpan(line: string, index: number): boolean {
  const before = line.slice(0, index).split('`').length - 1;
  return before % 2 === 1;
}

function firstWord(line: string, index: number): string {
  return /^[A-Za-z]+/.exec(line.slice(index))?.[0] ?? '';
}

/** In code outside a comment: an enum member, an identifier or a string literal. */
function isCodeValue(line: string, index: number, word: string): boolean {
  if (word.length > 1 && word === word.toUpperCase()) return true;
  const before = line[index - 1] ?? ' ';
  const after = line[index + word.length] ?? ' ';
  return /['"`\w.]/.test(before) || /['"`\w]/.test(after);
}

function citesRegisteredFinding(text: string, registered: ReadonlySet<string>): boolean {
  return [...text.matchAll(FINDING_ID)].some((match) => registered.has(match[0]));
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
  registered: ReadonlySet<string> = new Set<string>(),
): boolean {
  if (isDescriptivePath(relPath)) return false;
  const word = firstWord(line, matchIndex);
  if (CODE_FILE.test(relPath)) {
    const comment = commentStart(line, lineCommentMarkers(relPath));
    const inComment = comment !== -1 && matchIndex >= comment;
    if (!inComment && isCodeValue(line, matchIndex, word)) return false;
  } else if (insideBacktickSpan(line, matchIndex)) {
    return false;
  }
  const after = line.slice(matchIndex + word.length);
  if (label === 'temporary' || label === 'interim') {
    return !TEMPORARY_TECHNICAL_AFTER.test(after);
  }
  if (label.startsWith('deferred')) {
    if (citesRegisteredFinding(`${line}\n${nextLine}`, registered)) return false;
    if (DEFERRED_TECHNICAL_AFTER.test(after)) return false;
    return !DEFERRED_CONDITION_BEFORE.test(line.slice(0, matchIndex));
  }
  if (label.startsWith('out of scope')) {
    // A spec's own scope section names what the spec covers; it excuses nothing.
    return !MARKDOWN_HEADING.test(line);
  }
  return true;
}
