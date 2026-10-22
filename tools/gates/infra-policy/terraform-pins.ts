/**
 * Terraform pins: module sources and provider version constraints — the one owner
 * (ARIA-HIGH-012).
 *
 * WHY: a module sourced from a git branch, or from a registry without `version`, changes under
 * an unchanged `.tf` file; a provider without a version constraint does the same on the next
 * `terraform init`. These functions read blocks from hcl-blocks.ts and never evaluate HCL.
 * Source address forms follow https://developer.hashicorp.com/terraform/language/modules/sources.
 *
 * The address judged and reported is the source's value as Terraform evaluates it: hcl-blocks.ts
 * returns a quoted literal with its HCL escapes decoded (`\u0040` is `@`), and a template with
 * `${...}` or `%{...}` as no literal. A pin's `source` is a ReportedSource, never the address as
 * written: it becomes ARIA's finding subject and message, kept long after a credential in it is
 * rotated. The verdict is judged on the whole address. The report is BUILT from the address's
 * parts, each emitted only when it passes its shape check and otherwise as a fixed placeholder;
 * a userinfo, the scp login `git@` included, is never emitted, only recorded as present. Three
 * rounds derived the report by masking the written text instead (a deny list of credential
 * arguments, round-2 B2; an allow list of argument names, round-3 R1; a userinfo mask over the
 * whole address, round-4 R1 residual), and each leaked by a position the mask did not foresee:
 * an `@` in a query value, an allow-listed argument holding a nested URL, a token written as an
 * scp user. A fourth checked the authority and a scheme-less head one half at a time, so a user
 * whose `@` was percent-encoded or an HCL escape, or a user:password with no host, was reported
 * as the host (round-5 R1 residual-2); each is now one part, reported whole or withheld whole.
 * Percent-encoding is never decoded: `%` is outside every reported shape, so a part holding it
 * is withheld. A part that is reported has a shape no credential can hide in beyond what that
 * shape spells out. A source that is not one string literal is an expression this owner does
 * not evaluate, and reports a fixed text.
 */
import type { HclBlock } from '../lib/infra/hcl-blocks';

export type ModuleSourceVerdict =
  | 'local'
  | 'git_commit'
  | 'git_tag'
  | 'git_branch_ref'
  | 'git_unpinned'
  | 'registry_versioned'
  | 'registry_unversioned'
  /** An http(s), s3 or gcs archive with a go-getter `checksum=` (the bytes are verified). */
  | 'archive_checksummed'
  /** An http(s), s3 or gcs archive without one: the object behind the URL can be replaced. */
  | 'archive'
  /** No `source`, a non-literal one, or an address form this owner does not classify. */
  | 'unknown';

/**
 * Whether each verdict's module content can change without the `.tf` file changing: `pinned`,
 * `unpinned`, or `unresolved` when this owner cannot tell (it never counts as pinned, the way
 * image-reference.ts counts `malformed` as mutable). A Record over the union: a new verdict
 * without an entry does not compile, so none can default to pinned (ARIA-HIGH-012 landing fix 3).
 */
export const MODULE_SOURCE_PINNING: Readonly<
  Record<ModuleSourceVerdict, 'pinned' | 'unpinned' | 'unresolved'>
> = {
  local: 'pinned',
  git_commit: 'pinned',
  git_tag: 'pinned',
  git_branch_ref: 'unpinned',
  git_unpinned: 'unpinned',
  registry_versioned: 'pinned',
  registry_unversioned: 'unpinned',
  archive_checksummed: 'pinned',
  archive: 'unpinned',
  unknown: 'unresolved',
};

