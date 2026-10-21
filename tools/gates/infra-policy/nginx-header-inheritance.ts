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
 * hit the security set). An include target missing from `includedHeaders` counts as adding none.
 */
import type { NginxDirective } from '../lib/infra/nginx-conf';

/** Contexts that form an add_header inheritance level. */
const LEVELS: ReadonlySet<string> = new Set(['http', 'server', 'location', 'if', 'limit_except']);

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
  /** Inherited headers the level loses because it sets headers of its own (case-insensitive). */
  readonly dropped: readonly string[];
}

/** Header names set by `add_header` directly in these directives (snippet files, levels). */
export function addHeaderNames(directives: readonly NginxDirective[]): string[] {
  return directives.flatMap((d) =>
    d.name === 'add_header' && d.args[0] !== undefined ? [d.args[0]] : [],
  );
}

function ownHeaders(block: readonly NginxDirective[], options: HeaderInheritanceOptions): string[] {
  const names = addHeaderNames(block);
  for (const d of block) {
    if (d.name !== 'include' || d.args[0] === undefined) continue;
    const included = options.includedHeaders.get(d.args[0]);
    if (included !== undefined) names.push(...included);
  }
  return names;
}

/** Every inheritance level in source order, whether it drops headers or not. */
export function headerLevels(
  tree: readonly NginxDirective[],
  options: HeaderInheritanceOptions,
): HeaderLevel[] {
  const levels: HeaderLevel[] = [];
  const visit = (directives: readonly NginxDirective[], inherited: readonly string[]): void => {
    for (const d of directives) {
      if (d.block === null) continue;
      if (!LEVELS.has(d.name)) continue;
      const own = ownHeaders(d.block, options);
      const ownLower = new Set(own.map((h) => h.toLowerCase()));
      // A level that sets any header (directly or through a known include) inherits none.
      const dropped = own.length > 0 ? inherited.filter((h) => !ownLower.has(h.toLowerCase())) : [];
      levels.push({
        context: d.name,
        location: d.args.join(' '),
        line: d.line,
        declared: own,
        dropped,
      });
      visit(d.block, own.length > 0 ? own : inherited);
    }
  };
  visit(tree, []);
  return levels;
}

/** The levels that drop at least one inherited header. */
export function headerInheritanceDrops(
  tree: readonly NginxDirective[],
  options: HeaderInheritanceOptions,
): HeaderLevel[] {
  return headerLevels(tree, options).filter((level) => level.dropped.length > 0);
}
