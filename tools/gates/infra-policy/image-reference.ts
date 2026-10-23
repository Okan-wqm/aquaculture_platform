/**
 * Container image references: parsing and pin verdicts — the one owner (ARIA-HIGH-012).
 *
 * WHY one owner: ci-image-registry.spec.ts needed "which registry does this reference pull
 * from" (INFRA-HIGH-213) and the infrastructure-policy adapter needs "is this reference
 * immutable". Both are the Docker reference grammar
 * (`[registry/]path[:tag][@digest]`, https://github.com/distribution/reference), so both read
 * this parser instead of each keeping a regex.
 *
 * Compose / shell interpolation (`${TAG:?msg}`, `${TAG:-latest}`, `$TAG`, and GitHub's
 * `${{ expr }}`) is masked before splitting, so the `:` and `/` inside it never decide the
 * registry, tag or digest.
 */

export interface ImageInterpolation {
  readonly raw: string;
  readonly variable: string;
  /** required = `${V:?}`/`${V?}`, default = `${V:-w}`/`${V-w}`, plain = `${V}`/`$V`/other. */
  readonly mode: 'required' | 'default' | 'plain';
  readonly fallback: string | null;
}

export interface ImageReference {
  readonly raw: string;
  /** Explicit registry host; null means Docker Hub (the CLI's default registry). */
  readonly registry: string | null;
  /** Repository path inside the registry. */
  readonly path: string;
  /** `registry/path`, or `path` for Docker Hub: the reference without tag or digest. */
  readonly name: string;
  readonly tag: string | null;
  readonly digest: string | null;
  readonly interpolations: readonly ImageInterpolation[];
}

export type ImagePinVerdict =
  /** `@sha256:<64 hex>`: content-addressed, immutable. */
  | 'digest'
  /** `x.y.z` (or longer) version tag: still a mutable tag. */
  | 'exact_version'
  /** `latest`, a moving alias, a major-only or major.minor-only tag (`7-alpine`, `1.88-slim`). */
  | 'floating'
  /** A tag that is not a version (`pg16`, `bookworm-slim`, a git sha). */
  | 'opaque_tag'
  /** No tag and no digest: Docker pulls `latest`. */
  | 'implicit_latest'
  /** The tag/digest is `${VAR:?...}`: the deploy must supply it or fail. */
  | 'interpolated_required'
  /** The tag/digest falls back to a default when the variable is unset. */
  | 'interpolated_default'
  /** The tag/digest is a variable with no requirement and no default. */
  | 'interpolated_unchecked'
  /** Not a well-formed reference (empty path, malformed digest). */
  | 'malformed';

/**
 * Whether each verdict's image can change under an unchanged file. A Record over the union:
 * a new verdict without an entry does not compile, so it can never default to immutable.
 */
export const PIN_MUTABILITY: Readonly<Record<ImagePinVerdict, 'mutable' | 'immutable'>> = {
  digest: 'immutable',
  exact_version: 'mutable',
  floating: 'mutable',
  opaque_tag: 'mutable',
  implicit_latest: 'mutable',
  interpolated_required: 'immutable',
  interpolated_default: 'mutable',
  interpolated_unchecked: 'mutable',
  malformed: 'mutable',
};

const MOVING_ALIASES: ReadonlySet<string> = new Set([
  'latest',
  'stable',
  'edge',
  'lts',
  'mainline',
  'current',
  'nightly',
  'main',
  'master',
  'develop',
  'dev',
]);
const DIGEST = /^[a-z0-9]+(?:[.+_-][a-z0-9]+)*:[0-9a-fA-F]{32,}$/;
const VERSION = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.\d+)*(?:[-_+].*)?$/i;
const MASK = '\u0000';

function parseInterpolation(raw: string): ImageInterpolation {
  if (raw.startsWith('${{'))
    return { raw, variable: raw.slice(3, -2).trim(), mode: 'plain', fallback: null };
  const bare = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(raw);
  const bareName = bare === null ? undefined : bare[1];
  if (bareName !== undefined) return { raw, variable: bareName, mode: 'plain', fallback: null };
  const braced = /^\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?+])(.*))?\}$/s.exec(raw);
  const [, variable, op, word] = braced === null ? [] : braced;
  if (variable === undefined) return { raw, variable: raw, mode: 'plain', fallback: null };
  if (op === ':?' || op === '?') return { raw, variable, mode: 'required', fallback: null };
  if (op === ':-' || op === '-')
    return { raw, variable, mode: 'default', fallback: word === undefined ? null : word };
  return { raw, variable, mode: 'plain', fallback: null };
}

