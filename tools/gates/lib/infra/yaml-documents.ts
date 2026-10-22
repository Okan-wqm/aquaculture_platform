/**
 * Multi-document YAML reader with source positions (ARIA-HIGH-012).
 *
 * WHY `yaml` and not js-yaml: evidence must cite file:line, and js-yaml returns plain values
 * without node positions. `yaml` keeps the node tree, so `lineOf` can map a value path back
 * to its line, including keys that arrive through an anchor merge (`<<: *base`), which cite
 * the anchor's line because that is where the value is written.
 *
 * Values are produced with anchors resolved and merge keys applied, i.e. the effective
 * configuration a tool like docker compose or kubectl sees.
 */
import {
  type Alias,
  type Document,
  isAlias,
  isMap,
  isPair,
  isScalar,
  isSeq,
  LineCounter,
  type Node,
  parseAllDocuments,
} from 'yaml';

import type { ReadError, ReadErrorMessage } from './read-error';

export type YamlPath = readonly (string | number)[];

export interface YamlDocument {
  /** 0-based index among the documents of the stream. */
  readonly index: number;
  /** 1-based line of the document's content. */
  readonly line: number;
  readonly value: unknown;
  /** Line of the value at `path` (the key's line for a map entry); null when absent. */
  lineOf(path: YamlPath): number | null;
}

export interface YamlRead {
  readonly docs: readonly YamlDocument[];
  readonly errors: readonly ReadError[];
}

type NodeLike = Node | null;

/**
 * The context `Alias.resolve` accepts (yaml's ToJSContext, which the package does not export by
 * name). Without one, every resolve walks the whole document to find the anchor; with one, the
 * first walk is cached on it (`aliasResolveCache`) and every later alias of the document reuses it.
 */
type AliasResolveContext = NonNullable<Parameters<Alias['resolve']>[1]>;

/**
 * One resolve context per document: resolving every alias and merge source of a document costs
 * one document walk, not one walk per alias (yaml@2.9.0 walks per call without it: a 110 KB
 * compose file with 4000 merge keys took 46 s, ARIA-HIGH-012 landing fix 5).
 */
function aliasResolveContext(doc: Document): AliasResolveContext {
  return {
    anchors: new Map(),
    doc,
    keep: false,
    mapAsMap: false,
    mapKeyWarned: false,
    // Alias.resolve refuses only at 0; the alias budget is toJS's, which keeps its own context.
    maxAliasCount: -1,
  };
}

function isMergeKey(key: unknown): boolean {
  if (!isScalar(key)) return false;
  // `yaml` represents a merge key as the string '<<' or as Symbol('<<') when merge is on;
  // this mirrors the library's own identify() for its merge tag.
  return key.value === '<<' || (typeof key.value === 'symbol' && key.value.description === '<<');
}

function keyMatches(key: unknown, segment: string | number): boolean {
  return isScalar(key) && String(key.value) === String(segment);
}

function deref(doc: Document, node: unknown, aliases: AliasResolveContext): NodeLike {
  if (isAlias(node)) {
    const target = node.resolve(doc, aliases);
    return target === undefined ? null : target;
  }
  return isMap(node) || isSeq(node) || isScalar(node) ? node : null;
}

/** Find the pair for `segment` in a map, following merge keys in YAML merge order. */
function findPair(
  doc: Document,
  aliases: AliasResolveContext,
  map: NodeLike,
  segment: string | number,
  depth: number,
): { key: Node; value: NodeLike } | null {
  if (!isMap(map) || depth > 64) return null;
  for (const item of map.items) {
    if (isPair(item) && !isMergeKey(item.key) && keyMatches(item.key, segment)) {
      return { key: item.key as Node, value: deref(doc, item.value, aliases) };
    }
  }
  for (const item of map.items) {
    if (!isPair(item) || !isMergeKey(item.key)) continue;
    const source = deref(doc, item.value, aliases);
    const sources = isSeq(source) ? source.items.map((s) => deref(doc, s, aliases)) : [source];
    for (const merged of sources) {
      const found = findPair(doc, aliases, merged, segment, depth + 1);
      if (found !== null) return found;
    }
  }
  return null;
}

