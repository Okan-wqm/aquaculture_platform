/**
 * INVARIANT (FE-MEDIUM-337): sample data reaches a web page only through the
 * typed preview path, and only while its backend gap is a tracked finding.
 *
 * WHY: a console view whose backend is not built yet (a budget per cost
 * centre, a unified command log, per-module alarm counts) could either render
 * nothing or render invented values that read as real. Okan's decision
 * (2026-10-16): absent backends get a LABELLED preview, through one typed
 * path, each behind a tracked finding.
 *
 * The tier-1 half lives in `web/shared-ui/src/preview/`: `definePreviewData`
 * returns an opaque handle whose value sits in a module-private WeakMap, and
 * `MockPreview` is the only reader — it always draws the notice (reason +
 * finding + "sample data") beside what the value renders. This spec is the
 * tier-3 half, four rules over every file under `web/`:
 *
 *   1. A `*.preview.ts` file declares data and nothing else: it imports
 *      `definePreviewData` from `@aquaculture/shared-ui`, and every export is
 *      `export const NAME = definePreviewData({ finding, reasonKey, needs }, value)`
 *      with literal `finding` / `needs`; the name appears nowhere else in the
 *      file, so no private call can mint a handle the source check never
 *      reads and pass it out inside an exported one. The finding exists in
 *      `docs/reviews/_registry/findings.jsonl`, is still unresolved, and its
 *      review file exists — so when the backend lands and the finding is
 *      RESOLVED, the build fails until the preview is replaced by real data.
 *      "Unresolved" is the registry's own predicate, isUnresolvedFindingState
 *      (every state but RESOLVED): a finding moves to IN-PROGRESS when the
 *      backend work starts, and the preview has to stay until that work merges.
 *   2. A `*.preview` module is imported only by a file that renders
 *      `MockPreview` (imported from `@aquaculture/shared-ui`) — a barrel or a
 *      helper cannot pass preview data on to a page that would not label it.
 *   3. No production web file imports a module whose path contains "mock"
 *      (any case). This generalises the farm-module gate
 *      (`farm-no-mock-data-growth-ssot.spec.ts`, kept with its frozen empty
 *      baseline) to the whole web tree: unlabelled sample data has no
 *      sanctioned home anywhere.
 *   4. No production file but a `*.preview.ts` file (and the preview module
 *      itself) names `definePreviewData` — not as a call, an import (aliased
 *      or not), a re-export, a property of a namespace import or a
 *      destructured binding. Matching the callee's local name let
 *      `import { definePreviewData as sample }` or `const d =
 *      definePreviewData` define preview data inline under an unregistered
 *      finding that rule 1 never reads; every binding of the function starts
 *      from its name, so the name is what the rule looks for. Preview data is
 *      then findable by file name and every instance passes rule 1.
 *      (shared-ui's entry re-exports the preview module with `export *`,
 *      which does not name it.)
 *
 * "Production" excludes test support: `__tests__/`, `__mocks__/`, `test/`,
 * `tests/`, `test-utils/`, `e2e/`, `*.spec.*`, `*.test.*`, `*.stories.*`,
 * `test-setup.*`, `*.config.*` and declaration files. Rule 2 holds for test
 * files too. Each rule's detector is exercised on synthetic sources below, so
 * a broken detector cannot pass the live scan vacuously.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, posix, relative, resolve, sep } from 'node:path';

import * as ts from 'typescript';

import { isUnresolvedFindingState } from '../../tools/gates/finding-registry-chain';
import { projectRegistry } from '../../tools/gates/finding-registry-projection';

const REPO_ROOT = resolve(__dirname, '..', '..');
const WEB_ROOT = resolve(REPO_ROOT, 'web');

/** The preview module: defines `definePreviewData` and `MockPreview`. */
const PREVIEW_MODULE_DIR = 'web/shared-ui/src/preview/';
const SHARED_UI_PACKAGE = '@aquaculture/shared-ui';

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', 'dev-dist', '.vite']);
const TEST_SUPPORT_DIRS = new Set(['__tests__', '__mocks__', 'test', 'tests', 'test-utils', 'e2e']);
const SOURCE_FILE = /\.(?:tsx?|jsx?|mjs|cjs)$/;
const TEST_SUPPORT_FILE =
  /(?:\.(?:spec|test|stories)\.[cm]?[jt]sx?|\.d\.ts|\.config\.[cm]?[jt]s|(?:^|\/)test-setup\.[jt]sx?)$/;
