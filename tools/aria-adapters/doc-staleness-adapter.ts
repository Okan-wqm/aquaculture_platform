#!/usr/bin/env ts-node
// D5-documentation dimension adapter v1 (Plan "ARIA Sinir Sistemi" FAZ 7).
//
// WHY: nothing watched documentation truth — a runbook can name a script
// that was deleted a year ago and stay green forever. Stale docs are worse
// than missing docs: they answer confidently and wrongly.
// WHAT (deterministic, fs-only): every backtick-quoted repo path in
// docs/**/*.md is resolved against the working tree; a reference to a path
// that no longer exists is a `doc_references_missing_path` finding with the
// doc's file:line as evidence. Globs, placeholders, and line-suffixed refs
// are handled so the rule stays low-noise. Point-in-time records (see
// isPointInTimeRecord) are read but never flagged: they describe the repo as
// it was on their date, so a path they cite that is gone since is history,
// not staleness (ARIA-HIGH-202).
// A missing path is stale only where the doc CLAIMS it exists. A reference
// the doc marks as a file to create, proposes, states is absent or excluded,
// or lists as a change target it never evidences makes no such claim — see
// referenceRole (ARIA-HIGH-212).
import { relative } from 'node:path';

import {
  collectFiles,
  filterFilesBySnapshot,
  isArchivedWorkspacePath,
  normalizeWorkspacePath,
  readWorkspaceFile,
  requireScanRoots,
  resolveInsideWorkspace,
  workspacePathExists,
} from './adapter-fs';

interface AdapterInput {
  readonly roots?: readonly string[];
  readonly repo_snapshot?: { readonly allowed_paths?: readonly string[] };
}

interface EvidenceRef {
  readonly path: string;
  readonly line?: number;
}

interface AdapterObservation {
  readonly id: string;
  readonly type: string;
  readonly path?: string;
  readonly details?: Record<string, unknown>;
}

interface AdapterFinding {
  readonly id: string;
  readonly rule: 'doc_references_missing_path';
  readonly severity: 'medium';
  readonly path: string;
  readonly line: number;
  readonly message: string;
  readonly evidence: readonly EvidenceRef[];
  readonly confidence?: number;
}

interface AriaOutput {
  readonly observations: readonly AdapterObservation[];
  readonly findings: readonly AdapterFinding[];
  readonly read_paths: readonly string[];
  readonly evidence_sources: readonly string[];
  readonly belief_candidates: readonly unknown[];
  readonly cost_units: number;
  readonly metadata: Record<string, unknown>;
}

// A ref must start at a known top-level code directory to count as a repo
// path claim — prose like `feature/branch-name` or `owner/repo` never
// matches, which is what keeps this rule quiet.
const PATH_PREFIXES = [
  'apps/',
  'e2e/',
  'infrastructure/',
  'libs/',
  'platform/',
  'scripts/',
  'sens-api-gateway/',
  'tools/',
  'web/',
];