const REGISTRY_ADDRESS =
  /^(?:[a-z0-9.-]+\.[a-z]{2,}(?::\d+)?\/)?[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+(?:\/\/.*)?$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const VERSION_TAG = /^v?\d+\.\d+\.\d+/;

function isGitSource(source: string): boolean {
  return (
    source.startsWith('git::') ||
    source.startsWith('git@') ||
    source.startsWith('github.com/') ||
    source.startsWith('bitbucket.org/') ||
    /\.git(?:$|[/?])/.test(source)
  );
}

/** The value of a go-getter query argument (`?ref=`, `?checksum=`), or null when absent or empty. */
function queryArgument(source: string, name: string): string | null {
  const query = source.indexOf('?');
  if (query < 0) return null;
  for (const pair of source.slice(query + 1).split('&')) {
    const eq = pair.indexOf('=');
    if (eq < 0 || pair.slice(0, eq) !== name) continue;
    const value = pair.slice(eq + 1);
    if (value.length > 0) return value;
  }
  return null;
}

/**
 * A module source as this owner reports it. Only this file constructs one, and only in
 * reportedSource, from the parts of the written address that pass their shape check; a plain
 * string is not assignable to it. The adapter's Terraform finding subject takes this type, so
 * printing the address as written is a compile error (ARIA-HIGH-012 round-4 review R1 residual:
 * three rounds of masking the written address each leaked by a new path).
 */
export type ReportedSource = string & { readonly __brand: unique symbol };

/** The claim message for an unpinned module, built from a ReportedSource and checked labels. */
export type ReportedSourceMessage = string & { readonly __brand: unique symbol };

/** The one place a text becomes a ReportedSource: every caller passes fixed or checked parts. */
function asReported(text: string): ReportedSource {
  return text as ReportedSource;
}

/** A part that fails its shape check is reported as this fixed text, never as itself. */
const WITHHELD = '<withheld>';
/** A userinfo is never reported, the scp login `git@` included; that one was present is. */
const USERINFO = '<userinfo>';
/** A literal source that is not printable ASCII is not parsed, and so reports nothing of itself. */
const UNPARSED = '<unparsed source>';
/** A module with no `source`, or one that is not one string literal (an expression). */
const NO_LITERAL = '<no literal source>';

/** go-getter's forced getters (`git::`); any other prefix is withheld. */
const FORCED_GETTERS: ReadonlySet<string> = new Set([
  'git',
  'hg',
  's3',
  'gcs',
  'http',
  'https',
  'file',
]);
/** The URL schemes a module source names; any other scheme is withheld. */
const URL_SCHEMES: ReadonlySet<string> = new Set([
  'https',
  'http',
  'ssh',
  'git',
  's3',
  'gcs',
  'ftp',
  'ftps',
  'file',
]);
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;
/**
 * A URL authority after its userinfo, as a whole: a hostname and an optional digit port, or
 * empty (`file:///`). Anything else (`user:password`, `user:x-oauth-basic%40host`) is no host.
 */
const URL_HOST =
  /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*(?::\d{1,5})?)?$/;
/** A path segment or an scp path start: no `@ : ; ? # = %` and no space. */
const SEGMENT = /^[A-Za-z0-9._~-]*$/;
/**
 * A scheme-less head as a whole: one SEGMENT (`github.com`, `.`, a registry namespace), or two
 * joined by one `:` (the scp `host:org`).
 */
const SCHEMELESS_HEAD = /^[A-Za-z0-9._~-]*(?::[A-Za-z0-9._~-]*)?$/;
const MODULE_LABEL = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/**
 * go-getter's arguments that select what is fetched and carry no credential, each with the
 * shape its value must have to be reported: git `ref` and hg `rev` a ref name, `depth` digits,
 * `archive` a known type, `checksum` `<type>:<hex>`, `filename` a plain name. A value off its
 * shape (`ref=x?token=…`, `checksum=file:<URL>`) is withheld; every other argument, `sshkey`,
 * `token`, a presigned URL's or an unknown server's own, is withheld whole, its name included,
 * since a bare argument's name is its only content.
 */
const REPORTED_ARGUMENTS: ReadonlyMap<string, RegExp> = new Map([
  ['ref', /^[A-Za-z0-9._/-]+$/],
  ['rev', /^[A-Za-z0-9._/-]+$/],
  ['depth', /^\d+$/],
  [
    'archive',
    /^(?:zip|tar|tar\.gz|tgz|tar\.bz2|tbz2|tar\.xz|txz|tar\.zst|tzst|gz|bz2|xz|zst|false)$/,
  ],
  ['checksum', /^(?:md5|sha1|sha256|sha512):[0-9A-Fa-f]+$/],
  ['filename', /^[A-Za-z0-9._-]+$/],
]);

/** One part of the address and the offset it starts at. */
interface AddressPart {
  readonly text: string;
  readonly at: number;
}