const PREVIEW_FILE = /\.preview\.tsx?$/;
const PREVIEW_SPECIFIER = /\.preview(?:\.tsx?)?$/;
const MOCK_WORD = /mock/i;
const DEFINE_PREVIEW_DATA = 'definePreviewData';

/**
 * Rule 3 exemptions, keyed `importer::specifier`, each with its reason. Every
 * entry must still match a live import (checked below), so a migrated file
 * cannot leave a stale permission behind.
 */
const MOCK_PATH_EXEMPTIONS: ReadonlyMap<string, string> = new Map([
  [
    'web/modules/sensor-module/src/pages/water-chemistry/WaterChemistryMonitoringPage.tsx::./retiredMockStorage',
    'deletes the localStorage keys the retired browser-local mock wrote before PR-5; it reads and renders nothing',
  ],
]);

interface RegistryRow {
  readonly state: string;
  readonly reviewFile: string | null;
}
type Registry = ReadonlyMap<string, RegistryRow>;

function toPosix(path: string): string {
  return path.split(sep).join('/');
}

/**
 * The registry as every reader sees it: the projection, where a merged
 * `Closes:` trailer makes a finding RESOLVED the moment it merges. The stored
 * `state` is not refreshed by any workflow (MF-1, PROC-HIGH-039), so a gate
 * that read it would keep a preview alive past its finding's closure.
 */
function readRegistry(): Registry {
  return new Map(
    projectRegistry(REPO_ROOT).map((row) => [
      row.id,
      { state: row.state, reviewFile: row.review_file ?? null },
    ]),
  );
}

/** Every source file under web/, as a repo-relative POSIX path. */
function webSourceFiles(dir: string = WEB_ROOT): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) out.push(...webSourceFiles(full));
    } else if (entry.isFile() && SOURCE_FILE.test(entry.name)) {
      out.push(toPosix(relative(REPO_ROOT, full)));
    }
  }
  return out;
}

function isTestSupport(rel: string): boolean {
  return TEST_SUPPORT_FILE.test(rel) || rel.split('/').some((part) => TEST_SUPPORT_DIRS.has(part));
}

function parse(rel: string, source: string): ts.SourceFile {
  const kind = rel.endsWith('.tsx')
    ? ts.ScriptKind.TSX
    : rel.endsWith('.jsx')
      ? ts.ScriptKind.JSX
      : /\.[cm]?js$/.test(rel)
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
  return ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true, kind);
}

/** `import()`, `require()` and `import.meta.glob()` — the calls that load a module by path. */
function isModuleLoad(callee: ts.Expression): boolean {
  return (
    callee.kind === ts.SyntaxKind.ImportKeyword ||
    (ts.isIdentifier(callee) && callee.text === 'require') ||
    (ts.isPropertyAccessExpression(callee) &&
      callee.name.text === 'glob' &&
      ts.isMetaProperty(callee.expression))
  );
}

/** Every module path the file loads: static and dynamic imports, re-exports, require, glob. */
function moduleSpecifiers(sf: ts.SourceFile): string[] {
  const out: string[] = [];
  const collect = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node)) out.push(node.text);
    else if (ts.isArrayLiteralExpression(node)) node.elements.forEach(collect);
  };
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined
    ) {
      collect(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      collect(node.moduleReference.expression);
    } else if (ts.isCallExpression(node) && isModuleLoad(node.expression)) {
      node.arguments.forEach(collect);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** True when `specifier`, imported by `rel`, is shared-ui's package entry or its preview module. */
function isPreviewModuleSource(rel: string, specifier: string): boolean {
  if (specifier === SHARED_UI_PACKAGE) return true;
  let target: string | null = null;
  if (specifier.startsWith('.'))
    target = posix.normalize(posix.join(posix.dirname(rel), specifier));
  else if (specifier.startsWith('@/') && rel.startsWith('web/shared-ui/'))
    target = `web/shared-ui/src/${specifier.slice(2)}`;
  if (target === null) return false;
  return (
    target === 'web/shared-ui/src' ||
    target === 'web/shared-ui/src/index' ||
    `${target}/`.startsWith(PREVIEW_MODULE_DIR)
  );
}

/** Local names bound to `name` imported (unrenamed) from the preview module. */
function importsFromPreviewModule(rel: string, sf: ts.SourceFile, name: string): boolean {
  return sf.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      isPreviewModuleSource(rel, statement.moduleSpecifier.text) &&
      statement.importClause?.namedBindings !== undefined &&
      ts.isNamedImports(statement.importClause.namedBindings) &&
      statement.importClause.namedBindings.elements.some(
        (element) => element.propertyName === undefined && element.name.text === name,
      ),
  );
}

function isCallTo(node: ts.Node, name: string): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  return (
    (ts.isIdentifier(callee) && callee.text === name) ||
    (ts.isPropertyAccessExpression(callee) && callee.name.text === name)
  );
}

