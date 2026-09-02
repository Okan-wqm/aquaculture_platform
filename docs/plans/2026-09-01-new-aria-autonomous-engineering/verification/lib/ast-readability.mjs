import { readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import ts from 'typescript';

function add(errors, path, message) {
  errors.push({ code: 'READABILITY_LIMIT', message: `${path}: ${message}` });
}

function parseModule(path, source) {
  return ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
}

function verifySyntax(errors, path, sourceFile) {
  for (const diagnostic of sourceFile.parseDiagnostics) {
    const position = sourceFile.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ');
    add(errors, path, `syntax error ${position.line + 1}:${position.character + 1} ${message}`);
  }
}

function isFunction(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

function functionLabel(node, sourceFile) {
  if ('name' in node && node.name) return node.name.getText(sourceFile);
  return `<callback@${sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1}>`;
}

function branchKind(node) {
  if (ts.isIfStatement(node)) return 'if';
  if (
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node)
  ) {
    return 'loop';
  }
  if (ts.isSwitchStatement(node)) return 'switch';
  if (ts.isCatchClause(node)) return 'catch';
  if (ts.isConditionalExpression(node)) return 'conditional';
  return null;
}

function isLogical(node) {
  return (
    ts.isBinaryExpression(node) &&
    [
      ts.SyntaxKind.AmpersandAmpersandToken,
      ts.SyntaxKind.BarBarToken,
      ts.SyntaxKind.QuestionQuestionToken,
    ].includes(node.operatorToken.kind)
  );
}

function complexity(root) {
  let cyclomatic = 1;
  let cognitive = 0;
  function visit(node, nesting) {
    if (node !== root && isFunction(node)) return;
    const kind = branchKind(node);
    if (kind) {
      cyclomatic += 1;
      cognitive += 1 + nesting;
      if (ts.isSwitchStatement(node)) {
        const cases = node.caseBlock.clauses.filter((clause) => ts.isCaseClause(clause)).length;
        cyclomatic += cases;
      }
    } else if (isLogical(node)) {
      cyclomatic += 1;
      cognitive += 1;
    }
    const nextNesting = kind ? nesting + 1 : nesting;
    ts.forEachChild(node, (child) => visit(child, nextNesting));
  }
  visit(root, 0);
  return { cyclomatic, cognitive };
}

function verifyFunction(errors, path, sourceFile, node, limits) {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line;
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line;
  const lines = end - start + 1;
  const parameters = node.parameters.length;
  const metrics = complexity(node);
  const label = functionLabel(node, sourceFile);
  if (lines > limits.function_lines) add(errors, path, `${label} function lines ${lines}`);
  if (parameters > limits.function_parameters) {
    add(errors, path, `${label} function parameters ${parameters}`);
  }
  if (metrics.cyclomatic > limits.cyclomatic_complexity) {
    add(errors, path, `${label} cyclomatic complexity ${metrics.cyclomatic}`);
  }
  if (metrics.cognitive > limits.cognitive_complexity) {
    add(errors, path, `${label} cognitive complexity ${metrics.cognitive}`);
  }
}

export function verifyAstFunctions(errors, path, source, limits) {
  const sourceFile = parseModule(path, source);
  verifySyntax(errors, path, sourceFile);
  function visit(node) {
    if (isFunction(node)) verifyFunction(errors, path, sourceFile, node, limits);
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
}

function moduleSpecifiers(sourceFile) {
  const values = [];
  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      values.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [specifier] = node.arguments;
      values.push(
        node.arguments.length === 1 && ts.isStringLiteral(specifier) ? specifier.text : null,
      );
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return values;
}

function dependencyLayers(policy) {
  const layers = policy.dependency_policy.layers;
  const layerByPath = new Map();
  for (const [layer, paths] of Object.entries(policy.dependency_policy.d0_verification_layers)) {
    for (const path of paths) layerByPath.set(path, layers.indexOf(layer));
  }
  return layerByPath;
}

function verifySpecifier(context, specifier) {
  const { errors, sourcePath, sourceLayer, layerByPath, approvedExternalSpecifiers } = context;
  if (specifier === null) {
    add(errors, sourcePath, 'dynamic import requires exactly one string literal argument');
    return;
  }
  if (!specifier.startsWith('.')) {
    if (!approvedExternalSpecifiers.has(specifier)) {
      add(errors, sourcePath, `unapproved external dependency ${specifier}`);
    }
    return;
  }
  const targetPath = normalize(join(dirname(sourcePath), specifier)).replaceAll('\\', '/');
  const targetLayer = layerByPath.get(targetPath);
  if (targetLayer === undefined || targetLayer > sourceLayer) {
    add(errors, sourcePath, `forbidden dependency ${targetPath}`);
  }
}

function verifySourceDependencies(context, sourcePath, sourceLayer) {
  const source = readFileSync(join(context.planRoot, sourcePath), 'utf8');
  const sourceFile = parseModule(sourcePath, source);
  for (const specifier of moduleSpecifiers(sourceFile)) {
    verifySpecifier(
      {
        ...context,
        sourcePath,
        sourceLayer,
      },
      specifier,
    );
  }
}

export function verifyAstDependencies(errors, planRoot, policy) {
  const layerByPath = dependencyLayers(policy);
  const approvedExternalSpecifiers = new Set(policy.dependency_policy.approved_external_specifiers);
  for (const [sourcePath, sourceLayer] of layerByPath) {
    verifySourceDependencies(
      { errors, planRoot, layerByPath, approvedExternalSpecifiers },
      sourcePath,
      sourceLayer,
    );
  }
}

export function typescriptVersion() {
  return ts.version;
}