function partsOf(text: string, offset: number, separator: string): AddressPart[] {
  const parts: AddressPart[] = [];
  let at = offset;
  for (const part of text.split(separator)) {
    parts.push({ text: part, at });
    at += part.length + separator.length;
  }
  return parts;
}

function fromClosedSet(name: string, allowed: ReadonlySet<string>): string {
  const folded = name.toLowerCase();
  return allowed.has(folded) ? folded : WITHHELD;
}

function segmentShape(text: string): string {
  return SEGMENT.test(text) ? text : WITHHELD;
}

/** A URL authority after its userinfo: reported whole when it is URL_HOST, else withheld whole. */
function urlHostShape(text: string): string {
  return URL_HOST.test(text) ? text : WITHHELD;
}

/** The first part of a scheme-less address: reported whole when it is SCHEMELESS_HEAD. */
function schemelessHeadShape(text: string): string {
  return SCHEMELESS_HEAD.test(text) ? text : WITHHELD;
}

function argumentShape(text: string): string {
  const eq = text.indexOf('=');
  if (eq < 0) return WITHHELD;
  const name = text.slice(0, eq);
  const shape = REPORTED_ARGUMENTS.get(name);
  if (shape === undefined) return WITHHELD;
  const value = text.slice(eq + 1);
  return `${name}=${shape.test(value) ? value : WITHHELD}`;
}

/**
 * The source as reported, built from parts and never by masking the written text. The address
 * is split as go-getter's URL parser splits it: the forced getter, then the fragment at the
 * first `#`, the query at the first `?`, the scheme, the authority up to the first `/` and its
 * userinfo up to the authority's last `@`. Each part is then checked against its shape and
 * reported as itself only when it passes: the getter and scheme from a closed set, a hostname
 * and digit port, path segments of SEGMENT, an argument of REPORTED_ARGUMENTS whose value has
 * its shape. A userinfo is reported as USERINFO, a fragment as WITHHELD. The authority after its
 * userinfo, and a scheme-less head, is one part: it is reported whole or withheld whole.
 *
 * An `@` past the authority means a userinfo written with an unencoded `/`, `?` or `#` may have
 * ended the authority early: every part that starts before the last `@` may be the rest of it,
 * and is withheld whatever its shape (a GCS V2 GoogleAccessId=sa@… costs the host its report).
 */
function reportedSource(value: string): ReportedSource {
  if (!PRINTABLE_ASCII.test(value)) return asReported(UNPARSED);
  const forced = /^([A-Za-z0-9]+)::/.exec(value);
  const getter = forced === null ? '' : `${fromClosedSet(forced[1] ?? '', FORCED_GETTERS)}::`;
  const address = forced === null ? value : value.slice(forced[0].length);

  const hash = address.indexOf('#');
  const body = hash < 0 ? address : address.slice(0, hash);
  const question = body.indexOf('?');
  const location = question < 0 ? body : body.slice(0, question);
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(location);
  const authorityAt = scheme === null ? 0 : scheme[0].length;
  const slash = location.indexOf('/', authorityAt);
  const authorityEnd = slash < 0 ? location.length : slash;
  const authority = location.slice(authorityAt, authorityEnd);
  const userinfoEnd = authority.lastIndexOf('@');

  const lastAt = address.lastIndexOf('@');
  const ambiguousUntil = lastAt >= authorityEnd ? lastAt : -1;
  const shown = (part: AddressPart, shape: (text: string) => string): string =>
    part.at < ambiguousUntil ? WITHHELD : shape(part.text);

  const host = shown(
    { text: authority.slice(userinfoEnd + 1), at: authorityAt + userinfoEnd + 1 },
    scheme === null ? schemelessHeadShape : urlHostShape,
  );
  const path = partsOf(location.slice(authorityEnd), authorityEnd, '/')
    .map((segment) => (segment.text === '' ? '' : shown(segment, segmentShape)))
    .join('/');
  const query =
    question < 0
      ? ''
      : `?${partsOf(body.slice(question + 1), question + 1, '&')
          .filter((argument) => argument.text !== '')
          .map((argument) => shown(argument, argumentShape))
          .join('&')}`;
  return asReported(
    [
      getter,
      scheme === null ? '' : `${fromClosedSet(scheme[1] ?? '', URL_SCHEMES)}://`,
      userinfoEnd < 0 ? '' : `${USERINFO}@`,
      host,
      path,
      query,
      hash < 0 ? '' : `#${WITHHELD}`,
    ].join(''),
  );
}