function someNode(sf: ts.SourceFile, predicate: (node: ts.Node) => boolean): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (predicate(node)) found = true;
    else ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

function findNodes(sf: ts.SourceFile, predicate: (node: ts.Node) => boolean): ts.Node[] {
  const out: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    if (predicate(node)) out.push(node);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/**
 * An identifier or string spelling `definePreviewData` in code (comments are
 * not nodes): a call, an import or export specifier on either side of `as`,
 * a property access, a destructured key, or `ns['definePreviewData']`.
 */
function namesDefinePreviewData(node: ts.Node): boolean {
  return (
    (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && node.text === DEFINE_PREVIEW_DATA
  );
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function hasExportModifier(statement: ts.Statement): boolean {
  return (
    ts.canHaveModifiers(statement) &&
    (ts.getModifiers(statement) ?? []).some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    )
  );
}

/** Rule 1, one `definePreviewData(...)` call: a literal source naming a live finding. */
function previewSourceViolations(
  where: string,
  call: ts.CallExpression,
  registry: Registry,
  fileExists: (rel: string) => boolean,
): string[] {
  const [source, value, ...extra] = call.arguments;
  if (source === undefined || value === undefined || extra.length > 0)
    return [`${where}: definePreviewData takes (source, value)`];
  if (!ts.isObjectLiteralExpression(source))
    return [`${where}: the source must be an object literal the gate can read`];
  const literal = new Map<string, string>();
  for (const property of source.properties) {
    if (
      !ts.isPropertyAssignment(property) ||
      !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
    )
      return [`${where}: the source must be plain \`key: 'literal'\` properties`];
    if (ts.isStringLiteralLike(property.initializer))
      literal.set(property.name.text, property.initializer.text);
  }
  const violations: string[] = [];
  const finding = literal.get('finding');
  const needs = literal.get('needs');
  if (literal.get('reasonKey') === undefined)
    violations.push(`${where}: reasonKey is not a literal message key`);
  if (needs === undefined || needs.trim() === '')
    violations.push(`${where}: needs must name the backend query or entity that would feed it`);
  if (finding === undefined) {
    violations.push(`${where}: finding is not a literal finding id`);
    return violations;
  }
  const row = registry.get(finding);
  if (row === undefined) violations.push(`${where}: ${finding} is not in the finding registry`);
  else {
    if (!isUnresolvedFindingState(row.state))
      violations.push(
        `${where}: ${finding} is ${row.state} — its backend landed; render the real data and delete the preview`,
      );
    if (row.reviewFile === null || !fileExists(row.reviewFile))
      violations.push(
        `${where}: ${finding}'s review file ${String(row.reviewFile)} does not exist`,
      );
  }
  return violations;
}

/** Rule 1: a `*.preview.ts` file declares preview data and nothing else. */
function previewFileViolations(
  rel: string,
  source: string,
  registry: Registry,
  fileExists: (rel: string) => boolean,
): string[] {
  const sf = parse(rel, source);
  const violations: string[] = [];
  /** The callee of each exported const's `definePreviewData(...)` — the name's one sanctioned use. */
  const exportedCallees = new Set<ts.Node>();
  let exported = 0;
  for (const statement of sf.statements) {
    if (ts.isImportDeclaration(statement)) continue;
    if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
      if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0)
        violations.push(`${rel}: exported preview data must be a const`);
      for (const declaration of statement.declarationList.declarations) {
        exported += 1;
        const name = ts.isIdentifier(declaration.name) ? declaration.name.text : '(destructured)';
        const where = `${rel} › ${name}`;
        if (!ts.isIdentifier(declaration.name))
          violations.push(`${where}: export one named const per preview`);
        else if (
          declaration.initializer === undefined ||
          !isCallTo(declaration.initializer, DEFINE_PREVIEW_DATA) ||
          !ts.isIdentifier(declaration.initializer.expression)
        )
          violations.push(`${where}: is not a definePreviewData(...) call`);
        else {
          exportedCallees.add(declaration.initializer.expression);
          violations.push(
            ...previewSourceViolations(where, declaration.initializer, registry, fileExists),
          );
        }
      }
      continue;
    }
    if (
      hasExportModifier(statement) ||
      ts.isExportDeclaration(statement) ||
      ts.isExportAssignment(statement)
    ) {
      violations.push(
        `${rel}: exports a ${ts.SyntaxKind[statement.kind]} — a preview file exports only definePreviewData(...) consts`,
      );
      continue;
    }
    // Module-private helpers that build a value are fine; side effects are not.
    if (
      ts.isVariableStatement(statement) ||
      ts.isFunctionDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement)
    )
      continue;
    violations.push(
      `${rel}: top-level ${ts.SyntaxKind[statement.kind]} — a preview file declares data and runs nothing`,
    );
  }
  if (!importsFromPreviewModule(rel, sf, DEFINE_PREVIEW_DATA))
    violations.push(`${rel}: does not import definePreviewData from ${SHARED_UI_PACKAGE}`);
  const stray = findNodes(
    sf,
    (node) =>
      namesDefinePreviewData(node) &&
      !exportedCallees.has(node) &&
      !(
        ts.isImportSpecifier(node.parent) &&
        node.parent.name === node &&
        node.parent.propertyName === undefined
      ),
  );
  for (const node of stray)
    violations.push(
      `${rel}:${lineOf(sf, node)}: names definePreviewData outside an exported const's initializer — a handle made there skips the finding check`,
    );
  if (exported === 0) violations.push(`${rel}: exports no preview data`);
  return violations;
}

