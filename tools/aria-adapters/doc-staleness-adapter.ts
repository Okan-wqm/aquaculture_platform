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
// are handled so the rule stays low-noise.
import { relative } from 'node:path';

import {
  collectFiles,
  filterFilesBySnapshot,
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

function candidateRef(span: string): string | undefined {
  let text = span.trim();
  // `path:123` / `path:12-40` — evidence-style refs pin a line, the claim
  // is about the path.
  text = text.replace(/:[0-9][0-9-]*$/, '');
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
  return text.replace(/\/$/, '');
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
  for (const doc of docs) {
    const docRel = normalizeWorkspacePath(relative(workspaceRoot, doc));
    readPaths.push(docRel);
    const lines = readWorkspaceFile(doc).split('\n');
    let missingInDoc = 0;
    for (let index = 0; index < lines.length; index += 1) {
      for (const match of lines[index].matchAll(BACKTICK_SPAN_RE)) {
        const ref = candidateRef(match[1]);
        if (ref === undefined) {
          continue;
        }
        refsChecked += 1;
        if (workspacePathExists(resolveInsideWorkspace(workspaceRoot, ref))) {
          continue;
        }
        missingInDoc += 1;
        findings.push({
          id: `doc-staleness:missing:${docRel}:${index + 1}:${ref}`,
          rule: 'doc_references_missing_path',
          severity: 'medium',
          path: docRel,
          line: index + 1,
          message:
            `\`${docRel}\` references \`${ref}\`, which no longer exists — ` +
            'the doc answers confidently about a surface that is gone.',
          evidence: [{ path: docRel, line: index + 1 }],
          confidence: 0.85,
        });
      }
    }
    observations.push({
      id: `doc-staleness:doc:${docRel}`,
      type: 'doc_staleness_document',
      path: docRel,
      details: { missingRefs: missingInDoc },
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
    metadata: { scanMode: 'doc_staleness_v1', docCount: docs.length, refsChecked },
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
