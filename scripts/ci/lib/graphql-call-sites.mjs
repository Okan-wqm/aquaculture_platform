/**
 * GraphQL call sites of the web tree and the variables they send.
 *
 * WHY: GraphQL drops a variable the operation does not declare, so a call site
 * that sends `{ filter, pagination }` to an operation declaring `$status $page`
 * is a filter the server never applies; a required variable left out is a
 * request the server rejects. Document validation cannot see either: both
 * live in the call, not in the document.
 *
 * WHAT: every call that passes a resolvable operation document — the
 * `graphqlRequest(client, DOC, vars)` / `graphqlClient.request(DOC, vars)` /
 * `graphqlFetch(DOC, vars)` shape, `useGraphQLQuery(key, DOC, { variables })`
 * — every `{ query: DOC, variables }` object, and every call of a known GraphQL
 * transport whose document cannot be resolved. The variables are compared with
 * the operation's declarations: undeclared keys and missing required variables
 * (non-null, no default) are mismatches. A site whose document or variables
 * cannot be read literally (spread, computed key, non-literal value, a later
 * `mutate(vars)`, several operations in one document) is UNRESOLVED and counted
 * — the gate ratchets that count; it never passes such a site as clean.
 */
import ts from 'typescript';

import { unwrap } from './graphql-documents.mjs';

/** Calls that are GraphQL transports whatever their arguments resolve to. */
const TRANSPORT_CALLEES = new Set([
  'graphqlRequest',
  'graphqlFetch',
  'postGraphQL',
  'executeGraphQL',
  'useGraphQLQuery',
  'useGraphQLMutation',
]);
/** `.request()` on a GraphQL client (`graphqlClient`, `client`) — not on `restClient`. */
const REQUEST_RECEIVER = /graphql|gql|(?:^|\.)client$/i;

function calleeOf(call) {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return { name: callee.text, receiver: null };
  if (ts.isPropertyAccessExpression(callee)) {
    return { name: callee.name.text, receiver: callee.expression.getText() };
  }
  return { name: null, receiver: null };
}

/** `gql(\`...\`)` / `graphql(\`...\`)` builds a document; it does not send one. */
function isDocumentConstructor(call) {
  return ts.isIdentifier(call.expression) && /^(gql|graphql)$/.test(call.expression.text);
}

function isTransport({ name, receiver }) {
  return (
    TRANSPORT_CALLEES.has(name) || (name === 'request' && REQUEST_RECEIVER.test(receiver ?? ''))
  );
}

function propertyName(prop) {
  const name = prop.name;
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name))
    return name.text;
  return null;
}