/** Rule 2: a file that imports a `*.preview` module renders MockPreview from shared-ui. */
function previewImportViolations(rel: string, source: string): string[] {
  const sf = parse(rel, source);
  const previews = moduleSpecifiers(sf).filter((specifier) => PREVIEW_SPECIFIER.test(specifier));
  if (previews.length === 0) return [];
  const renders =
    importsFromPreviewModule(rel, sf, 'MockPreview') &&
    someNode(
      sf,
      (node) =>
        ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
          ts.isIdentifier(node.tagName) &&
          node.tagName.text === 'MockPreview') ||
        (isCallTo(node, 'createElement') &&
          node.arguments[0] !== undefined &&
          ts.isIdentifier(node.arguments[0]) &&
          node.arguments[0].text === 'MockPreview'),
    );
  return renders
    ? []
    : previews.map(
        (specifier) =>
          `${rel}: imports ${specifier} but does not render it through MockPreview from ${SHARED_UI_PACKAGE}`,
      );
}

/** Rule 3: the module paths a file loads that contain "mock" in any case. */
function mockNamedImports(rel: string, source: string): string[] {
  return moduleSpecifiers(parse(rel, source)).filter((specifier) => MOCK_WORD.test(specifier));
}

/** Rule 4: the lines on which the file names definePreviewData, in any binding form. */
function definePreviewDataUses(rel: string, source: string): number[] {
  const sf = parse(rel, source);
  return findNodes(sf, namesDefinePreviewData).map((node) => lineOf(sf, node));
}