/** Replace each `${...}` / `$NAME` with a mask token; return the masked text and the pieces. */
function mask(ref: string): { masked: string; pieces: string[] } {
  const pieces: string[] = [];
  let masked = '';
  let i = 0;
  while (i < ref.length) {
    if (ref[i] === '$' && ref[i + 1] === '{') {
      let depth = 0;
      let j = i + 1;
      for (; j < ref.length; j += 1) {
        if (ref[j] === '{') depth += 1;
        else if (ref[j] === '}') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      const end = j < ref.length ? j + 1 : ref.length;
      masked += `${MASK}${pieces.length}${MASK}`;
      pieces.push(ref.slice(i, end));
      i = end;
      continue;
    }
    const bare = /^\$[A-Za-z_][A-Za-z0-9_]*/.exec(ref.slice(i));
    if (bare !== null) {
      masked += `${MASK}${pieces.length}${MASK}`;
      pieces.push(bare[0]);
      i += bare[0].length;
      continue;
    }
    masked += ref[i];
    i += 1;
  }
  return { masked, pieces };
}

function unmask(text: string, pieces: readonly string[]): string {
  return text.replace(new RegExp(`${MASK}(\\d+)${MASK}`, 'g'), (whole: string, n: string) => {
    const piece = pieces[Number(n)];
    return piece === undefined ? whole : piece;
  });
}

export function parseImageReference(ref: string): ImageReference {
  const raw = ref.trim();
  const { masked, pieces } = mask(raw);
  const at = masked.indexOf('@');
  const nameAndTag = at < 0 ? masked : masked.slice(0, at);
  const digest = at < 0 ? null : unmask(masked.slice(at + 1), pieces);
  const lastSlash = nameAndTag.lastIndexOf('/');
  const colon = nameAndTag.lastIndexOf(':');
  const hasTag = colon > lastSlash;
  const name = unmask(hasTag ? nameAndTag.slice(0, colon) : nameAndTag, pieces);
  const tag = hasTag ? unmask(nameAndTag.slice(colon + 1), pieces) : null;
  // Docker treats the first component as a registry host only when it looks like one.
  const firstSlash = nameAndTag.indexOf('/');
  const first = firstSlash < 0 ? null : unmask(nameAndTag.slice(0, firstSlash), pieces);
  const registry =
    first !== null && (first.includes('.') || first.includes(':') || first === 'localhost')
      ? first
      : null;
  const path = registry === null ? name : name.slice(registry.length + 1);
  return { raw, registry, path, name, tag, digest, interpolations: pieces.map(parseInterpolation) };
}

function interpolationVerdict(text: string): ImagePinVerdict | null {
  const { pieces } = mask(text);
  if (pieces.length === 0) return null;
  const modes = pieces.map((p) => parseInterpolation(p).mode);
  if (modes.every((m) => m === 'required')) return 'interpolated_required';
  if (modes.some((m) => m === 'plain')) return 'interpolated_unchecked';
  return 'interpolated_default';
}

function tagVerdict(tag: string): ImagePinVerdict {
  if (MOVING_ALIASES.has(tag.toLowerCase())) return 'floating';
  const version = VERSION.exec(tag);
  if (version !== null) return version[3] === undefined ? 'floating' : 'exact_version';
  const base = tag.toLowerCase().split(/[-_]/)[0];
  return base !== undefined && MOVING_ALIASES.has(base) ? 'floating' : 'opaque_tag';
}

export function imagePinVerdict(ref: ImageReference): ImagePinVerdict {
  if (ref.path.length === 0) return 'malformed';
  if (ref.digest !== null) {
    const interpolated = interpolationVerdict(ref.digest);
    if (interpolated !== null) return interpolated;
    return DIGEST.test(ref.digest) ? 'digest' : 'malformed';
  }
  if (ref.tag === null) {
    const interpolated = interpolationVerdict(ref.name);
    return interpolated === null ? 'implicit_latest' : interpolated;
  }
  const interpolated = interpolationVerdict(ref.tag);
  return interpolated === null ? tagVerdict(ref.tag) : interpolated;
}