function property(object, key) {
  return object.properties.find(
    (p) =>
      (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
      propertyName(p) === key,
  );
}

function propertyValue(prop) {
  return ts.isShorthandPropertyAssignment(prop) ? prop.name : prop.initializer;
}

/** `{ keys }` for a literal variables object, `{ unresolved: reason }` otherwise. */
function variableKeys(expr, index) {
  const n = unwrap(expr);
  if (!n || (ts.isIdentifier(n) && n.text === 'undefined')) return { keys: [] };
  if (ts.isIdentifier(n)) {
    const local = index.scopedInitializer(n, n.text);
    return local && ts.isObjectLiteralExpression(unwrap(local))
      ? variableKeys(local, index)
      : { unresolved: 'non-literal variables' };
  }
  if (!ts.isObjectLiteralExpression(n)) return { unresolved: 'non-literal variables' };
  const keys = [];
  for (const prop of n.properties) {
    if (ts.isSpreadAssignment(prop)) return { unresolved: 'spread in variables' };
    const key = propertyName(prop);
    if (key === null) return { unresolved: 'computed variable key' };
    keys.push(key);
  }
  return { keys };
}

function operationOf(doc) {
  return (doc?.ast?.definitions ?? []).filter((d) => d.kind === 'OperationDefinition');
}

function compare(site, doc, variables) {
  const [operation, ...others] = operationOf(doc);
  if (others.length)
    return { ...site, op: doc.name, unresolved: 'several operations in one document' };
  if ('unresolved' in variables) return { ...site, op: doc.name, unresolved: variables.unresolved };
  // A codegen DocumentNode omits `variableDefinitions` when there are none.
  const definitions = operation.variableDefinitions ?? [];
  const declared = definitions.map((v) => v.variable.name.value);
  const required = definitions
    .filter((v) => v.type.kind === 'NonNullType' && !v.defaultValue)
    .map((v) => v.variable.name.value);
  return {
    ...site,
    op: operation.name?.value ?? '(anonymous)',
    declared,
    undeclared: variables.keys.filter((k) => !declared.includes(k)).sort(),
    missingRequired: required.filter((k) => !variables.keys.includes(k)).sort(),
  };
}

function hasOperation(doc) {
  return Boolean(doc) && (doc.error !== null || operationOf(doc).length > 0);
}

/** Every GraphQL call site in the index, each resolved or with an `unresolved` reason. */
export function collectCallSites(index) {
  const sites = [];
  for (const file of index.files) {
    const sourceFile = index.sourceFile(file);
    const at = (node, via) => ({
      file,
      line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
      via,
    });
    const record = (node, via, doc, variablesExpr, variablesKnown = true) => {
      if (doc.error !== null) {
        sites.push({ ...at(node, via), op: doc.name, unresolved: 'document does not parse' });
      } else {
        const variables = variablesKnown
          ? variableKeys(variablesExpr, index)
          : { unresolved: variablesExpr };
        sites.push(compare(at(node, via), doc, variables));
      }
    };
    const visit = (node) => {
      if (ts.isCallExpression(node) && !isDocumentConstructor(node)) {
        const callee = calleeOf(node);
        const docIndex = node.arguments.findIndex((arg) =>
          hasOperation(index.documentAt(arg, file)),
        );
        if (docIndex >= 0) {
          const doc = index.documentAt(node.arguments[docIndex], file);
          const next = node.arguments[docIndex + 1];
          const via = `${callee.name ?? '(expression)'}()`;
          if (callee.name === 'useGraphQLMutation') {
            record(node, via, doc, 'variables passed later to mutate()', false);
          } else if (callee.name === 'useGraphQLQuery') {
            const options = next && unwrap(next);
            if (options && !ts.isObjectLiteralExpression(options)) {
              record(node, via, doc, 'non-literal options', false);
            } else {
              const prop = options && property(options, 'variables');
              record(node, via, doc, prop ? propertyValue(prop) : undefined);
            }
          } else {
            record(node, via, doc, next);
          }
        } else if (
          isTransport(callee) &&
          !node.arguments.some((arg) => {
            const n = unwrap(arg);
            return n && ts.isObjectLiteralExpression(n) && property(n, 'query');
          })
        ) {
          sites.push({
            ...at(node, `${callee.name}()`),
            op: '(unresolved)',
            unresolved: `document of ${callee.name}() not resolvable`,
          });
        }
      } else if (ts.isObjectLiteralExpression(node)) {
        const query = property(node, 'query');
        const doc = query && index.documentAt(propertyValue(query), file);
        if (hasOperation(doc)) {
          const variables = property(node, 'variables');
          record(
            node,
            '{ query, variables }',
            doc,
            variables ? propertyValue(variables) : undefined,
          );
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return sites;
}

/** Stable baseline key of a mismatched site: file, operation and the offending keys. */
export function mismatchKey(site) {
  return `${site.file}::${site.op}::undeclared=${site.undeclared.join(',')};missing=${site.missingRequired.join(',')}`;
}

export function isMismatch(site) {
  return !site.unresolved && (site.undeclared.length > 0 || site.missingRequired.length > 0);
}

export function describeMismatch(site) {
  const parts = [];
  if (site.undeclared.length) parts.push(`undeclared: ${site.undeclared.join(', ')}`);
  if (site.missingRequired.length)
    parts.push(`missing required: ${site.missingRequired.join(', ')}`);
  return `${site.file}:${site.line} ${site.op} — ${parts.join('; ')} (declares: ${site.declared.join(', ') || 'none'})`;
}
