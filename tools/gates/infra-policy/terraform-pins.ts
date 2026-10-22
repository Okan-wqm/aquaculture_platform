/**
 * Terraform pins: module sources and provider version constraints — the one owner
 * (ARIA-HIGH-012).
 *
 * WHY: a module sourced from a git branch, or from a registry without `version`, changes under
 * an unchanged `.tf` file; a provider without a version constraint does the same on the next
 * `terraform init`. These functions read blocks from hcl-blocks.ts and never evaluate HCL.
 * Source address forms follow https://developer.hashicorp.com/terraform/language/modules/sources.
 *
 * A pin's `source` is reported, never the address as written: a reported source becomes ARIA's
 * finding subject and message, kept long after a credential in it is rotated. The verdict is
 * judged on the whole address; the report keeps the scheme, host and path, masks the URL userinfo
 * as `***`, and keeps a query value only for an argument in REPORTED_ARGUMENTS. A deny list of
 * go-getter's own credential arguments (round-2 review B2) left every credential a server names
 * itself in the output: an S3 presigned URL's X-Amz-Credential, X-Amz-Security-Token and
 * X-Amz-Signature, an Azure SAS `sig=`, a `?token=` (ARIA-HIGH-012 round-3 review R1). The
 * arguments that carry no credential are few and known; every other one is not. An scp-style
 * `git@host:path` user is a login name, not a credential, and stays. A source that is not one
 * string literal is an expression this owner does not evaluate, and is not reported at all.
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
 * The query arguments whose value is reported: go-getter's own arguments that select what is
 * fetched (git `ref`, hg `rev`, git `depth`, `archive` type, `checksum`, `filename`) and carry no
 * credential. Every other argument keeps its name and loses its value, `sshkey` and the
 * aws_access_* arguments among them, and an argument with no `=` is masked whole, since its name
 * is then its only content.
 */
const REPORTED_ARGUMENTS: ReadonlySet<string> = new Set([
  'ref',
  'rev',
  'depth',
  'archive',
  'checksum',
  'filename',
]);

const MASK = '***';

/**
 * `address` with its userinfo masked. With a `scheme://`, everything from there to the last `@`
 * goes: a password with an unencoded `/`, `?` or `#` is not a valid URL, but it is still written
 * in the file, and masking a path or query that holds an `@` hides more than needed, never less.
 * Without one, an scp-style `user@host:path` keeps its login name; a `user:password@` does not.
 */
function maskUserinfo(address: string): string {
  // go-getter's forced getter prefix, `git::` or `s3::`, is not part of the URL.
  const forced = /^[A-Za-z0-9]+::/.exec(address);
  const start = forced === null ? 0 : forced[0].length;
  const scheme = address.indexOf('://', start);
  const at = address.lastIndexOf('@');
  if (scheme >= 0) {
    return at > scheme ? `${address.slice(0, scheme + 3)}${MASK}${address.slice(at)}` : address;
  }
  return at > start && address.slice(start, at).includes(':')
    ? `${address.slice(0, start)}${MASK}${address.slice(at)}`
    : address;
}

/**
 * `address` as reported: userinfo masked, a query value kept only for REPORTED_ARGUMENTS, and a
 * fragment masked (go-getter reads none, so whatever follows `#` is not part of the address).
 */
function reportedAddress(address: string): string {
  const masked = maskUserinfo(address);
  const hash = masked.indexOf('#');
  const withoutFragment = hash < 0 ? masked : `${masked.slice(0, hash)}#${MASK}`;
  const query = withoutFragment.indexOf('?');
  if (query < 0) return withoutFragment;
  const end = hash < 0 ? withoutFragment.length : withoutFragment.indexOf('#');
  const pairs = withoutFragment
    .slice(query + 1, end)
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      if (eq < 0) return pair.length === 0 ? pair : MASK;
      const name = pair.slice(0, eq);
      return REPORTED_ARGUMENTS.has(name) ? pair : `${name}=${MASK}`;
    });
  return `${withoutFragment.slice(0, query + 1)}${pairs.join('&')}${withoutFragment.slice(end)}`;
}

export interface ModuleSourcePin {
  readonly verdict: ModuleSourceVerdict;
  /**
   * The source address as reported (see the file comment), or null when the module has no
   * `source` or its value is not one string literal.
   */
  readonly source: string | null;
  readonly line: number;
}

export function moduleSourcePin(block: HclBlock): ModuleSourcePin {
  const { verdict, line } = judgeModuleSource(block);
  const written = block.attributes.source?.string;
  return {
    verdict,
    source: written === undefined || written === null ? null : reportedAddress(written),
    line,
  };
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