const BACKTICK_SPAN_RE = /`([^`\n]+)`/g;

interface CandidateRef {
  readonly ref: string;
  // `path:123` / `path:12-40` — an evidence-style ref pins a line, so the doc
  // asserts the file existed with content there.
  readonly linePinned: boolean;
}

const LINE_PIN_RE = /:[0-9][0-9-]*$/;

function candidateRef(span: string): CandidateRef | undefined {
  const trimmed = span.trim();
  const text = trimmed.replace(LINE_PIN_RE, '');
  if (!PATH_PREFIXES.some((prefix) => text.startsWith(prefix))) {
    return undefined;
  }
  // Globs and placeholders are patterns, not path claims.
  if (/[*{}<>$\s]/.test(text) || text.includes('...')) {
    return undefined;
  }
  if (!/^[A-Za-z0-9_@./-]+$/.test(text)) {
    return undefined;
  }
  return { ref: text.replace(/\/$/, ''), linePinned: text !== trimmed };
}

// ---------------------------------------------------------------------------
// Reference roles (ARIA-HIGH-212). The rule's claim is "the doc answers
// confidently about a surface that is gone"; that needs the doc to say the
// path exists. Operator feedback on the pre-role adapter (19 TP / 27 FP)
// put every false positive in one of these roles. The role is read from the
// reference's own markdown unit — its list item, table row, code line or
// paragraph — with every backtick span removed, so a marker word inside a
// neighbouring path (`{create,update}-x.handler.ts`) never counts.
// ---------------------------------------------------------------------------

export type UnclaimedRole = 'creation' | 'proposal' | 'absence' | 'change_target';

const NOT_LETTER = '(?<![\\p{L}\\p{N}_])';
const END_WORD = '(?![\\p{L}\\p{N}_])';
const word = (body: string): RegExp => new RegExp(`${NOT_LETTER}(?:${body})${END_WORD}`, 'iu');

// The file is to be created: `(new)`, `(NEW) -- …`, `(new — …)`, `— YENİ`,
// a `Create:` list verb. `(new mutations)` is not a creation marker: it adds
// to a file that exists.
const CREATION_RES: readonly RegExp[] = [
  /\(\s*(?:new|yeni|YENİ)(?:\s+file)?\s*(?:\)|—|–|--|,|-)/iu,
  /(?:—|–|--)\s*(?:new|yeni|YENİ)(?:\s+file)?(?![\p{L}\p{N}_])/iu,
  /^\s*(?:[-*+]|\d+\.)\s+(?:\*\*)?(?:create|add|oluştur)(?:\*\*)?\s*:/iu,
];
// The doc proposes the surface: it names where a future artifact would live.
const PROPOSAL_RES: readonly RegExp[] = [
  word('proposed|proposal|to be created|not yet created'),
  word('önerilen|öneri|önerisi'),
];
// The doc itself says the path is absent or out of its scope — it is right
// about the fact the rule would call its error.
const ABSENCE_RES: readonly RegExp[] = [
  word("(?:does not|doesn't|do not|did not|no longer) exists?"),
  word('not (?:yet )?(?:exist|present)'),
  word('excluding|excluded|excludes'),
];
// A list headed by what a change WILL do to files (`Files to change:`,
// `#### Files to Modify`). It mixes files the change edits with files it
// creates, so membership alone claims nothing. A bare `Files:` / `Dosyalar`
// / `Affected surface` heading is not one: reference docs and findings use
// it to describe code as it stands, and a missing path there is stale.
const CHANGE_TARGET_LABEL_RE =
  /^files?\s+to\s+(?:change|modify|fix|touch|create|add|update|edit|delete|remove)$/iu;
// …unless the item says the file is modified, which presumes it exists.
const EXISTING_TARGET_RE = word('modify|modified|güncelle|GÜNCELLE');

