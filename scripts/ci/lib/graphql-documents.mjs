/**
 * GraphQL documents of the web tree, read with the TypeScript compiler API.
 *
 * WHY: the operation gate used a backtick regex over raw text. It paired a
 * backtick inside a comment with the next literal, and it deleted every
 * `${...}`, so a selection set built from an interpolated field list parsed as
 * `items { }` and the whole document was skipped — 223 of 1039 operation
 * documents on 405f2ecac, a vacuous pass. The AST yields each literal exactly,
 * and an interpolation becomes what the grammar admits at its position.
 *
 * WHAT: `SourceIndex` lists the scanned files, parses them on demand, resolves
 * imports through the repository's tsconfig paths (`ts.resolveModuleName`), and
 * resolves an expression at a call site to the document literal it names —
 * through local constants, named imports, re-exports and `export *`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';

import { parse } from 'graphql';
import ts from 'typescript';

export const SCAN_ROOTS = ['web/modules', 'web/apps', 'web/shell', 'web/shared-ui', 'mcp'];
const PLACEHOLDER = '\u0000';
const DOCUMENT_START =
  /^\s*(?:#[^\n]*\s*)*(?:(?:query|mutation|subscription)\b\s*(?:[A-Za-z_]\w*\s*)?[({@]|fragment\s+[A-Za-z_]\w*\s+on\b)/;

/** Strip `(x)`, `x as T`, `x satisfies T`, `x!` and `<T>x` down to the expression itself. */
export function unwrap(node) {
  let current = node;
  while (
    current &&
    (ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isTypeAssertionExpression(current))
  ) {
    current = current.expression;
  }
  return current;
}

/** The string/template literal a document is written as: `...`, gql`...`, graphql(`...`). */
function documentLiteral(node) {
  const n = unwrap(node);
  if (!n) return null;
  if (ts.isTaggedTemplateExpression(n)) return n.template;
  if (
    ts.isCallExpression(n) &&
    ts.isIdentifier(n.expression) &&
    /^(gql|graphql)$/.test(n.expression.text) &&
    n.arguments.length === 1
  ) {
    return documentLiteral(n.arguments[0]);
  }
  if (
    ts.isStringLiteral(n) ||
    ts.isNoSubstitutionTemplateLiteral(n) ||
    ts.isTemplateExpression(n)
  ) {
    return n;
  }
  return null;
}

/**
 * GraphQL text of a literal. An interpolation inside a selection set becomes
 * `__typename` — a leaf every composite type has — so the document parses and
 * every other selection is validated; one between definitions is a fragment
 * supplied by another constant and becomes nothing. One inside an argument or
 * variable list has no neutral GraphQL value: `unvalidatable` names it.
 */
function graphqlText(literal) {
  const raw = ts.isTemplateExpression(literal)
    ? literal.head.text + literal.templateSpans.map((s) => PLACEHOLDER + s.literal.text).join('')
    : literal.text;
  let text = '';
  let depth = 0;
  let paren = 0;
  let unvalidatable = false;
  for (const c of raw) {
    if (c === PLACEHOLDER) {
      if (paren) unvalidatable = true;
      text += depth ? ' __typename ' : ' ';
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}') depth -= 1;
    else if (c === '(') paren += 1;
    else if (c === ')') paren -= 1;
    text += c;
  }
  return { text, unvalidatable };
}

/** A parsed document: `{ file, line, name, text, ast, error }` (`ast` null when `error`). */
function toDocument(literal, file, sourceFile) {
  const { text, unvalidatable } = graphqlText(literal);
  if (!DOCUMENT_START.test(text)) return null;
  const line = sourceFile.getLineAndCharacterOfPosition(literal.getStart(sourceFile)).line + 1;
  const name =
    (text.match(/\b(?:query|mutation|subscription)\s+([A-Za-z_]\w*)/) || [])[1] || '(anonymous)';
  if (unvalidatable) {
    return { file, line, name, text, ast: null, error: 'interpolation inside an argument list' };
  }
  try {
    return { file, line, name, text, ast: parse(text), error: null };
  } catch (error) {
    return { file, line, name, text, ast: null, error: error.message.split('\n')[0] };
  }
}