// ── Synthetic fixtures for the detector self-tests ──────────────────────────
const FIXTURE_REGISTRY: Registry = new Map([
  ['FARM-MEDIUM-439', { state: 'OPEN', reviewFile: 'docs/reviews/x.md' }],
  ['SENSOR-MEDIUM-185', { state: 'IN-PROGRESS', reviewFile: 'docs/reviews/x.md' }],
  ['FE-LOW-001', { state: 'RESOLVED', reviewFile: 'docs/reviews/x.md' }],
  ['FE-LOW-002', { state: 'OPEN', reviewFile: 'docs/reviews/missing.md' }],
]);
const fixtureExists = (rel: string): boolean => rel === 'docs/reviews/x.md';
const FIXTURE_PREVIEW_PATH = 'web/modules/farm-module/src/pages/finance/budget.preview.ts';
const GOOD_PREVIEW = `import { definePreviewData } from '@aquaculture/shared-ui';

const ROWS = [{ centre: 'Hatchery', planned: 120000 }];

export const BUDGET_PREVIEW = definePreviewData(
  { finding: 'FARM-MEDIUM-439', reasonKey: 'finance.budget.previewReason', needs: 'budget entity' },
  ROWS,
);
`;

describe('INVARIANT (FE-MEDIUM-337): web preview data goes through the typed path', () => {
  const registry = readRegistry();
  const files = webSourceFiles();
  const sources = new Map(files.map((rel) => [rel, readFileSync(resolve(REPO_ROOT, rel), 'utf8')]));
  const source = (rel: string): string => sources.get(rel) ?? '';
  const production = files.filter((rel) => !isTestSupport(rel));
  const repoFileExists = (rel: string): boolean => existsSync(resolve(REPO_ROOT, rel));

  it('scans the web tree and the registry (a path typo would pass everything vacuously)', () => {
    expect(files.length).toBeGreaterThan(1500);
    expect(production.length).toBeGreaterThan(1000);
    expect(production).toContain('web/shared-ui/src/preview/previewData.ts');
    expect(production).not.toContain('web/modules/farm-module/src/test-utils/sharedUiMock.ts');
    expect(registry.get('FE-MEDIUM-337')?.reviewFile).toBe(
      'docs/reviews/claude/2026-10-16-tenant-console-d6.md',
    );
  });

  describe('rule 1 — a *.preview.ts file exports only definePreviewData results naming a live finding', () => {
    it('holds for every preview file under web/', () => {
      const violations = files
        .filter((rel) => PREVIEW_FILE.test(rel))
        .flatMap((rel) => previewFileViolations(rel, source(rel), registry, repoFileExists));
      expect(violations).toEqual([]);
    });

    it('accepts a well-formed preview file (IN-PROGRESS keeps it too)', () => {
      expect(
        previewFileViolations(FIXTURE_PREVIEW_PATH, GOOD_PREVIEW, FIXTURE_REGISTRY, fixtureExists),
      ).toEqual([]);
      const inProgress = GOOD_PREVIEW.replace('FARM-MEDIUM-439', 'SENSOR-MEDIUM-185');
      expect(
        previewFileViolations(FIXTURE_PREVIEW_PATH, inProgress, FIXTURE_REGISTRY, fixtureExists),
      ).toEqual([]);
    });

    it('bites: raw export, unknown / resolved / review-less finding, empty needs, wrong import, side effect', () => {
      const bites = (text: string): string[] =>
        previewFileViolations(FIXTURE_PREVIEW_PATH, text, FIXTURE_REGISTRY, fixtureExists);
      expect(bites(`${GOOD_PREVIEW}export const RAW = [1, 2, 3];\n`)).toEqual([
        expect.stringContaining('RAW: is not a definePreviewData(...) call'),
      ]);
      expect(bites(`${GOOD_PREVIEW}export function rows() { return []; }\n`)).toEqual([
        expect.stringContaining('exports a FunctionDeclaration'),
      ]);
      expect(bites(`${GOOD_PREVIEW}export { ROWS };\n`)).toEqual([
        expect.stringContaining('exports a ExportDeclaration'),
      ]);
      expect(bites(GOOD_PREVIEW.replace('FARM-MEDIUM-439', 'FARM-MEDIUM-999'))).toEqual([
        expect.stringContaining('FARM-MEDIUM-999 is not in the finding registry'),
      ]);
      expect(bites(GOOD_PREVIEW.replace('FARM-MEDIUM-439', 'FE-LOW-001'))).toEqual([
        expect.stringContaining('FE-LOW-001 is RESOLVED'),
      ]);
      expect(bites(GOOD_PREVIEW.replace('FARM-MEDIUM-439', 'FE-LOW-002'))).toEqual([
        expect.stringContaining('review file docs/reviews/missing.md does not exist'),
      ]);
      expect(bites(GOOD_PREVIEW.replace("needs: 'budget entity'", "needs: ' '"))).toEqual([
        expect.stringContaining('needs must name the backend'),
      ]);
      expect(
        bites(GOOD_PREVIEW.replace("'@aquaculture/shared-ui'", "'./localDefinePreviewData'")),
      ).toEqual([expect.stringContaining('does not import definePreviewData from')]);
      expect(bites(`${GOOD_PREVIEW}window.alert('x');\n`)).toEqual([
        expect.stringContaining('top-level ExpressionStatement'),
      ]);
    });

    it('bites: a private call that would hand an unchecked handle out inside an exported one', () => {
      const bites = (text: string): string[] =>
        previewFileViolations(FIXTURE_PREVIEW_PATH, text, FIXTURE_REGISTRY, fixtureExists);
      const hidden = GOOD_PREVIEW.replace(
        'const ROWS = [',
        `const mint = definePreviewData;
const HIDDEN = mint({ finding: 'FARM-MEDIUM-999', reasonKey: 'x', needs: 'y' }, 1);
const NESTED = definePreviewData({ finding: 'FARM-MEDIUM-998', reasonKey: 'x', needs: 'y' }, HIDDEN);
const ROWS = [`,
      );
      expect(bites(hidden)).toEqual([
        expect.stringContaining(`${FIXTURE_PREVIEW_PATH}:3: names definePreviewData outside`),
        expect.stringContaining(`${FIXTURE_PREVIEW_PATH}:5: names definePreviewData outside`),
      ]);
      const aliased = GOOD_PREVIEW.replace(
        'import { definePreviewData }',
        'import { definePreviewData as sample }',
      ).replace('= definePreviewData(', '= sample(');
      expect(bites(aliased)).toEqual([
        expect.stringContaining('BUDGET_PREVIEW: is not a definePreviewData(...) call'),
        expect.stringContaining('does not import definePreviewData from'),
        expect.stringContaining(`${FIXTURE_PREVIEW_PATH}:1: names definePreviewData outside`),
      ]);
    });
  });

  describe('rule 2 — only a file that renders MockPreview imports a *.preview module', () => {
    it('holds for every file under web/ (tests included)', () => {
      const violations = files
        .filter((rel) => source(rel).includes('.preview'))
        .flatMap((rel) => previewImportViolations(rel, source(rel)));
      expect(violations).toEqual([]);
    });

    it('bites: a page, a barrel or a lazy import that does not render MockPreview', () => {
      const page = 'web/modules/farm-module/src/pages/finance/BudgetTab.tsx';
      const renders = `import { MockPreview } from '@aquaculture/shared-ui';
import { BUDGET_PREVIEW } from './budget.preview';
export function BudgetTab() {
  return <MockPreview data={BUDGET_PREVIEW} variant="block">{(rows) => rows.length}</MockPreview>;
}
`;
      expect(previewImportViolations(page, renders)).toEqual([]);
      expect(
        previewImportViolations(
          page,
          renders.replace(/<MockPreview[\s\S]*<\/MockPreview>/, '<p>{String(BUDGET_PREVIEW)}</p>'),
        ),
      ).toEqual([expect.stringContaining('imports ./budget.preview but does not render it')]);
      expect(
        previewImportViolations(
          page,
          renders.replace("from '@aquaculture/shared-ui'", "from './LocalMockPreview'"),
        ),
      ).toHaveLength(1);
      expect(
        previewImportViolations(
          'web/modules/farm-module/src/pages/finance/index.ts',
          "export { BUDGET_PREVIEW } from './budget.preview';\n",
        ),
      ).toHaveLength(1);
      expect(
        previewImportViolations(page, "export const load = () => import('./budget.preview');\n"),
      ).toHaveLength(1);
    });
  });

  describe('rule 3 — no production web file imports a module whose path contains "mock"', () => {
    const offenders = production
      .filter((rel) => MOCK_WORD.test(source(rel)))
      .flatMap((rel) =>
        mockNamedImports(rel, source(rel)).map((specifier) => `${rel}::${specifier}`),
      );

    it('holds outside the reasoned exemptions', () => {
      expect(offenders.filter((key) => !MOCK_PATH_EXEMPTIONS.has(key))).toEqual([]);
    });

    it('keeps every exemption live (a migrated import must drop its entry)', () => {
      expect([...MOCK_PATH_EXEMPTIONS.keys()].filter((key) => !offenders.includes(key))).toEqual(
        [],
      );
      for (const reason of MOCK_PATH_EXEMPTIONS.values()) expect(reason.length).toBeGreaterThan(30);
    });

    it('bites on every way a module is loaded, in any case', () => {
      const rel = 'web/modules/hr-module/src/pages/PayrollPage.tsx';
      for (const text of [
        "import { rows } from './mock/payroll';",
        "import rows from '../data/payrollMock';",
        "export { rows } from './MOCK_ROWS';",
        "export * from './mocks';",
        "const rows = await import('./mockData');",
        "const rows = require('./mock-rows');",
        "const pages = import.meta.glob('./mocks/*.ts');",
        "import rows = require('./mockRows');",
      ])
        expect(mockNamedImports(rel, text)).toHaveLength(1);
      expect(
        mockNamedImports(rel, "import { MockPreview } from '@aquaculture/shared-ui';"),
      ).toEqual([]);
      expect(mockNamedImports(rel, "// import rows from './mock/payroll';")).toEqual([]);
      expect(isTestSupport('web/modules/farm-module/src/test-utils/mockGraphqlClient.ts')).toBe(
        true,
      );
      expect(isTestSupport('web/modules/hr-module/src/pages/__tests__/PayrollPage.spec.tsx')).toBe(
        true,
      );
      expect(isTestSupport(rel)).toBe(false);
    });
  });

  describe('rule 4 — only *.preview.ts files name definePreviewData', () => {
    it('holds for every production file under web/', () => {
      const violations = production
        .filter(
          (rel) =>
            !PREVIEW_FILE.test(rel) &&
            !rel.startsWith(PREVIEW_MODULE_DIR) &&
            source(rel).includes(DEFINE_PREVIEW_DATA),
        )
        .flatMap((rel) => definePreviewDataUses(rel, source(rel)).map((line) => `${rel}:${line}`));
      expect(violations).toEqual([]);
    });

    it('bites on every binding form, aliased or not', () => {
      const page = 'web/modules/farm-module/src/pages/finance/BudgetTab.tsx';
      const call = "({ finding: 'X-LOW-1', reasonKey: 'x', needs: 'y' }, rows)";
      for (const text of [
        `const BUDGET = definePreviewData${call};`,
        `import { definePreviewData as sample } from '@aquaculture/shared-ui';\nconst B = sample${call};`,
        `import { definePreviewData } from '@aquaculture/shared-ui';\nconst d = definePreviewData;\nconst B = d${call};`,
        `import * as ui from '@aquaculture/shared-ui';\nconst B = ui.definePreviewData${call};`,
        `import * as ui from '@aquaculture/shared-ui';\nconst { definePreviewData: d } = ui;\nconst B = d${call};`,
        `import * as ui from '@aquaculture/shared-ui';\nconst B = ui['definePreviewData']${call};`,
        `const { definePreviewData: d } = await import('@aquaculture/shared-ui');\nconst B = d${call};`,
        "export { definePreviewData as sample } from '@aquaculture/shared-ui';",
      ])
        expect(definePreviewDataUses(page, text).length).toBeGreaterThan(0);
    });

    it('passes a file that does not name it: the package entry, a comment, MockPreview', () => {
      expect(
        definePreviewDataUses('web/shared-ui/src/index.ts', "export * from './preview';"),
      ).toEqual([]);
      expect(
        definePreviewDataUses(
          'web/shared-ui/src/components/Layout/console/TitleBlock.tsx',
          "// the shell passes definePreviewData's handle through MockPreview\nimport { MockPreview } from '@aquaculture/shared-ui';",
        ),
      ).toEqual([]);
    });
  });
});
