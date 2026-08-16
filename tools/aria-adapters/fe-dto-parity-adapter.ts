#!/usr/bin/env ts-node
// D6-correctness dimension adapter v1 (Plan "ARIA Sinir Sistemi" FAZ 7).
//
// WHY: hand-copied DTO types are this repo's documented disease (the
// admin-panel carries hand-written types with no contract codegen; the SSOT
// audit named the "hand-copied catalog" anti-pattern). A frontend type named
// `XDto` that drifts from the backend class `XDto` fails silently: the form
// submits, the whitelist ValidationPipe strips the unknown field, and the
// operator's input is discarded without an error.
// WHAT (deterministic, name-level v1): collect field-name sets of exported
// backend `*Dto` classes under apps/*/src/**/dto/ and exported frontend
// `*Dto` interfaces/type-literals under web/ (generated files excluded).
// Same name + different field sets => `hand_copied_dto_field_drift` naming
// the missing/extra fields on both sides.
import { relative } from 'node:path';
import ts from 'typescript';
import {
  collectFiles,
  filterFilesBySnapshot,
  normalizeWorkspacePath,
  readWorkspaceFile,
  resolveInsideWorkspace,
  workspacePathExists,
} from './adapter-fs';

interface AdapterInput {
  readonly backendRoots?: readonly string[];
  readonly frontendRoots?: readonly string[];
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
  readonly name?: string;
  readonly details?: Record<string, unknown>;
}

interface AdapterFinding {
  readonly id: string;
  readonly rule: 'hand_copied_dto_field_drift';
  readonly severity: 'high';
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

interface DtoShape {
  readonly name: string;
  readonly path: string;
  readonly line: number;
  readonly fields: ReadonlySet<string>;
}

const DEFAULT_BACKEND_ROOTS = ['apps'];
const DEFAULT_FRONTEND_ROOTS = ['web'];
const DTO_NAME_RE = /Dto$/;

function fieldNamesOfMembers(members: readonly ts.Node[]): Set<string> {
  const fields = new Set<string>();
  for (const member of members) {
    if (
      (ts.isPropertyDeclaration(member) || ts.isPropertySignature(member)) &&
      member.name !== undefined &&
      (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))
    ) {
      fields.add(member.name.text);
    }
  }
  return fields;
}