/**
 * Upper bound on the nodes `toJS` may build for one document. yaml@2.9.0 counts aliases only in
 * Alias.toJS (maxAliasCount); a merge source (`<<: [*a, *a]`) is copied through mergeValue
 * without that count, so a 400-byte merge chain expands tenfold per level and still returns.
 * The real compose and k8s files expand to a few thousand nodes.
 */
const EXPANSION_BUDGET = 100_000;

/**
 * Nodes `toJS` builds for `node`: an alias or merge source counts at its target's size. Memoised
 * per node, so the count costs one pass over the document however far it would expand.
 */
function expandedSize(
  doc: Document,
  aliases: AliasResolveContext,
  node: unknown,
  memo: Map<unknown, number>,
): number {
  const target = isAlias(node) ? node.resolve(doc, aliases) : node;
  if (target === undefined || target === null) return 1;
  const known = memo.get(target);
  if (known !== undefined) return known;
  memo.set(target, 1); // an anchor that aliases itself counts once
  let size = 1;
  if (isMap(target)) {
    for (const item of target.items) {
      size +=
        expandedSize(doc, aliases, item.key, memo) + expandedSize(doc, aliases, item.value, memo);
    }
  } else if (isSeq(target)) {
    for (const item of target.items) size += expandedSize(doc, aliases, item, memo);
  }
  memo.set(target, size);
  return size;
}

function lineAt(lineCounter: LineCounter, node: Node): number | null {
  const range = node.range;
  if (range === undefined || range === null) return null;
  return lineCounter.linePos(range[0]).line;
}

function makeLineOf(
  doc: Document,
  aliases: AliasResolveContext,
  lineCounter: LineCounter,
): (path: YamlPath) => number | null {
  return (path) => {
    let node: NodeLike = deref(doc, doc.contents, aliases);
    let keyNode: Node | null = null;
    for (const segment of path) {
      keyNode = null;
      if (isSeq(node) && typeof segment === 'number') {
        node = deref(doc, node.items[segment], aliases);
      } else if (isMap(node)) {
        const pair = findPair(doc, aliases, node, segment, 0);
        if (pair === null) return null;
        keyNode = pair.key;
        node = pair.value;
      } else {
        return null;
      }
      if (node === null && keyNode === null) return null;
    }
    if (keyNode !== null) return lineAt(lineCounter, keyNode);
    return node === null ? null : lineAt(lineCounter, node);
  };
}

export function readYamlDocuments(text: string): YamlRead {
  const lineCounter = new LineCounter();
  const errors: ReadError[] = [];
  const docs: YamlDocument[] = [];
  const parsed = parseAllDocuments(text, { lineCounter, merge: true, prettyErrors: false });
  parsed.forEach((doc, index) => {
    if (doc.errors.length > 0) {
      for (const error of doc.errors) {
        // The code, never the library's message: that quotes the scalar, alias or escape it
        // failed on (read-error.ts, ARIA-HIGH-012 round-3 R2).
        errors.push({
          line: lineCounter.linePos(error.pos[0]).line,
          message: `YAML ${error.code}` as const,
        });
      }
      return;
    }
    const aliases = aliasResolveContext(doc);
    let value: unknown;
    let failure: ReadErrorMessage | null = null;
    try {
      // An alias or merge-key bomb is a read error, not a value graph that grows tenfold per
      // level for every caller that walks it. The expansion budget covers both before any value
      // is built; the library's own alias budget (maxAliasCount 100) stays on behind it. Real
      // files stay far inside both; infra-policy.spec.ts reads every tracked one.
      if (expandedSize(doc, aliases, doc.contents, new Map()) > EXPANSION_BUDGET) {
        failure = 'the document expands through aliases and merge keys past the expansion budget';
      } else {
        value = doc.toJS();
      }
    } catch {
      // What toJS throws on a document without parse errors is an alias it cannot resolve, the
      // library's alias budget, or a merge source that is not a map. Its message names the alias
      // or quotes the node, so only the fixed text is kept (read-error.ts).
      failure = 'an alias or merge key does not resolve to a value';
    }
    if (failure !== null) {
      errors.push({ line: lineCounter.linePos(doc.range[0]).line, message: failure });
      return;
    }
    const contents = doc.contents;
    const start = contents === null ? doc.range[0] : (contents.range ?? doc.range)[0];
    docs.push({
      index,
      line: lineCounter.linePos(start).line,
      value,
      lineOf: makeLineOf(doc, aliases, lineCounter),
    });
  });
  return { docs, errors };
}
