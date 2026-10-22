/**
 * nginx `add_header` inheritance drops — the one owner (SEC-MEDIUM-052, ARIA-HIGH-012).
 *
 * WHY: nginx inherits `add_header` from the enclosing level only when the current level
 * declares none (https://nginx.org/en/docs/http/ngx_http_headers_module.html#add_header).
 * A location that sets one header of its own (Cache-Control, Content-Type, CORS) silently
 * loses every header set above it, including HSTS and the Content-Security-Policy. The
 * repository's fix is a snippet `include`d in every overriding level. The drop is computed,
 * not assumed: a level's own headers are its `add_header` lines plus the headers of each known
 * include (an include is textual), and it drops every inherited header it does not set itself.
 * An include therefore re-applies only what it actually contains; one that misses a header the
 * parent set outside the snippet (HSTS at the TLS edge) still drops it. Callers decide which
 * drops matter (mobile-csp-headers filters Cache-Control overrides; the adapter keeps drops that
 * hit the security set).
 *
 * A file that includes a known snippet anywhere adopts that snippet's headers as its response
 * policy. A serving level (location, if, limit_except) that sets headers of its own serves only
 * those, so it drops each adopted header it does not carry, whatever its parent sets: with the
 * server-level include gone, a Cache-Control location without the include still serves without
 * the CSP, and that is what main's guard caught (ARIA-HIGH-012 landing fix 1). http and server
 * levels set defaults rather than serve, so only inheritance decides what they drop.
 *
 * An include target missing from `includedHeaders` adds no known header; the level lists it in
 * `unresolvedIncludes`, so a caller can tell "sets nothing" from "sets what this owner cannot see".
 */
import type { NginxDirective } from '../lib/infra/nginx-conf';

/** Contexts that form an add_header inheritance level. */
const LEVELS: ReadonlySet<string> = new Set(['http', 'server', 'location', 'if', 'limit_except']);
/** Levels that answer requests, where the file's adopted header sets must be carried. */
const SERVING_LEVELS: ReadonlySet<string> = new Set(['location', 'if', 'limit_except']);

export interface HeaderInheritanceOptions {
  /** Headers each known include target adds (an include is textual, so its headers count). */
  readonly includedHeaders: ReadonlyMap<string, readonly string[]>;
}

/** One add_header inheritance level (http, server, location, if, limit_except). */
export interface HeaderLevel {
  readonly context: string;
  /** The level's arguments joined by a space (the location pattern; '' for server). */
  readonly location: string;
  readonly line: number;
  /** Headers the level sets itself: its add_header lines, then those of known includes. */
  readonly declared: readonly string[];
  /**
   * Headers the level's responses lose because it sets headers of its own (case-insensitive):
   * the inherited headers it does not set, then, at a serving level, the adopted headers it does
   * not carry.
   */
  readonly dropped: readonly string[];
  /** `include` targets of this level that `includedHeaders` does not know. */
  readonly unresolvedIncludes: readonly string[];
}

/** Header names set by `add_header` directly in these directives (snippet files, levels). */
export function addHeaderNames(directives: readonly NginxDirective[]): string[] {
  return directives.flatMap((d) =>
    d.name === 'add_header' && d.args[0] !== undefined ? [d.args[0]] : [],
  );
}

/** `names` with case-insensitive duplicates removed, the first spelling kept. */
function distinct(names: readonly string[]): string[] {
  const seen = new Set<string>();
  return names.filter((name) => {
    const lower = name.toLowerCase();
    if (seen.has(lower)) return false;
    seen.add(lower);
    return true;
  });
}

function ownHeaders(
  block: readonly NginxDirective[],
  options: HeaderInheritanceOptions,
): { names: string[]; unresolved: string[] } {
  const names = addHeaderNames(block);
  const unresolved: string[] = [];
  for (const d of block) {
    if (d.name !== 'include' || d.args[0] === undefined) continue;
    const included = options.includedHeaders.get(d.args[0]);
    if (included === undefined) unresolved.push(d.args[0]);
    else names.push(...included);
  }
  return { names, unresolved };
}

/** The headers of every known include the tree applies anywhere, in first-include order. */
function adoptedHeaders(
  tree: readonly NginxDirective[],
  options: HeaderInheritanceOptions,
): string[] {
  const adopted: string[] = [];
  const visit = (directives: readonly NginxDirective[]): void => {
    for (const d of directives) {
      if (d.name === 'include' && d.args[0] !== undefined) {
        const included = options.includedHeaders.get(d.args[0]);
        if (included !== undefined) adopted.push(...included);
      }
      if (d.block !== null) visit(d.block);
    }
  };
  visit(tree);
  return distinct(adopted);
}

/** Every inheritance level in source order, whether it drops headers or not. */
export function headerLevels(
  tree: readonly NginxDirective[],
  options: HeaderInheritanceOptions,
): HeaderLevel[] {
  const adopted = adoptedHeaders(tree, options);
  const levels: HeaderLevel[] = [];
  const visit = (directives: readonly NginxDirective[], inherited: readonly string[]): void => {
    for (const d of directives) {
      if (d.block === null) continue;
      if (!LEVELS.has(d.name)) continue;
      const own = ownHeaders(d.block, options);
      const ownLower = new Set(own.names.map((h) => h.toLowerCase()));
      // A level that sets any header (directly or through a known include) inherits none, and a
      // serving level that does so serves only its own: it must carry the adopted set itself.
      const expected = SERVING_LEVELS.has(d.name) ? [...inherited, ...adopted] : inherited;
      const dropped =
        own.names.length > 0
          ? distinct(expected).filter((h) => !ownLower.has(h.toLowerCase()))
          : [];
      levels.push({
        context: d.name,
        location: d.args.join(' '),
        line: d.line,
        declared: own.names,
        dropped,
        unresolvedIncludes: own.unresolved,
      });
      visit(d.block, own.names.length > 0 ? own.names : inherited);
    }
  };
  visit(tree, []);
  return levels;
}

/** The levels that drop at least one inherited or adopted header. */
export function headerInheritanceDrops(
  tree: readonly NginxDirective[],
  options: HeaderInheritanceOptions,
): HeaderLevel[] {
  return headerLevels(tree, options).filter((level) => level.dropped.length > 0);
}
