/**
 * Terraform pins: module sources and provider version constraints — the one owner
 * (ARIA-HIGH-012).
 *
 * WHY: a module sourced from a git branch, or from a registry without `version`, changes under
 * an unchanged `.tf` file; a provider without a version constraint does the same on the next
 * `terraform init`. These functions read blocks from hcl-blocks.ts and never evaluate HCL.
 * Source address forms follow https://developer.hashicorp.com/terraform/language/modules/sources.
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
  | 'archive'
  | 'unknown';

/**
 * Whether each verdict's module content can change without the `.tf` file changing. A Record
 * over the union: a new verdict without an entry does not compile.
 */
export const MODULE_SOURCE_PINNING: Readonly<Record<ModuleSourceVerdict, 'pinned' | 'unpinned'>> = {
  local: 'pinned',
  git_commit: 'pinned',
  git_tag: 'pinned',
  git_branch_ref: 'unpinned',
  git_unpinned: 'unpinned',
  registry_versioned: 'pinned',
  registry_unversioned: 'unpinned',
  archive: 'pinned',
  unknown: 'pinned',
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

function gitRef(source: string): string | null {
  const query = source.indexOf('?');
  if (query < 0) return null;
  for (const pair of source.slice(query + 1).split('&')) {
    const [key, value] = pair.split('=');
    if (key === 'ref' && value !== undefined && value.length > 0) return value;
  }
  return null;
}

export interface ModuleSourcePin {
  readonly verdict: ModuleSourceVerdict;
  readonly source: string | null;
  readonly line: number;
}

export function moduleSourcePin(block: HclBlock): ModuleSourcePin {
  const attr = block.attributes.source;
  if (attr === undefined || attr.string === null) {
    return {
      verdict: 'unknown',
      source: attr === undefined ? null : attr.raw,
      line: attr === undefined ? block.line : attr.line,
    };
  }
  const source = attr.string;
  const line = attr.line;
  if (source.startsWith('./') || source.startsWith('../'))
    return { verdict: 'local', source, line };
  if (isGitSource(source)) {
    const ref = gitRef(source);
    if (ref === null) return { verdict: 'git_unpinned', source, line };
    if (COMMIT_SHA.test(ref)) return { verdict: 'git_commit', source, line };
    return { verdict: VERSION_TAG.test(ref) ? 'git_tag' : 'git_branch_ref', source, line };
  }
  if (REGISTRY_ADDRESS.test(source)) {
    const version = block.attributes.version;
    return {
      verdict: version === undefined ? 'registry_unversioned' : 'registry_versioned',
      source,
      line,
    };
  }
  if (/^(?:https?|s3|gcs|hg)::|^https?:\/\//.test(source))
    return { verdict: 'archive', source, line };
  return { verdict: 'unknown', source, line };
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