const LIST_ITEM_RE = /^(\s*)(?:[-*+]|\d+\.)\s/;
const HEADING_RE = /^\s*#{1,6}\s/;
const TABLE_ROW_RE = /^\s*\|/;
const FENCE_RE = /^\s*(?:```|~~~)/;

function stripSpans(text: string): string {
  return text.replace(BACKTICK_SPAN_RE, ' ');
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function isBlank(line: string): boolean {
  return line.trim().length === 0;
}

function fenceMask(lines: readonly string[]): readonly boolean[] {
  const mask: boolean[] = [];
  let inFence = false;
  for (const line of lines) {
    if (FENCE_RE.test(line)) {
      mask.push(true);
      inFence = !inFence;
      continue;
    }
    mask.push(inFence);
  }
  return mask;
}

// A line that is a markdown unit by itself: a heading, a table row, a fenced
// code line. A list item starts a unit that its continuation lines join.
function isSingleLineUnit(
  lines: readonly string[],
  fenced: readonly boolean[],
  index: number,
): boolean {
  return fenced[index] || HEADING_RE.test(lines[index]) || TABLE_ROW_RE.test(lines[index]);
}

function unitText(lines: readonly string[], fenced: readonly boolean[], index: number): string {
  if (isSingleLineUnit(lines, fenced, index)) {
    return lines[index];
  }
  const joinsUnit = (at: number): boolean =>
    at >= 0 && at < lines.length && !isBlank(lines[at]) && !isSingleLineUnit(lines, fenced, at);
  let start = index;
  while (!LIST_ITEM_RE.test(lines[start]) && joinsUnit(start - 1)) {
    start -= 1;
  }
  let end = index + 1;
  while (joinsUnit(end) && !LIST_ITEM_RE.test(lines[end])) {
    end += 1;
  }
  return lines.slice(start, end).join('\n');
}

// The label that owns the list item at `index`: the nearest line above it
// that is less indented (a parent item, a bold label, a heading).
function listOwnerLabel(lines: readonly string[], index: number): string | undefined {
  let start = index;
  while (start > 0 && !LIST_ITEM_RE.test(lines[start]) && !isBlank(lines[start - 1])) {
    start -= 1;
  }
  const item = LIST_ITEM_RE.exec(lines[start]);
  if (item === null) {
    return undefined;
  }
  const indent = item[1].length;
  for (let at = start - 1; at >= 0; at -= 1) {
    const line = lines[at];
    if (isBlank(line)) {
      continue;
    }
    const lineIndent = indentOf(line);
    if (lineIndent > indent || (LIST_ITEM_RE.test(line) && lineIndent === indent)) {
      continue;
    }
    return stripSpans(line)
      .replace(/^\s*(?:#{1,6}\s+|(?:[-*+]|\d+\.)\s+)?/, '')
      .replace(/[*_]/g, '')
      .replace(/\s*:\s*$/, '')
      .trim();
  }
  return undefined;
}

export function referenceRole(
  lines: readonly string[],
  index: number,
  evidencedRefs: ReadonlySet<string>,
  ref: string,
  fenced: readonly boolean[] = fenceMask(lines),
): UnclaimedRole | undefined {
  const text = stripSpans(unitText(lines, fenced, index));
  if (CREATION_RES.some((re) => re.test(text))) {
    return 'creation';
  }
  if (PROPOSAL_RES.some((re) => re.test(text))) {
    return 'proposal';
  }
  if (ABSENCE_RES.some((re) => re.test(text))) {
    return 'absence';
  }
  if (fenced[index] || evidencedRefs.has(ref) || EXISTING_TARGET_RE.test(text)) {
    return undefined;
  }
  const label = listOwnerLabel(lines, index);
  if (label !== undefined && CHANGE_TARGET_LABEL_RE.test(label)) {
    return 'change_target';
  }
  return undefined;
}

export interface StaleReference {
  readonly line: number;
  readonly ref: string;
}

export interface DocReferenceScan {
  readonly checked: number;
  readonly stale: readonly StaleReference[];
  readonly unclaimed: Readonly<Record<UnclaimedRole, number>>;
}

// Every repo-path reference in one document, resolved and role-read. Pure
// over (lines, pathExists) so a calibration replay can drive it on any doc.
export function scanDocReferences(
  lines: readonly string[],
  pathExists: (ref: string) => boolean,
): DocReferenceScan {
  const refs: { readonly index: number; readonly candidate: CandidateRef }[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    for (const match of lines[index].matchAll(BACKTICK_SPAN_RE)) {
      const candidate = candidateRef(match[1]);
      if (candidate !== undefined) {
        refs.push({ index, candidate });
      }
    }
  }
  const evidencedRefs = new Set(
    refs.filter(({ candidate }) => candidate.linePinned).map(({ candidate }) => candidate.ref),
  );
  const fenced = fenceMask(lines);
  const stale: StaleReference[] = [];
  const unclaimed: Record<UnclaimedRole, number> = {
    creation: 0,
    proposal: 0,
    absence: 0,
    change_target: 0,
  };
  for (const { index, candidate } of refs) {
    if (pathExists(candidate.ref)) {
      continue;
    }
    const role = referenceRole(lines, index, evidencedRefs, candidate.ref, fenced);
    if (role !== undefined) {
      unclaimed[role] += 1;
      continue;
    }
    stale.push({ line: index + 1, ref: candidate.ref });
  }
  return { checked: refs.length, stale, unclaimed };
}

// Directory segments whose documents are review/audit records — findings,
// verdicts and audits written against one revision of the code.
const RECORD_DIR_SEGMENTS = new Set(['reviews', 'audits']);
// A dated file or directory name (`2026-04-21-db-migrate-….md`,
// `docs/plans/2026-04-24-deferred-items/`, `security-audit-2026-03-30.md`)
// is the repo's spelling of "written
// on this date": plans, specs, reports and dated ADRs cite paths that did not
// exist yet or no longer exist, by design.
const DATED_SEGMENT_RE = /(?:^|[^0-9])[0-9]{4}-[0-9]{2}-[0-9]{2}(?:[^0-9]|$)/;
// The docs' own header markers for a document that is no longer live
// authority (tests/invariants/aria-doc-runtime-ssot.spec.ts PLAN_MARKERS).
const RECORD_MARKERS = ['ARIA-HISTORICAL', 'ARIA-SUPERSEDED'];
const MARKER_HEAD_LINES = 5;

export function isPointInTimeRecord(docRel: string, lines: readonly string[]): boolean {
  const segments = normalizeWorkspacePath(docRel).split('/');
  return (
    isArchivedWorkspacePath(docRel) ||
    segments.some(
      (segment) => RECORD_DIR_SEGMENTS.has(segment) || DATED_SEGMENT_RE.test(segment),
    ) ||
    lines
      .slice(0, MARKER_HEAD_LINES)
      .some((line) => RECORD_MARKERS.some((marker) => line.includes(marker)))
  );
}

export function analyzeDocStaleness(
  input: AdapterInput,
  workspaceRoot = process.cwd(),
): AriaOutput {
  const roots = requireScanRoots('doc-staleness-adapter', input.roots);
  const observations: AdapterObservation[] = [];
  const findings: AdapterFinding[] = [];
  const readPaths: string[] = [];

  const docs = filterFilesBySnapshot(
    roots
      .map((root) => resolveInsideWorkspace(workspaceRoot, root))
      .filter((root) => workspacePathExists(root))
      .flatMap((root) => collectFiles(root, { extensions: ['.md'] })),
    workspaceRoot,
    input,
  );

  let refsChecked = 0;
  let recordDocs = 0;
  const unclaimedRefs: Record<UnclaimedRole, number> = {
    creation: 0,
    proposal: 0,
    absence: 0,
    change_target: 0,
  };
  const pathExists = (ref: string): boolean =>
    workspacePathExists(resolveInsideWorkspace(workspaceRoot, ref));
  for (const doc of docs) {
    const docRel = normalizeWorkspacePath(relative(workspaceRoot, doc));
    readPaths.push(docRel);
    const lines = readWorkspaceFile(doc).split('\n');
    if (isPointInTimeRecord(docRel, lines)) {
      recordDocs += 1;
      continue;
    }
    const scan = scanDocReferences(lines, pathExists);
    refsChecked += scan.checked;
    for (const role of Object.keys(unclaimedRefs) as UnclaimedRole[]) {
      unclaimedRefs[role] += scan.unclaimed[role];
    }
    for (const { line, ref } of scan.stale) {
      findings.push({
        id: `doc-staleness:missing:${docRel}:${line}:${ref}`,
        rule: 'doc_references_missing_path',
        severity: 'medium',
        path: docRel,
        line,
        message:
          `\`${docRel}\` references \`${ref}\`, which no longer exists — ` +
          'the doc answers confidently about a surface that is gone.',
        evidence: [{ path: docRel, line }],
        confidence: 0.85,
      });
    }
    observations.push({
      id: `doc-staleness:doc:${docRel}`,
      type: 'doc_staleness_document',
      path: docRel,
      details: { missingRefs: scan.stale.length },
    });
  }

  const sortedReadPaths = [...new Set(readPaths)].sort();
  return {
    observations: observations.sort((a, b) => a.id.localeCompare(b.id)),
    findings: findings.sort((a, b) => a.id.localeCompare(b.id)),
    read_paths: sortedReadPaths,
    evidence_sources: sortedReadPaths,
    belief_candidates: [],
    cost_units: sortedReadPaths.length,
    metadata: {
      scanMode: 'doc_staleness_v2',
      docCount: docs.length,
      recordDocs,
      refsChecked,
      unclaimedRefs,
    },
  };
}

function readStdin(): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    // setEncoding('utf8') makes every chunk a string at runtime, but the
    // stream's declared chunk type stays `string | Buffer` — concatenating the
    // union is what the type checker rejects. Narrow at the boundary rather
    // than widening `input` (kernel-dead-wire-adapter is the converged shape).
    process.stdin.on('data', (chunk: string | Buffer) => {
      input += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    });
    process.stdin.on('end', () => resolvePromise(input));
    process.stdin.on('error', reject);
  });
}

async function main(): Promise<void> {
  const rawInput = await readStdin();
  const input = rawInput.trim().length > 0 ? (JSON.parse(rawInput) as AdapterInput) : {};
  process.stdout.write(`${JSON.stringify(analyzeDocStaleness(input))}\n`);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