function collectDtoShapes(files: readonly string[], workspaceRoot: string): DtoShape[] {
  const shapes: DtoShape[] = [];
  for (const file of files) {
    const rel = normalizeWorkspacePath(relative(workspaceRoot, file));
    const source = ts.createSourceFile(rel, readWorkspaceFile(file), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (
        (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) &&
        node.name !== undefined &&
        DTO_NAME_RE.test(node.name.text)
      ) {
        shapes.push({
          name: node.name.text,
          path: rel,
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          fields: fieldNamesOfMembers(node.members),
        });
      } else if (
        ts.isTypeAliasDeclaration(node) &&
        DTO_NAME_RE.test(node.name.text) &&
        ts.isTypeLiteralNode(node.type)
      ) {
        shapes.push({
          name: node.name.text,
          path: rel,
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          fields: fieldNamesOfMembers(node.type.members),
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return shapes;
}

export function analyzeFeDtoParity(input: AdapterInput, workspaceRoot = process.cwd()): AriaOutput {
  const backendFiles = filterFilesBySnapshot(
    (input.backendRoots ?? DEFAULT_BACKEND_ROOTS)
      .map((root) => resolveInsideWorkspace(workspaceRoot, root))
      .filter((root) => workspacePathExists(root))
      .flatMap((root) => collectFiles(root, { extensions: ['.ts'] }))
      .filter((path) => normalizeWorkspacePath(path).includes('/dto/')),
    workspaceRoot,
    input,
  );
  const frontendFiles = filterFilesBySnapshot(
    (input.frontendRoots ?? DEFAULT_FRONTEND_ROOTS)
      .map((root) => resolveInsideWorkspace(workspaceRoot, root))
      .filter((root) => workspacePathExists(root))
      .flatMap((root) => collectFiles(root, { extensions: ['.ts', '.tsx'] }))
      .filter((path) => {
        const rel = normalizeWorkspacePath(path);
        // Generated contract types ARE the fix for this rule; only
        // hand-written declarations are suspects.
        return !/generated|codegen|__generated__|\.d\.ts$/.test(rel) && !rel.endsWith('.test.ts');
      }),
    workspaceRoot,
    input,
  );

  const backendShapes = collectDtoShapes(backendFiles, workspaceRoot);
  const frontendShapes = collectDtoShapes(frontendFiles, workspaceRoot);
  const backendByName = new Map<string, DtoShape[]>();
  for (const shape of backendShapes) {
    const list = backendByName.get(shape.name) ?? [];
    list.push(shape);
    backendByName.set(shape.name, list);
  }

  const observations: AdapterObservation[] = [];
  const findings: AdapterFinding[] = [];
  let pairs = 0;
  for (const frontend of frontendShapes) {
    const candidates = backendByName.get(frontend.name);
    if (!candidates || candidates.length === 0 || frontend.fields.size === 0) {
      continue;
    }
    pairs += 1;
    const exact = candidates.find(
      (candidate) =>
        candidate.fields.size === frontend.fields.size &&
        [...candidate.fields].every((field) => frontend.fields.has(field)),
    );
    const closest =
      exact ??
      [...candidates].sort(
        (a, b) => overlap(b.fields, frontend.fields) - overlap(a.fields, frontend.fields),
      )[0];
    observations.push({
      id: `fe-dto-parity:pair:${frontend.path}:${frontend.name}`,
      type: 'fe_dto_parity_pair',
      path: frontend.path,
      name: frontend.name,
      details: { backendPath: closest.path, drift: exact === undefined },
    });
    if (exact !== undefined) {
      continue;
    }
    const missing = [...closest.fields].filter((field) => !frontend.fields.has(field)).sort();
    const extra = [...frontend.fields].filter((field) => !closest.fields.has(field)).sort();
    findings.push({
      id: `fe-dto-parity:drift:${frontend.path}:${frontend.name}`,
      rule: 'hand_copied_dto_field_drift',
      severity: 'high',
      path: frontend.path,
      line: frontend.line,
      message:
        `Frontend \`${frontend.name}\` drifts from backend \`${closest.path}\`: ` +
        `missing [${missing.join(', ') || '-'}], extra [${extra.join(', ') || '-'}]. ` +
        'A hand-copied DTO fails silently — the whitelist ValidationPipe strips ' +
        'unknown fields and the input is discarded without an error.',
      evidence: [
        { path: frontend.path, line: frontend.line },
        { path: closest.path, line: closest.line },
      ],
      confidence: 0.8,
    });
  }

  const readPaths = [
    ...new Set([
      ...backendFiles.map((path) => normalizeWorkspacePath(relative(workspaceRoot, path))),
      ...frontendFiles.map((path) => normalizeWorkspacePath(relative(workspaceRoot, path))),
    ]),
  ].sort();
  return {
    observations: observations.sort((a, b) => a.id.localeCompare(b.id)),
    findings: findings.sort((a, b) => a.id.localeCompare(b.id)),
    read_paths: readPaths,
    evidence_sources: readPaths,
    belief_candidates: [],
    cost_units: readPaths.length,
    metadata: {
      scanMode: 'fe_dto_parity_v1',
      backendDtoCount: backendShapes.length,
      frontendDtoCount: frontendShapes.length,
      comparedPairs: pairs,
    },
  };
}

function overlap(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let count = 0;
  for (const item of a) {
    if (b.has(item)) {
      count += 1;
    }
  }
  return count;
}

function readStdin(): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      input += chunk;
    });
    process.stdin.on('end', () => resolvePromise(input));
    process.stdin.on('error', reject);
  });
}

async function main(): Promise<void> {
  const rawInput = await readStdin();
  const input = rawInput.trim().length > 0 ? (JSON.parse(rawInput) as AdapterInput) : {};
  process.stdout.write(`${JSON.stringify(analyzeFeDtoParity(input))}\n`);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