export interface ModuleSourcePin {
  readonly verdict: ModuleSourceVerdict;
  /**
   * The source as reported (reportedSource), or NO_LITERAL when the module has no `source` or
   * its value is not one string literal (a template with `${...}` or `%{...}` included).
   */
  readonly source: ReportedSource;
  readonly line: number;
}

export function moduleSourcePin(block: HclBlock): ModuleSourcePin {
  const { verdict, line } = judgeModuleSource(block);
  const value = block.attributes.source?.string;
  return {
    verdict,
    source: value === undefined || value === null ? asReported(NO_LITERAL) : reportedSource(value),
    line,
  };
}

/**
 * A module block's labels as reported: each one with a label's shape as itself, any other as
 * WITHHELD. The one formatter of module labels: the claim message and the adapter's unresolved
 * observation both take it.
 */
export function reportedModuleLabels(block: HclBlock): string {
  return block.labels.map((label) => (MODULE_LABEL.test(label) ? label : WITHHELD)).join(' ');
}

/**
 * The claim message for a module whose source does not pin its content: its reported labels and
 * its reported source. Built here so the adapter's message, like its subject, takes a type only
 * this owner constructs.
 */
export function unpinnedSourceMessage(
  block: HclBlock,
  pin: ModuleSourcePin,
): ReportedSourceMessage {
  const message = `module ${reportedModuleLabels(block)} sources \`${pin.source}\` (${pin.verdict}): its content can change under an unchanged .tf file`;
  return message as ReportedSourceMessage;
}

/** The verdict on the whole source address, credentials included, and the line it sits on. */
function judgeModuleSource(block: HclBlock): {
  verdict: ModuleSourceVerdict;
  line: number;
} {
  const attr = block.attributes.source;
  if (attr === undefined || attr.string === null) {
    return { verdict: 'unknown', line: attr === undefined ? block.line : attr.line };
  }
  const source = attr.string;
  const line = attr.line;
  if (source.startsWith('./') || source.startsWith('../')) return { verdict: 'local', line };
  if (isGitSource(source)) {
    const ref = queryArgument(source, 'ref');
    if (ref === null) return { verdict: 'git_unpinned', line };
    if (COMMIT_SHA.test(ref)) return { verdict: 'git_commit', line };
    return { verdict: VERSION_TAG.test(ref) ? 'git_tag' : 'git_branch_ref', line };
  }
  if (REGISTRY_ADDRESS.test(source)) {
    const version = block.attributes.version;
    return {
      verdict: version === undefined ? 'registry_unversioned' : 'registry_versioned',
      line,
    };
  }
  if (/^(?:https?|s3|gcs|hg)::|^https?:\/\//.test(source)) {
    // go-getter verifies `checksum=<type>:<value>` before it unpacks the archive.
    const checksum = queryArgument(source, 'checksum');
    return {
      verdict: checksum !== null && checksum.includes(':') ? 'archive_checksummed' : 'archive',
      line,
    };
  }
  return { verdict: 'unknown', line };
}

export interface ProviderConstraint {
  readonly provider: string;
  /** The version constraint, or null when the entry has none. */
  readonly version: string | null;
  readonly line: number;
}

/** Every `required_providers` entry of a `terraform {}` block with its version constraint. */
export function providerConstraints(terraformBlock: HclBlock): ProviderConstraint[] {
  const out: ProviderConstraint[] = [];
  for (const child of terraformBlock.blocks) {
    if (child.type !== 'required_providers') continue;
    for (const [provider, attr] of Object.entries(child.attributes)) {
      if (attr.object !== null) {
        const version = attr.object.version;
        out.push({
          provider,
          version:
            version === undefined ? null : version.string === null ? version.raw : version.string,
          line: attr.line,
        });
      } else {
        // Legacy shorthand `aws = "~> 2.0"` is the version constraint itself.
        out.push({ provider, version: attr.string, line: attr.line });
      }
    }
  }
  return out;
}
