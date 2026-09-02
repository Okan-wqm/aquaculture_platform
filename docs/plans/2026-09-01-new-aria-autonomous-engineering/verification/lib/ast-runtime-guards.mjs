import ts from 'typescript';

const loaderNames = new Set([
  'Function',
  'SourceTextModule',
  'SyntheticModule',
  'compileFunction',
  'createRequire',
  'eval',
  'getBuiltinModule',
  'require',
  'runInContext',
  'runInNewContext',
  'runInThisContext',
]);

function staticText(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticText(node.left);
    const right = staticText(node.right);
    return left === null || right === null ? null : `${left}${right}`;
  }
  return null;
}

function loaderName(node) {
  if (ts.isIdentifier(node) && loaderNames.has(node.text)) return node.text;
  if (ts.isElementAccessExpression(node)) {
    const name = staticText(node.argumentExpression);
    return loaderNames.has(name) ? name : null;
  }
  return null;
}

function subtreeMatches(root, predicate) {
  let matched = false;
  function visit(node) {
    if (predicate(node)) matched = true;
    else ts.forEachChild(node, visit);
  }
  visit(root);
  return matched;
}

function isProcessExecutable(node) {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'process' &&
    node.name.text === 'execPath'
  );
}

function nodeEvalSubprocess(node) {
  if (!ts.isCallExpression(node)) return false;
  const executable = node.arguments.some((argument) =>
    subtreeMatches(argument, isProcessExecutable),
  );
  const evalFlag = node.arguments.some((argument) =>
    subtreeMatches(argument, (child) => ['-e', '--eval'].includes(staticText(child))),
  );
  return executable && evalFlag;
}

export function verifyRuntimeLoaders(errors, path, sourceFile, add) {
  const reported = new Set();
  function report(name) {
    if (reported.has(name)) return;
    reported.add(name);
    add(errors, path, `forbidden runtime code loader ${name}`);
  }
  function visit(node) {
    const name = loaderName(node);
    if (name) report(name);
    if (nodeEvalSubprocess(node)) report('process.execPath -e');
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
}