/**
 * Compiler options of a tsconfig (its `extends` chain included). Files are not
 * enumerated: only `paths`/`baseUrl`/`moduleResolution` matter here, and a
 * project's own aliases (aquamobil's `@/*`) live in its tsconfig, not the base.
 */
const CONFIG_HOST = { ...ts.sys, readDirectory: () => [] };
/** A JSON-shaped object literal as a value (codegen DocumentNode constants are one). */
function literalValue(node) {
  const n = unwrap(node);
  if (ts.isObjectLiteralExpression(n)) {
    const out = {};
    for (const prop of n.properties) {
      if (!ts.isPropertyAssignment(prop)) return undefined;
      out[prop.name.text] = literalValue(prop.initializer);
    }
    return out;
  }
  if (ts.isArrayLiteralExpression(n)) return n.elements.map(literalValue);
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  if (ts.isNumericLiteral(n)) return Number(n.text);
  if (n.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (n.kind === ts.SyntaxKind.FalseKeyword) return false;
  return undefined;
}

/**
 * A codegen `export const XDocument = {"kind":"Document",...} as unknown as
 * DocumentNode<...>` is the parsed AST already; read it as the document.
 */
function codegenDocument(object, file, sourceFile) {
  const ast = literalValue(object);
  if (!ast || ast.kind !== 'Document' || !Array.isArray(ast.definitions)) return null;
  const operation = ast.definitions.find((d) => d?.kind === 'OperationDefinition');
  const line = sourceFile.getLineAndCharacterOfPosition(object.getStart(sourceFile)).line + 1;
  return {
    file,
    line,
    name: operation?.name?.value ?? '(anonymous)',
    text: null,
    ast,
    error: null,
  };
}

function compilerOptions(configPath) {
  if (!configPath) return { moduleResolution: ts.ModuleResolutionKind.Node10 };
  const { config } = ts.readConfigFile(configPath, ts.sys.readFile);
  return ts.parseJsonConfigFileContent(config ?? {}, CONFIG_HOST, dirname(configPath)).options;
}

export class SourceIndex {
  constructor(root) {
    this.root = root;
    this.optionsByConfig = new Map();
    this.sources = new Map();
    this.exportCache = new Map();
    this.parsed = new Map();
    this.files = execFileSync(
      'git',
      ['ls-files', ...SCAN_ROOTS.flatMap((r) => [`${r}/**/*.ts`, `${r}/**/*.tsx`])],
      { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 },
    )
      .split('\n')
      .filter(Boolean)
      .filter(
        (f) =>
          !f.includes('.spec.') &&
          !f.includes('.test.') &&
          !f.includes('/generated/') &&
          !f.includes('/dist/') &&
          !f.endsWith('.d.ts'),
      );
  }

  sourceFile(file) {
    if (!this.sources.has(file)) {
      const path = join(this.root, file);
      const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
      const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
      this.sources.set(file, ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind));
    }
    return this.sources.get(file);
  }

  /** The parsed document a literal holds, once per literal node. */
  documentOf(literal, file) {
    if (!this.parsed.has(literal))
      this.parsed.set(literal, toDocument(literal, file, this.sourceFile(file)));
    return this.parsed.get(literal);
  }

  /** Every operation/fragment document literal in the scanned files. */
  documents() {
    const out = [];
    for (const file of this.files) {
      const visit = (node) => {
        if (
          ts.isStringLiteral(node) ||
          ts.isNoSubstitutionTemplateLiteral(node) ||
          ts.isTemplateExpression(node)
        ) {
          const doc = this.documentOf(node, file);
          if (doc) {
            out.push(doc);
            return;
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(this.sourceFile(file));
    }
    return out;
  }

  /** Options of the tsconfig nearest to `file` (then the root tsconfig.base.json). */
  optionsFor(file) {
    let configPath = null;
    for (let dir = dirname(join(this.root, file)); dir.startsWith(this.root); dir = dirname(dir)) {
      if (existsSync(join(dir, 'tsconfig.json'))) {
        configPath = join(dir, 'tsconfig.json');
        break;
      }
      if (dir === this.root) break;
    }
    configPath ??= existsSync(join(this.root, 'tsconfig.base.json'))
      ? join(this.root, 'tsconfig.base.json')
      : null;
    if (!this.optionsByConfig.has(configPath))
      this.optionsByConfig.set(configPath, compilerOptions(configPath));
    return this.optionsByConfig.get(configPath);
  }

  resolveImport(specifier, fromFile) {
    const resolved = ts.resolveModuleName(
      specifier,
      join(this.root, fromFile),
      this.optionsFor(fromFile),
      ts.sys,
    ).resolvedModule?.resolvedFileName;
    if (!resolved) return null;
    const rel = relative(this.root, resolved);
    return rel.startsWith('..') || isAbsolute(rel) || rel.includes('node_modules') ? null : rel;
  }

  /** The document a top-level binding `name` of `file` holds (declared, imported or re-exported). */
  topLevelDocument(file, name, seen = new Set()) {
    const key = `${file}#${name}`;
    if (this.exportCache.has(key)) return this.exportCache.get(key);
    if (seen.has(key)) return null;
    seen.add(key);
    let found = null;
    const starSources = [];
    for (const statement of this.sourceFile(file).statements) {
      if (found) break;
      if (ts.isVariableStatement(statement)) {
        const decl = statement.declarationList.declarations.find(
          (d) => ts.isIdentifier(d.name) && d.name.text === name,
        );
        if (decl?.initializer) found = this.initializerDocument(decl.initializer, file, seen);
      } else if (ts.isImportDeclaration(statement) && statement.importClause?.namedBindings) {
        const bindings = statement.importClause.namedBindings;
        const element = ts.isNamedImports(bindings)
          ? bindings.elements.find((e) => e.name.text === name)
          : null;
        const target = element && this.resolveImport(statement.moduleSpecifier.text, file);
        if (target)
          found = this.topLevelDocument(target, (element.propertyName ?? element.name).text, seen);
      } else if (ts.isExportDeclaration(statement)) {
        const target = statement.moduleSpecifier
          ? this.resolveImport(statement.moduleSpecifier.text, file)
          : file;
        if (!statement.exportClause) {
          if (target) starSources.push(target);
          continue;
        }
        if (!ts.isNamedExports(statement.exportClause)) continue;
        const element = statement.exportClause.elements.find((e) => e.name.text === name);
        if (element && target) {
          const original = (element.propertyName ?? element.name).text;
          if (target !== file || original !== name)
            found = this.topLevelDocument(target, original, seen);
        }
      }
    }
    for (const target of starSources) {
      if (found) break;
      found = this.topLevelDocument(target, name, seen);
    }
    this.exportCache.set(key, found);
    return found;
  }

  initializerDocument(initializer, file, seen) {
    const literal = documentLiteral(initializer);
    if (literal) return this.documentOf(literal, file);
    const n = unwrap(initializer);
    if (n && ts.isObjectLiteralExpression(n))
      return codegenDocument(n, file, this.sourceFile(file));
    return n && ts.isIdentifier(n) ? this.topLevelDocument(file, n.text, seen) : null;
  }

  /** The const object/initializer `name` holds in the innermost enclosing scope of `node`. */
  scopedInitializer(node, name) {
    for (let scope = node.parent; scope; scope = scope.parent) {
      if (!(ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isModuleBlock(scope))) continue;
      for (const statement of scope.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        if (!(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
        const decl = statement.declarationList.declarations.find(
          (d) => ts.isIdentifier(d.name) && d.name.text === name,
        );
        if (decl?.initializer) return decl.initializer;
      }
      if (ts.isSourceFile(scope)) return null;
    }
    return null;
  }

  /** The document `expr` (an argument or property value at `file`) names, or null. */
  documentAt(expr, file) {
    const n = unwrap(expr);
    if (!n) return null;
    const literal = documentLiteral(n);
    if (literal) return this.documentOf(literal, file);
    if (ts.isIdentifier(n)) {
      const local = this.scopedInitializer(n, n.text);
      if (local) return this.initializerDocument(local, file, new Set());
      return this.topLevelDocument(file, n.text);
    }
    if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression)) {
      const ns = this.sourceFile(file).statements.find(
        (s) =>
          ts.isImportDeclaration(s) &&
          s.importClause?.namedBindings &&
          ts.isNamespaceImport(s.importClause.namedBindings) &&
          s.importClause.namedBindings.name.text === n.expression.text,
      );
      const target = ns && this.resolveImport(ns.moduleSpecifier.text, file);
      return target ? this.topLevelDocument(target, n.name.text) : null;
    }
    return null;
  }
}
